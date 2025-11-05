import "dotenv/config";
import { main as runScrape } from "./index.js";
import logger from "./logger.js";

const fallbackInterval = 24 * 60 * 60 * 1000;
const configured = Number.parseInt(process.env.INTERVAL_MS ?? process.env.SCRAPER_INTERVAL_MS ?? "", 10);
const intervalMs = Number.isFinite(configured) && configured > 0 ? configured : fallbackInterval;

async function loop() {
  while (true) {
    try {
      await runScrape();
    } catch (e) {
      logger.error("scrape failed:", e);
    }
    logger.info(`Waiting ${Math.round(intervalMs / 1000 / 60)} minutes before the next scrape.`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

logger.info(`Starting scraper loop with interval ${intervalMs}ms.`);
loop();
