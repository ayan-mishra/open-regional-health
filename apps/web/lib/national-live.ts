import "server-only";
import { z } from "zod";
import type { NationalDetailReading, NationalFeedResponse, NationalOutlookResponse, NationalStateReading } from "@/lib/national-contracts";
import { compactNationalFeed } from "@/lib/national-feed";
import { aggregateNndssRows, nndssLabelWhere, nndssRate, nndssRowSchema, NNDSS_ENDPOINT, NNDSS_SIGNAL_LABELS } from "@/lib/nndss";
import { SIGNAL_BY_ID, SIGNAL_CATALOG, type SignalId } from "@/lib/signal-catalog";
import { jurisdictionByCode, US_JURISDICTIONS, type IncludedStateCode } from "@/lib/us-geography";
import { US_STATE_GEOMETRY } from "@/lib/us-map-geometry";
import { getMassachusettsCountyDetails } from "@/lib/massachusetts-national-details";
import { hasUsableHospitalReportingCoverage, HOSPITAL_REPORTING_COVERAGE_MAX, HOSPITAL_REPORTING_COVERAGE_MIN } from "@/lib/hospital-reporting";
import countyCentroidData from "@/lib/generated/us-county-centroids.json";
import { nonNegativePublisherNumber, optionalNonNegativePublisherNumber, optionalPublisherPercentage, parseTrustedRows } from "@/lib/publisher-values";
import { applyNationalReadingPolicy } from "@/lib/national-reading-policy";
import { cachedPublisherFetch, pinPublisherCacheKey } from "@/lib/publisher-cache";
import { countyNames, normalizedCounty } from "@/lib/county-name";
import { publisherHeaders, TRANSIENT_PUBLISHER_STATUSES } from "@/lib/publisher-request";
import bMiyamotoiPresenceData from "@/lib/generated/b-miyamotoi-presence.json";
import { readBakedSignalIndex, readBakedStateDetail, writeBakedSignal, type BakedStateDetail } from "@/lib/county-detail-store";
import { STORE_VERSION } from "@/lib/state-slice-store";
const TWELVE_HOURS = 43200;
const AIRNOW_TTL = 3600;
const NSSP_ENDPOINT = "https://data.cdc.gov/resource/rdmq-nq56.json";
const NHSN_ENDPOINT = "https://data.cdc.gov/resource/mpgq-jmmr.json";
const NWSS_ENDPOINT = "https://data.cdc.gov/resource/atcp-73re.json";
const HEATRISK_ENDPOINT = "https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer";
const LYME_COUNTY_ENDPOINT = "https://data.cdc.gov/resource/x5j9-wybp.json";
const AIRNOW_DAILY_ENDPOINT = "https://files.airnowtech.org/airnow/today/daily_data_v2.dat";
const COUNTY_POPULATION_ENDPOINT = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv";
const CMS_ED_WAIT_HOSPITAL_ENDPOINT = "https://data.cms.gov/provider-data/api/1/datastore/query/yv7e-xc69/0";
const CMS_ED_WAIT_STATE_ENDPOINT = "https://data.cms.gov/provider-data/api/1/datastore/query/apyc-v239/0";
const PUBLISHER_RETRY_DELAY_MS = 250;
const PUBLISHER_MAX_ATTEMPTS = 3;
const FEED_SIGNAL_TIMEOUT_MS = 5000;
const RESPIRATORY_FEED_SIGNAL_TIMEOUT_MS = 20000;
const SLOW_FEED_SIGNAL_TIMEOUT_MS = 10000;
type PublisherTrend = "Increasing" | "No Change" | "Decreasing";
const trendSchema = z.string().optional().transform((value): PublisherTrend | undefined => value === "Increasing" || value === "No Change" || value === "Decreasing" ? value : undefined);
const respiratorySchema = z.object({
    week_end: z.string(), geography: z.string(), county: z.string().optional().default("All"),
    hsa_nci_id: z.string().optional().default("All"), hsa: z.string().optional(), hsa_counties: z.string().optional(), trend_source: z.string().optional(), fips: z.string().optional(),
    percent_visits_covid: optionalPublisherPercentage, percent_visits_influenza: optionalPublisherPercentage, percent_visits_rsv: optionalPublisherPercentage,
    ed_trends_covid: trendSchema,
    ed_trends_influenza: trendSchema,
    ed_trends_rsv: trendSchema,
});
const hospitalSchema = z.object({
    weekendingdate: z.string(), jurisdiction: z.string(),
    totalconfc19newadmper100k: optionalNonNegativePublisherNumber, totalconfflunewadmper100k: optionalNonNegativePublisherNumber, totalconfrsvnewadmper100k: optionalNonNegativePublisherNumber,
    totalconfc19newadmperchosprep: optionalNonNegativePublisherNumber, totalconfflunewadmperchosprep: optionalNonNegativePublisherNumber, totalconfrsvnewadmperchosprep: optionalNonNegativePublisherNumber,
    pctconfc19inptbeds: optionalPublisherPercentage, pctconffluinptbeds: optionalPublisherPercentage, pctconfrsvinptbeds: optionalPublisherPercentage,
    pctconfc19inptbedsperchosprep: optionalNonNegativePublisherNumber, pctconffluinptbedsperchosprep: optionalNonNegativePublisherNumber, pctconfrsvinptbedsperchosprep: optionalNonNegativePublisherNumber,
    pctinptbedsocc: optionalPublisherPercentage, pcticubedsocc: optionalPublisherPercentage,
    pctinptbedsoccperchosprep: optionalNonNegativePublisherNumber, pcticubedsoccperchosprep: optionalNonNegativePublisherNumber,
});
const wastewaterSiteSchema = z.object({ state_territory: z.string(), counties_served: z.string().optional().default(""), site: z.string(), site_wval: nonNegativePublisherNumber, week_end: z.string() });
const cmsEdWaitStateSchema = z.object({ state: z.string(), score: z.string(), start_date: z.string(), end_date: z.string() });
const cmsEdWaitHospitalSchema = z.object({ facility_id: z.string(), facility_name: z.string(), state: z.string(), countyparish: z.string(), score: z.string(), sample: z.string().optional().default(""), start_date: z.string(), end_date: z.string() });
const heatRiskMetadataSchema = z.object({ timeInfo: z.object({ timeExtent: z.tuple([z.number(), z.number()]) }) });
const heatRiskSamplesSchema = z.object({ samples: z.array(z.object({ locationId: z.number(), value: nonNegativePublisherNumber })) });
type OutlookOptions = {
    signalId: SignalId;
    stateCode: IncludedStateCode | null;
    period: string | null;
    now?: Date;
    includeAllDetails?: boolean;
    deferReadingPolicy?: boolean;
    timeoutMs?: number;
    recompute?: boolean;
    trace?: OutlookTrace;
};
export type OutlookTrace = {
    source?: "memory-cache" | "history-store" | "county-store" | "computed" | "timed-out";
};
type CountyCentroid = {
    fips: string;
    stateFips: string;
    name: string;
    geoCentroid: [
        number,
        number
    ];
};
type StateOutlookCacheEntry = {
    value: NationalOutlookResponse;
    cachedAt: number;
    ttl: number;
};
type DerivedOutlookCacheEntry = {
    states: NationalStateReading[];
    details: NationalDetailReading[];
    cachedAt: number;
    ttl: number;
};
const STATE_OUTLOOK_CACHE_LIMIT = 96;
const DERIVED_OUTLOOK_CACHE_LIMIT = 24;
const STATE_OUTLOOK_TTL_MS = 43200000;
const globalOutlookState = globalThis as typeof globalThis & {
    __corvidStateOutlooks?: Map<string, StateOutlookCacheEntry>;
    __corvidOutlookPending?: Map<string, Promise<NationalOutlookResponse>>;
};
const stateOutlookCache = globalOutlookState.__corvidStateOutlooks ??= new Map<string, StateOutlookCacheEntry>();
const outlookPending = globalOutlookState.__corvidOutlookPending ??= new Map<string, Promise<NationalOutlookResponse>>();
const derivedOutlookCache = new Map<string, DerivedOutlookCacheEntry>();
const COUNTY_CENTROIDS = countyCentroidData as CountyCentroid[];
const COUNTY_NAME_BY_FIPS = new Map(COUNTY_CENTROIDS.map((county) => [county.fips, county.name]));
const STATE_CODE_BY_FIPS = new Map<string, IncludedStateCode>(US_JURISDICTIONS.map((state) => [state.fips, state.code]));
const COUNTY_STATES_BY_NAME = new Map<string, Set<IncludedStateCode>>();
for (const county of COUNTY_CENTROIDS) {
    const stateCode = STATE_CODE_BY_FIPS.get(county.stateFips);
    if (!stateCode)
        continue;
    const name = normalizedCounty(county.name);
    const states = COUNTY_STATES_BY_NAME.get(name) ?? new Set<IncludedStateCode>();
    states.add(stateCode);
    COUNTY_STATES_BY_NAME.set(name, states);
}
const WASTEWATER_SERVICE_STATE_OVERRIDES: Record<string, IncludedStateCode> = {
    "DC:300:MONTGOMERY": "MD",
    "IA:543:DAKOTA": "NE",
    "IA:543:UNION": "SD",
    "NH:1183:CUMBERLAND": "ME",
    "RI:2339:NORFOLK": "MA",
    "RI:2339:WORCESTER": "MA",
    "TN:1837:DADE": "GA",
    "TN:1837:WALKER": "GA",
};
function countiesByState(defaultStateCode: IncludedStateCode, publisherCounties: string[], siteId?: string): Array<[
    IncludedStateCode,
    string[]
]> {
    if (!publisherCounties.length)
        return [[defaultStateCode, []]];
    const groups = new Map<IncludedStateCode, string[]>();
    const normalizedSiteId = siteId?.replace(/^ID:/i, "");
    for (const publisherCounty of publisherCounties) {
        const normalizedPublisherCounty = normalizedCounty(publisherCounty);
        const override = normalizedSiteId ? WASTEWATER_SERVICE_STATE_OVERRIDES[`${defaultStateCode}:${normalizedSiteId}:${normalizedPublisherCounty}`] : undefined;
        const possibleStates = new Set<IncludedStateCode>();
        for (const name of countyNames(publisherCounty))
            for (const state of COUNTY_STATES_BY_NAME.get(name) ?? [])
                possibleStates.add(state);
        const stateCode = override ?? (possibleStates.has(defaultStateCode) ? defaultStateCode : possibleStates.size === 1 ? [...possibleStates][0] : defaultStateCode);
        groups.set(stateCode, [...(groups.get(stateCode) ?? []), publisherCounty]);
    }
    return [...groups.entries()];
}
function dateOnly(value: string) { return value.slice(0, 10); }
function derivedOutlook(key: string, options: OutlookOptions) {
    const cached = derivedOutlookCache.get(key);
    if (!cached)
        return null;
    if (Date.now() - cached.cachedAt >= cached.ttl) {
        derivedOutlookCache.delete(key);
        return null;
    }
    derivedOutlookCache.delete(key);
    derivedOutlookCache.set(key, cached);
    return {
        states: structuredClone(cached.states),
        details: options.includeAllDetails ? structuredClone(cached.details) : options.stateCode ? structuredClone(cached.details.filter((detail) => detail.stateCode === options.stateCode)) : [],
    };
}
function cacheDerivedOutlook(key: string, states: NationalStateReading[], details: NationalDetailReading[], ttl: number, options: OutlookOptions) {
    derivedOutlookCache.delete(key);
    derivedOutlookCache.set(key, { states: structuredClone(states), details: structuredClone(details), cachedAt: Date.now(), ttl });
    while (derivedOutlookCache.size > DERIVED_OUTLOOK_CACHE_LIMIT)
        derivedOutlookCache.delete(derivedOutlookCache.keys().next().value!);
    return derivedOutlook(key, options)!;
}
function sourceErrorMessage(error: unknown) {
    if (error instanceof Error && /^Publisher responded with \d{3}$/.test(error.message))
        return error.message;
    return "Publisher data could not be validated.";
}
function periodBounds(period: string | null, now: Date) {
    if (period) {
        const [year, month] = period.split("-").map(Number);
        const start = `${period}-01T00:00:00.000`;
        const endDate = new Date(Date.UTC(year, month, 1));
        return { start, end: `${endDate.toISOString().slice(0, 10)}T00:00:00.000` };
    }
    const startDate = new Date(now.getTime() - 42 * 86400000);
    return { start: `${startDate.toISOString().slice(0, 10)}T00:00:00.000`, end: `${now.toISOString().slice(0, 10)}T23:59:59.999` };
}
async function publisherResponse(url: string, accept: string) {
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt < PUBLISHER_MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store", headers: publisherHeaders(url, accept) });
            if (response.ok)
                return response;
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
    return cachedPublisherFetch(url, TWELVE_HOURS, async () => (await publisherResponse(url, "application/json")).json());
}
function emptyStates(note: string): NationalStateReading[] {
    return US_JURISDICTIONS.map((state) => ({ code: state.code, name: state.name, value: null, displayValue: "No comparable data", observedThrough: null, comparisonEligible: false, note }));
}
function latestBy<T>(rows: T[], key: (row: T) => string, date: (row: T) => string) {
    const result = new Map<string, T>();
    for (const row of rows) {
        const id = key(row);
        const current = result.get(id);
        if (!current || date(row) > date(current))
            result.set(id, row);
    }
    return result;
}
function meanBy<T>(rows: T[], key: (row: T) => string, date: (row: T) => string, fields: readonly (keyof T)[]) {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
        const id = key(row);
        const group = groups.get(id);
        if (group)
            group.push(row);
        else
            groups.set(id, [row]);
    }
    const result = new Map<string, T>();
    for (const [id, group] of groups) {
        const representative = group.reduce((latest, row) => (date(row) > date(latest) ? row : latest));
        const averaged = { ...representative };
        for (const field of fields) {
            const values = group.map((row) => row[field]).filter((value): value is T[keyof T] & number => typeof value === "number" && Number.isFinite(value));
            if (values.length)
                averaged[field] = (values.reduce((sum, value) => sum + value, 0) / values.length) as T[keyof T];
        }
        result.set(id, averaged);
    }
    return result;
}
function reduceBy<T>(period: string | null, rows: T[], key: (row: T) => string, date: (row: T) => string, fields: readonly (keyof T)[]) {
    return period ? meanBy(rows, key, date, fields) : latestBy(rows, key, date);
}
const RESPIRATORY_MEASURES = ["percent_visits_covid", "percent_visits_influenza", "percent_visits_rsv"] as const;
const HOSPITAL_MEASURES = [
    "totalconfc19newadmper100k", "totalconfflunewadmper100k", "totalconfrsvnewadmper100k",
    "totalconfc19newadmperchosprep", "totalconfflunewadmperchosprep", "totalconfrsvnewadmperchosprep",
    "pctconfc19inptbeds", "pctconffluinptbeds", "pctconfrsvinptbeds",
    "pctconfc19inptbedsperchosprep", "pctconffluinptbedsperchosprep", "pctconfrsvinptbedsperchosprep",
    "pctinptbedsocc", "pcticubedsocc", "pctinptbedsoccperchosprep", "pcticubedsoccperchosprep",
] as const;
const RESPIRATORY_FIELDS = {
    "covid-ed": ["percent_visits_covid", "ed_trends_covid"],
    "influenza-ed": ["percent_visits_influenza", "ed_trends_influenza"],
    "rsv-ed": ["percent_visits_rsv", "ed_trends_rsv"],
} as const;
async function respiratoryOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const bounds = periodBounds(options.period, options.now ?? new Date());
    const selectedName = options.stateCode ? jurisdictionByCode(options.stateCode)?.name : null;
    const query = (geographyClause: string) => new URLSearchParams({
        "$select": "week_end,geography,county,hsa_nci_id,hsa,hsa_counties,trend_source,fips,percent_visits_covid,percent_visits_influenza,percent_visits_rsv,ed_trends_covid,ed_trends_influenza,ed_trends_rsv",
        "$where": `week_end >= '${bounds.start}' AND week_end < '${bounds.end}' AND ${geographyClause}`,
        "$order": "week_end DESC", "$limit": "50000",
    });
    const detailClause = options.includeAllDetails
        ? "hsa_nci_id!='All'"
        : selectedName ? `geography='${selectedName.replaceAll("'", "''")}' AND hsa_nci_id!='All'` : null;
    const [statePayload, detailPayload] = await Promise.all([
        publicJson(`${NSSP_ENDPOINT}?${query("trend_source='State'")}`),
        detailClause ? publicJson(`${NSSP_ENDPOINT}?${query(detailClause)}`) : Promise.resolve([]),
    ]);
    const rows = [...z.array(respiratorySchema).parse(statePayload), ...z.array(respiratorySchema).parse(detailPayload)];
    const [valueField, trendField] = RESPIRATORY_FIELDS[options.signalId as keyof typeof RESPIRATORY_FIELDS];
    const stateRows = reduceBy(options.period, rows.filter((row) => row.trend_source === "State" || row.hsa_nci_id === "All"), (row) => row.geography, (row) => row.week_end, RESPIRATORY_MEASURES);
    const cohortPeriod = [...stateRows.values()].filter((row) => US_JURISDICTIONS.some((state) => state.name === row.geography) && row[valueField] !== undefined).map((row) => dateOnly(row.week_end)).sort().at(-1) ?? null;
    const states = emptyStates("CDC NSSP did not publish a comparable state observation for this period.");
    for (const state of states) {
        const row = stateRows.get(state.name);
        const value = row?.[valueField];
        if (value === undefined || row === undefined)
            continue;
        state.value = value;
        state.displayValue = `${value.toFixed(2)}%`;
        state.observedThrough = dateOnly(row.week_end);
        state.publisherEligible = true;
        state.comparisonEligible = state.observedThrough === cohortPeriod;
        state.trend = row[trendField];
        state.note = state.comparisonEligible ? "Publisher state observation from CDC NSSP." : `Shown for context, but excluded from the ${cohortPeriod ?? "current"} comparison cohort.`;
    }
    const hsaRows = selectedName || options.includeAllDetails
        ? [...reduceBy(options.period, rows.filter((row) => row.hsa_nci_id !== "All" && (options.includeAllDetails || row.geography === selectedName)), (row) => `${row.geography}:${row.hsa_nci_id}`, (row) => row.week_end, RESPIRATORY_MEASURES).values()]
        : [];
    const hsaCohortPeriod = hsaRows.map((row) => dateOnly(row.week_end)).sort().at(-1) ?? null;
    const details = hsaRows.map((row): NationalDetailReading => {
        const value = row[valueField] ?? null;
        const observedThrough = dateOnly(row.week_end);
        const isCurrentIssue = observedThrough === hsaCohortPeriod;
        const eligible = value !== null;
        const note = value === null
            ? "CDC NSSP publishes no value for this Health Service Area in the current reporting week."
            : isCurrentIssue
                ? "Shared HSA observation from CDC NSSP, not a county estimate."
                : `Shared HSA observation from CDC NSSP's ${observedThrough} reporting week, a week behind the current cohort.`;
        const stateCode = US_JURISDICTIONS.find((state) => state.name === row.geography)?.code;
        return { id: options.includeAllDetails ? `${stateCode ?? row.geography}:${row.hsa_nci_id}` : row.hsa_nci_id, name: row.hsa ?? `HSA ${row.hsa_nci_id}`, stateCode, geographyType: "hsa", counties: (row.hsa_counties ?? row.county).split(/,|;/).map((item) => item.trim()).filter(Boolean), value, displayValue: value === null ? "No data" : `${value.toFixed(2)}%`, observedThrough, publisherEligible: value !== null, comparisonEligible: eligible, isStale: value !== null && !isCurrentIssue ? true : undefined, note };
    });
    return { states, details };
}
const NHSN_FIELDS = {
    "influenza-admissions": ["totalconfflunewadmper100k", "totalconfflunewadmperchosprep", false, ""],
    "covid-admissions": ["totalconfc19newadmper100k", "totalconfc19newadmperchosprep", false, ""],
    "rsv-admissions": ["totalconfrsvnewadmper100k", "totalconfrsvnewadmperchosprep", false, ""],
    "covid-inpatient-burden": ["pctconfc19inptbeds", "pctconfc19inptbedsperchosprep", false, "%"],
    "influenza-inpatient-burden": ["pctconffluinptbeds", "pctconffluinptbedsperchosprep", false, "%"],
    "rsv-inpatient-burden": ["pctconfrsvinptbeds", "pctconfrsvinptbedsperchosprep", false, "%"],
    "available-beds": ["pctinptbedsocc", "pctinptbedsoccperchosprep", true, "%"],
    "icu-availability": ["pcticubedsocc", "pcticubedsoccperchosprep", true, "%"],
} as const;
async function hospitalOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const bounds = periodBounds(options.period, options.now ?? new Date());
    const query = new URLSearchParams({
        "$select": "weekendingdate,jurisdiction,totalconfc19newadmper100k,totalconfflunewadmper100k,totalconfrsvnewadmper100k,totalconfc19newadmperchosprep,totalconfflunewadmperchosprep,totalconfrsvnewadmperchosprep,pctconfc19inptbeds,pctconffluinptbeds,pctconfrsvinptbeds,pctconfc19inptbedsperchosprep,pctconffluinptbedsperchosprep,pctconfrsvinptbedsperchosprep,pctinptbedsocc,pcticubedsocc,pctinptbedsoccperchosprep,pcticubedsoccperchosprep",
        "$where": `weekendingdate >= '${bounds.start}' AND weekendingdate < '${bounds.end}'`, "$order": "weekendingdate DESC", "$limit": "10000",
    });
    const rows = parseTrustedRows(hospitalSchema, z.array(z.unknown()).parse(await publicJson(`${NHSN_ENDPOINT}?${query}`)));
    const latest = reduceBy(options.period, rows, (row) => row.jurisdiction, (row) => row.weekendingdate, HOSPITAL_MEASURES);
    const [valueField, coverageField, invert, suffix] = NHSN_FIELDS[options.signalId as keyof typeof NHSN_FIELDS];
    const states = emptyStates("CDC NHSN did not publish a comparable state observation for this period.");
    const cohortPeriod = [...latest.values()].filter((row) => US_JURISDICTIONS.some((state) => state.code === row.jurisdiction) && row[valueField] !== undefined).map((row) => dateOnly(row.weekendingdate)).sort().at(-1) ?? null;
    for (const state of states) {
        const row = latest.get(state.code);
        const raw = row?.[valueField];
        const coverage = row?.[coverageField];
        if (raw === undefined || row === undefined)
            continue;
        const value = invert ? Math.max(0, 100 - raw) : raw;
        state.value = value;
        state.displayValue = `${value.toFixed(2)}${suffix}`;
        state.observedThrough = dateOnly(row.weekendingdate);
        state.publisherEligible = hasUsableHospitalReportingCoverage(coverage);
        state.comparisonEligible = state.publisherEligible && state.observedThrough === cohortPeriod;
        state.note = state.comparisonEligible ? "Comparable CDC NHSN state observation." : coverage === undefined ? "Shown for context, but reporting coverage was not published." : !hasUsableHospitalReportingCoverage(coverage) ? `Excluded from comparison because hospital reporting was ${coverage.toFixed(0)}%; expected ${HOSPITAL_REPORTING_COVERAGE_MIN}% to ${HOSPITAL_REPORTING_COVERAGE_MAX}%.` : `Shown for context, but excluded from the ${cohortPeriod ?? "current"} comparison cohort.`;
    }
    const selectedStates = options.includeAllDetails ? states.filter((state) => state.value !== null) : options.stateCode ? states.filter((state) => state.code === options.stateCode) : [];
    const details = selectedStates.map((selected) => ({ id: options.includeAllDetails ? `state:${selected.code}` : selected.code, name: selected.name, stateCode: selected.code, geographyType: "state" as const, counties: [], value: selected.value, displayValue: selected.displayValue, observedThrough: selected.observedThrough, publisherEligible: selected.publisherEligible, comparisonEligible: selected.comparisonEligible, note: "Statewide NHSN signal. County borders do not imply county measurements." }));
    return { states, details };
}
const CMS_ED_WAIT_MEASURE = "OP_18b";
const CMS_PAGE_SIZE = 1500;
function cmsMeasureUrl(endpoint: string, offset = 0, stateCode?: IncludedStateCode) {
    const query = new URLSearchParams({
        limit: String(CMS_PAGE_SIZE),
        offset: String(offset),
        "conditions[0][property]": "measure_id",
        "conditions[0][value]": CMS_ED_WAIT_MEASURE,
        "conditions[0][operator]": "=",
    });
    if (stateCode) {
        query.set("conditions[1][property]", "state");
        query.set("conditions[1][value]", stateCode);
        query.set("conditions[1][operator]", "=");
    }
    return `${endpoint}?${query}`;
}
function cmsDate(value: string) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
}
function cmsScore(value: string) {
    const score = Number(value);
    return value.trim() !== "" && Number.isFinite(score) && score >= 0 ? score : null;
}
async function cmsEdWaitOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const resultSchema = <T extends z.ZodType>(rowSchema: T) => z.object({ count: z.coerce.number().int().nonnegative(), results: z.array(rowSchema) });
    const needsHospitalDetail = Boolean(options.stateCode) || Boolean(options.includeAllDetails);
    const selectedState = options.stateCode && !options.includeAllDetails ? options.stateCode : undefined;
    const [statePage, firstHospitalPage] = await Promise.all([
        publicJson(cmsMeasureUrl(CMS_ED_WAIT_STATE_ENDPOINT)),
        needsHospitalDetail ? publicJson(cmsMeasureUrl(CMS_ED_WAIT_HOSPITAL_ENDPOINT, 0, selectedState)) : Promise.resolve(null),
    ]);
    const stateResult = resultSchema(cmsEdWaitStateSchema).parse(statePage);
    const states = emptyStates("CMS Care Compare did not publish a numeric state emergency-department length-of-stay measure.");
    const stateRows = new Map(stateResult.results.map((row) => [row.state.toUpperCase(), row]));
    for (const state of states) {
        const row = stateRows.get(state.code);
        if (!row)
            continue;
        const value = cmsScore(row.score);
        const observedThrough = cmsDate(row.end_date);
        if (value === null || !observedThrough)
            continue;
        state.value = value;
        state.displayValue = `${value.toFixed(0)} minutes`;
        state.observedThrough = observedThrough;
        state.publisherEligible = true;
        state.comparisonEligible = true;
        state.note = `CMS Care Compare statewide median for discharged emergency-department visits measured ${row.start_date} through ${row.end_date}; transferred and psychiatric/mental-health visits are excluded.`;
    }
    if (!needsHospitalDetail)
        return { states, details: [] };
    const firstHospitalResult = resultSchema(cmsEdWaitHospitalSchema).parse(firstHospitalPage);
    const remainingOffsets = Array.from({ length: Math.max(0, Math.ceil(firstHospitalResult.count / CMS_PAGE_SIZE) - 1) }, (_, index) => (index + 1) * CMS_PAGE_SIZE);
    const remainingPages = await Promise.all(remainingOffsets.map((offset) => publicJson(cmsMeasureUrl(CMS_ED_WAIT_HOSPITAL_ENDPOINT, offset, selectedState))));
    const hospitalRows = [
        ...firstHospitalResult.results,
        ...remainingPages.flatMap((page) => resultSchema(cmsEdWaitHospitalSchema).parse(page).results),
    ];
    const validStateCodes = new Set(US_JURISDICTIONS.map((state) => state.code));
    const details = hospitalRows.flatMap((row): NationalDetailReading[] => {
        const stateCode = row.state.toUpperCase() as IncludedStateCode;
        const value = cmsScore(row.score);
        const observedThrough = cmsDate(row.end_date);
        if (!validStateCodes.has(stateCode) || value === null || !observedThrough || !row.countyparish.trim())
            return [];
        if (options.stateCode && !options.includeAllDetails && stateCode !== options.stateCode)
            return [];
        const sample = cmsScore(row.sample);
        return [{
                id: `cms:${row.facility_id}:${CMS_ED_WAIT_MEASURE}`,
                name: row.facility_name,
                stateCode,
                geographyType: "site",
                counties: [row.countyparish],
                value,
                displayValue: `${value.toFixed(0)} minutes`,
                observedThrough,
                publisherEligible: true,
                comparisonEligible: true,
                note: `CMS Care Compare facility median for discharged emergency-department visits measured ${row.start_date} through ${row.end_date}${sample === null ? "" : ` (${sample.toLocaleString()} reported visits)`}. This is a hospital observation mapped to its reported county, not a countywide estimate.`,
            }];
    });
    return { states, details };
}
async function publicText(url: string, ttlSeconds = TWELVE_HOURS) {
    return cachedPublisherFetch(url, ttlSeconds, async () => (await publisherResponse(url, "*/*")).text());
}
function csvFields(line: string) {
    const fields: string[] = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' && quoted && line[index + 1] === '"') {
            value += '"';
            index += 1;
        }
        else if (character === '"')
            quoted = !quoted;
        else if (character === "," && !quoted) {
            fields.push(value);
            value = "";
        }
        else
            value += character;
    }
    fields.push(value);
    return fields;
}
async function nndssOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const labels = nndssLabelWhere(options.signalId);
    if (!labels)
        return { states: emptyStates("No CDC NNDSS mapping exists for this signal."), details: [] };
    const now = options.now ?? new Date();
    const targetYear = Number((options.period ?? now.toISOString().slice(0, 7)).slice(0, 4));
    const archivedSeries = options.signalId === "anaplasmosis-cases" || options.signalId === "babesiosis-cases";
    const yearClause = !options.period && archivedSeries
        ? `year >= '${targetYear - 4}' AND year <= '${targetYear}'`
        : `year = '${targetYear}'`;
    const query = new URLSearchParams({
        "$select": "states,year,week,label,m1,m1_flag,location1",
        "$where": `label in(${labels}) AND ${yearClause}`,
        "$order": "year DESC,week DESC",
        "$limit": "50000",
    });
    const rows = z.array(nndssRowSchema).parse(await publicJson(`${NNDSS_ENDPOINT}?${query}`));
    const allObservations = aggregateNndssRows(rows);
    const observations = options.period
        ? allObservations.filter((row) => { const bounds = periodBounds(options.period, now); return row.date >= bounds.start.slice(0, 10) && row.date < bounds.end.slice(0, 10); })
        : allObservations.filter((row) => row.date <= now.toISOString().slice(0, 10));
    const latest = reduceBy(options.period, observations, (row) => row.code, (row) => row.date, ["value"]);
    const cohortPeriod = [...latest.values()].map((row) => row.date).sort().at(-1) ?? null;
    const states = emptyStates("CDC NNDSS did not publish a numeric weekly case count for this period.");
    for (const state of states) {
        const row = latest.get(state.code);
        if (!row)
            continue;
        state.value = row.value;
        state.displayValue = `${row.value.toFixed(3)} per 100k`;
        state.observedThrough = row.date;
        state.publisherEligible = true;
        state.comparisonEligible = row.date === cohortPeriod;
        state.note = state.comparisonEligible
            ? "Provisional weekly CDC NNDSS cases normalized with the 2020 Census resident population."
            : `Shown for context, but excluded from the ${cohortPeriod ?? "current"} comparison cohort.`;
    }
    const selectedStates = options.includeAllDetails ? states.filter((state) => state.value !== null) : options.stateCode ? states.filter((state) => state.code === options.stateCode) : [];
    const details = selectedStates.map((selected) => ({ id: options.includeAllDetails ? `state:${selected.code}` : selected.code, name: selected.name, stateCode: selected.code, geographyType: "state" as const, counties: [], value: selected.value, displayValue: selected.displayValue, observedThrough: selected.observedThrough, publisherEligible: selected.publisherEligible, comparisonEligible: selected.comparisonEligible, note: "Statewide provisional NNDSS incidence. County values are not inferred." }));
    return { states, details };
}
const COUNTY_POPULATION_KEY = "derived:county-population";
pinPublisherCacheKey(COUNTY_POPULATION_KEY);
function countyPopulationMap(): Promise<Map<string, number>> {
    return cachedPublisherFetch(COUNTY_POPULATION_KEY, TWELVE_HOURS, parseCountyPopulation);
}
async function parseCountyPopulation() {
    const populationText = await publicText(COUNTY_POPULATION_ENDPOINT);
    const populationLines = populationText.trim().split(/\r?\n/);
    const populationHeader = csvFields(populationLines[0]);
    const stateIndex = populationHeader.indexOf("STATE");
    const countyIndex = populationHeader.indexOf("COUNTY");
    const populationIndex = populationHeader.indexOf("POPESTIMATE2025");
    if ([stateIndex, countyIndex, populationIndex].some((index) => index < 0))
        throw new Error("Census county population columns are unavailable");
    return new Map(populationLines.slice(1).map(csvFields).map((row) => [`${row[stateIndex].padStart(2, "0")}${row[countyIndex].padStart(3, "0")}`, Number(row[populationIndex])]));
}
const lymeAggregateSchema = z.object({ state: z.string(), year: z.coerce.number().int(), cases: nonNegativePublisherNumber });
const lymeCountySchema = z.object({ fips: z.string(), cases: nonNegativePublisherNumber });
async function lymeOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const requestedYear = options.period ? Number(options.period.slice(0, 4)) : null;
    const yearQuery = new URLSearchParams({ "$select": "max(year) as year" });
    const [latestYearRow] = z.array(z.object({ year: z.coerce.number() })).parse(await publicJson(`${LYME_COUNTY_ENDPOINT}?${yearQuery}`));
    const year = requestedYear ?? latestYearRow?.year;
    if (!year)
        return { states: emptyStates("CDC did not publish a county Lyme surveillance year."), details: [] };
    const stateQuery = new URLSearchParams({ "$select": "state,year,sum(frequency) as cases", "$where": `year='${year}'`, "$group": "state,year", "$limit": "100" });
    const aggregates = z.array(lymeAggregateSchema).parse(await publicJson(`${LYME_COUNTY_ENDPOINT}?${stateQuery}`));
    const byState = new Map(aggregates.map((row) => [row.state, row]));
    const states = emptyStates(`CDC county Lyme public-use data are not available for ${year}.`);
    for (const state of states) {
        const row = byState.get(state.code);
        if (!row)
            continue;
        const value = nndssRate(row.cases, state.code);
        state.value = value;
        state.displayValue = `${value.toFixed(1)} per 100k`;
        state.observedThrough = `${year}-12-31`;
        state.comparisonEligible = true;
        state.note = `Annual CDC county-of-residence Lyme cases aggregated to state for ${year}.`;
    }
    if (!options.stateCode && !options.includeAllDetails)
        return { states, details: [] };
    const countyWhere = options.includeAllDetails ? `year='${year}'` : `state='${options.stateCode}' and year='${year}'`;
    const countyQuery = new URLSearchParams({ "$select": "fips,sum(frequency) as cases", "$where": countyWhere, "$group": "fips", "$order": "fips", "$limit": "5000" });
    const [countyRows, population] = await Promise.all([
        z.array(lymeCountySchema).parse(await publicJson(`${LYME_COUNTY_ENDPOINT}?${countyQuery}`)),
        countyPopulationMap(),
    ]);
    const details = countyRows.flatMap((row): NationalDetailReading[] => {
        const denominator = population.get(row.fips);
        const name = COUNTY_NAME_BY_FIPS.get(row.fips);
        if (!denominator || !name)
            return [];
        const value = row.cases / denominator * 100000;
        const stateCode = US_JURISDICTIONS.find((state) => state.fips === row.fips.slice(0, 2))?.code;
        if (!stateCode)
            return [];
        return [{ id: `county:${row.fips}`, name: `${name} County`, stateCode, geographyType: "county", counties: [name], value, ratioBasis: { numerator: row.cases, denominator, scale: 100000, denominatorVintage: "Census 2025" }, displayValue: `${value.toFixed(1)} per 100k`, observedThrough: `${year}-12-31`, comparisonEligible: true, stateAggregationEligible: true, note: `${row.cases.toLocaleString()} reported Lyme cases among county residents in ${year}, normalized with the Census 2025 county population estimate. County of residence may differ from exposure location.` }];
    });
    return { states, details };
}
const ARBONET_DISEASES = { "wnv-activity": "WNV", "powassan-cases": "POW" } as const;
const ARBONET_CURRENT_ENDPOINT = (code: string) => `https://www.cdc.gov/wcms/vizdata/live/ncezid_dvbd/${code}/${code.toLowerCase()}_current_hum_nonhum.csv`;
async function arbonetOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const code = ARBONET_DISEASES[options.signalId as keyof typeof ARBONET_DISEASES];
    const now = options.now ?? new Date();
    const year = now.getUTCFullYear();
    const asOf = now.toISOString().slice(0, 10);
    const text = await publicText(ARBONET_CURRENT_ENDPOINT(code));
    const lines = text.trim().split(/\r?\n/);
    const header = csvFields(lines[0]);
    const fipsIndex = header.indexOf("County");
    const activityIndex = header.indexOf("Activity");
    const casesIndex = header.indexOf("Total human disease cases");
    if (fipsIndex < 0 || activityIndex < 0 || casesIndex < 0)
        throw new Error("CDC ArboNET county columns are unavailable");
    const allRows = lines.slice(1).map(csvFields).flatMap((row) => {
        const rawFips = row[fipsIndex]?.trim() ?? "";
        const cases = Number(row[casesIndex]);
        if (!/^\d{1,5}$/.test(rawFips) || row[casesIndex]?.trim() === "" || !Number.isInteger(cases) || cases < 0)
            return [];
        return [{ fips: rawFips.padStart(5, "0"), activity: row[activityIndex]?.trim() ?? "", cases }];
    });
    const casesByState = new Map<IncludedStateCode, number>();
    const reportingStates = new Set<IncludedStateCode>();
    for (const row of allRows) {
        const stateCode = US_JURISDICTIONS.find((state) => state.fips === row.fips.slice(0, 2))?.code;
        if (!stateCode)
            continue;
        reportingStates.add(stateCode);
        casesByState.set(stateCode, (casesByState.get(stateCode) ?? 0) + row.cases);
    }
    const countyCases = allRows;
    const states = emptyStates(`CDC ArboNET did not report a county of residence for this disease in ${year}.`);
    for (const state of states) {
        if (!reportingStates.has(state.code))
            continue;
        const cases = casesByState.get(state.code) ?? 0;
        const value = nndssRate(cases, state.code);
        state.value = value;
        state.displayValue = `${value.toFixed(2)} per 100k`;
        state.observedThrough = asOf;
        state.comparisonEligible = true;
        state.note = `${cases.toLocaleString()} ${year} season-to-date CDC ArboNET cases of county-of-residence, normalized with the 2020 Census resident population.`;
    }
    if (!options.stateCode && !options.includeAllDetails)
        return { states, details: [] };
    const population = await countyPopulationMap();
    const details = countyCases.flatMap((row): NationalDetailReading[] => {
        const denominator = population.get(row.fips);
        const name = COUNTY_NAME_BY_FIPS.get(row.fips);
        if (!denominator || !name)
            return [];
        const stateCode = US_JURISDICTIONS.find((state) => state.fips === row.fips.slice(0, 2))?.code;
        if (!stateCode || (options.stateCode && !options.includeAllDetails && stateCode !== options.stateCode))
            return [];
        const value = row.cases / denominator * 100000;
        const activityNote = row.cases === 0
            ? row.activity
                ? ` CDC ArboNET lists ${row.activity.toLowerCase()} in this county while reporting zero human disease cases.`
                : " CDC ArboNET includes this county in the source table while reporting zero human disease cases."
            : "";
        return [{ id: `county:${row.fips}`, name: `${name} County`, stateCode, geographyType: "county", counties: [name], value, ratioBasis: { numerator: row.cases, denominator, scale: 100000, denominatorVintage: "Census 2025" }, displayValue: `${value.toFixed(2)} per 100k`, observedThrough: asOf, comparisonEligible: true, stateAggregationEligible: true, note: `${row.cases.toLocaleString()} reported CDC ArboNET cases among county residents this season (${year}), normalized with the Census 2025 county population estimate.${activityNote} County of residence may differ from exposure location.` }];
    });
    return { states, details };
}
const CDC_TICKBORNE_COUNTY_WORKBOOK = "https://www.cdc.gov/ticks/media/files/2024/05/AllTBD2022_Public.xlsx";
const TICKBORNE_COUNTY_DISEASES = { "anaplasmosis-cases": "Anaplasmosis", "babesiosis-cases": "Babesiosis" } as const;
const TICKBORNE_COUNTY_YEAR = 2022;
async function publicWorkbookRows(url: string, sheetName?: string): Promise<unknown[][]> {
    return cachedPublisherFetch(`${url}:${sheetName ?? "first"}`, TWELVE_HOURS, async () => {
        const XLSX = await import("@e965/xlsx");
        const response = await publisherResponse(url, "*/*");
        const workbook = XLSX.read(await response.arrayBuffer(), { type: "array" });
        const worksheet = workbook.Sheets[sheetName ?? workbook.SheetNames[0]];
        if (!worksheet)
            throw new Error(`Publisher workbook sheet ${sheetName ?? "1"} is unavailable`);
        return XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null, raw: true }) as unknown[][];
    });
}
async function tickborneCountyDetails(signalId: SignalId, stateCode: IncludedStateCode | null, includeAllDetails?: boolean): Promise<NationalDetailReading[]> {
    const disease = TICKBORNE_COUNTY_DISEASES[signalId as keyof typeof TICKBORNE_COUNTY_DISEASES];
    if (!disease)
        return [];
    const rows = await publicWorkbookRows(CDC_TICKBORNE_COUNTY_WORKBOOK);
    const header = rows[0] as string[];
    const fipsIndex = header.indexOf("FIPS");
    const diseaseIndex = header.indexOf(disease);
    if (fipsIndex < 0 || diseaseIndex < 0)
        throw new Error("CDC tickborne workbook columns are unavailable");
    const population = await countyPopulationMap();
    return rows.slice(1).flatMap((row): NationalDetailReading[] => {
        const fips = String(row[fipsIndex] ?? "").padStart(5, "0");
        const rawCases = row[diseaseIndex];
        const cases = typeof rawCases === "number" ? rawCases : typeof rawCases === "string" && rawCases.trim() !== "" ? Number(rawCases) : Number.NaN;
        const name = COUNTY_NAME_BY_FIPS.get(fips);
        const denominator = population.get(fips);
        if (!name || !denominator || !Number.isInteger(cases) || cases < 0)
            return [];
        const countyStateCode = US_JURISDICTIONS.find((state) => state.fips === fips.slice(0, 2))?.code;
        if (!countyStateCode || (stateCode && !includeAllDetails && countyStateCode !== stateCode))
            return [];
        const value = cases / denominator * 100000;
        return [{
                id: `county:${fips}`, name: `${name} County`, stateCode: countyStateCode, geographyType: "county", counties: [name],
                value, displayValue: `${value.toFixed(1)} per 100k`, observedThrough: `${TICKBORNE_COUNTY_YEAR}-12-31`,
                comparisonEligible: true, stateAggregationEligible: false,
                note: `${cases.toLocaleString()} reported ${disease} cases by county of residence in CDC's ${TICKBORNE_COUNTY_YEAR} national tickborne disease surveillance file, normalized with the Census 2025 county population estimate. This is an annual county rate; the national state view uses the latest available weekly NNDSS rate. County of residence may differ from exposure location.`,
            }];
    });
}
const CDC_IXODES_PATHOGEN_YEAR = 2025;
const B_MIYAMOTOI_PRESENCE = bMiyamotoiPresenceData as Array<{
    fips: string;
    stateCode: IncludedStateCode;
    source: string;
}>;
async function bMiyamotoiOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const presentRows = B_MIYAMOTOI_PRESENCE.flatMap((row) => {
        const name = COUNTY_NAME_BY_FIPS.get(row.fips);
        return name && STATE_CODE_BY_FIPS.get(row.fips.slice(0, 2)) === row.stateCode ? [{ ...row, name }] : [];
    });
    const states = emptyStates("CDC classifies this jurisdiction's counties as 'No records'; this does not mean B. miyamotoi is absent or that every county was sampled.");
    const counts = new Map<IncludedStateCode, number>();
    for (const row of presentRows)
        counts.set(row.stateCode, (counts.get(row.stateCode) ?? 0) + 1);
    for (const state of states) {
        const count = counts.get(state.code);
        if (!count)
            continue;
        state.value = count;
        state.displayValue = `${count} ${count === 1 ? "county" : "counties"} with documented presence`;
        state.observedThrough = `${CDC_IXODES_PATHOGEN_YEAR}-12-31`;
        state.publisherEligible = true;
        state.comparisonEligible = false;
        state.note = `CDC documents B. miyamotoi in host-seeking Ixodes ticks in ${count} ${count === 1 ? "county" : "counties"}. This is a cumulative surveillance status, not a prevalence or human-risk rank; "No records" does not mean absence.`;
    }
    if (!options.stateCode && !options.includeAllDetails)
        return { states, details: [] };
    const details = presentRows.flatMap((row): NationalDetailReading[] => {
        if (options.stateCode && !options.includeAllDetails && row.stateCode !== options.stateCode)
            return [];
        return [{
                id: `county:${row.fips}`,
                name: `${row.name} County`,
                stateCode: row.stateCode,
                geographyType: "county",
                counties: [row.name],
                value: 1,
                displayValue: "Documented presence",
                observedThrough: `${CDC_IXODES_PATHOGEN_YEAR}-12-31`,
                publisherEligible: true,
                comparisonEligible: false,
                stateAggregationEligible: false,
                note: `CDC documents B. miyamotoi in host-seeking blacklegged or western blacklegged ticks in this county (${row.source}). This cumulative status is not a prevalence estimate; counties with no record may not have been sampled or reported.`,
            }];
    });
    return { states, details };
}
const NWSS_DETECTION_DATASETS = { "measles-detection": "akvg-8vrb", "influenza-a-h5-detection": "mtpu-urpp", "mpox-detection": "xpxn-rzgz" } as const;
const wastewaterDetectionRowSchema = z.object({ state_territory: z.string(), county_fips: z.string().optional(), counties_served: z.string().optional().default(""), site: z.string(), sample_collect_date: z.string(), pcr_target_detect: z.string() });
function detectionStateCode(stateTerritory: string): IncludedStateCode | undefined {
    const upper = stateTerritory.toUpperCase();
    return US_JURISDICTIONS.some((state) => state.code === upper) ? upper as IncludedStateCode : undefined;
}
async function wastewaterDetectionOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const datasetId = NWSS_DETECTION_DATASETS[options.signalId as keyof typeof NWSS_DETECTION_DATASETS];
    const cacheKey = `${options.signalId}:${options.period ?? ""}`;
    const cached = derivedOutlook(cacheKey, options);
    if (cached)
        return cached;
    const bounds = periodBounds(options.period, options.now ?? new Date());
    const query = new URLSearchParams({
        "$select": "state_territory,county_fips,counties_served,site,sample_collect_date,pcr_target_detect",
        "$where": `sample_collect_date >= '${bounds.start.slice(0, 10)}' AND sample_collect_date < '${bounds.end.slice(0, 10)}'`,
        "$order": "sample_collect_date DESC", "$limit": "50000",
    });
    const parsed = z.array(wastewaterDetectionRowSchema).parse(await publicJson(`https://data.cdc.gov/resource/${datasetId}.json?${query}`));
    const rows = parsed.map((row) => ({ ...row, detected: row.pcr_target_detect === "yes" ? 1 : 0 }));
    const latestSites = [...reduceBy(options.period, rows, (row) => row.site, (row) => row.sample_collect_date, ["detected"]).values()];
    const sitesByState = new Map<IncludedStateCode, typeof latestSites>();
    for (const row of latestSites) {
        const stateCode = detectionStateCode(row.state_territory);
        if (!stateCode)
            continue;
        const current = sitesByState.get(stateCode) ?? [];
        current.push(row);
        sitesByState.set(stateCode, current);
    }
    const states = emptyStates("CDC NWSS did not report a reporting-site sample for this state in this period.");
    for (const state of states) {
        const sites = sitesByState.get(state.code);
        if (!sites?.length)
            continue;
        const detected = sites.reduce((sum, row) => sum + row.detected, 0);
        const value = (detected / sites.length) * 100;
        state.value = value;
        state.displayValue = `${value.toFixed(0)}%`;
        state.observedThrough = sites.map((row) => row.sample_collect_date).sort().at(-1) ?? null;
        state.comparisonEligible = true;
        state.note = options.period
            ? `Average across ${sites.length} CDC NWSS reporting sites of the share of that site's samples detecting this pathogen during ${options.period}.`
            : `${detected} of ${sites.length} CDC NWSS reporting sites detected this pathogen in their latest sample.`;
    }
    const details = latestSites.flatMap((row): NationalDetailReading[] => {
        const reportedStateCode = detectionStateCode(row.state_territory);
        if (!reportedStateCode)
            return [];
        const countyName = row.county_fips ? COUNTY_NAME_BY_FIPS.get(row.county_fips) : undefined;
        const counties = countyName ? [countyName] : row.counties_served.split(/,|;/).map((county) => county.trim()).filter(Boolean);
        const detectionRate = row.detected;
        return countiesByState(reportedStateCode, counties, row.site).flatMap(([stateCode, stateCounties]) => {
            const share = detectionRate * 100;
            return [{ id: `${stateCode}:${row.site}`, name: `Wastewater site ${row.site}`, stateCode, geographyType: "site" as const, counties: stateCounties, value: share, displayValue: options.period ? `${share.toFixed(0)}% of samples` : share > 0 ? "Detected" : "Not detected", observedThrough: row.sample_collect_date, publisherEligible: true, comparisonEligible: true, note: options.period ? `${share.toFixed(0)}% of this site's CDC NWSS samples during ${options.period} detected this pathogen. Mapped to the publisher's county of service.` : `Latest CDC NWSS sample at this site ${share > 0 ? "detected" : "did not detect"} this pathogen. Mapped to the publisher's county of service.` }];
        });
    });
    return cacheDerivedOutlook(cacheKey, states, details, STATE_OUTLOOK_TTL_MS, options);
}
const NWSS_PATHOGENS = { "influenza-a-wval": "Influenza A virus", "sars-cov-2-wval": "SARS-CoV-2", "rsv-wval": "RSV" } as const;
async function wastewaterOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const bounds = periodBounds(options.period, options.now ?? new Date());
    const pathogen = NWSS_PATHOGENS[options.signalId as keyof typeof NWSS_PATHOGENS];
    const states = emptyStates("CDC NWSS published no reporting-site WVAL for this state in this period.");
    let details: NationalDetailReading[] = [];
    if (options.stateCode || options.includeAllDetails) {
        const selectedPublisherStates = options.stateCode && !options.includeAllDetails
            ? [options.stateCode, ...Object.entries(WASTEWATER_SERVICE_STATE_OVERRIDES).flatMap(([key, servedState]) => servedState === options.stateCode ? [key.slice(0, 2) as IncludedStateCode] : [])]
            : [];
        const stateNames = [...new Set(selectedPublisherStates.map((code) => jurisdictionByCode(code)?.name).filter((name): name is string => Boolean(name)))];
        const stateClause = stateNames.length ? ` AND state_territory in(${stateNames.map((name) => `'${name.replaceAll("'", "''")}'`).join(",")})` : "";
        const detailQuery = new URLSearchParams({ "$select": "state_territory,counties_served,site,site_wval,week_end", "$where": `pathogen_target='${pathogen}' AND week_end >= '${bounds.start}' AND week_end < '${bounds.end}' AND site_wval is not null${stateClause}`, "$order": "week_end DESC", "$limit": "50000" });
        const siteRows = z.array(wastewaterSiteSchema).parse(await publicJson(`${NWSS_ENDPOINT}?${detailQuery}`));
        const latestSites = [...reduceBy(options.period, siteRows, (row) => row.site, (row) => row.week_end, ["site_wval"]).values()];
        const sitePeriod = latestSites.map((row) => dateOnly(row.week_end)).sort().at(-1) ?? null;
        const peers = latestSites.filter((row) => dateOnly(row.week_end) === sitePeriod);
        details = latestSites.flatMap((row): NationalDetailReading[] => {
            const reportedStateCode = US_JURISDICTIONS.find((state) => state.name === row.state_territory)?.code;
            if (!reportedStateCode)
                return [];
            const counties = row.counties_served.split(/,|;/).map((county) => county.trim()).filter(Boolean);
            return countiesByState(reportedStateCode, counties, row.site).flatMap(([stateCode, stateCounties]) => {
                if (options.stateCode && !options.includeAllDetails && stateCode !== options.stateCode)
                    return [];
                return [{ id: `${stateCode}:${row.site}`, name: `Wastewater site ${row.site.replace(/^ID:/, "")}`, stateCode, geographyType: "site" as const, counties: stateCounties, value: row.site_wval, displayValue: row.site_wval.toFixed(2), observedThrough: dateOnly(row.week_end), publisherEligible: true, comparisonEligible: dateOnly(row.week_end) === sitePeriod, note: `${peers.length} sites share the latest publisher week. Site WVAL is mapped to the publisher's counties served.` }];
            });
        });
        const siteValuesByState = new Map<IncludedStateCode, number[]>();
        for (const row of latestSites) {
            const reportedStateCode = US_JURISDICTIONS.find((state) => state.name === row.state_territory)?.code;
            if (!reportedStateCode)
                continue;
            const bucket = siteValuesByState.get(reportedStateCode);
            if (bucket)
                bucket.push(row.site_wval);
            else
                siteValuesByState.set(reportedStateCode, [row.site_wval]);
        }
        for (const state of states) {
            const siteValues = siteValuesByState.get(state.code);
            if (!siteValues?.length)
                continue;
            const value = siteValues.reduce((sum, siteValue) => sum + siteValue, 0) / siteValues.length;
            state.value = value;
            state.displayValue = value.toFixed(2);
            state.observedThrough = sitePeriod;
            state.comparisonEligible = true;
            state.note = `Corvid's unweighted mean of ${siteValues.length} CDC NWSS reporting ${siteValues.length === 1 ? "site" : "sites"} in this state. NWSS publishes site WVAL only; this state figure is derived, and sites are not weighted by the population they serve.`;
        }
    }
    return { states, details };
}
async function airQualityOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const states = emptyStates("AirNow has no current, valid monitor AQI for this state.");
    if (options.period)
        return { states, details: [] };
    const cached = derivedOutlook(options.signalId, options);
    if (cached)
        return cached;
    const text = await publicText(AIRNOW_DAILY_ENDPOINT, AIRNOW_TTL);
    const countyValues = new Map<string, {
        value: number;
        observedThrough: string;
        sites: Set<string>;
    }>();
    const monitorValues = new Map<string, {
        fips: string;
        name: string;
        value: number;
        observedThrough: string;
    }>();
    for (const line of text.split(/\r?\n/)) {
        const fields = line.split("|");
        const [date, siteId, siteName, , , , , , rawAqi] = fields;
        if (!/^\d{9}$/.test(siteId ?? ""))
            continue;
        const aqi = Number(rawAqi);
        if (!Number.isFinite(aqi) || aqi < 0 || aqi > 500)
            continue;
        const fips = siteId.slice(0, 5);
        const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(date ?? "");
        if (!match)
            continue;
        const observedThrough = `20${match[3]}-${match[1]}-${match[2]}`;
        const current = countyValues.get(fips);
        if (!current)
            countyValues.set(fips, { value: aqi, observedThrough, sites: new Set([siteId]) });
        else {
            current.value = Math.max(current.value, aqi);
            if (observedThrough > current.observedThrough)
                current.observedThrough = observedThrough;
            current.sites.add(siteId);
        }
        const monitor = monitorValues.get(siteId);
        if (!monitor || aqi > monitor.value)
            monitorValues.set(siteId, { fips, name: siteName || `AirNow monitor ${siteId}`, value: aqi, observedThrough });
    }
    const stateMaxima = new Map<string, {
        value: number;
        observedThrough: string;
    }>();
    for (const [fips, reading] of countyValues) {
        const code = US_JURISDICTIONS.find((state) => state.fips === fips.slice(0, 2))?.code;
        if (!code)
            continue;
        const current = stateMaxima.get(code);
        if (!current || reading.value > current.value)
            stateMaxima.set(code, { value: reading.value, observedThrough: reading.observedThrough });
    }
    for (const state of states) {
        const reading = stateMaxima.get(state.code);
        if (!reading)
            continue;
        state.value = reading.value;
        state.displayValue = `${reading.value} AQI`;
        state.observedThrough = reading.observedThrough;
        state.comparisonEligible = true;
        state.note = "Highest preliminary AirNow monitor AQI reported in the state today.";
    }
    const details = [...monitorValues.entries()].flatMap(([siteId, reading]): NationalDetailReading[] => {
        const countyName = COUNTY_NAME_BY_FIPS.get(reading.fips);
        const stateCode = US_JURISDICTIONS.find((state) => state.fips === reading.fips.slice(0, 2))?.code;
        if (!countyName || !stateCode)
            return [];
        return [{ id: `airnow:${siteId}`, name: reading.name, stateCode, geographyType: "site", counties: [countyName], value: reading.value, displayValue: `${reading.value} AQI`, observedThrough: reading.observedThrough, comparisonEligible: true, note: `Preliminary AirNow AQI from monitor ${siteId} in ${countyName} County. The county map uses the highest reporting monitor AQI.` }];
    });
    return cacheDerivedOutlook(options.signalId, states, details, AIRNOW_TTL * 1000, options);
}
async function heatRiskOutlook(options: OutlookOptions): Promise<{
    states: NationalStateReading[];
    details: NationalDetailReading[];
}> {
    const states = emptyStates("NOAA HeatRisk did not return a valid state-centroid sample.");
    if (options.period)
        return { states, details: [] };
    const geometry = JSON.stringify({ points: US_STATE_GEOMETRY.map((state) => state.geoCentroid), spatialReference: { wkid: 4326 } });
    const query = new URLSearchParams({ geometry, geometryType: "esriGeometryMultipoint", returnFirstValueOnly: "false", f: "json" });
    const [metadata, sampleResult] = await Promise.all([heatRiskMetadataSchema.parse(await publicJson(`${HEATRISK_ENDPOINT}?f=json`)), heatRiskSamplesSchema.parse(await publicJson(`${HEATRISK_ENDPOINT}/getSamples?${query}`))]);
    const validEnd = metadata.timeInfo.timeExtent[1];
    if (validEnd < (options.now ?? new Date()).getTime())
        return { states, details: [] };
    const validThrough = new Date(validEnd).toISOString().slice(0, 10);
    const maxima = new Map<number, number>();
    for (const sample of sampleResult.samples)
        if (sample.value >= 0 && sample.value <= 4)
            maxima.set(sample.locationId, Math.max(maxima.get(sample.locationId) ?? 0, sample.value));
    for (const [index, state] of states.entries()) {
        const value = maxima.get(index);
        if (value === undefined)
            continue;
        state.value = value;
        state.displayValue = `${value.toFixed(0)} of 4`;
        state.observedThrough = validThrough;
        state.comparisonEligible = true;
        state.note = `Maximum official NOAA HeatRisk category at the state geographic centroid through ${validThrough}.`;
    }
    let details: NationalDetailReading[] = [];
    if (options.stateCode || options.includeAllDetails) {
        const selectedFips = options.stateCode && !options.includeAllDetails ? jurisdictionByCode(options.stateCode)!.fips : null;
        const counties = COUNTY_CENTROIDS.filter((county) => !selectedFips || county.stateFips === selectedFips);
        const chunks = Array.from({ length: Math.ceil(counties.length / 150) }, (_, index) => counties.slice(index * 150, (index + 1) * 150));
        const chunkDetails = await Promise.all(chunks.map(async (chunk) => {
            const countyGeometry = JSON.stringify({ points: chunk.map((county) => county.geoCentroid), spatialReference: { wkid: 4326 } });
            const countyQuery = new URLSearchParams({ geometry: countyGeometry, geometryType: "esriGeometryMultipoint", returnFirstValueOnly: "false", f: "json" });
            const countySamples = heatRiskSamplesSchema.parse(await publicJson(`${HEATRISK_ENDPOINT}/getSamples?${countyQuery}`));
            const countyMaxima = new Map<number, number>();
            for (const sample of countySamples.samples)
                if (sample.value >= 0 && sample.value <= 4)
                    countyMaxima.set(sample.locationId, Math.max(countyMaxima.get(sample.locationId) ?? 0, sample.value));
            return chunk.flatMap((county, index): NationalDetailReading[] => {
                const value = countyMaxima.get(index);
                const stateCode = US_JURISDICTIONS.find((state) => state.fips === county.stateFips)?.code;
                return value === undefined || !stateCode ? [] : [{ id: `heatrisk:${county.fips}`, name: `${county.name} County`, stateCode, geographyType: "county", counties: [county.name], value, displayValue: `${value.toFixed(0)} of 4`, observedThrough: validThrough, comparisonEligible: true, stateAggregationEligible: true, note: "Maximum official NOAA HeatRisk category sampled at the Census county centroid across the seven-day outlook." }];
            });
        }));
        details = chunkDetails.flat();
    }
    return { states, details };
}
function geographyAvailability(options: OutlookOptions, states: NationalStateReading[], details: NationalDetailReading[]): NationalOutlookResponse["geography"] {
    const observedStates = states.filter((state) => state.value !== null).map((state) => state.code);
    const hasCounty = details.some((detail) => detail.geographyType === "county");
    const hasHsa = details.some((detail) => detail.geographyType === "hsa") || Object.hasOwn(RESPIRATORY_FIELDS, options.signalId);
    const hasSite = details.some((detail) => detail.geographyType === "site") || options.signalId === "ed-wait" || Object.hasOwn(NWSS_PATHOGENS, options.signalId) || Object.hasOwn(NWSS_DETECTION_DATASETS, options.signalId);
    const nationallyCounty = options.signalId === "lyme-cases" || options.signalId === "heatrisk" || options.signalId === "air-quality" || (!options.period && (options.signalId === "b-miyamotoi-presence" || Object.hasOwn(ARBONET_DISEASES, options.signalId) || Object.hasOwn(TICKBORNE_COUNTY_DISEASES, options.signalId)));
    if (hasCounty || nationallyCounty) {
        const detailStates = [...new Set(details.filter((detail) => detail.geographyType === "county" && detail.stateCode).map((detail) => detail.stateCode!))];
        const countyDataStates = detailStates.length ? detailStates : options.stateCode && hasCounty ? [options.stateCode] : observedStates;
        return { level: "county", countyDataStates, statewideOnlyStates: [], message: countyDataStates.length ? `County observations are available in ${countyDataStates.length} ${countyDataStates.length === 1 ? "jurisdiction" : "jurisdictions"}. Counties without observations are striped; no county values are inferred.` : "No county observations are available for this period." };
    }
    if (hasHsa)
        return { level: "hsa", countyDataStates: [], statewideOnlyStates: observedStates, message: "Sub-state values are published by Health Service Area and repeated across member counties. They are not separate county estimates." };
    if (hasSite)
        return { level: "site-to-county", countyDataStates: [...new Set(details.filter((detail) => detail.geographyType === "site" && detail.stateCode).map((detail) => detail.stateCode!))], statewideOnlyStates: [], message: "Reporting-site observations are mapped only to the counties the publisher says each site serves. Unserved counties are striped." };
    if (observedStates.length)
        return { level: "statewide", countyDataStates: [], statewideOnlyStates: observedStates, message: `Statewide observations are available in ${observedStates.length} ${observedStates.length === 1 ? "jurisdiction" : "jurisdictions"}. No county values are inferred.` };
    return { level: "unavailable", countyDataStates: [], statewideOnlyStates: [], message: "No defensible county or statewide public observation is available for this signal and period." };
}
function planningDescription(signalId: SignalId) {
    const signal = SIGNAL_BY_ID[signalId];
    return `${signal.source} planning context is available, but no comparable short-horizon national ${signal.unit.toLowerCase()} observation is published for this view.`;
}
function stateOutlookKey(signalId: SignalId, stateCode: IncludedStateCode, period: string | null) {
    return `${signalId}:${stateCode}:${period ?? ""}`;
}
function cachedStateOutlook(options: OutlookOptions) {
    if (!options.stateCode || options.now || options.recompute)
        return null;
    const key = stateOutlookKey(options.signalId, options.stateCode, options.period);
    const cached = stateOutlookCache.get(key);
    if (!cached || Date.now() - cached.cachedAt >= cached.ttl) {
        stateOutlookCache.delete(key);
        return null;
    }
    stateOutlookCache.delete(key);
    stateOutlookCache.set(key, cached);
    return cached.value;
}
function cacheStateOutlook(options: OutlookOptions, value: NationalOutlookResponse) {
    if (!options.stateCode || options.now)
        return;
    const key = stateOutlookKey(options.signalId, options.stateCode, options.period);
    stateOutlookCache.delete(key);
    stateOutlookCache.set(key, { value, cachedAt: Date.now(), ttl: value.status === "current" ? STATE_OUTLOOK_TTL_MS : 300000 });
    while (stateOutlookCache.size > STATE_OUTLOOK_CACHE_LIMIT)
        stateOutlookCache.delete(stateOutlookCache.keys().next().value!);
}
const FEED_CONCURRENCY = 2;
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await fn(items[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
function uniqueErrors(errors: Array<{
    source: string;
    message: string;
}>) {
    const seen = new Set<string>();
    return errors.filter((error) => {
        const key = `${error.source}:${error.message}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
export const GENEROUS_OUTLOOK_TIMEOUT_MS = 40000;
function outlookTimeoutMs(options: OutlookOptions): number {
    if (options.timeoutMs !== undefined)
        return options.timeoutMs;
    if (options.stateCode)
        return GENEROUS_OUTLOOK_TIMEOUT_MS;
    return Object.hasOwn(RESPIRATORY_FIELDS, options.signalId) ? RESPIRATORY_FEED_SIGNAL_TIMEOUT_MS
        : Object.hasOwn(NNDSS_SIGNAL_LABELS, options.signalId) || options.signalId === "ed-wait" ? SLOW_FEED_SIGNAL_TIMEOUT_MS
            : FEED_SIGNAL_TIMEOUT_MS;
}
function timedOutOutlook(options: OutlookOptions, now: Date): NationalOutlookResponse {
    const signal = SIGNAL_BY_ID[options.signalId];
    return {
        scope: options.stateCode ? "state" : "national", signal, catalog: SIGNAL_CATALOG, retrievedAt: now.toISOString(), status: "partial", isStale: false, period: options.period,
        states: emptyStates(`${signal.source} did not respond in time for this request.`), selectedState: options.stateCode, details: [],
        geography: { level: "unavailable", countyDataStates: [], statewideOnlyStates: [], message: "No defensible county or statewide public observation is available for this signal and period." },
        errors: [{ source: signal.source, message: "Publisher did not respond in time." }],
    };
}
function outlookRequestKey(options: OutlookOptions) {
    if (options.now)
        return null;
    return `${options.signalId}:${options.stateCode ?? ""}:${options.period ?? ""}:${options.includeAllDetails ? "all" : "scoped"}:${options.deferReadingPolicy ? "deferred" : "applied"}`;
}
function sharedOutlook(options: OutlookOptions, now: Date): Promise<NationalOutlookResponse> {
    const compute = () => computeNationalOutlook(options, now).then((response) => {
        cacheStateOutlook(options, response);
        return response;
    });
    const key = outlookRequestKey(options);
    if (!key)
        return compute();
    const pending = outlookPending.get(key);
    if (pending)
        return pending;
    const computed = compute().finally(() => { outlookPending.delete(key); });
    void computed.catch(() => undefined);
    outlookPending.set(key, computed);
    return computed;
}
export async function getBakedNationalOutlook(options: OutlookOptions, now = new Date()): Promise<NationalOutlookResponse | null> {
    if (options.period || options.includeAllDetails || options.now || options.recompute)
        return null;
    const [index, state] = await Promise.all([
        readBakedSignalIndex(options.signalId),
        options.stateCode ? readBakedStateDetail(options.signalId, options.stateCode) : Promise.resolve(null),
    ]);
    if (!index || !index.states.length || (options.stateCode && !state))
        return null;
    if (!options.stateCode && !index.geography)
        return null;
    const details = state?.details ?? [];
    const isStale = applyNationalReadingPolicy(index.states, details, SIGNAL_BY_ID[options.signalId], null, now);
    return {
        scope: options.stateCode ? "state" : "national", signal: SIGNAL_BY_ID[options.signalId], catalog: SIGNAL_CATALOG, retrievedAt: index.retrievedAt, status: index.status, isStale, period: null,
        states: index.states, selectedState: options.stateCode, details, geography: state?.geography ?? index.geography!, errors: index.errors,
    };
}
export async function bakeCountyDetails(signalId: SignalId, now = new Date()): Promise<number | null> {
    const national = await getNationalOutlook({ signalId, stateCode: null, period: null, includeAllDetails: true, deferReadingPolicy: true, recompute: true, timeoutMs: GENEROUS_OUTLOOK_TIMEOUT_MS });
    const detailsByState = new Map<IncludedStateCode, NationalDetailReading[]>();
    for (const detail of national.details) {
        if (!detail.stateCode)
            continue;
        const bucket = detailsByState.get(detail.stateCode);
        if (bucket)
            bucket.push(detail);
        else
            detailsByState.set(detail.stateCode, [detail]);
    }
    const massachusetts = await getNationalOutlook({ signalId, stateCode: "MA", period: null, deferReadingPolicy: true, recompute: true, timeoutMs: GENEROUS_OUTLOOK_TIMEOUT_MS }).catch(() => null);
    if (massachusetts?.details.length)
        detailsByState.set("MA", massachusetts.details);
    const errors = uniqueErrors([...national.errors, ...(massachusetts?.errors ?? [])]);
    const byState = new Map<IncludedStateCode, BakedStateDetail>();
    for (const jurisdiction of US_JURISDICTIONS) {
        const details = detailsByState.get(jurisdiction.code) ?? [];
        byState.set(jurisdiction.code, { version: STORE_VERSION, details, geography: geographyAvailability({ signalId, stateCode: jurisdiction.code, period: null }, national.states, details) });
    }
    const carriesData = national.states.some((state) => state.value !== null) || national.details.length > 0;
    if (!carriesData && errors.length)
        return null;
    await writeBakedSignal(signalId, {
        version: STORE_VERSION, bakedAt: now.toISOString(), retrievedAt: national.retrievedAt, status: national.status,
        states: national.states, errors,
        geography: geographyAvailability({ signalId, stateCode: null, period: null }, national.states, national.details),
    }, byState);
    for (const key of [...stateOutlookCache.keys()])
        if (key.startsWith(`${signalId}:`))
            stateOutlookCache.delete(key);
    return national.details.length;
}
async function bakedHistoryOutlook(options: OutlookOptions, now: Date): Promise<NationalOutlookResponse | null> {
    if (!options.period || options.recompute)
        return null;
    const { isBakedHistoryPeriod, readBakedHistoryMonth } = await import("@/lib/history-store");
    if (!isBakedHistoryPeriod(options.period, now))
        return null;
    const month = await readBakedHistoryMonth(options.signalId, options.period);
    if (!month)
        return null;
    const details = options.stateCode ? month.details.filter((detail) => detail.stateCode === options.stateCode) : month.details;
    const errors = month.absent
        ? [...month.errors, { source: SIGNAL_BY_ID[options.signalId].source, message: month.absent.detail }]
        : month.errors;
    return {
        scope: options.stateCode ? "state" : "national", signal: SIGNAL_BY_ID[options.signalId], catalog: SIGNAL_CATALOG,
        retrievedAt: month.retrievedAt, status: month.absent ? "current" : month.status, isStale: false, period: options.period,
        states: month.states, selectedState: options.stateCode, details, geography: month.geography, errors,
    };
}
export async function getNationalOutlook(options: OutlookOptions): Promise<NationalOutlookResponse> {
    const cached = cachedStateOutlook(options);
    if (cached) {
        if (options.trace)
            options.trace.source = "memory-cache";
        return cached;
    }
    const now = options.now ?? new Date();
    const history = await bakedHistoryOutlook(options, now);
    if (history) {
        if (options.trace)
            options.trace.source = "history-store";
        cacheStateOutlook(options, history);
        return history;
    }
    const baked = await getBakedNationalOutlook(options, now);
    if (baked) {
        if (options.trace)
            options.trace.source = "county-store";
        cacheStateOutlook(options, baked);
        return baked;
    }
    if (options.trace)
        options.trace.source = "computed";
    return Promise.race([
        sharedOutlook(options, now),
        new Promise<NationalOutlookResponse>((resolve) => setTimeout(() => {
            if (options.trace)
                options.trace.source = "timed-out";
            resolve(timedOutOutlook(options, now));
        }, outlookTimeoutMs(options))),
    ]);
}
async function computeNationalOutlook(options: OutlookOptions, now: Date): Promise<NationalOutlookResponse> {
    let states = emptyStates(`Planning context only. ${planningDescription(options.signalId)}`);
    let details: NationalDetailReading[] = [];
    const errors: Array<{
        source: string;
        message: string;
    }> = [];
    try {
        if (Object.hasOwn(RESPIRATORY_FIELDS, options.signalId))
            ({ states, details } = await respiratoryOutlook(options));
        else if (options.signalId === "lyme-cases")
            ({ states, details } = await lymeOutlook(options));
        else if (Object.hasOwn(NHSN_FIELDS, options.signalId))
            ({ states, details } = await hospitalOutlook(options));
        else if (!options.period && options.signalId === "ed-wait")
            ({ states, details } = await cmsEdWaitOutlook(options));
        else if (Object.hasOwn(NWSS_PATHOGENS, options.signalId))
            ({ states, details } = await wastewaterOutlook(options));
        else if (Object.hasOwn(NWSS_DETECTION_DATASETS, options.signalId))
            ({ states, details } = await wastewaterDetectionOutlook(options));
        else if (options.signalId === "heatrisk")
            ({ states, details } = await heatRiskOutlook(options));
        else if (options.signalId === "air-quality")
            ({ states, details } = await airQualityOutlook(options));
        else if (!options.period && options.signalId === "b-miyamotoi-presence")
            ({ states, details } = await bMiyamotoiOutlook(options));
        else if (!options.period && Object.hasOwn(ARBONET_DISEASES, options.signalId))
            ({ states, details } = await arbonetOutlook(options));
        else if (Object.hasOwn(NNDSS_SIGNAL_LABELS, options.signalId))
            ({ states, details } = await nndssOutlook(options));
    }
    catch (error) {
        errors.push({ source: SIGNAL_BY_ID[options.signalId].source, message: sourceErrorMessage(error) });
    }
    if (!options.period && Object.hasOwn(TICKBORNE_COUNTY_DISEASES, options.signalId) && (options.stateCode || options.includeAllDetails)) {
        try {
            const tickborneDetails = await tickborneCountyDetails(options.signalId, options.stateCode, options.includeAllDetails);
            if (tickborneDetails.length)
                details = tickborneDetails;
        }
        catch (error) {
            errors.push({ source: "CDC tickborne county surveillance", message: sourceErrorMessage(error) });
        }
    }
    if (options.stateCode === "MA") {
        try {
            const massachusettsDetails = await getMassachusettsCountyDetails(options.signalId, options.period, undefined, (source, observedThrough) => {
                errors.push({ source, message: `Live data are unavailable, so county detail is the last reviewed snapshot, observed through ${observedThrough}.` });
            });
            if (massachusettsDetails !== null)
                details = massachusettsDetails.map((detail) => ({ ...detail, stateCode: "MA" as const }));
        }
        catch (error) {
            errors.push({ source: "Massachusetts county connectors", message: sourceErrorMessage(error) });
        }
    }
    const isStale = options.deferReadingPolicy ? false : applyNationalReadingPolicy(states, details, SIGNAL_BY_ID[options.signalId], options.period, now);
    const geography = geographyAvailability(options, states, details);
    return { scope: options.stateCode ? "state" as const : "national" as const, signal: SIGNAL_BY_ID[options.signalId], catalog: SIGNAL_CATALOG, retrievedAt: now.toISOString(), status: errors.length ? "partial" as const : "current" as const, isStale, period: options.period, states, selectedState: options.stateCode, details, geography, errors };
}
const feedInFlight = new Map<string, Promise<NationalFeedResponse>>();
export function getCachedNationalDetails(period: string | null = null): Map<SignalId, NationalOutlookResponse> | null {
    const outlooks = new Map<SignalId, NationalOutlookResponse>();
    for (const [key, entry] of stateOutlookCache) {
        if (!key.endsWith(`:${period ?? ""}`) || Date.now() - entry.cachedAt >= entry.ttl)
            continue;
        const current = outlooks.get(entry.value.signal.id);
        outlooks.set(entry.value.signal.id, current
            ? { ...current, details: [...current.details, ...entry.value.details.filter((detail) => !current.details.some((item) => item.id === detail.id && item.stateCode === detail.stateCode))] }
            : entry.value);
    }
    return outlooks.size ? outlooks : null;
}
export function clearNationalOutlookCache() {
    stateOutlookCache.clear();
    outlookPending.clear();
    derivedOutlookCache.clear();
}
const feedProgress = new Map<string, {
    completed: number;
    total: number;
}>();
export function getFeedProgress(period: string): {
    completed: number;
    total: number;
} | null {
    return feedProgress.get(period) ?? null;
}
export async function getNationalFeed(options: Omit<OutlookOptions, "signalId" | "stateCode">): Promise<NationalFeedResponse> {
    const key = options.period ?? "";
    const pending = feedInFlight.get(key);
    if (pending)
        return pending;
    feedProgress.set(key, { completed: 0, total: SIGNAL_CATALOG.length });
    const promise = computeNationalFeed(options).finally(() => { feedInFlight.delete(key); feedProgress.delete(key); });
    feedInFlight.set(key, promise);
    return promise;
}
async function computeNationalFeed(options: Omit<OutlookOptions, "signalId" | "stateCode">): Promise<NationalFeedResponse> {
    const now = options.now ?? new Date();
    const retrievedAt = now.toISOString();
    const progressKey = options.period ?? "";
    const entries = await mapWithConcurrency(SIGNAL_CATALOG, FEED_CONCURRENCY, async (signal) => {
        const outlook = await getNationalOutlook({ ...options, now, stateCode: null, signalId: signal.id, includeAllDetails: false, deferReadingPolicy: true });
        outlook.isStale = applyNationalReadingPolicy(outlook.states, outlook.details, signal, options.period, now);
        outlook.geography = geographyAvailability({ ...options, stateCode: null, signalId: signal.id, includeAllDetails: false }, outlook.states, outlook.details);
        const progress = feedProgress.get(progressKey);
        if (progress)
            progress.completed += 1;
        return [signal.id, outlook] as const;
    });
    const errors = uniqueErrors(entries.flatMap(([, outlook]) => outlook.errors));
    return compactNationalFeed({ catalog: SIGNAL_CATALOG, retrievedAt, refreshHours: 12, status: errors.length ? "partial" : "current", errors, selectedState: null, period: options.period, outlooks: Object.fromEntries(entries) as Record<SignalId, NationalOutlookResponse> });
}
