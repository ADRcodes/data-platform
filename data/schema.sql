-- --- SQLite pragmas for better durability + concurrency
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- --- Main table
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  starts_at   TEXT,            -- ISO8601 or NULL
  ends_at     TEXT,
  description TEXT,
  price       TEXT,
  venue       TEXT,
  city        TEXT,
  url         TEXT,
  image_url   TEXT,
  tags        TEXT,            -- CSV or JSON string (keep simple for now)
  content_hash TEXT,
  updated_at  TEXT NOT NULL,
  UNIQUE(source, source_id) ON CONFLICT REPLACE
);

-- Helpful indexes for your current queries:
CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_title ON events(title);

-- Feeds you poll (Google Calendar or any .ics)
CREATE TABLE IF NOT EXISTS ics_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  url TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  last_fetch_at TEXT,
  last_status TEXT
);

-- Manual/curated links a human adds (FB, websites)
CREATE TABLE IF NOT EXISTS event_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  last_status TEXT
);


-- Optional: lightweight change tracking, if you want it later
-- CREATE TABLE IF NOT EXISTS event_changes (
--   event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
--   changed_at TEXT NOT NULL,
--   diff       TEXT NOT NULL
-- );
