# Agent Guide

Brief orientation for working in this repo.

## What this project does
- Scrapes local event sources into a normalized SQLite DB at `data/events.db`.
- Optional: pushes the normalized rows to Supabase using service-role credentials.
- Exposes an Express API that reads from SQLite and serves `/events`, `/events/:id`, and `/debug`.

## Repo map
- Root scripts: `pnpm scrape`, `pnpm scrape:one <source>`, `pnpm dev:api`, `pnpm build:dataset`.
- Scraper: `packages/scraper/*` (individual site scrapers live in `packages/scraper/sites`).
- API: `packages/api/server.js` (reads `data/events.db`).
- Data: `data/events.db` (ignored by git; created by the scraper).

## Setup
1) `pnpm install`
2) `pnpm approve-builds` when prompted so `better-sqlite3` can build.
3) Copy env: `cp .env.example .env` then fill in Supabase values if you plan to sync (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
4) Ensure Node 24.x (repo enforces `engines.node`).

## Common commands (run from repo root)
- Full scrape: `pnpm scrape`
- Single source: `pnpm scrape:one destinationstjohns|majestic|stjohnsliving|showpass`
- One-off Destination St. John's scrape: `pnpm scrape:once`
- Looping scheduler: `pnpm scrape:loop`
- Sync existing SQLite rows to Supabase only: `pnpm scrape:sync`
- API dev server: `pnpm dev:api` (defaults to port 3001)
- Build derived dataset artifact: `pnpm build:dataset`

## Notes
- SQLite artifacts (`data/events.db` plus WAL/SHM) stay local and untracked.
- Supabase sync assumes target tables have `external_id` uniqueness and `event_tags` has a composite unique key on `(event_id, tag_id)`.
- Logs come from `packages/scraper/logger.js`; run scrapers in the foreground to see output.
