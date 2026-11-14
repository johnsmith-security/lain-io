export type ExternalMediaKind = 'gif' | 'video' | 'youtube' | 'peertube' | 'vimeo';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

function youtubeVideoId(url: URL): string | null {
  const id = url.hostname.toLowerCase() === 'youtu.be' ? url.pathname.split('/').filter(Boolean)[0]
    : url.pathname.match(/^\/(?:embed|shorts)\/([^/?]+)/)?.[1] ?? url.searchParams.get('v');
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

/** Recognize media URLs we can display safely without fetching arbitrary page HTML. */
export function externalMediaUrl(raw: string): { kind: ExternalMediaKind; url: string } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host) && youtubeVideoId(url)) return { kind: 'youtube', url: url.href };
  if (/^\/(?:w|videos\/watch)\/[a-z0-9-]+/i.test(url.pathname)) return { kind: 'peertube', url: url.href };
  if ((host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') && /(?:^|\/)\d+(?:\/|$)/.test(path)) return { kind: 'vimeo', url: url.href };
  if (/\.gif$/i.test(path)) return { kind: 'gif', url: url.href };
  if (/\.(?:mp4|m4v|mov|webm|m3u8)$/i.test(path)) return { kind: 'video', url: url.href };
  return null;
}

export function firstExternalMediaUrl(text: string): string | null {
  const matches = text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi);
  for (const match of matches) {
    const raw = match[0].replace(/[).,!?]+$/, '');
    if (externalMediaUrl(raw)) return raw;
  }
  return null;
}

export function embedUrl(raw: string, kind: 'youtube' | 'peertube' | 'vimeo'): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (kind === 'youtube') {
    if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
    const id = youtubeVideoId(url);
    return id ? `https://www.youtube-nocookie.com/embed/${id}?playsinline=1` : null;
  }
  if (kind === 'vimeo') {
    if (!['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(url.hostname.toLowerCase())) return null;
    const id = url.pathname.match(/(?:^|\/)(\d+)(?:\/|$)/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  if (!/^\/(?:w|videos\/watch)\/[a-z0-9-]+/i.test(url.pathname)) return null;
  const id = url.pathname.split('/').filter(Boolean).at(-1);
  if (!id || !/^[a-z0-9-]{6,100}$/i.test(id)) return null;
  return `https://${url.host}/videos/embed/${encodeURIComponent(id)}`;
}
