# Open Regional Health

Open Regional Health is a local-first, read-only dashboard for public U.S. health data. It displays evidence for the 48 contiguous states and Washington, D.C., with source, geography, and reporting limits kept visible. It does not diagnose illness or estimate individual risk.

## Run locally

Requirements: Node.js 22 and pnpm 11.9.0. No account, API key, or hosted service is required. Internet access is needed to retrieve public data feeds.

```sh
git clone https://github.com/ayan-mishra/open-regional-health.git
cd open-regional-health
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm start
```

Open [http://localhost:3000](http://localhost:3000). `pnpm dev` starts the same local app in development mode. Stop it with Ctrl+C. Bundled reference snapshots keep their publisher dates and freshness labels; they are not automatically regenerated. Live publisher data requires internet access.

## Optional Python CLI

The Python package is a separate, Massachusetts-focused influenza forecasting and ingestion tool. It does not power the national web dashboard. Python 3.12 and [uv](https://docs.astral.sh/uv/) are required.

```sh
uv sync --locked --all-extras
uv run --locked corvid demo load
uv run --locked corvid forecast --as-of 2025-02-14T23:00:00Z
```

Demo observations are synthetic and must not be interpreted as current surveillance. Live ingestion is opt-in and fetches only the reviewed publisher feeds; see [Data sources](docs/DATA_SOURCES.md).

## Checks

```sh
pnpm --dir apps/web lint
pnpm --dir apps/web test
pnpm --dir apps/web build
uv run --locked pytest -q
uv run --locked ruff check packages tests
uv run --locked mypy packages/corvid/src
```

Docker Compose is optional: `docker compose up --build` serves the web app at [http://localhost:3000](http://localhost:3000).

## Project notes

- [Methodology](docs/METHODOLOGY.md)
- [Data catalog](docs/DATA_CATALOG.md)
- [Data sources](docs/DATA_SOURCES.md)
- [Limitations](docs/LIMITATIONS.md)
- [Coverage audit](docs/COVERAGE_AUDIT_2026-08-20.md)

Licensed under Apache-2.0; see [LICENSE](LICENSE).

Source: [ayan-mishra/open-regional-health](https://github.com/ayan-mishra/open-regional-health).
