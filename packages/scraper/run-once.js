import { openDb, upsertEvents } from "./db.js";
import { scrapeDestinationStJohns } from "./sites/destinationstjohns.js";

const db = openDb();
const rows = await scrapeDestinationStJohns();
upsertEvents(db, rows);
console.log(`Upserted ${rows.length} events from Destination St. John's.`);
