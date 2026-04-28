# 📦 TeleStore

> **Telegram-backed image hosting on Cloudflare Workers + D1**  
> Upload images → stored in Telegram channels → metadata in D1 → auto-forwarded to backup channels → beautiful dashboard UI included.

---

## What's Inside

| File | Purpose |
|---|---|
| `worker.js` | The entire backend + frontend in one file |
| `wrangler.toml` | Cloudflare Worker config (D1 bindings, env vars) |

> ✅ **No `schema.sql` needed.** The database tables are created automatically on first deploy.

---

## Architecture

```
Client
  │
  ▼
Cloudflare Worker (worker.js)
  ├── Auto-migrates D1 schema on first request
  ├── Serves dashboard UI at /  (toggle with ENABLE_DASHBOARD)
  │
  ├── Cloudflare D1 — primary        (env.DB)
  ├── Cloudflare D1 — backup 1       (env.DB_BACKUP,  optional)
  ├── Cloudflare D1 — backup 2       (env.DB_BACKUP2, optional)
  │
  └── Telegram Bot API
        ├── Main Channel             ← binary storage
        ├── Backup Channel A         ← auto-forwarded on upload
        └── Backup Channel B         ← auto-forwarded on upload
```

---

## Setup Guide

### 1 — Create a Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the **Bot Token** (format: `123456:ABC-DEF…`)

### 2 — Create Telegram Channels

1. Create a **private channel** → add your bot as **Admin** (can post messages)
2. Get the **Channel ID** — easiest way: forward any message from the channel to [@userinfobot](https://t.me/userinfobot)  
   IDs look like `-1001234567890`
3. Repeat for backup channels (optional but recommended)

### 3 — Create D1 Databases

```bash
# Install wrangler if needed
npm install -g wrangler
wrangler login

# Create primary DB (required)
wrangler d1 create telestore-main
# → copy the database_id into wrangler.toml

# Create backup DBs (optional)
wrangler d1 create telestore-backup
wrangler d1 create telestore-backup2
```

> ⚡ **No schema.sql to run.** The worker creates all tables automatically on first deploy.

### 4 — Configure

#### Option A — Edit `worker.js` directly

Fill in the `CONFIG` block at the top of `worker.js`:

```js
const CONFIG = {
  TELEGRAM_BOT_TOKEN:       "123456:ABC-DEF...",
  TELEGRAM_CHANNEL_ID:      "-1001234567890",
  TELEGRAM_BACKUP_CHANNELS: "-1009876543210",   // comma-separated or ""
  API_KEY:                  "your-secret-key",
  ENABLE_DASHBOARD:         "true",              // "false" to disable UI
  BASE_URL:                 "https://telestore.yourname.workers.dev",
  // D1 IDs are for reference — actual bindings are in wrangler.toml
  D1_MAIN_DATABASE_ID:      "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
};
```

#### Option B — Worker Secrets + `wrangler.toml` (recommended for production)

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHANNEL_ID
wrangler secret put TELEGRAM_BACKUP_CHANNELS
wrangler secret put API_KEY
```

Edit `wrangler.toml` for non-secret vars:

```toml
[vars]
BASE_URL         = "https://telestore.yourname.workers.dev"
ENABLE_DASHBOARD = "true"    # ← flip to "false" to disable the UI
MAX_FILE_SIZE_MB = "20"
```

Paste your D1 database IDs into the `[[d1_databases]]` blocks in `wrangler.toml`.

### 5 — Deploy

```bash
wrangler deploy
```

Open your worker URL — you'll see the TeleStore dashboard. Done.

---

## Toggling the Dashboard

The frontend UI at `/` and `/dashboard` is controlled by a single variable:

| Where | How |
|---|---|
| `worker.js` CONFIG | `ENABLE_DASHBOARD: "true"` or `"false"` |
| `wrangler.toml` vars | `ENABLE_DASHBOARD = "true"` |
| Worker secret | `wrangler secret put ENABLE_DASHBOARD` → type `false` |

When **disabled**, `GET /` returns:
```json
{ "service": "TeleStore", "dashboard": "disabled" }
```

When **enabled**, `GET /` serves the full interactive UI.

---

## API Reference

All protected endpoints require one of:
- Header: `X-API-Key: YOUR_KEY`
- Query param: `?api_key=YOUR_KEY`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | — | Dashboard UI (or JSON if disabled) |
| `GET` | `/dashboard` | — | Same as `/` |
| `GET` | `/health` | — | Health check |
| `GET` | `/stats` | — | Storage + DB stats |
| `POST` | `/upload` | ✅ | Upload an image |
| `GET` | `/image/:id` | — | Redirect to Telegram CDN |
| `GET` | `/proxy/:id` | — | Stream image through worker |
| `GET` | `/info/:id` | — | JSON metadata |
| `DELETE` | `/delete/:id` | ✅ | Delete from Telegram + DB |
| `GET` | `/list` | ✅ | List images (paginated) |
| `POST` | `/revalidate/:id` | ✅ | Check Telegram file still accessible |

### Upload Examples

**Multipart (browser / curl):**
```bash
curl -X POST https://your-worker.workers.dev/upload \
  -H "X-API-Key: YOUR_KEY" \
  -F "file=@photo.jpg" \
  -F "tags=nature,landscape" \
  -F 'meta={"author":"alice"}'
```

**Raw binary:**
```bash
curl -X POST https://your-worker.workers.dev/upload \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: image/jpeg" \
  -H "X-Filename: photo.jpg" \
  --data-binary @photo.jpg
```

**Base64 JSON:**
```bash
curl -X POST https://your-worker.workers.dev/upload \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename":"photo.jpg","mime_type":"image/jpeg","data":"<base64>","tags":"test"}'
```

### List with Pagination
```bash
GET /list?limit=20&offset=0&tag=nature
```

---

## Optional: Custom Domain via Cloudflare

**Cloudflare Dashboard:** Workers & Pages → your worker → Settings → Triggers → Add Custom Domain

**Or via cloudflared tunnel (local dev):**
```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login
cloudflared tunnel create telestore
cloudflared tunnel route dns telestore images.yourdomain.com

# Terminal 1 — local dev server
wrangler dev

# Terminal 2 — expose via tunnel
cloudflared tunnel --url http://localhost:8787
```

---

## D1 Schema (auto-applied, for reference)

```sql
CREATE TABLE IF NOT EXISTS images (
  id                 TEXT    PRIMARY KEY,
  filename           TEXT    NOT NULL,
  mime_type          TEXT    NOT NULL,
  size               INTEGER NOT NULL,
  tg_message_id      INTEGER NOT NULL,
  tg_file_id         TEXT    NOT NULL,
  backup_message_ids TEXT    NOT NULL DEFAULT '{}',
  uploaded_at        TEXT    NOT NULL,
  tags               TEXT    NOT NULL DEFAULT '',
  meta               TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_uploaded_at ON images (uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_tags        ON images (tags);
```

This runs automatically via `env.DB.exec()` on the first request after each deploy, using `IF NOT EXISTS` so it's always safe to re-run.
