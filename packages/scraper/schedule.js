import { main as runScrape } from "./index.js";

async function loop() {
  while (true) {
    try { await runScrape(); }
    catch (e) { console.error("scrape failed:", e?.message); }
    await new Promise(r => setTimeout(r, 24 * 60 * 60 * 1000)); // 24 hours
  }
}
loop();
