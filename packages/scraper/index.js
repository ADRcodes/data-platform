import "dotenv/config";
import { openDb, upsertEvents, pruneSourceEvents } from "./db.js";
import { scrapeDestinationStJohns } from "./sites/destinationstjohns.js";
import { scrapeMajestic } from "./sites/majestic.js";
import { scrapeStJohnsLiving } from "./sites/stjohnsliving.js";
import logger from "./logger.js";

export async function main() {
  const db = openDb();

  const [destinationRows, majesticRows, stJohnsLivingRows] = await Promise.all([
    scrapeDestinationStJohns(),
    scrapeMajestic(),
    scrapeStJohnsLiving()
  ]);
  const rows = [...destinationRows, ...majesticRows, ...stJohnsLivingRows];
  const countsBySource = rows.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] ?? 0) + 1;
    return acc;
  }, {});
  if (rows.length) {
    upsertEvents(db, rows);
    logger.info(
      `Upserted ${rows.length} events. Breakdown: ${Object.entries(countsBySource)
        .map(([source, count]) => `${source}=${count}`)
        .join(", ")}`
    );
  } else {
    logger.info("No events fetched; nothing to upsert.");
  }
  pruneSourceEvents(db, "destinationstjohns", destinationRows);
  pruneSourceEvents(db, "majestic", majesticRows);
  pruneSourceEvents(db, "stjohnsliving", stJohnsLivingRows);
}
main().catch(e => {
  logger.error("Scrape failed:", e);
  process.exit(1);
});
