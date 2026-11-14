# Lain IO moderation console: mod.lain.コム

Status: **M0, M1 and tier-0 alerts are live** at `mod.lain.xn--tckwe` (2026-11-13). Cloudflare Access isn't set up yet: the API trusts only requests signed by the moderation key, and the key never leaves the browser. Tier-1 holds (M2) and M3/M4 are still to do. This builds on [PLAN-cloudflare.md](PLAN-cloudflare.md) §2a (moderation's single source of truth on Cloudflare) and §2b (post retention).

## Why

Today moderation runs from the command line (`relay/tools/admin.js`). That works for one person and a handful of reports. It stops working when:

- **Play and the App Store expect reports handled within 24 hours.** Nothing tracks that clock today, and nothing warns you when it's about to run out.
- **Reports are encrypted** to the moderation key. Reading one means running a script with the private key on hand.
- **There's no record** of who did what and why. Store review, legal requests and appeals all need one.
- **Repetitive cases need a person every time:** spam waves, a known-bad image re-uploaded, a brand-new account flooding posts.

The console turns this into a web app with a queue, case pages, one-click actions, an audit log, and rule-based automations. It keeps the existing security model:

- **Signing keys stay on moderators' own devices.** Every ban is signed in the moderator's browser, the same as today.
- **Automations can only hide content for a while.** They do it with a limited-power key, and a human has to confirm or the hide expires.

## 1. Where it lives

| Piece | Choice |
|---|---|
| Address | `mod.lain.コム` (`mod.lain.xn--tckwe`). The apex `lain.コム` stays the public site. |
| Hosting | Worker `lain-mod` with static assets (React + Vite single-page app) plus a small API |
| Who can open it | **Cloudflare Access** in front of the whole hostname: only listed moderator emails, with passkey or hardware-key MFA. The Worker also checks the Access JWT on every API call. |
| Data the app reads | Gun, directly from the browser (`wss://relay.lain.xn--tckwe/gun`), plus the relay's `/lain/*` endpoints |
| Case workflow state | D1 `lain-mod`: case status, assignee, timestamps, rule hits. **It holds no user content.** Reports are decrypted only in the browser. |
| As code | Terraform manages the Access app and policies, DNS, D1 and the Worker custom domain. Wrangler deploys the Worker. Same CI as the relay. |

## 2. Keys: one list, several moderators, nobody holds the root key day to day

Today one moderation key signs everything, and reports are sealed to its epub. With several people moderating, sharing that key isn't safe. The plan:

1. **The root moderation key** (the current one) **stays offline.** It is used only to add or remove moderators.
2. **Each moderator gets their own key**, generated in their browser when they enrol.
   - It's stored as a non-extractable WebCrypto key in IndexedDB, unlocked by a passkey.
   - The root key issues them a **SEA certificate** allowing writes to `~MOD/moderation/*` only, valid for 90 days.
   - Bans therefore stay in the one list apps already read (§2a), and **app code doesn't change**. Gun verifies the certificate.
   - Every entry also records which moderator wrote it.
3. **Removing a moderator:** add them to the certificate's write-block list, or let the certificate expire.
4. **The Cloudflare relay must accept certificates.** Today it rejects them. Certificate verification is added to `sea.ts` and tested against real gun.
5. **A shared reports key:**
   - Apps seal reports to a dedicated **reports key**. Its public key is published, signed, in the moderation space.
   - Each moderator receives the private half encrypted to their own key.
   - When someone leaves, the key is rotated. New reports use the new key, and old ones remain readable by current moderators.
   - App change: the app reads the current reports epub from the signed list instead of the build-time `EXPO_PUBLIC_LAIN_MODERATION_EPUB`.

## 3. Automations: three tiers

| Tier | Who acts | What it can do | If it's wrong |
|---|---|---|---|
| **0 · Signals** | The relay and the console, no key | Score and sort the queue, flag priority, start SLA timers, send alerts | Nothing is hidden |
| **1 · Hold** | An **automation key** (Worker secret) with a certificate that only covers `~MOD/moderation/hold/*` | Temporarily hide a post, an account's new posts, or a media hash. Apps hide held items like bans. **A hold expires on its own after 48 h** unless a human turns it into a ban. | It undoes itself. A stolen automation key can only cause temporary hides, never bans. |
| **2 · Decide** | A human, signing in the browser | Ban, unban, ban media, keep or unkeep a post, dismiss | Reversible with an unban, and recorded in the audit log |

**Starter rules.** These are stored as JSON in the repo and can be edited in the console with version history. Each has a dry-run mode that shows what it *would* have done over the last 30 days.

- 3 or more reports on a post from distinct accounts older than 7 days, within an hour → **hold the post** and mark it high priority.
- An account under 24 hours old posting more than 20 times an hour, or sending more than 50 DMs an hour → **hold the account's new posts**.
- Someone tries to re-upload a banned media hash. The relay already refuses the file. The rule **flags the uploader's account for review** and adds the attempt to its history.
- A post matches the keyword or link blocklist → high priority, plus a hold if the list entry says so.
- A report category of "child safety" → **hold immediately and alert at once**. Preserving evidence and the reporting duty are covered in the runbook.
- A case close to the 24-hour SLA → alert at 12 h and 20 h.

**Where rules run:** cheap counters (reports, posting rate) are kept in the GunRelay Durable Object as writes arrive. A Cron Worker evaluates rules every minute and runs the hold expiry. Alerts go out by email (Cloudflare Email Sending, internal addresses only) and an optional Discord or Slack webhook.

## 4. Screens

1. **Queue:** open cases sorted by severity and time left on the SLA. Filters for type, rule and assignee. "Take next" assigns the top case.
2. **Case:**
   - The reported item, decrypted in the browser, with media blurred and greyscale by default.
   - Context: the thread, the author's recent posts, account age, earlier actions and reports.
   - Which rules fired.
   - Action buttons with reason templates. Bulk actions for spam waves.
3. **Search:** look up a username, pub, post ref or media hash to see everything about it plus its history.
4. **Holds:** what automation is hiding right now, with confirm (ban) or release buttons and the time left.
5. **Appeals:** users appeal from the app. Appeals are sealed to the reports key like reports, and land in the queue linked to the original case.
6. **Audit log:** every action with moderator, time, reason and signature. Filters, and CSV/JSON export for store review or legal.
7. **Retention:** the keep list (§2b), upcoming expiries, and score cut-offs. Manual keep/unkeep only if you want it (decision below).
8. **Network:** relay health, connected peer relays, the signed relay list, and rotating peer tokens.
9. **Metrics:** reports per day, median time to action, SLA breaches, holds confirmed vs released. That last figure is the false-positive rate, which tells you whether a rule is too aggressive.
10. **Settings:** moderators (enrol, revoke), rules, keyword lists, alert channels.

## 5. Safety of the console itself

- Strict Content-Security-Policy: no third-party scripts, and connections only to the relay and the console API. XSS is the main way a browser-held key could be stolen.
- Signing actions ask for the passkey again after 15 minutes of inactivity.
- Moderator wellbeing: media is blurred by default with reveal-on-click, and there's a "skip and reassign" option.
- The console is an ordinary client of the network. If it goes down, moderation still works through `admin.js`.

## 6. Phases

| Phase | Work | Done when |
|---|---|---|
| **M0: Keys** | Certificate support in the relay (`sea.ts`, with tests against gun); moderator enrolment; reports-key wrapping; the app reads the reports epub from the signed list | Two moderators can each ban; revoking one stops their bans from being accepted |
| **M1: Core** | Access, Worker, D1; queue, case page, actions, audit log, search | A report goes from the app to the console to a ban, and the ban reaches the app, within the SLA, end to end |
| **M2: Automation** | Tier 0 signals and SLA alerts; Tier 1 holds with 48 h expiry (the app honours `hold`); starter rules; dry-run | Holds appear and expire; dry-run over sample data matches what was expected |
| **M3: Operations** | Appeals, metrics, retention view, network view | Play's UGC and child-safety requirements can be shown from the console |
| **M4: Rules editor** | Editing rules in the console with history and simulation | A rule change is reviewed with its dry-run before it goes live |

M0 and M1 come before step 4 (store compliance) of the main plan. M2 onwards can follow the launch.

## 7. Decisions (2026-11-13)

1. **Moderators: only the owner for now.** M0 is the smaller version. The current moderation key is used in the browser, unlocked by a passkey. Per-moderator certificates and the shared reports key are postponed until a second moderator joins.
2. **Alerts go to Discord** through a webhook (Worker secret `DISCORD_WEBHOOK_URL`).
3. **Keep list: ranking only.** There is no manual keep. The Retention screen is read-only.
4. **Case state: D1** (the default), holding ops metadata only.
