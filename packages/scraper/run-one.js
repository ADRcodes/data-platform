import "./env.js";
import { openDb, upsertEvents, pruneSourceEvents } from "./db.js";
import { scrapeDestinationStJohns } from "./sites/destinationstjohns.js";
import { scrapeMajestic } from "./sites/majestic.js";
import { scrapeStJohnsLiving } from "./sites/stjohnsliving.js";
import logger from "./logger.js";

const sources = {
  destinationstjohns: scrapeDestinationStJohns,
  majestic: scrapeMajestic,
  stjohnsliving: scrapeStJohnsLiving,
};

const name = process.argv[2];
if (!name || !sources[name]) {
  logger.error("Usage: node packages/scraper/run-one.js <destinationstjohns|majestic|stjohnsliving>");
  process.exit(1);
}

const fn = sources[name];

(async () => {
  const db = openDb();
  const rows = await fn();
  if (rows.length) upsertEvents(db, rows);
  pruneSourceEvents(db, name, rows);
  logger.info(`Upserted ${rows.length} from ${name}`);
})();
