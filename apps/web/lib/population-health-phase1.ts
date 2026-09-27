import "server-only";
import type { PopulationPhaseResult } from "@/lib/population-health-sources";
import { cachedPublisherFetch, pinPublisherCacheKey } from "@/lib/publisher-cache";
import { jurisdictionByCode, type IncludedStateCode } from "@/lib/us-geography";
import { fetchJsonRows, makeMeasure, normalizeFips, numberValue, parseCsv, POPULATION_PUBLISHER_TIMEOUT_MS, sourceError, textValue, unavailableMeasure } from "@/lib/population-health-utils";
import populationBaseline from "@/lib/generated/population-health-baseline.json";
const POPULATION_URL = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv";
const SVI_URL = "https://svi.cdc.gov/Documents/Data/2022/csv/states_counties/SVI_2022_US_county.csv";
const PLACES_URL = "https://data.cdc.gov/resource/swc5-untb.json";
const PLACES_CATALOG = "https://data.cdc.gov/d/swc5-untb";
const ACS_CATALOG = "https://api.census.gov/data/2024/acs/acs5";
const PLACES_MEASURES = [
    "MHLTH", "DEPRESSION", "DIABETES", "CHD", "COPD", "OBESITY", "CSMOKING", "LPA", "ACCESS2", "CHECKUP", "SLEEP", "FOODINSECU",
] as const;
const SVI_FIELDS = [
    ["social-vulnerability", "Social vulnerability", "RPL_THEMES"],
    ["svi-socioeconomic", "Socioeconomic vulnerability", "RPL_THEME1"],
    ["svi-household-disability", "Household characteristics vulnerability", "RPL_THEME2"],
    ["svi-minority-language", "Racial and ethnic minority status vulnerability", "RPL_THEME3"],
    ["svi-housing-transportation", "Housing and transportation vulnerability", "RPL_THEME4"],
] as const;
const stateScoped = (stateCode: IncludedStateCode, fips: string | null) => ({ stateCode, ...(fips ? { fips } : {}) });
const POPULATION_KEY = "population-health:population-compact";
const SVI_KEY = "population-health:svi-compact";
export async function warmPopulationHealthPhase1() {
    pinPublisherCacheKey(POPULATION_KEY);
    pinPublisherCacheKey(SVI_KEY);
    await cachedPublisherFetch(POPULATION_KEY, 86400, async () => populationBaseline.population as PopulationRow[]);
    await cachedPublisherFetch(SVI_KEY, 86400, async () => populationBaseline.svi as PopulationRow[]);
}
type PopulationRow = Record<string, string>;
type WeightedRow = {
    row: PopulationRow;
    weight: number;
};
function nonNegativeNumber(value: unknown): number | null {
    const parsed = numberValue(value);
    return parsed !== null && parsed >= 0 ? parsed : null;
}
function sviValue(value: unknown): number | null {
    const parsed = numberValue(value);
    return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}
function unavailable(source: string, sourceUrl: string, note: string, stateCode: IncludedStateCode | null, fips: string | null) {
    return unavailableMeasure({ id: source.toLowerCase().replaceAll(" ", "-"), label: source, category: "baseline", geographyType: fips ? "county" : "state", source, sourceUrl, vintage: "Current publisher release", cadence: "Varies", note, ...(stateCode ? stateScoped(stateCode, fips) : {}) });
}
function weightedMean(values: WeightedRow[], field: string): {
    value: number | null;
    weighted: boolean;
} {
    const valid = values.flatMap(({ row, weight }) => {
        const value = sviValue(row[field]);
        return value === null ? [] : [{ value, weight }];
    });
    if (!valid.length)
        return { value: null, weighted: false };
    const totalWeight = valid.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight > 0)
        return { value: valid.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight, weighted: true };
    return { value: valid.reduce((sum, item) => sum + item.value, 0) / valid.length, weighted: false };
}
function countyWeights(rows: PopulationRow[], stateFips: string): Map<string, number> {
    return new Map(rows.flatMap((row) => {
        const state = normalizeFips(row.STATE, 2);
        const county = normalizeFips(row.COUNTY, 3);
        const population = nonNegativeNumber(row.POPESTIMATE2025);
        return state === stateFips && county && county !== "000" && population !== null
            ? [[`${state}${county}`, population]]
            : [];
    }));
}
async function fetchCompactCsv(url: string, key: string, fields: readonly string[]) {
    return cachedPublisherFetch(key, 86400, async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(POPULATION_PUBLISHER_TIMEOUT_MS), headers: { accept: "text/csv" }, cache: "no-store" });
        if (!response.ok)
            throw new Error(`Publisher returned ${response.status}`);
        return parseCsv(await response.text(), fields);
    });
}
function fetchPopulationRows() {
    return fetchCompactCsv(POPULATION_URL, POPULATION_KEY, ["STATE", "COUNTY", "POPESTIMATE2025"]);
}
function fetchSviRows() {
    return fetchCompactCsv(SVI_URL, SVI_KEY, ["FIPS", ...SVI_FIELDS.map(([, , field]) => field)]);
}
export async function loadPhase1(stateCode: IncludedStateCode | null, countyFips: string | null, period: string | null = null): Promise<PopulationPhaseResult> {
    const section = { id: "baseline" as const, title: "Population, susceptibility, and community conditions", description: "A population denominator and the conditions around it make Corvid surveillance comparable, interpretable, and useful for planning.", measures: [] as ReturnType<typeof makeMeasure>[] };
    if (!stateCode) {
        section.measures.push(unavailable("Census population", POPULATION_URL, "Choose a state to load population denominators and community conditions.", null, null));
        return { section, errors: [], sources: [{ name: "U.S. Census Bureau population estimates", url: POPULATION_URL, vintage: "2025", cadence: "Annual" }] };
    }
    const jurisdiction = jurisdictionByCode(stateCode)!;
    const targetFips = countyFips ?? jurisdiction.fips;
    const geographyType = countyFips ? "county" as const : "state" as const;
    const censusApiKey = process.env.CENSUS_API_KEY?.trim() ?? "";
    const errors: Array<{
        source: string;
        message: string;
    }> = [];
    const sources = [
        { name: "U.S. Census Bureau population estimates", url: POPULATION_URL, vintage: "2025", cadence: "Annual" },
        { name: "CDC/ATSDR Social Vulnerability Index", url: SVI_URL, vintage: "2022", cadence: "Periodic" },
        { name: "CDC PLACES", url: PLACES_CATALOG, vintage: "2025", cadence: "Annual" },
        { name: "U.S. Census Bureau ACS", url: ACS_CATALOG, vintage: "2024 5-year", cadence: "Annual" },
    ];
    const independent = Promise.allSettled([
        fetchSviRows(),
        censusApiKey ? fetchAcs(jurisdiction.fips, stateCode, countyFips, censusApiKey) : Promise.resolve([]),
    ]);
    const [populationResult] = await Promise.allSettled([fetchPopulationRows()]);
    const populationRows = populationResult.status === "fulfilled" ? populationResult.value : [];
    const [[sviResult, acsResult], [placesResult]] = await Promise.all([
        independent,
        Promise.allSettled([fetchPlaces(stateCode, countyFips, populationRows)]),
    ]);
    if (populationResult.status === "fulfilled") {
        const row = populationResult.value.find((candidate) => normalizeFips(candidate.STATE, 2) === jurisdiction.fips && normalizeFips(candidate.COUNTY, 3) === (countyFips ? countyFips.slice(2) : "000"));
        const value = nonNegativeNumber(row?.POPESTIMATE2025);
        section.measures.push(value === null
            ? unavailable("Census population", POPULATION_URL, "The selected geography did not have a 2025 estimate in the publisher file.", stateCode, countyFips)
            : makeMeasure({ id: "population", label: "Population estimate", category: "baseline", geographyType, ...stateScoped(stateCode, countyFips), value, unit: "people", vintage: "2025", period: "2025", cadence: "Annual", estimateType: "observed", status: "current", quality: "high", source: "U.S. Census Bureau", sourceUrl: POPULATION_URL, note: "Annual population estimate; used as a denominator, not a disease forecast." }));
    }
    else {
        errors.push({ source: "U.S. Census Bureau population estimates", message: sourceError(populationResult.reason) });
        section.measures.push(unavailable("Census population", POPULATION_URL, errors.at(-1)!.message, stateCode, countyFips));
    }
    if (sviResult.status === "fulfilled") {
        const rows = countyFips
            ? sviResult.value.filter((candidate) => normalizeFips(candidate.FIPS) === targetFips)
            : sviResult.value.filter((candidate) => normalizeFips(candidate.FIPS).startsWith(jurisdiction.fips));
        const weights = countyWeights(populationRows, jurisdiction.fips);
        const weightedRows = rows.map((row) => ({ row, weight: countyFips ? 1 : weights.get(normalizeFips(row.FIPS)) ?? 0 }));
        for (const [id, label, field] of SVI_FIELDS) {
            const aggregate = countyFips ? { value: sviValue(weightedRows[0]?.row[field]), weighted: true } : weightedMean(weightedRows, field);
            const value = aggregate.value;
            section.measures.push(value === null
                ? unavailableMeasure({ id, label, category: "baseline", geographyType, source: "CDC/ATSDR SVI", sourceUrl: SVI_URL, vintage: "2022", cadence: "Periodic", note: "The selected geography did not have an SVI score in the publisher file.", stateCode, ...(countyFips ? { fips: countyFips } : {}) })
                : makeMeasure({ id, label, category: "baseline", geographyType, ...stateScoped(stateCode, countyFips), value: value * 100, unit: "percentile", vintage: "2022", period: "2022", cadence: "Periodic", estimateType: "ranked", status: aggregate.weighted || countyFips ? "current" : "partial", quality: "moderate", source: "CDC/ATSDR SVI", sourceUrl: SVI_URL, note: countyFips ? "Overall or theme percentile rank across U.S. counties; higher means more vulnerable." : `${rows.length} county records aggregated with 2025 population weights; higher means more vulnerable relative to U.S. counties.` }));
        }
    }
    else {
        errors.push({ source: "CDC/ATSDR Social Vulnerability Index", message: sourceError(sviResult.reason) });
        section.measures.push(unavailable("Social vulnerability", SVI_URL, errors.at(-1)!.message, stateCode, countyFips));
    }
    if (placesResult.status === "fulfilled") {
        if (placesResult.value.length)
            section.measures.push(...placesResult.value);
        else
            section.measures.push(unavailable("CDC PLACES", PLACES_CATALOG, "No current county-native PLACES rows were returned for the selected geography.", stateCode, countyFips));
    }
    else {
        errors.push({ source: "CDC PLACES", message: sourceError(placesResult.reason) });
        section.measures.push(unavailable("CDC PLACES", PLACES_CATALOG, errors.at(-1)!.message, stateCode, countyFips));
    }
    if (acsResult.status === "fulfilled" && acsResult.value.length)
        section.measures.push(...acsResult.value);
    else {
        const message = !censusApiKey
            ? "A server-side Census API key is not configured, so ACS measures are unavailable."
            : acsResult.status === "rejected" ? sourceError(acsResult.reason) : "The selected geography did not have ACS rows in the publisher response.";
        errors.push({ source: "U.S. Census Bureau ACS", message });
        section.measures.push(unavailable("Census ACS", ACS_CATALOG, message, stateCode, countyFips));
    }
    if (period) {
        section.measures = section.measures.map((measure) => measure.value === null ? measure : { ...measure, status: "stale", note: `${measure.note} Latest release; not backdated to the selected month.` });
    }
    return { section, errors, sources };
}
async function fetchPlaces(stateCode: IncludedStateCode, countyFips: string | null, populationRows: PopulationRow[]) {
    const params = new URLSearchParams({ "$select": "locationname,locationid,measureid,measure,short_question_text,datavaluetypeid,data_value,year,data_value_unit,low_confidence_limit,high_confidence_limit", "$where": `stateabbr='${stateCode}' AND measureid in (${PLACES_MEASURES.map((id) => `'${id}'`).join(",")}) AND datavaluetypeid='CrdPrv'`, "$limit": "50000" });
    const rows = await fetchJsonRows(`${PLACES_URL}?${params}`);
    const scopedRows = countyFips ? rows.filter((row) => normalizeFips(row.locationid) === countyFips) : rows;
    const latestYearByMeasure = new Map<string, number>();
    for (const row of scopedRows) {
        const measure = textValue(row.measureid);
        const year = numberValue(row.year);
        if (PLACES_MEASURES.includes(measure as (typeof PLACES_MEASURES)[number]) && textValue(row.datavaluetypeid) === "CrdPrv" && year !== null) {
            latestYearByMeasure.set(measure, Math.max(latestYearByMeasure.get(measure) ?? 0, year));
        }
    }
    const selected = scopedRows.filter((row) => {
        const measure = textValue(row.measureid);
        return textValue(row.datavaluetypeid) === "CrdPrv"
            && numberValue(row.year) === latestYearByMeasure.get(measure)
            && normalizeFips(row.locationid) !== "";
    });
    if (countyFips)
        return selected.map((row) => placesMeasure(row, stateCode, countyFips, "county"));
    const weights = new Map(countyWeights(populationRows, jurisdictionByCode(stateCode)!.fips));
    const byMeasure = new Map<string, Record<string, unknown>[]>();
    for (const row of selected)
        byMeasure.set(textValue(row.measureid), [...(byMeasure.get(textValue(row.measureid)) ?? []), row]);
    return [...byMeasure].map(([measure, measureRows]) => {
        const values = measureRows.flatMap((row) => {
            const value = numberValue(row.data_value);
            return value === null ? [] : [{ value, weight: weights.get(normalizeFips(row.locationid)) ?? 0 }];
        });
        const totalWeight = values.reduce((sum, item) => sum + item.weight, 0);
        const value = values.length ? totalWeight > 0 ? values.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight : values.reduce((sum, item) => sum + item.value, 0) / values.length : null;
        const first = measureRows[0];
        return makeMeasure({ id: `places-${measure.toLowerCase()}`, label: textValue(first.short_question_text) || measure, category: "baseline", geographyType: "state", stateCode, value, unit: textValue(first.data_value_unit) || "%", vintage: textValue(first.year) || "2025", period: textValue(first.year), cadence: "Annual", estimateType: "model-based", status: value === null ? "partial" : totalWeight > 0 ? "current" : "partial", quality: totalWeight > 0 ? "moderate" : "limited", source: "CDC PLACES", sourceUrl: PLACES_CATALOG, note: `${measureRows.length} county estimates aggregated${totalWeight > 0 ? " with 2025 population weights" : " without a usable denominator"}; PLACES county values are model-based small-area estimates.` });
    });
}
function placesMeasure(row: Record<string, unknown>, stateCode: IncludedStateCode, fips: string, geographyType: "county") {
    const value = numberValue(row.data_value);
    const measure = textValue(row.measureid);
    return makeMeasure({ id: `places-${measure.toLowerCase()}-${fips}`, label: textValue(row.short_question_text) || textValue(row.measure) || measure, category: "baseline", geographyType, stateCode, fips, value, unit: textValue(row.data_value_unit) || "%", vintage: textValue(row.year) || "2025", period: textValue(row.year), cadence: "Annual", estimateType: "model-based", status: value === null ? "partial" : "current", quality: "moderate", confidenceLow: numberValue(row.low_confidence_limit), confidenceHigh: numberValue(row.high_confidence_limit), source: "CDC PLACES", sourceUrl: PLACES_CATALOG, note: "County-native crude-prevalence small-area estimate from CDC PLACES." });
}
async function fetchAcs(stateFips: string, stateCode: IncludedStateCode, countyFips: string | null, key: string) {
    const variables = [
        "NAME", "B01001_001E", "B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E", "B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E", "B01001_024E", "B01001_025E", "B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E", "B01001_044E", "B01001_045E", "B01001_046E", "B01001_047E", "B01001_048E", "B01001_049E", "B17001_001E", "B17001_002E", "B23025_003E", "B23025_005E",
    ];
    const params = new URLSearchParams({ get: variables.join(","), for: countyFips ? "county:*" : `state:${stateFips}` });
    if (countyFips)
        params.set("in", `state:${stateFips}`);
    params.set("key", key);
    const cacheKey = `population-health:acs:${countyFips ? `county:${stateFips}` : `state:${stateFips}`}`;
    const body = await cachedPublisherFetch(cacheKey, 86400, async () => {
        const response = await fetch(`${ACS_CATALOG}?${params}`, { signal: AbortSignal.timeout(POPULATION_PUBLISHER_TIMEOUT_MS), cache: "no-store" });
        if (!response.ok)
            throw new Error(`Publisher returned ${response.status}`);
        return response.json() as Promise<string[][]>;
    });
    const [headers, ...rows] = body;
    const row = rows.find((candidate) => !countyFips || `${stateFips}${candidate.at(-1)}` === countyFips);
    if (!row)
        return [];
    const values = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
    const totalPopulation = nonNegativeNumber(values.B01001_001E);
    const children = sumNonNegative(values, ["B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E", "B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E"]);
    const olderAdults = sumNonNegative(values, ["B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E", "B01001_024E", "B01001_025E", "B01001_044E", "B01001_045E", "B01001_046E", "B01001_047E", "B01001_048E", "B01001_049E"]);
    const povertyDenominator = nonNegativeNumber(values.B17001_001E);
    const povertyNumerator = nonNegativeNumber(values.B17001_002E);
    const laborForce = nonNegativeNumber(values.B23025_003E);
    const unemployed = nonNegativeNumber(values.B23025_005E);
    const geographyType = countyFips ? "county" as const : "state" as const;
    const shared = { category: "baseline" as const, geographyType, value: null as number | null, vintage: "2024 5-year", period: "2024", cadence: "Annual", estimateType: "observed" as const, status: "partial" as const, quality: "moderate" as const, source: "U.S. Census Bureau ACS", sourceUrl: ACS_CATALOG, stateCode, ...(countyFips ? { fips: countyFips } : {}), note: `${textValue(values.NAME)}; ACS five-year estimate.` };
    const percentage = (numerator: number | null, denominator: number | null) => numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator * 100 : null;
    return [
        makeMeasure({ ...shared, id: "acs-children", label: "Residents under 18", value: percentage(children, totalPopulation), unit: "%", numerator: children, denominator: totalPopulation }),
        makeMeasure({ ...shared, id: "acs-older-adults", label: "Residents 65 and older", value: percentage(olderAdults, totalPopulation), unit: "%", numerator: olderAdults, denominator: totalPopulation }),
        makeMeasure({ ...shared, id: "acs-poverty", label: "Below poverty threshold", value: povertyDenominator !== null && povertyNumerator !== null ? percentage(povertyNumerator, povertyDenominator) : null, unit: "%", numerator: povertyNumerator, denominator: povertyDenominator }),
        makeMeasure({ ...shared, id: "acs-unemployment", label: "Unemployment rate", value: laborForce !== null && unemployed !== null ? percentage(unemployed, laborForce) : null, unit: "%", numerator: unemployed, denominator: laborForce }),
    ].map((measure) => ({ ...measure, status: measure.value === null ? "partial" as const : "current" as const }));
}
function sumNonNegative(values: Record<string, string>, fields: string[]): number | null {
    const numbers = fields.map((field) => nonNegativeNumber(values[field]));
    return numbers.some((value) => value === null) ? null : numbers.reduce<number>((sum, value) => sum + value!, 0);
}
