// Lain's data for the signed-in user (plan §B3). Everything private is
// encrypted with the account pair before it reaches Gun, and syncs across the
// user's devices.
//
//   ~pub/lain/chats/<chatId>/<msgId>  SEA.encrypt(LainChatMessage)
//   ~pub/lain/chatIndex/<chatId>      SEA.encrypt({title, updatedAt}) | null
//   ~pub/lain/memory/<factId>         SEA.encrypt(LainMemoryFact) | null
//   ~pub/lain/profile                 SEA.encrypt({summary, updatedAt})
//   ~pub/lain/consent                 JSON LainConsent              (signed, readable: it's a permission, not data)
//   ~pub/lain/model                   JSON ActiveModel              (signed)
// Local only (never leaves the device):
//   activity signals used to build memory; capped at 5000 events

import { newId, safeJson } from './encoding';
import { type Ctx, accountNs, collectMap, decryptWith, encryptFor, meNode, putAck, readOnce, requirePair, subscribeLeaf, subscribeMap, throttle } from './graph';
import type { ActiveModel, LainChatMessage, LainConsent, LainMemoryFact, SignalEvent, Unsubscribe } from './types';

const MAX_SIGNALS = 5000;
const pad = (n: number) => String(n).padStart(15, '0');
export const DEFAULT_CONSENT: LainConsent = { learnLocal: false, trainRemote: false, at: 0 };

export class LainData {
  private memory = new Map<string, LainMemoryFact>();
  private consent: LainConsent = DEFAULT_CONSENT;
  private stops: Unsubscribe[] = [];
  private memoryListeners = new Set<(facts: LainMemoryFact[]) => void>();
  private consentListeners = new Set<(c: LainConsent) => void>();
  private notifyMemory = throttle(() => { const list = this.listMemory(); for (const cb of this.memoryListeners) cb(list); });

  constructor(private ctx: Ctx) {}

  start() {
    this.stop();
    const { pair } = requirePair(this.ctx);
    const cachedConsent = safeJson<LainConsent>(this.ctx.platform.kv.get(accountNs(this.ctx, 'lain'), 'consent'));
    if (cachedConsent) this.consent = cachedConsent;
    this.stops.push(subscribeLeaf(meNode(this.ctx).get('lain').get('consent'), (raw) => {
      const c = safeJson<LainConsent>(raw);
      if (!c || c.at < this.consent.at) return;
      this.consent = { learnLocal: Boolean(c.learnLocal), trainRemote: Boolean(c.trainRemote), at: Number(c.at) };
      this.ctx.platform.kv.set(accountNs(this.ctx, 'lain'), 'consent', JSON.stringify(this.consent));
      for (const cb of this.consentListeners) cb(this.consent);
    }));
    this.stops.push(subscribeMap(meNode(this.ctx).get('lain').get('memory'), async (id, raw) => {
      const fact = await decryptWith<LainMemoryFact>(raw, pair);
      if (fact && fact.id === id) this.memory.set(id, fact); else this.memory.delete(id);
      this.notifyMemory();
    }));
  }

  stop() { for (const s of this.stops) s(); this.stops = []; this.memory.clear(); this.consent = DEFAULT_CONSENT; }

  // ---------- consent ----------

  getConsent(): LainConsent { return this.consent; }
  subscribeConsent(cb: (c: LainConsent) => void): Unsubscribe { this.consentListeners.add(cb); cb(this.consent); return () => { this.consentListeners.delete(cb); }; }

  async setConsent(patch: Partial<Pick<LainConsent, 'learnLocal' | 'trainRemote'>>): Promise<LainConsent> {
    requirePair(this.ctx);
    const next: LainConsent = { ...this.consent, ...patch, at: Date.now() };
    if (!next.learnLocal) next.trainRemote = false; // remote training needs local learning
    this.consent = next;
    this.ctx.platform.kv.set(accountNs(this.ctx, 'lain'), 'consent', JSON.stringify(next));
    for (const cb of this.consentListeners) cb(next);
    await putAck(meNode(this.ctx).get('lain').get('consent'), JSON.stringify(next));
    if (!next.learnLocal) this.clearSignals();
    return next;
  }

  // ---------- chats ----------

  /** `id`/`at` let the caller show the message before the write finishes and match it up afterwards. */
  async addChatMessage(chatId: string, role: LainChatMessage['role'], text: string, opts: { id?: string; at?: number } = {}): Promise<LainChatMessage> {
    const { pair } = requirePair(this.ctx);
    const message: LainChatMessage = { id: opts.id ?? newId(), chatId, role, text: text.slice(0, 20_000), at: opts.at ?? Date.now() };
    await this.writeChatMessage(message, pair);
    await putAck(meNode(this.ctx).get('lain').get('chatIndex').get(chatId), await encryptFor({ title: role === 'you' ? text.slice(0, 60) : '', updatedAt: message.at }, pair));
    if (role === 'you') this.recordSignal({ kind: 'lain-chat', data: text.slice(0, 500) });
    return message;
  }

  async rateMessage(chatId: string, messageId: string, rating: 1 | -1 | null): Promise<void> {
    const { pair } = requirePair(this.ctx);
    const node = meNode(this.ctx).get('lain').get('chats').get(chatId).get(messageId);
    const existing = await decryptWith<LainChatMessage>(await readOnce(node, this.ctx.config.readTimeoutMs), pair);
    if (!existing) return;
    const next = { ...existing, rating: rating ?? undefined };
    await this.writeChatMessage(next, pair);
    if (rating) this.recordSignal({ kind: 'rating', data: `${rating > 0 ? '+' : '-'}${existing.text.slice(0, 300)}` });
  }

  async listChat(chatId: string): Promise<LainChatMessage[]> {
    const { pair } = requirePair(this.ctx);
    const items = await collectMap(meNode(this.ctx).get('lain').get('chats').get(chatId), { idleMs: 500, maxMs: 4000 });
    const out: LainChatMessage[] = [];
    for (const raw of items.values()) { const m = await decryptWith<LainChatMessage>(raw, pair); if (m) out.push(m); }
    return out.sort((a, b) => a.at - b.at);
  }

  subscribeChat(chatId: string, cb: (messages: LainChatMessage[]) => void): Unsubscribe {
    const { pair } = requirePair(this.ctx);
    const messages = new Map<string, LainChatMessage>();
    const emit = throttle(() => cb([...messages.values()].sort((a, b) => a.at - b.at)));
    const stop = subscribeMap(meNode(this.ctx).get('lain').get('chats').get(chatId), async (id, raw) => {
      const m = await decryptWith<LainChatMessage>(raw, pair);
      if (m && m.id === id) messages.set(id, m); else messages.delete(id);
      emit();
    });
    emit();
    return stop;
  }

  async listChats(): Promise<Array<{ chatId: string; title: string; updatedAt: number }>> {
    const { pair } = requirePair(this.ctx);
    const items = await collectMap(meNode(this.ctx).get('lain').get('chatIndex'), { idleMs: 500, maxMs: 4000 });
    const out: Array<{ chatId: string; title: string; updatedAt: number }> = [];
    for (const [chatId, raw] of items) {
      const meta = await decryptWith<{ title: string; updatedAt: number }>(raw, pair);
      if (meta) out.push({ chatId, title: meta.title, updatedAt: meta.updatedAt });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteChat(chatId: string): Promise<void> {
    requirePair(this.ctx);
    const node = meNode(this.ctx).get('lain').get('chats').get(chatId);
    const items = await collectMap(node, { idleMs: 500, maxMs: 4000 });
    for (const id of items.keys()) await putAck(node.get(id), null, 3000);
    await putAck(meNode(this.ctx).get('lain').get('chatIndex').get(chatId), null);
  }

  // ---------- memory ("What Lain knows") ----------

  listMemory(): LainMemoryFact[] { return [...this.memory.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  subscribeMemory(cb: (facts: LainMemoryFact[]) => void): Unsubscribe { this.memoryListeners.add(cb); cb(this.listMemory()); return () => { this.memoryListeners.delete(cb); }; }

  async addMemory(input: { text: string; source: LainMemoryFact['source']; confidence?: number }): Promise<LainMemoryFact> {
    const { pair } = requirePair(this.ctx);
    const now = Date.now();
    const fact: LainMemoryFact = { id: newId(), text: input.text.trim().slice(0, 500), source: input.source, confidence: Math.max(0, Math.min(1, input.confidence ?? 0.7)), createdAt: now, updatedAt: now };
    if (!fact.text) throw new Error('A memory needs text.');
    this.memory.set(fact.id, fact);
    this.notifyMemory();
    await putAck(meNode(this.ctx).get('lain').get('memory').get(fact.id), await encryptFor(fact, pair));
    return fact;
  }

  async updateMemory(id: string, patch: Partial<Pick<LainMemoryFact, 'text' | 'confidence'>>): Promise<LainMemoryFact> {
    const { pair } = requirePair(this.ctx);
    const existing = this.memory.get(id);
    if (!existing) throw new Error('Memory not found.');
    const fact = { ...existing, ...patch, text: (patch.text ?? existing.text).trim().slice(0, 500), updatedAt: Date.now() };
    this.memory.set(id, fact);
    this.notifyMemory();
    await putAck(meNode(this.ctx).get('lain').get('memory').get(id), await encryptFor(fact, pair));
    return fact;
  }

  async deleteMemory(id: string): Promise<void> {
    requirePair(this.ctx);
    this.memory.delete(id);
    this.notifyMemory();
    await putAck(meNode(this.ctx).get('lain').get('memory').get(id), null);
  }

  async clearMemory(): Promise<void> {
    for (const id of [...this.memory.keys()]) await this.deleteMemory(id);
    await putAck(meNode(this.ctx).get('lain').get('profile'), null);
  }

  // ---------- profile summary ----------

  async getProfileSummary(): Promise<{ summary: string; updatedAt: number } | null> {
    const { pair } = requirePair(this.ctx);
    return (await decryptWith<{ summary: string; updatedAt: number }>(await readOnce(meNode(this.ctx).get('lain').get('profile'), this.ctx.config.readTimeoutMs), pair)) ?? null;
  }

  async setProfileSummary(summary: string): Promise<void> {
    const { pair } = requirePair(this.ctx);
    await putAck(meNode(this.ctx).get('lain').get('profile'), await encryptFor({ summary: summary.slice(0, 4000), updatedAt: Date.now() }, pair));
  }

  /** What the LLM layer injects into the system prompt (retrieval/ranking happens there). */
  async promptContext(maxFacts = 40): Promise<{ summary: string; facts: string[] }> {
    const profile = await this.getProfileSummary();
    const facts = this.listMemory().sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt).slice(0, maxFacts).map((f) => f.text);
    return { summary: profile?.summary ?? '', facts };
  }

  // ---------- active model ----------

  async getActiveModel(): Promise<ActiveModel | null> {
    return safeJson<ActiveModel>(await readOnce(meNode(this.ctx).get('lain').get('model'), this.ctx.config.readTimeoutMs)) ?? null;
  }
  async setActiveModel(model: Omit<ActiveModel, 'at'>): Promise<void> {
    requirePair(this.ctx);
    await putAck(meNode(this.ctx).get('lain').get('model'), JSON.stringify({ ...model, at: Date.now() }));
  }

  // ---------- activity signals (local only) ----------

  /** Ignored unless the user turned on "learn from my activity". */
  recordSignal(event: Omit<SignalEvent, 'id' | 'at'>): void {
    if (!this.ctx.session || !this.consent.learnLocal) return;
    const ns = accountNs(this.ctx, 'signals');
    const full: SignalEvent = { ...event, data: event.data.slice(0, 1000), id: newId(), at: Date.now() };
    this.ctx.platform.kv.set(ns, `${pad(full.at)}-${full.id}`, JSON.stringify(full));
    const all = this.ctx.platform.kv.list(ns);
    for (const { key } of all.slice(0, Math.max(0, all.length - MAX_SIGNALS))) this.ctx.platform.kv.del(ns, key);
  }

  listSignals(since = 0): SignalEvent[] {
    if (!this.ctx.session) return [];
    return this.ctx.platform.kv.list(accountNs(this.ctx, 'signals')).map(({ value }) => JSON.parse(value) as SignalEvent).filter((e) => e.at >= since);
  }

  clearSignals(): void { if (this.ctx.session) this.ctx.platform.kv.clear(accountNs(this.ctx, 'signals')); }

  // ---------- account deletion ----------

  async wipeMine(): Promise<void> {
    for (const chat of await this.listChats()) await this.deleteChat(chat.chatId);
    await this.clearMemory();
    await putAck(meNode(this.ctx).get('lain').get('consent'), null);
    await putAck(meNode(this.ctx).get('lain').get('model'), null);
    this.clearSignals();
    this.stop();
  }

  private async writeChatMessage(message: LainChatMessage, pair: Parameters<typeof encryptFor>[1]) {
    await putAck(meNode(this.ctx).get('lain').get('chats').get(message.chatId).get(message.id), await encryptFor(message, pair));
  }
}
