import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { scrapeDestinationStJohns } from "../packages/scraper/sites/destinationstjohns.js";
import { scrapeMajestic } from "../packages/scraper/sites/majestic.js";
import { scrapeStJohnsLiving } from "../packages/scraper/sites/stjohnsliving.js";
import { fetchIcs } from "../packages/scraper/ics.js";
import logger from "../packages/scraper/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FRONTEND_ROOT = process.env.FE_FRONTEND_ROOT
  ? path.resolve(process.env.FE_FRONTEND_ROOT)
  : path.resolve(__dirname, "..", "frontend");
const OUT_DIR = process.env.FE_EVENTS_DIR
  ? path.resolve(process.env.FE_EVENTS_DIR)
  : path.join(FRONTEND_ROOT, "public", "data");
const OUT_JSON = path.join(OUT_DIR, "events.json");
const OUT_GZ = path.join(OUT_DIR, "events.json.gz");

const ICS_SOURCES = (process.env.DAILY_ICS_URLS ?? "")
  .split(/[,\n]/)
  .map((v) => v.trim())
  .filter(Boolean);

const DEFAULT_CITY = process.env.DEFAULT_ICS_CITY?.trim() || null;

async function scrapeAllSites() {
  const tasks = [
    scrapeDestinationStJohns(),
    scrapeMajestic(),
    scrapeStJohnsLiving(),
  ];

  if (ICS_SOURCES.length) {
    for (const url of ICS_SOURCES) {
      tasks.push(
        fetchIcs(url, null, DEFAULT_CITY)
          .then((rows) => rows.map((row) => ({ ...row, source: row.source ?? "ics" })))
          .catch((error) => {
            logger.warn(`Daily ICS fetch failed for ${url}:`, error?.message ?? error);
            return [];
          })
      );
    }
  }

  const results = await Promise.all(tasks);
  const rows = results.flat();

  rows.sort((a, b) => {
    const left = a.starts_at ?? "";
    const right = b.starts_at ?? "";
    if (left === right) return (a.title ?? "").localeCompare(b.title ?? "");
    return left.localeCompare(right);
  });

  return rows;
}

function atomicWrite(filePath, buffer) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, filePath);
}

async function buildDataset() {
  logger.info("Running daily scrape");
  const rows = await scrapeAllSites();
  logger.info(`Scraped ${rows.length} rows`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const payload = {
    generated_at: new Date().toISOString(),
    count: rows.length,
    rows,
  };

  const jsonBuffer = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  const gzBuffer = zlib.gzipSync(jsonBuffer);

  atomicWrite(OUT_JSON, jsonBuffer);
  atomicWrite(OUT_GZ, gzBuffer);

  logger.info(`Wrote ${OUT_JSON}`);
  logger.info(`Wrote ${OUT_GZ}`);
}

buildDataset().catch((error) => {
  console.error("Daily dataset build failed", error);
  process.exit(1);
});
