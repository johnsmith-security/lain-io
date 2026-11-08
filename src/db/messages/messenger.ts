// End-to-end encrypted messaging: Signal protocol (X3DH + Double Ratchet)
// with Gun as the transport.
//
// Published (account-signed, in your own space):
//   ~pub/devices/<deviceId>             JSON {deviceId, registrationId, identityKey, signedPreKey, sealEpub, createdAt, revoked?}
//   ~pub/prekeys/<deviceId>/<keyId>     base64 public one-time prekey | null once used
// Transport (content-addressed, sealed):
//   lain-io/mail/<day>/<mailboxId>#     JSON {v, e, c}: the Signal message plus sender identity,
//                                       sealed to the recipient device's seal key
// Mailbox ids:
//   first contact (PreKey message): sha256("pub" | recipient | device | day)
//   after the recipient replied:    sha256("priv" | ECDH(sealA, sealB) | recipient | device | day),
//                                   which a relay can't link to either party or across days
// Local only (encrypted SQLite): ratchet sessions, prekey private keys,
// conversations, decrypted history.
//
// Groups are pairwise fan-out over the 1:1 sessions (every member gets their
// own ratchet message). Forward secrecy holds, cost is O(members). Fine for
// small groups; switch to Sender Keys / MLS if groups grow past ~100.

import { FingerprintGenerator, KeyHelper, SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';
import { abToB64, abToText, b64ToAb, b64ToBytes, binaryStringToBytes, bytesToB64, newId, randomBytes, recentDays, safeJson, textToAb } from '../encoding';
import { type Ctx, SEA, accountNs, collectMap, meNode, putAck, putHashed, readOnce, requirePair, sealTo, sha256url, subscribeMap, throttle, unseal, userNode } from '../graph';
import type { Moderation } from '../moderation';
import type { SafetyStore } from '../settings';
import type { ChatMessage, Conversation, IdentityWarning, SEAPair, Unsubscribe } from '../types';
import { type DeviceSecrets, SignalStore, identityName } from './signalStore';

const PREKEY_TARGET = 50;
const PREKEY_REFILL_BELOW = 20;
const SIGNED_PREKEY_ROTATE_MS = 7 * 86_400_000;
const SIGNED_PREKEY_KEEP_MS = 30 * 86_400_000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_GROUP_MEMBERS = 100;

type LocalDevice = DeviceSecrets & {
  seal: SEAPair;
  signedPreKey: { keyId: number; publicKey: string; signature: string; createdAt: number };
  nextPreKeyId: number;
};

export type PublishedDevice = {
  pub: string;
  deviceId: number;
  registrationId: number;
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  sealEpub: string;
  createdAt: number;
  revoked?: boolean;
};

type ConvMeta = { id: string; kind: 'direct' | 'group'; members: string[]; name?: string; owner?: string };
type Payload =
  | { t: 'msg'; conv: ConvMeta; id: string; text: string; sentAt: number; replyTo?: string }
  | { t: 'group'; conv: ConvMeta; at: number }
  | { t: 'leave'; convId: string; at: number };
type Inner = { from: string; fd: number; t: number; b: string };

const signalName = (pub: string, deviceId: number) => `${pub}|${deviceId}`;
const pad = (n: number) => String(n).padStart(15, '0');

export class Messenger {
  private device: LocalDevice | null = null;
  private store: SignalStore | null = null;
  private boxStops = new Map<string, Unsubscribe>();
  private deviceCache = new Map<string, { at: number; devices: PublishedDevice[] }>();
  private secretCache = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private dayTimer: ReturnType<typeof setInterval> | null = null;
  private currentDays = '';
  private convListeners = new Set<(c: Conversation[]) => void>();
  private msgListeners = new Map<string, Set<() => void>>();
  private warnListeners = new Set<(w: IdentityWarning[]) => void>();

  constructor(private ctx: Ctx, private safety: SafetyStore, private moderation: Moderation) {}

  // ================= lifecycle =================

  get deviceId(): number | null { return this.device?.deviceId ?? null; }

  /** Load or create this device's keys, publish them, and start receiving. */
  async start(): Promise<void> {
    const { session } = requirePair(this.ctx);
    this.device = await this.loadOrCreateDevice();
    this.store = new SignalStore(this.ctx.platform.kv, accountNs(this.ctx, 'signal'), this.device);
    this.store.onPreKeyRemoved = (keyId) => { void this.onPreKeyUsed(keyId); };
    session.deviceId = this.device.deviceId;
    await this.publishDevice();
    await this.refillPreKeys();
    await this.rotateSignedPreKeyIfDue();
    this.pruneSeen();
    this.resubscribeAll();
    this.dayTimer = setInterval(() => this.resubscribeAll(), 10 * 60_000);
  }

  stop() {
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.dayTimer = null;
    for (const stop of this.boxStops.values()) stop();
    this.boxStops.clear();
    this.currentDays = '';
    this.device = null;
    this.store = null;
    this.deviceCache.clear();
    this.secretCache.clear();
  }

  // ================= conversations (local) =================

  async directConversationId(pub: string): Promise<string> {
    const { session } = requirePair(this.ctx);
    return `d:${await sha256url([session.pub, pub].sort().join('|'))}`;
  }

  async openDirect(pub: string): Promise<Conversation> {
    const { session } = requirePair(this.ctx);
    if (pub === session.pub) throw new Error('You can’t message yourself.');
    const id = await this.directConversationId(pub);
    return this.getConversation(id) ?? this.saveConversation({ id, kind: 'direct', members: [session.pub, pub].sort(), name: '', lastMessageAt: Date.now(), lastMessagePreview: '', unread: 0 });
  }

  listConversations(): Conversation[] {
    return this.ctx.platform.kv.list(accountNs(this.ctx, 'conv'))
      .map(({ value }) => JSON.parse(value) as Conversation)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  getConversation(id: string): Conversation | null {
    return safeJson<Conversation>(this.ctx.platform.kv.get(accountNs(this.ctx, 'conv'), id)) ?? null;
  }

  subscribeConversations(cb: (conversations: Conversation[]) => void): Unsubscribe {
    this.convListeners.add(cb);
    cb(this.listConversations());
    return () => { this.convListeners.delete(cb); };
  }

  listMessages(conversationId: string, { limit = 100, before }: { limit?: number; before?: number } = {}): ChatMessage[] {
    const all = this.ctx.platform.kv.list(accountNs(this.ctx, `msg:${conversationId}`)).map(({ value }) => JSON.parse(value) as ChatMessage);
    const filtered = before ? all.filter((m) => m.sentAt < before) : all;
    return filtered.slice(-limit);
  }

  subscribeMessages(conversationId: string, cb: (messages: ChatMessage[]) => void, limit = 200): Unsubscribe {
    let set = this.msgListeners.get(conversationId);
    if (!set) this.msgListeners.set(conversationId, (set = new Set()));
    const listener = () => { if (this.ctx.session) cb(this.listMessages(conversationId, { limit })); };
    const throttled = throttle(listener, 30);
    set.add(throttled);
    listener();
    return () => { set!.delete(throttled); };
  }

  markRead(conversationId: string) {
    const conv = this.getConversation(conversationId);
    if (conv && conv.unread) this.saveConversation({ ...conv, unread: 0 });
  }

  /** Removes the conversation and its history from this device only. */
  deleteLocalConversation(conversationId: string) {
    this.ctx.platform.kv.del(accountNs(this.ctx, 'conv'), conversationId);
    this.ctx.platform.kv.clear(accountNs(this.ctx, `msg:${conversationId}`));
    this.notifyConversations();
  }

  // ================= sending =================

  async send(conversationId: string, text: string, options: { replyTo?: string } = {}): Promise<ChatMessage> {
    const { session } = requirePair(this.ctx);
    const body = text.trim();
    if (!body) throw new Error('Write a message first.');
    if (body.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`);
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error('Conversation not found.');
    const message: ChatMessage = { id: newId(), conversationId, from: session.pub, text: body, sentAt: Date.now(), receivedAt: Date.now(), replyTo: options.replyTo, status: 'sending' };
    this.storeMessage(message, false);
    const payload: Payload = { t: 'msg', conv: this.meta(conv), id: message.id, text: body, sentAt: message.sentAt, ...(options.replyTo ? { replyTo: options.replyTo } : {}) };
    const recipients = conv.members.filter((pub) => pub !== session.pub && !this.safety.isBlocked(pub));
    let delivered = 0;
    try { delivered = await this.fanOut(recipients, payload); } catch { delivered = 0; }
    const final: ChatMessage = { ...message, status: delivered > 0 || recipients.length === 0 ? 'sent' : 'failed' };
    this.storeMessage(final, false);
    return final;
  }

  /** Retry a failed message (same id, so recipients dedupe). */
  async resend(conversationId: string, messageId: string): Promise<ChatMessage | null> {
    const existing = this.listMessages(conversationId, { limit: 10_000 }).find((m) => m.id === messageId);
    const conv = this.getConversation(conversationId);
    if (!existing || !conv) return null;
    const payload: Payload = { t: 'msg', conv: this.meta(conv), id: existing.id, text: existing.text, sentAt: existing.sentAt, ...(existing.replyTo ? { replyTo: existing.replyTo } : {}) };
    const delivered = await this.fanOut(conv.members.filter((p) => p !== existing.from), payload).catch(() => 0);
    const final: ChatMessage = { ...existing, status: delivered > 0 ? 'sent' : 'failed' };
    this.storeMessage(final, false);
    return final;
  }

  // ================= groups =================

  async createGroup(name: string, memberPubs: string[]): Promise<Conversation> {
    const { session } = requirePair(this.ctx);
    const members = [...new Set([session.pub, ...memberPubs])].sort();
    if (members.length < 2) throw new Error('Add at least one other person.');
    if (members.length > MAX_GROUP_MEMBERS) throw new Error(`Groups can have up to ${MAX_GROUP_MEMBERS} members.`);
    const conv = this.saveConversation({ id: `g:${newId()}`, kind: 'group', members, name: name.trim().slice(0, 60) || 'Group', owner: session.pub, lastMessageAt: Date.now(), lastMessagePreview: '', unread: 0 });
    await this.fanOut(members.filter((p) => p !== session.pub), { t: 'group', conv: this.meta(conv), at: Date.now() });
    return conv;
  }

  /** Owner only: rename, add, or remove members. Removed members get the update so they know. */
  async updateGroup(conversationId: string, change: { name?: string; add?: string[]; remove?: string[] }): Promise<Conversation> {
    const { session } = requirePair(this.ctx);
    const conv = this.getConversation(conversationId);
    if (!conv || conv.kind !== 'group') throw new Error('Group not found.');
    if (conv.owner !== session.pub) throw new Error('Only the group owner can change the group.');
    const removed = new Set(change.remove ?? []);
    removed.delete(session.pub);
    const members = [...new Set([...conv.members, ...(change.add ?? [])])].filter((p) => !removed.has(p)).sort();
    if (members.length > MAX_GROUP_MEMBERS) throw new Error(`Groups can have up to ${MAX_GROUP_MEMBERS} members.`);
    const next = this.saveConversation({ ...conv, members, name: change.name?.trim().slice(0, 60) || conv.name });
    const notify = [...new Set([...members, ...removed])].filter((p) => p !== session.pub);
    await this.fanOut(notify, { t: 'group', conv: this.meta(next), at: Date.now() });
    return next;
  }

  async leaveGroup(conversationId: string): Promise<void> {
    const { session } = requirePair(this.ctx);
    const conv = this.getConversation(conversationId);
    if (!conv || conv.kind !== 'group') return;
    await this.fanOut(conv.members.filter((p) => p !== session.pub), { t: 'leave', convId: conv.id, at: Date.now() }).catch(() => 0);
    this.deleteLocalConversation(conversationId);
  }

  // ================= safety numbers & devices =================

  /** Safety numbers to compare in person / by QR, one per device of `pub`. */
  async safetyNumbers(pub: string): Promise<Array<{ deviceId: number; safetyNumber: string; changed: boolean }>> {
    const { session } = requirePair(this.ctx);
    const generator = new FingerprintGenerator(5200);
    const devices = await this.devicesOf(pub, true);
    const mine = b64ToAb(this.device!.identity.pub);
    return Promise.all(devices.map(async (d) => {
      const pinned = this.store!.getPinned(signalName(pub, d.deviceId));
      return {
        deviceId: d.deviceId,
        safetyNumber: await generator.createFor(session.pub, mine, pub, b64ToAb(d.identityKey)),
        changed: Boolean(pinned && pinned !== d.identityKey),
      };
    }));
  }

  identityWarnings(): IdentityWarning[] {
    return this.ctx.platform.kv.list(accountNs(this.ctx, 'idwarn')).map(({ value }) => JSON.parse(value) as IdentityWarning);
  }

  subscribeIdentityWarnings(cb: (warnings: IdentityWarning[]) => void): Unsubscribe {
    this.warnListeners.add(cb);
    cb(this.identityWarnings());
    return () => { this.warnListeners.delete(cb); };
  }

  /** Accept a changed device key after the user checked the safety number. */
  async trustNewIdentity(pub: string, deviceId: number): Promise<void> {
    const device = (await this.devicesOf(pub, true)).find((d) => d.deviceId === deviceId);
    if (!device) throw new Error('Device not found.');
    this.store!.replacePinned(signalName(pub, deviceId), b64ToAb(device.identityKey));
    this.ctx.platform.kv.del(accountNs(this.ctx, 'idwarn'), signalName(pub, deviceId));
    this.notifyWarnings();
  }

  /** Your signed-in devices. */
  async myDevices(): Promise<Array<PublishedDevice & { current: boolean }>> {
    const { session } = requirePair(this.ctx);
    const devices = await this.devicesOf(session.pub, true, true);
    return devices.map((d) => ({ ...d, current: d.deviceId === this.device?.deviceId }));
  }

  /** Stop other people from encrypting to one of your devices (lost phone). */
  async revokeDevice(deviceId: number): Promise<void> {
    const { session } = requirePair(this.ctx);
    const devices = await this.devicesOf(session.pub, true, true);
    const device = devices.find((d) => d.deviceId === deviceId);
    if (!device) return;
    const { pub: _pub, ...stored } = device;
    await putAck(meNode(this.ctx).get('devices').get(String(deviceId)), JSON.stringify({ ...stored, revoked: true }));
    const prekeys = await collectMap(meNode(this.ctx).get('prekeys').get(String(deviceId)), { idleMs: 500, maxMs: 3000 });
    for (const keyId of prekeys.keys()) await putAck(meNode(this.ctx).get('prekeys').get(String(deviceId)).get(keyId), null, 2000);
    this.deviceCache.delete(session.pub);
  }

  /** Account deletion: revoke this device and wipe local messaging data. */
  async wipeMine(): Promise<void> {
    const { session } = requirePair(this.ctx);
    const devices = await this.devicesOf(session.pub, true, true);
    for (const d of devices) await this.revokeDevice(d.deviceId);
    this.stop();
    this.ctx.platform.kv.clearPrefix(`${session.pub}:`);
  }

  // ================= internals: device keys =================

  private async loadOrCreateDevice(): Promise<LocalDevice> {
    const ns = accountNs(this.ctx, 'device');
    const existing = safeJson<LocalDevice>(this.ctx.platform.kv.get(ns, 'self'));
    if (existing?.deviceId) return existing;
    const identity = await KeyHelper.generateIdentityKeyPair();
    const registrationId = KeyHelper.generateRegistrationId();
    const signed = await KeyHelper.generateSignedPreKey(identity, 1);
    const bytes = randomBytes(4);
    const deviceId = (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 1) || 1;
    const device: LocalDevice = {
      deviceId,
      registrationId,
      identity: { pub: abToB64(identity.pubKey), priv: abToB64(identity.privKey) },
      seal: await SEA.pair(),
      signedPreKey: { keyId: 1, publicKey: abToB64(signed.keyPair.pubKey), signature: abToB64(signed.signature), createdAt: Date.now() },
      nextPreKeyId: 1,
      createdAt: Date.now(),
    };
    const store = new SignalStore(this.ctx.platform.kv, accountNs(this.ctx, 'signal'), device);
    await store.storeSignedPreKey(1, signed.keyPair);
    this.ctx.platform.kv.set(ns, 'self', JSON.stringify(device));
    return device;
  }

  private saveDevice() { this.ctx.platform.kv.set(accountNs(this.ctx, 'device'), 'self', JSON.stringify(this.device)); }

  private async publishDevice() {
    const d = this.device!;
    const record = {
      deviceId: d.deviceId,
      registrationId: d.registrationId,
      identityKey: d.identity.pub,
      signedPreKey: { keyId: d.signedPreKey.keyId, publicKey: d.signedPreKey.publicKey, signature: d.signedPreKey.signature },
      sealEpub: d.seal.epub,
      createdAt: d.createdAt,
    };
    await putAck(meNode(this.ctx).get('devices').get(String(d.deviceId)), JSON.stringify(record));
  }

  private async refillPreKeys() {
    const store = this.store!, d = this.device!;
    store.pruneUsedPreKeys();
    const missing = PREKEY_TARGET - store.preKeyCount();
    if (missing <= 0) return;
    const node = meNode(this.ctx).get('prekeys').get(String(d.deviceId));
    const writes: Promise<void>[] = [];
    for (let i = 0; i < missing; i++) {
      const keyId = d.nextPreKeyId++;
      const preKey = await KeyHelper.generatePreKey(keyId);
      await store.storePreKey(keyId, preKey.keyPair);
      writes.push(putAck(node.get(String(keyId)), abToB64(preKey.keyPair.pubKey)));
    }
    this.saveDevice();
    await Promise.all(writes);
  }

  private async onPreKeyUsed(keyId: number) {
    if (!this.device) return;
    meNode(this.ctx).get('prekeys').get(String(this.device.deviceId)).get(String(keyId)).put(null);
    if (this.store!.preKeyCount() < PREKEY_REFILL_BELOW) await this.refillPreKeys();
  }

  private async rotateSignedPreKeyIfDue() {
    const d = this.device!;
    if (Date.now() - d.signedPreKey.createdAt < SIGNED_PREKEY_ROTATE_MS) return;
    const keyId = d.signedPreKey.keyId + 1;
    const identity = { pubKey: b64ToAb(d.identity.pub), privKey: b64ToAb(d.identity.priv) };
    const signed = await KeyHelper.generateSignedPreKey(identity, keyId);
    await this.store!.storeSignedPreKey(keyId, signed.keyPair);
    d.signedPreKey = { keyId, publicKey: abToB64(signed.keyPair.pubKey), signature: abToB64(signed.signature), createdAt: Date.now() };
    this.saveDevice();
    this.store!.pruneSignedPreKeys(keyId, SIGNED_PREKEY_KEEP_MS);
    await this.publishDevice();
  }

  /** Published, non-revoked devices of an account (cached for a minute). */
  async devicesOf(pub: string, fresh = false, includeRevoked = false): Promise<PublishedDevice[]> {
    const cached = this.deviceCache.get(pub);
    let devices: PublishedDevice[];
    if (!fresh && cached && Date.now() - cached.at < 60_000) devices = cached.devices;
    else {
      const items = await collectMap(userNode(this.ctx, pub).get('devices'), { idleMs: 600, maxMs: this.ctx.config.readTimeoutMs });
      devices = [];
      for (const [key, value] of items) {
        const d = safeJson<Omit<PublishedDevice, 'pub'>>(value);
        if (!d || String(d.deviceId) !== key || !d.identityKey || !d.sealEpub || !d.signedPreKey?.publicKey) continue;
        devices.push({ ...d, pub });
      }
      this.deviceCache.set(pub, { at: Date.now(), devices });
    }
    return includeRevoked ? devices : devices.filter((d) => !d.revoked);
  }

  // ================= internals: transport =================

  private async mailboxSecret(peerSealEpub: string): Promise<string> {
    let secret = this.secretCache.get(peerSealEpub);
    if (!secret) {
      secret = await SEA.secret(peerSealEpub, this.device!.seal) as string;
      if (!secret) throw new Error('Could not derive a mailbox key.');
      this.secretCache.set(peerSealEpub, secret);
    }
    return secret;
  }

  private publicBox = (pub: string, deviceId: number, day: string) => sha256url(`lain-mail-v1|pub|${pub}|${deviceId}|${day}`);
  private async privateBox(peerSealEpub: string, toPub: string, toDevice: number, day: string) {
    return sha256url(`lain-mail-v1|priv|${await this.mailboxSecret(peerSealEpub)}|${toPub}|${toDevice}|${day}`);
  }

  /** Encrypt `payload` to every device of `pubs`, plus your own other devices. Returns devices reached. */
  private async fanOut(pubs: string[], payload: Payload): Promise<number> {
    const { session } = requirePair(this.ctx);
    const plain = textToAb(JSON.stringify(payload));
    const targets: PublishedDevice[] = [];
    for (const pub of new Set([...pubs, session.pub])) {
      const devices = await this.devicesOf(pub);
      targets.push(...devices.filter((d) => !(pub === session.pub && d.deviceId === this.device!.deviceId)));
    }
    let reached = 0;
    for (const target of targets) {
      try {
        if (await this.sendToDevice(target, plain)) if (target.pub !== session.pub) reached++;
      } catch (error) {
        console.warn('[lain-db] send to device failed', target.pub.slice(0, 8), target.deviceId, error);
      }
    }
    return reached;
  }

  private async sendToDevice(target: PublishedDevice, plain: ArrayBuffer): Promise<boolean> {
    const { session } = requirePair(this.ctx);
    const store = this.store!;
    const name = signalName(target.pub, target.deviceId);
    const pin = store.pinIdentity(name, b64ToAb(target.identityKey));
    if (pin === 'changed') { this.addWarning(target.pub, target.deviceId); return false; }
    const address = new SignalProtocolAddress(name, 1);
    const cipher = new SessionCipher(store, address);
    if (!(await cipher.hasOpenSession())) {
      const preKeys = await collectMap(userNode(this.ctx, target.pub).get('prekeys').get(String(target.deviceId)), { idleMs: 400, maxMs: 2500 });
      const available = [...preKeys].filter(([, v]) => typeof v === 'string' && v);
      const pick = available.length ? available[randomBytes(1)[0] % available.length] : null;
      await new SessionBuilder(store, address).processPreKey({
        identityKey: b64ToAb(target.identityKey),
        registrationId: target.registrationId,
        signedPreKey: { keyId: target.signedPreKey.keyId, publicKey: b64ToAb(target.signedPreKey.publicKey), signature: b64ToAb(target.signedPreKey.signature) },
        ...(pick ? { preKey: { keyId: Number(pick[0]), publicKey: b64ToAb(String(pick[1])) } } : {}),
      });
    }
    const encrypted = await cipher.encrypt(plain);
    if (!encrypted.body) throw new Error('Encryption produced no body.');
    const inner: Inner = { from: session.pub, fd: this.device!.deviceId, t: encrypted.type, b: bytesToB64(binaryStringToBytes(encrypted.body)) };
    const sealed = await sealTo(inner, target.sealEpub);
    const day = recentDays(1)[0];
    const box = encrypted.type === 3
      ? await this.publicBox(target.pub, target.deviceId, day)
      : await this.privateBox(target.sealEpub, target.pub, target.deviceId, day);
    await putHashed(this.ctx, `lain-io/mail/${day}/${box}#`, sealed);
    this.addPeer(target);
    return true;
  }

  private peers(): PublishedDevice[] {
    return this.ctx.platform.kv.list(accountNs(this.ctx, 'peers')).map(({ value }) => JSON.parse(value) as PublishedDevice);
  }

  private addPeer(device: PublishedDevice) {
    const ns = accountNs(this.ctx, 'peers');
    const key = signalName(device.pub, device.deviceId);
    if (this.ctx.platform.kv.get(ns, key)) return;
    this.ctx.platform.kv.set(ns, key, JSON.stringify(device));
    void this.subscribePeer(device);
  }

  /** (Re)subscribe to every mailbox for today and yesterday. */
  private resubscribeAll() {
    if (!this.device) return;
    const days = recentDays(2);
    if (days.join() === this.currentDays) return;
    this.currentDays = days.join();
    for (const stop of this.boxStops.values()) stop();
    this.boxStops.clear();
    const { session } = requirePair(this.ctx);
    for (const day of days) {
      void this.publicBox(session.pub, this.device.deviceId, day).then((box) => this.watchBox(day, box));
    }
    for (const peer of this.peers()) void this.subscribePeer(peer);
  }

  private async subscribePeer(peer: PublishedDevice) {
    if (!this.device) return;
    const { session } = requirePair(this.ctx);
    for (const day of recentDays(2)) {
      this.watchBox(day, await this.privateBox(peer.sealEpub, session.pub, this.device.deviceId, day));
    }
  }

  private watchBox(day: string, box: string) {
    const soul = `lain-io/mail/${day}/${box}#`;
    if (this.boxStops.has(soul)) return;
    this.boxStops.set(soul, subscribeMap(this.ctx.gun.get(soul), (hash, value) => {
      if (typeof value !== 'string') return;
      this.queue = this.queue.then(() => this.receive(hash, value)).catch((error) => console.warn('[lain-db] receive failed', error));
    }));
  }

  // ================= internals: receiving =================

  private async receive(hash: string, sealed: string) {
    if (!this.device || !this.store) return;
    const seenNs = accountNs(this.ctx, 'seen');
    if (this.ctx.platform.kv.get(seenNs, hash)) return;
    const markSeen = () => this.ctx.platform.kv.set(seenNs, hash, String(Date.now()));
    const inner = await unseal<Inner>(sealed, this.device.seal);
    if (!inner?.from || !inner.fd || !inner.b) { markSeen(); return; } // not for this device
    if (this.moderation.isPubBanned(inner.from) || this.safety.isBlocked(inner.from)) { markSeen(); return; }

    let sender = (await this.devicesOf(inner.from)).find((d) => d.deviceId === inner.fd);
    if (!sender) sender = (await this.devicesOf(inner.from, true)).find((d) => d.deviceId === inner.fd);
    if (!sender) { markSeen(); return; } // unknown or revoked device

    const name = signalName(sender.pub, sender.deviceId);
    if (this.store.pinIdentity(name, b64ToAb(sender.identityKey)) === 'changed') { this.addWarning(sender.pub, sender.deviceId); markSeen(); return; }

    const cipher = new SessionCipher(this.store, new SignalProtocolAddress(name, 1));
    const body = b64ToAb(inner.b);
    let plain: ArrayBuffer;
    try {
      plain = inner.t === 3 ? await cipher.decryptPreKeyWhisperMessage(body) : await cipher.decryptWhisperMessage(body);
    } catch (error) {
      if ((error as Error)?.name === 'IdentityMismatchError') this.addWarning(sender.pub, sender.deviceId);
      markSeen();
      return;
    }
    markSeen();
    this.addPeer(sender);
    const payload = safeJson<Payload>(abToText(plain));
    if (payload) await this.handlePayload(sender.pub, payload);
  }

  private async handlePayload(from: string, payload: Payload) {
    const { session } = requirePair(this.ctx);
    const fromSelf = from === session.pub;
    if (payload.t === 'leave') {
      const conv = this.getConversation(payload.convId);
      if (conv?.kind === 'group' && conv.members.includes(from)) {
        if (fromSelf) this.deleteLocalConversation(conv.id);
        else this.saveConversation({ ...conv, members: conv.members.filter((p) => p !== from) });
      }
      return;
    }
    const meta = payload.conv;
    if (!meta?.id || !Array.isArray(meta.members) || !meta.members.includes(session.pub)) {
      // Removed from a group: the owner's update no longer lists us.
      if (payload.t === 'group' && meta?.id && this.getConversation(meta.id)?.owner === from) this.deleteLocalConversation(meta.id);
      return;
    }
    if (!meta.members.includes(from)) return;
    let conv = this.getConversation(meta.id);

    if (meta.kind === 'direct') {
      // Direct ids are derived from the two pubs, so a sender can't inject messages into someone else's chat.
      const expected = `d:${await sha256url([...meta.members].sort().join('|'))}`;
      if (meta.members.length !== 2 || meta.id !== expected) return;
    } else if (meta.kind === 'group') {
      if (conv && !conv.members.includes(from)) return;           // not a member (any more)
      if (payload.t === 'group') {
        const owner = conv?.owner ?? meta.owner;
        if (owner !== from) return;                               // only the owner edits the group
      }
    } else {
      return;
    }

    if (!conv) {
      conv = this.saveConversation({ id: meta.id, kind: meta.kind, members: [...meta.members].sort(), name: meta.kind === 'group' ? String(meta.name ?? 'Group').slice(0, 60) : '', owner: meta.kind === 'group' ? meta.owner ?? from : undefined, lastMessageAt: Date.now(), lastMessagePreview: '', unread: 0 });
    } else if (payload.t === 'group') {
      conv = this.saveConversation({ ...conv, members: [...meta.members].sort(), name: String(meta.name ?? conv.name).slice(0, 60) });
    }

    if (payload.t === 'msg') {
      const text = String(payload.text ?? '').slice(0, MAX_MESSAGE_LENGTH);
      if (!text || !payload.id) return;
      const message: ChatMessage = { id: payload.id, conversationId: conv.id, from, text, sentAt: Number(payload.sentAt) || Date.now(), receivedAt: Date.now(), replyTo: payload.replyTo, status: fromSelf ? 'sent' : 'received' };
      this.storeMessage(message, !fromSelf);
    }
  }

  // ================= internals: local history =================

  private meta(conv: Conversation): ConvMeta {
    return { id: conv.id, kind: conv.kind, members: conv.members, ...(conv.kind === 'group' ? { name: conv.name, owner: conv.owner } : {}) };
  }

  private saveConversation(conv: Conversation): Conversation {
    this.ctx.platform.kv.set(accountNs(this.ctx, 'conv'), conv.id, JSON.stringify(conv));
    this.notifyConversations();
    return conv;
  }

  private storeMessage(message: ChatMessage, incoming: boolean) {
    const ns = accountNs(this.ctx, `msg:${message.conversationId}`);
    const key = `${pad(message.sentAt)}-${message.id}`;
    const isNew = !this.ctx.platform.kv.get(ns, key);
    this.ctx.platform.kv.set(ns, key, JSON.stringify(message));
    const conv = this.getConversation(message.conversationId);
    if (conv && (isNew || message.sentAt >= conv.lastMessageAt)) {
      this.saveConversation({
        ...conv,
        lastMessageAt: Math.max(conv.lastMessageAt, message.sentAt),
        lastMessagePreview: message.text.slice(0, 120),
        unread: conv.unread + (incoming && isNew ? 1 : 0),
      });
    }
    for (const cb of this.msgListeners.get(message.conversationId) ?? []) cb();
  }

  private notifyConversations() {
    if (!this.ctx.session) return;
    const list = this.listConversations();
    for (const cb of this.convListeners) cb(list);
  }

  private addWarning(pub: string, deviceId: number) {
    const ns = accountNs(this.ctx, 'idwarn');
    const key = signalName(pub, deviceId);
    if (this.ctx.platform.kv.get(ns, key)) return;
    this.ctx.platform.kv.set(ns, key, JSON.stringify({ pub, deviceId, at: Date.now() } satisfies IdentityWarning));
    this.notifyWarnings();
  }

  private notifyWarnings() { const list = this.identityWarnings(); for (const cb of this.warnListeners) cb(list); }

  private pruneSeen() {
    const ns = accountNs(this.ctx, 'seen');
    const cutoff = Date.now() - this.ctx.config.mailRetentionDays * 86_400_000;
    for (const { key, value } of this.ctx.platform.kv.list(ns)) if (Number(value) < cutoff) this.ctx.platform.kv.del(ns, key);
  }
}
