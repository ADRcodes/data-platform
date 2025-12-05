# Scraping Notes

Use this to track what we scrape and any observations while iterating.

## Active sources
- Destination St. John's — `pnpm scrape:one destinationstjohns` (core source; respects `SCRAPER_SKIP_ENRICH=1` to skip follow-up fetches when debugging)
- Majestic Theatre — `pnpm scrape:one majestic` (checks event detail pages for richer content)
- St. John's Living — `pnpm scrape:one stjohnsliving` (general community listings)
- Showpass (St. John's) — `pnpm scrape:one showpass` (filters Showpass events for the region)

## Data cadence
- Standard run: `pnpm scrape` (runs all sources, writes `data/events.db`, prunes stale per source).
- Sync only: `pnpm scrape:sync` (push existing SQLite rows to Supabase without re-scraping).

## Notes and TODOs
- Log any new candidate sites here before adding a scraper.
- If a source consistently returns zero events, capture the date and suspected cause (site change, 403, markup shift).
- When tweaking scrapers, run the single-source command first to limit traffic and speed up debugging.
