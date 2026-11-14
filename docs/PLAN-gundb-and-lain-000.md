# Lain IO — Decentralized storage (GunDB) and lain-000 personalization plan

Status: draft · 2026-11-08 · owner: LainCorp · decisions Q1–Q5 recorded 2026-11-08 (see §D)

Two workstreams, one shared foundation:

- **A. Everything on GunDB.** Identity, profiles, feed, likes, follows, messages, settings, and Lain's memory all live in Gun, signed and (where private) encrypted with Gun SEA. No app backend owns user data.
- **B. lain-000.** A baseline Lain model shipped to every user. It adapts to each user in two layers: on-device memory (no training, always available) and an opt-in fine-tune pipeline that produces a personal adapter for that user.

B depends on A: the user profile that drives personalization is stored, encrypted, in the user's own Gun graph.

---

## 0. Where the code is today

| Area | Current state | Gap |
|---|---|---|
| Gun client | [src/gun.ts](../src/gun.ts): one `Gun({peers})` instance, public `lain-io/feed` node | Anyone can overwrite or delete any post. No persistence on React Native (no `localStorage`), so data is lost on restart. `followFeed`'s unsubscribe calls `.map().off()`, which removes **all** listeners on that node, not just this one. |
| Auth | Google / Apple OAuth in [App.tsx](../App.tsx) only flip `signedIn = true`; guest mode does too | No identity. The OAuth tokens are never checked and never tied to data. |
| Feed | Posts carry `author: 'You'`, `handle: '@wired_guest'`, `likes` as a number | No signing; `likes` as a shared counter will lose writes under Gun's conflict resolution. |
| Friends | Hard-coded list | No social graph. |
| Messages | None (the `↗` button does nothing) | Everything. |
| Settings | React `useState` only | Lost on restart; not synced. |
| LLM | [modules/lain-ai](../modules/lain-ai/): LiteRT-LM 0.16.1, Gemma 4 E2B (~2.6 GB), Android only, persona in a hard-coded `systemInstruction` | `lain-000` exists only as a radio button; chat always uses Gemma. Chat history is in memory only. |

---

## A. GunDB as the only storage

### A1. Foundation spikes (do these first; they can sink the plan)

1. **Persistence on React Native.** Gun's browser storage doesn't exist in RN. Build or adopt a RAD storage adapter (`gun/lib/radisk` + a `store` with `get/put/list`) backed by `expo-file-system` or SQLite (e.g. `op-sqlite`). Test: write 10k nodes, kill the app, relaunch offline, read them all back.
2. **SEA crypto on React Native.** SEA needs WebCrypto (`crypto.subtle`, ECDSA P-256, ECDH, AES-GCM, PBKDF2). Hermes doesn't provide it. Candidates: `react-native-quick-crypto` (native, has a `subtle` implementation) or a WebView-backed polyfill. Test: `SEA.pair()`, `sign/verify`, `secret`, `encrypt/decrypt` on a mid-range Android phone, and time each one (feed verification runs `verify` per post).
3. **Sync behavior on mobile.** Phones can't accept inbound connections, so they always sync through relays (WebSocket). Measure: cold start time to the first 50 feed items, reconnect after airplane mode, battery cost of keeping a socket open in the foreground. Decide on background sync (likely none at first; sync when the app opens).
4. **Gun package health.** `gun@0.2020.1241` gets little maintenance. Pin the version, vendor the files we depend on, and keep a thin wrapper (`src/gun/`) so the rest of the app never imports Gun directly.

Exit criterion: one screen that creates an identity, writes a signed + encrypted note, survives a restart, and syncs to a second device through a relay.

### A2. Identity and authentication — built (2026-11-08)

**Username + password; email only for recovery** (user decision). Implemented in [src/db/auth.ts](../src/db/auth.ts) and [src/db/usernames.ts](../src/db/usernames.ts); API in [DB-LAYER.md](DB-LAYER.md).

- The account is a random SEA key pair, never derived from the password. It's stored at `~pub/auth/vault`, encrypted with a PBKDF2-SHA256 (600k rounds) key from the password, so any device can sign in with username + password. Passwords need ≥ 12 characters, because the vault is public and could be guessed offline.
- **Usernames:** the main relay's registrar accepts the first signed claim per name and records it in its own Gun space; clients trust only that. A dev fallback (earliest signed claim) exists for local work only.
- **Email recovery:** a random 160-bit recovery code encrypts a second copy of the pair (`~pub/auth/recovery`). It's shown once in the app and emailed through the relay, which doesn't store it. Using it rotates the code. Anyone with inbox access can reset the password, which is the standard email-reset trade-off.
- **Changing the password** re-encrypts the vault but doesn't rotate the key pair (rotation = new account; out of scope for v1).
- **Devices:** each signed-in device makes its own Signal identity and publishes a device record in the account's signed space (A5). The QR device linking from the earlier draft isn't needed, since signing in is enough.
- **Session:** the pair is kept in the OS keystore (expo-secure-store) so the app reopens signed in.
- **Account deletion** is built: it wipes all of the user's nodes, revokes devices, releases the username, and has the relay stop storing and serving the account.
- Google / Apple sign-in were removed (Q1).

### A3. Graph schema

Rules: no arrays in Gun (use sets keyed by id), keep nodes flat, every user-owned write goes under `~<pub>` (signed automatically by SEA), and anything private is `SEA.encrypt`ed before `put`.

```
~<pub>                                  (user space, writable only by <pub>)
├─ profile        { name, handle, bio, avatar, accent, updatedAt }
├─ posts/<postId> { body, createdAt, replyTo?, media? }           public, signed
├─ likes/<postSoul> { at }  (or null to unlike)                   public, signed
├─ follows/<pub>  { at } | null                                    public, signed
├─ blocks/<pub>   SEA.encrypt({at}, ownPair)                       private
├─ settings       SEA.encrypt({...}, ownPair)                      private, synced across devices
├─ devices/<deviceId>  { identityKey, signedPreKey, sig, at }      device cert, signed by account pair
├─ prekeys/<deviceId>/<keyId>  one-time prekey (public)            consumed by senders (A5)
├─ groups/<gid>/members/<pub>  { role, at }                        group membership (A5)
├─ lain/
│   ├─ chats/<chatId>/<msgId>  SEA.encrypt(...)                    private
│   ├─ memory/<factId>         SEA.encrypt(fact, ownPair)          private
│   ├─ profile                 SEA.encrypt(summary, ownPair)       private
│   ├─ consent                 { learnLocal, trainRemote, at }     signed
│   └─ models/active           { version, adapterHash?, at }       signed
└─ keys/epub      (SEA publishes epub on user creation)

lain-io/                               (shared namespace, public)
├─ index/<yyyy-mm-dd>/<postSoul>  # content-hashed entries only (see A4)
├─ mail/<mailboxId>#<hash>             sealed DM envelopes (A5)
├─ reports#<hash>                      reports encrypted to the moderation key (A8)
├─ moderation/list                     signed by the LainCorp moderation key (A8)
├─ registry/models                     signed by the LainCorp release key
└─ relays                              signed by the LainCorp release key (bootstrap list)
```

Data-type rules:

- **Likes:** never a shared counter. Each user writes `~me/likes/<postSoul>`. The like count is computed client-side from known likers (people you follow plus people seen through the index), or a relay-side indexer publishes signed counts. Accept that the count is approximate. That's how decentralized systems behave.
- **Edits / deletes:** a post edit is a new `put` to the same node (last-write-wins by HAM timestamp). Delete = `put(null)` and is a tombstone. Relays and peers that already copied the post keep it. The UI and privacy policy must not promise "permanent deletion" for public content.
- **Settings shape:** `{ theme, lainStyle, selectedModel, privatePresence, quietMode, showActivity, relays[] (as an object), notifications }`, encrypted as one blob so they stay consistent.

### A4. Feed

- **Following feed (primary):** for each pub in `~me/follows`, subscribe to `~<pub>/posts` with `.map().on()`, check the signature (Gun does this for `~` spaces), merge, and sort by `createdAt`. Cap subscriptions (e.g. 200 follows open at once, older ones paged in).
- **Discovery feed ("The Wired"):** the public `lain-io/index` can be vandalized. Write only **content-addressed** entries: `lain-io/index/<day>#<hash>` where the key is the SHA-256 of the value `{ soul: '~pub/posts/id', pub, at }`. Gun rejects a write whose hash doesn't match its key, so nobody can overwrite or forge another user's entry. Readers then fetch the real post from the author's signed space.
- **Spam / moderation:** see A8. In short, the LainCorp moderation list is always applied and can't be turned off. On top of it come the user's own block/mute lists (encrypted), optional shared blocklists, and relay rate limits.
- **Paging:** bucket the index by day so a client reads only today's and yesterday's buckets on open.
- **Fix now:** replace `followFeed`'s `.map().off()` with per-listener `on(cb, {change:true})` + `event.off()` from the callback's `ev` argument.

### A5. Messages (E2E with forward secrecy)

**Decision Q5: the Signal protocol design, with Gun as the transport.** It's the most widely reviewed design for asynchronous E2E messaging, and it works when the recipient is offline, which matters here since phones are often offline. Gun only stores and relays ciphertext.

- **Protocol pieces:**
  - **X3DH** key agreement starts a session. Each device publishes an identity key, a signed prekey (rotated weekly), and a batch of one-time prekeys under `~<pub>/devices` and `~<pub>/prekeys`.
  - The **Double Ratchet** then gives forward secrecy (a stolen key can't read past messages) and post-compromise security (once the ratchet moves on, an attacker who stole a key can't read new messages).
  - **Per-device sessions** (like Signal's Sesame): a message to a user is encrypted once for each of their certified devices, and for each of the sender's other devices.
- **Library:** use an existing, reviewed implementation of the Signal protocol, not our own crypto. Primary candidate: `@privacyresearch/libsignal-protocol-typescript`, which runs on WebCrypto, so the same polyfill as A1.2 covers it. Alternative: bind Signal's official Rust `libsignal` as a native module (stronger, but more work). Decide in P0; the external audit in P8 covers our integration either way.
- **Groups:** Sender Keys, as Signal uses them. Each member sends a sender-key distribution message to every other member over the 1:1 sessions. Removing a member means everyone rotates their sender key. Revisit MLS (RFC 9420) if groups need to go past a few hundred members.
- **Transport over Gun (sealed sender, to cut metadata):**
  - Envelopes go to `lain-io/mail/<mailboxId>#<hash>`. They're content-addressed, so nobody can overwrite them.
  - `mailboxId = HMAC(mailboxKey, dayBucket)`, where `mailboxKey` comes out of the session. It changes daily, so a relay can't link a mailbox to a user over time.
  - The envelope hides who sent it: the sender's identity is inside the ciphertext.
  - Starting a new conversation: the first message goes to a **public** mailbox derived from the recipient's identity key, and every later message moves to the rotating mailbox.
  - A relay still sees an IP address writing to a mailbox; hiding that would take Tor-style routing, which is out of scope.
- **Prekey race:** two senders can grab the same one-time prekey in Gun. The recipient accepts the first and falls back to the signed prekey for the second (still secure). Devices top up their one-time prekeys when the count drops below 20.
- **Where state lives (an exception to "everything in Gun"):**
  - Ratchet state and decrypted message history stay **on the device only**, in an encrypted SQLite database whose key is in secure storage.
  - Syncing ratchet state through Gun would defeat forward secrecy, so it's excluded by design.
  - Gun holds only ciphertext envelopes. Clients delete them (tombstone) after delivery, and relays drop envelopes after 30 days.
- **History on a new device:** off by default (same as Signal). Optional "transfer history" sends it directly from the old device to the new one, encrypted during the QR linking step. There's no cloud backup at first: a backup encrypted with the account key would bring back exactly the risk forward secrecy removes.
- **Safety numbers:** each contact has a fingerprint screen and QR verification; the app warns when a contact's identity key changes.
- Read receipts and typing indicators: off by default; when on, they travel inside the ratchet like any other message.

### A6. Relays and operations

- **Main relay (LainCorp):** at least 3 nodes in different regions (`gun/lib/server` + RAD on disk, behind TLS). It's the moderated source of record: it enforces the moderation list (A8) on write and on read, handles account-deletion purges, and runs the report queue.
- **Community relays (decision Q2): allowed from day one.**
  - Anyone can run one with the open-source relay package, which has the moderation-list sync built in and turned on by default.
  - Relays listed in the app's signed `lain-io/relays` bootstrap list must agree to the relay policy: honor the moderation list and purge requests, and publish contact details. The main relay drops listed relays that break it.
  - Users can still add any unlisted relay by URL in Settings → Sync & storage (the existing row shows "GunDB · local peer").
  - Store compliance doesn't depend on any relay behaving well, because the **client** enforces moderation on everything it displays (A8).
- Relay policy: per-pub write rate limits, maximum node size, reject unsigned writes outside the `#` namespaces, drop expired mail envelopes.
- **Media (avatars, images):** Gun handles large binaries badly. Store blobs content-addressed (an IPFS pinning service or plain object storage keyed by SHA-256) and put only the hash in Gun. Private media is encrypted on the client before upload.
- Legal: encrypted personal data plus key deletion ("crypto-shredding") is the plan for erasure requests. Public posts and their tombstones are a known residue. Get this reviewed before EU launch.

### A8. Moderation and App Store / Play compliance

Apple (App Review Guideline 1.2, user-generated content) and Google Play (UGC policy, plus the AI-generated content policy) require, roughly: a way to filter objectionable content, in-app reporting with a timely response, user blocking, published contact info, and in-app account deletion. Since content can come in from any relay, the app enforces this itself:

- **Moderation list:** `lain-io/moderation/list`, signed by a LainCorp moderation key whose public key ships in the binary.
  - It lists banned post souls, banned pubs, and banned media hashes.
  - The client won't render anything on the list, from any relay, and users can't turn it off.
  - The main relay also refuses to store or serve listed content.
  - The list is delta-synced and cached offline; cap its size by expiring entries for data that has already been purged.
- **Filtering before display:** a lightweight on-device text classifier plus a keyword list hides likely-objectionable posts behind a tap-to-reveal. Users can add muted words.
- **Reporting:**
  - Every post, profile, message, and Lain reply has "Report". The report is encrypted to the moderation key and written to `lain-io/reports#<hash>`.
  - A DM report includes the reported messages as plaintext (the reporter's device has them decrypted) plus their envelope hashes. This is the only way moderation sees DM content, and the report screen says so.
  - The moderation team works from an internal console on the main relay, targeting **action within 24 hours**.
- **Blocking:** instant and local. Blocked users' content is hidden, and their sessions are refused.
- **Media:** see A9. Uploads go through the main relay, which scans them against known CSAM hashes before storing them. Banned hashes are refused, taken down, and hidden by the client.
- **AI output (Play AI policy):** "Report this reply" in the Lain chat feeds the same queue and the lain-000 eval set (B2).
- **Age:** an age gate at onboarding, and a 17+ / Mature store rating (UGC + AI chat). Below that age the app is off-limits.
- **Contact + policy:** support email, terms, and an objectionable-content policy, linked from Settings and from both store listings.

### A9. Images and videos — built (2026-11-09)

**Gun can't carry media.** Every relay copies every value, phones hold the graph in memory, and Gun has no streaming or byte ranges. A 5 MB photo in Gun would cost every viewer and every relay 5 MB+ of WebSocket traffic. So Gun stores only a **MediaRef** inside the signed post, and the bytes live in a blob store:

```
post (Gun, signed)  { body, media: [{ sha, mime, size, width, height, duration, thumb, cid, sensitive }], link }
bytes (main relay)  /lain/media/<sha>  → Kubo (IPFS) pin, CID = cid
```

- `sha` is the SHA-256 of the file. The relay recomputes it, so a ref can't point at a different file. Files are deduplicated: the same meme uploaded twice is stored once and owned by both uploaders.
- `thumb` is a ≈24 px JPEG data URL (≈1 KB). Viewers see it blurred while loading and after the file expires, so an ephemeral post never shows a broken image.
- `cid` is the IPFS address. Any IPFS node that pinned the file can still serve it after we drop it (see "Retention" for what that means).

**Upload path** (`POST /lain/media`, signed with the account key):
1. Device: photos are re-encoded as JPEG, longest edge ≤ 2048 px. Re-encoding drops EXIF, so **GPS never leaves the phone**. GIFs stay as-is to keep their animation. Videos are ≤ 60 s and ≤ 25 MB, picked at 720p on iOS.
2. Relay checks: signature and freshness, banned or purged account, banned hash, rate limit (60 per hour, 300 MB per day), size limit (6 MB photo, 25 MB video, 512 KB avatar), and real file type from magic bytes.
3. Relay sends the file to the scanner, `SCANNER_URL` (below).
4. The file is pinned in Kubo and recorded in the manifest (`data/media.json`: owners, upload times, kept, sensitive).

**Scanning**

| Check | Optional? | Effect |
|---|---|---|
| Known CSAM hash match (PhotoDNA, Thorn Safer, Cloudflare CSAM tool…) | **No.** Required on the main relay in production. Uploads are refused (503) when the scanner is missing, unless `ALLOW_UNSCANNED_MEDIA=1`. | Rejected (422); logged for reporting obligations |
| Adult content (nudity classifier) | **Yes**, in two ways: the scanner may implement it, and each **viewer** decides in Settings → "Show sensitive media" (off by default; turning it on asks for 18+ confirmation) | File is stored but flagged `sensitive`, and blurred with "tap to view" unless the viewer opted in |
| Uploader's own "18+" mark | Yes (composer chip) | Same as above |

The scanner contract is `POST <bytes>` → `{ ok, reason?, adult? }`. Store note: Apple expects adult UGC to be hidden by default. Keep the toggle off by default and, if App Review asks, move the opt-in to the website (Reddit / X pattern).

**Retention.** It runs hourly on the main relay; tests drive it with a fake clock.

| Kind | Lifetime |
|---|---|
| Post media | **30 days** (`MEDIA_TTL_DAYS`). At expiry the relay scores it, and a file scoring ≥ `MEDIA_KEEP_SCORE` (default 50) is **kept forever**. Otherwise it's unpinned, Kubo GC runs, and it answers **410 Gone**. |
| Avatars | While someone uses it as their avatar. Replacing it releases the old file. |
| DM attachments | 30 days, never kept. Encrypted on the device with AES-256-GCM; the key travels only inside the Signal message, so the relay stores ciphertext. |
| Deleted post / account | Released at once. Deleted when no other owner uses the file. |
| Banned hash | Taken down as soon as the moderation list changes; serves **451**. |

Score = verified likers + 2 × verified reposters of every post that used the file. Each like or repost is checked against the account's own signed space. Uploaders don't count, and neither do banned or purged accounts or accounts younger than `MEDIA_KEEP_MIN_ACCOUNT_AGE_DAYS` (7, from the registrar's claim date). This keeps throwaway accounts from rescuing their own uploads.

**IPFS doesn't expire anything.** "Ephemeral" means *we* unpin it. A community relay or user that pinned the CID keeps it. So the promise to users is "Lain IO stops hosting it after 30 days", never "it's gone from the internet". Moderation removal works the same way: unpin, block the hash at the relay, and hide it in every client.

**Long videos and external links:** post the link. If the text contains a URL, the composer asks the relay for a preview (`/lain/link-preview`). YouTube and PeerTube go through oEmbed: the relay makes the request, so the poster's IP isn't sent. The relay is SSRF-guarded: https only, no private addresses, no redirects. The preview is stored in the post, so viewers don't fetch it. Tapping opens the link.

**Reposts:** "↗ Relay" on a post creates a post with `repostOf`. It writes `~pub/reposts/<ref>` and announces in `lain-io/reposts/<sha(ref)>#`. Counts are verified like likes, and they feed the keep score.

**Known gaps:**
- Android videos are uploaded as picked, so their MP4 container can still carry a location tag until we add a transcoder.
- The `sensitive` flag rides in the uploader's post: a modified client can drop it. The relay serves `x-lain-sensitive` and `/info` for an authoritative check, and reports catch the rest.
- Community relays don't run the media service. Their users upload to the main relay, which is configured by `serviceUrl`.

### A7. Code layout — built as `src/db/` (see DB-LAYER.md); relay in `relay/`

```
src/gun/
  client.ts       Gun init, RAD storage adapter, crypto polyfill, relay list
  identity.ts     create/load/link/recover key pair, secure-store
  schema.ts       typed paths + zod-style validators for every node shape
  feed.ts         follows feed, discovery index, paging
  social.ts       follow, like, block, profile
  messages/       Signal protocol store (encrypted SQLite), sessions, sealed envelopes, mailboxes, sender-key groups
  moderation.ts   signed list sync, display filter, report submission
  settings.ts     encrypted settings blob + React hook
  hooks.ts        useGunNode / useGunSet with correct unsubscribe
```

Done (2026-11-10): `App.tsx` is split into `src/app` (shell, navigation), `src/features/<screen>` and `src/ui`; see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## B. lain-000 and personalization

### B1. Be clear about the decentralization trade-off

Fine-tuning a 2B-parameter model needs a GPU server. A phone can't do it in reasonable time today. Sending profile data to a pipeline is a **central component** in a decentralized app. The plan handles this by:

1. Making on-device personalization (B3) good enough that most users never need the pipeline.
2. Making the pipeline **opt-in**, separate from "learn from me locally", with data encrypted in transit, deleted after training, and never joined with other users' data.
3. Open-sourcing the pipeline and making its endpoint configurable, so anyone can run their own (self-hosted GPU, community operator).

### B2. Shipping lain-000 (the baseline)

> **Superseded (2026-11-13):** lain-000 will now be trained from scratch and released fully open. See `Lain AI/lain-000/PLAN.md`. Until it beats Gemma 4 E2B, the app keeps shipping Gemma 4 E2B. The distribution, registry and app-integration parts below still apply.

- **What it is:** Gemma 4 E2B (Apache-2.0) + a Lain persona fine-tune, converted to `.litertlm`, versioned `lain-000`, `lain-000.1`, …
- **Training data:** a curated, original persona dataset written in-house (voice, values, refusals, how to talk about memory and the Wired), plus general instruction data so it doesn't lose general skills. No copyrighted script text from the anime.
- **Training:** LoRA or full SFT on the base checkpoint (PEFT/TRL or Unsloth), then a small preference-tuning pass. Merge, convert to LiteRT-LM with the same mixed 2/4/8-bit quantization profile, and confirm on-device speed matches stock Gemma.
- **Eval gate before every release:** persona consistency, safety (self-harm, minors, sexual content, "are you a real person" honesty), general benchmarks vs. stock Gemma (must not drop much), on-device latency and memory on 3 reference phones.
- **Distribution:** hosted on a CDN / Hugging Face like Gemma today. `lain-io/registry/models` holds `{ version, url, sha256, size, minAppVersion, notes }`, signed by a LainCorp release key whose public key ships in the app. The client verifies the signature and the sha256 before loading.
- **App changes:** `GEMMA_MODEL_URL` → a registry lookup; the Settings radio picks among registry entries; the native `systemInstruction` becomes a parameter of `loadModel` so the persona and memory (B3) can be injected from JS; add streaming tokens (`sendMessageAsync` already streams; forward it as events).
- **iOS: required at launch (decision Q3).**
  - Add an iOS target to `modules/lain-ai` with the same JS API (`getModelStatus`, `downloadModel`, `loadModel`, `generate`, streaming, `startListening`, `speak`).
  - Runtime: use LiteRT-LM's iOS support if it covers this model and format (P0 spike). Otherwise, pick one runtime that runs on both platforms *and* loads LoRA (B4 option C), so we don't maintain two inference stacks.
  - Memory: a ~2.6 GB model is close to iOS's per-app limit on 6 GB phones. Request the `com.apple.developer.kernel.increased-memory-limit` entitlement, set a minimum device (e.g. 8 GB RAM), and show a clear "not supported on this device" state below it.
  - Speech: `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` and `AVSpeechSynthesizer`. Add microphone and speech-recognition usage strings to `app.json`.
  - Large downloads: use a background `URLSession` so the 2.6 GB download survives the app being suspended.

### B3. Layer 1: on-device personalization (no training)

This delivers most of "Lain adapts to you", ships first, and never leaves the device unencrypted.

**Signals collector** (`src/lain/signals.ts`): an append-only local event log, also mirrored encrypted to `~me/lain/…` for multi-device:

| Signal | Source | Kept as |
|---|---|---|
| Own posts and replies | Feed | text + topics |
| Likes, follows, mutes | Social | ids + topics of the target |
| Dwell time on posts | Feed scroll | topic weights only, not raw timings |
| Lain chats | Lain tab | full text (private) |
| Thumbs up/down, edits to Lain replies | Lain tab | preference pairs |
| Explicit interests / "tell Lain about you" | Settings | text |
| Own outgoing DMs | Messages | **off by default**; topics only, never the other person's words |

**Profile builder:** periodically (while charging, app open) the on-device model itself condenses new events into:
- `memory/<factId>`: short facts ("into 90s synth music", "studying for nursing exams"), each with source, confidence, and timestamp.
- `profile`: a ~300-token summary of tone, interests, and how the user likes to be answered.

**Use at chat time:** system prompt = lain-000 persona + profile summary + top-k relevant memories (retrieved by an on-device embedding model, e.g. a small LiteRT embedding model; small enough to brute-force cosine search without a vector DB).

**User control (required, not optional):** Settings → "What Lain knows": list, edit, and delete every fact; pause learning; wipe everything. Replace the current "Personalization is a future feature" note.

### B4. Layer 2: opt-in personal fine-tune pipeline

**Gate first: the adapter-delivery spike.** It's unverified whether LiteRT-LM 0.16.x can load a LoRA adapter at runtime on top of a `.litertlm` base. The plan forks on that answer:

| Option | How | Per-update download | Verdict |
|---|---|---|---|
| A. Runtime LoRA | Base stays; load a ~10–50 MB adapter | small | **Preferred** if supported |
| B. Server-side merge + re-convert | Pipeline outputs a full personal `.litertlm` | ~2.6 GB | Works without runtime support, but expensive in storage, bandwidth, and user patience; limit to rare updates |
| C. Different runtime with LoRA support | e.g. MediaPipe LLM Inference (GPU LoRA) or llama.cpp | small | Fallback; costs a native-module rewrite |

**Pipeline flow:**

```
device                                    pipeline (stateless GPU workers)
──────                                    ───────────────────────────────
1. consent.trainRemote == true
2. dataset builder (on device):
   - SFT pairs from Lain chats the user rated 👍 or edited
   - style samples from the user's own posts
   - preference pairs from 👍/👎
   - PII scrub + drop anything authored by other people
   - user can preview the dataset before upload
3. encrypt dataset to pipeline's epub,
   sign with user pair  ──── HTTPS ────▶ 4. verify signature, rate-limit per pub
                                         5. LoRA train on lain-000 vN (fixed recipe,
                                            small rank, few epochs, low LR)
                                         6. eval gate: safety suite + persona +
                                            regression vs. base; fail → reject
                                         7. encrypt adapter to user's epub,
                                            upload blob by sha256
                                         8. delete dataset + worker disk
9. ◀── job result: {adapterHash, baseVersion, evalReport}, signed by pipeline key
10. download, verify, decrypt, load; record in ~me/lain/models/active
11. one-tap rollback to plain lain-000
```

- **Cadence:** user-triggered or automatic when there are ≥ N new quality examples (e.g. 200) and ≥ 2 weeks since the last run.
- **Base upgrades:** when lain-000 v(N+1) ships, old adapters don't transfer. Re-train from the user's latest dataset (kept encrypted on their device or in their Gun space, never on the server).
- **Infra:** job queue + autoscaled GPU workers; no data store beyond the queue; logs exclude content. Later: confidential-computing VMs with attestation so users can verify the code that touches their data.
- **Cost: free (decision Q4).** A LoRA run on a 2B model with a few thousand examples should take minutes of single-GPU time; measure it in P0 and set the GPU budget from that × expected opt-in rate. Free and anonymous means fake accounts will try to farm GPU time, so:
  - **Device attestation:** a job needs a valid App Attest (iOS) / Play Integrity (Android) token, which the pipeline checks. This leans on Apple and Google, but only to gate GPU access, never data.
  - **Eligibility:** account ≥ 14 days old, a minimum number of quality examples, at most 1 run every 2 weeks per account and per attested device.
  - **Global budget:** a fair queue. When the month's GPU budget runs out, jobs wait for the next window instead of failing, and the app shows the expected wait.
  - **Self-hosting** stays available and unlimited for anyone who runs their own pipeline.

### B5. Safety and privacy for personalization

- A personal fine-tune can weaken safety training. A fixed training recipe, a hard eval gate, and rejection on regression are mandatory, not nice-to-haves.
- Lain must never imitate the user to third parties or post on their behalf.
- Profiling is personal data; inferred traits (health, sexuality, politics) are special-category data under GDPR. Default the profile builder to **not** store such inferences unless the user typed them into "tell Lain about you".
- Age: decide a minimum age; personalization for minors needs a separate legal review.
- Copy update: "Your conversation stays here" stays true for Layer 1; Layer 2 consent screens state exactly what leaves the device, where it goes, and when it's deleted.

---

## C. Phased roadmap

| Phase | Scope | Exit criterion |
|---|---|---|
| **P0 Spikes** (≈2–3 wks) | A1.1–A1.3 on Android **and iOS**; B4 adapter-delivery spike; LiteRT-LM iOS check; Signal library choice (TS vs. native libsignal) on Hermes; one lain-000 persona training run; GPU cost per fine-tune run | Go/no-go on Gun-in-RN; one inference runtime picked for both platforms; option A/B/C picked |
| **P1 Identity + storage** | `src/gun/` wrapper, RAD adapter, SEA polyfill, remove Google/Apple sign-in, onboarding with keys + recovery phrase + age gate, device certificates, encrypted settings, account deletion, App.tsx split | Settings persist and sync across an Android and an iOS device |
| **P2 Social + moderation** | Profiles, signed posts, follows, likes, discovery index, block/mute, moderation list, report flow, moderation console, content filter | Real feed between test accounts; vandalism test passes; a report is actioned end to end. **Store-submittable from here on.** |
| **P3 Messages** | X3DH + Double Ratchet 1:1, per-device fan-out, sealed envelopes + rotating mailboxes, safety numbers, then Sender Key groups, history transfer on device link | Two devices chat E2E through relays; relay sees only ciphertext and rotating mailbox ids; a stolen current key can't decrypt old messages (test) |
| **P4 Relays + media** | 3 main relay nodes, community relay package with moderation sync, signed relay list + policy, media service on Kubo/IPFS with CSAM scanning + optional adult flagging + 30-day/keep-popular retention (**built**, A9; needs a production scanner contract), user-added relays | Load test: 10k users' worth of nodes; a community relay honors a ban and a purge in under 1 h |
| **P5 lain-000 release** | Persona model, registry, signed download, configurable system prompt, streaming, **iOS native module**, "Report this reply" | lain-000 is the default on both platforms; eval report published |
| **P6 On-device memory** | Signals, profile builder, embeddings + retrieval, "What Lain knows" UI | Blind test: users prefer personalized replies |
| **P7 Fine-tune pipeline (free)** | Dataset builder, consent flow, pipeline service, attestation + eligibility + fair queue, eval gate, adapter delivery, rollback | Opt-in beta with 50 users; zero eval-gate escapes; spend within budget |
| **P8 Hardening** | External audit of the SEA and Signal-protocol integration, multi-device edge cases, GDPR review, store review dry runs | Audit sign-off; both stores approve |

P1–P4 (workstream A) and P5 (lain-000 + iOS module) can run in parallel with separate people. P6 needs P1. P7 needs P6 and the P0 adapter result. Don't submit to the stores before P2 is done: without moderation, App Review rejects UGC apps.

---

## D. Decisions (2026-11-08)

| # | Question | Decision | Where it lands |
|---|---|---|---|
| Q1 | Google / Apple sign-in | **Dropped.** Recovery = phrase + device linking | A2, P1 |
| Q2 | Relays | **Community relays allowed**; the LainCorp main relay moderates, and the client enforces the signed moderation list for store compliance | A6, A8, P2, P4 |
| Q3 | iOS on-device Lain at launch | **Yes** | B2, P0, P5 |
| Q4 | Fine-tune pricing | **Free**, protected by attestation, eligibility rules, and a fair-queue budget | B4, P7 |
| Q6 | Media storage | **Not in Gun.** Hash + thumbnail in Gun; bytes on IPFS (Kubo) pinned by the main relay. 30-day ephemeral; popular (likes + reposts) kept forever. Long video = YouTube/PeerTube links. Adult-content blur is a viewer setting (off by default); CSAM scanning is mandatory | A9, P4 |
| Q5 | DM secrecy | **Signal protocol** (X3DH + Double Ratchet, sealed sender, Sender Keys for groups) over Gun | A5, P3 |

## E. Top risks

1. Gun on React Native (storage + WebCrypto) performs poorly on low-end phones → mitigated by P0 spike and the `src/gun/` wrapper.
2. No runtime LoRA in LiteRT-LM → option B/C; price the cost before committing to P7.
3. Discovery-feed spam → content-addressed index + blocklists + relay rate limits from P2, not later.
4. Unrecoverable accounts from lost keys. With Google/Apple gone there's no cloud fallback → strong recovery phrase UX, nagging until it's saved, device linking.
5. Regulatory exposure from profiling → opt-in, transparency UI, special-category exclusion, legal review before P6 ships.
6. Store rejection → moderation (A8) ships in P2, before any submission; 24 h report SLA staffed from day one.
7. Free GPU abuse → attestation + eligibility + budget queue (B4).
8. iOS memory limits for a 2.6 GB model → entitlement, device floor, early device testing in P0.
9. Signal-protocol integration mistakes → reviewed library only, no custom crypto, external audit in P8.
10. Media hosting liability: CSAM scanning must be live before public uploads (the relay refuses uploads in production without it). Storage cost of "kept forever" grows; watch the keep rate and raise `MEDIA_KEEP_SCORE` if needed.
