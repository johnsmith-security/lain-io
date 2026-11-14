// Lain IO relay: a Gun peer plus the main relay's services.
//
//   wss://<host>/gun                 Gun sync (every relay)
//   POST /lain/registrar/claim       first-come username registrar      (main relay only: REGISTRAR_PAIR set)
//   POST /lain/registrar/release     owner releases a username
//   POST /lain/recovery/send         email a recovery code (not stored) (needs SMTP_URL in production)
//   POST /lain/account/purge         stop storing/serving a deleted account
//   /lain/media, /lain/link-preview  images and videos (see media.js; main relay)
//   GET  /lain/health
//
// Enforcement (every relay running this file, community relays included):
//   - drops writes and reads for banned or purged accounts and banned posts
//   - strips banned posts from outgoing data
//   - drops mail envelopes older than MAIL_RETENTION_DAYS
//   - rate-limits mail writes per connection (MAIL_WRITES_PER_MIN) so one client can't flood mailboxes
//   - rejects oversized values
//   - post retention (plan §2b): posts older than RETENTION_DAYS (from RETENTION_EPOCH at the
//     earliest) that aren't on the archivist's keep list are refused and not served. The Cloudflare
//     relay ranks and decides; this relay follows its signed keep list.
//
// Run a single registrar (one node). Other main-relay nodes can run without
// REGISTRAR_PAIR and proxy /lain/registrar/* to it.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const Gun = require('gun');
const SEA = require('gun/sea');
const { createMedia } = require('./media');

const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'help', 'security', 'staff', 'official',
  'mod', 'moderator', 'moderation', 'laincorp', 'lain', 'lain_io', 'lainio', 'registrar', 'relay', 'null', 'undefined']);
const validName = (name) => typeof name === 'string' && /^[a-z0-9_]{3,20}$/.test(name) && !RESERVED.has(name);
const validEmail = (email) => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const parseSigned = (signed) => { try { return JSON.parse(String(signed).replace(/^SEA/, '')).m; } catch { return undefined; } };
const sha256url = async (text) => String(await SEA.work(text, null, null, { name: 'SHA-256' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const POSTS_RE = /^~([^/@][^/]*)\/posts$/;
const RETENTION_GRACE_MS = 2 * 3_600_000;
/** createdAt of a (signed) post value, or null. */
function createdAtOf(val) {
  try {
    let v = typeof val === 'string' && val[0] === '{' ? JSON.parse(val) : val;
    if (v && typeof v === 'object' && ':' in v) v = v[':'];
    if (typeof v !== 'string') return null;
    const at = Number(JSON.parse(v).createdAt);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch { return null; }
}
const pubOfSoul = (soul) => (typeof soul === 'string' && soul[0] === '~' && soul[1] !== '@' ? soul.slice(1).split('/')[0] : null);

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

// ---------- enforcement middleware ----------

const policies = new WeakMap();

Gun.on('opt', function (root) {
  this.to.next(root);
  const policy = root.opt && root.opt.lainPolicy;
  if (!policy || root.once || policies.has(root)) return;
  policies.set(root, policy);

  const soulBlocked = (soul) => {
    const pub = pubOfSoul(soul);
    if (pub && (policy.bannedPubs.has(pub) || policy.purged.has(pub))) return true;
    const mail = /^lain-io\/mail\/(\d{4}-\d{2}-\d{2})\//.exec(soul || '');
    if (mail && Date.parse(`${mail[1]}T00:00:00Z`) < Date.now() - policy.mailRetentionDays * 86_400_000) return true;
    return false;
  };
  const keyBlocked = (soul, key) => {
    const pub = pubOfSoul(soul);
    return Boolean(pub && soul === `~${pub}/posts` && policy.bannedPosts.has(`${pub}|${key}`));
  };
  const tooBig = (val) => typeof val === 'string' && val.length > policy.maxValueBytes;
  const postExpired = (soul, key, val) => {
    if (!policy.archivistPub || !policy.retentionDays) return false;
    const m = POSTS_RE.exec(soul || '');
    if (!m) return false;
    const created = createdAtOf(val);
    if (created === null) return false;
    const born = Math.max(Math.min(created, Date.now()), policy.retentionEpoch || 0);
    return born < Date.now() - policy.retentionDays * 86_400_000 - RETENTION_GRACE_MS && !policy.kept.has(`${m[1]}|${key}`);
  };
  const MAIL_RE = /^lain-io\/mail\//;
  // Per-connection token bucket for mail writes. Gun sets msg._.via to the sending peer.
  const buckets = new WeakMap();
  const mailAllowed = (msg, count) => {
    const peer = msg && msg._ && msg._.via;
    if (!peer || typeof peer !== 'object' || !policy.mailWritesPerMin) return true;
    const now = Date.now();
    const rate = policy.mailWritesPerMin / 60_000;
    let b = buckets.get(peer);
    if (!b) { b = { tokens: policy.mailWritesPerMin, at: now }; buckets.set(peer, b); }
    b.tokens = Math.min(policy.mailWritesPerMin, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (b.tokens < count) { policy.mailDropped = (policy.mailDropped || 0) + 1; return false; }
    b.tokens -= count;
    return true;
  };

  // Incoming: runs before Gun's own handler because 'opt' fires first.
  root.on('in', function (msg) {
    const put = msg && msg.put;
    if (put) {
      if (put['#'] && put['.'] !== undefined) {                           // single-key form
        if (soulBlocked(put['#']) || keyBlocked(put['#'], put['.']) || tooBig(put[':']) || postExpired(put['#'], put['.'], put[':'])) return;
        if (MAIL_RE.test(put['#']) && !mailAllowed(msg, 1)) return;
      } else {                                                             // graph form
        let mailKeys = 0;
        for (const soul of Object.keys(put)) {
          const node = put[soul];
          if (soulBlocked(soul)) return;
          for (const key of Object.keys(node || {})) {
            if (key === '_') continue;
            if (keyBlocked(soul, key) || tooBig(node[key]) || postExpired(soul, key, node[key])) return;
            if (MAIL_RE.test(soul)) mailKeys++;
          }
        }
        if (mailKeys && !mailAllowed(msg, mailKeys)) return;
      }
    }
    const get = msg && msg.get;
    if (get && typeof get['#'] === 'string' && soulBlocked(get['#'])) return;
    if (get && typeof get['#'] === 'string' && typeof get['.'] === 'string' && keyBlocked(get['#'], get['.'])) return;
    this.to.next(msg);
  });

  // Outgoing: strip banned posts from replies we send to peers.
  root.on('out', function (msg) {
    const put = msg && msg.put;
    if (put && !put['#']) {
      // Graph nodes here can be Gun's live in-memory objects: filter into copies, never mutate.
      let changed = false;
      const filtered = {};
      for (const soul of Object.keys(put)) {
        if (soulBlocked(soul)) { changed = true; continue; }
        const node = put[soul];
        const keys = Object.keys(node || {}).filter((key) => key !== '_' && (keyBlocked(soul, key) || postExpired(soul, key, node[key])));
        if (!keys.length) { filtered[soul] = node; continue; }
        changed = true;
        const copy = { ...node, _: { ...(node._ || {}), '>': { ...((node._ || {})['>'] || {}) } } };
        for (const key of keys) { delete copy[key]; delete copy._['>'][key]; }
        filtered[soul] = copy;
      }
      if (changed) {
        if (!Object.keys(filtered).length) return;
        msg = { ...msg, put: filtered };
      }
    } else if (put && put['#'] && (soulBlocked(put['#']) || keyBlocked(put['#'], put['.']) || postExpired(put['#'], put['.'], put[':']))) {
      return;
    }
    this.to.next(msg);
  });
});

// ---------- services ----------

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

/** Verify a SEA-signed request made within the last 10 minutes. */
async function verifyFresh(signed, pub) {
  const data = await SEA.verify(signed, pub);
  if (!data || typeof data !== 'object' || Math.abs(Date.now() - Number(data.at)) > 10 * 60_000) return null;
  return data;
}

function rateLimiter() {
  const hits = new Map();
  return (key, max, windowMs) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

function readOnce(node, ms = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(undefined), ms);
    function finish(v) { if (done) return; done = true; clearTimeout(timer); resolve(v); }
    node.once((v) => finish(v), { wait: 300 });
  });
}

function putAck(node, value, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms); // no ack without storage or peers: treat as queued
    node.put(value, (ack) => { clearTimeout(timer); if (ack && ack.err) reject(new Error(ack.err)); else resolve(); });
  });
}

async function createMailer(options) {
  if (!options.smtpUrl) return null;
  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport(options.smtpUrl);
  return async ({ to, username, code }) => {
    await transport.sendMail({
      from: options.mailFrom,
      to,
      subject: 'Your Lain IO recovery code',
      text: [
        `Recovery code for @${username}:`,
        '',
        `    ${code}`,
        '',
        'Use it in the app (Sign in → Forgot password) to set a new password.',
        'Anyone with this code can reset your password. Keep this email private, or delete it after saving the code.',
        'If you didn’t ask for this, you can ignore it.',
      ].join('\n'),
    });
  };
}

/**
 * Start a relay. Options default to env vars; tests pass them directly.
 * Returns { url, httpUrl, gun, server, close }.
 */
async function start(options = {}) {
  const env = process.env;
  const o = {
    port: Number(options.port ?? env.PORT ?? 8765),
    host: options.host ?? env.HOST ?? '0.0.0.0',
    dataDir: options.dataDir ?? env.DATA_DIR ?? path.join(__dirname, 'data'),
    peers: options.peers ?? (env.RELAY_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    registrarPair: options.registrarPair ?? (env.REGISTRAR_PAIR ? JSON.parse(env.REGISTRAR_PAIR) : null),
    moderationPub: options.moderationPub ?? env.MODERATION_PUB ?? '',
    // Cloudflare relay's signed moderation list; pulled every minute so this relay enforces the
    // same bans even when it isn't peered with Cloudflare. SEA verifies every value.
    moderationUrl: options.moderationUrl ?? env.MODERATION_URL ?? '',
    archivistPub: options.archivistPub ?? env.ARCHIVIST_PUB ?? '',
    retentionDays: Number(options.retentionDays ?? env.RETENTION_DAYS ?? 30),
    retentionEpoch: Number(options.retentionEpoch ?? env.RETENTION_EPOCH ?? 1_794_528_000_000),
    smtpUrl: options.smtpUrl ?? env.SMTP_URL ?? '',
    mailFrom: options.mailFrom ?? env.MAIL_FROM ?? 'Lain IO <no-reply@lain.io>',
    production: options.production ?? env.NODE_ENV === 'production',
    mailRetentionDays: Number(options.mailRetentionDays ?? env.MAIL_RETENTION_DAYS ?? 30),
    mailWritesPerMin: Number(options.mailWritesPerMin ?? env.MAIL_WRITES_PER_MIN ?? 600),
    maxValueBytes: Number(options.maxValueBytes ?? env.MAX_VALUE_BYTES ?? 65_536),
    persist: options.persist ?? true,
    ipfsApi: options.ipfsApi ?? env.IPFS_API ?? '',
    scannerUrl: options.scannerUrl ?? env.SCANNER_URL ?? '',
    allowUnscanned: options.allowUnscanned ?? env.ALLOW_UNSCANNED_MEDIA === '1',
    mediaTtlDays: Number(options.mediaTtlDays ?? env.MEDIA_TTL_DAYS ?? 30),
    keepScore: Number(options.keepScore ?? env.MEDIA_KEEP_SCORE ?? 50),
    keepMinAccountAgeDays: Number(options.keepMinAccountAgeDays ?? env.MEDIA_KEEP_MIN_ACCOUNT_AGE_DAYS ?? 7),
    retentionIntervalMs: Number(options.retentionIntervalMs ?? (env.MEDIA_RETENTION_INTERVAL_MIN ?? 60) * 60_000),
    maxVideoBytes: Number(options.maxVideoBytes ?? env.MEDIA_MAX_VIDEO_BYTES ?? 25 * 1024 * 1024),
    dailyBytes: Number(options.dailyBytes ?? env.MEDIA_DAILY_BYTES ?? 300 * 1024 * 1024),
    scan: options.scan,           // tests: (buf, mime, sha) => ({ ok, reason })
    fetchJson: options.fetchJson, // tests: stub for oEmbed requests
    onMail: options.onMail, // tests: capture outgoing mail
    log: options.log ?? console.log,
  };
  fs.mkdirSync(o.dataDir, { recursive: true });
  const purgedFile = path.join(o.dataDir, 'purged.json');
  const policy = {
    bannedPubs: new Set(),
    bannedPosts: new Set(),
    bannedMedia: new Set(),
    purged: new Set(readJson(purgedFile, [])),
    kept: new Set(),
    archivistPub: o.archivistPub,
    retentionDays: o.retentionDays,
    retentionEpoch: o.retentionEpoch,
    mailRetentionDays: o.mailRetentionDays,
    mailWritesPerMin: o.mailWritesPerMin,
    maxValueBytes: o.maxValueBytes,
  };
  const limit = rateLimiter();
  const mailer = o.onMail ? async (m) => o.onMail(m) : await createMailer(o);
  const locks = new Map();
  const withLock = (key, fn) => {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  };

  let gun;
  let media = null;
  let moderationTimer = null;
  const routes = {
    'GET /lain/health': async () => [200, { ok: true, registrar: Boolean(o.registrarPair), moderation: Boolean(o.moderationPub), media: media ? { store: media.store, healthy: await media.health() } : null, mail: { retentionDays: policy.mailRetentionDays, writesPerMin: policy.mailWritesPerMin, dropped: policy.mailDropped || 0 } }],

    'POST /lain/registrar/claim': async (body) => {
      if (!o.registrarPair) return [404, { error: 'no registrar on this relay' }];
      const unsigned = parseSigned(body.claim);
      if (!unsigned || typeof unsigned.pub !== 'string') return [400, { error: 'bad claim' }];
      const claim = await SEA.verify(body.claim, unsigned.pub);
      if (!claim || claim.pub !== unsigned.pub || !validName(claim.name)) return [400, { error: 'bad claim' }];
      if (!limit(`claim:${claim.pub}`, 10, 3_600_000)) return [429, { error: 'slow down' }];
      return withLock(claim.name, async () => {
        const node = gun.user().get('usernames').get(claim.name);
        const existing = await readOnce(node);
        let record; try { record = existing ? JSON.parse(existing) : null; } catch { record = null; }
        if (record && record.pub !== claim.pub) return [409, { error: 'taken' }];
        if (!record) await putAck(node, JSON.stringify({ pub: claim.pub, at: Date.now() }));
        return [200, { ok: true }];
      });
    },

    'POST /lain/registrar/release': async (body) => {
      if (!o.registrarPair) return [404, { error: 'no registrar on this relay' }];
      const unsigned = parseSigned(body.request);
      const request = unsigned && (await verifyFresh(body.request, unsigned.pub));
      if (!request || request.action !== 'release' || !validName(request.name)) return [400, { error: 'bad request' }];
      return withLock(request.name, async () => {
        const node = gun.user().get('usernames').get(request.name);
        let record; try { record = JSON.parse(await readOnce(node)); } catch { record = null; }
        if (!record || record.pub !== request.pub) return [403, { error: 'not the owner' }];
        await putAck(node, null);
        return [200, { ok: true }];
      });
    },

    'POST /lain/recovery/send': async (body) => {
      const request = typeof body.pub === 'string' && (await verifyFresh(body.request, body.pub));
      if (!request || !validEmail(request.email) || !validName(request.username) || typeof request.code !== 'string') return [400, { error: 'bad request' }];
      if (!limit(`mail-pub:${body.pub}`, 3, 3_600_000) || !limit(`mail-to:${request.email.toLowerCase()}`, 5, 86_400_000)) return [429, { error: 'slow down' }];
      if (!mailer) {
        if (o.production) return [503, { error: 'mail not configured' }];
        o.log(`[relay] (dev, no SMTP) recovery code for @${request.username} <${request.email}>: ${request.code}`);
        return [200, { ok: true, dev: true }];
      }
      await mailer({ to: request.email, username: request.username, code: request.code });
      return [200, { ok: true }];
    },

    'POST /lain/account/purge': async (body) => {
      const request = typeof body.pub === 'string' && (await verifyFresh(body.request, body.pub));
      if (!request || request.action !== 'purge' || request.pub !== body.pub) return [400, { error: 'bad request' }];
      policy.purged.add(body.pub);
      fs.writeFileSync(purgedFile, JSON.stringify([...policy.purged]));
      if (media) await media.releaseOwner(body.pub);
      return [200, { ok: true }];
    },
  };

  const server = http.createServer(async (req, res) => {
    const route = `${req.method} ${(req.url || '').split('?')[0]}`;
    if (req.method === 'OPTIONS' && (req.url || '').startsWith('/lain/')) {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,HEAD,POST', 'access-control-allow-headers': 'content-type,range,x-lain-pub,x-lain-request' });
      res.end();
      return;
    }
    if (media && /^\/lain\/(media|link-preview)/.test(req.url || '')) {
      try { if (await media.handle(req, res)) return; } catch (error) {
        o.log('[relay] media request failed', error && error.message);
        if (!res.headersSent) json(res, 500, { error: 'media request failed' }); else res.destroy();
        return;
      }
    }
    const handler = routes[route];
    if (!handler) {
      if ((req.url || '').startsWith('/lain/')) { json(res, 404, { error: 'not found' }); return; }
      if (Gun.serve) { Gun.serve(__dirname)(req, res); return; }
      res.writeHead(404); res.end();
      return;
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const [status, payload] = await handler(body);
      json(res, status, payload);
    } catch (error) {
      o.log('[relay] request failed', route, error && error.message);
      json(res, 400, { error: 'bad request' });
    }
  });

  await new Promise((resolve) => server.listen(o.port, o.host, resolve));
  const port = server.address().port;

  gun = Gun({
    web: server,
    peers: o.peers,
    file: path.join(o.dataDir, 'radata'),
    radisk: o.persist,
    localStorage: false,
    axe: false,
    multicast: false,
    lainPolicy: policy,
  });

  if (o.registrarPair) {
    await new Promise((resolve, reject) => gun.user().auth(o.registrarPair, (ack) => (ack.err ? reject(new Error(ack.err)) : resolve())));
  }

  if (o.moderationPub) {
    const mod = gun.get(`~${o.moderationPub}`).get('moderation');
    const follow = (kind, set) => mod.get(kind).map().on((value, key) => { if (value) set.add(key); else set.delete(key); });
    follow('pubs', policy.bannedPubs);
    follow('posts', policy.bannedPosts);
    mod.get('media').map().on((value, key) => {
      if (value) { policy.bannedMedia.add(key); if (media) media.onBanned(key); } else policy.bannedMedia.delete(key);
    });
    if (o.archivistPub) {
      gun.get(`~${o.archivistPub}`).get('keep').map().on((value, key) => { if (value) policy.kept.add(key); else policy.kept.delete(key); });
    }
    if (o.moderationUrl) {
      const pull = async () => {
        try {
          const res = await fetch(o.moderationUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return;
          const body = await res.json();
          if (body.moderationPub !== o.moderationPub || !body.graph) return;
          const graph = {};
          for (const [soul, node] of Object.entries(body.graph)) {
            if (soul === `~${o.moderationPub}` || soul.startsWith(`~${o.moderationPub}/moderation`)) graph[soul] = node;
            else if (o.archivistPub && (soul === `~${o.archivistPub}` || soul === `~${o.archivistPub}/keep`)) graph[soul] = node;
          }
          gun._.root.on('in', { '#': Math.random().toString(36).slice(2, 11), put: graph });
        } catch (error) { o.log('[relay] moderation pull failed', error && error.message); }
      };
      void pull();
      moderationTimer = setInterval(pull, 60_000);
    }
  }

  media = createMedia({
    ...o,
    ttlDays: o.mediaTtlDays,
    gun,
    policy,
    registrar: Boolean(o.registrarPair),
    verifyFresh,
    limit,
    sha256url,
  });

  o.log(`[relay] listening on ${port} · registrar ${o.registrarPair ? 'on' : 'off'} · moderation ${o.moderationPub ? 'on' : 'off'} · mail ${mailer ? 'on' : o.production ? 'OFF' : 'dev-log'} · media ${media.store}${o.scannerUrl || o.scan ? ' (scanned)' : o.production && !o.allowUnscanned ? ' (uploads OFF: no scanner)' : ' (unscanned, dev)'}`);
  return {
    url: `http://127.0.0.1:${port}/gun`,
    httpUrl: `http://127.0.0.1:${port}`,
    gun,
    policy,
    server,
    media,
    close: () => new Promise((resolve) => {
      media.close();
      if (moderationTimer) clearInterval(moderationTimer);
      try { Object.values(gun.back('opt.peers') || {}).forEach((peer) => { try { peer.wire && peer.wire.close(); } catch { /* noop */ } }); } catch { /* noop */ }
      server.closeAllConnections && server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

module.exports = { start };

if (require.main === module) {
  start().catch((error) => { console.error(error); process.exit(1); });
}
