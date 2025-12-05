# Next Steps

- Refresh data: run `pnpm scrape` and confirm `data/events.db` is populated; spot-check `/debug` from `pnpm dev:api`.
- Supabase sync: fill `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`, then run `pnpm scrape:sync` to push the current SQLite contents.
- Source upkeep: keep `SCRAPING_NOTES.md` updated when adding or pausing scrapers; prefer `pnpm scrape:one <source>` while iterating.
- Data export: if sharing data externally, run `pnpm build:dataset` after a fresh scrape and stash the artifact.
- Reliability: add lightweight checks around scrapers (e.g., assert non-empty results per site and log diffs when counts drop).
