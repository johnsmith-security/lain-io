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
// Reports are sealed to the moderation epub (the sender's identity goes inside
// the ciphertext) and written to `lain-io/reports/<day>#`.

import { dayBucket, safeJson } from './encoding';
import { type Ctx, putHashed, sealTo, subscribeMap, userNode } from './graph';
import type { Report, Unsubscribe } from './types';

type Kind = 'pubs' | 'posts' | 'media';
const KINDS: Kind[] = ['pubs', 'posts', 'media'];
// Gun keys can't safely contain "/" in every client, so post refs are stored with "|".
export const modKey = (ref: string) => ref.replace(/\//g, '|');

export class Moderation {
  private banned: Record<Kind, Set<string>> = { pubs: new Set(), posts: new Set(), media: new Set() };
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
  }

  stop() { for (const s of this.stops) s(); this.stops = []; }

  /** Called whenever the ban list changes, so feeds can re-filter. */
  onChange(cb: () => void): Unsubscribe { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }

  isPubBanned(pub: string) { return this.banned.pubs.has(pub); }
  isPostBanned(ref: string) { return this.banned.posts.has(modKey(ref)); }
  isMediaBanned(hash: string) { return this.banned.media.has(hash); }

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
