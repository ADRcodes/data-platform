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
  }
  return db;
}

export function upsertEvents(db, rows) {
  const insert = db.prepare(`
    INSERT INTO events
      (source, source_id, title, starts_at, ends_at, description, venue, city, url, image_url, tags, updated_at)
    VALUES
      (@source, @source_id, @title, @starts_at, @ends_at, @description, @venue, @city, @url, @image_url, @tags, datetime('now'))
    ON CONFLICT(source, source_id) DO UPDATE SET
      title=excluded.title,
      starts_at=excluded.starts_at,
      ends_at=excluded.ends_at,
      venue=excluded.venue,
      city=excluded.city,
      url=excluded.url,
      image_url=excluded.image_url,
      description=excluded.description,
      tags=excluded.tags,
      updated_at=datetime('now')
  `);
  const tx = db.transaction(batch => batch.forEach(r => insert.run(r)));
  tx(rows);
}
