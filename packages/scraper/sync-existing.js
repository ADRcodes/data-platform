import "./env.js";
import { openDb, readAllEvents } from "./db.js";
import { syncRowsToSupabase } from "./supabase-sync.js";
import logger from "./logger.js";

async function main() {
  const db = openDb();
  const rows = readAllEvents(db);
  if (!rows.length) {
    logger.info("SQLite has no events; nothing to sync with Supabase.");
    return;
  }

  logger.info(`Syncing ${rows.length} existing events from SQLite to Supabase…`);
  const result = await syncRowsToSupabase(rows);
  if (result?.synced) {
    logger.info("Supabase sync complete.");
  } else {
    const reason = result?.reason ?? "unknown_reason";
    logger.warn(`Supabase sync skipped (${reason}).`);
  }
}

main().catch((err) => {
  logger.error("Existing data sync failed:", err);
  process.exit(1);
});
