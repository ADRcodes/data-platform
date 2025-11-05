import "dotenv/config";
import { openDb, upsertEvents } from "./db.js";
import { scrapeDestinationStJohns } from "./sites/destinationstjohns.js";
import logger from "./logger.js";

const db = openDb();
const rows = await scrapeDestinationStJohns();
upsertEvents(db, rows);
logger.info(`Upserted ${rows.length} events from Destination St. John's.`);
