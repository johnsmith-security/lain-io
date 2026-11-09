// Private, encrypted settings that sync across the user's devices:
//   ~pub/private/settings  SEA.encrypt(Settings, pair)
//   ~pub/private/safety    SEA.encrypt(Safety, pair)   (blocks + muted words)

import { safeJson } from './encoding';
import { type Ctx, accountNs, decryptWith, encryptFor, meNode, putAck, requirePair, subscribeLeaf } from './graph';
import type { Safety, Settings, Unsubscribe } from './types';

export const DEFAULT_SETTINGS: Settings = {
  lainStyle: 'vaporwave',
  selectedModel: 'lain-000',
  privatePresence: true,
  quietMode: false,
  showActivity: true,
  readReceipts: false,
  typingIndicators: false,
  showSensitiveMedia: false,
  relays: [],
  updatedAt: 0,
};

export const DEFAULT_SAFETY: Safety = { blocked: {}, mutedWords: [] };

class EncryptedDoc<T extends object> {
  private value: T;
  private listeners = new Set<(value: T) => void>();
  private stop: Unsubscribe | null = null;

  constructor(private ctx: Ctx, private key: 'settings' | 'safety', private defaults: T) {
    this.value = defaults;
  }

  /** Load the local cache, then follow the synced copy. Called on sign-in. */
  start() {
    this.stopSync();
    const cached = safeJson<T>(this.ctx.platform.kv.get(accountNs(this.ctx, 'doc'), this.key));
    this.value = { ...this.defaults, ...(cached ?? {}) };
    this.notify();
    const { pair } = requirePair(this.ctx);
    this.stop = subscribeLeaf(meNode(this.ctx).get('private').get(this.key), async (raw) => {
      const data = await decryptWith<T>(raw, pair);
      if (!data) return;
      const incoming = { ...this.defaults, ...data };
      if (Number((incoming as any).updatedAt ?? 0) < Number((this.value as any).updatedAt ?? 0)) return;
      this.value = incoming;
      this.ctx.platform.kv.set(accountNs(this.ctx, 'doc'), this.key, JSON.stringify(this.value));
      this.notify();
    });
  }

  stopSync() { this.stop?.(); this.stop = null; }

  get(): T { return this.value; }

  subscribe(cb: (value: T) => void): Unsubscribe {
    this.listeners.add(cb);
    cb(this.value);
    return () => { this.listeners.delete(cb); };
  }

  async set(next: T): Promise<T> {
    const { pair } = requirePair(this.ctx);
    this.value = { ...next, updatedAt: Date.now() } as T;
    this.ctx.platform.kv.set(accountNs(this.ctx, 'doc'), this.key, JSON.stringify(this.value));
    this.notify();
    await putAck(meNode(this.ctx).get('private').get(this.key), await encryptFor(this.value, pair));
    return this.value;
  }

  async wipe() {
    this.stopSync();
    this.value = this.defaults;
    await putAck(meNode(this.ctx).get('private').get(this.key), null);
  }

  private notify() { for (const cb of this.listeners) cb(this.value); }
}

export class SettingsStore {
  private doc: EncryptedDoc<Settings>;
  constructor(ctx: Ctx) { this.doc = new EncryptedDoc(ctx, 'settings', DEFAULT_SETTINGS); }
  start() { this.doc.start(); }
  stop() { this.doc.stopSync(); }
  get(): Settings { return this.doc.get(); }
  subscribe(cb: (settings: Settings) => void): Unsubscribe { return this.doc.subscribe(cb); }
  update(patch: Partial<Omit<Settings, 'updatedAt'>>): Promise<Settings> { return this.doc.set({ ...this.doc.get(), ...patch }); }
  wipe() { return this.doc.wipe(); }
}

export class SafetyStore {
  private doc: EncryptedDoc<Safety & { updatedAt: number }>;
  constructor(ctx: Ctx) { this.doc = new EncryptedDoc<Safety & { updatedAt: number }>(ctx, 'safety', { ...DEFAULT_SAFETY, updatedAt: 0 }); }
  start() { this.doc.start(); }
  stop() { this.doc.stopSync(); }
  get(): Safety { return this.doc.get(); }
  subscribe(cb: (safety: Safety) => void): Unsubscribe { return this.doc.subscribe(cb); }
  isBlocked(pub: string): boolean { return Boolean(this.doc.get().blocked[pub]); }
  async block(pub: string) { const s = this.doc.get(); await this.doc.set({ ...s, blocked: { ...s.blocked, [pub]: Date.now() } }); }
  async unblock(pub: string) { const s = this.doc.get(); const blocked = { ...s.blocked }; delete blocked[pub]; await this.doc.set({ ...s, blocked }); }
  async setMutedWords(words: string[]) {
    const clean = [...new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 200);
    await this.doc.set({ ...this.doc.get(), mutedWords: clean });
  }
  wipe() { return this.doc.wipe(); }
}
