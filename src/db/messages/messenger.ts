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
// conversations, decrypted history, outbox.
//
// Inside the ratchet (the relay sees none of this):
//   msg    text and/or encrypted attachments (AES-GCM blob on the media relay / IPFS;
//          the key and iv travel only here)
//   rcpt   delivered / read receipts (direct chats). 'read' always syncs to your own
//          devices (clears unread there); peers get it only with Settings.readReceipts.
//   del    delete for everyone (sender only)
//   group / leave   group membership
//
// Reliability: a write the relay never acked marks the message 'failed' and puts
// it in the outbox, which is flushed on reconnect, on wake() and every minute
// (24 h). Recipients dedupe by message id. Mailboxes older than yesterday are
// read once at start (catch-up after days offline, up to mailRetentionDays).
//
// Groups are pairwise fan-out over the 1:1 sessions (every member gets their
// own ratchet message). Forward secrecy holds, cost is O(members). Fine for
// small groups; switch to Sender Keys / MLS if groups grow past ~100.

import { FingerprintGenerator, KeyHelper, SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';
import { abToB64, abToText, b64ToAb, binaryStringToBytes, bytesToB64, dayBucket, newId, randomBytes, recentDays, safeJson, textToAb } from '../encoding';
import { type Ctx, SEA, accountNs, collectMap, meNode, putAck, requirePair, sealTo, sha256, sha256url, subscribeMap, throttle, unseal, userNode } from '../graph';
import { type Media, isVideo, sanitizePrivateMediaList } from '../media';
import type { Moderation } from '../moderation';
import type { SafetyStore, SettingsStore } from '../settings';
import type { ChatMessage, Conversation, IdentityWarning, MessageStatus, PrivateMediaRef, SEAPair, Unsubscribe } from '../types';
import { type DeviceSecrets, SignalStore, identityName } from './signalStore';

const PREKEY_TARGET = 50;
const PREKEY_REFILL_BELOW = 20;
const SIGNED_PREKEY_ROTATE_MS = 7 * 86_400_000;
const SIGNED_PREKEY_KEEP_MS = 30 * 86_400_000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_GROUP_MEMBERS = 100;
/** Relays drop values over 64 KB; keep sealed envelopes under that. */
const MAX_ENVELOPE_CHARS = 60_000;
const OUTBOX_MAX_AGE_MS = 24 * 3_600_000;
const OUTBOX_INTERVAL_MS = 60_000;
/** A mail write the relay doesn't ack in this time counts as not sent (retried from the outbox). */
const MAIL_ACK_TIMEOUT_MS = 10_000;
const RECEIPT_DELAY_MS = 800;
const STATUS_RANK: Record<MessageStatus, number> = { failed: 0, sending: 1, sent: 2, delivered: 3, read: 4, received: 0 };

export class MessageTooLargeError extends Error {
  constructor() { super('This message is too large. Send fewer attachments or shorter text.'); this.name = 'MessageTooLargeError'; }
}

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
  | { t: 'msg'; conv: ConvMeta; id: string; text: string; sentAt: number; replyTo?: string; media?: PrivateMediaRef[] }
  | { t: 'rcpt'; convId: string; ids: string[]; s: 'delivered' | 'read'; at: number }
  | { t: 'del'; convId: string; id: string; at: number }
  | { t: 'group'; conv: ConvMeta; at: number }
  | { t: 'leave'; convId: string; at: number };
type OutboxEntry = { conversationId: string; id: string; at: number; tries: number };
type Inner = { from: string; fd: number; t: number; b: string };

const signalName = (pub: string, deviceId: number) => `${pub}|${deviceId}`;
/** One-line preview for the conversation list. */
export function previewOf(message: Pick<ChatMessage, 'text' | 'media' | 'deleted'>): string {
  if (message.deleted) return 'Message deleted';
  if (message.text) return message.text.slice(0, 120);
  const media = message.media ?? [];
  if (media.some((m) => isVideo({ mime: m.plainMime }))) return '🎞 Video';
  return media.length > 1 ? `📷 ${media.length} photos` : '📷 Photo';
}
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
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private pendingReceipts = new Map<string, { to: string; ids: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  private ctxStops: Unsubscribe[] = [];

  constructor(private ctx: Ctx, private safety: SafetyStore, private moderation: Moderation, private settings: SettingsStore, private media: Media) {}

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
    const lastDay = this.ctx.platform.kv.get(accountNs(this.ctx, 'sync'), 'lastDay');
    this.resubscribeAll();
    this.dayTimer = setInterval(() => this.resubscribeAll(), 10 * 60_000);
    this.outboxTimer = setInterval(() => { void this.flushOutbox(); }, OUTBOX_INTERVAL_MS);
    (this.outboxTimer as { unref?: () => void }).unref?.();
    (this.dayTimer as { unref?: () => void }).unref?.();
    this.ctxStops.push(this.ctx.on('reconnect', () => { void this.flushOutbox(); }));
    this.ctxStops.push(this.ctx.on('wake', () => { this.resubscribeAll(); void this.flushOutbox(); }));
    void this.catchUp(lastDay);
    void this.flushOutbox();
  }

  stop() {
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.dayTimer = null;
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.outboxTimer = null;
    for (const stop of this.ctxStops) stop();
    this.ctxStops = [];
    for (const pending of this.pendingReceipts.values()) clearTimeout(pending.timer);
    this.pendingReceipts.clear();
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

  /**
   * Mark everything in a conversation read. Syncs to your other devices, and (direct
   * chats, Settings.readReceipts on) tells the sender, whose message turns 'read'.
   */
  markRead(conversationId: string) {
    const conv = this.getConversation(conversationId);
    if (!conv || !this.ctx.session) return;
    const me = this.ctx.session.pub;
    const now = Date.now();
    const ns = accountNs(this.ctx, `msg:${conversationId}`);
    const ids: string[] = [];
    for (const { key, value } of this.ctx.platform.kv.list(ns)) {
      const m = JSON.parse(value) as ChatMessage;
      if (m.from === me || m.readAt) continue;
      this.ctx.platform.kv.set(ns, key, JSON.stringify({ ...m, readAt: now }));
      ids.push(m.id);
    }
    if (conv.unread) this.saveConversation({ ...conv, unread: 0 });
    if (!ids.length) return;
    this.notifyMessages(conversationId);
    if (!this.device) return;
    const peers = conv.kind === 'direct' && this.settings.get().readReceipts
      ? conv.members.filter((p) => p !== me && !this.safety.isBlocked(p)) : [];
    void this.fanOut(peers, { t: 'rcpt', convId: conversationId, ids: ids.slice(-200), s: 'read', at: now }).catch(() => 0);
  }

  /** Total unread messages across conversations (for a tab badge). */
  unreadTotal(): number { return this.ctx.session ? this.listConversations().reduce((sum, c) => sum + (c.unread || 0), 0) : 0; }

  /** Delete one message from this device only; the recipient's copy is unchanged. */
  deleteLocalMessage(conversationId: string, messageId: string): boolean {
    const target = this.listMessages(conversationId, { limit: 10_000 }).find((message) => message.id === messageId);
    if (!target) return false;
    this.ctx.platform.kv.del(accountNs(this.ctx, `msg:${conversationId}`), `${pad(target.sentAt)}-${target.id}`);
    const remaining = this.listMessages(conversationId, { limit: 10_000 });
    const latest = remaining.reduce<ChatMessage | null>((current, message) => !current || message.sentAt > current.sentAt ? message : current, null);
    const conv = this.getConversation(conversationId);
    if (conv) this.saveConversation({
      ...conv,
      lastMessageAt: latest?.sentAt ?? 0,
      lastMessagePreview: latest ? previewOf(latest) : '',
      unread: target.status === 'received' ? Math.max(0, conv.unread - 1) : conv.unread,
    });
    this.ctx.platform.kv.del(accountNs(this.ctx, 'outbox'), `${conversationId}|${messageId}`);
    for (const cb of this.msgListeners.get(conversationId) ?? []) cb();
    return true;
  }

  /** Delete one of your messages for everyone: recipients replace it with a tombstone; attachments are released. */
  async deleteForEveryone(conversationId: string, messageId: string): Promise<void> {
    const { session } = requirePair(this.ctx);
    const found = this.findMessage(conversationId, messageId);
    const conv = this.getConversation(conversationId);
    if (!found || !conv) return;
    if (found.message.from !== session.pub) throw new Error('You can only delete your own messages for everyone.');
    this.tombstone(found.key, found.message);
    this.ctx.platform.kv.del(accountNs(this.ctx, 'outbox'), `${conversationId}|${messageId}`);
    for (const m of found.message.media ?? []) void this.media.release(m.sha);
    await this.fanOut(conv.members.filter((p) => p !== session.pub), { t: 'del', convId: conversationId, id: messageId, at: Date.now() }).catch(() => 0);
  }

  /** Removes the conversation and its history from this device only. */
  deleteLocalConversation(conversationId: string) {
    this.ctx.platform.kv.del(accountNs(this.ctx, 'conv'), conversationId);
    this.ctx.platform.kv.clear(accountNs(this.ctx, `msg:${conversationId}`));
    for (const entry of this.outbox()) if (entry.conversationId === conversationId) this.ctx.platform.kv.del(accountNs(this.ctx, 'outbox'), `${entry.conversationId}|${entry.id}`);
    this.notifyConversations();
  }

  // ================= sending =================

  /**
   * Send text and/or attachments. Upload attachments first with db.media.uploadPrivate
   * (uploadPrivatePrepared in the app) and pass the refs. Resolves with status 'sent'
   * or 'failed'; failed ones stay in the outbox and are retried automatically.
   */
  async send(conversationId: string, text: string, options: { replyTo?: string; media?: PrivateMediaRef[] } = {}): Promise<ChatMessage> {
    const { session } = requirePair(this.ctx);
    const body = text.trim();
    const media = sanitizePrivateMediaList(options.media);
    if (options.media?.length && !media) throw new Error('These attachments can’t be sent.');
    if (!body && !media) throw new Error('Write a message first.');
    if (body.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`);
    const conv = this.getConversation(conversationId);
    if (!conv) throw new Error('Conversation not found.');
    const others = conv.members.filter((pub) => pub !== session.pub);
    if (conv.kind === 'direct' && others.every((pub) => this.safety.isBlocked(pub))) throw new Error('You blocked this person. Unblock them to send messages.');
    const message: ChatMessage = { id: newId(), conversationId, from: session.pub, text: body, sentAt: Date.now(), receivedAt: Date.now(), replyTo: options.replyTo, status: 'sending', ...(media ? { media } : {}) };
    this.storeMessage(message, false);
    return this.deliver(conv, message);
  }

  /** Retry a failed message now (same id, so recipients dedupe). */
  async resend(conversationId: string, messageId: string): Promise<ChatMessage | null> {
    const found = this.findMessage(conversationId, messageId);
    const conv = this.getConversation(conversationId);
    if (!found || !conv || found.message.deleted || found.message.from !== this.ctx.session?.pub) return null;
    this.storeMessage({ ...found.message, status: 'sending' }, false);
    return this.deliver(conv, found.message);
  }

  /** Messages waiting to be re-sent. */
  outbox(): OutboxEntry[] {
    if (!this.ctx.session) return [];
    return this.ctx.platform.kv.list(accountNs(this.ctx, 'outbox')).map(({ value }) => JSON.parse(value) as OutboxEntry);
  }

  /** Retry everything in the outbox (runs on reconnect, wake() and every minute). */
  flushOutbox(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = (async () => {
      try {
        if (!this.device || !this.ctx.session) return;
        const ns = accountNs(this.ctx, 'outbox');
        for (const entry of this.outbox()) {
          const key = `${entry.conversationId}|${entry.id}`;
          const found = this.findMessage(entry.conversationId, entry.id);
          const conv = this.getConversation(entry.conversationId);
          if (!found || !conv || found.message.deleted || STATUS_RANK[found.message.status] >= STATUS_RANK.sent || Date.now() - entry.at > OUTBOX_MAX_AGE_MS) {
            this.ctx.platform.kv.del(ns, key);
            continue;
          }
          await this.deliver(conv, found.message).catch(() => undefined);
        }
      } catch (error) {
        console.warn('[lain-db] outbox flush failed', error);
      }
    })();
    // Clear only after assigning: an empty outbox finishes synchronously.
    this.flushing = run.finally(() => { if (this.flushing === guarded) this.flushing = null; });
    const guarded = this.flushing;
    return guarded;
  }

  private async deliver(conv: Conversation, message: ChatMessage): Promise<ChatMessage> {
    const { session } = requirePair(this.ctx);
    const payload: Payload = {
      t: 'msg', conv: this.meta(conv), id: message.id, text: message.text, sentAt: message.sentAt,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}), ...(message.media ? { media: message.media } : {}),
    };
    const recipients = conv.members.filter((pub) => pub !== session.pub && !this.safety.isBlocked(pub));
    let reached = 0;
    let tooLarge = false;
    try { reached = await this.fanOut(recipients, payload); } catch (error) { tooLarge = error instanceof MessageTooLargeError; }
    const ok = reached > 0 || recipients.length === 0;
    const current = this.findMessage(conv.id, message.id)?.message ?? message;
    // A receipt can arrive before the relay's ack; never downgrade.
    const status: MessageStatus = ok ? (STATUS_RANK[current.status] > STATUS_RANK.sent ? current.status : 'sent') : 'failed';
    const final: ChatMessage = { ...current, status };
    this.storeMessage(final, false);
    const outboxNs = accountNs(this.ctx, 'outbox');
    const key = `${conv.id}|${message.id}`;
    if (ok || tooLarge) this.ctx.platform.kv.del(outboxNs, key);
    else {
      const previous = safeJson<OutboxEntry>(this.ctx.platform.kv.get(outboxNs, key));
      this.ctx.platform.kv.set(outboxNs, key, JSON.stringify({ conversationId: conv.id, id: message.id, at: previous?.at ?? message.sentAt, tries: (previous?.tries ?? 0) + 1 } satisfies OutboxEntry));
    }
    if (tooLarge) throw new MessageTooLargeError();
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
      const read = async (idleMs: number, maxMs: number) => {
        const out: PublishedDevice[] = [];
        for (const [key, value] of await collectMap(userNode(this.ctx, pub).get('devices'), { idleMs, maxMs })) {
          const d = safeJson<Omit<PublishedDevice, 'pub'>>(value);
          if (!d || String(d.deviceId) !== key || !d.identityKey || !d.sealEpub || !d.signedPreKey?.publicKey) continue;
          out.push({ ...d, pub });
        }
        return out;
      };
      devices = await read(600, this.ctx.config.readTimeoutMs);
      // Nothing yet usually means a slow link, not "no devices": look again, longer.
      if (!devices.length) devices = await read(1500, Math.max(8000, this.ctx.config.readTimeoutMs * 3));
      // Never cache an empty answer, or one slow read blocks messaging to this person for a minute.
      if (devices.length) this.deviceCache.set(pub, { at: Date.now(), devices });
      else this.deviceCache.delete(pub);
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
        if (await this.sendToDevice(target, plain)) { if (target.pub !== session.pub) reached++; }
        else if (target.pub !== session.pub) console.warn('[lain-db] relay did not ack mail for', target.pub.slice(0, 8), target.deviceId);
      } catch (error) {
        if (error instanceof MessageTooLargeError) throw error;
        console.warn('[lain-db] send to device failed', target.pub.slice(0, 8), target.deviceId, error);
      }
    }
    if (!targets.some((t) => t.pub !== session.pub) && pubs.some((p) => p !== session.pub)) console.warn('[lain-db] no devices found for recipients');
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
    // Rough size check before advancing the ratchet: Signal + seal roughly doubles base64 text.
    if (plain.byteLength * 2.2 + 1500 > MAX_ENVELOPE_CHARS) throw new MessageTooLargeError();
    const encrypted = await cipher.encrypt(plain);
    if (!encrypted.body) throw new Error('Encryption produced no body.');
    const inner: Inner = { from: session.pub, fd: this.device!.deviceId, t: encrypted.type, b: bytesToB64(binaryStringToBytes(encrypted.body)) };
    const sealed = await sealTo(inner, target.sealEpub);
    if (sealed.length > MAX_ENVELOPE_CHARS) throw new MessageTooLargeError();
    const day = recentDays(1)[0];
    const box = encrypted.type === 3
      ? await this.publicBox(target.pub, target.deviceId, day)
      : await this.privateBox(target.sealEpub, target.pub, target.deviceId, day);
    this.addPeer(target);
    // Only a relay ack counts: putAck alone resolves on timeout, which would hide a dead link.
    return this.putMail(`lain-io/mail/${day}/${box}#`, sealed);
  }

  /** Content-addressed write that resolves true only when a relay acked it. */
  private async putMail(soul: string, value: string): Promise<boolean> {
    const key = await sha256(value);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
      const timer = setTimeout(() => finish(false), MAIL_ACK_TIMEOUT_MS);
      this.ctx.gun.get(soul).get(key).put(value, (ack: { err?: string }) => finish(!ack?.err));
    });
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
    this.ctx.platform.kv.set(accountNs(this.ctx, 'sync'), 'lastDay', days[0]);
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

  /**
   * Read mailboxes of days we missed (app closed for a while) once. Today and
   * yesterday are live subscriptions; this covers older days up to mailRetentionDays.
   */
  private async catchUp(last: string | null) {
    if (!this.device || !this.ctx.session) return;
    if (!last || last >= dayBucket()) return;
    const maxDays = this.ctx.config.mailRetentionDays;
    const days = recentDays(maxDays).filter((d) => d >= last).slice(2);  // skip today/yesterday (live)
    if (!days.length) return;
    const { session } = requirePair(this.ctx);
    const deviceId = this.device.deviceId;
    const boxes: Array<Promise<string>> = [];
    for (const day of days) {
      boxes.push(this.publicBox(session.pub, deviceId, day).then((b) => `lain-io/mail/${day}/${b}#`));
      for (const peer of this.peers()) boxes.push(this.privateBox(peer.sealEpub, session.pub, deviceId, day).then((b) => `lain-io/mail/${day}/${b}#`));
    }
    const souls = await Promise.all(boxes);
    for (let i = 0; i < souls.length; i += 8) {
      await Promise.all(souls.slice(i, i + 8).map(async (soul) => {
        const items = await collectMap(this.ctx.gun.get(soul), { idleMs: 700, maxMs: 4000 });
        for (const [hash, value] of items) {
          if (typeof value !== 'string') continue;
          this.queue = this.queue.then(() => this.receive(hash, value)).catch((error) => console.warn('[lain-db] receive failed', error));
        }
      }));
      if (!this.device) return;
    }
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
    if (payload.t === 'rcpt') { this.handleReceipt(from, payload); return; }
    if (payload.t === 'del') { this.handleDelete(from, payload); return; }
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
      const text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_MESSAGE_LENGTH) : '';
      const media = sanitizePrivateMediaList(payload.media);
      if ((!text && !media) || typeof payload.id !== 'string' || !payload.id || payload.id.length > 64) return;
      const sentAt = Number(payload.sentAt) || Date.now();
      const existing = this.findMessage(conv.id, payload.id);
      if (existing) {
        // Retried copy (the sender didn't see the relay's ack). Re-confirm delivery, change nothing else.
        if (!fromSelf && conv.kind === 'direct') this.queueReceipt(conv.id, from, payload.id);
        return;
      }
      if (this.isDeletedId(conv.id, payload.id)) return;   // "delete for everyone" arrived first
      const message: ChatMessage = {
        id: payload.id, conversationId: conv.id, from, text, sentAt: Math.min(sentAt, Date.now() + 5 * 60_000), receivedAt: Date.now(),
        ...(typeof payload.replyTo === 'string' ? { replyTo: payload.replyTo.slice(0, 64) } : {}),
        ...(media ? { media } : {}),
        status: fromSelf ? 'sent' : 'received',
      };
      this.storeMessage(message, !fromSelf);
      if (!fromSelf && conv.kind === 'direct') this.queueReceipt(conv.id, from, payload.id);
    }
  }

  /** Batch 'delivered' receipts per conversation (one envelope for a burst of messages). */
  private queueReceipt(conversationId: string, to: string, id: string) {
    let pending = this.pendingReceipts.get(conversationId);
    if (!pending) {
      const timer = setTimeout(() => {
        const entry = this.pendingReceipts.get(conversationId);
        this.pendingReceipts.delete(conversationId);
        if (!entry || !this.device || this.safety.isBlocked(entry.to)) return;
        void this.fanOut([entry.to], { t: 'rcpt', convId: conversationId, ids: [...entry.ids].slice(-200), s: 'delivered', at: Date.now() }).catch(() => 0);
      }, RECEIPT_DELAY_MS);
      pending = { to, ids: new Set(), timer };
      this.pendingReceipts.set(conversationId, pending);
    }
    pending.ids.add(id);
  }

  private handleReceipt(from: string, payload: Extract<Payload, { t: 'rcpt' }>) {
    const me = this.ctx.session?.pub;
    const conv = typeof payload.convId === 'string' ? this.getConversation(payload.convId) : null;
    if (!me || !conv || !conv.members.includes(from) || !Array.isArray(payload.ids)) return;
    const ids = new Set(payload.ids.filter((id): id is string => typeof id === 'string').slice(0, 500));
    const ns = accountNs(this.ctx, `msg:${conv.id}`);
    let changed = false;
    if (from === me) {
      // Read on another of my devices: mark those incoming messages read here too.
      if (payload.s !== 'read') return;
      let cleared = 0;
      for (const { key, value } of this.ctx.platform.kv.list(ns)) {
        const m = JSON.parse(value) as ChatMessage;
        if (!ids.has(m.id) || m.from === me || m.readAt) continue;
        this.ctx.platform.kv.set(ns, key, JSON.stringify({ ...m, readAt: Number(payload.at) || Date.now() }));
        cleared++;
        changed = true;
      }
      if (cleared && conv.unread) this.saveConversation({ ...conv, unread: Math.max(0, conv.unread - cleared) });
    } else {
      if (conv.kind !== 'direct') return;
      const next: MessageStatus = payload.s === 'read' ? 'read' : 'delivered';
      for (const { key, value } of this.ctx.platform.kv.list(ns)) {
        const m = JSON.parse(value) as ChatMessage;
        if (!ids.has(m.id) || m.from !== me || m.deleted || STATUS_RANK[m.status] >= STATUS_RANK[next]) continue;
        this.ctx.platform.kv.set(ns, key, JSON.stringify({ ...m, status: next }));
        this.ctx.platform.kv.del(accountNs(this.ctx, 'outbox'), `${conv.id}|${m.id}`);
        changed = true;
      }
    }
    if (changed) this.notifyMessages(conv.id);
  }

  private handleDelete(from: string, payload: Extract<Payload, { t: 'del' }>) {
    const conv = typeof payload.convId === 'string' ? this.getConversation(payload.convId) : null;
    if (!conv || !conv.members.includes(from) || typeof payload.id !== 'string') return;
    const found = this.findMessage(conv.id, payload.id);
    if (!found) { this.ctx.platform.kv.set(accountNs(this.ctx, `deleted:${conv.id}`), payload.id, String(Date.now())); return; }
    if (found.message.from !== from) return;                    // only the sender can delete it for everyone
    const wasUnread = found.message.from !== this.ctx.session?.pub && !found.message.readAt;
    this.tombstone(found.key, found.message);
    if (wasUnread && conv.unread) this.saveConversation({ ...(this.getConversation(conv.id) ?? conv), unread: Math.max(0, conv.unread - 1) });
  }

  private isDeletedId(conversationId: string, id: string): boolean {
    return Boolean(this.ctx.platform.kv.get(accountNs(this.ctx, `deleted:${conversationId}`), id));
  }

  private findMessage(conversationId: string, messageId: string): { key: string; message: ChatMessage } | null {
    for (const { key, value } of this.ctx.platform.kv.list(accountNs(this.ctx, `msg:${conversationId}`))) {
      if (key.endsWith(`-${messageId}`)) {
        const message = safeJson<ChatMessage>(value);
        if (message?.id === messageId) return { key, message };
      }
    }
    return null;
  }

  private tombstone(key: string, message: ChatMessage) {
    const { media: _media, replyTo: _replyTo, ...rest } = message;
    this.ctx.platform.kv.set(accountNs(this.ctx, `msg:${message.conversationId}`), key, JSON.stringify({ ...rest, text: '', deleted: true, readAt: rest.readAt ?? Date.now() } satisfies ChatMessage));
    this.refreshPreview(message.conversationId);
    this.notifyMessages(message.conversationId);
  }

  private refreshPreview(conversationId: string) {
    const conv = this.getConversation(conversationId);
    if (!conv) return;
    const latest = this.listMessages(conversationId, { limit: 1 })[0];
    this.saveConversation({ ...conv, lastMessagePreview: latest ? previewOf(latest) : '' });
  }

  private notifyMessages(conversationId: string) { for (const cb of this.msgListeners.get(conversationId) ?? []) cb(); }

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
        lastMessagePreview: previewOf(message),
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
