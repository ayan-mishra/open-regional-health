# Methodology

Corvid is a population-level public health planning product. It does not diagnose illness, estimate individual risk, or replace official public health guidance.

## Comparable map issues

The national view covers the 48 contiguous states and the District of Columbia. Relative colors are computed only among values that share the same signal, source geography, and latest publisher period. Values from older periods can remain visible as context but are excluded from the color cohort. Missing and incomparable values are hatched.

State observations are never copied into counties. HSA observations can repeat across publisher-listed member counties with an explicit HSA disclosure. Wastewater values and forecasts remain at reporting-site geography and use the publisher's counties-served metadata. NOAA HeatRisk samples the official outlook at state and county geographic centroids and labels that sampling method explicitly.

NNDSS current-week case counts are normalized per 100,000 using official 2020 Census resident populations. New York State and New York City reporting rows are combined before normalization. The denominator is fixed and is not represented as a current population estimate.

## Forecast model

Repeated weekly series are eligible for 7, 14, and 28 day forecasts. The point estimate is the median of:

- persistence, using the latest observation;
- a local linear trend fit to the most recent eight observations;
- a seasonal analogue from approximately 52 weeks earlier when available.

Forecasts are nonnegative. Percentage signals are also capped at 100.

## Publication gates

Corvid publishes a numerical model result only when all of these conditions hold:

1. At least 64 finite weekly observations are available.
2. No gap in the most recent 64 observations exceeds 14 days.
3. The latest observation is no more than 28 days old for a current issue.
4. At least 12 expanding-window backtest errors exist for the selected horizon.
5. The model's mean absolute error is lower than persistence on those backtests.
6. The observation belongs to the latest comparable publisher period.

Failure of any gate produces planning context or an unavailable value, not an estimate.

## Uncertainty and evaluation

The displayed interval uses the 80th percentile of absolute rolling-origin backtest errors around the point forecast. Interval width cannot shrink as the requested horizon increases. The interface reports backtest MAE, empirical interval coverage, and skill versus persistence. These are retrospective diagnostics, not a probability that the forecast is correct.

## Source-specific handling

- CDC NSSP respiratory ED percentages are modeled at state geography and, when selected, at HSA geography.
- CDC NHSN admission rates, virus-specific inpatient burden, bed availability, and ICU availability require at least 80 percent hospital reporting coverage. Availability is calculated as 100 minus occupancy.
- CDC NREVSS Massachusetts RSV and COVID-19 values are supporting laboratory context only. The backend preserves publisher `posted` issues and centered-window semantics; these values are not currently modeled or blended with NSSP evidence.
- CDC NNDSS provisional weekly incidence is modeled separately for every state series. Sparse rare-disease series normally fail the publication gates.
- CDC county-native disease files use exact five-digit FIPS before name matching. Publisher-reported zero cases are retained, while blank fields remain missing.
- CDC *B. miyamotoi* status is a presence-only planning layer. `No records` is not treated as absence, and reporting differences are not ranked.
- CDC NWSS WVAL is modeled separately for every reporting site. Site values are not pooled into a state estimate.
- NOAA HeatRisk is an official publisher outlook. It is never relabeled as a Corvid model and is removed after the publisher validity window ends.

Publisher responses used by the browser-facing national APIs are cached for twelve hours; partial coordinated feeds are cached for five minutes. The backend ingestion pipeline refreshes separately every six hours. Historical requests cut the series off at the selected month and apply the same evidence gates using only observations available through that cutoff.

## September 2026 national engine update

The TypeScript national engine now uses `adaptive-ensemble-v2`; the older median
baseline description above remains applicable to the separate Python research
implementation and previously baked v1 estimates. Rebuild forecast stores to
publish v2. Forecast outputs retain their model versions for interpretation.

The v2 candidates are persistence, an eight-week Theil–Sen trend with geometric
horizon damping (0.9), an exact 52-week seasonal analogue, and a seasonal analogue
adjusted by the median of recent matched year-over-year differences. Candidate
weights use inverse squared MAE over up to 26 matured backtest targets, with a
scale-dependent floor. Until eight errors exist for every available candidate,
weights are equal. Percentage bounds apply inside candidate evaluation as well
as to published intervals. Dates and weekly spacing are validated explicitly.

Every training origin has at least 64 observations. Evaluation uses the latest
156 possible origins and only residuals whose targets are known at that origin;
a four-week error is never used to choose a forecast issued one week later.
Intervals use up to 52 past errors normalized by the training window's recent
median level (floor 0.01), with rank `ceil(0.8 * (n + 1))`. At least 12 residuals
are required before evaluating intervals, and at least 12 subsequent interval
evaluations are required before an estimate is returned. Publication additionally
requires positive evaluated skill against persistence and at least 70% empirical
coverage for the nominal 80% interval. Existing source/recency gates remain.
The 70% threshold is an explicit conservative availability rule, not a statistical
proof of calibration. Temporal dependence and publisher revisions preclude
claiming distribution-free or prospective coverage from these diagnostics.

A regional forecast is fitted to the intersection of the selected states' weekly
histories, with a fixed cohort and matching latest periods. Its uncertainty is
estimated from regional forecast residuals, never by averaging state interval
endpoints. Without common history and passing regional gates, no pooled estimate
is published. This forecast describes a constituent mean, not population burden.
County selections do not inherit state forecasts.

Regional observed rates pool published numerators/denominators only when scale,
observation period, and denominator vintage match. Lyme and ArboNET county
connectors carry their existing Census denominator into this calculation. Where
compatible denominators are unavailable, a constituent mean is labeled as such;
ordinal HeatRisk and presence categories are not averaged. Missing county values
remain missing. County selections are matched by exact FIPS before names.

References: [rolling-origin evaluation](https://otexts.com/fpp3/tscv.html),
[finite-sample interval ranks and assumptions](https://arxiv.org/abs/2107.07511).
