# Health Intelligence Data Catalog

Research reviewed August 10, 2026. This catalog distinguishes data that can drive an operational map from slower context useful for research and planning.

## National release

The current product covers the 48 contiguous states and the District of Columbia. Alaska, Hawaii, and U.S. territories are intentionally excluded from this release. Every national view uses the same 40-signal catalog across 8 domains and the same 49-jurisdiction cohort. CDC NSSP supports state and HSA respiratory emergency-department activity. CDC NNDSS supplies provisional or latest-available state case counts for 18 mosquito-borne, tick-borne, and nationally notifiable conditions. CDC national county files add Lyme, anaplasmosis, babesiosis, West Nile, Powassan, and documented *Borrelia miyamotoi* presence where those publishers provide county observations. CDC NHSN supplies state respiratory admissions, virus-specific inpatient burden, available beds, and ICU availability. CDC NWSS supplies site-level wastewater observations. CMS Care Compare supplies emergency-department length of stay. Signals without a defensible public feed are not retained as empty planning layers.

County boundaries are loaded only after a state is selected. State-only observations remain state-only and are never copied into counties.

The complete point-in-time coverage matrix, removal decisions, and reproducible audit command are in [the August 20 national coverage audit](COVERAGE_AUDIT_2026-08-20.md).

## Audited expansion candidates

These official feeds were rechecked against live publisher rows on August 3, 2026. They are candidates, not silently interchangeable substitutes for existing targets.

| Candidate | Current verified coverage | Best Corvid role | Adoption gate |
|---|---|---|---|
| [CDC NSSP respiratory daily (`vjzj-u7u8`)](https://data.cdc.gov/d/vjzj-u7u8) | Daily state observations for ARI, COVID-19, influenza, and RSV; Massachusetts rows were available through July 25, 2026 | Higher-resolution observed respiratory context and a candidate forecast input alongside the established weekly target | Preserve the weekly-updated publication cadence, validate 0â€“100 percent values, establish retrieval vintages, and backtest without treating seven daily rows as seven independent weekly updates |
| [CDC Epidemic Trends and Rt (`5dqz-y4ea`)](https://data.cdc.gov/d/5dqz-y4ea) | Weekly state and national modeled Rt, interval, probability of growth, and category for COVID-19 and influenza; the feed also contained RSV rows marked `Not Estimated` for the latest Massachusetts issue | Clearly labeled official modeled context; never relabel as a Corvid forecast | Split evaluation at the June 1, 2026 publisher method change, preserve `as_of` and `buildnumber`, retain `Not Estimated` as missing, and never blend its posterior interval with Corvid backtest intervals |
| [CDC NREVSS respiratory NAAT positivity (`rgnm-fkqb`)](https://data.cdc.gov/d/rgnm-fkqb) | Weekly national and HHS-region data for multiple viruses; two years of state data for RSV and SARS-CoV-2. Massachusetts rows were available through July 25, 2026 | Backend state laboratory-positivity context for RSV and SARS-CoV-2; browser context remains a candidate | Backend contract complete; browser or model adoption must retain the sentinel limitation and prove the centered three-week average cannot leak future-week information |
| [CDC NHSN weekly admission levels (`vdzy-6i9v`)](https://data.cdc.gov/d/vdzy-6i9v) | Current derived national and jurisdiction admission rates and categorical levels for COVID-19, influenza, and RSV | Publisher severity labels shown beside raw NHSN observations | Keep derived levels distinct from the raw `mpgq-jmmr` target and do not count both as independent evidence |
| [CDC RESP-NET rates and clinical data (`kvib-3txy`)](https://data.cdc.gov/d/kvib-3txy) | Laboratory-confirmed respiratory hospitalization rates and clinical characteristics across participating surveillance sites | Delayed severity and research context | Disclose sentinel-site geography, publication lag, and population scope; do not present as complete state hospitalization incidence |

The backend `nrevss_naat` connector now implements the NREVSS source contract,
including `posted` issue versions, explicit `*` suppression and `.` missingness,
percentage bounds, and sentinel-network caveats. It remains supporting context;
browser display or modeling still requires an explicit product contract and
leakage-safe evaluation of the centered window.

| Layer | Diseases or hazards | Publisher | Cadence | Best public geography | Corvid use |
|---|---|---|---|---|---|
| Respiratory ED trajectories | Influenza, RSV, COVID-19 | CDC NSSP | Weekly | State and six Massachusetts HSA groupings | Live observed activity and direction; first mapped layer |
| Hospital respiratory admissions | Influenza, RSV, COVID-19 | CDC NHSN | Weekly | State | Live severity and reporting-coverage context |
| Nationally notifiable diseases | West Nile, anaplasmosis, babesiosis, Powassan, pertussis, measles, mumps, hepatitis A, campylobacteriosis, salmonellosis, shigellosis, STEC, legionellosis, meningococcal disease, dengue, mpox, invasive pneumococcal disease, congenital syphilis | CDC NNDSS | Weekly or latest published annual series | State reporting area | Provisional or latest-available incidence and gated short-horizon forecasts |
| Respiratory inpatient burden | COVID-19, influenza, RSV | CDC NHSN | Weekly | State | Share of inpatient beds occupied by patients with each virus |
| Respiratory reporting | Flu, RSV, COVID-19; rhinovirus/enterovirus, parainfluenza, HMPV, seasonal coronavirus, adenovirus | Massachusetts DPH | Weekly/seasonal files | Mostly state/region | Validation and broader respiratory context |
| Wastewater | Flu A, SARS-CoV-2, RSV, measles, H5, mpox | CDC NWSS | Weekly | Sewershed/site | Early-warning evidence; never compare raw concentrations across unlike methods |
| Arbovirus surveillance | West Nile virus | CDC ArboNET with Massachusetts DPH enrichment | In-season updates | County where published | Human incidence plus publisher-reported non-human activity context |
| Tick-borne surveillance | Lyme, anaplasmosis, babesiosis, *Borrelia miyamotoi*, Powassan | CDC surveillance files | Annual / weekly by source | County and state where published | Incidence, reported case counts, or documented presence according to source semantics |
| Heat health | Extreme heat and heat-related illness | NOAA/CDC HeatRisk; MA EPHT | Daily forecast / historical health data | Forecast grid; historical local areas | Seven-day environmental health outlook plus vulnerability context |
| Air quality | Ozone and particle pollution | EPA AirNow | Current and forecast | Monitor/forecast area | Current and next-day respiratory stressor |
| Health-system pressure | Beds, ICU, and emergency-department length of stay | CDC NHSN, CMS Care Compare, and reviewed Massachusetts enrichment | Weekly / annual by source | State, hospital-to-county, or reviewed county enrichment | Operational context, not a real-time outbreak forecast |
| Environmental-health baseline | Asthma, COPD, heart attack, carbon monoxide, heat/cold illness, lead | MA EPHT | Annual/historical | City/town, county, region, tract depending on topic | Vulnerability and research layer, not a current alert |
| Enteric outbreak history | Foodborne, waterborne, animal-contact and other enteric outbreaks | CDC NORS | Delayed historical releases | State/outbreak | Seasonality and research baseline, not live detection |

## Feasible product layers

### Ship as live or official observed layers

- Influenza, RSV, and COVID-19 emergency-department activity.
- Weekly or latest-available incidence for 18 CDC NNDSS conditions.
- COVID-19, influenza, and RSV admissions and inpatient bed burden.
- West Nile provisional weekly state incidence and county surveillance detail where published.
- Current/forecast air quality and heat risk.
- State laboratory activity for other respiratory viruses.

### Ship first as observed seasonal outlooks

- Lyme disease and documented *Borrelia miyamotoi* presence where no comparable weekly national feed is available.
- Wastewater signals for respiratory pathogens, measles, H5, and mpox where Massachusetts sites report.
- Health-system pressure.

These become Corvid forecasts only after a documented target, sufficient history, vintage-aware evaluation, and baseline comparison exist.

### Keep as research or vulnerability context

- Historical asthma, COPD, cardiovascular, lead, and temperature-related hospitalization data.
- Historical enteric outbreak data.
- County social and environmental vulnerability baselines.

## Required semantics

Every value must carry: publisher, source URL, retrieval time, observation period, publication/build date when available, cadence, geography type, unit, and status (`live`, `last-valid`, `delayed`, or `unavailable`). A map fill inherits the source geography; repeating one HSA value across member county shapes does not create county estimates.

## Official sources

- CDC NSSP: https://data.cdc.gov/resource/rdmq-nq56.json
- CDC NNDSS weekly data: https://data.cdc.gov/resource/x9gk-5huc.json
- CDC NHSN hospital respiratory metrics: https://data.cdc.gov/resource/mpgq-jmmr.json
- CDC NREVSS respiratory NAAT positivity: https://data.cdc.gov/resource/rgnm-fkqb.json
- U.S. Census 2020 resident population table: https://www2.census.gov/programs-surveys/decennial/2020/data/apportionment/apportionment.csv
- Massachusetts viral respiratory reporting: https://www.mass.gov/info-details/viral-respiratory-illness-reporting
- CDC wastewater: https://www.cdc.gov/nwss/about-data.html
- CDC tick surveillance data sets: https://www.cdc.gov/ticks/data-research/facts-stats/tick-surveillance-data-sets.html
- CMS Care Compare hospital timely and effective care: https://data.cms.gov/provider-data/dataset/yv7e-xc69
- CMS Care Compare state timely and effective care: https://data.cms.gov/provider-data/dataset/apyc-v239
- Massachusetts arbovirus update: https://www.mass.gov/info-details/massachusetts-arbovirus-update
- Massachusetts health care capacity: https://www.mass.gov/info-details/health-care-capacity-interactive-dashboard
- Massachusetts Environmental Public Health Tracking: https://www.mass.gov/orgs/massachusetts-environmental-public-health-tracking-ma-epht
- CDC NORS: https://www.cdc.gov/nors/data/index.html
