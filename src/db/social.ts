// Posts, feeds, likes, follows, replies.
//
//   ~pub/posts/<id>                 JSON {id, body, createdAt, editedAt?, replyTo?, media?, link?, repostOf?} | null   signed
//   ~pub/likes/<ref|key>            JSON {at} | null                                         signed
//   ~pub/reposts/<ref|key>          JSON {id, at} | null  (id = the repost post)             signed
//   ~pub/follows/<pub>              JSON {at} | null                                         signed
//   lain-io/index/<day>#            JSON {ref, at}           discovery pointers (content-addressed)
//   lain-io/likes/<sha(ref)>#       JSON {pub, ref}          "I liked this" announcements
//   lain-io/followers/<sha(pub)>#   JSON {pub, target}       "I follow X" announcements
//   lain-io/replies/<sha(ref)>#     JSON {ref, parent}       reply pointers
//   lain-io/reposts/<sha(ref)>#     JSON {pub, ref}          "I reposted this" announcements
//
// Media (MediaRef) is only a hash + tiny thumbnail; the bytes are on the media relay (media.ts).
//
// Announcements only help others *find* signed data. Every like, follow, and
// reply is checked against the author's own signed space before it counts.

import { dayBucket, newId, recentDays, safeJson } from './encoding';
import {
  type Ctx, collectMap, meNode, putAck, putHashed, readOnce, requirePair, sha256url, subscribeLeaf, subscribeMap, throttle, userNode,
} from './graph';
import { type Media, sanitizeLinkPreview, sanitizeMediaList } from './media';
import { modKey, type Moderation } from './moderation';
import type { SafetyStore } from './settings';
import type { LinkPreview, MediaRef, Post, PostRef, Unsubscribe } from './types';

export const MAX_POST_LENGTH = 2000;
const MAX_FOLLOW_SUBSCRIPTIONS = 200;
const MAX_DISCOVERY_POSTS = 300;
const MAX_VERIFIED_LIKES = 500;

export const makeRef = (pub: string, id: string): PostRef => `${pub}/${id}`;
export function parseRef(ref: PostRef): { pub: string; id: string } | null {
  const at = ref.lastIndexOf('/');
  if (at <= 0 || at === ref.length - 1) return null;
  return { pub: ref.slice(0, at), id: ref.slice(at + 1) };
}

type StoredPost = {
  id: string; body: string; createdAt: number; editedAt?: number; replyTo?: PostRef;
  media?: MediaRef[]; link?: LinkPreview; repostOf?: PostRef;
};

function toPost(pub: string, id: string, raw: unknown): Post | null {
  const data = safeJson<StoredPost>(raw);
  if (!data || data.id !== id || typeof data.body !== 'string') return null;
  const media = sanitizeMediaList(data.media);
  const link = sanitizeLinkPreview(data.link);
  const repostOf = typeof data.repostOf === 'string' && parseRef(data.repostOf) ? data.repostOf : undefined;
  if (!data.body.trim() && !media && !link && !repostOf) return null;
  return {
    ref: makeRef(pub, id),
    id,
    author: pub,
    body: data.body.slice(0, MAX_POST_LENGTH),
    createdAt: Number(data.createdAt) || 0,
    editedAt: data.editedAt ? Number(data.editedAt) : undefined,
    replyTo: typeof data.replyTo === 'string' ? data.replyTo : undefined,
    ...(media ? { media } : {}),
    ...(link ? { link } : {}),
    ...(repostOf ? { repostOf } : {}),
  };
}

/** Keeps a filtered, newest-first list of posts and emits it (throttled). */
class PostList {
  private posts = new Map<PostRef, Post>();
  private stops: Unsubscribe[] = [];
  private emit: () => void;

  constructor(private social: Social, cb: (posts: Post[]) => void, limit = Infinity) {
    this.emit = throttle(() => {
      const visible = [...this.posts.values()].map((p) => this.social.present(p)).filter((p): p is Post => Boolean(p)).sort((a, b) => b.createdAt - a.createdAt);
      cb(visible.slice(0, limit));
    });
    this.stops.push(social.onVisibilityChange(this.emit));
  }

  upsert(post: Post | null, ref: PostRef) {
    if (post) this.posts.set(ref, post); else this.posts.delete(ref);
    this.emit();
  }
  removeAuthor(pub: string) {
    for (const ref of [...this.posts.keys()]) if (ref.startsWith(`${pub}/`)) this.posts.delete(ref);
    this.emit();
  }
  get size() { return this.posts.size; }
  add(stop: Unsubscribe) { this.stops.push(stop); }
  /** Emit even if nothing arrived, so the GUI can leave its loading state. */
  flush() { this.emit(); }
  close() { for (const s of this.stops) s(); this.stops = []; }
}

export class Social {
  private visibilityListeners = new Set<() => void>();

  constructor(private ctx: Ctx, private moderation: Moderation, private safety: SafetyStore, private media: Media) {
    moderation.onChange(() => this.notifyVisibility());
    safety.subscribe(() => this.notifyVisibility());
  }

  // ---------- visibility ----------

  isVisible(post: Post): boolean {
    if (this.moderation.isPubBanned(post.author) || this.moderation.isPostBanned(post.ref)) return false;
    if (this.safety.isBlocked(post.author)) return false;
    const muted = this.safety.get().mutedWords;
    if (muted.length) {
      const body = post.body.toLowerCase();
      if (muted.some((word) => body.includes(word))) return false;
    }
    return true;
  }

  /** The post as the viewer should see it (banned files removed), or null when hidden. */
  present(post: Post): Post | null {
    if (!this.isVisible(post)) return null;
    if (!post.media?.some((m) => this.moderation.isMediaBanned(m.sha))) return post;
    const media = post.media.filter((m) => !this.moderation.isMediaBanned(m.sha));
    const rest: Post = { ...post, media: media.length ? media : undefined };
    return rest.body.trim() || rest.media || rest.link || rest.repostOf ? rest : null;
  }

  onVisibilityChange(cb: () => void): Unsubscribe { this.visibilityListeners.add(cb); return () => { this.visibilityListeners.delete(cb); }; }
  private notifyVisibility() { for (const cb of this.visibilityListeners) cb(); }

  // ---------- posts ----------

  /**
   * Publish a post. `media`: refs from db.media.upload (≤ 4 images or 1 video).
   * `link`: from db.media.linkPreview(url). `repostOf`: use repost() instead.
   */
  async createPost(body: string, options: { replyTo?: PostRef; media?: MediaRef[]; link?: LinkPreview; repostOf?: PostRef } = {}): Promise<Post> {
    const { session } = requirePair(this.ctx);
    const text = body.trim();
    const media = options.media?.length ? sanitizeMediaList(options.media) : undefined;
    if (options.media?.length && media?.length !== options.media.length) throw new Error('Attach up to 4 photos, or 1 video.');
    const link = options.link ? sanitizeLinkPreview(options.link) : undefined;
    if (!text && !media && !link && !options.repostOf) throw new Error('Write something first.');
    if (text.length > MAX_POST_LENGTH) throw new Error(`Posts can be up to ${MAX_POST_LENGTH} characters.`);
    if (options.replyTo && !parseRef(options.replyTo)) throw new Error('Invalid reply target.');
    if (options.repostOf && !parseRef(options.repostOf)) throw new Error('Invalid post.');
    const id = newId();
    const stored: StoredPost = {
      id, body: text, createdAt: Date.now(),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(media ? { media } : {}),
      ...(link ? { link } : {}),
      ...(options.repostOf ? { repostOf: options.repostOf } : {}),
    };
    await putAck(meNode(this.ctx).get('posts').get(id), JSON.stringify(stored));
    const ref = makeRef(session.pub, id);
    await putHashed(this.ctx, `lain-io/index/${dayBucket(stored.createdAt)}#`, JSON.stringify({ ref, at: stored.createdAt }));
    if (options.replyTo) {
      await putHashed(this.ctx, `lain-io/replies/${await sha256url(options.replyTo)}#`, JSON.stringify({ ref, parent: options.replyTo }));
    }
    return toPost(session.pub, id, JSON.stringify(stored))!;
  }

  async editPost(id: string, body: string): Promise<Post> {
    const { session } = requirePair(this.ctx);
    const text = body.trim();
    if (!text || text.length > MAX_POST_LENGTH) throw new Error(`Posts must be 1–${MAX_POST_LENGTH} characters.`);
    const node = meNode(this.ctx).get('posts').get(id);
    const existing = safeJson<StoredPost>(await readOnce(node, this.ctx.config.readTimeoutMs));
    if (!existing) throw new Error('Post not found.');
    const stored: StoredPost = { ...existing, body: text, editedAt: Date.now() };
    await putAck(node, JSON.stringify(stored));
    return toPost(session.pub, id, JSON.stringify(stored))!;
  }

  /** Deletes your copy. Relays and peers that already synced it keep a tombstone (null). Its files are released. */
  async deletePost(id: string): Promise<void> {
    requirePair(this.ctx);
    const node = meNode(this.ctx).get('posts').get(id);
    const existing = safeJson<StoredPost>(await readOnce(node, this.ctx.config.readTimeoutMs));
    await putAck(node, null);
    if (existing?.repostOf) await putAck(meNode(this.ctx).get('reposts').get(modKey(existing.repostOf)), null);
    for (const m of sanitizeMediaList(existing?.media) ?? []) await this.media.release(m.sha);
  }

  async getPost(ref: PostRef): Promise<Post | null> {
    const parsed = parseRef(ref);
    if (!parsed) return null;
    return toPost(parsed.pub, parsed.id, await readOnce(userNode(this.ctx, parsed.pub).get('posts').get(parsed.id), this.ctx.config.readTimeoutMs));
  }

  subscribePost(ref: PostRef, cb: (post: Post | null) => void): Unsubscribe {
    const parsed = parseRef(ref);
    if (!parsed) { cb(null); return () => {}; }
    return subscribeLeaf(userNode(this.ctx, parsed.pub).get('posts').get(parsed.id), (raw) => {
      const post = toPost(parsed.pub, parsed.id, raw);
      cb(post ? this.present(post) : null);
    });
  }

  /** A profile's posts, newest first. */
  subscribeUserPosts(pub: string, cb: (posts: Post[]) => void): Unsubscribe {
    const list = new PostList(this, cb);
    list.add(this.followAuthor(pub, list));
    setTimeout(() => list.flush(), this.ctx.config.readTimeoutMs);
    return () => list.close();
  }

  /** Posts from everyone you follow, plus your own. */
  subscribeFollowingFeed(cb: (posts: Post[]) => void, limit = 500): Unsubscribe {
    const { session } = requirePair(this.ctx);
    const list = new PostList(this, cb, limit);
    const authors = new Map<string, Unsubscribe>();
    authors.set(session.pub, this.followAuthor(session.pub, list));
    list.add(subscribeMap(meNode(this.ctx).get('follows'), (pub, value) => {
      if (pub === session.pub) return;
      const following = Boolean(safeJson(value));
      if (following && !authors.has(pub) && authors.size < MAX_FOLLOW_SUBSCRIPTIONS) authors.set(pub, this.followAuthor(pub, list));
      if (!following && authors.has(pub)) { authors.get(pub)!(); authors.delete(pub); list.removeAuthor(pub); }
    }));
    list.add(() => { for (const stop of authors.values()) stop(); authors.clear(); });
    setTimeout(() => list.flush(), this.ctx.config.readTimeoutMs);
    return () => list.close();
  }

  /** "The Wired": recent public posts from everyone, via the content-addressed index. */
  subscribeDiscovery(cb: (posts: Post[]) => void, { days = 2, limit = 200 } = {}): Unsubscribe {
    const list = new PostList(this, cb, limit);
    const seen = new Set<PostRef>();
    for (const day of recentDays(days)) {
      list.add(subscribeMap(this.ctx.gun.get(`lain-io/index/${day}#`), (_key, value) => {
        const entry = safeJson<{ ref: PostRef; at: number }>(value);
        const parsed = entry && parseRef(entry.ref);
        if (!entry || !parsed || seen.has(entry.ref) || seen.size >= MAX_DISCOVERY_POSTS) return;
        if (dayBucket(entry.at) !== day) return; // pointer must sit in its own day bucket
        seen.add(entry.ref);
        list.add(subscribeLeaf(userNode(this.ctx, parsed.pub).get('posts').get(parsed.id), (raw) => {
          list.upsert(toPost(parsed.pub, parsed.id, raw), entry.ref);
        }));
      }));
    }
    setTimeout(() => list.flush(), this.ctx.config.readTimeoutMs);
    return () => list.close();
  }

  subscribeReplies(parent: PostRef, cb: (posts: Post[]) => void): Unsubscribe {
    const list = new PostList(this, (posts) => cb([...posts].reverse())); // oldest first for threads
    const seen = new Set<PostRef>();
    void sha256url(parent).then((hash) => {
      list.add(subscribeMap(this.ctx.gun.get(`lain-io/replies/${hash}#`), (_key, value) => {
        const entry = safeJson<{ ref: PostRef; parent: PostRef }>(value);
        const parsed = entry && entry.parent === parent ? parseRef(entry.ref) : null;
        if (!entry || !parsed || seen.has(entry.ref)) return;
        seen.add(entry.ref);
        list.add(subscribeLeaf(userNode(this.ctx, parsed.pub).get('posts').get(parsed.id), (raw) => {
          const post = toPost(parsed.pub, parsed.id, raw);
          list.upsert(post && post.replyTo === parent ? post : null, entry.ref);
        }));
      }));
    });
    setTimeout(() => list.flush(), this.ctx.config.readTimeoutMs);
    return () => list.close();
  }

  private followAuthor(pub: string, list: PostList): Unsubscribe {
    return subscribeMap(userNode(this.ctx, pub).get('posts'), (id, raw) => list.upsert(toPost(pub, id, raw), makeRef(pub, id)));
  }

  // ---------- likes ----------

  async like(ref: PostRef): Promise<void> {
    const { session } = requirePair(this.ctx);
    if (!parseRef(ref)) throw new Error('Invalid post.');
    await putAck(meNode(this.ctx).get('likes').get(modKey(ref)), JSON.stringify({ at: Date.now() }));
    await putHashed(this.ctx, `lain-io/likes/${await sha256url(ref)}#`, JSON.stringify({ pub: session.pub, ref }));
  }

  async unlike(ref: PostRef): Promise<void> {
    requirePair(this.ctx);
    await putAck(meNode(this.ctx).get('likes').get(modKey(ref)), null);
  }

  /** Live like count (verified against each liker's signed space) and whether you liked it. */
  subscribeLikes(ref: PostRef, cb: (state: { count: number; likedByMe: boolean; capped: boolean }) => void): Unsubscribe {
    return this.subscribeTally('likes', ref, ({ count, mine, capped }) => cb({ count, likedByMe: mine, capped }));
  }

  // ---------- reposts ----------

  /** Repost to your followers and The Wired. Popular reposts also keep the post's media from expiring. */
  async repost(ref: PostRef): Promise<Post> {
    const { session } = requirePair(this.ctx);
    const parsed = parseRef(ref);
    if (!parsed) throw new Error('Invalid post.');
    if (parsed.pub === session.pub) throw new Error('You can’t repost your own post.');
    const mark = meNode(this.ctx).get('reposts').get(modKey(ref));
    const existing = safeJson<{ id: string }>(await readOnce(mark, this.ctx.config.readTimeoutMs));
    if (existing?.id) {
      const post = await this.getPost(makeRef(session.pub, existing.id));
      if (post) return post;
    }
    const post = await this.createPost('', { repostOf: ref });
    await putAck(mark, JSON.stringify({ id: post.id, at: post.createdAt }));
    await putHashed(this.ctx, `lain-io/reposts/${await sha256url(ref)}#`, JSON.stringify({ pub: session.pub, ref }));
    return post;
  }

  async unrepost(ref: PostRef): Promise<void> {
    requirePair(this.ctx);
    const mark = meNode(this.ctx).get('reposts').get(modKey(ref));
    const existing = safeJson<{ id: string }>(await readOnce(mark, this.ctx.config.readTimeoutMs));
    if (existing?.id) await putAck(meNode(this.ctx).get('posts').get(existing.id), null);
    await putAck(mark, null);
  }

  /** Live repost count (verified) and whether you reposted it. */
  subscribeReposts(ref: PostRef, cb: (state: { count: number; repostedByMe: boolean }) => void): Unsubscribe {
    return this.subscribeTally('reposts', ref, ({ count, mine }) => cb({ count, repostedByMe: mine }));
  }

  /** Count of accounts that announced `kind` for `ref`, each checked against their own signed space. */
  private subscribeTally(kind: 'likes' | 'reposts', ref: PostRef, cb: (state: { count: number; mine: boolean; capped: boolean }) => void): Unsubscribe {
    const me = this.ctx.session?.pub;
    const voters = new Map<string, boolean>();
    const stops: Unsubscribe[] = [];
    const emit = throttle(() => {
      let count = 0;
      for (const [pub, yes] of voters) if (yes && !this.moderation.isPubBanned(pub) && !this.safety.isBlocked(pub)) count++;
      cb({ count, mine: Boolean(me && voters.get(me)), capped: voters.size >= MAX_VERIFIED_LIKES });
    });
    const watch = (pub: string) => {
      if (voters.has(pub) || voters.size >= MAX_VERIFIED_LIKES) return;
      voters.set(pub, false);
      stops.push(subscribeLeaf(userNode(this.ctx, pub).get(kind).get(modKey(ref)), (value) => {
        voters.set(pub, Boolean(safeJson(value)));
        emit();
      }));
    };
    if (me) watch(me);
    void sha256url(ref).then((hash) => {
      stops.push(subscribeMap(this.ctx.gun.get(`lain-io/${kind}/${hash}#`), (_key, value) => {
        const entry = safeJson<{ pub: string; ref: PostRef }>(value);
        if (entry?.ref === ref && entry.pub) watch(entry.pub);
      }));
    });
    emit();
    return () => { for (const s of stops) s(); };
  }

  // ---------- follows ----------

  async follow(pub: string): Promise<void> {
    const { session } = requirePair(this.ctx);
    if (pub === session.pub) throw new Error('You can’t follow yourself.');
    await putAck(meNode(this.ctx).get('follows').get(pub), JSON.stringify({ at: Date.now() }));
    await putHashed(this.ctx, `lain-io/followers/${await sha256url(pub)}#`, JSON.stringify({ pub: session.pub, target: pub }));
  }

  async unfollow(pub: string): Promise<void> {
    requirePair(this.ctx);
    await putAck(meNode(this.ctx).get('follows').get(pub), null);
  }

  /** Who `pub` follows (defaults to you). */
  subscribeFollowing(cb: (pubs: string[]) => void, pub?: string): Unsubscribe {
    const owner = pub ?? requirePair(this.ctx).session.pub;
    const following = new Set<string>();
    const emit = throttle(() => cb([...following]));
    const stop = subscribeMap(userNode(this.ctx, owner).get('follows'), (target, value) => {
      if (safeJson(value)) following.add(target); else following.delete(target);
      emit();
    });
    emit();
    return stop;
  }

  /** Who follows `pub`, verified against each follower's signed follows list. */
  subscribeFollowers(pub: string, cb: (pubs: string[]) => void): Unsubscribe {
    const followers = new Map<string, boolean>();
    const stops: Unsubscribe[] = [];
    const emit = throttle(() => cb([...followers].filter(([, yes]) => yes).map(([p]) => p)));
    void sha256url(pub).then((hash) => {
      stops.push(subscribeMap(this.ctx.gun.get(`lain-io/followers/${hash}#`), (_key, value) => {
        const entry = safeJson<{ pub: string; target: string }>(value);
        if (entry?.target !== pub || !entry.pub || followers.has(entry.pub) || followers.size >= MAX_VERIFIED_LIKES) return;
        followers.set(entry.pub, false);
        stops.push(subscribeLeaf(userNode(this.ctx, entry.pub).get('follows').get(pub), (value2) => {
          followers.set(entry.pub, Boolean(safeJson(value2)));
          emit();
        }));
      }));
    });
    emit();
    return () => { for (const s of stops) s(); };
  }

  // ---------- account deletion ----------

  async wipeMine(): Promise<void> {
    requirePair(this.ctx);
    for (const branch of ['posts', 'likes', 'reposts', 'follows']) {
      const items = await collectMap(meNode(this.ctx).get(branch), { idleMs: 800, maxMs: 6000 });
      for (const key of items.keys()) await putAck(meNode(this.ctx).get(branch).get(key), null, 3000);
    }
  }
}
