import "./env.js";
import { openDb, upsertEvents, pruneSourceEvents } from "./db.js";
import { scrapeDestinationStJohns } from "./sites/destinationstjohns.js";
import { scrapeMajestic } from "./sites/majestic.js";
import { scrapeStJohnsLiving } from "./sites/stjohnsliving.js";
import { scrapeShowpass } from "./sites/showpass.js";
import logger from "./logger.js";
import { syncRowsToSupabase } from "./supabase-sync.js";

export async function main() {
  const db = openDb();

  const [destinationRows, majesticRows, stJohnsLivingRows, showpassRows] = await Promise.all([
    scrapeDestinationStJohns(),
    scrapeMajestic(),
    scrapeStJohnsLiving(),
    scrapeShowpass()
  ]);
  const rows = [...destinationRows, ...majesticRows, ...stJohnsLivingRows, ...showpassRows];
  const countsBySource = rows.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] ?? 0) + 1;
    return acc;
  }, {});
  if (!rows.length) {
    logger.info("No events fetched; nothing to upsert.");
    pruneSourceEvents(db, "destinationstjohns", destinationRows);
    pruneSourceEvents(db, "majestic", majesticRows);
    pruneSourceEvents(db, "stjohnsliving", stJohnsLivingRows);
    pruneSourceEvents(db, "showpass", showpassRows);
    return;
  }

  upsertEvents(db, rows);
  logger.info(
    `Upserted ${rows.length} events locally. Breakdown: ${Object.entries(countsBySource)
      .map(([source, count]) => `${source}=${count}`)
      .join(", ")}`
  );

  await syncRowsToSupabase(rows);

  pruneSourceEvents(db, "destinationstjohns", destinationRows);
  pruneSourceEvents(db, "majestic", majesticRows);
  pruneSourceEvents(db, "stjohnsliving", stJohnsLivingRows);
  pruneSourceEvents(db, "showpass", showpassRows);
}
main().catch(e => {
  logger.error("Scrape failed:", e);
  process.exit(1);
});
