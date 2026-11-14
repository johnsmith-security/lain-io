# Lain IO on Cloudflare: GunDB relay and IPFS on lain.コム, all as code

Status: the Gun relay is **live on Cloudflare at `wss://relay.lain.xn--tckwe/gun`** (2026-11-13). It is paired with the minikube relay, and the pairing and moderation tests pass against it (§8). IPFS, Terraform and CI are not built yet.

Scope decisions (2026-11-13): **no CSAM scanning and no recovery email for now.** **Moderation has a single source of truth on Cloudflare** (§2a).

Earlier text: Today the main relay (`relay/server.js` + `relay/media.js`) and Kubo run on minikube (`/Users/johnsmith/LainCorp/Infrastructure`). This plan moves the **LainCorp main relay** and **media/IPFS** onto Cloudflare under `lain.コム`, with every resource defined in code.

It does not change the product rules in [PLAN-gundb-and-lain-000.md](PLAN-gundb-and-lain-000.md):
- Gun stays the only database.
- The Cloudflare relay is one peer among many, not a central backend. It stores signed or encrypted graph data, and community relays still work.
- Moderation and media rules (A6, A8, A9) carry over unchanged.

## 1. What runs where

The domain is `lain.コム`. Its ASCII (punycode) form is **`lain.xn--tckwe`**. Every config file, URL, certificate and email header uses the punycode form. Only the UI shows `lain.コム`.

| Hostname | Cloudflare product | Replaces |
|---|---|---|
| `lain.コム` (apex) | Worker with static assets: landing, support, terms, privacy, relay policy, objectionable-content policy (A8 requires published contact and policy pages) | nothing yet |
| `relay.lain.コム` | Worker `lain-relay`: `/gun` (WebSocket) goes to the **GunRelay Durable Object**; `/lain/*` runs the services | `relay/server.js` + `media.js` |
| `ipfs.lain.コム` | Worker `lain-ipfs`: an IPFS **trustless gateway** reading blocks from R2 | Kubo's gateway and pins |
| `staging.relay.…`, `staging.ipfs.…` | Same Workers, `staging` environment, separate buckets and databases | minikube |

```
phone ──wss──▶ relay.lain.xn--tckwe/gun ──▶ Worker ──▶ GunRelay DO (SQLite graph) ◀──wss──▶ community relays
      ──https─▶ relay…/lain/media ──▶ Worker ──▶ scanner ──▶ R2 lain-media (by sha) + R2 lain-ipfs (blocks by CID)
                                               └──────────▶ D1 lain-media-manifest (owners, TTL, kept, sensitive)
any IPFS client ─https─▶ ipfs.lain.xn--tckwe/ipfs/<cid> ──▶ Worker ──▶ R2 lain-ipfs
Cron (hourly) ──▶ retention, moderation-list sync, IPNI announce, backups to R2
```

### Storage map

| Data | Store | Why |
|---|---|---|
| Gun graph | SQLite-backed Durable Object storage (table `node(soul, key, val, state)`) | Strongly consistent, co-located with the WebSocket fan-out, with 30-day point-in-time recovery |
| Username registrar | Its own singleton `Registrar` DO | One writer gives the first-come ordering `REGISTRAR_PAIR` needs today |
| Media bytes, by sha256 | R2 `lain-media` | Range reads; no egress fees |
| IPFS blocks, by CID | R2 `lain-ipfs` | Feeds the trustless gateway |
| Media manifest (`data/media.json` today) | D1 `lain-media` | Queried by the retention job |
| Backups, Terraform state | R2 `lain-backups`, `lain-tfstate` | Both stay on Cloudflare |

## 2. GunDB on Durable Objects

**Approach: a native Gun wire-protocol relay, not `gun` running inside a Worker.**

The `gun` npm server depends on Node `http`/`ws`, RAD on a filesystem, and a long-lived in-memory graph. Durable Objects hibernate and lose memory, so that model doesn't fit. A relay only has to speak Gun's DAM message format:

- `get`: `{"#":id, get:{"#":soul, ".":key?}}` is answered with `{"@":id, put:{soul:{…, _:{"#":soul, ">":{key:state}}}}}`.
- `put`: `{"#":id, put:{soul:node}}` is merged per key using HAM (higher state wins; equal states break ties by lexical value; states more than a drift window in the future are deferred), stored, acknowledged with `{"@":id, ok:1}`, and fanned out to subscribers of that soul.
- Dedup on `#` ids, and handle `dam`/`?` peer handshakes so the relay can peer with other Gun relays.

This takes a few hundred lines in `relay-cf/src/gun/`. The **enforcement layer from `server.js` (lines 44–135) is ported as-is**: banned or purged pubs, banned posts stripped on the way out, mail retention, the per-connection mail token bucket, `MAX_VALUE_BYTES`, and SEA signature checks on `~pub` souls.

**WebSockets:** use the Hibernation API (`ctx.acceptWebSocket`), so idle phones cost nothing. Subscriptions (socket → souls) are stored in each socket's attachment so they survive hibernation.

**Scaling, in two steps:**
1. **Launch:** one `GunRelay` DO instance (`idFromName("main")`). Measure CPU and messages per second against the 110-check e2e test plus a load script.
2. **Sharded, once one instance passes about 60% CPU:**
   - The Worker hashes each connection to one of N **gateway DOs**, which hold sockets and subscriptions.
   - The graph lives in **shard DOs** keyed by `hash(soul) mod M`.
   - Gateways forward `get`/`put` to the owning shard. Shards push changes to the gateways subscribed to that soul.
   - The client protocol doesn't change.

**Peering:** the DO keeps outbound WebSockets to `RELAY_PEERS` (community relays and the old k8s relay during migration), so the network stays a mesh.

**Services:** everything under `/lain/*` moves into the Worker:
- **Registrar:** `claim`/`release` go to the `Registrar` DO. `REGISTRAR_PAIR` is a Worker secret, and SEA signing uses WebCrypto ECDSA P-256 (proven in spike S2).
- **Recovery mail:** out of scope for now (decided 2026-11-13).
- **Account purge, health, link preview:** link preview keeps https-only and manual redirects, and Workers can't reach private networks anyway.

## 2a. Moderation: one source of truth on Cloudflare (built 2026-11-13)

Play and App Store rules need consistent takedowns, wherever content comes from. The moderation list is the signed `~MOD/moderation/{pubs,posts,media}` space described in A8, and **its home is the Cloudflare relay**.

- **Moderators write there.** Run `RELAY=wss://relay.lain.xn--tckwe/gun node relay/tools/admin.js ban-user …`.
- **The Cloudflare relay enforces it** on every read and write, with the same rules as `server.js`. It also serves the list at `GET /lain/moderation`, edge-cached for 30 s, as raw signed Gun nodes.
- **Apps pull it** from `EXPO_PUBLIC_LAIN_MODERATION_URL` at start and every 5 minutes, on top of the live Gun subscription (`src/db/moderation.ts` `pull()`). The nodes go through Gun's SEA checks, so only values signed by the moderation key apply. The endpoint can deliver bans but can't forge or alter them. Offline, the cached list stays in force.
- **Self-hosted and community relays pull it** from `MODERATION_URL` every minute (`relay/server.js`). They also receive bans live when peered with Cloudflare. Either way, every relay enforces the same list.

Tested:
- A ban made on Cloudflare stops the banned account's data on both the Cloudflare and the self-hosted relay.
- An offline peer applies a genuine pulled ban.
- A replayed signature or an altered ban is ignored.

## 2b. Storage rule: posts expire monthly; the top posts are kept forever (built and live 2026-11-13)

**Rule:** posts last one month. Only the most liked and reposted posts are kept indefinitely, and the keep decision is recorded **in the moderation layer**. The same rule already applies to media (A9), so a kept post keeps its media and an expired post releases it.

**How it works:**
1. **Score:** the Cloudflare relay scores each post with the A9 formula: verified likers + 2 × verified reposters. It reads the signed `~pub/likes/*` and `~pub/reposts/*` rows already in its graph. The same exclusions apply: no self-likes, no banned or purged accounts, no accounts younger than 7 days.
2. **Keep list in the moderation layer:** when a post reaches the keep threshold, it gets a signed entry in `~KEEP/keep/<pub|postId>` `{score, at}`. `/lain/moderation` serves this next to the ban list. Apps and relays pull it and verify it exactly like bans (§2a).
   - The signing key is a separate **archivist** key. It is a Worker secret, and only its pub ships in the app.
   - The moderation private key stays offline, so a compromised Worker can't ban anyone. It could at most mark posts as kept.
   - A moderator can still ban a kept post. Bans always win.
3. **Expiry:** a Durable Object alarm runs hourly on the Cloudflare relay.
   - It deletes `~pub/posts/<id>` rows older than 30 days that aren't on the keep list.
   - It also deletes their likes, reposts, replies' links and `lain-io/index/<day>` buckets older than 30 days.
   - After that it no longer stores or serves them. Expired puts are refused, so peers can't re-seed them.
4. **Everyone else follows the same list:**
   - Apps hide posts older than 30 days that aren't on the keep list, whichever relay they came from, and drop them from their local cache.
   - Self-hosted and community relays prune with the same rule. They run the same code in `relay/server.js`.
   - The result is that the rule holds across the network, not just on Cloudflare.
5. **Promise to users:** wording as in A9. "Lain IO keeps posts for a month, and the most liked and reposted forever." Never "deleted from the internet": a peer that copied a post can keep its copy.

**Decided (2026-11-13):**
- **Window:** rolling 30 days from each post's creation.
- **Ranking:** **top posts**. When a post turns 30 days old it is ranked against every post decided in the last 30 days, and the top `KEEP_TOP_PERCENT` = **1 %** are kept. A post also needs a score of at least `KEEP_MIN_SCORE` = **5**, so a quiet month doesn't keep posts with one like. Keeping is by ranking only, never by hand.
- **Day 0 = 2026-11-13** (`RETENTION_EPOCH`): posts made before that count as made on that day. The first expiries are on 2026-12-13.

**Built:**
- **Relay:** `GunRelay` tracks when it first saw each post and account. An hourly alarm runs `runRetention()`. `GET /lain/retention` shows status, and `POST /lain/retention/run` runs it on demand (needs the peer token).
- **Keys:** the archivist key is in `relay/keys/archivist.json` and is the Worker secret `ARCHIVIST_PAIR`.
- **Keep list:** it lives in `~ARCHIVIST/keep/<pub|id>` and is served with `/lain/moderation`.
- **App:** `Moderation.isExpired()` / `isKept()` and `Social.isVisible()` apply the rule.
- **Self-hosted relays:** `relay/server.js` follows the keep list and refuses or strips expired posts.
- **Migration:** `scripts/seed-graph.ts` copied minikube's graph to Cloudflare: 3 accounts, 7 posts, all signatures verified.

**Tests:**
- `test/retention.e2e.ts`: 24/24, with a 26-second "month". Covers ranking, deletes, refused re-sends, the archivist signature verified by Gun, a forged keep entry, and bans winning over keeps.
- The app's `npm run test:db`: 117/117, including the retention checks.

## 3. IPFS on Cloudflare

**What Cloudflare can't do:** there's no way to run a full IPFS peer (DHT, Bitswap on port 4001) natively. Workers have no inbound TCP/UDP. Cloudflare's Web3 IPFS gateway is read-only, and on non-Enterprise plans it's DNSLink-only, so it can't pin or serve arbitrary CIDs. Cloudflare's public `cloudflare-ipfs.com` was retired in 2024.

**So we serve IPFS over HTTP, which is still verifiable and interoperable:**

1. **Content addressing at upload.** `POST /lain/media`:
   - Hashes the bytes (sha256, as today).
   - Builds the UnixFS DAG in the Worker with `ipfs-unixfs-importer`, using **the same parameters Kubo used**: CIDv0/dag-pb, 256 KiB chunks, balanced layout. Existing `cid`s in posts then stay valid (spike S3).
   - Writes the blocks to R2 `lain-ipfs` as `blocks/<cid>` and the whole file to `lain-media/<sha>`.
2. **Trustless gateway** (`ipfs.lain.xn--tckwe`) implements the IPFS HTTP gateway spec for `/ipfs/<cid>`:
   - `?format=raw` (single block).
   - `?format=car` (whole DAG).
   - Plain deserialized responses with Range support for browsers.
   
   Clients verify every block against its CID, so trust in Cloudflare isn't required. Helia and recent Kubo can fetch from trustless HTTP gateways directly.
3. **Discoverability:** an hourly Cron Worker publishes IPNI advertisements (stored in R2 and served over HTTPS), listing `ipfs.lain.xn--tckwe` as an HTTP provider, and announces them to `cid.contact`. Then ipfs.io, dweb.link and Helia can find our CIDs without a libp2p node (spike S5).
4. **Pin = an object exists in R2. Unpin = delete it.** Retention (A9) becomes:
   - The hourly Cron reads D1.
   - Expired, unkept media gets its `lain-media` and `lain-ipfs` objects deleted, and IPNI gets a removal ad.
   - The gateway answers **410**. Banned hashes answer **451**.
   
   The promise stays the same: "Lain IO stops hosting it", never "it's gone from the internet".
5. **Optional and not required:** a Cloudflare Container running Kubo for Bitswap peers. Its disk is not durable storage, so R2 stays the source of truth. Add it only if Bitswap reach turns out to matter.

**Scanning:** out of scope for now (decided 2026-11-13). The upload Worker keeps a hook where a synchronous scanner can be added later. Until one is added, the Worker runs the way `ALLOW_UNSCANNED_MEDIA=1` does today. Takedowns go through the moderation list (§2a) only.

## 4. Everything as code

A new folder `Infrastructure/cloudflare/` sits next to the k8s manifests:

```
Infrastructure/cloudflare/
  terraform/                  OpenTofu + cloudflare provider v5
    bootstrap/                once, by hand: R2 bucket lain-tfstate + scoped API tokens
    modules/zone/             DNS, TLS, HSTS, WebSockets on, CAA, email DNS, WAF, rate limits, CSAM tool
    modules/storage/          R2 buckets (+ lifecycle), D1 databases
    modules/workers/          custom domains, cron triggers, Worker secrets wiring (names only)
    envs/staging/  envs/production/
  workers/                    pnpm workspace, TypeScript
    lain-relay/   wrangler.jsonc   Worker + GunRelay, Registrar DOs (DO migrations live here)
    lain-ipfs/    wrangler.jsonc   gateway + IPNI announcer
    lain-site/    wrangler.jsonc   apex static assets
    shared/                        enforcement policy, SEA helpers, CID helpers
  scripts/                    migrate-radata.ts, migrate-media.ts, load-test.ts
.github/workflows/cloudflare.yml
```

**Who owns what:**
- **Terraform** owns everything account- and zone-level: the zone (adopted with `import`), DNS, security settings, R2, D1, custom domains, cron triggers, and API tokens.
- **Wrangler** owns Worker code, bindings and **Durable Object migrations**, which Terraform handles poorly.
- Bindings use the names and IDs that Terraform outputs. CI writes them into `wrangler.jsonc` with `wrangler.jsonc.tmpl` + `tofu output -json`.

**State and secrets:**
- Terraform state uses the S3 backend on R2 `lain-tfstate`, with OpenTofu state encryption turned on.
- Secrets (`REGISTRAR_PAIR`, scanner key, mail key) **never enter Terraform state**. CI pushes them with `wrangler secret put` from GitHub environment secrets, or uses Cloudflare Secrets Store.
- The moderation and release private keys stay offline as they are today (`relay/keys`). The relay only needs the public keys.

**CI (GitHub Actions):**
- **Pull request:** `tofu fmt/validate/plan` (posted to the PR), `tsc`, unit tests for the HAM merge, enforcement and CID builder, then `wrangler deploy --dry-run`.
- **Merge to main:**
  1. Apply to staging and deploy the Workers to staging.
  2. Run `npm run test:db` with `EXPO_PUBLIC_GUN_PEERS=wss://staging.relay.lain.xn--tckwe/gun`. All 110 DB checks and 88 media checks must pass.
  3. A manual approval gate, then production.
- Rollback with `wrangler rollback` (code). DO SQLite point-in-time recovery and the R2 backups cover data.

**App changes (small):** `.env.production` gets these values. `src/db/config.ts` already reads them, so no code changes there.
- `EXPO_PUBLIC_GUN_PEERS=wss://relay.lain.xn--tckwe/gun`
- `EXPO_PUBLIC_LAIN_SERVICE_URL=https://relay.lain.xn--tckwe`

The media resolver also falls back to `https://ipfs.lain.xn--tckwe/ipfs/<cid>` when `/lain/media/<sha>` is gone.

## 5. Phases

| Phase | Work | Done when |
|---|---|---|
| **P0: Spikes** (any one can change the plan) | **S1** DO Gun relay pairs with the self-hosted relay ✅ (local workerd) · **S2** SEA write rules in Workers ✅ · **S3** UnixFS CIDs built in the Worker match Kubo's for the existing pins · ~~S4 scanner~~ (out of scope) · **S5** IPNI HTTP-provider announce shows our CIDs on cid.contact | S1/S2 on real Cloudflare, S3, S5 |
| **P1: Foundation** | bootstrap; zone import; DNS, TLS and WAF; R2 and D1; staging environment; CI | `tofu plan` is clean on both environments |
| **P2: Relay** | `lain-relay` with GunRelay, Registrar, services and enforcement; peers with the k8s relay | e2e green on staging; a phone on staging works for a week |
| **P2b: Post retention** (§2b) | archivist key + `~KEEP/keep` list in `/lain/moderation`; scoring + hourly expiry alarm in GunRelay; same rule in `relay/server.js`; app hides and prunes expired posts | e2e with a fake clock: unkept post gone everywhere after 30 days, kept post stays, banned kept post still hidden |
| **P3: Media + IPFS** | upload, R2, CID, D1 manifest, retention cron, `lain-ipfs` gateway, IPNI | 88/88 media checks; a CID fetched through ipfs.io resolves from our gateway |
| **P4: Site** | apex pages for support, terms, privacy and policies; store-listing links | Linked from Settings |
| **P5: Migration** | `migrate-radata.ts` (RAD → put stream into the DO), `migrate-media.ts` (media.json → D1, `ipfs dag export` → R2), then dual-run with the app peering both relays, then switch | Counts match; k8s relay demoted to a community peer |
| **P6: Hardening** | sharded DOs if needed; nightly DO-to-R2 export; Logpush or Workers Analytics dashboards; alerts on health, mail drops and scanner errors | Load test at 10× launch traffic |

## 6. Costs (order of magnitude, check Cloudflare pricing before committing)

- Workers Paid at $5 per month covers the base allowance for Workers, Durable Objects and D1.
- R2 costs about $0.015 per GB-month with no egress fees. That matters most here, since media and gateway traffic is mostly egress.
- An Enterprise plan isn't needed, because the design avoids the Web3 gateway product.

## 7a. Before production

- Set the `RELAY_PEER_TOKEN` secret, and append `&token=…` to `RELAY_PEERS`. Without the token, anyone who connects with `?peer=relay` receives every put and has gets forwarded to them.
- Move the registrar to the `Registrar` DO. Until then, `EXPO_PUBLIC_LAIN_SERVICE_URL` stays on the self-hosted relay, and peering keeps the usernames in sync.

## 7. Risks

1. **The custom Gun relay drifting from gun.js behaviour.** Mitigation: the e2e suite is the contract, and fuzz-test HAM against `gun` itself in CI.
2. **One DO's throughput** (it's single-threaded). Mitigation: the sharding design is ready, and the load test runs in P2, not later.
3. **Single provider.** Everything on Cloudflare is the opposite of the decentralization goal for the *infrastructure*, though not for the data. Mitigation:
   - Community relays and peering.
   - The open-source relay package stays runnable on Docker/k8s.
   - CIDs are portable, so anyone can re-pin from the gateway.
4. **CID parity** with existing posts (S3). If it fails, keep the old CIDs readable through a mapping table in D1.
5. **IDN quirks:** use punycode everywhere outside the UI. Test Android `OkHttp` and the iOS ATS.

## 8. Built so far (2026-11-13)

**Code** is in `Infrastructure/cloudflare/workers/lain-relay`:
- `src/relay.ts`: the GunRelay Durable Object.
- `src/sea.ts`: Gun's SEA write rules in WebCrypto.
- `src/index.ts`: the Worker.
- `wrangler.jsonc`.

**Tests:**
- `test/sea.test.ts`: 12/12. Checked against real gun/SEA wire writes.
- `test/pair.e2e.ts`: 17/17. Covers both directions of Cloudflare ⇄ minikube relay: data, live updates, forgery rejection, and moderation enforcement on both relays.
- `test/moderation-pull.e2e.ts`: 6/6.
- The app's `npm run test:db` still passes 110/110.

**Pairing:** the minikube overlay sets `RELAY_PEERS` and `MODERATION_URL`, currently pointing at `wrangler dev` on the Mac (`host.minikube.internal:8787`).

**Deployed** (2026-11-13) with `npx wrangler deploy`. Account `f82b6e89…`, workers.dev name `laincorp` (disabled for this Worker), custom domain `relay.lain.xn--tckwe`.

- **Peer token:** the `RELAY_PEER_TOKEN` secret is set. Minikube's `RELAY_PEERS`, which includes the token, is in `relay.env`, the gitignored secret. A wrong token is treated as a plain client.
- **Moderation list:** the existing list was copied from minikube with `scripts/seed-moderation.ts`. It has 5 entries, 2 of them active bans.
- **Tests against live Cloudflare:** `pair.e2e` 17/17, `moderation-pull` 5/5.
- **App `.env`:** peers are minikube plus Cloudflare. `EXPO_PUBLIC_LAIN_MODERATION_URL` points at Cloudflare. `SERVICE_URL` (registrar, media) stays on minikube.

**Next:** P1. Terraform takes over the custom domain, then CI is set up, then the IPFS gateway (P3).

## 9. Status after the free-tier push (2026-11-13)

**Live on Cloudflare (all on the Free plan):**

| What | Where | Notes |
|---|---|---|
| Gun relay, moderation list, post retention | `relay.lain.xn--tckwe` (Worker `lain-relay` + SQLite Durable Object) | See §2, §2a and §2b |
| Username registrar, link previews, account purge | same | The app's `EXPO_PUBLIC_LAIN_SERVICE_URL` now points here. `/lain/recovery/send` answers 503, because mail is out of scope. |
| Public site | `lain.xn--tckwe` (+ `www`), Worker `lain-site` (static assets) | Home, community guidelines, child safety standards, privacy, terms, support, delete account, `/.well-known/security.txt`. Served by zone routes until the old parking DNS records are removed. |
| Moderation console | `mod.lain.xn--tckwe`, Worker `lain-mod` + D1 `lain-mod` | Details below |
| Zone as code | `Infrastructure/cloudflare/terraform` (OpenTofu) | D1 is imported and applied. Zone settings and the rate limit are planned; they need an API token with zone permissions. |
| CI/CD | `Infrastructure/.github/workflows/cloudflare.yml` | Ready for when a GitHub repo exists |

**The moderation console:**
- **Built so far:** queue, case pages, ban, unban, dismiss, search, audit log with export, network and retention stats.
- **Key handling:** the browser decrypts reports and signs bans. The key is stored encrypted with a passphrase and locks after 15 minutes idle.
- **API:** every call is signed by the moderation key. The API stores workflow state only.
- **Discord alerts:** a cron job every 5 minutes checks for new reports and for reports at 12 h and 20 h of the 24 h deadline. Alerts start once `DISCORD_WEBHOOK_URL` is set.

**Media:** still on the self-hosted relay (`EXPO_PUBLIC_LAIN_MEDIA_URL`) until R2 is enabled.

**App:**
- **Sign-up:** a 17+ age check and links to the terms, guidelines and privacy policy.
- **Settings:** links to the policy pages, and in-app account deletion with a password check.
- **Posts:** a ··· menu with Report (with reasons), Block, and Delete for your own posts.
- **Lain's replies:** long-press to report.

**Tests:**
- `tests/cloudflare.e2e.ts` against live Cloudflare: 11/11.
- Console end to end (local): 13/13. It was also checked in headless Chrome.
- `npm run test:db`: 117/117.

## 10. Media and IPFS on R2 (live 2026-11-13)

- **Media:** `relay/media.js` is ported to `lain-relay/src/media.ts`.
  - The HTTP contract is unchanged.
  - Files are stored in the R2 bucket `lain-media` under `files/<sha>`.
  - Downloads are served by the Worker straight from R2, with Range support.
  - Uploads, info and release go through the Durable Object.
  - Limits are unchanged: photos 6 MB, videos 25 MB, avatars 512 KB, 300 MB per day.
  - Uploads up to 25 MB were tested on production without hitting CPU limits.
- **Retention** (aligned with §2b): a file stays as long as the posts using it. Media of a kept (top) post is kept forever.
  - Post media expires 30 days after its last upload (2-hour grace).
  - Avatars stay while in use.
  - DM attachments expire after 30 days.
  - Bans take files down at once (451). Account deletion releases the account's files.
- **IPFS:**
  - CIDs are computed in the Worker. They are identical to Kubo's (`--cid-version=1 --raw-leaves`, 256 KiB chunks, 174 links); tested from 1 B to 25 MB.
  - Raw leaves are pointers into `files/<sha>`, so nothing is stored twice.
  - The trustless gateway at `ipfs.lain.xn--tckwe` serves `/ipfs/<cid>` as the file, `?format=raw` and `?format=car`. Kubo imported our CAR offline, and the file matched.
- **IPNI:** `src/ipni.ts` publishes one advertisement per file (add or remove) every hour and announces to cid.contact.
  - Identity: `relay/keys/ipni.json` (Ed25519), secret `IPNI_KEY`. Peer ID `12D3KooWSRwHL4RHn112wr9RuDK2mccgkNtA1t6234naKFYDACRi`.
  - The output is byte-identical to `@web3-storage/ipni`.
  - Live: cid.contact and delegated-ipfs.dev list our gateway as an HTTP provider for migrated content.
- **Migration:** the 7 files from minikube were copied with `scripts/migrate-media.mjs`. Every SHA-256 and CID is identical.
- **App:** `.env` uses only Cloudflare. The peer is `wss://relay.lain.xn--tckwe/gun`, and services and media are at `https://relay.lain.xn--tckwe`.
- **Tests:**
  - `tests/media-cloudflare.e2e.ts`: 21/21.
  - `test/cid-parity.test.ts`: 7/7 against Kubo.
  - `tests/cloudflare.e2e.ts` live: 11/11.
  - `npm run test:db`: 117/117.
