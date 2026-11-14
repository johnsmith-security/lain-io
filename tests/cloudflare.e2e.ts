// The app's own database layer (src/db) against the Cloudflare relay alone: no self-hosted relay.
// Covers what the app needs from Cloudflare today: sign-up with the registrar, sign-in on a second
// device, feeds, likes, link previews, the moderation list and account deletion.
//   CF=http://localhost:8788 npx tsx tests/cloudflare.e2e.ts      (wrangler dev with REGISTRAR_PAIR in .dev.vars)
import fs from 'node:fs';
import { LainDb, UsernameTakenError, type Post } from '../src/db';
import { memoryKV, memorySecure, type Platform } from '../src/db/platform';

const CF = (process.env.CF || 'http://localhost:8788').replace(/\/$/, '');
const keys = (name: string) => JSON.parse(fs.readFileSync(`${__dirname}/../relay/keys/${name}.json`, 'utf8'));
let failures = 0, passes = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { if (ok) { passes++; console.log(`  ✓ ${name}`); } else { failures++; console.log(`  ✗ ${name}`, detail ?? ''); } };
async function waitFor(name: string, fn: () => unknown, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return check(name, true); } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
  check(name, false, `timed out after ${ms} ms`);
}
const platform = (): Platform => ({ kv: memoryKV(), secure: memorySecure(), persistGun: false, fetch: globalThis.fetch.bind(globalThis) });
const moderation = keys('moderation');
const config = {
  peers: [`${CF}/gun`], serviceUrl: CF, moderationUrl: `${CF}/lain/moderation`,
  registrarPub: keys('registrar').pub, moderationPub: moderation.pub, moderationEpub: moderation.epub,
  releasePub: keys('release').pub, archivistPub: keys('archivist').pub, passwordIterations: 2000, readTimeoutMs: 3000,
};
const make = () => LainDb.create({ platform: platform(), config });

async function main() {
  setTimeout(() => { console.log(`\nGLOBAL TIMEOUT · ${passes} passed, ${failures} failed`); process.exit(2); }, 240_000).unref();
  const run = Date.now().toString(36).slice(-6);
  const name = `cf_${run}`;
  console.log(`\nCloudflare relay only: ${CF}\n\nAccounts`);
  const alice = await make();
  const bob = await make();
  const signUp = await alice.signUp({ username: name, password: 'wired-signal-0451' });
  check('sign-up claims the username on the Cloudflare registrar', signUp.session.username === name);
  check('the name now shows as taken', !(await bob.isUsernameAvailable(name)));
  try { await bob.signUp({ username: name, password: 'another-password-1' }); check('a second claim is refused', false); }
  catch (error) { check('a second claim is refused', error instanceof UsernameTakenError, error); }
  const health = await (await fetch(`${CF}/lain/health`)).json();
  check('relay serves health', health.ok === true);
  const device2 = await make();
  const signIn = await device2.signIn({ username: name, password: 'wired-signal-0451' });
  check('sign-in on a second device', signIn.session.pub === signUp.session.pub);
  await bob.signUp({ username: `cfb_${run}`, password: 'wired-signal-0451' });

  console.log('\nFeed');
  let discovery: Post[] = [];
  const stop = bob.social.subscribeDiscovery((p) => { discovery = p; });
  const post = await alice.social.createPost(`Present day, present time. ${run}`);
  await waitFor('bob’s discovery feed shows alice’s post', () => discovery.some((p) => p.ref === post.ref));
  let likes = { count: 0 };
  const stopLikes = alice.social.subscribeLikes(post.ref, (s) => { likes = s; });
  await bob.social.like(post.ref);
  await waitFor('alice sees bob’s like', () => likes.count === 1);
  stopLikes(); stop();

  console.log('\nServices');
  const preview = await alice.media.linkPreview('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  check('YouTube link preview through the relay', preview.provider === 'youtube' && Boolean(preview.title), preview);
  check('the app pulled the moderation list from Cloudflare', await alice.moderation.pull());

  console.log('\nAccount deletion');
  await alice.deleteAccount('wired-signal-0451');
  await waitFor('the username is released', async () => bob.isUsernameAvailable(name));
  const after = await (await fetch(`${CF}/lain/health`)).json();
  check('the account is purged on the relay', after.bans.purged >= 1, after.bans);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
