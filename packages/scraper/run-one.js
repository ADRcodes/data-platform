import "./env.js";
import { openDb, upsertEvents, pruneSourceEvents } from "./db.js";
import { scrapeDestinationStJohns } from "./sites/destinationstjohns.js";
import { scrapeMajestic } from "./sites/majestic.js";
import { scrapeStJohnsLiving } from "./sites/stjohnsliving.js";
import { scrapeShowpass } from "./sites/showpass.js";
import { scrapeArtsAndCultureCentre } from "./sites/artsandculturecentre.js";
import logger from "./logger.js";
import { shouldExcludeEvent } from "./scrape-helpers.js";

const sources = {
  destinationstjohns: scrapeDestinationStJohns,
  majestic: scrapeMajestic,
  stjohnsliving: scrapeStJohnsLiving,
  showpass: scrapeShowpass,
  artsandculturecentre: scrapeArtsAndCultureCentre,
};

const name = process.argv[2];
if (!name || !sources[name]) {
  logger.error("Usage: node packages/scraper/run-one.js <destinationstjohns|majestic|stjohnsliving|showpass|artsandculturecentre>");
  process.exit(1);
}

const fn = sources[name];

function shouldSkipPrune(rows) {
  return Boolean(rows?.skipped);
}

(async () => {
  const db = openDb();
  const scrapedRows = await fn();
  const rows = Array.isArray(scrapedRows) ? scrapedRows.filter(row => !shouldExcludeEvent(row)) : scrapedRows;
  if (Array.isArray(scrapedRows) && scrapedRows.length !== rows.length) {
    logger.info(`Filtered ${scrapedRows.length - rows.length} excluded events from ${name}.`);
  }
  if (rows.length) upsertEvents(db, rows);
  if (shouldSkipPrune(scrapedRows)) {
    logger.warn(`Skipping prune for ${name}${scrapedRows.skipReason ? ` (${scrapedRows.skipReason})` : ""}.`);
    return;
  }
  pruneSourceEvents(db, name, rows);
  logger.info(`Upserted ${rows.length} from ${name}`);
})();
