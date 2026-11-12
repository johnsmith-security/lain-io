// "bob", a second user that lives on your computer, so a phone has someone to
// interact with through the relay.
//   npm run bot            (needs the relay running and .env from relay/tools/dev-setup.js)
// He: signs up (or back in) as @bob, posts a hello with a generated picture,
// follows and likes every new post in "The Wired", relays (reposts) posts that
// have photos or videos, and replies to direct messages and group messages.
// DMs: read receipts on; photos and videos you send him are downloaded and
// decrypted (proving the end-to-end path), and he answers a photo with an
// encrypted picture of his own. "delete" in a DM makes him delete his last
// message for everyone.
// State (keys, Signal sessions) persists in tools/.bot-state.json.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LainDb, type Post } from '../src/db';
import type { LocalKV, Platform, SecureKV } from '../src/db/platform';

const USERNAME = process.env.BOT_USERNAME ?? 'bob';
const PASSWORD = process.env.BOT_PASSWORD ?? 'wired-bot-passphrase-01';
const STATE = path.join(__dirname, '.bot-state.json');
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

function loadEnv(): Record<string, string> {
  const file = path.join(__dirname, '..', '.env');
  const out: Record<string, string> = {};
  for (const line of fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : []) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function filePlatform(): Platform {
  const state: { kv: Record<string, Record<string, string>>; secure: Record<string, string> } =
    fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { kv: {}, secure: {} };
  let timer: NodeJS.Timeout | null = null;
  const save = () => { if (!timer) timer = setTimeout(() => { timer = null; fs.writeFileSync(STATE, JSON.stringify(state)); }, 200); };
  const bucket = (ns: string) => (state.kv[ns] ??= {});
  const kv: LocalKV = {
    get: (ns, k) => bucket(ns)[k] ?? null,
    set: (ns, k, v) => { bucket(ns)[k] = v; save(); },
    del: (ns, k) => { delete bucket(ns)[k]; save(); },
    list: (ns, prefix = '') => Object.keys(bucket(ns)).filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, value: bucket(ns)[key] })),
    clear: (ns) => { delete state.kv[ns]; save(); },
    clearPrefix: (p) => { for (const ns of Object.keys(state.kv)) if (ns.startsWith(p)) delete state.kv[ns]; save(); },
  };
  const secure: SecureKV = {
    get: async (k) => state.secure[k] ?? null,
    set: async (k, v) => { state.secure[k] = v; save(); },
    del: async (k) => { delete state.secure[k]; save(); },
  };
  return { kv, secure, persistGun: false, fetch: globalThis.fetch.bind(globalThis) };
}

/** A 320×200 vaporwave gradient PNG, made without image libraries. */
function gradientPng(seed: number): Uint8Array {
  const width = 320; const height = 200;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const grid = (x + seed) % 32 === 0 || y % 25 === 0 ? 60 : 0;
      raw[o] = Math.min(255, 40 + (x / width) * 215 + grid);
      raw[o + 1] = Math.min(255, 10 + (y / height) * 60 + grid);
      raw[o + 2] = Math.min(255, 120 + (1 - y / height) * 135);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

async function main() {
  const env = loadEnv();
  const peers = (env.EXPO_PUBLIC_GUN_PEERS ?? 'http://localhost:8765/gun').split(',').map((s) => s.trim()).filter(Boolean);
  const db = await LainDb.create({
    platform: filePlatform(),
    config: {
      peers,
      serviceUrl: env.EXPO_PUBLIC_LAIN_SERVICE_URL ?? 'http://localhost:8765',
      registrarPub: env.EXPO_PUBLIC_LAIN_REGISTRAR_PUB ?? '',
      moderationPub: env.EXPO_PUBLIC_LAIN_MODERATION_PUB ?? '',
      moderationEpub: env.EXPO_PUBLIC_LAIN_MODERATION_EPUB ?? '',
      releasePub: env.EXPO_PUBLIC_LAIN_RELEASE_PUB ?? '',
    },
  });
  log(`relay ${peers.join(', ')}`);

  if (!db.session) {
    if (await db.isUsernameAvailable(USERNAME)) {
      await db.signUp({ username: USERNAME, password: PASSWORD });
      await db.profiles.updateMine({ name: 'Bob (bot)', bio: 'I live on the developer’s computer. Say hi.' });
      log(`signed up as @${USERNAME}`);
    } else {
      await db.signIn({ username: USERNAME, password: PASSWORD });
      log(`signed in as @${USERNAME}`);
    }
  } else {
    log(`restored session @${db.session.username}`);
  }
  const me = db.session!.pub;
  log(`pub ${me.slice(0, 16)}… device ${db.session!.deviceId}`);

  // Old device records from earlier runs would make senders encrypt to dead devices.
  for (const d of await db.messages.myDevices()) {
    if (!d.current && !d.revoked) { await db.messages.revokeDevice(d.deviceId); log(`revoked stale device ${d.deviceId}`); }
  }

  try {
    const picture = await db.media.upload(gradientPng(Date.now() % 32), { mime: 'image/png', width: 320, height: 200 });
    await db.social.createPost(`bob is online at ${new Date().toLocaleTimeString()} — post something and I’ll like it. Post a photo and I’ll relay it.`, { media: [picture] });
    log(`posted a picture (${picture.sha.slice(0, 12)}…${picture.cid ? `, ipfs ${picture.cid.slice(0, 16)}…` : ''})`);
  } catch (error) {
    log('picture upload failed:', (error as Error).message);
    await db.social.createPost(`bob is online at ${new Date().toLocaleTimeString()} — post something and I’ll like it.`);
  }

  const handled = new Set<string>();
  db.social.subscribeDiscovery((posts: Post[]) => {
    for (const post of posts) {
      if (post.author === me || handled.has(post.ref)) continue;
      handled.add(post.ref);
      void (async () => {
        const author = await db.profiles.get(post.author);
        await db.social.like(post.ref);
        await db.social.follow(post.author).catch(() => {});
        log(`liked @${author?.username ?? '?'}: "${post.body.slice(0, 60)}"${post.media ? ` [${post.media.length} file(s)]` : ''}${post.link ? ` [${post.link.provider} link]` : ''}`);
        if (post.media && !post.repostOf) { await db.social.repost(post.ref); log('  relayed it'); }
      })().catch((e) => log('like failed', e.message));
    }
  });

  const replied = new Set(db.ctx.platform.kv.list(`${me}:bot`).map((e) => e.key));
  const startedAt = Date.now();
  db.messages.subscribeConversations((conversations) => {
    for (const conv of conversations) {
      for (const msg of db.messages.listMessages(conv.id, { limit: 20 })) {
        if (msg.from === me || msg.deleted || replied.has(msg.id) || msg.receivedAt < startedAt - 60_000) continue;
        replied.add(msg.id);
        db.ctx.platform.kv.set(`${me}:bot`, msg.id, '1');
        void (async () => {
          const who = (await db.profiles.get(msg.from))?.username ?? '?';
          log(`${conv.kind} from @${who}: "${msg.text}"${msg.media ? ` + ${msg.media.length} attachment(s)` : ''}`);
          await new Promise((r) => setTimeout(r, 800));
          db.messages.markRead(conv.id);
          if (/^delete$/i.test(msg.text.trim())) {
            const mine = db.messages.listMessages(conv.id, { limit: 50 }).filter((m) => m.from === me && !m.deleted).pop();
            if (mine) { await db.messages.deleteForEveryone(conv.id, mine.id); log('deleted my last message for everyone'); }
            return;
          }
          if (msg.media?.length) {
            const sizes: string[] = [];
            for (const m of msg.media) {
              try { const bytes = await db.media.downloadPrivate(m); sizes.push(`${m.plainMime} ${(bytes.length / 1024).toFixed(0)} KB`); }
              catch (e) { sizes.push(`${m.plainMime} (couldn’t decrypt: ${(e as Error).message})`); }
            }
            const png = gradientPng((Date.now() / 1000) | 0);
            const ref = await db.media.uploadPrivate(png, 'image/png', { width: 320, height: 200 });
            const reply = await db.messages.send(conv.id, `bob here — decrypted ${sizes.join(', ')} on my side. The relay and IPFS only ever held ciphertext. Here’s one back:`, { media: [ref] });
            log(`replied with an encrypted picture (${reply.status})`);
            return;
          }
          const reply = await db.messages.send(conv.id, `bob here — got "${msg.text.slice(0, 80)}" (end-to-end encrypted, relay saw only ciphertext)`);
          log(`replied (${reply.status})`);
        })().catch((e) => log('reply failed', e.message));
      }
    }
  });

  if (!db.settings.get().readReceipts) await db.settings.update({ readReceipts: true }).catch(() => undefined);
  // Show delivery / read receipts as they come back for bob's own messages.
  log('listening… (Ctrl+C to stop)');
}

main().catch((error) => { console.error(error); process.exit(1); });
