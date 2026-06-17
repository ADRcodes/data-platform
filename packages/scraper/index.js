import "./env.js";
import { openDb, upsertEvents, pruneSourceEvents } from "./db.js";
import { scrapeDestinationStJohns } from "./sites/destinationstjohns.js";
import { scrapeMajestic } from "./sites/majestic.js";
import { scrapeStJohnsLiving } from "./sites/stjohnsliving.js";
import { scrapeShowpass } from "./sites/showpass.js";
import { scrapeArtsAndCultureCentre } from "./sites/artsandculturecentre.js";
import logger from "./logger.js";
import { syncRowsToSupabase } from "./supabase-sync.js";
import { shouldExcludeEvent } from "./scrape-helpers.js";

async function runSource(name, scraper) {
  const rows = await scraper();
  const filteredRows = Array.isArray(rows) ? rows.filter(row => !shouldExcludeEvent(row)) : rows;
  if (Array.isArray(rows) && rows.length !== filteredRows.length) {
    logger.info(`Filtered ${rows.length - filteredRows.length} excluded events from ${name}.`);
  }
  return {
    name,
    rows: filteredRows,
    skipped: Boolean(rows?.skipped),
    skipReason: rows?.skipReason ?? null,
  };
}

export async function main() {
  const db = openDb();

  const [destination, majestic, stJohnsLiving, showpass, artsAndCultureCentre] = await Promise.all([
    runSource("destinationstjohns", scrapeDestinationStJohns),
    runSource("majestic", scrapeMajestic),
    runSource("stjohnsliving", scrapeStJohnsLiving),
    runSource("showpass", scrapeShowpass),
    runSource("artsandculturecentre", scrapeArtsAndCultureCentre)
  ]);
  const sourceResults = [destination, majestic, stJohnsLiving, showpass, artsAndCultureCentre];
  const rows = sourceResults.flatMap(result => result.rows);
  const countsBySource = rows.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] ?? 0) + 1;
    return acc;
  }, {});
  if (!rows.length) {
    logger.info("No events fetched; nothing to upsert.");
    for (const result of sourceResults) {
      if (result.skipped) {
        logger.warn(`Skipping prune for ${result.name}${result.skipReason ? ` (${result.skipReason})` : ""}.`);
        continue;
      }
      pruneSourceEvents(db, result.name, result.rows);
    }
    return;
  }

  upsertEvents(db, rows);
  logger.info(
    `Upserted ${rows.length} events locally. Breakdown: ${Object.entries(countsBySource)
      .map(([source, count]) => `${source}=${count}`)
      .join(", ")}`
  );

  await syncRowsToSupabase(rows);

  for (const result of sourceResults) {
    if (result.skipped) {
      logger.warn(`Skipping prune for ${result.name}${result.skipReason ? ` (${result.skipReason})` : ""}.`);
      continue;
    }
    pruneSourceEvents(db, result.name, result.rows);
  }
}
main().catch(e => {
  logger.error("Scrape failed:", e);
  process.exit(1);
});
