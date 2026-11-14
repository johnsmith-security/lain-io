// Media on Cloudflare R2 + the IPFS gateway, through the app's own code (src/db).
//   wrangler dev with RETENTION_DAYS tiny, KEEP_MIN_SCORE=1, KEEP_MIN_ACCOUNT_AGE_DAYS=0, RETENTION_EPOCH=0,
//   RELAY_PEER_TOKEN=dev-token:  CF=http://localhost:8788 npx tsx tests/media-cloudflare.e2e.ts
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LainDb } from '../src/db';
import { memoryKV, memorySecure, type Platform } from '../src/db/platform';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Gun: any = require('gun'); require('gun/sea');

const CF = (process.env.CF || 'http://localhost:8788').replace(/\/$/, '');
const TOKEN = process.env.TOKEN || 'dev-token';
const keys = (n: string) => JSON.parse(fs.readFileSync(`${__dirname}/../relay/keys/${n}.json`, 'utf8'));
let failures = 0, passes = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { if (ok) { passes++; console.log(`  ✓ ${name}`); } else { failures++; console.log(`  ✗ ${name}`, detail ?? ''); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const platform = (): Platform => ({ kv: memoryKV(), secure: memorySecure(), persistGun: false, fetch: globalThis.fetch.bind(globalThis) });
const mod = keys('moderation');
const config = { peers: [`${CF}/gun`], serviceUrl: CF, moderationUrl: `${CF}/lain/moderation`, registrarPub: keys('registrar').pub, moderationPub: mod.pub, moderationEpub: mod.epub, releasePub: keys('release').pub, archivistPub: keys('archivist').pub, retentionEpoch: 0, passwordIterations: 2000, readTimeoutMs: 3000 };
const make = () => LainDb.create({ platform: platform(), config });
const png = (n: number) => { const b = crypto.randomBytes(n); Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(b, 0); return new Uint8Array(b); };
const mp4 = (n: number) => { const b = crypto.randomBytes(n); b.writeUInt32BE(32, 0); b.write('ftypisom', 4, 'latin1'); return new Uint8Array(b); };
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const status = async (url: string, init?: RequestInit) => (await fetch(url, init)).status;

async function main() {
  setTimeout(() => { console.log(`\nGLOBAL TIMEOUT · ${passes} passed, ${failures} failed`); process.exit(2); }, 300_000).unref();
  const run = Date.now().toString(36).slice(-5);
  const alice = await make(); await alice.signUp({ username: `md_${run}`, password: 'wired-signal-0451' });
  const fans = await Promise.all([0, 1, 2].map(async (i) => { const d = await make(); await d.signUp({ username: `mf${i}_${run}`, password: 'wired-signal-0451' }); return d; }));

  console.log('\nUpload and download (R2)');
  const img1 = png(70_000), img2 = png(50_000), video = mp4(1_000_000), avatarBytes = png(30_000);
  const ref1 = await alice.media.upload(img1, { mime: 'image/png' });
  check('upload returns sha and an IPFS CID', ref1.sha === sha(img1) && /^bafkrei/.test(ref1.cid || ''), ref1);
  const res = await fetch(alice.media.url(ref1.sha));
  check('download returns the same bytes', res.status === 200 && sha(new Uint8Array(await res.arrayBuffer())) === ref1.sha);
  const part = await fetch(alice.media.url(ref1.sha), { headers: { range: 'bytes=10-19' } });
  check('Range requests work', part.status === 206 && (await part.arrayBuffer()).byteLength === 10 && /bytes 10-19\/70000/.test(part.headers.get('content-range') || ''));
  const refV = await alice.media.upload(video, { mime: 'video/mp4' });
  check('a 1 MB video gets a chunked (dag-pb) CID', /^bafybei/.test(refV.cid || ''), refV.cid);
  const ref2 = await alice.media.upload(img2, { mime: 'image/png' });
  const info = await alice.media.info(ref1.sha);
  check('info reports live, size, CID and an expiry', info.status === 'live' && info.size === 70_000 && Boolean((info as any).expiresAt), info);
  check('a wrong type is refused', await status(`${CF}/lain/media`, { method: 'POST', body: 'x' }) === 400);
  try { await alice.media.upload(png(7 * 1024 * 1024), { mime: 'image/png' }); check('oversized photo refused', false); } catch { check('oversized photo refused', true); }

  console.log('\nIPFS gateway (trustless)');
  const g1 = await fetch(`${CF}/ipfs/${ref1.cid}`);
  check('/ipfs/<cid> serves the file', g1.status === 200 && sha(new Uint8Array(await g1.arrayBuffer())) === ref1.sha);
  const raw = new Uint8Array(await (await fetch(`${CF}/ipfs/${ref1.cid}?format=raw`)).arrayBuffer());
  check('?format=raw block hashes to its CID', sha(raw) === ref1.sha);
  const car = new Uint8Array(await (await fetch(`${CF}/ipfs/${refV.cid}?format=car`, { headers: { accept: 'application/vnd.ipld.car' } })).arrayBuffer());
  const carFile = path.join(os.tmpdir(), `lain-${run}.car`);
  fs.writeFileSync(carFile, car);
  execFileSync('kubectl', ['-n', 'lain', 'cp', carFile, `ipfs-0:/tmp/v.car`], { stdio: 'ignore' });
  const imported = execFileSync('kubectl', ['-n', 'lain', 'exec', 'ipfs-0', '-c', 'kubo', '--', 'sh', '-c', `ipfs dag import --pin-roots=false --stats /tmp/v.car >/dev/null && ipfs cat --offline ${refV.cid} | sha256sum && rm /tmp/v.car`]).toString().split(' ')[0];
  check('Kubo imports our CAR offline and the file matches (verified by IPFS itself)', imported === refV.sha, imported);
  fs.unlinkSync(carFile);

  console.log('\nRetention: media lives as long as its post');
  const avatar = await alice.media.upload(avatarBytes, { mime: 'image/png' }, 'avatar');
  const priv = await alice.media.uploadPrivate(new Uint8Array(crypto.randomBytes(20_000)), 'image/png');
  const top = await alice.social.createPost(`top ${run}`, { media: [ref1] });
  await alice.social.createPost(`meh ${run}`, { media: [ref2] });
  await alice.social.createPost(`video ${run}`, { media: [refV] });
  for (const f of fans) await f.social.like(top.ref);
  await fans[0].social.repost(top.ref);
  await sleep(60_000);   // window (26 s) + grace (≤ window) after the uploads
  const run1 = await (await fetch(`${CF}/lain/retention/run`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).json();
  check('the liked post is kept', run1.kept?.some((k: any) => k.ref.endsWith(`|${top.id}`)), run1);
  check('its photo stays and is marked kept', (await status(alice.media.url(ref1.sha))) === 200 && (await alice.media.info(ref1.sha) as any).kept === true);
  check('the unkept post’s photo is gone (410)', (await status(alice.media.url(ref2.sha))) === 410);
  check('…and its IPFS CID too (410)', (await status(`${CF}/ipfs/${ref2.cid}`)) === 410);
  check('the unkept video and its blocks are gone', (await status(`${CF}/ipfs/${refV.cid}?format=car`)) === 410);
  check('the avatar stays while in use', (await status(alice.media.url(avatar.sha))) === 200);
  check('the DM attachment expired', (await status(`${CF}/lain/media/${priv.sha}`)) === 410);

  console.log('\nModeration');
  const m = Gun({ peers: [`${CF}/gun`], localStorage: false, radisk: false, file: false, axe: false, multicast: false });
  await new Promise<void>((r) => { m.user().auth(mod, () => r()); setTimeout(r, 3000); });
  await new Promise<void>((r) => { m.user().get('moderation').get('media').get(ref1.sha).put(JSON.stringify({ reason: 'media test', at: Date.now() }), () => r()); setTimeout(r, 5000); });
  await sleep(2000);
  check('a banned (even kept) photo answers 451', (await status(`${CF}/lain/media/${ref1.sha}`)) === 451);
  check('…on the IPFS gateway too', (await status(`${CF}/ipfs/${ref1.cid}`)) === 451);
  try { await alice.media.upload(img1, { mime: 'image/png' }); check('re-uploading a banned file is refused', false); } catch { check('re-uploading a banned file is refused', true); }
  await new Promise<void>((r) => { m.user().get('moderation').get('media').get(ref1.sha).put(null, () => r()); setTimeout(r, 4000); });

  console.log('\nAccount deletion');
  await alice.deleteAccount('wired-signal-0451');
  await sleep(1500);
  check('the avatar is deleted with the account', (await status(`${CF}/lain/media/${avatar.sha}`)) === 410);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
