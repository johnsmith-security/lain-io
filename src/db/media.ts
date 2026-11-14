// Images and videos (plan §A9).
//
// Gun can't carry media: every relay would copy every byte and phones would
// hold it in memory. So Gun stores only a MediaRef (hash, type, size, tiny
// thumbnail) inside the post, and the bytes go to the main relay's media store
// (IPFS-backed), addressed by their SHA-256:
//
//   POST {mediaUrl}/lain/media        upload (signed by the account key)
//   GET  {mediaUrl}/lain/media/<sha>  download / stream (Range supported)
// mediaUrl defaults to serviceUrl; it differs only while media still runs on the self-hosted relay.
//
// Retention is decided by the relay: post media lasts 30 days unless it becomes
// popular (likes + reposts), avatars last while in use, DM attachments 30 days.
// Files are scanned for known abuse material before they're stored.
//
// DM attachments are encrypted on the device (AES-256-GCM, random key per
// file); the relay stores ciphertext and the key travels inside the Signal message.

import { b64ToBytes, bytesToB64, randomBytes, safeJson } from './encoding';
import { type Ctx, SEA, requirePair } from './graph';
import type { Moderation } from './moderation';
import type { LinkPreview, MediaInfo, MediaRef, PrivateMediaRef } from './types';

export const MEDIA_LIMITS = {
  /** Images per post. A post has either images or one video. */
  imagesPerPost: 4,
  imageBytes: 6 * 1024 * 1024,
  videoBytes: 25 * 1024 * 1024,
  videoSeconds: 60,
  avatarBytes: 512 * 1024,
  privateBytes: 25 * 1024 * 1024,
  /** Longest edge for uploaded photos (resized on the device). */
  imageMaxEdge: 2048,
  thumbChars: 6000,
} as const;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
const MEDIA_URI = /^media:([0-9a-f]{64})$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export const isImage = (ref: { mime: string }) => (IMAGE_TYPES as readonly string[]).includes(ref.mime);
export const isVideo = (ref: { mime: string }) => (VIDEO_TYPES as readonly string[]).includes(ref.mime);

const num = (value: unknown, max: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined);

/** Validate a MediaRef read from Gun (anyone can write anything into their own posts). */
export function sanitizeMediaRef(raw: unknown): MediaRef | null {
  const r = raw as Partial<MediaRef> | null;
  if (!r || typeof r !== 'object' || typeof r.sha !== 'string' || !SHA_RE.test(r.sha) || typeof r.mime !== 'string') return null;
  if (!isImage({ mime: r.mime }) && !isVideo({ mime: r.mime })) return null;
  const size = num(r.size, MEDIA_LIMITS.videoBytes);
  if (size === undefined) return null;
  return {
    sha: r.sha,
    mime: r.mime,
    size,
    width: num(r.width, 20_000),
    height: num(r.height, 20_000),
    duration: num(r.duration, 3600),
    thumb: typeof r.thumb === 'string' && r.thumb.startsWith('data:image/') && r.thumb.length <= MEDIA_LIMITS.thumbChars ? r.thumb : undefined,
    cid: typeof r.cid === 'string' && /^[a-z0-9]{20,100}$/i.test(r.cid) ? r.cid : undefined,
    sensitive: r.sensitive === true ? true : undefined,
  };
}

/** Validate a post's media list: up to 4 images, or exactly 1 video. */
export function sanitizeMediaList(raw: unknown): MediaRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.slice(0, MEDIA_LIMITS.imagesPerPost).map(sanitizeMediaRef).filter((x): x is MediaRef => Boolean(x));
  const video = list.find(isVideo);
  const out = video ? [video] : list;
  return out.length ? out : undefined;
}

/** Thumbs ride inside the encrypted message; keep them small so an envelope stays under the relay's value limit. */
const PRIVATE_THUMB_CHARS = 3000;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validate DM attachments from a decrypted message: up to 4 images, or 1 video. */
export function sanitizePrivateMediaList(raw: unknown): PrivateMediaRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list: PrivateMediaRef[] = [];
  for (const item of raw.slice(0, MEDIA_LIMITS.imagesPerPost)) {
    const r = item as Partial<PrivateMediaRef> | null;
    if (!r || typeof r !== 'object' || typeof r.sha !== 'string' || !SHA_RE.test(r.sha)) continue;
    if (typeof r.key !== 'string' || r.key.length !== 44 || !B64_RE.test(r.key)) continue;
    if (typeof r.iv !== 'string' || r.iv.length !== 16 || !B64_RE.test(r.iv)) continue;
    if (typeof r.plainMime !== 'string' || (!isImage({ mime: r.plainMime }) && !isVideo({ mime: r.plainMime }))) continue;
    const size = num(r.size, MEDIA_LIMITS.privateBytes + 64);
    if (size === undefined) continue;
    list.push({
      sha: r.sha, key: r.key, iv: r.iv, plainMime: r.plainMime, mime: 'application/octet-stream', size,
      width: num(r.width, 20_000), height: num(r.height, 20_000), duration: num(r.duration, 3600),
      thumb: typeof r.thumb === 'string' && r.thumb.startsWith('data:image/') && r.thumb.length <= PRIVATE_THUMB_CHARS ? r.thumb : undefined,
      cid: typeof r.cid === 'string' && /^[a-z0-9]{20,100}$/i.test(r.cid) ? r.cid : undefined,
    });
  }
  const video = list.find((m) => isVideo({ mime: m.plainMime }));
  const out = video ? [video] : list;
  return out.length ? out : undefined;
}

export function sanitizeLinkPreview(raw: unknown): LinkPreview | undefined {
  const r = raw as Partial<LinkPreview> | null;
  if (!r || typeof r !== 'object' || typeof r.url !== 'string' || !/^https?:\/\//.test(r.url) || r.url.length > 2000) return undefined;
  const provider = r.provider === 'youtube' || r.provider === 'peertube' ? r.provider : 'link';
  return {
    url: r.url,
    provider,
    title: typeof r.title === 'string' && r.title.trim() ? r.title.slice(0, 200) : new URL(r.url).hostname,
    author: typeof r.author === 'string' ? r.author.slice(0, 100) : undefined,
    thumbnail: typeof r.thumbnail === 'string' && /^https:\/\//.test(r.thumbnail) ? r.thumbnail.slice(0, 500) : undefined,
  };
}

/** First http(s) URL in a text, if any. */
export function findLink(text: string): string | null {
  const match = /\bhttps?:\/\/[^\s<>"']+/i.exec(text);
  return match ? match[0].replace(/[).,!?]+$/, '') : null;
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class MediaError extends Error {
  constructor(message: string, readonly status = 0) { super(message); this.name = 'MediaError'; }
}

export class Media {
  constructor(private ctx: Ctx, private moderation: Moderation) {}

  /** Where image and video bytes live (defaults to the main relay's services). */
  private get mediaUrl() { return this.ctx.config.mediaUrl || this.ctx.config.serviceUrl; }

  private get base() {
    if (!this.mediaUrl) throw new MediaError('Media needs the main relay (EXPO_PUBLIC_LAIN_MEDIA_URL or EXPO_PUBLIC_LAIN_SERVICE_URL).');
    return `${this.mediaUrl}/lain/media`;
  }

  /** Download URL for a file. Empty when moderation removed it. */
  url(sha: string): string {
    if (!SHA_RE.test(sha) || this.moderation.isMediaBanned(sha) || !this.mediaUrl) return '';
    return `${this.base}/${sha}`;
  }

  /** Resolve a stored image value (e.g. profile.avatar): `media:<sha>` → URL; other URLs / data URLs pass through. */
  resolveUri(value: string | undefined | null): string {
    if (!value) return '';
    const match = MEDIA_URI.exec(value);
    return match ? this.url(match[1]) : value;
  }

  isBanned(sha: string) { return this.moderation.isMediaBanned(sha); }

  /** Upload a public file for a post. Prepare it first (resize, strip metadata): see nativeMedia.ts. */
  async upload(bytes: Uint8Array, meta: Omit<MediaRef, 'sha' | 'size' | 'cid'>, kind: 'post' | 'avatar' = 'post'): Promise<MediaRef> {
    const image = isImage(meta);
    if (!image && !isVideo(meta)) throw new MediaError('Only photos (JPEG, PNG, WebP, GIF) and videos (MP4, MOV, WebM) can be shared.');
    if (kind === 'avatar' && !image) throw new MediaError('A profile picture must be a photo.');
    const max = kind === 'avatar' ? MEDIA_LIMITS.avatarBytes : image ? MEDIA_LIMITS.imageBytes : MEDIA_LIMITS.videoBytes;
    if (bytes.length > max) throw new MediaError(`This file is too large (max ${Math.round(max / 1048576 * 10) / 10} MB).`);
    if (!image && meta.duration && meta.duration > MEDIA_LIMITS.videoSeconds + 1) throw new MediaError(`Videos can be up to ${MEDIA_LIMITS.videoSeconds} seconds. Share longer ones as a YouTube or PeerTube link.`);
    const result = await this.put(bytes, meta.mime, kind, meta.sensitive === true);
    // Either the uploader or the relay's adult-content scan can mark a file sensitive; neither can unmark the other.
    const ref = sanitizeMediaRef({ ...meta, sha: result.sha, size: bytes.length, cid: result.cid, sensitive: meta.sensitive || result.sensitive });
    if (!ref) throw new MediaError('Upload failed.');
    return ref;
  }

  /** Encrypt and upload a DM attachment. Send the returned ref (with its key) inside the Signal message. */
  async uploadPrivate(bytes: Uint8Array, plainMime: string, meta: Partial<Pick<MediaRef, 'width' | 'height' | 'duration' | 'thumb'>> = {}): Promise<PrivateMediaRef> {
    if (bytes.length > MEDIA_LIMITS.privateBytes) throw new MediaError('This file is too large.');
    const keyBytes = randomBytes(32);
    const iv = randomBytes(12);
    const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, bytes as BufferSource));
    const result = await this.put(cipher, 'application/octet-stream', 'private');
    const thumb = meta.thumb && meta.thumb.length <= PRIVATE_THUMB_CHARS ? meta.thumb : undefined;
    return { ...meta, thumb, sha: result.sha, size: cipher.length, mime: 'application/octet-stream', cid: result.cid, key: bytesToB64(keyBytes), iv: bytesToB64(iv), plainMime };
  }

  /** Download and decrypt a DM attachment. */
  async downloadPrivate(ref: PrivateMediaRef): Promise<Uint8Array> {
    const res = await this.ctx.platform.fetch(`${this.base}/${ref.sha}`);
    if (!res.ok) throw new MediaError(res.status === 410 ? 'This attachment expired.' : 'Couldn’t download the attachment.', res.status);
    const cipher = new Uint8Array(await res.arrayBuffer());
    if ((await sha256hex(cipher)) !== ref.sha) throw new MediaError('The attachment was corrupted.');
    const key = await crypto.subtle.importKey('raw', b64ToBytes(ref.key) as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ref.iv) as BufferSource }, key, cipher as BufferSource));
  }

  /** You no longer use this file (post deleted, avatar replaced). The relay deletes it once nobody does. */
  async release(sha: string): Promise<void> {
    const { pair } = requirePair(this.ctx);
    if (!SHA_RE.test(sha) || !this.mediaUrl) return;
    const request = await SEA.sign({ action: 'release', sha, at: Date.now() }, pair);
    await this.ctx.platform.fetch(`${this.base}/release`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pub: pair.pub, request }),
    }).catch(() => undefined);
  }

  /** Whether a file is still available, when it expires, and whether it was kept for good. */
  async info(sha: string): Promise<MediaInfo> {
    if (this.moderation.isMediaBanned(sha)) return { sha, status: 'banned' };
    const res = await this.ctx.platform.fetch(`${this.base}/${sha}/info`);
    const data = safeJson<MediaInfo>(await res.text());
    if (!res.ok || !data) throw new MediaError('Couldn’t reach the media relay.', res.status);
    return data;
  }

  /** Title and thumbnail for a YouTube / PeerTube link (fetched by the relay, so your IP isn't sent to them). */
  async linkPreview(url: string): Promise<LinkPreview> {
    const fallback = sanitizeLinkPreview({ url, provider: 'link' });
    if (!fallback) throw new MediaError('That isn’t a valid link.');
    try {
      const res = await this.ctx.platform.fetch(`${this.ctx.config.serviceUrl}/lain/link-preview?url=${encodeURIComponent(url)}`);
      return (res.ok && sanitizeLinkPreview(await res.json())) || fallback;
    } catch {
      return fallback;
    }
  }

  /** Upload a new profile picture (square, ≤ 512 KB) and set it. The previous one is released. */
  async setAvatar(bytes: Uint8Array, mime = 'image/jpeg', updateProfile: (avatar: string) => Promise<unknown>, previous?: string): Promise<string> {
    const ref = await this.upload(bytes, { mime }, 'avatar');
    const avatar = `media:${ref.sha}`;
    await updateProfile(avatar);
    const old = previous && MEDIA_URI.exec(previous);
    if (old && old[1] !== ref.sha) await this.release(old[1]);
    return avatar;
  }

  private async put(bytes: Uint8Array, mime: string, kind: 'post' | 'avatar' | 'private', sensitive = false): Promise<{ sha: string; cid?: string; sensitive?: boolean }> {
    const { pair } = requirePair(this.ctx);
    const sha = await sha256hex(bytes);
    if (this.moderation.isMediaBanned(sha)) throw new MediaError('This file was removed for breaking the rules.', 451);
    const request = await SEA.sign({ action: 'upload', sha, size: bytes.length, mime, kind, sensitive, at: Date.now() }, pair);
    let res: Response;
    try {
      res = await this.ctx.platform.fetch(this.base, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-lain-pub': pair.pub, 'x-lain-request': request },
        body: bytes as BodyInit,
      });
    } catch {
      throw new MediaError('Couldn’t reach the media relay. Check your connection.');
    }
    const data = safeJson<{ sha?: string; cid?: string; sensitive?: boolean; error?: string }>(await res.text().catch(() => ''));
    if (!res.ok || data?.sha !== sha) throw new MediaError(data?.error ?? `Upload failed (${res.status}).`, res.status);
    return { sha, cid: data.cid, sensitive: data.sensitive === true };
  }
}
