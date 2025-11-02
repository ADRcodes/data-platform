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
