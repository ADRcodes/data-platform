import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.resolve(ROOT_DIR, "data");
const DB_PATH = path.resolve(DATA_DIR, "events.db");
const SCHEMA_PATH = path.resolve(DATA_DIR, "schema.sql");

export function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const firstTime = !fs.existsSync(DB_PATH);
  const db = new Database(DB_PATH);

  // Make sure these are set regardless of firstTime
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  if (firstTime) {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    db.exec(schema);
  } else {
    const columns = db.prepare("PRAGMA table_info(events)").all();
    if (!columns.some(col => col.name === "content_hash")) {
      db.exec("ALTER TABLE events ADD COLUMN content_hash TEXT");
    }
    if (!columns.some(col => col.name === "price")) {
      db.exec("ALTER TABLE events ADD COLUMN price TEXT");
    }

    // Ensure auxiliary tables exist for admin workflows (ICS feeds, manual links)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ics_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT,
        url TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        last_fetch_at TEXT,
        last_status TEXT
      );

      CREATE TABLE IF NOT EXISTS event_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_checked_at TEXT,
        last_status TEXT
      );
    `);
  }
  return db;
}

export function upsertEvents(db, rows) {
  const sel = db.prepare("SELECT content_hash FROM events WHERE source=@source AND source_id=@source_id");
  const insert = db.prepare(`
    INSERT INTO events
      (source, source_id, title, starts_at, ends_at, venue, city, url, image_url, description, price, tags, content_hash, updated_at)
    VALUES
      (@source, @source_id, @title, @starts_at, @ends_at, @venue, @city, @url, @image_url, @description, @price, @tags, @content_hash, datetime('now'))
    ON CONFLICT(source, source_id) DO UPDATE SET
      title=excluded.title,
      starts_at=excluded.starts_at,
      ends_at=excluded.ends_at,
      venue=excluded.venue,
      city=excluded.city,
      url=excluded.url,
      image_url=excluded.image_url,
      description=excluded.description,
      price=excluded.price,
      tags=excluded.tags,
      content_hash=excluded.content_hash,
      updated_at=datetime('now')
  `);

  const tx = db.transaction(batch => {
    for (const r of batch) {
      const row = { ...r, price: r.price ?? null };
      const existing = sel.get({ source: row.source, source_id: row.source_id });
      if (existing && existing.content_hash === row.content_hash) continue;
      insert.run(row);
    }
  });
  tx(rows);
}

export function pruneSourceEvents(db, source, rows = []) {
  if (!source) return;
  const ids = rows.map(r => r.source_id).filter(Boolean);
  if (!ids.length) {
    db.prepare("DELETE FROM events WHERE source = @source").run({ source });
    return;
  }
  const params = { source };
  const placeholders = ids.map((id, idx) => {
    const key = `id${idx}`;
    params[key] = id;
    return `@${key}`;
  });
  const sql = `
    DELETE FROM events
    WHERE source = @source
      AND source_id NOT IN (${placeholders.join(", ")})
  `;
  db.prepare(sql).run(params);
}
