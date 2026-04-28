/**
 * TeleStore — Cloudflare Worker Image Hosting via Telegram
 * =========================================================
 * ✅ Schema auto-created on first deploy — no manual SQL ever needed
 * ✅ Beautiful test dashboard at / and /dashboard (toggle with ENABLE_DASHBOARD)
 * ✅ Telegram Bot as primary storage backend
 * ✅ CF D1 as metadata store (main + 2 optional backups, all auto-migrated)
 * ✅ Auto-forward to backup Telegram channels on every upload
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG — edit here OR set as Worker environment variables / secrets.
// Worker env vars always override these hardcoded values.
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {

  // ── Telegram ─────────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN:       "",  // @BotFather token  e.g. "123456:ABC-DEF..."
  TELEGRAM_CHANNEL_ID:      "",  // Main storage channel  e.g. "-1001234567890"
  TELEGRAM_BACKUP_CHANNELS: "",  // Optional comma-separated  e.g. "-100aaa,-100bbb"

  // ── Cloudflare D1 (for reference — actual access is via wrangler.toml bindings) ──
  //   env.DB         = primary DB   (binding name: "DB")
  //   env.DB_BACKUP  = backup DB 1  (binding name: "DB_BACKUP")   optional
  //   env.DB_BACKUP2 = backup DB 2  (binding name: "DB_BACKUP2")  optional
  //
  // All databases are auto-migrated on first request. No manual SQL needed.
  D1_MAIN_DATABASE_NAME:    "telestore-main",     // wrangler d1 create telestore-main
  D1_MAIN_DATABASE_ID:      "YOUR_D1_MAIN_ID",    // paste ID from above command output
  D1_BACKUP_DATABASE_NAME:  "telestore-backup",   // wrangler d1 create telestore-backup (optional)
  D1_BACKUP_DATABASE_ID:    "",                   // paste ID, or leave blank to skip
  D1_BACKUP2_DATABASE_NAME: "",                   // wrangler d1 create telestore-backup2 (optional)
  D1_BACKUP2_DATABASE_ID:   "",                   // paste ID, or leave blank to skip

  // ── Auth ─────────────────────────────────────────────────────────────────────
  API_KEY: "",  // Protects upload/delete/list. Send as X-API-Key header or ?api_key=

  // ── Frontend ─────────────────────────────────────────────────────────────────
  // Set to "false" (string or boolean) to disable the dashboard UI entirely.
  // When disabled, GET / returns a plain JSON health response instead.
  ENABLE_DASHBOARD: "true",  // "true" | "false"

  // ── Misc ─────────────────────────────────────────────────────────────────────
  MAX_FILE_SIZE_MB: 20,
  ALLOWED_TYPES: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"],
  BASE_URL: "",  // e.g. https://telestore.yourname.workers.dev  (used in response URLs)
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-MIGRATION — runs on first request, safe to re-run (IF NOT EXISTS)
// ═══════════════════════════════════════════════════════════════════════════════
const SCHEMA_SQL = `
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
`;

// Track which DBs have been migrated this isolate lifetime (avoids re-running every request)
const _migrated = new Set();

async function ensureMigrated(env) {
  const dbs = [
    { key: "DB",        instance: env.DB        },
    { key: "DB_BACKUP", instance: env.DB_BACKUP  },
    { key: "DB_BACKUP2",instance: env.DB_BACKUP2 },
  ].filter(d => d.instance);

  for (const { key, instance } of dbs) {
    if (_migrated.has(key)) continue;
    try {
      // D1 exec() runs multi-statement SQL
      await instance.exec(SCHEMA_SQL);
      _migrated.add(key);
    } catch (err) {
      // Non-fatal — log and continue (might already exist)
      console.warn(`Migration warning [${key}]:`, err?.message);
      _migrated.add(key); // mark done so we don't retry every request
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Read a config value: env var first, then CONFIG hardcode. */
function cfg(env, key) {
  const v = env[key];
  if (v !== undefined && v !== null && v !== "") return v;
  return CONFIG[key] ?? "";
}

function isDashboardEnabled(env) {
  const v = String(cfg(env, "ENABLE_DASHBOARD")).toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "no";
}

function backupChannels(env) {
  const raw = cfg(env, "TELEGRAM_BACKUP_CHANNELS");
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function checkAuth(request, env) {
  const key = cfg(env, "API_KEY");
  if (!key) return true;
  const header =
    request.headers.get("X-API-Key") ||
    (request.headers.get("Authorization") || "").replace("Bearer ", "");
  const qkey = new URL(request.url).searchParams.get("api_key");
  return header === key || qkey === key;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM API
// ═══════════════════════════════════════════════════════════════════════════════

async function tgReq(env, method, body, isForm = false) {
  const token = cfg(env, "TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    ...(isForm
      ? { body }
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return res.json();
}

async function tgSendPhoto(env, fileData, filename, caption) {
  const fd = new FormData();
  fd.append("chat_id", cfg(env, "TELEGRAM_CHANNEL_ID"));
  fd.append("photo", new Blob([fileData]), filename);
  if (caption) fd.append("caption", caption);
  return tgReq(env, "sendPhoto", fd, true);
}

async function tgSendDocument(env, fileData, filename, caption) {
  const fd = new FormData();
  fd.append("chat_id", cfg(env, "TELEGRAM_CHANNEL_ID"));
  fd.append("document", new Blob([fileData]), filename);
  if (caption) fd.append("caption", caption);
  return tgReq(env, "sendDocument", fd, true);
}

async function tgForward(env, messageId, targetChannelId) {
  return tgReq(env, "forwardMessage", {
    chat_id: targetChannelId,
    from_chat_id: cfg(env, "TELEGRAM_CHANNEL_ID"),
    message_id: messageId,
  });
}

async function tgDelete(env, messageId) {
  return tgReq(env, "deleteMessage", {
    chat_id: cfg(env, "TELEGRAM_CHANNEL_ID"),
    message_id: messageId,
  });
}

async function tgGetFile(env, fileId) {
  return tgReq(env, "getFile", { file_id: fileId });
}

async function tgDownload(env, filePath) {
  const token = cfg(env, "TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  return res.ok ? res : null;
}

function extractFileId(msg) {
  if (msg.photo?.length) return msg.photo[msg.photo.length - 1].file_id;
  if (msg.document)      return msg.document.file_id;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE HELPERS — all writes mirror to backup DBs automatically
// ═══════════════════════════════════════════════════════════════════════════════

function allDbs(env) {
  return [env.DB, env.DB_BACKUP, env.DB_BACKUP2].filter(Boolean);
}

async function dbWriteAll(env, sql, bindings = []) {
  await env.DB.prepare(sql).bind(...bindings).run();
  for (const db of [env.DB_BACKUP, env.DB_BACKUP2].filter(Boolean)) {
    try { await db.prepare(sql).bind(...bindings).run(); }
    catch (e) { console.warn("Backup DB write failed:", e?.message); }
  }
}

async function dbInsert(env, r) {
  return dbWriteAll(env,
    `INSERT INTO images (id,filename,mime_type,size,tg_message_id,tg_file_id,backup_message_ids,uploaded_at,tags,meta)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [r.id, r.filename, r.mime_type, r.size, r.tg_message_id, r.tg_file_id,
     JSON.stringify(r.backup_message_ids || {}), r.uploaded_at, r.tags || "", JSON.stringify(r.meta || {})]
  );
}

async function dbGet(env, id) {
  const row = await env.DB.prepare("SELECT * FROM images WHERE id=?").bind(id).first();
  return row ? parseRow(row) : null;
}

async function dbDelete(env, id) {
  return dbWriteAll(env, "DELETE FROM images WHERE id=?", [id]);
}

async function dbList(env, { limit = 50, offset = 0, tag = null } = {}) {
  let q = "SELECT * FROM images", p = [];
  if (tag) { q += " WHERE tags LIKE ?"; p.push(`%${tag}%`); }
  q += " ORDER BY uploaded_at DESC LIMIT ? OFFSET ?";
  p.push(limit, offset);
  const r = await env.DB.prepare(q).bind(...p).all();
  return (r.results || []).map(parseRow);
}

async function dbCount(env, tag = null) {
  let q = "SELECT COUNT(*) as cnt FROM images", p = [];
  if (tag) { q += " WHERE tags LIKE ?"; p.push(`%${tag}%`); }
  const r = await env.DB.prepare(q).bind(...p).first();
  return r?.cnt || 0;
}

async function dbUpdateBackups(env, id, backups) {
  return dbWriteAll(env, "UPDATE images SET backup_message_ids=? WHERE id=?",
    [JSON.stringify(backups), id]);
}

function dbSummary(env) {
  return {
    primary:   !!env.DB,
    backup_1:  !!env.DB_BACKUP,
    backup_2:  !!env.DB_BACKUP2,
    total:     allDbs(env).length,
  };
}

function parseRow(row) {
  return {
    ...row,
    backup_message_ids: JSON.parse(row.backup_message_ids || "{}"),
    meta:               JSON.parse(row.meta || "{}"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ID GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

function genId() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => chars[b % chars.length]).join("");
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /upload
async function handleUpload(request, env) {
  if (!checkAuth(request, env)) return jsonResp({ error: "Unauthorized" }, 401);

  const ct = request.headers.get("Content-Type") || "";
  let fileData, filename, mimeType, tags = "", metaExtra = {};

  if (ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    const file = fd.get("file");
    if (!file || typeof file === "string") return jsonResp({ error: "No file field in multipart" }, 400);
    fileData  = await file.arrayBuffer();
    filename  = file.name || "upload.bin";
    mimeType  = file.type || "application/octet-stream";
    tags      = fd.get("tags") || "";
    try { metaExtra = JSON.parse(fd.get("meta") || "{}"); } catch {}
  } else if (ct.includes("application/json")) {
    const body = await request.json();
    if (!body.data || !body.filename) return jsonResp({ error: "Provide base64 'data' and 'filename'" }, 400);
    fileData  = Uint8Array.from(atob(body.data), c => c.charCodeAt(0)).buffer;
    filename  = body.filename;
    mimeType  = body.mime_type || "image/jpeg";
    tags      = body.tags || "";
    metaExtra = body.meta || {};
  } else {
    filename  = request.headers.get("X-Filename") || "upload.bin";
    mimeType  = ct || "application/octet-stream";
    fileData  = await request.arrayBuffer();
  }

  const maxBytes = Number(cfg(env, "MAX_FILE_SIZE_MB") || CONFIG.MAX_FILE_SIZE_MB) * 1024 * 1024;
  if (fileData.byteLength > maxBytes)
    return jsonResp({ error: `File too large. Max ${cfg(env, "MAX_FILE_SIZE_MB")}MB` }, 413);

  const allowed = CONFIG.ALLOWED_TYPES;
  if (!allowed.includes(mimeType) && !/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(filename))
    return jsonResp({ error: `Unsupported type: ${mimeType}` }, 415);

  const id      = genId();
  const caption = `[TeleStore] ${id} | ${filename} | ${(fileData.byteLength / 1024).toFixed(1)}KB`;
  const useDoc  = mimeType === "image/gif" || mimeType === "image/svg+xml" || fileData.byteLength > 5 * 1024 * 1024;

  const tgRes = useDoc
    ? await tgSendDocument(env, fileData, filename, caption)
    : await tgSendPhoto(env, fileData, filename, caption);

  if (!tgRes.ok) return jsonResp({ error: "Telegram upload failed", detail: tgRes.description }, 502);

  const msgId  = tgRes.result.message_id;
  const fileId = extractFileId(tgRes.result) || "";

  // Forward to backup Telegram channels
  const backups = {};
  for (const ch of backupChannels(env)) {
    try {
      const fwd = await tgForward(env, msgId, ch);
      if (fwd.ok) backups[ch] = fwd.result.message_id;
    } catch {}
  }

  const record = {
    id, filename, mime_type: mimeType, size: fileData.byteLength,
    tg_message_id: msgId, tg_file_id: fileId,
    backup_message_ids: backups, uploaded_at: new Date().toISOString(), tags, meta: metaExtra,
  };
  await dbInsert(env, record);

  const base = cfg(env, "BASE_URL").replace(/\/$/, "");
  return jsonResp({
    success: true, id,
    url:       `${base}/image/${id}`,
    proxy_url: `${base}/proxy/${id}`,
    filename, size: fileData.byteLength, mime_type: mimeType, tags,
    backup_channels: Object.keys(backups).length,
    uploaded_at: record.uploaded_at,
  }, 201);
}

// GET /image/:id → redirect to Telegram CDN
async function handleImageRedirect(id, env) {
  const rec = await dbGet(env, id);
  if (!rec) return jsonResp({ error: "Not found" }, 404);
  const fi = await tgGetFile(env, rec.tg_file_id);
  if (!fi.ok) return jsonResp({ error: "Telegram file unavailable" }, 502);
  const token = cfg(env, "TELEGRAM_BOT_TOKEN");
  return Response.redirect(`https://api.telegram.org/file/bot${token}/${fi.result.file_path}`, 302);
}

// GET /proxy/:id → stream through worker (hides bot token)
async function handleProxy(id, env) {
  const rec = await dbGet(env, id);
  if (!rec) return jsonResp({ error: "Not found" }, 404);
  const fi = await tgGetFile(env, rec.tg_file_id);
  if (!fi.ok) return jsonResp({ error: "Telegram file unavailable" }, 502);
  const stream = await tgDownload(env, fi.result.file_path);
  if (!stream) return jsonResp({ error: "Download failed" }, 502);
  return new Response(stream.body, {
    headers: {
      "Content-Type":        rec.mime_type,
      "Content-Disposition": `inline; filename="${rec.filename}"`,
      "Cache-Control":       "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
      "X-TeleStore-ID":      id,
    },
  });
}

// GET /info/:id
async function handleInfo(id, env) {
  const rec = await dbGet(env, id);
  if (!rec) return jsonResp({ error: "Not found" }, 404);
  const base = cfg(env, "BASE_URL").replace(/\/$/, "");
  return jsonResp({
    id: rec.id, filename: rec.filename, mime_type: rec.mime_type,
    size: rec.size, tags: rec.tags, meta: rec.meta, uploaded_at: rec.uploaded_at,
    backup_channels: Object.keys(rec.backup_message_ids).length,
    url:       `${base}/image/${rec.id}`,
    proxy_url: `${base}/proxy/${rec.id}`,
  });
}

// DELETE /delete/:id
async function handleDelete(id, request, env) {
  if (!checkAuth(request, env)) return jsonResp({ error: "Unauthorized" }, 401);
  const rec = await dbGet(env, id);
  if (!rec) return jsonResp({ error: "Not found" }, 404);
  await tgDelete(env, rec.tg_message_id);
  for (const [ch, msgId] of Object.entries(rec.backup_message_ids)) {
    try { await tgReq(env, "deleteMessage", { chat_id: ch, message_id: msgId }); } catch {}
  }
  await dbDelete(env, id);
  return jsonResp({ success: true, id, deleted: true });
}

// GET /list
async function handleList(request, env) {
  if (!checkAuth(request, env)) return jsonResp({ error: "Unauthorized" }, 401);
  const url    = new URL(request.url);
  const limit  = Math.min(parseInt(url.searchParams.get("limit")  || "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const tag    = url.searchParams.get("tag") || null;
  const [images, total] = await Promise.all([dbList(env, { limit, offset, tag }), dbCount(env, tag)]);
  const base = cfg(env, "BASE_URL").replace(/\/$/, "");
  return jsonResp({
    total, limit, offset,
    images: images.map(r => ({
      id: r.id, filename: r.filename, mime_type: r.mime_type,
      size: r.size, tags: r.tags, uploaded_at: r.uploaded_at,
      url:       `${base}/image/${r.id}`,
      proxy_url: `${base}/proxy/${r.id}`,
    })),
  });
}

// GET /stats
async function handleStats(env) {
  const total = await dbCount(env);
  return jsonResp({
    total_images: total,
    telegram: {
      main_channel:    cfg(env, "TELEGRAM_CHANNEL_ID"),
      backup_channels: backupChannels(env).length,
    },
    databases:        dbSummary(env),
    dashboard_enabled: isDashboardEnabled(env),
  });
}

// GET /health
function handleHealth(env) {
  return jsonResp({
    status: "ok", service: "TeleStore", version: "2.0.0",
    timestamp: new Date().toISOString(),
    dashboard_enabled: isDashboardEnabled(env),
  });
}

// POST /revalidate/:id
async function handleRevalidate(id, request, env) {
  if (!checkAuth(request, env)) return jsonResp({ error: "Unauthorized" }, 401);
  const rec = await dbGet(env, id);
  if (!rec) return jsonResp({ error: "Not found" }, 404);
  const fi = await tgGetFile(env, rec.tg_file_id);
  if (!fi.ok) return jsonResp({ error: "File inaccessible on Telegram", detail: fi.description }, 502);
  return jsonResp({ success: true, id, file_accessible: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD FRONTEND — served at / and /dashboard
// ═══════════════════════════════════════════════════════════════════════════════

function handleDashboard(env) {
  const base = (cfg(env, "BASE_URL") || "").replace(/\/$/, "");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TeleStore Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:       #0a0a0f;
    --surface:  #111118;
    --border:   #1e1e2e;
    --border2:  #2a2a3e;
    --text:     #e2e2f0;
    --muted:    #6b6b8a;
    --accent:   #7c6af7;
    --accent2:  #4fc3f7;
    --green:    #4ade80;
    --red:      #f87171;
    --orange:   #fb923c;
    --yellow:   #facc15;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'IBM Plex Sans', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Grid background */
  body::before {
    content: '';
    position: fixed; inset: 0;
    background-image:
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 40px 40px;
    opacity: 0.3;
    pointer-events: none;
    z-index: 0;
  }

  .wrap { position: relative; z-index: 1; max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }

  /* Header */
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1.5rem 0 2.5rem;
    border-bottom: 1px solid var(--border2);
    margin-bottom: 2rem;
  }
  .logo { display: flex; align-items: center; gap: .75rem; }
  .logo-icon {
    width: 40px; height: 40px; border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    display: flex; align-items: center; justify-content: center;
    font-size: 1.2rem;
  }
  .logo-text h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -.02em; }
  .logo-text p  { font-size: .75rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
  .status-dot {
    display: flex; align-items: center; gap: .5rem;
    font-size: .75rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--muted);
    transition: background .3s;
  }
  .dot.online  { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot.offline { background: var(--red);   box-shadow: 0 0 6px var(--red);   }

  /* Stat cards */
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px,1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border2);
    border-radius: 12px; padding: 1.25rem 1.5rem;
    transition: border-color .2s;
  }
  .stat-card:hover { border-color: var(--accent); }
  .stat-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); margin-bottom: .5rem; }
  .stat-value { font-size: 1.75rem; font-weight: 600; font-family: 'IBM Plex Mono', monospace; }
  .stat-value.green  { color: var(--green);  }
  .stat-value.purple { color: var(--accent); }
  .stat-value.blue   { color: var(--accent2);}
  .stat-value.orange { color: var(--orange); }

  /* Sections */
  .section { margin-bottom: 2rem; }
  .section-title {
    font-size: .7rem; text-transform: uppercase; letter-spacing: .12em;
    color: var(--muted); margin-bottom: 1rem;
    display: flex; align-items: center; gap: .5rem;
  }
  .section-title::after { content: ''; flex: 1; height: 1px; background: var(--border2); }

  /* Upload zone */
  .upload-zone {
    background: var(--surface); border: 2px dashed var(--border2);
    border-radius: 16px; padding: 3rem 2rem; text-align: center;
    cursor: pointer; transition: all .25s; position: relative;
  }
  .upload-zone:hover, .upload-zone.dragover {
    border-color: var(--accent); background: rgba(124,106,247,.06);
  }
  .upload-zone input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .upload-icon { font-size: 2.5rem; margin-bottom: .75rem; display: block; }
  .upload-zone h3 { font-size: 1rem; font-weight: 500; margin-bottom: .35rem; }
  .upload-zone p  { font-size: .8rem; color: var(--muted); }

  .upload-meta {
    display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-top: 1rem;
  }
  .upload-meta input {
    background: var(--surface); border: 1px solid var(--border2); border-radius: 8px;
    padding: .6rem .9rem; color: var(--text); font-size: .85rem; font-family: inherit;
    outline: none; transition: border-color .2s;
  }
  .upload-meta input:focus { border-color: var(--accent); }
  .upload-meta input::placeholder { color: var(--muted); }

  /* Buttons */
  .btn {
    display: inline-flex; align-items: center; gap: .5rem;
    padding: .65rem 1.25rem; border-radius: 8px; font-size: .85rem;
    font-family: inherit; font-weight: 500; cursor: pointer; border: none;
    transition: all .2s; text-decoration: none;
  }
  .btn-primary {
    background: var(--accent); color: #fff;
    box-shadow: 0 0 20px rgba(124,106,247,.3);
  }
  .btn-primary:hover { background: #6957e8; box-shadow: 0 0 28px rgba(124,106,247,.5); }
  .btn-ghost {
    background: transparent; color: var(--muted); border: 1px solid var(--border2);
  }
  .btn-ghost:hover { border-color: var(--accent2); color: var(--accent2); }
  .btn-danger { background: transparent; color: var(--red); border: 1px solid rgba(248,113,113,.3); }
  .btn-danger:hover { background: rgba(248,113,113,.1); }
  .btn-sm { padding: .4rem .75rem; font-size: .75rem; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }

  .upload-actions { display: flex; gap: .75rem; margin-top: 1rem; align-items: center; }

  /* Progress bar */
  .progress-wrap { margin-top: 1rem; display: none; }
  .progress-wrap.show { display: block; }
  .progress-bar-bg { background: var(--border2); border-radius: 99px; height: 4px; overflow: hidden; }
  .progress-bar { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 99px; width: 0%; transition: width .3s; }
  .progress-label { font-size: .75rem; color: var(--muted); margin-top: .4rem; font-family: 'IBM Plex Mono', monospace; }

  /* Result box */
  .result-box {
    margin-top: 1rem; background: var(--surface); border: 1px solid var(--border2);
    border-radius: 12px; overflow: hidden; display: none;
  }
  .result-box.show { display: block; }
  .result-box.success { border-color: rgba(74,222,128,.3); }
  .result-box.error   { border-color: rgba(248,113,113,.3); }
  .result-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: .75rem 1rem; border-bottom: 1px solid var(--border2);
    font-size: .8rem; font-family: 'IBM Plex Mono', monospace;
  }
  .result-header.success { color: var(--green);  }
  .result-header.error   { color: var(--red);    }
  .result-body { padding: 1rem; }
  .result-img-wrap { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
  .result-thumb {
    width: 80px; height: 80px; border-radius: 8px; object-fit: cover;
    border: 1px solid var(--border2); background: var(--border);
    flex-shrink: 0;
  }
  .result-links { display: flex; flex-direction: column; gap: .4rem; flex: 1; }
  .result-link {
    display: flex; align-items: center; gap: .5rem;
    background: var(--bg); border: 1px solid var(--border2);
    border-radius: 6px; padding: .4rem .75rem;
    font-family: 'IBM Plex Mono', monospace; font-size: .72rem; color: var(--accent2);
    cursor: pointer; transition: border-color .2s; word-break: break-all;
  }
  .result-link:hover { border-color: var(--accent2); }
  .result-link span  { flex: 1; }
  .result-link .copy-icon { flex-shrink: 0; opacity: .5; }

  /* API tester */
  .tester-row { display: flex; gap: .75rem; align-items: center; margin-bottom: .75rem; flex-wrap: wrap; }
  .method-badge {
    font-family: 'IBM Plex Mono', monospace; font-size: .7rem; font-weight: 600;
    padding: .3rem .6rem; border-radius: 5px; min-width: 60px; text-align: center;
  }
  .m-get    { background: rgba(74,222,128,.12);  color: var(--green);  }
  .m-post   { background: rgba(251,146,60,.12);  color: var(--orange); }
  .m-delete { background: rgba(248,113,113,.12); color: var(--red);    }

  .tester-url {
    flex: 1; background: var(--surface); border: 1px solid var(--border2);
    border-radius: 8px; padding: .55rem .9rem; color: var(--text);
    font-family: 'IBM Plex Mono', monospace; font-size: .8rem; outline: none;
    transition: border-color .2s; min-width: 0;
  }
  .tester-url:focus { border-color: var(--accent); }

  .response-box {
    background: var(--bg); border: 1px solid var(--border2); border-radius: 10px;
    padding: 1rem; font-family: 'IBM Plex Mono', monospace; font-size: .75rem;
    line-height: 1.6; color: var(--muted); min-height: 80px; max-height: 320px;
    overflow-y: auto; white-space: pre-wrap; word-break: break-word;
    display: none;
  }
  .response-box.show { display: block; }

  /* Gallery */
  .gallery-toolbar {
    display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem; flex-wrap: wrap;
  }
  .gallery-toolbar input {
    flex: 1; min-width: 120px; background: var(--surface); border: 1px solid var(--border2);
    border-radius: 8px; padding: .55rem .9rem; color: var(--text); font-size: .85rem;
    font-family: inherit; outline: none; transition: border-color .2s;
  }
  .gallery-toolbar input:focus { border-color: var(--accent); }
  .gallery-toolbar input::placeholder { color: var(--muted); }

  .gallery {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: .75rem;
  }
  .gallery-item {
    background: var(--surface); border: 1px solid var(--border2);
    border-radius: 10px; overflow: hidden; cursor: pointer;
    transition: all .2s; position: relative;
  }
  .gallery-item:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  .gallery-thumb {
    width: 100%; aspect-ratio: 1; object-fit: cover; display: block;
    background: var(--border);
  }
  .gallery-thumb-placeholder {
    width: 100%; aspect-ratio: 1; display: flex; align-items: center;
    justify-content: center; font-size: 2rem; background: var(--border);
  }
  .gallery-info { padding: .5rem .6rem; }
  .gallery-name { font-size: .7rem; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gallery-size { font-size: .65rem; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
  .gallery-del {
    position: absolute; top: .4rem; right: .4rem; width: 22px; height: 22px;
    background: rgba(248,113,113,.85); border: none; border-radius: 5px;
    color: #fff; font-size: .75rem; cursor: pointer; display: none;
    align-items: center; justify-content: center;
  }
  .gallery-item:hover .gallery-del { display: flex; }

  .gallery-empty { grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--muted); font-size: .9rem; }
  .gallery-load  { text-align: center; padding: 1.5rem; }

  /* Modal */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.8); backdrop-filter: blur(6px);
    z-index: 100; display: flex; align-items: center; justify-content: center; padding: 1.5rem;
    opacity: 0; pointer-events: none; transition: opacity .2s;
  }
  .modal-overlay.open { opacity: 1; pointer-events: all; }
  .modal {
    background: var(--surface); border: 1px solid var(--border2); border-radius: 16px;
    max-width: 560px; width: 100%; max-height: 90vh; overflow-y: auto;
    transform: scale(.95); transition: transform .2s;
  }
  .modal-overlay.open .modal { transform: scale(1); }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border2);
  }
  .modal-header h3 { font-size: .95rem; font-weight: 600; }
  .modal-close { background: none; border: none; color: var(--muted); font-size: 1.2rem; cursor: pointer; }
  .modal-body  { padding: 1.25rem 1.5rem; }
  .modal-img   { width: 100%; border-radius: 10px; max-height: 280px; object-fit: contain; background: var(--bg); margin-bottom: 1rem; }
  .modal-field { margin-bottom: .75rem; }
  .modal-field label { display: block; font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: .3rem; }
  .modal-field .val  {
    font-family: 'IBM Plex Mono', monospace; font-size: .78rem;
    background: var(--bg); border: 1px solid var(--border2); border-radius: 6px;
    padding: .45rem .75rem; word-break: break-all; cursor: pointer; transition: border-color .2s;
  }
  .modal-field .val:hover { border-color: var(--accent2); }
  .modal-actions { display: flex; gap: .75rem; padding: 1rem 1.5rem; border-top: 1px solid var(--border2); }

  /* Toast */
  .toast-wrap { position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 200; display: flex; flex-direction: column; gap: .5rem; }
  .toast {
    background: var(--surface); border: 1px solid var(--border2); border-radius: 10px;
    padding: .75rem 1.1rem; font-size: .82rem; max-width: 320px;
    box-shadow: 0 8px 32px rgba(0,0,0,.5); display: flex; align-items: center; gap: .6rem;
    animation: slideIn .2s ease;
  }
  .toast.success { border-color: rgba(74,222,128,.4); }
  .toast.error   { border-color: rgba(248,113,113,.4); }
  @keyframes slideIn { from { opacity:0; transform: translateX(20px); } to { opacity:1; transform: none; } }

  /* API Key banner */
  .api-key-row {
    display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
    background: var(--surface); border: 1px solid var(--border2);
    border-radius: 10px; padding: .75rem 1rem; margin-bottom: 2rem;
  }
  .api-key-row label { font-size: .75rem; color: var(--muted); white-space: nowrap; }
  .api-key-input {
    flex: 1; min-width: 160px; background: var(--bg); border: 1px solid var(--border2);
    border-radius: 6px; padding: .45rem .75rem; color: var(--text);
    font-family: 'IBM Plex Mono', monospace; font-size: .8rem; outline: none;
  }
  .api-key-input:focus { border-color: var(--accent); }

  /* DB status */
  .db-badges { display: flex; gap: .5rem; flex-wrap: wrap; }
  .db-badge {
    font-size: .7rem; font-family: 'IBM Plex Mono', monospace;
    padding: .25rem .6rem; border-radius: 5px;
    border: 1px solid var(--border2); color: var(--muted);
  }
  .db-badge.active { border-color: rgba(74,222,128,.4); color: var(--green); }

  @media(max-width:600px) {
    .upload-meta { grid-template-columns: 1fr; }
    .tester-row  { flex-direction: column; align-items: stretch; }
    .stats-row   { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="header">
    <div class="logo">
      <div class="logo-icon">📦</div>
      <div class="logo-text">
        <h1>TeleStore</h1>
        <p>telegram × cloudflare image host</p>
      </div>
    </div>
    <div class="status-dot">
      <div class="dot" id="statusDot"></div>
      <span id="statusText">checking…</span>
    </div>
  </div>

  <!-- API Key -->
  <div class="api-key-row">
    <label>🔑 API KEY</label>
    <input class="api-key-input" id="apiKey" type="password" placeholder="your API key (leave blank if none)">
    <button class="btn btn-ghost btn-sm" onclick="saveKey()">Save</button>
    <span id="keyStatus" style="font-size:.75rem;color:var(--muted)"></span>
  </div>

  <!-- Stats -->
  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-label">Total Images</div>
      <div class="stat-value purple" id="statTotal">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">TG Backups</div>
      <div class="stat-value blue" id="statBackupCh">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">DB Replicas</div>
      <div class="stat-value orange" id="statDbs">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Service</div>
      <div class="stat-value green" id="statSvc">—</div>
    </div>
  </div>

  <!-- DB Status -->
  <div class="section">
    <div class="section-title">Database Bindings</div>
    <div class="db-badges" id="dbBadges">
      <div class="db-badge">loading…</div>
    </div>
  </div>

  <!-- Upload -->
  <div class="section">
    <div class="section-title">Upload Image</div>
    <div class="upload-zone" id="dropZone">
      <input type="file" id="fileInput" accept="image/*">
      <span class="upload-icon">🖼️</span>
      <h3>Drop image here or click to browse</h3>
      <p>JPEG · PNG · GIF · WebP · SVG &nbsp;·&nbsp; max ${CONFIG.MAX_FILE_SIZE_MB}MB</p>
    </div>
    <div class="upload-meta">
      <input type="text" id="uploadTags" placeholder="Tags  e.g. nature, cats">
      <input type="text" id="uploadMeta" placeholder='Meta JSON  e.g. {"author":"me"}'>
    </div>
    <div class="upload-actions">
      <button class="btn btn-primary" id="uploadBtn" onclick="doUpload()" disabled>⬆ Upload</button>
      <button class="btn btn-ghost" onclick="clearUpload()">Clear</button>
      <span id="uploadFileName" style="font-size:.8rem;color:var(--muted);font-family:'IBM Plex Mono',monospace"></span>
    </div>
    <div class="progress-wrap" id="progressWrap">
      <div class="progress-bar-bg"><div class="progress-bar" id="progressBar"></div></div>
      <div class="progress-label" id="progressLabel">Uploading…</div>
    </div>
    <div class="result-box" id="resultBox">
      <div class="result-header" id="resultHeader"></div>
      <div class="result-body" id="resultBody"></div>
    </div>
  </div>

  <!-- Gallery -->
  <div class="section">
    <div class="section-title">Image Gallery</div>
    <div class="gallery-toolbar">
      <input type="text" id="filterTag" placeholder="Filter by tag…" oninput="filterGallery(this.value)">
      <button class="btn btn-ghost btn-sm" onclick="loadGallery()">↻ Refresh</button>
    </div>
    <div class="gallery" id="gallery">
      <div class="gallery-empty">No images yet. Upload one above!</div>
    </div>
    <div class="gallery-load" id="galleryLoad" style="display:none">
      <button class="btn btn-ghost btn-sm" onclick="loadMore()">Load more</button>
    </div>
  </div>

  <!-- API Tester -->
  <div class="section">
    <div class="section-title">API Tester</div>
    <div style="display:flex;flex-direction:column;gap:.5rem">

      <div class="tester-row">
        <span class="method-badge m-get">GET</span>
        <input class="tester-url" id="t_health" value="/health" readonly>
        <button class="btn btn-ghost btn-sm" onclick="ttest('GET','t_health','r_health')">Run</button>
      </div>
      <div class="response-box" id="r_health"></div>

      <div class="tester-row">
        <span class="method-badge m-get">GET</span>
        <input class="tester-url" id="t_stats" value="/stats" readonly>
        <button class="btn btn-ghost btn-sm" onclick="ttest('GET','t_stats','r_stats')">Run</button>
      </div>
      <div class="response-box" id="r_stats"></div>

      <div class="tester-row">
        <span class="method-badge m-get">GET</span>
        <input class="tester-url" id="t_list" value="/list?limit=5">
        <button class="btn btn-ghost btn-sm" onclick="ttest('GET','t_list','r_list')">Run</button>
      </div>
      <div class="response-box" id="r_list"></div>

      <div class="tester-row">
        <span class="method-badge m-get">GET</span>
        <input class="tester-url" id="t_info" placeholder="/info/{id}">
        <button class="btn btn-ghost btn-sm" onclick="ttest('GET','t_info','r_info')">Run</button>
      </div>
      <div class="response-box" id="r_info"></div>

      <div class="tester-row">
        <span class="method-badge m-delete">DELETE</span>
        <input class="tester-url" id="t_del" placeholder="/delete/{id}">
        <button class="btn btn-danger btn-sm" onclick="ttest('DELETE','t_del','r_del')">Run</button>
      </div>
      <div class="response-box" id="r_del"></div>

    </div>
  </div>

</div>

<!-- Modal -->
<div class="modal-overlay" id="modal" onclick="closeModal(event)">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modalTitle">Image</h3>
      <button class="modal-close" onclick="closeModalBtn()">✕</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-actions" id="modalActions"></div>
  </div>
</div>

<!-- Toasts -->
<div class="toast-wrap" id="toastWrap"></div>

<script>
const BASE = '${base}';
let galleryOffset = 0;
let galleryTag = null;
const PAGE = 20;

// ── Helpers ────────────────────────────────────────────────────────────────
function apiKey() { return localStorage.getItem('ts_apikey') || ''; }

function authHeaders() {
  const k = apiKey();
  return k ? { 'X-API-Key': k } : {};
}

function saveKey() {
  const v = document.getElementById('apiKey').value.trim();
  localStorage.setItem('ts_apikey', v);
  document.getElementById('keyStatus').textContent = v ? '✓ saved' : 'cleared';
  setTimeout(() => document.getElementById('keyStatus').textContent = '', 2000);
}

function toast(msg, type='success') {
  const w = document.getElementById('toastWrap');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = (type==='success'?'✓':'✕') + ' ' + msg;
  w.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function copyText(text, label) {
  navigator.clipboard.writeText(text).then(() => toast(label + ' copied!')).catch(() => {});
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1024/1024).toFixed(2) + ' MB';
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString();
}

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('apiKey').value = apiKey();
  checkHealth();
  loadStats();
  loadGallery();
  setupDrop();
});

// ── Health / Stats ─────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const r = await fetch(BASE + '/health');
    const d = await r.json();
    const dot  = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    if (d.status === 'ok') {
      dot.className = 'dot online';
      text.textContent = 'online · v' + (d.version||'?');
      document.getElementById('statSvc').textContent = 'UP';
    } else throw new Error();
  } catch {
    document.getElementById('statusDot').className = 'dot offline';
    document.getElementById('statusText').textContent = 'offline';
    document.getElementById('statSvc').textContent = 'DOWN';
  }
}

async function loadStats() {
  try {
    const r = await fetch(BASE + '/stats', { headers: authHeaders() });
    const d = await r.json();
    document.getElementById('statTotal').textContent     = d.total_images ?? '—';
    document.getElementById('statBackupCh').textContent  = d.telegram?.backup_channels ?? '—';
    document.getElementById('statDbs').textContent       = d.databases?.total ?? '—';

    const dbs = d.databases || {};
    document.getElementById('dbBadges').innerHTML = [
      ['Primary (DB)',        dbs.primary],
      ['Backup 1 (DB_BACKUP)',dbs.backup_1],
      ['Backup 2 (DB_BACKUP2)',dbs.backup_2],
    ].map(([n,v]) =>
      \`<div class="db-badge \${v?'active':''}">\${v?'✓':'✗'} \${n}</div>\`
    ).join('');
  } catch(e) {
    console.warn('Stats error', e);
  }
}

// ── File Drop & Select ─────────────────────────────────────────────────────
function setupDrop() {
  const zone = document.getElementById('dropZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', ()=> zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  document.getElementById('fileInput').addEventListener('change', e => {
    if (e.target.files[0]) setFile(e.target.files[0]);
  });
}

let selectedFile = null;
function setFile(f) {
  selectedFile = f;
  document.getElementById('uploadFileName').textContent = f.name + '  (' + fmtSize(f.size) + ')';
  document.getElementById('uploadBtn').disabled = false;
  document.getElementById('resultBox').className = 'result-box';
}
function clearUpload() {
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('uploadFileName').textContent = '';
  document.getElementById('uploadBtn').disabled = true;
  document.getElementById('resultBox').className = 'result-box';
  document.getElementById('progressWrap').className = 'progress-wrap';
}

// ── Upload ─────────────────────────────────────────────────────────────────
async function doUpload() {
  if (!selectedFile) return;
  const btn = document.getElementById('uploadBtn');
  btn.disabled = true;

  const pw = document.getElementById('progressWrap');
  const pb = document.getElementById('progressBar');
  const pl = document.getElementById('progressLabel');
  pw.className = 'progress-wrap show';
  pb.style.width = '20%';
  pl.textContent = 'Uploading to Telegram…';

  const fd = new FormData();
  fd.append('file', selectedFile);
  const tags = document.getElementById('uploadTags').value.trim();
  const meta = document.getElementById('uploadMeta').value.trim();
  if (tags) fd.append('tags', tags);
  if (meta) fd.append('meta', meta);

  const headers = authHeaders();
  const rb  = document.getElementById('resultBox');
  const rh  = document.getElementById('resultHeader');
  const rbd = document.getElementById('resultBody');

  try {
    pb.style.width = '60%';
    const res = await fetch(BASE + '/upload', { method: 'POST', headers, body: fd });
    pb.style.width = '100%';
    pl.textContent = 'Done!';
    const data = await res.json();

    if (res.ok && data.success) {
      rh.className = 'result-header success';
      rh.innerHTML = '✓ Uploaded · <b>' + data.id + '</b> · ' + fmtSize(data.size);
      rbd.innerHTML = \`
        <div class="result-img-wrap">
          <img class="result-thumb" src="\${data.proxy_url}" onerror="this.style.display='none'" alt="">
          <div class="result-links">
            <div class="result-link" onclick="copyText('\${data.proxy_url}','Proxy URL')">
              <span>🔗 \${data.proxy_url}</span><span class="copy-icon">⧉</span>
            </div>
            <div class="result-link" onclick="copyText('\${data.url}','CDN URL')">
              <span>⚡ \${data.url}</span><span class="copy-icon">⧉</span>
            </div>
          </div>
        </div>
      \`;
      rb.className = 'result-box show success';
      toast('Uploaded! ID: ' + data.id);
      loadGallery();
      loadStats();
    } else {
      throw new Error(data.error || 'Upload failed');
    }
  } catch(e) {
    pb.style.width = '100%'; pb.style.background = 'var(--red)';
    pl.textContent = 'Failed';
    rh.className = 'result-header error';
    rh.textContent = '✕ ' + e.message;
    rbd.innerHTML = '';
    rb.className = 'result-box show error';
    toast(e.message, 'error');
  }
  btn.disabled = false;
  setTimeout(() => { pw.className = 'progress-wrap'; pb.style.width='0%'; pb.style.background=''; }, 2000);
}

// ── Gallery ────────────────────────────────────────────────────────────────
async function loadGallery() {
  galleryOffset = 0;
  galleryTag    = document.getElementById('filterTag').value.trim() || null;
  const g = document.getElementById('gallery');
  g.innerHTML = '<div class="gallery-empty" style="color:var(--muted)">Loading…</div>';
  document.getElementById('galleryLoad').style.display = 'none';
  await fetchGallery(true);
}

async function loadMore() {
  await fetchGallery(false);
}

async function fetchGallery(replace) {
  try {
    const params = new URLSearchParams({ limit: PAGE, offset: galleryOffset });
    if (galleryTag) params.set('tag', galleryTag);
    const res  = await fetch(BASE + '/list?' + params, { headers: authHeaders() });
    const data = await res.json();
    const g    = document.getElementById('gallery');

    if (replace) g.innerHTML = '';
    if (!data.images?.length && replace) {
      g.innerHTML = '<div class="gallery-empty">No images yet. Upload one above!</div>';
      return;
    }

    data.images.forEach(img => {
      const item = document.createElement('div');
      item.className = 'gallery-item';
      const isImage = img.mime_type?.startsWith('image/') && img.mime_type !== 'image/svg+xml';
      item.innerHTML = \`
        \${isImage
          ? \`<img class="gallery-thumb" src="\${img.proxy_url}" loading="lazy" alt="\${img.filename}">\`
          : \`<div class="gallery-thumb-placeholder">🖼️</div>\`}
        <div class="gallery-info">
          <div class="gallery-name">\${img.filename}</div>
          <div class="gallery-size">\${fmtSize(img.size)}</div>
        </div>
        <button class="gallery-del" onclick="event.stopPropagation();deleteImage('\${img.id}')">✕</button>
      \`;
      item.addEventListener('click', () => openModal(img));
      g.appendChild(item);
    });

    galleryOffset += data.images.length;
    const loadBtn = document.getElementById('galleryLoad');
    loadBtn.style.display = galleryOffset < data.total ? 'block' : 'none';
  } catch(e) {
    console.error(e);
    toast('Failed to load gallery', 'error');
  }
}

function filterGallery(val) {
  clearTimeout(window._filterTimer);
  window._filterTimer = setTimeout(loadGallery, 350);
}

// ── Modal ──────────────────────────────────────────────────────────────────
function openModal(img) {
  document.getElementById('modalTitle').textContent = img.filename;
  const isImage = img.mime_type?.startsWith('image/') && img.mime_type !== 'image/svg+xml';
  document.getElementById('modalBody').innerHTML = \`
    \${isImage ? \`<img class="modal-img" src="\${img.proxy_url}" alt="\${img.filename}">\` : ''}
    <div class="modal-field"><label>ID</label><div class="val" onclick="copyText('\${img.id}','ID')">\${img.id}</div></div>
    <div class="modal-field"><label>Proxy URL</label><div class="val" onclick="copyText('\${img.proxy_url}','URL')">\${img.proxy_url}</div></div>
    <div class="modal-field"><label>CDN URL</label><div class="val" onclick="copyText('\${img.url}','URL')">\${img.url}</div></div>
    <div class="modal-field"><label>Size</label><div class="val">\${fmtSize(img.size)} · \${img.mime_type}</div></div>
    \${img.tags ? \`<div class="modal-field"><label>Tags</label><div class="val">\${img.tags}</div></div>\` : ''}
    <div class="modal-field"><label>Uploaded</label><div class="val">\${fmtDate(img.uploaded_at)}</div></div>
  \`;
  document.getElementById('modalActions').innerHTML = \`
    <a class="btn btn-ghost btn-sm" href="\${img.proxy_url}" target="_blank">↗ Open</a>
    <button class="btn btn-ghost btn-sm" onclick="copyText('\${img.proxy_url}','URL')">⧉ Copy URL</button>
    <button class="btn btn-danger btn-sm" onclick="deleteImage('\${img.id}');closeModalBtn()">✕ Delete</button>
  \`;
  document.getElementById('modal').classList.add('open');
}
function closeModal(e) { if (e.target.id==='modal') closeModalBtn(); }
function closeModalBtn() { document.getElementById('modal').classList.remove('open'); }

// ── Delete ─────────────────────────────────────────────────────────────────
async function deleteImage(id) {
  if (!confirm('Delete image ' + id + '? This removes it from Telegram too.')) return;
  try {
    const res = await fetch(BASE + '/delete/' + id, { method: 'DELETE', headers: authHeaders() });
    const d   = await res.json();
    if (d.deleted) { toast('Deleted ' + id); loadGallery(); loadStats(); }
    else throw new Error(d.error || 'Delete failed');
  } catch(e) { toast(e.message, 'error'); }
}

// ── API Tester ─────────────────────────────────────────────────────────────
async function ttest(method, inputId, resultId) {
  const path = document.getElementById(inputId).value.trim();
  if (!path) return;
  const el = document.getElementById(resultId);
  el.className = 'response-box show';
  el.style.color = 'var(--muted)';
  el.textContent = 'Loading…';
  try {
    const res  = await fetch(BASE + path, { method, headers: authHeaders() });
    const text = await res.text();
    let pretty;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { pretty = text; }
    el.textContent = pretty;
    el.style.color = res.ok ? 'var(--green)' : 'var(--red)';
  } catch(e) {
    el.textContent = 'Error: ' + e.message;
    el.style.color = 'var(--red)';
  }
}
</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    // Run schema migration (no-op after first run per isolate)
    ctx.waitUntil(ensureMigrated(env));
    // Also await it so first-ever request doesn't race
    await ensureMigrated(env);

    const url      = new URL(request.url);
    const path     = url.pathname;
    const method   = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization, X-Filename",
      }});
    }

    try {
      // ── Dashboard (toggled by ENABLE_DASHBOARD) ──────────────────────────
      if ((path === "/" || path === "/dashboard") && method === "GET") {
        if (isDashboardEnabled(env)) return handleDashboard(env);
        // Dashboard disabled — return plain JSON
        return jsonResp({ service: "TeleStore", version: "2.0.0", dashboard: "disabled", hint: "Set ENABLE_DASHBOARD=true to enable the UI" });
      }

      // ── API Routes ───────────────────────────────────────────────────────
      if (path === "/health"  && method === "GET")  return handleHealth(env);
      if (path === "/stats"   && method === "GET")  return handleStats(env);
      if (path === "/upload"  && method === "POST") return handleUpload(request, env);
      if (path === "/list"    && method === "GET")  return handleList(request, env);

      let m;
      if ((m = path.match(/^\/image\/([a-zA-Z0-9]+)$/))     && method === "GET")    return handleImageRedirect(m[1], env);
      if ((m = path.match(/^\/proxy\/([a-zA-Z0-9]+)$/))     && method === "GET")    return handleProxy(m[1], env);
      if ((m = path.match(/^\/info\/([a-zA-Z0-9]+)$/))      && method === "GET")    return handleInfo(m[1], env);
      if ((m = path.match(/^\/delete\/([a-zA-Z0-9]+)$/))    && method === "DELETE") return handleDelete(m[1], request, env);
      if ((m = path.match(/^\/revalidate\/([a-zA-Z0-9]+)$/))&& method === "POST")   return handleRevalidate(m[1], request, env);

      return jsonResp({ error: "Not found", path }, 404);

    } catch (err) {
      console.error("TeleStore error:", err);
      return jsonResp({ error: "Internal server error", message: err.message }, 500);
    }
  },
};
