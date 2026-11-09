// Lain IO media service (plan §A9). Mounted by server.js on the main relay.
//
//   POST /lain/media                 upload raw bytes (signed headers)  → { sha, cid, size, mime, expiresAt }
//   GET  /lain/media/<sha>           serve the file (Range supported)   410 expired/deleted · 451 removed
//   GET  /lain/media/<sha>/info      { status, size, mime, cid, expiresAt, kept }
//   POST /lain/media/release         owner stops using a file (post deleted, avatar replaced)
//   GET  /lain/link-preview?url=     YouTube / PeerTube oEmbed preview (title, thumbnail)
//
// Media is addressed by the SHA-256 (hex) of its bytes. Gun only ever stores
// that hash plus a tiny thumbnail; the bytes live in a blob store:
//   - IPFS (Kubo) when IPFS_API is set: pinned while retained, unpinned + GC'd after.
//     Other IPFS nodes can keep serving a CID they pinned themselves.
//   - a directory on disk otherwise (dev, tests).
//
// Retention:
//   post media      30 days (MEDIA_TTL_DAYS), then removed, unless popular enough to keep forever:
//                   score = verified likers + 2 × verified reposters of the posts that used it,
//                   counting only accounts older than MEDIA_KEEP_MIN_ACCOUNT_AGE_DAYS, never the uploader.
//                   score ≥ MEDIA_KEEP_SCORE → kept until its owners delete it or moderation removes it.
//   avatars         while they are someone's current avatar (released on change / account deletion).
//   private media   (encrypted DM attachments) 30 days, never kept.
// Public uploads go through SCANNER_URL before they are stored. The scanner answers
//   { ok: boolean, reason?: string, adult?: boolean }
//   ok:false  → rejected (known child-abuse material, etc.). Mandatory on the main relay in production.
//   adult     → stored but flagged `sensitive`; apps blur it unless the viewer enabled
//               "Show sensitive media" in Settings. Adult detection is optional in the scanner.
// Uploaders can also flag their own files sensitive (header field `sensitive`).

'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Readable } = require('stream');

const DAY = 86_400_000;
const SHA_RE = /^[0-9a-f]{64}$/;
const KINDS = new Set(['post', 'avatar', 'private']);
const PUBLIC_MIME = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video',
};
const GONE_KEEP_MS = 180 * DAY; // remember why a file is gone, so clients can show "expired"

/** Detect the real file type from its first bytes. */
function sniff(buf) {
  const at = (offset, text) => buf.length >= offset + text.length && buf.toString('latin1', offset, offset + text.length) === text;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(4, 'ftyp')) return at(8, 'qt  ') ? 'video/quicktime' : 'video/mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

// ---------- blob stores ----------

function diskStore(dir) {
  const file = (sha) => path.join(dir, sha.slice(0, 2), sha);
  return {
    name: 'disk',
    async put(buf, sha) {
      fs.mkdirSync(path.dirname(file(sha)), { recursive: true });
      const tmp = `${file(sha)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file(sha));
      return {};
    },
    async read(sha, _entry, start, end) { return fs.createReadStream(file(sha), { start, end }); },
    async remove(sha) { fs.rmSync(file(sha), { force: true }); },
    async gc() {},
    async health() { return true; },
  };
}

function kuboStore(api) {
  const rpc = async (query, init = {}) => {
    const res = await fetch(`${api.replace(/\/+$/, '')}/api/v0/${query}`, { method: 'POST', ...init });
    if (!res.ok) throw new Error(`kubo ${query.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  return {
    name: 'ipfs',
    async put(buf) {
      const form = new FormData();
      form.append('file', new Blob([buf]), 'blob');
      const res = await rpc('add?pin=true&cid-version=1&raw-leaves=true&quieter=true', { body: form });
      const line = (await res.text()).trim().split('\n').pop();
      return { cid: JSON.parse(line).Hash };
    },
    async read(_sha, entry, start, end) {
      const length = end === undefined ? '' : `&length=${end - start + 1}`;
      const res = await rpc(`cat?arg=${entry.cid}&offset=${start}${length}`);
      return Readable.fromWeb(res.body);
    },
    async remove(_sha, entry) {
      if (!entry.cid) return;
      try { await rpc(`pin/rm?arg=${entry.cid}`); } catch (error) { if (!/not pinned/.test(error.message)) throw error; }
    },
    async gc() { const res = await rpc('repo/gc?quiet=true'); await res.text(); },
    async health() { try { await rpc('id'); return true; } catch { return false; } },
  };
}

// ---------- manifest (what we store, for whom, until when) ----------

function manifest(file) {
  let data = { entries: {}, gone: {} };
  try { data = { entries: {}, gone: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* new */ }
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  return {
    data,
    save() { if (!timer) timer = setTimeout(flush, 250); },
    flush,
  };
}

// ---------- helpers ----------

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.resume(); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJsonBody(req) {
  return readRaw(req, 16_384).then((buf) => JSON.parse(buf.toString('utf8') || '{}'));
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers });
  res.end(JSON.stringify(body));
}

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:') && privateAddress(v6.slice(7));
}

async function fetchJsonSafely(url, timeoutMs = 5000) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || (target.port && target.port !== '443')) throw new Error('https only');
  const addresses = await dns.lookup(target.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address))) throw new Error('private address');
  const res = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const text = await res.text();
  if (text.length > 65_536) throw new Error('too large');
  return JSON.parse(text);
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
const httpsOnly = (value) => (typeof value === 'string' && /^https:\/\//.test(value) ? value.slice(0, 500) : undefined);

// ---------- service ----------

/**
 * options: { dataDir, ipfsApi, gun, policy, log, production, scannerUrl, scan, allowUnscanned, ttlDays,
 *            keepScore, keepMinAccountAgeDays, registrar (bool), verifyFresh, limit, sha256url, maxBytes }
 */
function createMedia(options) {
  const o = options;
  const store = o.ipfsApi ? kuboStore(o.ipfsApi) : diskStore(path.join(o.dataDir, 'media'));
  const m = manifest(path.join(o.dataDir, 'media.json'));
  const { entries, gone } = m.data;
  const ttl = o.ttlDays * DAY;
  const bytesToday = new Map();
  const previews = new Map();
  const max = { image: 6 * 1024 * 1024, video: o.maxVideoBytes, avatar: 512 * 1024, private: o.maxVideoBytes, ...(o.maxBytes || {}) };

  const scanner = o.scan || (o.scannerUrl ? async (buf, mime, sha) => {
    const res = await fetch(o.scannerUrl, { method: 'POST', body: buf, headers: { 'content-type': mime, 'x-lain-sha256': sha }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`scanner status ${res.status}`);
    return res.json();
  } : null);

  const bury = (sha, reason, now = Date.now()) => {
    delete entries[sha];
    gone[sha] = { reason, at: now };
    m.save();
  };

  const removeFile = async (sha, reason, now) => {
    const entry = entries[sha];
    if (!entry) return false;
    try { await store.remove(sha, entry); } catch (error) { o.log('[media] remove failed', sha.slice(0, 12), error.message); return false; }
    bury(sha, reason, now);
    return true;
  };

  const expiresAt = (entry) => {
    if (entry.kept) return null;
    const owners = Object.values(entry.owners);
    if (owners.some((x) => x.kind === 'avatar')) return null;
    return owners.length ? Math.max(...owners.map((x) => x.at)) + ttl : null;
  };

  const statusOf = (sha) => {
    if (o.policy.bannedMedia.has(sha)) return 'banned';
    if (entries[sha]) return 'live';
    if (gone[sha]) return gone[sha].reason;
    return 'missing';
  };

  // ---- upload ----
  async function upload(req, res) {
    const pub = String(req.headers['x-lain-pub'] || '');
    const request = pub && (await o.verifyFresh(String(req.headers['x-lain-request'] || ''), pub));
    if (!request || request.action !== 'upload' || !SHA_RE.test(request.sha) || !KINDS.has(request.kind)) { req.resume(); return send(res, 400, { error: 'bad request' }); }
    if (o.policy.bannedPubs.has(pub) || o.policy.purged.has(pub)) { req.resume(); return send(res, 403, { error: 'account not allowed' }); }
    if (o.policy.bannedMedia.has(request.sha)) { req.resume(); return send(res, 451, { error: 'This file was removed for breaking the rules.' }); }
    if (!o.limit(`media:${pub}`, 60, 3_600_000)) { req.resume(); return send(res, 429, { error: 'Too many uploads. Try again later.' }); }

    const kind = request.kind;
    const mime = String(request.mime || '');
    const family = kind === 'private' ? 'private' : PUBLIC_MIME[mime];
    if (!family || (kind === 'private' && mime !== 'application/octet-stream') || (kind === 'avatar' && family !== 'image')) {
      req.resume();
      return send(res, 415, { error: 'Unsupported file type.' });
    }
    const limitBytes = kind === 'avatar' ? max.avatar : kind === 'private' ? max.private : max[family];
    let buf;
    try { buf = await readRaw(req, limitBytes); } catch (error) {
      return send(res, error.status || 400, { error: error.status === 413 ? `File too large (max ${Math.round(limitBytes / 1048576)} MB).` : 'upload failed' });
    }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== request.sha || buf.length !== Number(request.size)) return send(res, 400, { error: 'File hash or size mismatch.' });
    if (kind !== 'private' && sniff(buf) !== mime) return send(res, 415, { error: 'File content doesn’t match its type.' });

    const day = new Date().toISOString().slice(0, 10);
    const used = bytesToday.get(pub);
    const usedToday = used && used.day === day ? used.bytes : 0;
    if (usedToday + buf.length > o.dailyBytes) return send(res, 429, { error: 'Daily upload limit reached.' });

    const now = Date.now();
    let entry = entries[sha];
    let scanVerdict = null;
    if (!entry) {
      if (kind !== 'private') {
        if (scanner) {
          let verdict;
          try { verdict = await scanner(buf, mime, sha); } catch (error) {
            o.log('[media] scanner unavailable', error.message);
            return send(res, 503, { error: 'Uploads are paused. Try again later.' });
          }
          if (!verdict || verdict.ok !== true) {
            o.log(`[media] scanner rejected ${sha.slice(0, 12)} from ${pub.slice(0, 12)}: ${verdict && verdict.reason}`);
            return send(res, 422, { error: 'This file can’t be uploaded.' });
          }
          scanVerdict = verdict;
        } else if (o.production && !o.allowUnscanned) {
          return send(res, 503, { error: 'Media scanning isn’t configured on this relay.' });
        }
      }
      let stored;
      try { stored = await store.put(buf, sha); } catch (error) {
        o.log('[media] store failed', error.message);
        return send(res, 503, { error: 'Storage is unavailable. Try again later.' });
      }
      entry = entries[sha] = { sha, cid: stored.cid, mime: kind === 'private' ? 'application/octet-stream' : mime, size: buf.length, at: now, kept: false, sensitive: Boolean(scanVerdict && scanVerdict.adult), owners: {} };
      delete gone[sha];
    }
    const previous = entry.owners[pub];
    entry.owners[pub] = { at: now, kind: previous && previous.kind === 'avatar' ? 'avatar' : kind };
    if (request.sensitive === true && kind !== 'private') entry.sensitive = true;
    m.save();
    bytesToday.set(pub, { day, bytes: usedToday + buf.length });
    return send(res, 200, { sha, cid: entry.cid, size: entry.size, mime: entry.mime, sensitive: Boolean(entry.sensitive), expiresAt: expiresAt(entry) });
  }

  // ---- serve ----
  async function serve(req, res, sha) {
    const status = statusOf(sha);
    if (status === 'banned') return send(res, 451, { error: 'removed' });
    if (status !== 'live') return send(res, status === 'missing' ? 404 : 410, { error: status });
    const entry = entries[sha];
    let start = 0;
    let end = entry.size - 1;
    let partial = false;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
      else start = Math.max(0, entry.size - Number(range[2]));
      if (start > end || start >= entry.size) return send(res, 416, { error: 'bad range' }, { 'content-range': `bytes */${entry.size}` });
      partial = true;
    }
    const headers = {
      'content-type': entry.mime,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400',
      etag: `"${sha}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'access-control-allow-origin': '*',
      ...(entry.cid ? { 'x-ipfs-cid': entry.cid } : {}),
      ...(entry.sensitive ? { 'x-lain-sensitive': '1' } : {}),
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${entry.size}` } : {}),
    };
    if (req.method === 'HEAD') { res.writeHead(partial ? 206 : 200, headers); res.end(); return undefined; }
    let body;
    try { body = await store.read(sha, entry, start, end); } catch (error) {
      o.log('[media] read failed', sha.slice(0, 12), error.message);
      return send(res, 503, { error: 'storage unavailable' });
    }
    res.writeHead(partial ? 206 : 200, headers);
    body.on('error', () => res.destroy());
    body.pipe(res);
    return undefined;
  }

  function info(res, sha) {
    const status = statusOf(sha);
    const entry = entries[sha];
    return send(res, 200, {
      sha, status,
      ...(entry && status === 'live' ? { size: entry.size, mime: entry.mime, cid: entry.cid, expiresAt: expiresAt(entry), kept: entry.kept, sensitive: Boolean(entry.sensitive) } : {}),
      ...(gone[sha] ? { goneAt: gone[sha].at } : {}),
    });
  }

  async function release(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad request' }); }
    const request = typeof body.pub === 'string' && (await o.verifyFresh(body.request, body.pub));
    if (!request || request.action !== 'release' || !SHA_RE.test(request.sha)) return send(res, 400, { error: 'bad request' });
    const entry = entries[request.sha];
    if (!entry || !entry.owners[body.pub]) return send(res, 200, { ok: true });
    delete entry.owners[body.pub];
    m.save();
    if (!Object.keys(entry.owners).length) await removeFile(request.sha, 'deleted');
    return send(res, 200, { ok: true });
  }

  async function linkPreview(req, res, url) {
    const ip = req.socket.remoteAddress || '?';
    if (!o.limit(`preview:${ip}`, 30, 60_000)) return send(res, 429, { error: 'slow down' });
    let target;
    try { target = new URL(String(url || '')); } catch { return send(res, 400, { error: 'bad url' }); }
    if (!/^https?:$/.test(target.protocol)) return send(res, 400, { error: 'bad url' });
    const key = target.href;
    const cached = previews.get(key);
    if (cached && cached.until > Date.now()) return send(res, 200, cached.value);
    const host = target.hostname.toLowerCase();
    let value = { url: key, provider: 'link', title: host };
    try {
      if (YOUTUBE_HOSTS.has(host)) {
        const data = await (o.fetchJson || fetchJsonSafely)(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(key)}`);
        value = { url: key, provider: 'youtube', title: clip(data.title, 200) || 'YouTube video', author: clip(data.author_name, 100), thumbnail: httpsOnly(data.thumbnail_url) };
      } else if (/^\/(w|videos\/watch)\//.test(target.pathname)) {
        const data = await (o.fetchJson || fetchJsonSafely)(`https://${target.host}/services/oembed?format=json&url=${encodeURIComponent(key)}`);
        if (data && data.type === 'video') value = { url: key, provider: 'peertube', title: clip(data.title, 200) || 'PeerTube video', author: clip(data.author_name, 100), thumbnail: httpsOnly(data.thumbnail_url) };
      }
    } catch (error) {
      o.log('[media] link preview failed', host, error.message);
    }
    if (previews.size > 1000) previews.clear();
    previews.set(key, { value, until: Date.now() + DAY });
    return send(res, 200, value);
  }

  // ---- retention ----

  const collect = (node, maxMs = 2500) => new Promise((resolve) => {
    const out = new Map();
    let idle;
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(idle); clearTimeout(hard); resolve(out); };
    const bump = () => { clearTimeout(idle); idle = setTimeout(finish, 500); };
    const hard = setTimeout(finish, maxMs);
    node.map().once((value, key) => { out.set(key, value); bump(); });
    bump();
  });
  const once = (node, ms = 2000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    node.once((value) => { clearTimeout(timer); resolve(value); }, { wait: 300 });
  });
  const parse = (value) => { try { return typeof value === 'string' ? JSON.parse(value) : null; } catch { return null; } };
  const modKey = (ref) => ref.replace(/\//g, '|');

  /** Popularity of a file: verified likers + 2 × verified reposters of the posts that used it. */
  async function popularity(sha, entry, now) {
    const owners = Object.entries(entry.owners).filter(([, x]) => x.kind === 'post');
    const ownerSet = new Set(Object.keys(entry.owners));
    const ageCache = new Map();
    const oldEnough = async (pub) => {
      if (!o.registrar || !o.keepMinAccountAgeDays) return true;
      if (ageCache.has(pub)) return ageCache.get(pub);
      let ok = false;
      const profile = parse(await once(o.gun.user(pub).get('profile')));
      if (profile && typeof profile.username === 'string') {
        const record = parse(await once(o.gun.user().get('usernames').get(profile.username)));
        ok = Boolean(record && record.pub === pub && now - Number(record.at) >= o.keepMinAccountAgeDays * DAY);
      }
      ageCache.set(pub, ok);
      return ok;
    };
    const counts = async (kind, ref) => {
      const voters = new Set();
      const announced = await collect(o.gun.get(`lain-io/${kind}/${await o.sha256url(ref)}#`));
      for (const value of announced.values()) {
        const entryValue = parse(value);
        const voter = entryValue && entryValue.ref === ref && typeof entryValue.pub === 'string' ? entryValue.pub : null;
        if (!voter || ownerSet.has(voter) || voters.has(voter) || o.policy.bannedPubs.has(voter) || o.policy.purged.has(voter)) continue;
        if (!parse(await once(o.gun.user(voter).get(kind).get(modKey(ref))))) continue;
        if (await oldEnough(voter)) voters.add(voter);
      }
      return voters;
    };

    const refs = new Set();
    for (const [pub, owner] of owners) {
      for (let d = 0; d <= 1; d++) {
        const day = new Date(owner.at + d * DAY).toISOString().slice(0, 10);
        const index = await collect(o.gun.get(`lain-io/index/${day}#`));
        for (const value of index.values()) {
          const pointer = parse(value);
          if (!pointer || typeof pointer.ref !== 'string' || !pointer.ref.startsWith(`${pub}/`)) continue;
          const id = pointer.ref.slice(pub.length + 1);
          const post = parse(await once(o.gun.user(pub).get('posts').get(id)));
          if (post && Array.isArray(post.media) && post.media.some((x) => x && x.sha === sha)) refs.add(pointer.ref);
        }
      }
    }
    const likers = new Set();
    const reposters = new Set();
    for (const ref of refs) {
      for (const pub of await counts('likes', ref)) likers.add(pub);
      for (const pub of await counts('reposts', ref)) reposters.add(pub);
    }
    return { score: likers.size + 2 * reposters.size, likers: likers.size, reposters: reposters.size, posts: refs.size };
  }

  let running = null;
  /** Expire, keep, or remove files. Runs on a timer; tests call it with a fake clock. */
  function runRetention(now = Date.now()) {
    if (running) return running;
    running = (async () => {
      const report = { removed: [], kept: [], expiredOwners: 0 };
      for (const sha of Object.keys(entries)) {
        const entry = entries[sha];
        if (o.policy.bannedMedia.has(sha)) { if (await removeFile(sha, 'banned', now)) report.removed.push(sha); continue; }
        for (const pub of Object.keys(entry.owners)) {
          if (o.policy.bannedPubs.has(pub) || o.policy.purged.has(pub)) delete entry.owners[pub];
        }
        const due = Object.entries(entry.owners).filter(([, x]) => x.kind !== 'avatar' && x.at + ttl <= now);
        if (due.length && !entry.kept && due.some(([, x]) => x.kind === 'post')) {
          const pop = await popularity(sha, entry, now);
          if (pop.score >= o.keepScore) {
            entry.kept = true;
            entry.keptAt = now;
            entry.score = pop.score;
            report.kept.push(sha);
            o.log(`[media] keeping ${sha.slice(0, 12)} forever (score ${pop.score}: ${pop.likers} likers, ${pop.reposters} reposters)`);
          }
        }
        for (const [pub, owner] of due) {
          if (entry.kept && owner.kind === 'post') continue;
          delete entry.owners[pub];
          report.expiredOwners++;
        }
        m.save();
        if (!Object.keys(entry.owners).length && (await removeFile(sha, entry.kept ? 'deleted' : 'expired', now))) report.removed.push(sha);
      }
      for (const [sha, tomb] of Object.entries(gone)) if (now - tomb.at > GONE_KEEP_MS) delete gone[sha];
      if (report.removed.length) { try { await store.gc(); } catch (error) { o.log('[media] gc failed', error.message); } }
      m.flush();
      if (report.removed.length || report.kept.length) o.log(`[media] retention: removed ${report.removed.length}, kept ${report.kept.length}`);
      return report;
    })().finally(() => { running = null; });
    return running;
  }

  /** Account deleted or banned: drop all of its files that nobody else uses. */
  async function releaseOwner(pub) {
    for (const sha of Object.keys(entries)) {
      const entry = entries[sha];
      if (!entry.owners[pub]) continue;
      delete entry.owners[pub];
      if (!Object.keys(entry.owners).length) await removeFile(sha, 'deleted');
    }
    m.save();
  }

  /** Moderation banned a hash: take it down now rather than at the next retention run. */
  function onBanned(sha) { if (entries[sha]) void removeFile(sha, 'banned'); }

  const timer = o.retentionIntervalMs > 0 ? setInterval(() => { void runRetention().catch((e) => o.log('[media] retention failed', e.message)); }, o.retentionIntervalMs) : null;
  if (timer && timer.unref) timer.unref();

  /** Returns true when it handled the request. */
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://relay');
    const p = url.pathname;
    if (p === '/lain/media' && req.method === 'POST') { await upload(req, res); return true; }
    if (p === '/lain/media/release' && req.method === 'POST') { await release(req, res); return true; }
    if (p === '/lain/link-preview' && req.method === 'GET') { await linkPreview(req, res, url.searchParams.get('url')); return true; }
    const match = /^\/lain\/media\/([0-9a-f]{64})(\/info)?$/.exec(p);
    if (match && (req.method === 'GET' || req.method === 'HEAD')) {
      if (match[2]) info(res, match[1]); else await serve(req, res, match[1]);
      return true;
    }
    return false;
  }

  return {
    store: store.name,
    handle,
    runRetention,
    releaseOwner,
    onBanned,
    health: () => store.health(),
    entries,
    close() { if (timer) clearInterval(timer); m.flush(); },
  };
}

module.exports = { createMedia, sniff };
