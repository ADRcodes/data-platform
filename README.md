# data-platform

Small event-scraping + API project. This repository includes two packages in a pnpm workspace:

- `@dp/scraper` — scrapes remote event pages and writes a local SQLite database at `data/events.db`.
- `@dp/api` — a tiny Express API that reads `data/events.db` and exposes `/events`, `/events/:id`, and `/debug`.

## Prerequisites

- Node.js (recommend v20.x)
- pnpm (the repo uses pnpm as the package manager)
- A C/C++ toolchain for native modules (macOS: Xcode command line tools)

## Quick start

1. Install dependencies:

```bash
# install pnpm if you haven't already
npm install -g pnpm

pnpm install
```

2. Approve native builds (pnpm blocks lifecycle scripts by default). When prompted run:

```bash
pnpm approve-builds
# approve `better-sqlite3` when prompted so the native module can be built
```

3. Create/populate the database by running the scraper:

```bash
pnpm scrape
```

4. Start the API server:

```bash
pnpm dev:api
# open http://localhost:3001/debug or http://localhost:3001/events
```

### Syncing directly to Supabase

The scraper now optionally pushes the normalized events into your Supabase project. Configure credentials once and every `pnpm scrape` run will:

1. Run the three scrapers (`Destination St. John's`, `Majestic`, `St. John's Living`).
2. Upsert venues, organizers, tags, events, and `event_tags` rows via the Supabase service-role key.
3. Remove stale events (and their tag links) for each source to keep Supabase in sync with the upstream sites.

Setup:

```bash
cp .env.example .env
# edit .env and add your Supabase project values
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Already have fresh rows in `data/events.db` and only want to re-sync them without hitting the remote sites again? Run:

```bash
pnpm scrape:sync
```

That command reads every row from SQLite and pushes them to Supabase using the same normalization/upsert logic as the scraper.

The tables must have an `external_id` column with a unique constraint (events, venues, organizers, tags) plus the `event_tags` join table should have a composite unique key on `(event_id, tag_id)`. The scraper derives deterministic `external_id` values from the source payloads so rerunning the scraper is idempotent. User-owned tables such as `saved_events` or `user_tag_preferences` are never touched.

## Notes and troubleshooting

- The runtime SQLite database (`data/events.db`) and its WAL/SHM files are ignored by `.gitignore` and should not be committed. If they were previously committed, the repository history may still contain them; this repo has been cleaned to remove those blobs from history.
- If `pnpm scrape` errors with `better-sqlite3` ABI/native build issues, re-run `pnpm install` and approve builds, or rebuild the native module:

```bash
pnpm rebuild better-sqlite3
```

- If you prefer HTTPS for Git pushes, upgrade Git on macOS (Homebrew recommended) to avoid HTTP/2-related push issues. Alternatively, SSH-based pushes are already configured and working.

## Development tips

- To run the scraper once locally:
	- `pnpm --filter @dp/scraper run once`
- The API is intentionally tiny and reads the same `data/events.db` file the scraper writes.
- For schema changes, consider a small migrations system (SQL files run in order) instead of ad-hoc ALTERs.

## License / acknowledgements

Small personal project.

---

If anything above is unclear, or you want me to add a GitHub Actions workflow to run a smoke test and lint on push, tell me and I’ll add it.
