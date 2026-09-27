# Limitations

## Interpretation boundary

Corvid reports population surveillance. It is not medical guidance, a diagnostic system, an estimate of individual risk, or a replacement for clinical care or official public-health direction.

## Target and timing

- The NSSP measure is a share of ED visits received from participating facilities, not incidence, prevalence, case counts, or severity.
- The MVP output is a Friday-issued **current-week nowcast (horizon 0)** for the immediately following Saturday. It is not a +7-day forecast. A true +7-day target is a separate two-step problem.
- The 0.10 percentage-point direction deadband is a preregistered product rule without a clinical meaning. It does not reproduce CDC's smoothed trajectory method.
- A missing expected previous-week input makes the current nowcast unavailable; age-based freshness alone cannot repair target alignment.

## Revisions and evaluation

- NSSP and several supporting sources revise in place. Authentic historical evaluation requires immutable retrieval snapshots or source issue versions. A present-day series is not an authentic historical vintage.
- The +56-day scoring value is a fixed-lag convention, **not final truth**. Values may revise after eight weeks; promotion evidence remains provisional until +28/+56/+112/latest sensitivity is reported.
- The public champion is no-change. Retrospective challenger performance does not establish operational improvement or future performance.
- Direction accuracy can be inflated by the common stable class and varies by season. Class-aware metrics are necessary; overall accuracy alone is inadequate.

## Uncertainty

The MVP emits point estimates and qualitative data-quality/historical-skill fields. It has no predictive distribution, validated interval, or out-of-sample reliability analysis. Corvid therefore makes **no calibrated confidence claim** and does not interpret a label as the probability that a forecast is correct.

## Geography and coverage

- Statewide is the primary supported output.
- HSAs represent care-seeking regions and can cross county boundaries. Repeated county-labelled rows do not create county estimates.
- The MVP does not publish HSA nowcasts. HSA observations may be shown only as experimental context; an experimental label cannot bypass the gate.
- Participation and reporting coverage vary by source and time. Surveillance can reflect healthcare-seeking behavior, facility participation, reporting changes, and revisions as well as disease activity.
- NNDSS values are provisional weekly reports normalized with fixed 2020 Census resident populations. They are not current population estimates, finalized incidence rates, or county measurements.
- A numerical state or site forecast appears only when that individual series passes the history, continuity, recency, backtest, and comparison-period gates. Coverage can therefore differ by signal and issue.
- Wastewater forecasts remain tied to individual reporting sites and publisher counties-served metadata. Corvid does not create a statewide wastewater average.
- Publisher-defined wastewater service areas can cross state lines. Reviewed site-specific assignments map served counties to their actual states, but do not turn the site value into a county estimate.
- Several publishers still use Connecticut's eight retired county names while current Census geometry uses nine planning regions. Corvid leaves those labels unmatched instead of inventing a one-to-one crosswalk; statewide Connecticut values remain available.
- A CDC tick-pathogen `No records` status means no documented record in that dataset, not evidence that the pathogen is absent.

## Supporting sources

- FluView represents outpatient influenza-like illness and is neither laboratory-confirmed influenza nor the primary target.
- NHSN reporting had a voluntary interval in 2024; boundary weeks are ineligible rather than assigned to one regime.
- NREVSS state positivity is a centered three-week average from a changing voluntary sentinel laboratory network. It represents tests, not unique people; recent weeks are less complete, counts of 1–4 are suppressed, and rows can revise for up to two years.
- Wastewater `ymmh-divb` contains heterogeneous sample methods and units. Raw concentrations are experimental and are not pooled across incompatible sites or methods.
- Massachusetts DPH ingestion is disabled until an official workbook and its exact schema and reuse terms are reviewed.

## Demo and availability

Demo values and publication vintages are explicitly synthetic fixed examples. They are not current surveillance or authentic historical vintages. Live ingestion is explicit and failure-isolated. When primary data are stale, missing, malformed, or outside the expected publication schedule, Corvid retains safe historical evidence but withholds a current direction.
