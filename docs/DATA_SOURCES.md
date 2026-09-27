# Data sources

Source URLs and policies were reviewed on 2026-08-10. Corvid treats source fields and response text as untrusted data and validates publisher payloads before display. Point-in-time state and county coverage is documented in [the national coverage audit](COVERAGE_AUDIT_2026-08-20.md).

## National application sources

| Source | National use | Geographic limit |
| --- | --- | --- |
| [CDC NSSP emergency-department respiratory activity](https://data.cdc.gov/d/rdmq-nq56) | COVID-19, influenza, and RSV observations and forecast inputs | Comparable state and publisher-defined HSA records for the contiguous states and District of Columbia |
| [CDC NNDSS weekly data](https://data.cdc.gov/d/x9gk-5huc) | Provisional or latest-available incidence for 18 notifiable conditions | State reporting areas; New York and New York City rows are combined before normalization |
| [CDC NHSN hospital respiratory metrics](https://data.cdc.gov/d/mpgq-jmmr) | COVID-19, influenza, and RSV admissions, inpatient burden, available beds, and ICU availability | State observations only; values are not inferred for counties |
| [CDC NWSS wastewater viral activity](https://data.cdc.gov/d/atcp-73re) | Influenza A, SARS-CoV-2, and RSV site WVAL observations and gated site forecasts | Selected-state site detail uses counties served; Corvid does not average site values into an invented state WVAL |
| [CDC NWSS pathogen detection](https://data.cdc.gov/browse?tags=nwss) | Measles, influenza A H5, and mpox reporting-site detection | State reporting-site shares plus publisher-listed county service areas |
| [CDC Lyme disease surveillance](https://data.cdc.gov/d/x5j9-wybp) | Latest published state incidence and county case rates | State and county of residence where published |
| [CDC ArboNET downloads](https://www.cdc.gov/vector-borne-diseases/php/arbonet/) | West Nile and Powassan state incidence and county detail | Reported human and non-human surveillance rows; a reported zero remains a valid zero |
| [CDC tick surveillance data sets](https://www.cdc.gov/ticks/data-research/facts-stats/tick-surveillance-data-sets.html) | Anaplasmosis and babesiosis county cases; documented *B. miyamotoi* presence | County of residence or pathogen presence according to the workbook; no-record status is not absence |
| CMS Care Compare timely and effective care: [hospital](https://data.cms.gov/provider-data/dataset/yv7e-xc69) and [state](https://data.cms.gov/provider-data/dataset/apyc-v239) | Emergency-department length of stay (`OP_18b`) | Published state observations and hospitals mapped to their publisher county/parish |
| [NOAA NWS HeatRisk Image Service](https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer) | Official seven-day HeatRisk outlook | Maximum published category sampled at supported state and county centroids |
| [EPA AirNow daily data](https://files.airnowtech.org/?prefix=airnow/) | Current Air Quality Index | Valid monitors aggregated to county maximum and state maximum |
| [U.S. Census Bureau 2025 Cartographic Boundary Files](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html) | State and county display geometry | 48 contiguous states and District of Columbia; Alaska, Hawaii, and territories excluded |
| [U.S. Census Bureau 2020 resident population](https://www.census.gov/data/tables/2020/dec/2020-apportionment-data.html) | Denominator for comparable NNDSS state incidence | Fixed resident population denominator, documented in code and never presented as current population |

The browser-facing national APIs refresh against publisher data with a twelve-hour cache. Partial coordinated feeds are cached for only five minutes, and unusable or error responses are not cached. The backend ingestion pipeline has a separate six-hour refresh interval. Historical month selection is available from January 2018 or the first available publisher observation. Missing or incomparable observations are hatched. They are never replaced with synthetic values. Publisher-reported zero values remain visible; blank and invalid fields remain missing.

## Population-health context

The population-health context uses slower-moving and
operational context beside the national signal catalog. These sources are
loaded for one selected state or county at a time:

| Source | Measures | Geography and cadence | Guardrail |
| --- | --- | --- | --- |
| [Census population estimates](https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv) | Population denominator | State and county; annual | Used for denominators and population-weighted state summaries, never as a forecast |
| [Census ACS](https://www.census.gov/programs-surveys/acs/data.html) | Age structure, poverty, and unemployment | State and county; annual five-year profile | Percentages retain numerator and denominator; Census requires a server-side API key |
| [CDC/ATSDR SVI](https://www.atsdr.cdc.gov/placeandhealth/svi/index.html) | Overall and four theme vulnerability percentiles | County; periodic | State values are population-weighted county aggregates; higher is more vulnerable |
| [CDC PLACES](https://www.cdc.gov/places/about/) | Model-based mental health, chronic disease, prevention, access, sleep, and food-insecurity measures | County; annual | Uses one crude-prevalence row per measure; county-native small-area estimates stay labeled model-based |
| [HRSA HPSA and MUA/P](https://data.hrsa.gov/topics/health-workforce/shortage-areas/hpsa-find) | Primary-care and mental-health shortage designations and published need fields | State or selected county; current/periodic | Published designation populations can overlap and are not a unique-person count |
| [NOAA HeatRisk](https://www.wpc.ncep.noaa.gov/heatrisk/) and [EPA AirNow](https://www.airnow.gov/aqi/) | Current official heat outlook and air-quality context | Current state readout; daily | Historical periods do not reuse today's outlook |
| [CDC VaxView](https://www.cdc.gov/flu/fluvaxview/) and [CDC provisional mortality](https://wonder.cdc.gov/mcd.html) | Influenza coverage and 12-month-ending provisional overdose counts/rates | State or county; seasonal/quarterly releases | Provisional values can revise; suppressed values stay missing; older latest releases are labeled stale |
| [CDC NORS](https://www.cdc.gov/nors/data/index.html) | Reported outbreak illnesses and deaths | State; event-based historical extract | Event reports are not complete incidence estimates |
| [CMS Care Compare](https://data.cms.gov/provider-data/about) and [NOAA/NWS alerts](https://www.weather.gov/documentation/services-web-api) | ED length-of-stay context and active hazards | Prepared state ED measure/current alerts | Capacity and alert counts are operational context, not outbreak forecasts |

Population Health uses Corvid's process-wide 40 MB publisher LRU and a 100-entry
geography/period response cache. It opens as a picker, loads the current period
only after a state is selected, and fetches a historical month only on request.
Two phase groups are allowed in flight; the page does not preload all states,
counties, months, or forecast signals.

## Forecast eligibility

Every forecast-enabled repeated weekly series is evaluated for 7, 14, and 28 day forecasts. Corvid requires at least 64 observations, no gap longer than 14 days in the latest 64 observations, a current final observation, at least 12 rolling backtest origins, and positive MAE skill against persistence. Estimates that fail any gate are withheld. Percentage forecasts are bounded to 0 through 100. Wastewater forecasts remain at site geography. Official NOAA HeatRisk is shown only inside its publisher validity window.

| Source | Corvid role | Geography and cadence | Revision/vintage behavior | Reuse policy |
| --- | --- | --- | --- | --- |
| [CDC NSSP ED trajectories (`rdmq-nq56`)](https://data.cdc.gov/d/rdmq-nq56) | Primary targets: raw weekly influenza-, RSV-, and COVID-19-attributed ED visit percentages; upstream smoothed values and trajectories remain separate context | Massachusetts state and six deduplicated Massachusetts HSA values; weekly | Live Socrata rows overwrite revisions. `buildnumber` is a dataset build date, not an observation issue date. Corvid retrieval snapshots are the local vintage record. | CDC catalog: Public Domain U.S. Government work; attribution retained |
| [Delphi FluView API](https://cmu-delphi.github.io/delphi-epidata/api/fluview.html) | Supporting outpatient influenza-like illness (`ili`) and weighted ILI (`wili`) | Massachusetts; weekly issue versions | `issue`, `release_date`, and `lag` support vintage-aware reads; missing release dates fall back to retrieval time with a quality flag | Official API classification: Publicly Accessible US Government; publisher attribution retained |
| [CDC NHSN weekly hospital respiratory metrics (`ua7e-t2fy`)](https://data.cdc.gov/d/ua7e-t2fy) | Supporting confirmed influenza admissions, rate, and reporting coverage | Massachusetts; Sunday–Saturday weekly intervals | No row issue date; keep retrieval snapshots. The 2024 voluntary-reporting interval and boundary weeks are quality/ineligibility flags. Do not substitute or blend the derived `vdzy-6i9v` table. | CDC catalog: Public Domain U.S. Government work; attribution retained |
| [CDC NREVSS respiratory NAAT positivity (`rgnm-fkqb`)](https://data.cdc.gov/d/rgnm-fkqb) | Supporting RSV and COVID-19 laboratory percent positivity; not a Corvid target or forecast input | Massachusetts; weekly state rows for the latest two years | Preserve every `posted` date as an issue. Counts suppressed as `*` or unavailable as `.` remain missing, never zero. Retrieval snapshots retain later in-place revisions. | CDC catalog: Public Domain U.S. Government work; attribution retained |
| [CDC Wastewater Data for Influenza A (`ymmh-divb`)](https://data.cdc.gov/d/ymmh-divb) | Optional experimental raw sample observations | Massachusetts samples; dataset refreshed weekly | `record_id` is the source identity; retain method, site, units, detection, and update metadata | **Current public-domain U.S. Government dataset.** It has no per-row `license` field; the policy comes from the CDC catalog. Research and commercial modes are allowed with attribution. |
| [Massachusetts DPH influenza reporting](https://www.mass.gov/info-details/influenza-reporting) | Potential supporting seasonal workbook source | Massachusetts; human-facing seasonal archive | No stable API or published workbook contract. Discovery, link selection, content type, sheet names, headers, and hash require manual review per season. | No explicit license found; commercial reuse requires review |
| [MassGIS Counties](https://www.mass.gov/info-details/massgis-data-counties) | Display-only county boundary geometry for the informational coverage map | 14 Massachusetts county polygons; source updated as needed | Generated SVG paths retain the feature-service query and response hash; rerun the checked-in generator to refresh | Public MassGIS download; publisher attribution retained |

## Source-specific cautions

### NSSP

The NSSP targets are the percentages of ED visits attributed to influenza, RSV, and COVID-19 among reporting facilities. They are not population incidence. Statewide rows use `geography='Massachusetts'`, `county='All'`, `trend_source='State'`, and `fips='25000'`. HSA identity uses `hsa_nci_id`, not a contributing county FIPS. CDC's smoothed values and upstream trajectories are preserved as context and are not Corvid forecasts.

### FluView and NHSN

FluView is voluntary outpatient influenza-like illness surveillance and is not laboratory-confirmed influenza. NHSN coverage changed during the 2024 voluntary-reporting interval; legitimate zero admissions are retained and distinguished from missing values.

### NREVSS

`rgnm-fkqb` state rows provide RSV and SARS-CoV-2 NAAT positivity from a voluntary sentinel laboratory network. The normalized value is the publisher's centered three-week percent-positive average, not a raw weekly percentage or a measure of unique people. The most recent reporting week uses only the current and previous weeks because the following week is unavailable. Corvid stores the labeled MMWR week, the `posted` issue, the three-week test average and five-week detection average as metadata, and a sparse flag when the publisher suppresses detections of 1–4. Historical selection can use only issues and immutable snapshots actually acquired by Corvid; a current download does not manufacture past vintages.

### Wastewater

`ymmh-divb` is sample-level influenza A concentration data. Units, matrix, concentration method, PCR type, extraction method, target, site, and source can differ. Corvid does not aggregate incompatible raw concentrations, infer a county geography from multi-county coverage strings, or interpret a non-detect as a measured zero.

The national dashboard uses CDC's normalized site WVAL for influenza A, SARS-CoV-2, and RSV, and dedicated detection datasets for measles, influenza A H5, and mpox. Site detail is mapped only to publisher-listed counties served. Reviewed cross-state sewersheds are assigned to the served county's actual state, while the state summary remains tied to the reporting sites in the publisher's state field.

### County identity

When a source publishes a five-digit county FIPS, Corvid uses it before any name matching. This prevents same-named counties and independent cities from being conflated. Name-only service areas normalize common abbreviations, diacritics, publisher typos, and compound labels. Connecticut publishers that still use the eight retired county names are not forced into the state's nine current Census planning regions because no defensible one-to-one mapping exists.

### Massachusetts DPH

The DPH connector is **disabled until an official workbook is captured and reviewed**. A parser signature alone does not authorize normalization: a real workbook must establish the exact sheet/header/date/metric mapping and reuse policy. HTML responses, renamed headers, duplicate normalized headers, unexpected sheets, or an unsigned season fail closed.

### Coverage map

The Massachusetts CLI's display map uses county boundaries from MassGIS. It shows county geography for orientation and does not turn HSA observations into county measurements.
