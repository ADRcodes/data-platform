import { openDb, upsertEvents } from "./db.js";
import { scrapeDestinationStJohns } from "./sites/destinationstjohns.js";
import { scrapeMajestic } from "./sites/majestic.js";

export async function main() {
  const db = openDb();
  const [a, b] = await Promise.all([
    scrapeDestinationStJohns(),
    scrapeMajestic()
  ]);
  const rows = [...a, ...b];
  if (rows.length) upsertEvents(db, rows);
  console.log(`Upserted ${rows.length} events.`);
}
main().catch(e => { console.error(e); process.exit(1); });
