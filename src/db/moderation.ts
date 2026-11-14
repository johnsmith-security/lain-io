// Store-compliance moderation (plan §A8).
//
// The moderation account (config.moderationPub) publishes bans in its own Gun
// space, which only it can write:
//   ~mod/moderation/pubs/<pub>     {reason, at}  | null (unban)
//   ~mod/moderation/posts/<ref>    {reason, at}  | null
//   ~mod/moderation/media/<hash>   {reason, at}  | null
// The client always hides banned content, whatever relay it came from. Users
// can't turn this off.
//
// Single source of truth: the list is kept on the Cloudflare relay and pulled from
// config.moderationUrl at start and every MODERATION_PULL_MS, in addition to the live Gun
// subscription. The pulled nodes go through Gun's SEA checks, so only values signed by the
// moderation key are applied; the endpoint can deliver bans but never invent them.
//
// Retention (plan §2b): posts last config.retentionDays from creation (posts from before
// config.retentionEpoch count as created then). The top posts are kept forever; the archivist
// account signs them into ~ARCHIVIST/keep/<pub|id>, delivered the same way as bans. Expired,
// unkept posts are hidden everywhere. Bans always win over keeps.
//
// Reports are sealed to the moderation epub (the sender's identity goes inside
// the ciphertext) and written to `lain-io/reports/<day>#`.

import { dayBucket, safeJson } from './encoding';
import { type Ctx, putHashed, sealTo, subscribeMap, userNode } from './graph';
import type { Report, Unsubscribe } from './types';

type Kind = 'pubs' | 'posts' | 'media';
const MODERATION_PULL_MS = 5 * 60_000;
/** The relay decides hourly; don't hide a post before it has had a chance to be ranked. */
const RETENTION_GRACE_MS = 2 * 3_600_000;
const KINDS: Kind[] = ['pubs', 'posts', 'media'];
// Gun keys can't safely contain "/" in every client, so post refs are stored with "|".
export const modKey = (ref: string) => ref.replace(/\//g, '|');

export class Moderation {
  private banned: Record<Kind, Set<string>> = { pubs: new Set(), posts: new Set(), media: new Set() };
  private kept = new Set<string>();
  private stops: Unsubscribe[] = [];
  private listeners = new Set<() => void>();

  constructor(private ctx: Ctx) {}

  get enabled() { return Boolean(this.ctx.config.moderationPub); }

  /** Starts at init, signed in or not. Works offline from the local cache. */
  start() {
    if (!this.enabled || this.stops.length) return;
    for (const kind of KINDS) {
      for (const { key } of this.ctx.platform.kv.list(`moderation:${kind}`)) this.banned[kind].add(key);
      this.stops.push(subscribeMap(userNode(this.ctx, this.ctx.config.moderationPub).get('moderation').get(kind), (key, value) => {
        const ns = `moderation:${kind}`;
        if (value && safeJson(value)) { this.banned[kind].add(key); this.ctx.platform.kv.set(ns, key, String(value)); }
        else { this.banned[kind].delete(key); this.ctx.platform.kv.del(ns, key); }
        for (const cb of this.listeners) cb();
      }));
    }
    const archivist = this.ctx.config.archivistPub;
    if (archivist) {
      for (const { key } of this.ctx.platform.kv.list('retention:keep')) this.kept.add(key);
      this.stops.push(subscribeMap(userNode(this.ctx, archivist).get('keep'), (key, value) => {
        if (value && safeJson(value)) { this.kept.add(key); this.ctx.platform.kv.set('retention:keep', key, String(value)); }
        else { this.kept.delete(key); this.ctx.platform.kv.del('retention:keep', key); }
        for (const cb of this.listeners) cb();
      }));
    }
    if (this.ctx.config.moderationUrl) {
      void this.pull();
      const timer = setInterval(() => { void this.pull(); }, MODERATION_PULL_MS);
      this.stops.push(() => clearInterval(timer));
    }
  }

  stop() { for (const s of this.stops) s(); this.stops = []; }

  /**
   * Fetches the signed list from the Cloudflare relay and hands it to Gun as incoming data. SEA
   * verifies every value against the moderation pub; the subscriptions above then apply it.
   * Returns false when the list couldn't be fetched (offline: the cached list stays in force).
   */
  async pull(): Promise<boolean> {
    const { moderationUrl, moderationPub, archivistPub } = this.ctx.config;
    if (!moderationUrl || !moderationPub) return false;
    try {
      const res = await this.ctx.platform.fetch(moderationUrl, { headers: { accept: 'application/json' } });
      if (!res.ok) return false;
      const body = await res.json() as { moderationPub?: string; graph?: Record<string, unknown> };
      if (body.moderationPub !== moderationPub || !body.graph || typeof body.graph !== 'object') return false;
      const graph: Record<string, unknown> = {};
      for (const [soul, node] of Object.entries(body.graph)) {
        if (soul === `~${moderationPub}` || soul.startsWith(`~${moderationPub}/moderation`)) graph[soul] = node;
        else if (archivistPub && (soul === `~${archivistPub}` || soul === `~${archivistPub}/keep`)) graph[soul] = node;
      }
      if (Object.keys(graph).length) this.ctx.gun._.root.on('in', { '#': Math.random().toString(36).slice(2, 11), put: graph });
      return true;
    } catch {
      return false;
    }
  }

  /** Called whenever the ban list changes, so feeds can re-filter. */
  onChange(cb: () => void): Unsubscribe { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }

  isPubBanned(pub: string) { return this.banned.pubs.has(pub); }
  isPostBanned(ref: string) { return this.banned.posts.has(modKey(ref)); }
  isMediaBanned(hash: string) { return this.banned.media.has(hash); }
  isKept(ref: string) { return this.kept.has(modKey(ref)); }

  /** True when a post is past retention and isn't on the keep list (it's gone from the network). */
  isExpired(post: { ref: string; createdAt: number }, now = Date.now()): boolean {
    const { archivistPub, retentionDays, retentionEpoch } = this.ctx.config;
    if (!archivistPub || !retentionDays) return false;
    const born = Math.max(Math.min(post.createdAt || now, now), retentionEpoch || 0);
    return born < now - retentionDays * 86_400_000 - RETENTION_GRACE_MS && !this.isKept(post.ref);
  }

  async report(report: Report): Promise<void> {
    if (!this.ctx.config.moderationEpub) throw new Error('Reporting isn’t configured (EXPO_PUBLIC_LAIN_MODERATION_EPUB).');
    const payload = {
      v: 1,
      ...report,
      details: report.details?.slice(0, 2000),
      evidence: report.evidence?.slice(0, 50),
      reporter: this.ctx.session?.pub ?? null,
      at: Date.now(),
    };
    await putHashed(this.ctx, `lain-io/reports/${dayBucket()}#`, await sealTo(payload, this.ctx.config.moderationEpub));
  }
}
