// Username ownership.
//
// Production: the main relay runs a registrar. A user signs a claim
// {name, pub, at}; the registrar accepts the first claim it sees for a name and
// writes {pub, at} into its own Gun space (`~<registrarPub>/usernames/<name>`),
// which only the registrar key can write. Clients trust only that record.
//
// Development (no registrar configured): claims go into the content-addressed
// soul `lain-io/usernames/<name>#` and the earliest valid signed claim wins.
// Timestamps can be backdated, so this mode is not safe for production.

import { safeJson } from './encoding';
import { type Ctx, SEA, collectMap, postJson, putHashed, readOnce, userNode } from './graph';
import type { SEAPair } from './types';

export const USERNAME_RULE = '3–20 characters: lowercase letters, numbers, underscore.';

const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'security', 'staff', 'official',
  'mod', 'moderator', 'moderation', 'laincorp', 'lain', 'lain_io', 'lainio', 'registrar', 'relay', 'null', 'undefined',
]);

export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}

export function validateUsername(input: string): string | null {
  const name = normalizeUsername(input);
  if (!name) return 'Choose a username.';
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return `Use ${USERNAME_RULE.toLowerCase()}`;
  if (RESERVED.has(name)) return 'That username is reserved.';
  return null;
}

export class UsernameTakenError extends Error {
  constructor(name: string) { super(`@${name} is already taken.`); this.name = 'UsernameTakenError'; }
}

type Claim = { name: string; pub: string; at: number };

export class Usernames {
  private cache = new Map<string, { pub: string | null; at: number }>();
  constructor(private ctx: Ctx) {}

  private get registrar() { return this.ctx.config.registrarPub; }

  /** The pub that owns `name`, or null when unclaimed. */
  async resolve(input: string, { fresh = false } = {}): Promise<string | null> {
    const name = normalizeUsername(input);
    const cached = this.cache.get(name);
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.pub;
    const pub = this.registrar ? await this.resolveRegistrar(name) : await this.resolveClaims(name);
    this.cache.set(name, { pub, at: Date.now() });
    return pub;
  }

  async isAvailable(input: string): Promise<boolean> {
    if (validateUsername(input)) return false;
    return (await this.resolve(input, { fresh: true })) === null;
  }

  /** True when `name` currently maps to `pub`. Use it to flag impersonation on profiles. */
  async verify(pub: string, name: string): Promise<boolean> {
    return (await this.resolve(name)) === pub;
  }

  async claim(input: string, pair: SEAPair): Promise<void> {
    const name = normalizeUsername(input);
    const error = validateUsername(name);
    if (error) throw new Error(error);
    const claim: Claim = { name, pub: pair.pub, at: Date.now() };
    const signed: string = await SEA.sign(claim, pair);
    if (this.registrar) {
      const res = await postJson<{ ok?: boolean; error?: string }>(this.ctx, '/lain/registrar/claim', { claim: signed });
      if (res.status === 409) throw new UsernameTakenError(name);
      if (!res.ok) throw new Error('The username service is unreachable. Check your connection and try again.');
      this.cache.set(name, { pub: pair.pub, at: Date.now() });
      return;
    }
    const owner = await this.resolveClaims(name);
    if (owner && owner !== pair.pub) throw new UsernameTakenError(name);
    await putHashed(this.ctx, `lain-io/usernames/${name}#`, signed);
    this.cache.set(name, { pub: pair.pub, at: Date.now() });
  }

  async release(input: string, pair: SEAPair): Promise<void> {
    const name = normalizeUsername(input);
    this.cache.delete(name);
    if (!this.registrar) return; // dev claims are immutable; they simply stop being used
    const request = await SEA.sign({ name, pub: pair.pub, action: 'release', at: Date.now() }, pair);
    await postJson(this.ctx, '/lain/registrar/release', { request });
  }

  private async resolveRegistrar(name: string): Promise<string | null> {
    const raw = await readOnce(userNode(this.ctx, this.registrar).get('usernames').get(name), this.ctx.config.readTimeoutMs);
    const record = safeJson<{ pub: string; at: number }>(raw);
    return record?.pub ?? null;
  }

  private async resolveClaims(name: string): Promise<string | null> {
    const items = await collectMap(this.ctx.gun.get(`lain-io/usernames/${name}#`), { idleMs: 500, maxMs: this.ctx.config.readTimeoutMs });
    let best: Claim | null = null;
    for (const value of items.values()) {
      if (typeof value !== 'string') continue;
      const unsigned = safeJson<{ m?: Claim }>(value.replace(/^SEA/, ''))?.m;
      if (!unsigned?.pub) continue;
      const claim = (await SEA.verify(value, unsigned.pub)) as Claim | undefined;
      if (!claim || claim.name !== name || claim.pub !== unsigned.pub || claim.at > Date.now() + 60_000) continue;
      if (!best || claim.at < best.at || (claim.at === best.at && claim.pub < best.pub)) best = claim;
    }
    return best?.pub ?? null;
  }
}
