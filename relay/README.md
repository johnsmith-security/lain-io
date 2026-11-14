# Lain IO relay

A Gun relay plus the main relay's services. Community relays run the same file without the service keys and still enforce the moderation list.

```sh
cd relay && npm install
node tools/keygen.js                 # once: registrar / moderation / release keys in relay/keys (keep private)
REGISTRAR_PAIR='…' MODERATION_PUB=… SMTP_URL=smtps://user:pass@smtp.example.com MAIL_FROM='Lain IO <no-reply@…>' \
  NODE_ENV=production npm start
```

| Env | Purpose |
|---|---|
| `PORT` (8765), `HOST`, `DATA_DIR` (`./data`) | Listener and storage |
| `RELAY_PEERS` | Other relays to sync with (comma-separated `wss://…/gun`) |
| `REGISTRAR_PAIR` | Registrar key pair JSON. Set on **one** node only; that node owns username ordering |
| `MODERATION_PUB` | Moderation account; its bans are enforced on reads and writes |
| `MODERATION_URL` | Cloudflare relay's signed list (`https://relay.lain.xn--tckwe/lain/moderation`), the single source of truth. Pulled every minute and SEA-verified |
| `SMTP_URL`, `MAIL_FROM` | Recovery email. Without them: dev mode prints codes; production returns 503 |
| `MAIL_RETENTION_DAYS` (30), `MAX_VALUE_BYTES` (65536) | Limits |
| `MAIL_WRITES_PER_MIN` (600) | Mail envelopes (messages + receipts) one connection may write per minute; the excess is dropped without an ack and the client's outbox retries. `/lain/health` reports `mail.dropped`. |
| `IPFS_API` | Kubo RPC URL (e.g. `http://ipfs:5001`). Media is pinned there. Unset: files go to `DATA_DIR/media` (dev) |
| `SCANNER_URL` | Media scanner: `POST <bytes>` → `{ ok, reason?, adult? }`. **Required in production** (CSAM hash matching); `adult` flags files as sensitive |
| `ALLOW_UNSCANNED_MEDIA=1` | Accept uploads without a scanner in production. Don't. |
| `MEDIA_TTL_DAYS` (30), `MEDIA_KEEP_SCORE` (50), `MEDIA_KEEP_MIN_ACCOUNT_AGE_DAYS` (7) | Post media expires after the TTL unless likers + 2 × reposters ≥ score |
| `MEDIA_RETENTION_INTERVAL_MIN` (60), `MEDIA_MAX_VIDEO_BYTES` (25 MB), `MEDIA_DAILY_BYTES` (300 MB / account) | Media job and limits |

Endpoints: `POST /lain/registrar/claim`, `POST /lain/registrar/release`, `POST /lain/recovery/send`, `POST /lain/account/purge`, `POST /lain/media`, `GET|HEAD /lain/media/<sha>` (Range), `GET /lain/media/<sha>/info`, `POST /lain/media/release`, `GET /lain/link-preview?url=`, `GET /lain/health`; Gun at `/gun`.

Docker (`docker compose up --build -d`) starts the relay and a Kubo node (`lain-ipfs`). Kubo's API stays on the internal network; port 4001 is the IPFS swarm. Check pins with `docker exec lain-ipfs ipfs pin ls`. The media manifest is `data/media.json`. Put it behind TLS (`wss://`, `https://`).

Admin (`RELAY=wss://host/gun KEYS=relay/keys node tools/admin.js …`):
`ban-user <pub> <reason>`, `unban-user <pub>`, `ban-post <pub/postId> <reason>`, `unban-post`, `ban-media <sha256>` (the relay unpins it at once and serves 451), `reports [YYYY-MM-DD]`, `publish-model <file.json>`, `retire-model <version>`, `publish-relay <id> <wss-url> <region> <operator>`, `remove-relay <id>`.

Reports must be actioned within 24 h (App Store / Play UGC rules).
