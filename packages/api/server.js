import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const app = express();
app.use(cors());
app.use(express.json());

// Point at the same SQLite file the scraper uses (root `data/events.db`)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.resolve(ROOT_DIR, "data");
const DB_PATH = path.resolve(DATA_DIR, "events.db");
if (!fs.existsSync(DATA_DIR)) {
  console.error(`Data directory does not exist: ${DATA_DIR}`);
  console.error("Run `pnpm scrape` to create the database (this will create the root data directory and events.db).");
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`Database file not found: ${DB_PATH}`);
  console.error("Run `pnpm scrape` to populate the database before starting the API.");
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

// JSON health check
app.get("/health", (_req, res) => res.json({ ok: true }));

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function cleanLike(s) { return s.replace(/%/g, "\\%").replace(/_/g, "\\_"); } // basic LIKE escape

// JSON API: /events?from=YYYY-MM-DD&to=YYYY-MM-DD&source=majestic&q=theatre&limit=50&offset=0
app.get("/events", (req, res) => {
  let { from, to, source, q, limit = "100", offset = "0" } = req.query;

  // Validation & normalization
  if (from && !isIsoDate(from)) from = undefined;
  if (to && !isIsoDate(to)) to = undefined;
  if (source && typeof source !== "string") source = undefined;

  const where = [];
  const params = {};

  if (from) { where.push("datetime(starts_at) >= datetime(@from)"); params.from = `${from} 00:00:00`; }
  if (to) { where.push("datetime(starts_at) <= datetime(@to)"); params.to = `${to} 23:59:59`; }
  if (source) { where.push("source = @source"); params.source = source; }
  if (q && typeof q === "string") {
    const safe = `%${cleanLike(q)}%`;
    where.push("(title LIKE @q ESCAPE '\\' OR venue LIKE @q ESCAPE '\\')");
    params.q = safe;
  }

  limit = clamp(parseInt(limit, 10) || 100, 1, 200);
  offset = Math.max(parseInt(offset, 10) || 0, 0);

  const sql = `
    SELECT id, source, source_id, title, starts_at, ends_at, venue, city, url, image_url, description, tags
    FROM events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY datetime(starts_at) ASC
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(sql).all({ ...params, limit, offset });

  // cache hint
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ count: rows.length, rows });
});

// JSON: single event by id
app.get("/events/:id", (req, res) => {
  const row = db.prepare(`
    SELECT id, source, source_id, title, starts_at, ends_at, venue, city, url, image_url, description, tags
    FROM events WHERE id = @id
  `).get({ id: req.params.id });
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// Tiny HTML viewer (no React): /debug
app.get("/debug", (_req, res) => {
  const rows = db.prepare(`
    SELECT id, source, title, starts_at, venue, url
    FROM events
    ORDER BY datetime(starts_at) ASC
    LIMIT 200
  `).all();

  const tr = rows.map(r => `
    <tr>
      <td>${r.id}</td>
      <td>${r.source}</td>
      <td>${escapeHtml(r.title)}</td>
      <td>${r.starts_at ?? ""}</td>
      <td>${escapeHtml(r.venue ?? "")}</td>
      <td><a href="${r.url}" target="_blank">link</a></td>
    </tr>
  `).join("");

  res.type("html").send(`<!doctype html>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Events (debug)</title>
    <style>
      body{font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:16px}
      table{border-collapse: collapse; width:100%}
      th,td{border:1px solid #ddd; padding:8px; font-size:14px}
      th{background:#f5f5f5; text-align:left; position:sticky; top:0}
      tr:nth-child(even){background:#fafafa}
    </style>
    <h1>Events (first 200)</h1>
    <p>Try the JSON API at <code>/events</code> and filters like <code>?source=majestic</code>, <code>?q=market</code>, <code>?from=2025-10-01&to=2025-10-31</code>.</p>
    <table>
      <thead>
        <tr><th>ID</th><th>Source</th><th>Title</th><th>Starts</th><th>Venue</th><th>URL</th></tr>
      </thead>
      <tbody>${tr}</tbody>
    </table>`);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

const port = 3001;
app.listen(port, () => console.log(`API on http://localhost:${port} — open /debug and /events`));
