// Public profiles at `~<pub>/profile` (one signed JSON string).

import { safeJson } from './encoding';
import { type Ctx, meNode, putAck, readOnce, requirePair, subscribeLeaf, userNode } from './graph';
import type { Profile, Unsubscribe } from './types';
import type { Usernames } from './usernames';

const ACCENTS = ['#ff4fd8', '#59f3ff', '#ab7bff', '#ffd36b', '#79fbd2', '#7b82ff', '#da74ff'];
const MAX_AVATAR_LENGTH = 200_000;

function sanitize(pub: string, raw: unknown): Profile | null {
  const data = safeJson<Partial<Profile>>(raw);
  if (!data || typeof data.username !== 'string') return null;
  return {
    pub,
    username: data.username,
    name: String(data.name ?? data.username).slice(0, 50),
    bio: String(data.bio ?? '').slice(0, 280),
    // Small, cropped data URLs are embedded in the signed profile so followers
    // can render the same avatar without relying on a device-local file URI.
    avatar: String(data.avatar ?? '').slice(0, MAX_AVATAR_LENGTH),
    accent: /^#[0-9a-f]{6}$/i.test(String(data.accent)) ? String(data.accent) : ACCENTS[0],
    updatedAt: Number(data.updatedAt) || 0,
  };
}

export const shortFingerprint = (pub: string): string => pub.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toLowerCase();

export class Profiles {
  private cache = new Map<string, Profile>();
  constructor(private ctx: Ctx, private usernames: Usernames) {}

  async get(pub: string): Promise<Profile | null> {
    const cached = this.cache.get(pub);
    if (cached) return cached;
    const profile = sanitize(pub, await readOnce(userNode(this.ctx, pub).get('profile'), this.ctx.config.readTimeoutMs));
    if (!profile) return null;
    profile.verified = await this.usernames.verify(pub, profile.username);
    this.cache.set(pub, profile);
    return profile;
  }

  subscribe(pub: string, cb: (profile: Profile | null) => void): Unsubscribe {
    return subscribeLeaf(userNode(this.ctx, pub).get('profile'), async (raw) => {
      const profile = sanitize(pub, raw);
      if (profile) {
        profile.verified = await this.usernames.verify(pub, profile.username);
        this.cache.set(pub, profile);
      } else {
        this.cache.delete(pub);
      }
      cb(profile);
    });
  }

  /** Create the initial profile right after sign-up. */
  async createMine(username: string): Promise<Profile> {
    const { session } = requirePair(this.ctx);
    const accent = ACCENTS[parseInt(session.pub.replace(/[^0-9]/g, '').slice(0, 3) || '0', 10) % ACCENTS.length];
    return this.write({ pub: session.pub, username, name: username, bio: '', avatar: '', accent, updatedAt: Date.now() });
  }

  async updateMine(patch: Partial<Pick<Profile, 'name' | 'bio' | 'avatar' | 'accent'>>): Promise<Profile> {
    const { session } = requirePair(this.ctx);
    const current = (await this.get(session.pub)) ?? { pub: session.pub, username: session.username, name: session.username, bio: '', avatar: '', accent: ACCENTS[0], updatedAt: 0 };
    return this.write({ ...current, ...patch, username: session.username, updatedAt: Date.now() });
  }

  async wipeMine(): Promise<void> {
    const { session } = requirePair(this.ctx);
    this.cache.delete(session.pub);
    await putAck(meNode(this.ctx).get('profile'), null);
  }

  private async write(profile: Profile): Promise<Profile> {
    const { verified: _verified, pub: _pub, ...stored } = profile;
    await putAck(meNode(this.ctx).get('profile'), JSON.stringify(stored));
    const clean = sanitize(profile.pub, JSON.stringify(stored))!;
    clean.verified = true;
    this.cache.set(profile.pub, clean);
    return clean;
  }
}
