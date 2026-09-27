# National coverage audit — 2026-08-20

This audit covers every signal in the Corvid national catalog and every supported county or county-equivalent. The audited base feed was retrieved at `2026-08-20T08:44:44.557Z`, returned `current`, and contained no source errors. County detail was reconstructed from per-state outlooks retrieved between `2026-08-20T10:03Z` and `2026-08-20T10:41Z` (local), as explained below.

## Why county detail needed reconstruction

The national feed endpoint no longer carries county-level detail: `computeNationalFeed` in `apps/web/lib/national-live.ts` requests state-scoped outlooks, so the base feed's county payload is empty by design. A base-feed-only audit would therefore report `0/3,109` counties for every signal and wrongly flag the three wastewater WVAL signals for removal (they are state-null by design and live on their county coverage).

This audit instead fetched the public per-state outlook for every signal/state pair — 40 signals × 49 jurisdictions = 1,960 requests against `/api/national/outlook?signal=<id>&state=<code>` — merged the returned detail readings into the base feed, and ran the unchanged `scripts/audit-national-coverage.mjs` against the merged file. One gap: `influenza-a-wval` for Kentucky returned HTTP 429 after four backoff retries and is excluded (at most a handful of WVAL service sites).

## Decision rule

Corvid supports the 48 contiguous states plus the District of Columbia: 49 jurisdictions and 3,109 current Census county/county-equivalent geometries. Alaska, Hawaii, and territories are outside this release.

A signal is removed only when source-valid observations are missing for at least 90% of both levels:

- no more than 4 of 49 supported jurisdictions have data; and
- no more than 310 of 3,109 supported counties have data.

The audit counts a county once per signal, prefers an exact publisher FIPS when one exists, and otherwise matches a publisher's county/service-area names to current Census geometry. State-only sources are not copied into counties. Site-level wastewater values remain site observations mapped to publisher-listed service counties; they are not averaged into invented state values.

## Outcome

One signal fails the rule as audited: **Air quality (`air-quality`)** — 0/49 source-valid states and 84/3,109 source-valid counties (97.3% missing). Its county coverage is essentially unchanged from 2026-08-10 (80 → 84 counties), but state-level coverage collapsed from 36/49 to 0/49: every state reported "AirNow has no current, valid monitor AQI for this state." Every other signal keeps.

**Root cause found and fixed (2026-08-20, same day):** not a state-aggregation bug — the FIPS→state rollup in `airQualityOutlook()` (`apps/web/lib/national-live.ts`) was verified correct against the live AirNow feed. The actual cause was `publicText()`'s cache TTL: AirNow's `daily_data_v2.dat` is a same-day, continuously-accumulating file (most sharply for ozone, which only accumulates AQI readings during daylight), but it was cached at the same `TWELVE_HOURS` used for slower-moving publishers. A fetch landing early in the day (this audit ran 08:44 UTC, ~4:44 AM Eastern) got cached as "current" for up to 12 hours regardless of how much real coverage filled in upstream afterward. Fixed by giving the AirNow fetch its own 1-hour TTL (`AIRNOW_TTL`) instead of sharing `TWELVE_HOURS`. Re-verified directly against the live feed the same day: **37/49 states now report valid AQI** (confirmed via both a standalone replay of the rollup logic against the live AirNow file, and a direct hit against the running app's `/api/national/feed`). The signal was never actually removed from `SIGNAL_CATALOG`; no action needed there. A re-run of this audit at a normal time of day would no longer show the 0/49 result — the table and detail below are left as the original snapshot for the record, not re-generated.

## Coverage detail

# Corvid national coverage audit

Feed retrieved: 2026-08-20T08:44:44.557Z
Feed status: current
Denominators: 49 jurisdictions and 3,109 counties/county-equivalents
Removal rule: source-valid observations are at least 90% missing at both state and county levels.

| Signal | Published states | Source-valid states | Comparable states | Published counties | Source-valid counties | Comparable counties | Stale states/counties | Source errors | Rule |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| COVID-19 ED activity (`covid-ed`) | 47/49 (95.9%) | 47/49 | 47/49 | 2199/3109 (70.7%) | 2199/3109 | 2199/3109 | 0/0 | 0 | keep |
| Influenza ED activity (`influenza-ed`) | 47/49 (95.9%) | 47/49 | 47/49 | 2199/3109 (70.7%) | 2199/3109 | 2199/3109 | 0/0 | 0 | keep |
| RSV ED activity (`rsv-ed`) | 47/49 (95.9%) | 47/49 | 47/49 | 2199/3109 (70.7%) | 2199/3109 | 2199/3109 | 0/0 | 0 | keep |
| West Nile incidence (`wnv-activity`) | 46/49 (93.9%) | 46/49 | 46/49 | 400/3109 (12.9%) | 400/3109 | 400/3109 | 0/0 | 0 | keep |
| Lyme disease (`lyme-cases`) | 44/49 (89.8%) | 44/49 | 44/49 | 651/3109 (20.9%) | 651/3109 | 651/3109 | 44/651 | 0 | keep |
| Anaplasmosis (`anaplasmosis-cases`) | 46/49 (93.9%) | 46/49 | 46/49 | 3099/3109 (99.7%) | 3099/3109 | 3099/3109 | 46/3099 | 0 | keep |
| Babesiosis (`babesiosis-cases`) | 41/49 (83.7%) | 41/49 | 41/49 | 3099/3109 (99.7%) | 3099/3109 | 3099/3109 | 41/3099 | 0 | keep |
| B. miyamotoi documented presence (`b-miyamotoi-presence`) | 28/49 (57.1%) | 28/49 | 0/49 | 399/3109 (12.8%) | 399/3109 | 0/3109 | 28/399 | 0 | keep |
| Powassan (`powassan-cases`) | 9/49 (18.4%) | 9/49 | 9/49 | 25/3109 (0.8%) | 25/3109 | 25/3109 | 0/0 | 0 | keep |
| Pertussis incidence (`pertussis-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Measles incidence (`measles-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Mumps incidence (`mumps-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Hepatitis A incidence (`hepatitis-a-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Campylobacteriosis incidence (`campylobacteriosis-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Salmonellosis incidence (`salmonellosis-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Shigellosis incidence (`shigellosis-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| STEC incidence (`stec-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Legionellosis incidence (`legionellosis-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Meningococcal disease incidence (`meningococcal-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Dengue incidence (`dengue-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Mpox incidence (`mpox-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Invasive pneumococcal disease (`pneumococcal-cases`) | 41/49 (83.7%) | 41/49 | 41/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Congenital syphilis incidence (`congenital-syphilis-cases`) | 49/49 (100.0%) | 49/49 | 49/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Influenza A wastewater (`influenza-a-wval`) | 0/49 (0.0%) | 0/49 | 0/49 | 676/3109 (21.7%) | 676/3109 | 676/3109 | 0/676 | 0 | keep |
| SARS-CoV-2 wastewater (`sars-cov-2-wval`) | 0/49 (0.0%) | 0/49 | 0/49 | 761/3109 (24.5%) | 761/3109 | 761/3109 | 0/761 | 0 | keep |
| RSV wastewater (`rsv-wval`) | 0/49 (0.0%) | 0/49 | 0/49 | 667/3109 (21.5%) | 667/3109 | 667/3109 | 0/667 | 0 | keep |
| Measles wastewater (`measles-detection`) | 46/49 (93.9%) | 46/49 | 46/49 | 440/3109 (14.2%) | 440/3109 | 440/3109 | 46/440 | 0 | keep |
| Influenza A H5 wastewater (`influenza-a-h5-detection`) | 46/49 (93.9%) | 46/49 | 46/49 | 341/3109 (11.0%) | 341/3109 | 341/3109 | 46/341 | 0 | keep |
| Mpox wastewater (`mpox-detection`) | 45/49 (91.8%) | 45/49 | 45/49 | 307/3109 (9.9%) | 307/3109 | 307/3109 | 45/307 | 0 | keep |
| HeatRisk (`heatrisk`) | 49/49 (100.0%) | 49/49 | 49/49 | 3099/3109 (99.7%) | 3099/3109 | 3099/3109 | 0/0 | 0 | keep |
| Air quality (`air-quality`) | 0/49 (0.0%) | 0/49 | 0/49 | 84/3109 (2.7%) | 84/3109 | 84/3109 | 0/0 | 0 | REMOVE |
| Influenza hospital admissions (`influenza-admissions`) | 49/49 (100.0%) | 17/49 | 17/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| COVID-19 hospital admissions (`covid-admissions`) | 49/49 (100.0%) | 17/49 | 17/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| RSV hospital admissions (`rsv-admissions`) | 49/49 (100.0%) | 17/49 | 17/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Inpatient beds occupied by COVID-19 (`covid-inpatient-burden`) | 49/49 (100.0%) | 17/49 | 17/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Inpatient beds occupied by influenza (`influenza-inpatient-burden`) | 49/49 (100.0%) | 17/49 | 17/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Inpatient beds occupied by RSV (`rsv-inpatient-burden`) | 49/49 (100.0%) | 17/49 | 17/49 | 0/3109 (0.0%) | 0/3109 | 0/3109 | 0/0 | 0 | keep |
| Available inpatient beds (`available-beds`) | 49/49 (100.0%) | 17/49 | 17/49 | 14/3109 (0.5%) | 14/3109 | 14/3109 | 0/14 | 0 | keep |
| ICU availability (`icu-availability`) | 49/49 (100.0%) | 12/49 | 12/49 | 13/3109 (0.4%) | 13/3109 | 13/3109 | 0/13 | 0 | keep |
| Emergency-department length of stay (`ed-wait`) | 49/49 (100.0%) | 49/49 | 49/49 | 2282/3109 (73.4%) | 2282/3109 | 2282/3109 | 49/2282 | 0 | keep |

Unmatched publisher county labels: 53, all Connecticut — the publisher's eight retired CT county names do not map to the state's nine current Census planning regions, and the audit deliberately leaves them unmatched (same limitation as 2026-08-10). Connecticut statewide readings remain available.

## Changes since 2026-08-10

| Signal | 2026-08-10 | 2026-08-20 | Note |
|---|---|---|---|
| `air-quality` | 36/49 states, 80 counties | 0/49 states, 84 counties | State coverage collapsed; removal rule now fires (see Outcome) |
| `covid-ed` / `influenza-ed` / `rsv-ed` | 2,341 counties each | 2,199 each | Normal weekly NSSP refresh variance |
| `wnv-activity` | 43 states, 318 counties | 46 states, 400 counties | Seasonal ArboNET/WNV reporting growth |
| `lyme-cases` | 44 states, 651 counties | 44 states, 651 counties | Identical — annual CDC county-of-residence vintage (observed through 2023-12-31); all readings now flagged stale |
| `anaplasmosis-cases` / `babesiosis-cases` | 3,099 counties each | 3,099 each | Identical — CDC NNDSS feeds ended 2023/2024 (see `docs/DATA_CATALOG.md`); all readings flagged stale |
| `b-miyamotoi-presence` | 28 states, 399 counties | 28 states, 399 counties | Unchanged; comparable-states 0/49 by design (presence, not incidence) |
| `powassan-cases` | 9 states, 23 counties | 9 states, 25 counties | Unchanged within noise |
| Wastewater WVAL (`influenza-a-wval`, `sars-cov-2-wval`, `rsv-wval`) | 630 / 776 / 573 counties | 676 / 761 / 667 | Retained on county coverage; state-null by design |
| Wastewater detection (`measles-detection`, `influenza-a-h5-detection`, `mpox-detection`) | 445 / 360 / 306 counties | 440 / 341 / 307 | Small variance; all state readings flagged stale (latest NWSS issue older than the freshness window) |
| NHSN hospital signals (admissions, burden, `available-beds`, `icu-availability`) | 22 / 22 / 22 / 14 states | 17 / 17 / 17 / 12 states | Seasonal NHSN lag; far above the 90% missing threshold |
| `ed-wait` | 2,277 counties | 2,282 counties | CMS Care Compare quarterly (observed through 2025-09-30); all readings flagged stale |
| `heatrisk` | 3,099 counties | 3,099 counties | Unchanged (official 7-day outlook, current) |

Stale flags are expected for annual (Lyme), ended (anaplasmosis/babesiosis NNDSS series), quarterly (CMS ED wait), and recently-issued (NWSS detection) sources; they are recorded, not errors.

## Residual limitations

- Coverage is a point-in-time property of the audited feed and can move when publishers add, revise, or withdraw observations.
- The `air-quality` removal verdict reflects the audited snapshot: 84 counties of valid AirNow data remain, so this is a state-aggregation regression candidate, not an empty source. Investigate the state monitor selection path in `apps/web/lib/national-live.ts` before removing the signal from `SIGNAL_CATALOG`.
- One state/signal pair (`influenza-a-wval:KY`) was excluded after rate-limit retries; rerunning the reconstruction fills it.

## Reproduce the audit

With the web application running locally:

```sh
cd apps/web
node scripts/rebuild-audit-feed.mjs --base http://localhost:3000 --out /tmp/audit-feed
node scripts/audit-national-coverage.mjs \
  --source /tmp/audit-feed/merged-feed.json \
  --format markdown \
  --fail-on-threshold
```

The command exits with status 2 if any current catalog signal fails the removal rule (it does, for `air-quality`, in this snapshot). The base-feed command from the 2026-08-10 doc still works for state-level coverage only; its county columns are structurally zero since `0f71ae2`.
