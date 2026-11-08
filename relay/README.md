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
| `SMTP_URL`, `MAIL_FROM` | Recovery email. Without them: dev mode prints codes; production returns 503 |
| `MAIL_RETENTION_DAYS` (30), `MAX_VALUE_BYTES` (65536) | Limits |

Endpoints: `POST /lain/registrar/claim`, `POST /lain/registrar/release`, `POST /lain/recovery/send`, `POST /lain/account/purge`, `GET /lain/health`; Gun at `/gun`. Put it behind TLS (`wss://`, `https://`).

Admin (`RELAY=wss://host/gun KEYS=relay/keys node tools/admin.js …`):
`ban-user <pub> <reason>`, `unban-user <pub>`, `ban-post <pub/postId> <reason>`, `unban-post`, `ban-media <sha256>`, `reports [YYYY-MM-DD]`, `publish-model <file.json>`, `retire-model <version>`, `publish-relay <id> <wss-url> <region> <operator>`, `remove-relay <id>`.

Reports must be actioned within 24 h (App Store / Play UGC rules).
