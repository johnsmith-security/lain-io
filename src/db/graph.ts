// Thin wrapper around Gun + SEA. Everything else in src/db goes through here.
// Gun quirks handled here:
//  - records are stored as single JSON/SEA strings (atomic, no partial nodes)
//  - reads have a timeout (Gun has no reliable "not found")
//  - unsubscribe only removes *our* listeners (`.off()` would remove all)
//  - content-addressed ("#") writes compute the SHA-256 key Gun checks

import type { LainDbConfig } from './config';
import { b64url, safeJson } from './encoding';
import type { LocalKV, Platform } from './platform';
import type { SEAPair, Session, Unsubscribe } from './types';

/* eslint-disable @typescript-eslint/no-require-imports */
const Gun: any = require('gun');
const SEA: any = require('gun/sea');
/* eslint-enable @typescript-eslint/no-require-imports */

export { SEA };

let radiskLoaded = false;
function loadRadisk() {
  if (radiskLoaded) return;
  /* eslint-disable @typescript-eslint/no-require-imports */
  require('gun/lib/radix');
  require('gun/lib/radisk');
  require('gun/lib/store');
  /* eslint-enable @typescript-eslint/no-require-imports */
  radiskLoaded = true;
}

/** Radisk storage adapter on top of the platform KV (SQLite on device). */
function radStore(kv: LocalKV) {
  return {
    put(file: string, data: string, cb: (err: unknown, ok?: number) => void) {
      try { kv.set('gun', file, data); cb(null, 1); } catch (error) { cb(error); }
    },
    get(file: string, cb: (err: unknown, data?: string) => void) {
      try { cb(null, kv.get('gun', file) ?? undefined); } catch (error) { cb(error); }
    },
    list(cb: (file?: string) => void) {
      try { for (const { key } of kv.list('gun')) cb(key); } finally { cb(); }
    },
  };
}

export function createGun(platform: Platform, peers: string[]): any {
  const opt: Record<string, unknown> = { peers, localStorage: false, axe: false, multicast: false };
  if (platform.persistGun) {
    loadRadisk();
    opt.store = radStore(platform.kv);
    opt.file = 'lain';
  } else {
    opt.radisk = false;
    opt.file = false;
  }
  return Gun(opt);
}

// ---------- connection health ----------
//
// Gun's websocket client has two failure modes that silently stop all sync:
//  - if the first reconnect attempt fails, its 'bye' handler drops the peer and
//    it never tries again (relay restart, phone switching networks);
//  - it has no heartbeat, so a half-open socket (mobile NAT timeout, a proxy or
//    `kubectl port-forward` whose backend went away) looks connected forever.
// keepPeersAlive pings idle peers, replaces dead or hung sockets, and on every
// reconnect re-asks the relay for everything we're subscribed to, so writes
// made while we were offline still arrive. (A relay forgets a client's
// subscriptions when its socket closes, and only pushes live writes.)

const WS_OPEN = 1;
const randomMsgId = () => Math.random().toString(36).slice(2, 11);

/** The soul behind a chain like gun.get('a').get('b') → "a/b" (Gun names implicit child nodes by path). */
export function soulOf(node: any): string | null {
  const parts: string[] = [];
  let at = node?._;
  while (at) {
    if (at.soul) { parts.unshift(at.soul); return parts.join('/'); }
    if (at.get === undefined || at.root === at) return null;
    parts.unshift(String(at.get));
    at = at.back;
  }
  return null;
}

/** Active subscriptions per Gun root, so they can be re-asked after a reconnect. */
const liveSouls = new WeakMap<object, Map<string, { get: Record<string, string>; refs: number }>>();

function trackLive(node: any, leaf: boolean): () => void {
  const root = node?._?.root;
  if (!root) return () => {};
  let get: Record<string, string> | null = null;
  if (leaf) {
    const parent = soulOf(node.back?.());
    const key = node._?.get;
    if (parent && typeof key === 'string') get = { '#': parent, '.': key };
  } else {
    const soul = soulOf(node);
    if (soul) get = { '#': soul };
  }
  if (!get) return () => {};
  const id = get['.'] !== undefined ? `${get['#']}\u0000${get['.']}` : get['#'];
  let map = liveSouls.get(root);
  if (!map) liveSouls.set(root, (map = new Map()));
  const entry = map.get(id) ?? { get, refs: 0 };
  entry.refs++;
  map.set(id, entry);
  return () => { entry.refs--; if (entry.refs <= 0) map!.delete(id); };
}

/** Ask the relays again for every soul with a live subscription. Replies flow into the existing listeners. */
export function reaskLive(gun: any): number {
  const root = gun?._?.root;
  const map = root && liveSouls.get(root);
  if (!map) return 0;
  for (const { get } of map.values()) root.on('out', { get, '#': randomMsgId() });
  return map.size;
}

export type KeepAliveOptions = { intervalMs?: number; idleMs?: number; pingTimeoutMs?: number; connectTimeoutMs?: number };

/**
 * Keep every relay in `urls()` connected. Calls `onReconnect` when a relay that was
 * connected before comes back. Returns { stop, wake }; call wake() when the app
 * returns to the foreground or the network changes, to check right away.
 */
export function keepPeersAlive(gun: any, urls: () => string[], onReconnect: (url: string) => void, options: KeepAliveOptions = {}) {
  const { intervalMs = 5000, idleMs = 20_000, pingTimeoutMs = 8000, connectTimeoutMs = 12_000 } = options;
  const root = gun._.root;
  const opt = gun._.opt;
  const everConnected = new Set<string>();

  const instrument = (peer: any) => {
    const wire = peer?.wire;
    if (!wire || wire.__lainWrapped) return;
    const original = wire.onmessage;
    wire.onmessage = function (this: unknown, msg: unknown) {
      peer.lainIn = Date.now();
      peer.lainPing = 0;
      return original?.call(this, msg);
    };
    wire.__lainWrapped = true;
  };

  root.on('hi', function (this: any, peer: any) {
    this.to.next(peer);
    const url = peer?.url;
    if (!url) return;
    peer.lainIn = Date.now();
    peer.lainPing = 0;
    peer.lainOpening = 0;
    instrument(peer);
    if (everConnected.has(url)) onReconnect(url);
    everConnected.add(url);
  });

  const reopen = (url: string) => {
    const mesh = opt.mesh;
    if (!mesh?.wire) return;
    const peer = { url, id: url, lainOpening: Date.now() };
    opt.peers[url] = peer;
    try { mesh.wire(peer); } catch { /* retried next tick */ }
  };
  const kill = (peer: any) => {
    const wire = peer.wire;
    peer.wire = null;
    if (wire) {
      wire.onclose = wire.onerror = wire.onmessage = wire.onopen = null;
      try { wire.close(); } catch { /* already closed */ }
    }
    try { opt.mesh?.bye(peer); } catch { /* noop */ }
    delete opt.peers[peer.url ?? peer.id];
  };

  const check = (forcePing = false) => {
    const now = Date.now();
    for (const url of urls()) {
      if (!/^(wss?|https?):\/\//.test(url)) continue;
      const peer = opt.peers[url];
      if (!peer) { reopen(url); continue; }
      const wire = peer.wire;
      const state = wire?.readyState;
      if (!wire || state === 2 || state === 3) {
        // Gun's own reconnect timer may still be pending; give it one connect window.
        if (!peer.lainOpening) peer.lainOpening = now;
        else if (now - peer.lainOpening > connectTimeoutMs) { kill(peer); reopen(url); }
        continue;
      }
      if (state !== WS_OPEN) {                                    // CONNECTING
        if (!peer.lainOpening) peer.lainOpening = now;
        else if (now - peer.lainOpening > connectTimeoutMs) { kill(peer); reopen(url); }
        continue;
      }
      instrument(peer);
      if (peer.lainPing && now - peer.lainPing > pingTimeoutMs) { kill(peer); reopen(url); continue; }
      if (!peer.lainPing && (forcePing || now - (peer.lainIn ?? 0) > idleMs)) {
        peer.lainPing = now;
        try { opt.mesh.say({ dam: '?', pid: opt.pid }, peer); } catch { /* noop */ }
      }
    }
  };

  const timer = setInterval(() => check(false), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop: () => clearInterval(timer),
    wake: () => check(true),
  };
}

export type Ctx = {
  gun: any;
  platform: Platform;
  config: LainDbConfig;
  /** Set while signed in. */
  session: Session | null;
  pair: SEAPair | null;
  emit(event: string, payload?: unknown): void;
  on(event: string, listener: (payload: any) => void): Unsubscribe;
};

export function requirePair(ctx: Ctx): { pair: SEAPair; session: Session } {
  if (!ctx.pair || !ctx.session) throw new Error('Not signed in.');
  return { pair: ctx.pair, session: ctx.session };
}

/** Namespaced local KV for the signed-in account. */
export const accountNs = (ctx: Ctx, ns: string): string => `${requirePair(ctx).session.pub}:${ns}`;

// ---------- crypto helpers ----------

export async function sha256(text: string): Promise<string> {
  return SEA.work(text, null, null, { name: 'SHA-256' });
}
export const sha256url = async (text: string): Promise<string> => b64url(await sha256(text));

export async function encryptFor(data: unknown, keyOrPair: string | SEAPair): Promise<string> {
  const out = await SEA.encrypt(data, keyOrPair);
  if (typeof out !== 'string') throw new Error('Encryption failed.');
  return out;
}

export async function decryptWith<T>(data: unknown, keyOrPair: string | SEAPair): Promise<T | undefined> {
  if (typeof data !== 'string' || !data) return undefined;
  try { const out = await SEA.decrypt(data, keyOrPair); return (out ?? undefined) as T | undefined; } catch { return undefined; }
}

/** Encrypt to someone's epub with a throwaway key, so the sender stays anonymous. */
export async function sealTo(data: unknown, recipientEpub: string): Promise<string> {
  const eph = await SEA.pair();
  const secret = await SEA.secret(recipientEpub, eph);
  return JSON.stringify({ v: 1, e: eph.epub, c: await encryptFor(data, secret) });
}

export async function unseal<T>(sealed: string, pair: { epub: string; epriv: string }): Promise<T | undefined> {
  const box = safeJson<{ v: number; e: string; c: string }>(sealed);
  if (!box?.e || !box.c) return undefined;
  const secret = await SEA.secret(box.e, pair);
  if (!secret) return undefined;
  return decryptWith<T>(box.c, secret);
}

// ---------- graph helpers ----------

export const userNode = (ctx: Ctx, pub: string): any => ctx.gun.get(`~${pub}`);
export const meNode = (ctx: Ctx): any => { requirePair(ctx); return ctx.gun.user(); };

/** Read one leaf value. Resolves undefined when nothing arrives within the timeout; null when deleted. */
export function readOnce<T = unknown>(node: any, timeoutMs = 3000): Promise<T | null | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let ev: any;
    const finish = (value: T | null | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ev?.off(); } catch { /* already off */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    node.on((data: unknown, _key: string, _msg: unknown, e: any) => {
      ev = e;
      if (done) { try { e.off(); } catch { /* noop */ } return; }
      if (data === undefined) return;
      finish(data as T | null);
    });
  });
}

/** Write with ack. Rejects on a Gun error (e.g. unsigned write); resolves on ack or after the timeout (queued). */
export function putAck(node: any, value: unknown, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, timeoutMs);
    node.put(value, (ack: { err?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ack?.err) reject(new Error(String(ack.err))); else resolve();
    });
  });
}

/** Content-addressed write into a soul that contains "#": nobody can overwrite or forge the entry. */
export async function putHashed(ctx: Ctx, soul: string, value: string): Promise<string> {
  if (!soul.includes('#')) throw new Error('Hashed souls must contain "#".');
  const key = await sha256(value);
  await putAck(ctx.gun.get(soul).get(key), value);
  return key;
}

/** Live subscription to every child of a node. Returns an unsubscribe that removes only this listener. */
export function subscribeMap(node: any, onItem: (key: string, value: unknown) => void): Unsubscribe {
  let active = true;
  const events = new Set<any>();
  const untrack = trackLive(node, false);
  node.map().on((value: unknown, key: string, _msg: unknown, ev: any) => {
    if (ev) events.add(ev);
    if (!active) { try { ev?.off(); } catch { /* noop */ } return; }
    onItem(key, value);
  });
  return () => {
    if (active) untrack();
    active = false;
    for (const ev of events) { try { ev.off(); } catch { /* noop */ } }
    events.clear();
  };
}

/** Live subscription to a single leaf. */
export function subscribeLeaf(node: any, onValue: (value: unknown) => void): Unsubscribe {
  let active = true;
  let ev: any;
  const untrack = trackLive(node, true);
  node.on((value: unknown, _key: string, _msg: unknown, e: any) => {
    ev = e;
    if (!active) { try { e?.off(); } catch { /* noop */ } return; }
    onValue(value);
  });
  return () => { if (active) untrack(); active = false; try { ev?.off(); } catch { /* noop */ } };
}

/** Collect a map's children until no new item arrives for `idleMs` (or `maxMs` passes). */
export function collectMap(node: any, { idleMs = 700, maxMs = 4000 } = {}): Promise<Map<string, unknown>> {
  return new Promise((resolve) => {
    const items = new Map<string, unknown>();
    let idle: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(idle); clearTimeout(cap); unsubscribe(); resolve(items); };
    const bump = () => { clearTimeout(idle); idle = setTimeout(finish, idleMs); };
    const cap = setTimeout(finish, maxMs);
    const unsubscribe = subscribeMap(node, (key, value) => { items.set(key, value); bump(); });
    bump();
  });
}

/** Batch frequent updates into one callback per animation-ish frame. */
export function throttle(fn: () => void, ms = 80): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
}

export async function postJson<T>(ctx: Ctx, path: string, body: unknown): Promise<{ ok: boolean; status: number; data?: T }> {
  if (!ctx.config.serviceUrl) return { ok: false, status: 0 };
  try {
    const res = await ctx.platform.fetch(`${ctx.config.serviceUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data: T | undefined;
    try { data = (await res.json()) as T; } catch { data = undefined; }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0 };
  }
}
