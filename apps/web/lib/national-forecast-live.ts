import "server-only";
import { z } from "zod";
import { buildWeeklyForecast } from "@/lib/forecast-model";
import { hasUsableHospitalReportingCoverage } from "@/lib/hospital-reporting";
import type { ForecastEstimate, ForecastObservation } from "@/lib/forecast-contracts";
import type { NationalDetailReading, NationalForecastDetailReading, NationalForecastEvidence, NationalForecastResponse, NationalForecastState } from "@/lib/national-contracts";
import { aggregateNndssRows, nndssLabelWhere, nndssRowSchema, NNDSS_ENDPOINT, NNDSS_SIGNAL_LABELS } from "@/lib/nndss";
import { getNationalOutlook } from "@/lib/national-live";
import { STORE_VERSION } from "@/lib/state-slice-store";
import { readBakedForecastIndex, readBakedStateForecast, writeBakedForecast, type BakedStateForecast } from "@/lib/forecast-store";
import { SIGNAL_BY_ID, SIGNAL_CATALOG, type SignalId } from "@/lib/signal-catalog";
import { jurisdictionByCode, US_JURISDICTIONS, type IncludedStateCode } from "@/lib/us-geography";
import { nonNegativePublisherNumber, optionalNonNegativePublisherNumber, optionalPublisherPercentage, parseTrustedRows } from "@/lib/publisher-values";
import { cachedPublisherFetch } from "@/lib/publisher-cache";
import { publisherHeaders, TRANSIENT_PUBLISHER_STATUSES } from "@/lib/publisher-request";
const TWELVE_HOURS = 43200;
const DAY_MS = 86400000;
const CURRENT_SERIES_MAX_AGE_DAYS = 28;
const NSSP_ENDPOINT = "https://data.cdc.gov/resource/rdmq-nq56.json";
const NHSN_ENDPOINT = "https://data.cdc.gov/resource/mpgq-jmmr.json";
const NWSS_ENDPOINT = "https://data.cdc.gov/resource/atcp-73re.json";
const PUBLISHER_RETRY_DELAY_MS = 250;
const PUBLISHER_MAX_ATTEMPTS = 3;
type Options = {
    signalId: SignalId;
    stateCode: IncludedStateCode | null;
    horizon: 7 | 14 | 28;
    period: string | null;
    now?: Date;
    recompute?: boolean;
};
const forecastProgress = new Map<string, {
    completed: number;
    total: number;
}>();
function forecastProgressKey(options: Options) {
    return `${options.signalId}:${options.period ?? ""}:${options.stateCode ?? ""}:${options.horizon}`;
}
function startForecastProgress(options: Options, total = US_JURISDICTIONS.length) {
    forecastProgress.set(forecastProgressKey(options), { completed: 0, total });
}
function tickForecastProgress(options: Options) {
    const progress = forecastProgress.get(forecastProgressKey(options));
    if (progress)
        progress.completed += 1;
}
function yieldToRequests() {
    return new Promise((resolve) => setImmediate(resolve));
}
export function getForecastProgress(signalId: SignalId, period: string, stateCode: IncludedStateCode | null = null, horizon: 7 | 14 | 28 = 28): {
    completed: number;
    total: number;
} | null {
    return forecastProgress.get(`${signalId}:${period}:${stateCode ?? ""}:${horizon}`) ?? null;
}
const respiratorySchema = z.object({
    week_end: z.string(), geography: z.string(), hsa_nci_id: z.string().optional().default("All"), hsa: z.string().optional(), hsa_counties: z.string().optional(), county: z.string().optional().default("All"), trend_source: z.string().optional(),
    percent_visits_covid: optionalPublisherPercentage, percent_visits_influenza: optionalPublisherPercentage, percent_visits_rsv: optionalPublisherPercentage,
});
const hospitalSchema = z.object({
    weekendingdate: z.string(), jurisdiction: z.string(),
    totalconfc19newadmper100k: optionalNonNegativePublisherNumber, totalconfflunewadmper100k: optionalNonNegativePublisherNumber, totalconfrsvnewadmper100k: optionalNonNegativePublisherNumber,
    totalconfc19newadmperchosprep: optionalNonNegativePublisherNumber, totalconfflunewadmperchosprep: optionalNonNegativePublisherNumber, totalconfrsvnewadmperchosprep: optionalNonNegativePublisherNumber,
    pctconfc19inptbeds: optionalPublisherPercentage, pctconffluinptbeds: optionalPublisherPercentage, pctconfrsvinptbeds: optionalPublisherPercentage,
    pctconfc19inptbedsperchosprep: optionalNonNegativePublisherNumber, pctconffluinptbedsperchosprep: optionalNonNegativePublisherNumber, pctconfrsvinptbedsperchosprep: optionalNonNegativePublisherNumber,
    pctinptbedsocc: optionalPublisherPercentage, pcticubedsocc: optionalPublisherPercentage, pctinptbedsoccperchosprep: optionalNonNegativePublisherNumber, pcticubedsoccperchosprep: optionalNonNegativePublisherNumber,
});
const wastewaterSiteSchema = z.object({ state_territory: z.string(), counties_served: z.string().optional().default(""), site: z.string(), site_wval: nonNegativePublisherNumber, week_end: z.string() });
const RESPIRATORY_FIELDS = { "covid-ed": "percent_visits_covid", "influenza-ed": "percent_visits_influenza", "rsv-ed": "percent_visits_rsv" } as const;
const NHSN_FIELDS = {
    "influenza-admissions": "totalconfflunewadmper100k", "covid-admissions": "totalconfc19newadmper100k", "rsv-admissions": "totalconfrsvnewadmper100k",
    "covid-inpatient-burden": "pctconfc19inptbeds", "influenza-inpatient-burden": "pctconffluinptbeds", "rsv-inpatient-burden": "pctconfrsvinptbeds",
    "available-beds": "pctinptbedsocc", "icu-availability": "pcticubedsocc",
} as const;
const NHSN_COVERAGE_FIELDS = {
    "influenza-admissions": "totalconfflunewadmperchosprep", "covid-admissions": "totalconfc19newadmperchosprep", "rsv-admissions": "totalconfrsvnewadmperchosprep",
    "covid-inpatient-burden": "pctconfc19inptbedsperchosprep", "influenza-inpatient-burden": "pctconffluinptbedsperchosprep", "rsv-inpatient-burden": "pctconfrsvinptbedsperchosprep",
    "available-beds": "pctinptbedsoccperchosprep", "icu-availability": "pcticubedsoccperchosprep",
} as const;
const NWSS_PATHOGENS = { "influenza-a-wval": "Influenza A virus", "sars-cov-2-wval": "SARS-CoV-2", "rsv-wval": "RSV" } as const;
function cutoff(options: Options) {
    if (!options.period)
        return options.now ?? new Date();
    const [year, month] = options.period.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0, 23, 59, 59));
}
async function fetchJson(url: string) {
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt < PUBLISHER_MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(25000), cache: "no-store", headers: publisherHeaders(url, "application/json") });
            if (response.ok)
                return response.json();
            lastStatus = response.status;
            if (!TRANSIENT_PUBLISHER_STATUSES.has(response.status) || attempt === PUBLISHER_MAX_ATTEMPTS - 1)
                break;
        }
        catch (error) {
            if (attempt === PUBLISHER_MAX_ATTEMPTS - 1)
                throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, PUBLISHER_RETRY_DELAY_MS * (attempt + 1)));
    }
    throw new Error(`Publisher responded with ${lastStatus ?? "an unknown error"}`);
}
async function publicJson(url: string) {
    return cachedPublisherFetch(url, TWELVE_HOURS, () => fetchJson(url));
}
async function pagedPublicRows(endpoint: string, params: URLSearchParams) {
    const all: unknown[] = [];
    const pageSize = 50000;
    for (let offset = 0;; offset += pageSize) {
        const pageParams = new URLSearchParams(params);
        pageParams.set("$limit", String(pageSize));
        pageParams.set("$offset", String(offset));
        const page = z.array(z.unknown()).parse(await publicJson(`${endpoint}?${pageParams}`));
        all.push(...page);
        if (page.length < pageSize)
            return all;
    }
}
function emptyStates(note: string): NationalForecastState[] {
    return US_JURISDICTIONS.map((state) => ({ code: state.code, name: state.name, value: null, displayValue: "Forecast unavailable", observedThrough: null, comparisonEligible: false, note, estimate: null, latestObserved: null }));
}
function series<T>(rows: T[], filter: (row: T) => boolean, date: (row: T) => string, value: (row: T) => number | undefined): ForecastObservation[] {
    return [...new Map(rows.filter(filter).flatMap((row) => {
            const reading = value(row);
            return reading === undefined ? [] : [[date(row).slice(0, 10), { date: date(row).slice(0, 10), value: reading }] as const];
        })).values()].sort((left, right) => left.date.localeCompare(right.date));
}
function eligibleEstimate(estimates: ForecastEstimate[], horizon: 7 | 14 | 28) {
    return estimates.find((estimate) => estimate.horizonDays === horizon) ?? null;
}
function seriesIsCurrent(observations: ForecastObservation[], options: Options) {
    const latest = observations.at(-1)?.date;
    if (!latest)
        return false;
    const issueCutoff = cutoff(options);
    if (latest > issueCutoff.toISOString().slice(0, 10))
        return false;
    if (options.period)
        return true;
    return issueCutoff.getTime() - new Date(`${latest}T23:59:59.999Z`).getTime() <= CURRENT_SERIES_MAX_AGE_DAYS * DAY_MS;
}
function format(value: number, signalId: SignalId) {
    if (SIGNAL_BY_ID[signalId].unit.includes("%"))
        return `${value.toFixed(2)}%`;
    if (SIGNAL_BY_ID[signalId].unit.includes("per 100,000"))
        return value.toFixed(3);
    return `${value.toFixed(2)}%`;
}
function sourceErrorMessage(error: unknown) {
    if (error instanceof Error && /^Publisher responded with \d{3}$/.test(error.message))
        return error.message;
    return "Publisher data could not be validated.";
}
function boundedEstimates(estimates: ForecastEstimate[], signalId: SignalId) {
    const maximum = SIGNAL_BY_ID[signalId].unit.includes("%") ? 100 : Number.POSITIVE_INFINITY;
    return estimates.map((estimate) => ({
        ...estimate,
        value: Math.min(maximum, Math.max(0, estimate.value)),
        lower: Math.min(maximum, Math.max(0, estimate.lower)),
        upper: Math.min(maximum, Math.max(0, estimate.upper)),
    }));
}
type StateModel = {
    observations: ForecastObservation[];
    estimates: ForecastEstimate[];
    publishable: boolean;
};
type PerStateForecast = (stateCode: IncludedStateCode) => Promise<{
    evidence: NationalForecastEvidence;
    details: NationalDetailReading[];
}>;
type ModeledForecast = {
    states: NationalForecastState[];
    details: NationalDetailReading[];
    evidence: NationalForecastEvidence;
    perState?: PerStateForecast;
};
function stateEvidence(model: StateModel | undefined, stateCode: IncludedStateCode | null, publishableCount: number, copy: {
    gates: string;
    nationalGates: string;
    digits: number;
    nextUpdate: string;
}): NationalForecastEvidence {
    if (model?.publishable)
        return { kind: "modeled", model: "Corvid adaptive ensemble v2", observations: model.observations, estimates: model.estimates, evidence: "supported" };
    return {
        kind: "planning",
        description: stateCode ? `No selected state forecast passed the ${copy.gates}.` : `${publishableCount} state forecasts passed the ${copy.nationalGates}. Select a state to inspect its history and uncertainty.`,
        latestValue: stateCode ? model?.observations.at(-1)?.value.toFixed(copy.digits) ?? "No eligible observation" : `${publishableCount} publishable state forecasts`,
        nextUpdate: copy.nextUpdate,
    };
}
async function modeledRespiratory(options: Options): Promise<ModeledForecast> {
    const end = cutoff(options);
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - 4);
    const selectedName = options.stateCode ? jurisdictionByCode(options.stateCode)?.name : null;
    const sharedSelect = "week_end,geography,hsa_nci_id,hsa,hsa_counties,county,trend_source,percent_visits_covid,percent_visits_influenza,percent_visits_rsv";
    const dateWhere = `week_end >= '${start.toISOString().slice(0, 10)}T00:00:00.000' AND week_end <= '${end.toISOString().slice(0, 10)}T23:59:59.999'`;
    const stateQuery = new URLSearchParams({ "$select": sharedSelect, "$where": `${dateWhere} AND trend_source='State'`, "$order": "week_end ASC" });
    const stateRows = z.array(respiratorySchema).parse(await pagedPublicRows(NSSP_ENDPOINT, stateQuery));
    const detailSelect = "distinct week_end,geography,hsa_nci_id,hsa,hsa_counties,trend_source,percent_visits_covid,percent_visits_influenza,percent_visits_rsv";
    const field = RESPIRATORY_FIELDS[options.signalId as keyof typeof RESPIRATORY_FIELDS];
    const states = emptyStates("The state series did not pass Corvid's forecast evidence gates.");
    const stateModels = new Map<IncludedStateCode, {
        observations: ForecastObservation[];
        estimates: ForecastEstimate[];
        publishable: boolean;
    }>();
    startForecastProgress(options);
    for (const state of states) {
        const observations = series(stateRows, (row) => row.geography === state.name && (row.trend_source === "State" || row.hsa_nci_id === "All"), (row) => row.week_end, (row) => row[field]);
        const estimates = boundedEstimates(buildWeeklyForecast(observations, { upperBound: SIGNAL_BY_ID[options.signalId].unit.includes("%") ? 100 : undefined }), options.signalId);
        const estimate = eligibleEstimate(estimates, options.horizon);
        const publishable = estimate?.evidence === "supported" && seriesIsCurrent(observations, options);
        stateModels.set(state.code, { observations, estimates, publishable });
        state.estimate = publishable ? estimate : null;
        state.observedThrough = observations.at(-1)?.date ?? null;
        state.latestObserved = observations.at(-1)?.value ?? null;
        state.observations = observations;
        tickForecastProgress(options);
        await yieldToRequests();
        if (!publishable || !estimate)
            continue;
        state.value = estimate.value;
        state.displayValue = format(estimate.value, options.signalId);
        state.comparisonEligible = true;
        state.note = `Modeled ${options.horizon}-day state forecast with positive skill versus persistence.`;
    }
    const publishableCount = [...stateModels.values()].filter((model) => model.publishable).length;
    const copy = { gates: "history, recency, and skill gates", nationalGates: "evidence gates", digits: 2, nextUpdate: "CDC updates weekly" };
    const hsaDetailsFor = async (stateName: string): Promise<NationalDetailReading[]> => {
        const detailRows = z.array(respiratorySchema).parse(await pagedPublicRows(NSSP_ENDPOINT, new URLSearchParams({ "$select": detailSelect, "$where": `${dateWhere} AND geography='${stateName.replaceAll("'", "''")}' AND hsa_nci_id != 'All'`, "$order": "week_end ASC" })));
        const rows = [...stateRows, ...detailRows];
        const details: NationalDetailReading[] = [];
        const ids = [...new Set(rows.filter((row) => row.geography === stateName && row.hsa_nci_id !== "All").map((row) => row.hsa_nci_id))];
        for (const id of ids) {
            const hsaRows = rows.filter((row) => row.geography === stateName && row.hsa_nci_id === id);
            const observations = series(hsaRows, () => true, (row) => row.week_end, (row) => row[field]);
            const estimate = eligibleEstimate(boundedEstimates(buildWeeklyForecast(observations, { upperBound: SIGNAL_BY_ID[options.signalId].unit.includes("%") ? 100 : undefined }), options.signalId), options.horizon);
            const publishable = estimate?.evidence === "supported" && seriesIsCurrent(observations, options);
            const latest = hsaRows.at(-1);
            await yieldToRequests();
            details.push({ id, name: latest?.hsa ?? `HSA ${id}`, geographyType: "hsa", counties: (latest?.hsa_counties ?? latest?.county ?? "").split(/,|;/).map((item) => item.trim()).filter(Boolean), value: publishable && estimate ? estimate.value : null, displayValue: publishable && estimate ? format(estimate.value, options.signalId) : "Insufficient or stale forecast evidence", observedThrough: observations.at(-1)?.date ?? null, comparisonEligible: publishable, note: "Shared HSA forecast. Repeated county color is not a county estimate.", estimate: publishable ? estimate : null });
        }
        return details;
    };
    const evidence = stateEvidence(options.stateCode ? stateModels.get(options.stateCode) : undefined, options.stateCode, publishableCount, copy);
    const details = selectedName ? await hsaDetailsFor(selectedName) : [];
    const perState: PerStateForecast = async (stateCode) => ({
        evidence: stateEvidence(stateModels.get(stateCode), stateCode, publishableCount, copy),
        details: await hsaDetailsFor(jurisdictionByCode(stateCode)!.name),
    });
    return { states, details, evidence, perState };
}
async function modeledHospital(options: Options): Promise<ModeledForecast> {
    const end = cutoff(options);
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - 4);
    const query = new URLSearchParams({ "$select": "weekendingdate,jurisdiction,totalconfc19newadmper100k,totalconfflunewadmper100k,totalconfrsvnewadmper100k,totalconfc19newadmperchosprep,totalconfflunewadmperchosprep,totalconfrsvnewadmperchosprep,pctconfc19inptbeds,pctconffluinptbeds,pctconfrsvinptbeds,pctconfc19inptbedsperchosprep,pctconffluinptbedsperchosprep,pctconfrsvinptbedsperchosprep,pctinptbedsocc,pcticubedsocc,pctinptbedsoccperchosprep,pcticubedsoccperchosprep", "$where": `weekendingdate >= '${start.toISOString().slice(0, 10)}T00:00:00.000' AND weekendingdate <= '${end.toISOString().slice(0, 10)}T23:59:59.999'`, "$order": "weekendingdate ASC", "$limit": "20000" });
    const rows = parseTrustedRows(hospitalSchema, z.array(z.unknown()).parse(await publicJson(`${NHSN_ENDPOINT}?${query}`)));
    const field = NHSN_FIELDS[options.signalId as keyof typeof NHSN_FIELDS];
    const coverageField = NHSN_COVERAGE_FIELDS[options.signalId as keyof typeof NHSN_COVERAGE_FIELDS];
    const invert = options.signalId === "available-beds" || options.signalId === "icu-availability";
    const states = emptyStates("The state series did not pass Corvid's forecast evidence gates.");
    const models = new Map<IncludedStateCode, {
        observations: ForecastObservation[];
        estimates: ForecastEstimate[];
        publishable: boolean;
    }>();
    startForecastProgress(options);
    for (const state of states) {
        const observations = series(rows, (row) => row.jurisdiction === state.code && hasUsableHospitalReportingCoverage(row[coverageField]), (row) => row.weekendingdate, (row) => row[field] === undefined ? undefined : invert ? Math.max(0, 100 - row[field]!) : row[field]);
        const estimates = boundedEstimates(buildWeeklyForecast(observations, { upperBound: SIGNAL_BY_ID[options.signalId].unit.includes("%") ? 100 : undefined }), options.signalId);
        const estimate = eligibleEstimate(estimates, options.horizon);
        const publishable = estimate?.evidence === "supported" && seriesIsCurrent(observations, options);
        models.set(state.code, { observations, estimates, publishable });
        state.estimate = publishable ? estimate : null;
        state.observedThrough = observations.at(-1)?.date ?? null;
        state.latestObserved = observations.at(-1)?.value ?? null;
        state.observations = observations;
        tickForecastProgress(options);
        await yieldToRequests();
        if (!publishable || !estimate)
            continue;
        state.value = estimate.value;
        state.displayValue = format(estimate.value, options.signalId);
        state.comparisonEligible = true;
        state.note = `Modeled ${options.horizon}-day statewide forecast with positive skill versus persistence.`;
    }
    const publishableCount = [...models.values()].filter((item) => item.publishable).length;
    const copy = { gates: "history, recency, and skill gates", nationalGates: "evidence gates", digits: 2, nextUpdate: "CDC updates weekly" };
    const beforeCohortEnforcement = states.map((state) => ({ ...state }));
    const stateDetail = (stateCode: IncludedStateCode): NationalDetailReading[] => {
        const selected = beforeCohortEnforcement.find((state) => state.code === stateCode);
        return selected ? [{ id: selected.code, name: selected.name, geographyType: "state" as const, counties: [], value: selected.value, displayValue: selected.displayValue, observedThrough: selected.observedThrough, comparisonEligible: selected.comparisonEligible, note: "Statewide forecast. Corvid does not infer county capacity.", estimate: selected.estimate }] : [];
    };
    const evidence = stateEvidence(options.stateCode ? models.get(options.stateCode) : undefined, options.stateCode, publishableCount, copy);
    const perState: PerStateForecast = async (stateCode) => ({ evidence: stateEvidence(models.get(stateCode), stateCode, publishableCount, copy), details: stateDetail(stateCode) });
    return { states, details: options.stateCode ? stateDetail(options.stateCode) : [], evidence, perState };
}
async function modeledNndss(options: Options): Promise<ModeledForecast> {
    const labels = nndssLabelWhere(options.signalId);
    if (!labels)
        throw new Error("No NNDSS source mapping exists for this signal.");
    const end = cutoff(options);
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - 4);
    const query = new URLSearchParams({
        "$select": "states,year,week,label,m1,m1_flag,location1",
        "$where": `label in(${labels}) AND year >= '${start.getUTCFullYear()}' AND year <= '${end.getUTCFullYear()}'`,
        "$order": "year ASC,week ASC",
    });
    const rows = z.array(nndssRowSchema).parse(await pagedPublicRows(NNDSS_ENDPOINT, query));
    const aggregated = aggregateNndssRows(rows).filter((row) => row.date >= start.toISOString().slice(0, 10) && row.date <= end.toISOString().slice(0, 10));
    const states = emptyStates("The provisional NNDSS series did not pass Corvid's history, recency, and skill gates.");
    const models = new Map<IncludedStateCode, {
        observations: ForecastObservation[];
        estimates: ForecastEstimate[];
        publishable: boolean;
    }>();
    startForecastProgress(options);
    for (const state of states) {
        const observations = aggregated.filter((row) => row.code === state.code).map((row) => ({ date: row.date, value: row.value })).sort((left, right) => left.date.localeCompare(right.date));
        const estimates = boundedEstimates(buildWeeklyForecast(observations, { upperBound: SIGNAL_BY_ID[options.signalId].unit.includes("%") ? 100 : undefined }), options.signalId);
        const estimate = eligibleEstimate(estimates, options.horizon);
        const publishable = estimate?.evidence === "supported" && seriesIsCurrent(observations, options);
        models.set(state.code, { observations, estimates, publishable });
        state.estimate = publishable ? estimate : null;
        state.observedThrough = observations.at(-1)?.date ?? null;
        state.latestObserved = observations.at(-1)?.value ?? null;
        state.observations = observations;
        tickForecastProgress(options);
        await yieldToRequests();
        if (!publishable || !estimate)
            continue;
        state.value = estimate.value;
        state.displayValue = `${estimate.value.toFixed(3)} per 100k`;
        state.comparisonEligible = true;
        state.note = `Modeled ${options.horizon}-day provisional incidence forecast with positive skill versus persistence.`;
    }
    const publishableCount = [...models.values()].filter((item) => item.publishable).length;
    const copy = { gates: "NNDSS history, recency, continuity, and skill gates", nationalGates: "NNDSS evidence gates", digits: 3, nextUpdate: "CDC NNDSS updates weekly" };
    const beforeCohortEnforcement = states.map((state) => ({ ...state }));
    const stateDetail = (stateCode: IncludedStateCode): NationalDetailReading[] => {
        const selected = beforeCohortEnforcement.find((state) => state.code === stateCode);
        return selected ? [{ id: selected.code, name: selected.name, geographyType: "state" as const, counties: [], value: selected.value, displayValue: selected.displayValue, observedThrough: selected.observedThrough, comparisonEligible: selected.comparisonEligible, note: "Statewide provisional incidence forecast. County values are not inferred.", estimate: selected.estimate }] : [];
    };
    const evidence = stateEvidence(options.stateCode ? models.get(options.stateCode) : undefined, options.stateCode, publishableCount, copy);
    const perState: PerStateForecast = async (stateCode) => ({ evidence: stateEvidence(models.get(stateCode), stateCode, publishableCount, copy), details: stateDetail(stateCode) });
    return { states, details: options.stateCode ? stateDetail(options.stateCode) : [], evidence, perState };
}
async function modeledWastewater(options: Options): Promise<ModeledForecast> {
    const states = emptyStates("CDC NWSS publishes site-level forecasts. Select a state to inspect reporting sites.");
    if (!options.stateCode)
        return { states, details: [], evidence: { kind: "planning", description: "Wastewater forecasts remain at reporting-site geography. Select a state to load and model its eligible sites.", latestValue: "No state selected", nextUpdate: "CDC NWSS updates weekly" } };
    const selected = jurisdictionByCode(options.stateCode)!;
    const pathogen = NWSS_PATHOGENS[options.signalId as keyof typeof NWSS_PATHOGENS];
    const end = cutoff(options);
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - 4);
    const query = new URLSearchParams({
        "$select": "state_territory,counties_served,site,site_wval,week_end",
        "$where": `pathogen_target='${pathogen}' AND state_territory='${selected.name.replaceAll("'", "''")}' AND week_end >= '${start.toISOString().slice(0, 10)}T00:00:00.000' AND week_end <= '${end.toISOString().slice(0, 10)}T23:59:59.999' AND site_wval is not null`,
        "$order": "week_end ASC",
    });
    const rows = z.array(wastewaterSiteSchema).parse(await pagedPublicRows(NWSS_ENDPOINT, query));
    const siteIds = [...new Set(rows.map((row) => row.site))];
    startForecastProgress(options, siteIds.length || 1);
    const siteModels: Array<{
        id: string;
        observations: ForecastObservation[];
        estimates: ForecastEstimate[];
        publishable: boolean;
    }> = [];
    const details: NationalDetailReading[] = [];
    for (const id of siteIds) {
        const siteRows = rows.filter((row) => row.site === id);
        const observations = series(siteRows, () => true, (row) => row.week_end, (row) => row.site_wval);
        const estimates = boundedEstimates(buildWeeklyForecast(observations, { upperBound: SIGNAL_BY_ID[options.signalId].unit.includes("%") ? 100 : undefined }), options.signalId);
        const estimate = eligibleEstimate(estimates, options.horizon);
        const publishable = estimate?.evidence === "supported" && seriesIsCurrent(observations, options);
        siteModels.push({ id, observations, estimates, publishable });
        const latest = siteRows.at(-1);
        tickForecastProgress(options);
        await yieldToRequests();
        details.push({ id, name: `Wastewater site ${id.replace(/^ID:/, "")}`, geographyType: "site", counties: (latest?.counties_served ?? "").split(/,|;/).map((county) => county.trim()).filter(Boolean), value: publishable && estimate ? estimate.value : null, displayValue: publishable && estimate ? estimate.value.toFixed(2) : "Forecast unavailable", observedThrough: observations.at(-1)?.date ?? null, comparisonEligible: publishable, note: publishable ? `Modeled ${options.horizon}-day site WVAL forecast with positive skill versus persistence.` : "This site did not pass Corvid's history, recency, continuity, and skill gates.", estimate: publishable ? estimate : null, observations: observations.slice(-26), estimates });
    }
    const siteCohort = siteModels.filter((model) => model.publishable).map((model) => model.observations.at(-1)?.date).filter((date): date is string => Boolean(date)).sort().at(-1);
    const representative = siteModels.find((model) => model.publishable && model.observations.at(-1)?.date === siteCohort);
    const evidence: NationalForecastEvidence = representative
        ? { kind: "modeled", model: `Corvid adaptive ensemble v2 for wastewater site ${representative.id.replace(/^ID:/, "")}`, observations: representative.observations.slice(-26), estimates: representative.estimates, evidence: "supported" }
        : { kind: "planning", description: "No reporting-site forecast in the selected state passed the history, recency, continuity, and skill gates.", latestValue: `${siteIds.length} reporting sites evaluated`, nextUpdate: "CDC NWSS updates weekly" };
    return { states, details, evidence };
}
function enforceCommonForecastPeriod(states: NationalForecastState[]) {
    const cohort = states.filter((state) => state.comparisonEligible && state.observedThrough).map((state) => state.observedThrough as string).sort().at(-1);
    if (!cohort)
        return;
    for (const state of states)
        if (state.comparisonEligible && state.observedThrough !== cohort) {
            state.comparisonEligible = false;
            state.note = `Forecast shown for context, but excluded from the ${cohort} comparison cohort.`;
        }
}
function enforceCommonDetailPeriod(details: NationalDetailReading[]) {
    const cohort = details.filter((detail) => detail.comparisonEligible && detail.observedThrough).map((detail) => detail.observedThrough as string).sort().at(-1);
    if (!cohort)
        return;
    for (const detail of details)
        if (detail.comparisonEligible && detail.observedThrough !== cohort) {
            detail.comparisonEligible = false;
            detail.value = null;
            detail.displayValue = "Excluded from current comparison";
            detail.note = `Forecast excluded from the ${cohort} reporting-site comparison cohort.`;
            detail.estimate = null;
        }
}
type ForecastCacheEntry = {
    value: NationalForecastResponse;
    cachedAt: number;
    ttl: number;
};
const FORECAST_CACHE_LIMIT = 32;
const FORECAST_TTL_MS = 43200000;
const PARTIAL_FORECAST_TTL_MS = 300000;
const globalForecastState = globalThis as typeof globalThis & {
    __corvidForecasts?: Map<string, ForecastCacheEntry>;
    __corvidForecastPending?: Map<string, Promise<NationalForecastResponse>>;
};
const forecastCache = globalForecastState.__corvidForecasts ??= new Map<string, ForecastCacheEntry>();
const forecastPending = globalForecastState.__corvidForecastPending ??= new Map<string, Promise<NationalForecastResponse>>();
function forecastCacheKey(options: Options) {
    return `${options.signalId}:${options.stateCode ?? ""}:${options.period ?? ""}:${options.horizon}`;
}
function ownedByServerSnapshot(options: Options) {
    return options.stateCode === null && options.horizon === 28;
}
function cachedForecast(options: Options) {
    const key = forecastCacheKey(options);
    const cached = forecastCache.get(key);
    if (!cached || Date.now() - cached.cachedAt >= cached.ttl) {
        forecastCache.delete(key);
        return null;
    }
    forecastCache.delete(key);
    forecastCache.set(key, cached);
    return cached.value;
}
const BAKED_FORECAST_MAX_AGE_MS = 7 * 86400000;
function forecastDetailsOf(details: NationalDetailReading[]): NationalForecastDetailReading[] {
    return details.map((detail) => ({ ...detail, estimate: detail.estimate ?? null, observations: detail.observations ?? [], estimates: detail.estimates ?? [] }));
}
export async function getBakedNationalForecast(options: Options): Promise<NationalForecastResponse | null> {
    if (options.period || options.horizon !== 28 || options.now || options.recompute)
        return null;
    const [index, slice] = await Promise.all([
        readBakedForecastIndex(options.signalId),
        options.stateCode ? readBakedStateForecast(options.signalId, options.stateCode) : Promise.resolve(null),
    ]);
    if (!index || !index.states.length || (options.stateCode && !slice))
        return null;
    if (!options.stateCode && !index.evidence)
        return null;
    const bakedAt = Date.parse(index.bakedAt);
    if (!(Date.now() - bakedAt <= BAKED_FORECAST_MAX_AGE_MS))
        return null;
    return {
        signalId: options.signalId, signal: SIGNAL_BY_ID[options.signalId], catalog: SIGNAL_CATALOG, horizon: 28, period: null,
        retrievedAt: index.retrievedAt, status: index.status, states: index.states,
        selectedState: options.stateCode, selectedStateName: options.stateCode ? jurisdictionByCode(options.stateCode)?.name ?? null : null,
        evidence: slice?.evidence ?? index.evidence!, details: slice?.details ?? index.details ?? [], errors: index.errors,
    };
}
export async function bakeStateForecasts(signalId: SignalId, now = new Date()): Promise<{
    written: number;
    national: NationalForecastResponse;
} | null> {
    const { response, perState } = await computeForecast({ signalId, stateCode: null, horizon: 28, period: null, recompute: true });
    const carriesData = response.states.some((state) => state.value !== null) || response.details.length > 0;
    if (!carriesData && !perState && response.errors.length)
        return null;
    const byState = new Map<IncludedStateCode, BakedStateForecast>();
    for (const jurisdiction of US_JURISDICTIONS) {
        try {
            if (perState) {
                const { evidence, details } = await perState(jurisdiction.code);
                const forecastDetails = forecastDetailsOf(details);
                enforceCommonDetailPeriod(forecastDetails);
                byState.set(jurisdiction.code, { version: STORE_VERSION, evidence, details: forecastDetails });
            }
            else {
                const forecast = await computeNationalForecast({ signalId, stateCode: jurisdiction.code, horizon: 28, period: null, recompute: true });
                byState.set(jurisdiction.code, { version: STORE_VERSION, evidence: forecast.evidence, details: forecast.details });
            }
        }
        catch (error) {
            console.error(`[forecast-bake] ${signalId} ${jurisdiction.code} failed`, error instanceof Error ? error.name : "unknown error");
        }
        await yieldToRequests();
    }
    if (!byState.size)
        return null;
    await writeBakedForecast(signalId, {
        version: STORE_VERSION, bakedAt: now.toISOString(), retrievedAt: response.retrievedAt, status: response.status,
        states: response.states, errors: response.errors,
        evidence: response.evidence, details: response.details,
    }, byState);
    for (const key of [...forecastCache.keys()])
        if (key.startsWith(`${signalId}:`))
            forecastCache.delete(key);
    return { written: byState.size, national: response };
}
export async function getNationalForecast(options: Options): Promise<NationalForecastResponse> {
    if (options.now)
        return computeNationalForecast(options);
    const cached = options.recompute ? null : cachedForecast(options);
    if (cached)
        return cached;
    const baked = await getBakedNationalForecast(options);
    if (baked)
        return baked;
    const key = forecastCacheKey(options);
    const pending = forecastPending.get(key);
    if (pending)
        return pending;
    const computed = computeNationalForecast(options).then((forecast) => {
        if (!ownedByServerSnapshot(options)) {
            forecastCache.set(key, { value: forecast, cachedAt: Date.now(), ttl: forecast.status === "current" ? FORECAST_TTL_MS : PARTIAL_FORECAST_TTL_MS });
            while (forecastCache.size > FORECAST_CACHE_LIMIT)
                forecastCache.delete(forecastCache.keys().next().value!);
        }
        return forecast;
    }).finally(() => { forecastPending.delete(key); });
    void computed.catch(() => undefined);
    forecastPending.set(key, computed);
    return computed;
}
export function clearNationalForecastCache() {
    forecastCache.clear();
    forecastPending.clear();
}
async function computeNationalForecast(options: Options): Promise<NationalForecastResponse> {
    return (await computeForecast(options)).response;
}
async function computeForecast(options: Options): Promise<{
    response: NationalForecastResponse;
    perState?: PerStateForecast;
}> {
    const now = options.now ?? new Date();
    const errors: Array<{
        source: string;
        message: string;
    }> = [];
    let states: NationalForecastState[];
    let details: NationalDetailReading[];
    let evidence: NationalForecastEvidence;
    let perState: PerStateForecast | undefined;
    try {
        if (Object.hasOwn(RESPIRATORY_FIELDS, options.signalId))
            ({ states, details, evidence, perState } = await modeledRespiratory(options));
        else if (Object.hasOwn(NHSN_FIELDS, options.signalId))
            ({ states, details, evidence, perState } = await modeledHospital(options));
        else if (Object.hasOwn(NNDSS_SIGNAL_LABELS, options.signalId))
            ({ states, details, evidence, perState } = await modeledNndss(options));
        else if (Object.hasOwn(NWSS_PATHOGENS, options.signalId))
            ({ states, details, evidence, perState } = await modeledWastewater(options));
        else if (options.signalId === "heatrisk" && !options.period && options.horizon === 7) {
            const outlook = await getNationalOutlook({ signalId: options.signalId, stateCode: options.stateCode, period: options.period, now: options.now });
            states = outlook.states.map((state) => ({ ...state, estimate: null }));
            details = outlook.details;
            const validThrough = states.map((state) => state.observedThrough).filter((value): value is string => Boolean(value)).sort().at(-1);
            evidence = validThrough ? { kind: "official", validThrough, description: "Official NOAA seven-day HeatRisk outlook. Values are the maximum published category sampled at each state geographic centroid." } : { kind: "none", description: "NOAA did not return a current HeatRisk outlook." };
            errors.push(...outlook.errors);
        }
        else {
            const outlook = await getNationalOutlook({ signalId: options.signalId, stateCode: options.stateCode, period: options.period, now: options.now });
            states = outlook.states.map((state) => ({ ...state, estimate: null }));
            details = outlook.details;
            evidence = { kind: "planning", description: `${SIGNAL_BY_ID[options.signalId].label} is included for planning, but a short-horizon numerical forecast is not defensible from the comparable public history currently available.`, latestValue: options.stateCode ? details.length ? `${details.length} publisher geographies reporting` : states.find((state) => state.code === options.stateCode)?.displayValue ?? "No current evidence" : `${states.filter((state) => state.value !== null).length} states reporting`, nextUpdate: SIGNAL_BY_ID[options.signalId].defaultEvidence === "official" ? "Use the publisher's valid forecast window" : "Varies by publisher" };
            errors.push(...outlook.errors);
        }
    }
    catch (error) {
        states = emptyStates("Forecast source is temporarily unavailable.");
        details = [];
        evidence = { kind: "none", description: "No current forecast was issued because the source could not be validated." };
        errors.push({ source: SIGNAL_BY_ID[options.signalId].source, message: sourceErrorMessage(error) });
    }
    enforceCommonForecastPeriod(states);
    enforceCommonDetailPeriod(details);
    forecastProgress.delete(forecastProgressKey(options));
    const forecastDetails = forecastDetailsOf(details);
    const response: NationalForecastResponse = { signalId: options.signalId, signal: SIGNAL_BY_ID[options.signalId], catalog: SIGNAL_CATALOG, horizon: options.horizon, period: options.period, retrievedAt: now.toISOString(), status: errors.length ? "partial" : "current", states, selectedState: options.stateCode, selectedStateName: options.stateCode ? jurisdictionByCode(options.stateCode)?.name ?? null : null, evidence, details: forecastDetails, errors };
    return { response, perState };
}
