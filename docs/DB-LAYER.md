# Lain IO database layer — GUI linking guide

Everything storage-related lives in [`src/db/`](../src/db/) and runs on GunDB. The GUI only talks to this layer, never to Gun directly. The layer is tested end to end against a real relay (`npm run test:db`, 88 checks) and bundles for Android. **It has not run on a phone yet**; see "First run on a device" below.

## 1. Setup checklist (once)

1. **Native rebuild.** New native modules: `react-native-quick-crypto` (+ `react-native-nitro-modules`, `react-native-quick-base64`), `expo-secure-store`, `expo-sqlite` with SQLCipher (`app.json` plugin). Expo Go can't run them.
   ```sh
   npx expo prebuild          # no --clean: android/ has hand edits (edge-to-edge) and is gitignored
   npx expo run:android       # and npx expo run:ios
   ```
   Running an older build gives `TurboModuleRegistry.getEnforcing(...): 'QuickBase64' could not be found` at startup. Rebuild and reinstall.
2. **Entry point.** `package.json` `main` is now [`index.js`](../index.js), which imports `src/db/polyfills` first. Keep it first: Gun SEA and libsignal read `globalThis.crypto` when they load.
3. **Run a relay** for development: `npm run relay` (port 8765). Generate service keys with `node relay/tools/keygen.js`. It prints the env lines for the app and the relay. Then fill `.env` (see [.env.example](../.env.example)):
   ```
   EXPO_PUBLIC_GUN_PEERS=ws://<your-LAN-IP>:8765/gun
   EXPO_PUBLIC_LAIN_SERVICE_URL=http://<your-LAN-IP>:8765
   EXPO_PUBLIC_LAIN_REGISTRAR_PUB=…  EXPO_PUBLIC_LAIN_MODERATION_PUB=…  EXPO_PUBLIC_LAIN_MODERATION_EPUB=…  EXPO_PUBLIC_LAIN_RELEASE_PUB=…
   ```
   Start the relay with `REGISTRAR_PAIR='…' MODERATION_PUB=… npm run relay`. Without SMTP it prints recovery codes to its console instead of emailing them. Without `REGISTRAR_PAIR` it runs a username dev mode that is **not** safe for production (claims can be backdated).
4. **Remove the legacy modules** once the screens are linked:
   - [src/gun.ts](../src/gun.ts): unsigned public feed that anyone can overwrite.
   - [src/identity.ts](../src/identity.ts): username kept only on the device.

## 2. Boot and session

```tsx
import { useLainDb, useSession } from './src/db/hooks';

export default function App() {
  const { ready, error } = useLainDb();          // starts the DB once, restores the saved session
  const session = useSession();                   // null = show onboarding
  if (error) return <Fatal message={error.message} />;
  if (!ready) return <Splash />;
  if (!session) return <Onboarding />;
  return <Main />;                                 // session.username, session.pub, session.deviceId
}
```

Outside React use `getDb()` from `src/db/native` (after `initDb()` resolved).

## 3. Accounts: username + password, email only for recovery

| Screen action | Call | Notes |
|---|---|---|
| Live username check | `db.isUsernameAvailable(name)` | Rule text: `USERNAME_RULE`; local check: `validateUsername(name)` → error string \| null |
| Password hint | `checkPassword(pw, username)` → error string \| null | Min 12 chars. The encrypted vault is public, so a weak password can be guessed offline |
| Create account | `db.signUp({ username, password, email? })` → `{ session, recoveryCode?, emailSent? }` | With email: **show `recoveryCode` once** ("we also emailed it"). Throws `UsernameTakenError` |
| Sign in | `db.signIn({ username, password })` | Throws `InvalidCredentialsError` |
| Forgot password | `db.recoverAccount({ username, code, newPassword })` → may return a new `recoveryCode` | Code from the email; spaces, dashes and case are ignored. Signs in on success |
| Change password | `db.changePassword(current, next)` | |
| Recovery email | `db.getRecoveryEmail()` · `db.setRecoveryEmail(email)` → `{ recoveryCode, emailSent }` · `db.removeRecoveryEmail()` | Setting a new email cancels the old code |
| Sign out | `db.signOut({ wipeLocal })` | `wipeLocal: true` also deletes this device's messages and Lain data (shared phones) |
| Delete account | `db.deleteAccount(password)` | Required by App Store / Play. Irreversible: wipes posts, likes, follows, settings, Lain data, devices, and frees the username |

Show a spinner on sign-up / sign-in / recovery: key stretching (PBKDF2, 600k rounds) takes a moment on the phone.

## 4. Screen-by-screen wiring (current [App.tsx](../App.tsx))

**Onboarding** (replaces the username-only form): tabs "Create account" / "Sign in", fields username + password (+ optional email on create), "Forgot password?" → username + code + new password.

**Feed ("The Wired")**
- List: `const { items: posts, loading } = useDiscoveryFeed()`. A "Following" tab uses `useFollowingFeed()`.
- Composer: `await db.social.createPost(draft)` (max `MAX_POST_LENGTH` = 2000). The post shows up in the live list by itself, so don't add it to local state.
- Card: `const author = useProfile(post.author)` → `author.name`, `@${author.username}`, `author.accent`, `author.verified` (false = possible impersonation; show a warning). Time comes from `post.createdAt`.
- ♡: `const { count, likedByMe, toggle } = useLikes(post.ref)`.
- ◌ replies: `useReplies(post.ref)`; reply with `createPost(text, { replyTo: post.ref })`.
- "···" menu: own post → `editPost(post.id, text)` / `deletePost(post.id)`. Others → `db.moderation.report({ kind: 'post', target: post.ref, reason })`, `db.safety.block(post.author)`.
- Media and links: see "Media" below. `PostCard` in App.tsx already renders `post.media`, `post.link` and reposts.
- ↗ Relay (repost): `const { count, repostedByMe, toggle } = useReposts(post.ref)`; a repost has `post.repostOf`, so show the original with `usePost(post.repostOf)`.
- The "2.4k online" counter has no data source (presence isn't built). Remove it or hide it.

**Friends / Connections**
- List: `const { items: pubs } = useFollowing()`, and one `useProfile(pub)` per row.
- Search: `const pub = await db.usernames.resolve(query)`, then a profile card with `db.social.follow(pub)` / `unfollow(pub)`.
- Followers: `useFollowers(session.pub)`.
- ↗ button: `const conv = await db.messages.openDirect(pub)`, then open the Messages screen with `conv.id`.

**Messages (new screen)**
- Inbox: `useConversations()` → `{ id, kind, members, name, lastMessagePreview, lastMessageAt, unread }`.
- Thread: `useMessages(conversationId)` → `ChatMessage[]` (oldest first). Send with `db.messages.send(id, text)`, call `db.messages.markRead(id)` on open, and offer `db.messages.resend(id, msgId)` when `status === 'failed'`.
- Groups: `createGroup(name, pubs)`, `updateGroup(id, { name, add, remove })` (owner only), `leaveGroup(id)`.
- Security: `useIdentityWarnings()` (banner: "@x's device keys changed"), `safetyNumbers(pub)` (verify screen), `trustNewIdentity(pub, deviceId)`.
- Devices (Settings): `myDevices()`, `revokeDevice(id)`.
- History lives only on the device (forward secrecy). A newly signed-in device sees messages from then on.

**Lain tab**
- Before chatting: `useLainConsent()`; `db.lain.setConsent({ learnLocal, trainRemote })` asks permission to learn.
- Chat: `useLainChat(chatId)` (use `newId()`-style ids, or one fixed `'main'` chat). Save each turn with `db.lain.addChatMessage(chatId, 'you' | 'lain', text)`. 👍/👎 → `rateMessage(chatId, msgId, 1 | -1 | null)`.
- Personalization for the model: `await db.lain.promptContext()` → `{ summary, facts }` to put in the system prompt. Native needs one change: today `systemInstruction` is hard-coded in `LainAiModule.kt`; make `loadModel(path, systemPrompt)` accept it.
- "What Lain knows" (Settings): `useLainMemory()`, `addMemory`, `updateMemory`, `deleteMemory`, `clearMemory`.
- Activity signals (local only, ignored without consent): `db.lain.recordSignal({ kind: 'like' | 'post' | …, data })`. Call it from like/post/follow handlers.
- Report a Lain reply: `db.moderation.report({ kind: 'lain-reply', target: msgId, reason })`.
- Models: `db.registry.listModels()` (signed list), `db.lain.setActiveModel({ version })`.

**Media (photos, videos, links)**: all wired in App.tsx; details in the plan, §A9.
- Pick + prepare (device only, from `src/db/native`): `const items = await pickPostMedia({ already })`. It returns up to 4 photos or 1 video, resized, with EXIF stripped and a tiny thumbnail. Upload: `const media = await uploadPrepared(db, items)`.
- Links: `const url = findLink(text); const link = url ? await db.media.linkPreview(url) : undefined`.
- Post: `db.social.createPost(text, { media, link })`. Text may be empty when there's media.
- Show: `db.media.url(m.sha)` (empty string = removed by moderation). Draw `m.thumb` blurred underneath. If the image fails to load (410), the file expired: keep the blurred thumb and say so.
- Sensitive: if `m.sensitive && !settings.showSensitiveMedia`, show only the blurred thumb with "tap to view". Uploaders mark their own files by setting `sensitive: true` on items before `uploadPrepared` (the 18+ chip in the composer).
- Avatars: `pickAvatar(db)` uploads a 512 px square and stores `media:<sha>` in the profile. Render any avatar with `db.media.resolveUri(profile.avatar)`; old data-URL avatars still work.
- DMs: `db.media.uploadPrivate(bytes, mime)` returns a `PrivateMediaRef` (it includes the key). Put it in the message; the receiver opens it with `openPrivateMedia(db, ref)` → local URI.
- Limits: `MEDIA_LIMITS`. Errors are `MediaError` with readable messages.

**Settings**
- `const [settings, update] = useSettings()`. `lainStyle`, `selectedModel`, `privatePresence`, `quietMode`, `showActivity`, `readReceipts`, `typingIndicators`, and `showSensitiveMedia` replace the `useState`s. Before enabling `showSensitiveMedia`, confirm the user is 18+. Write with `update({ quietMode: true })`. Settings sync encrypted to the user's other devices.
- Profile card / EDIT: `useProfile(session.pub)`, `db.profiles.updateMine({ name, bio, accent, avatar })`.
- "Blocked connections": `Object.keys(useSafety()?.blocked ?? {}).length`; `db.safety.unblock(pub)`; muted words: `db.safety.setMutedWords([...])`.
- "Sync & storage": configured relays + `settings.relays` (user-added; `update({ relays: [...] })` connects at once). Signed list: `db.registry.listRelays()`.
- Account: change password, recovery email, devices, sign out, **delete account**.

## 5. Rules of thumb

- Every `subscribe…` / hook is live and cleans up after itself. Lists arrive as whole arrays, newest first (threads oldest first).
- The layer filters moderation bans, blocks, and muted words before the GUI sees data. Don't filter again.
- Errors thrown by the layer have user-readable `message`s. Show them as-is.
- Writes are optimistic: Gun queues them while offline and syncs later. A write can take up to ~8 s to confirm on a slow network; don't block the UI on it except for auth.
- Refs: a post is addressed by `post.ref` (`<authorPub>/<postId>`), never by `id` alone.

## 6. What's where in Gun

| Data | Location | Protection |
|---|---|---|
| Profile | `~pub/profile` | signed |
| Password vault / recovery vault | `~pub/auth/vault`, `~pub/auth/recovery` | encrypted (PBKDF2 key / 160-bit code) |
| Posts, likes, reposts, follows | `~pub/posts/*`, `~pub/likes/*`, `~pub/reposts/*`, `~pub/follows/*` | signed |
| Photos, videos, avatars | **not in Gun**: `MediaRef` (hash + thumb) in the post; bytes at `{serviceUrl}/lain/media/<sha>` (IPFS pin) | content hash; 30-day TTL unless popular; DM files encrypted |
| Discovery, like/follower/reply pointers | `lain-io/index/<day>#`, `lain-io/likes/<h>#`, `lain-io/followers/<h>#`, `lain-io/replies/<h>#` | content-addressed; checked against signed data |
| Settings, blocks, recovery email | `~pub/private/*` | encrypted to the account key |
| Device keys | `~pub/devices/*`, `~pub/prekeys/*` | signed |
| Message envelopes | `lain-io/mail/<day>/<mailbox>#` | Signal protocol + sealed sender; rotating mailbox ids |
| Lain chats, memory, summary | `~pub/lain/*` | encrypted to the account key |
| Usernames | `~registrar/usernames/<name>` | written only by the registrar |
| Moderation list | `~moderation/moderation/{pubs,posts,media}` | written only by the moderation key |
| Model + relay registry | `~release/models/*`, `~release/relays/*` | written only by the release key |
| Ratchet state, decrypted messages, signals | device only (SQLCipher) | never synced |

## 7. First run on a device: what to watch

- **Crypto polyfill.** If `useLainDb()` errors with "WebCrypto is missing", `index.js` isn't the entry, or something imported Gun first.
- **Sign-up speed.** PBKDF2 600k should be well under a second with the native polyfill. If it's slow, lower `passwordIterations` in `initDb({ passwordIterations })` only after measuring. Existing vaults keep their own iteration count.
- **SQLCipher.** Check `PRAGMA cipher_version` returns a value (the plugin needs the prebuild).
- **Cleartext dev relay.** Android blocks `ws://` / `http://` in release builds. Use TLS (`wss://`, `https://`) for anything beyond local dev.
