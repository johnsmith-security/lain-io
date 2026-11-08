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
  node.map().on((value: unknown, key: string, _msg: unknown, ev: any) => {
    if (ev) events.add(ev);
    if (!active) { try { ev?.off(); } catch { /* noop */ } return; }
    onItem(key, value);
  });
  return () => {
    active = false;
    for (const ev of events) { try { ev.off(); } catch { /* noop */ } }
    events.clear();
  };
}

/** Live subscription to a single leaf. */
export function subscribeLeaf(node: any, onValue: (value: unknown) => void): Unsubscribe {
  let active = true;
  let ev: any;
  node.on((value: unknown, _key: string, _msg: unknown, e: any) => {
    ev = e;
    if (!active) { try { e?.off(); } catch { /* noop */ } return; }
    onValue(value);
  });
  return () => { active = false; try { ev?.off(); } catch { /* noop */ } };
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
