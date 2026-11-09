// End-to-end test of the database layer against a real relay, in Node.
//   npm run test:db
// Spins up relay/server.js on a random port with a registrar and moderation
// key, then drives several LainDb instances (separate "devices") through
// sign-up, sign-in, feed, likes, follows, settings sync, E2E messages, groups,
// moderation, reports, Lain memory, recovery, password change, and deletion.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LainDb, InvalidCredentialsError, UsernameTakenError, type Post } from '../src/db';
import { memoryKV, memorySecure, type Platform } from '../src/db/platform';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SEA: any = require('gun/sea');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Gun: any = require('gun');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const relayModule = require('../relay/server.js');

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}`, detail ?? ''); }
}
async function waitFor<T>(name: string, fn: () => T | Promise<T>, timeoutMs = 15000): Promise<T | undefined> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    try { last = await fn(); if (last) { check(name, true); return last; } } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  check(name, false, `timed out after ${timeoutMs} ms`);
  return undefined;
}
async function rejects(name: string, p: Promise<unknown>, type?: new (...a: any[]) => Error) {
  try { await p; check(name, false, 'did not reject'); }
  catch (error) { check(name, !type || error instanceof type, error); }
}
const platform = (): Platform => ({ kv: memoryKV(), secure: memorySecure(), persistGun: false, fetch: globalThis.fetch.bind(globalThis) });

async function main() {
  setTimeout(() => { console.log(`\nGLOBAL TIMEOUT · ${passes} passed, ${failures} failed`); process.exit(2); }, 360_000).unref();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-relay-'));
  const registrar = await SEA.pair();
  const moderation = await SEA.pair();
  const release = await SEA.pair();
  const mails: Array<{ to: string; username: string; code: string }> = [];
  const relay = await relayModule.start({
    port: 0, host: '127.0.0.1', dataDir, persist: true, registrarPair: registrar, moderationPub: moderation.pub,
    onMail: (m: any) => mails.push(m), log: () => {},
    // media: fake scanner (rejects one known-bad file, flags "adult" ones), low keep threshold, manual retention
    scan: async (buf: Buffer) => ({ ok: !buf.includes(Buffer.from('KNOWN-BAD')), adult: buf.includes(Buffer.from('ADULT')) }),
    keepScore: 3, retentionIntervalMs: 0,
    fetchJson: async (url: string) => (url.startsWith('https://www.youtube.com/oembed')
      ? { title: 'Serial Experiments', author_name: 'wired', thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' } : {}),
  });
  const config = {
    peers: [relay.url], serviceUrl: relay.httpUrl, registrarPub: registrar.pub,
    moderationPub: moderation.pub, moderationEpub: moderation.epub, releasePub: release.pub,
    passwordIterations: 2000, readTimeoutMs: 2000,
  };
  const make = () => LainDb.create({ platform: platform(), config });

  console.log('\nAccounts');
  const alice = await make();
  const bob = await make();
  const aliceSignUp = await alice.signUp({ username: 'Alice', password: 'wired-signal-0451', email: 'alice@example.com' });
  check('sign-up returns a session with the normalized username', aliceSignUp.session.username === 'alice');
  check('sign-up with email returns a recovery code', /^[A-Z2-9]{4}(-[A-Z2-9]{4}){7}$/.test(aliceSignUp.recoveryCode ?? ''), aliceSignUp.recoveryCode);
  check('recovery email was handed to the mail service', aliceSignUp.emailSent === true && mails[0]?.to === 'alice@example.com' && mails[0]?.code === aliceSignUp.recoveryCode);
  await bob.signUp({ username: 'bob', password: 'navi-protocol-7' + 'xyz' });
  check('bob has a messaging device', typeof bob.session?.deviceId === 'number' && bob.session.deviceId > 0);

  const squatter = await make();
  await rejects('a taken username is refused', squatter.signUp({ username: 'alice', password: 'another-long-pass-1' }), UsernameTakenError);
  await rejects('short passwords are refused', squatter.signUp({ username: 'carol', password: 'short' }));
  await rejects('reserved usernames are refused', squatter.signUp({ username: 'admin', password: 'another-long-pass-1' }));
  check('username availability', (await squatter.isUsernameAvailable('carol')) && !(await squatter.isUsernameAvailable('alice')));

  console.log('\nSign-in from a second device');
  const alice2 = await make();
  await rejects('wrong password is refused', alice2.signIn({ username: 'alice', password: 'wrong-password-123' }), InvalidCredentialsError);
  await alice2.signIn({ username: 'alice', password: 'wired-signal-0451' });
  check('second device signs into the same account', alice2.session?.pub === alice.session?.pub);
  check('second device has its own device id', alice2.session?.deviceId !== alice.session?.deviceId);

  console.log('\nProfiles');
  const aliceProfile = await waitFor('bob sees alice’s profile, verified', async () => {
    const p = await bob.profiles.get(alice.session!.pub);
    return p?.verified && p.username === 'alice' ? p : undefined;
  });
  check('profile has defaults', aliceProfile?.name === 'alice');
  await alice.profiles.updateMine({ bio: 'present day, present time' });
  await waitFor('profile edits sync', async () => (await new Promise<string>((res) => { const stop = bob.profiles.subscribe(alice.session!.pub, (p) => { if (p?.bio) { stop(); res(p.bio); } }); })) === 'present day, present time');

  console.log('\nFeed, likes, follows, replies');
  let bobDiscovery: Post[] = [];
  const stopDiscovery = bob.social.subscribeDiscovery((posts) => { bobDiscovery = posts; });
  const post = await alice.social.createPost('Let’s all love Lain.');
  await waitFor('bob’s discovery feed shows alice’s post', () => bobDiscovery.some((p) => p.ref === post.ref && p.author === alice.session!.pub));
  await bob.social.follow(alice.session!.pub);
  let bobFollowing: Post[] = [];
  const stopFollowing = bob.social.subscribeFollowingFeed((posts) => { bobFollowing = posts; });
  await waitFor('following feed includes alice', () => bobFollowing.some((p) => p.ref === post.ref));
  let likes = { count: 0, likedByMe: false, capped: false };
  const stopLikes = alice.social.subscribeLikes(post.ref, (s) => { likes = s; });
  await bob.social.like(post.ref);
  await waitFor('alice sees one verified like', () => likes.count === 1);
  await bob.social.unlike(post.ref);
  await waitFor('unlike drops the count', () => likes.count === 0);
  let followers: string[] = [];
  const stopFollowers = alice.social.subscribeFollowers(alice.session!.pub, (f) => { followers = f; });
  await waitFor('alice sees bob as a verified follower', () => followers.includes(bob.session!.pub));
  const reply = await bob.social.createPost('Present day. Present time.', { replyTo: post.ref });
  let replies: Post[] = [];
  const stopReplies = alice.social.subscribeReplies(post.ref, (r) => { replies = r; });
  await waitFor('replies thread shows bob’s reply', () => replies.some((r) => r.ref === reply.ref));
  await alice.social.editPost(post.id, 'Let’s all love Lain. (edited)');
  await waitFor('edits propagate', () => bobDiscovery.some((p) => p.ref === post.ref && p.editedAt));
  // A forged write into alice's space must be rejected by Gun's signature check.
  const forged = await new Promise<string | undefined>((res) => bob.ctx.gun.get(`~${alice.session!.pub}`).get('posts').get('forged').put(JSON.stringify({ id: 'forged', body: 'pwned', createdAt: Date.now() }), (ack: any) => res(ack.err)));
  check('writes into someone else’s space are rejected', Boolean(forged), forged);

  console.log('\nModeration');
  const modClient = Gun({ peers: [relay.url], localStorage: false, radisk: false, file: false, axe: false, multicast: false });
  await new Promise<void>((res, rej) => modClient.user().auth(moderation, (ack: any) => (ack.err ? rej(ack.err) : res())));
  modClient.user().get('moderation').get('posts').get(post.ref.replace(/\//g, '|')).put(JSON.stringify({ reason: 'test', at: Date.now() }));
  await waitFor('banned post disappears from feeds', () => !bobDiscovery.some((p) => p.ref === post.ref) && !bobFollowing.some((p) => p.ref === post.ref));
  check('relay policy has the ban', relay.policy.bannedPosts.has(post.ref.replace(/\//g, '|')));
  await bob.moderation.report({ kind: 'post', target: reply.ref, reason: 'spam', details: 'test report' });
  const reports: any[] = [];
  modClient.get(`lain-io/reports/${new Date().toISOString().slice(0, 10)}#`).map().once(async (value: string) => {
    try { const box = JSON.parse(value); reports.push(await SEA.decrypt(box.c, await SEA.secret(box.e, moderation))); } catch { /* ignore */ }
  });
  await waitFor('moderators can decrypt reports', () => reports.some((r) => r?.target === reply.ref && r.reason === 'spam'));
  await bob.safety.block(alice.session!.pub);
  check('blocked authors are hidden', !bob.social.isVisible({ ...reply, author: alice.session!.pub }));
  await bob.safety.unblock(alice.session!.pub);

  console.log('\nEncrypted settings sync');
  await alice.settings.update({ quietMode: true, lainStyle: 'wired' });
  await waitFor('settings sync to the second device', () => alice2.settings.get().quietMode && alice2.settings.get().lainStyle === 'wired');
  const rawSettings = await new Promise<string>((res) => bob.ctx.gun.get(`~${alice.session!.pub}`).get('private').get('settings').once((v: string) => res(v)));
  check('settings are ciphertext in the graph', typeof rawSettings === 'string' && rawSettings.startsWith('SEA{') && !rawSettings.includes('quietMode'), rawSettings?.slice(0, 40));

  console.log('\nEnd-to-end messages');
  const conv = await alice.messages.openDirect(bob.session!.pub);
  const sent = await alice.messages.send(conv.id, 'hi bob, are you in the wired?');
  check('message marked sent', sent.status === 'sent', sent.status);
  const bobConv = await waitFor('bob receives the conversation', () => bob.messages.listConversations().find((c) => c.id === conv.id));
  check('bob has an unread count', (bobConv?.unread ?? 0) >= 1);
  check('bob reads the text', bob.messages.listMessages(conv.id).some((m) => m.text === 'hi bob, are you in the wired?' && m.from === alice.session!.pub));
  await bob.messages.send(conv.id, 'always connected.');
  await waitFor('alice receives bob’s reply', () => alice.messages.listMessages(conv.id).some((m) => m.text === 'always connected.'));
  await waitFor('alice’s second device gets her sent message (self-sync)', () => alice2.messages.listMessages(conv.id).some((m) => m.text === 'hi bob, are you in the wired?'));
  await waitFor('alice’s second device gets bob’s reply', () => alice2.messages.listMessages(conv.id).some((m) => m.text === 'always connected.'));
  for (let i = 0; i < 3; i++) await alice.messages.send(conv.id, `ratchet ${i}`);
  await waitFor('ratcheted follow-ups arrive in order', () => {
    const texts = bob.messages.listMessages(conv.id).map((m) => m.text);
    return texts.includes('ratchet 0') && texts.includes('ratchet 2') && texts.indexOf('ratchet 0') < texts.indexOf('ratchet 2');
  });
  const mailSouls = Object.keys(bob.ctx.gun._.graph).filter((s) => s.startsWith('lain-io/mail/'));
  const anyPlain = mailSouls.some((s) => JSON.stringify(bob.ctx.gun._.graph[s]).includes('ratchet'));
  check('mail envelopes on the relay are ciphertext only', mailSouls.length > 0 && !anyPlain);
  const numbers = await alice.messages.safetyNumbers(bob.session!.pub);
  const numbersBob = await bob.messages.safetyNumbers(alice.session!.pub);
  check('safety numbers match on both sides', numbers.length === 1 && numbersBob.some((n) => n.safetyNumber === numbers[0].safetyNumber));

  console.log('\nGroups');
  const group = await alice.messages.createGroup('the wired', [bob.session!.pub]);
  await waitFor('bob joins the group', () => bob.messages.getConversation(group.id)?.name === 'the wired');
  await alice.messages.send(group.id, 'group hello');
  await waitFor('group message arrives', () => bob.messages.listMessages(group.id).some((m) => m.text === 'group hello'));

  console.log('\nLain data');
  await alice.lain.setConsent({ learnLocal: true });
  const fact = await alice.lain.addMemory({ text: 'Likes 90s synth music', source: 'explicit' });
  await waitFor('memory syncs (encrypted) to the second device', () => alice2.lain.listMemory().some((f) => f.id === fact.id));
  alice.lain.recordSignal({ kind: 'interest', data: 'synthwave' });
  check('signals are recorded locally once consented', alice.lain.listSignals().length === 1);
  check('signals never sync', alice2.lain.listSignals().length === 0);
  const ctxPrompt = await alice.lain.promptContext();
  check('prompt context includes facts', ctxPrompt.facts.includes('Likes 90s synth music'));

  console.log('\nPassword change and email recovery');
  await rejects('change password needs the current password', alice.changePassword('nope-nope-nope-1', 'brand-new-password-1'), InvalidCredentialsError);
  await alice.changePassword('wired-signal-0451', 'brand-new-password-1');
  const alice3 = await make();
  await rejects('old password stops working', alice3.signIn({ username: 'alice', password: 'wired-signal-0451' }), InvalidCredentialsError);
  await alice3.signIn({ username: 'alice', password: 'brand-new-password-1' });
  check('new password works', alice3.session?.pub === alice.session!.pub);
  const alice4 = await make();
  await rejects('a wrong recovery code is refused', alice4.recoverAccount({ username: 'alice', code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', newPassword: 'recovered-password-1' }));
  const recovered = await alice4.recoverAccount({ username: 'alice', code: aliceSignUp.recoveryCode!.toLowerCase().replace(/-/g, ' '), newPassword: 'recovered-password-1' });
  check('recovery with the emailed code signs in', recovered.session.pub === alice.session!.pub);
  check('recovery rotates the code and re-emails it', Boolean(recovered.recoveryCode) && recovered.recoveryCode !== aliceSignUp.recoveryCode && mails.at(-1)?.code === recovered.recoveryCode);
  check('recovery email is readable by the owner', (await alice4.getRecoveryEmail()) === 'alice@example.com');
  const alice5 = await make();
  await alice5.signIn({ username: 'alice', password: 'recovered-password-1' });
  check('the recovered password works on a new device', alice5.session?.pub === alice.session!.pub);

  console.log('\nMedia');
  const jpeg = (tag: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`${tag}-${Math.random()}`), Buffer.alloc(2048, 7)]));
  const mp4 = () => new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4096, 3)]));
  const fetchStatus = async (url: string) => (await fetch(url)).status;
  const imgA = jpeg('a');
  const refA = await alice.media.upload(imgA, { mime: 'image/jpeg', width: 640, height: 480, thumb: 'data:image/jpeg;base64,AAAA' });
  check('upload returns the content hash', /^[0-9a-f]{64}$/.test(refA.sha) && refA.size === imgA.length);
  const served = new Uint8Array(await (await fetch(alice.media.url(refA.sha))).arrayBuffer());
  check('the relay serves the same bytes', Buffer.from(served).equals(Buffer.from(imgA)));
  const partial = await fetch(alice.media.url(refA.sha), { headers: { range: 'bytes=0-9' } });
  check('range requests work (video seeking)', partial.status === 206 && (await partial.arrayBuffer()).byteLength === 10);
  await rejects('a file whose content doesn’t match its type is refused', alice.media.upload(jpeg('x'), { mime: 'image/png' }));
  await rejects('the scanner blocks known-bad files', alice.media.upload(jpeg('KNOWN-BAD'), { mime: 'image/jpeg' }));
  const adult = await alice.media.upload(jpeg('ADULT'), { mime: 'image/jpeg' });
  check('scanner-flagged adult files come back sensitive', adult.sensitive === true);
  const marked = await alice.media.upload(jpeg('self-marked'), { mime: 'image/jpeg', sensitive: true });
  check('uploaders can mark their own files sensitive', marked.sensitive === true);
  check('sensitive media is hidden by default in settings', alice.settings.get().showSensitiveMedia === false);
  const video = await alice.media.upload(mp4(), { mime: 'video/mp4', duration: 12 });
  check('videos upload', video.mime === 'video/mp4');

  const link = await alice.media.linkPreview('https://youtu.be/abc123');
  check('YouTube links get a preview from the relay', link.provider === 'youtube' && link.title === 'Serial Experiments' && Boolean(link.thumbnail));
  const popular = await alice.social.createPost('a meme', { media: [refA], link });
  const imgB = jpeg('b');
  const refB = await alice.media.upload(imgB, { mime: 'image/jpeg' });
  const ignored = await alice.social.createPost('nobody likes this', { media: [refB] });
  await rejects('a post can’t mix a video with photos', alice.social.createPost('x', { media: [refA, video] }));
  await waitFor('bob’s feed shows the post with its media and link', () => bobDiscovery.some((p) => p.ref === popular.ref && p.media?.[0]?.sha === refA.sha && p.link?.provider === 'youtube'));
  await bob.social.like(popular.ref);
  const repost = await bob.social.repost(popular.ref);
  let reposts = { count: 0, repostedByMe: false };
  const stopReposts = alice.social.subscribeReposts(popular.ref, (r) => { reposts = r; });
  await waitFor('alice sees one verified repost', () => reposts.count === 1);
  await waitFor('the repost shows in the feed', () => bobDiscovery.some((p) => p.ref === repost.ref && p.repostOf === popular.ref));
  check('ignored post exists', Boolean(ignored.media?.length));

  const info = await alice.media.info(refA.sha);
  check('media info shows a 30-day expiry', info.status === 'live' && Math.abs((info.expiresAt ?? 0) - (Date.now() + 30 * 86_400_000)) < 120_000);
  const later = Date.now() + 31 * 86_400_000;
  const retention = await relay.media.runRetention(later);
  check('after 30 days a liked + reposted file is kept forever', retention.kept.includes(refA.sha), retention);
  check('an unpopular file expires', retention.removed.includes(refB.sha), retention);
  check('expired files answer 410 Gone', (await fetchStatus(alice.media.url(refB.sha))) === 410);
  check('kept files stay available', (await alice.media.info(refA.sha)).kept === true && (await fetchStatus(alice.media.url(refA.sha))) === 200);

  const imgC = jpeg('c');
  const refC = await alice.media.upload(imgC, { mime: 'image/jpeg' });
  const temp = await alice.social.createPost('', { media: [refC] });
  await alice.social.deletePost(temp.id);
  await waitFor('deleting a post deletes its file', async () => (await fetchStatus(alice.media.url(refC.sha))) === 410);

  const refD = await alice.media.upload(jpeg('d'), { mime: 'image/jpeg' });
  const banned = await alice.social.createPost('caption stays', { media: [refD] });
  await waitFor('bob sees the post with its file', () => bobDiscovery.some((p) => p.ref === banned.ref && p.media?.length === 1));
  modClient.user().get('moderation').get('media').get(refD.sha).put(JSON.stringify({ reason: 'test', at: Date.now() }));
  await waitFor('a banned file disappears from posts, the text stays', () => bobDiscovery.some((p) => p.ref === banned.ref && !p.media));
  await waitFor('the relay takes the banned file down (451)', async () => (await fetch(`${relay.httpUrl}/lain/media/${refD.sha}`)).status === 451);

  const secret = new Uint8Array(Buffer.from('a private photo for bob only'));
  const priv = await alice.media.uploadPrivate(secret, 'image/jpeg');
  const stored = Buffer.from(await (await fetch(alice.media.url(priv.sha))).arrayBuffer());
  check('the relay stores DM attachments as ciphertext', !stored.includes(Buffer.from('private photo')));
  check('the recipient decrypts the attachment', Buffer.from(await bob.media.downloadPrivate(priv)).equals(Buffer.from(secret)));

  let seenAvatar = '';
  const stopAvatar = bob.profiles.subscribe(alice.session!.pub, (p) => { seenAvatar = p?.avatar ?? ''; });
  const avatar1 = await alice.media.setAvatar(jpeg('avatar1'), 'image/jpeg', (a) => alice.profiles.updateMine({ avatar: a }));
  await waitFor('avatar is stored as a media reference', () => seenAvatar === avatar1);
  check('avatar resolves to a URL', bob.media.resolveUri(avatar1).endsWith(avatar1.slice(6)));
  const avatar2 = await alice.media.setAvatar(jpeg('avatar2'), 'image/jpeg', (a) => alice.profiles.updateMine({ avatar: a }), avatar1);
  await waitFor('bob sees the new avatar', () => seenAvatar === avatar2);
  stopAvatar();
  await waitFor('replacing the avatar deletes the old file', async () => (await fetchStatus(bob.media.resolveUri(avatar1))) === 410);
  const avatarRetention = await relay.media.runRetention(Date.now() + 90 * 86_400_000);
  check('the current avatar never expires', !avatarRetention.removed.includes(avatar2.slice(6)) && (await fetchStatus(alice.media.resolveUri(avatar2))) === 200);
  const bobFile = await bob.media.upload(jpeg('bob'), { mime: 'image/jpeg' });
  stopReposts();

  console.log('\nAccount deletion');
  const bobPub = bob.session!.pub;
  await rejects('deletion needs the password', bob.deleteAccount('wrong-password-123'), InvalidCredentialsError);
  await bob.deleteAccount('navi-protocol-7xyz');
  check('signed out after deletion', bob.session === null);
  check('relay purged the account', relay.policy.purged.has(bobPub));
  await waitFor('username is free again', () => squatter.isUsernameAvailable('bob'));
  check('deleting the account deletes its files', (await fetchStatus(alice.media.url(bobFile.sha))) === 410);

  for (const stop of [stopDiscovery, stopFollowing, stopLikes, stopFollowers, stopReplies]) stop();
  console.log(`\n${passes} passed, ${failures} failed`);
  await relay.close().catch(() => {});
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
