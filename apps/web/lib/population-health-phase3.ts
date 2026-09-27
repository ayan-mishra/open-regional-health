import "server-only";
import type { PopulationPhaseResult } from "@/lib/population-health-sources";
import { jurisdictionByCode, type IncludedStateCode } from "@/lib/us-geography";
import { fetchJsonRows, makeMeasure, numberValue, sourceError, textValue, unavailableMeasure } from "@/lib/population-health-utils";
const VAX_URL = "https://data.cdc.gov/resource/vh55-3he6.json";
const VAX_CATALOG = "https://data.cdc.gov/d/vh55-3he6";
const OVERDOSE_URL = "https://data.cdc.gov/resource/gb4e-yj24.json";
const OVERDOSE_CATALOG = "https://data.cdc.gov/d/gb4e-yj24";
export async function loadPhase3(stateCode: IncludedStateCode | null, countyFips: string | null, period: string | null = null, population: number | null = null): Promise<PopulationPhaseResult> {
    const section = { id: "prevention" as const, title: "Prevention and avoidable burden", description: "Prevention coverage and provisional mortality add population-level context to the surveillance view.", measures: [] as ReturnType<typeof makeMeasure>[] };
    const errors: Array<{
        source: string;
        message: string;
    }> = [];
    const sources = [
        { name: "CDC VaxView influenza coverage", url: VAX_CATALOG, vintage: "Latest published season", cadence: "Seasonal" },
        { name: "CDC provisional drug overdose deaths", url: OVERDOSE_CATALOG, vintage: "Latest 12-month-ending period", cadence: "Quarterly" },
    ];
    if (!stateCode) {
        section.measures.push(unavailableMeasure({ id: "flu-vaccination", label: "Influenza vaccination coverage", category: "prevention", geographyType: "state", source: "CDC VaxView", sourceUrl: VAX_CATALOG, vintage: "Latest published season", cadence: "Seasonal", note: "Choose a state to load prevention indicators." }));
        return { section, errors, sources };
    }
    const stateName = jurisdictionByCode(stateCode)!.name;
    const [vax, overdose] = await Promise.allSettled([fetchVaccination(stateName, stateCode, countyFips, period), fetchOverdose(stateCode, countyFips, period, population)]);
    if (vax.status === "fulfilled")
        section.measures.push(vax.value);
    else {
        errors.push({ source: "CDC VaxView", message: sourceError(vax.reason) });
        section.measures.push(unavailableMeasure({ id: "flu-vaccination", label: "Influenza vaccination coverage", category: "prevention", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), source: "CDC VaxView", sourceUrl: VAX_CATALOG, vintage: "Latest published season", cadence: "Seasonal", note: errors.at(-1)!.message }));
    }
    if (overdose.status === "fulfilled")
        section.measures.push(...overdose.value);
    else {
        errors.push({ source: "CDC provisional overdose deaths", message: sourceError(overdose.reason) });
        section.measures.push(unavailableMeasure({ id: "overdose-deaths", label: "12-month-ending provisional overdose deaths", category: "prevention", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), source: "CDC NVSS", sourceUrl: OVERDOSE_CATALOG, vintage: "Latest 12-month-ending period", cadence: "Quarterly", note: errors.at(-1)!.message }));
    }
    return { section, errors, sources };
}
async function fetchVaccination(stateName: string, stateCode: IncludedStateCode, countyFips: string | null, period: string | null) {
    const stateFips = jurisdictionByCode(stateCode)!.fips;
    const params = new URLSearchParams({ "$select": "vaccine,geography_type,geography,fips,year_season,month,dimension_type,dimension,coverage_estimate,_95_ci", "$where": `fips like '${stateFips}%' AND dimension_type='Age' AND vaccine like '%Influenza%'`, "$limit": "5000" });
    const stateRows = await fetchJsonRows(`${VAX_URL}?${params}`);
    const rows = stateRows.filter((row) => {
        const fips = textValue(row.fips).replace(/\D/g, "");
        return countyFips ? fips.padStart(5, "0") === countyFips : fips === stateFips || textValue(row.geography) === stateName;
    });
    const preferredDimensions = countyFips ? [">=18 years"] : [">=6 months", "greater than 6 months flu"];
    const eligible = rows.filter((row) => /influenza|flu/i.test(textValue(row.vaccine)) && preferredDimensions.includes(textValue(row.dimension).trim().toLowerCase()));
    const periodKey = (row: Record<string, unknown>) => `${textValue(row.year_season)}-${String(numberValue(row.month) ?? 0).padStart(2, "0")}`;
    const row = eligible.sort((left, right) => periodKey(right).localeCompare(periodKey(left))
        || preferredDimensions.indexOf(textValue(left.dimension).trim().toLowerCase()) - preferredDimensions.indexOf(textValue(right.dimension).trim().toLowerCase()))[0];
    const value = numberValue(row?.coverage_estimate);
    const confidence = confidenceInterval(row?._95_ci);
    const releaseStale = (coverageEndYear(row?.year_season) ?? 0) < new Date().getUTCFullYear();
    const freshnessNote = period ? "Latest published season; not backdated to the selected month." : releaseStale ? "The latest published season is older than the current calendar year." : "Estimate from the latest published season.";
    return makeMeasure({ id: "flu-vaccination", label: "Influenza vaccination coverage", category: "prevention", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), value, unit: "%", vintage: textValue(row?.year_season) || "Latest published season", period: textValue(row?.year_season), cadence: "Seasonal", estimateType: "observed", status: value === null ? "partial" : period || releaseStale ? "stale" : "current", quality: value === null ? "limited" : "moderate", ...(confidence.low !== null ? { confidenceLow: confidence.low } : {}), ...(confidence.high !== null ? { confidenceHigh: confidence.high } : {}), source: "CDC VaxView", sourceUrl: VAX_CATALOG, note: row ? `${textValue(row.dimension)}; ${countyFips ? "county" : "state"} estimate. ${freshnessNote}` : "No matching influenza estimate was returned." });
}
function coverageEndYear(value: unknown): number | null {
    const match = /^(\d{4})(?:-(\d{2}|\d{4}))?$/.exec(textValue(value).trim());
    if (!match)
        return null;
    const start = Number(match[1]);
    if (!match[2])
        return start;
    if (match[2].length === 4)
        return Number(match[2]);
    const end = Math.floor(start / 100) * 100 + Number(match[2]);
    return end < start ? end + 100 : end;
}
function confidenceInterval(value: unknown) {
    const parts = textValue(value).trim().split(/\s+to\s+/i);
    const low = parts.length === 2 ? numberValue(parts[0]) : null;
    const high = parts.length === 2 ? numberValue(parts[1]) : null;
    return low !== null && high !== null && low <= high ? { low, high } : { low: null, high: null };
}
async function fetchOverdose(stateCode: IncludedStateCode, countyFips: string | null, period: string | null, population: number | null) {
    const whereParts = [`st_abbrev='${stateCode}'`];
    if (period) {
        const [year, month] = period.split("-").map(Number);
        const previous = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
        const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
        whereParts.push(`monthendingdate >= '${previous}' AND monthendingdate < '${next}'`);
    }
    const params = new URLSearchParams({ "$select": "year,month,st_abbrev,state_name,countyname,fips,provisional_drug_overdose,monthendingdate,data_as_of", "$where": whereParts.join(" AND "), "$order": "monthendingdate DESC", "$limit": "5000" });
    const stateRows = await fetchJsonRows(`${OVERDOSE_URL}?${params}`);
    const rows = countyFips ? stateRows.filter((row) => textValue(row.fips).replace(/\D/g, "").padStart(5, "0") === countyFips) : stateRows;
    if (!rows.length)
        return makeOverdoseMeasure(null, null, stateCode, countyFips, population, period, "No provisional county records were returned.");
    const periods = [...new Set(rows.map((row) => textValue(row.monthendingdate)).filter(Boolean))].sort((left, right) => right.localeCompare(left));
    const latestPeriod = period ? periods.find((candidate) => candidate.slice(0, 7) === period) ?? "" : periods[0] ?? "";
    const latestRows = rows.filter((row) => textValue(row.monthendingdate) === latestPeriod);
    const previousPeriod = periods.find((candidate) => candidate !== latestPeriod && (!latestPeriod || candidate < latestPeriod)) ?? null;
    const previousRows = previousPeriod ? rows.filter((row) => textValue(row.monthendingdate) === previousPeriod) : [];
    const count = sumPublishedCounts(latestRows);
    const previousCount = sumPublishedCounts(previousRows);
    const suppressed = latestRows.filter((row) => numberValue(row.provisional_drug_overdose) === null).length;
    const caveat = suppressed ? ` ${suppressed} suppressed or missing county ${suppressed === 1 ? "value is" : "values are"} excluded.` : "";
    const note = `This is a provisional 12-month-ending count, not a one-month count.${caveat} Records can change as death certificates are processed.${previousCount === null ? "" : " Change is versus the prior 12-month-ending period."}`;
    return makeOverdoseMeasure(count, textValue(latestRows[0]?.data_as_of) || latestPeriod, stateCode, countyFips, population, latestPeriod, note, previousCount);
}
function sumPublishedCounts(rows: Record<string, unknown>[]) {
    const counts = rows.map((row) => numberValue(row.provisional_drug_overdose)).filter((value): value is number => value !== null);
    return counts.length ? counts.reduce((sum, count) => sum + count, 0) : null;
}
function makeOverdoseMeasure(value: number | null, vintage: string | null, stateCode: IncludedStateCode, countyFips: string | null, population: number | null, period: string | null, note: string, previousCount: number | null = null) {
    const geographyType = countyFips ? "county" as const : "state" as const;
    const change = value !== null && previousCount !== null ? value - previousCount : null;
    const shared = { category: "prevention" as const, geographyType, stateCode, ...(countyFips ? { fips: countyFips } : {}), vintage: vintage || "Latest 12-month-ending period", period: period ?? "", cadence: "Quarterly", estimateType: "observed" as const, source: "CDC NVSS", sourceUrl: OVERDOSE_CATALOG, note, quality: "moderate" as const };
    const countMeasure = makeMeasure({ ...shared, id: "overdose-deaths", label: countyFips ? "12-month-ending provisional overdose deaths" : "12-month-ending provisional overdose deaths across state counties", value, unit: "deaths", status: value === null ? "partial" : "current", change: change === null ? undefined : { value: change, displayValue: `${change > 0 ? "+" : ""}${change.toFixed(0)}`, label: "vs prior 12-month-ending period", period: period ?? "" }, trend: change === null ? "unknown" : change > 0 ? "worsening" : change < 0 ? "improving" : "stable" });
    const rate = value !== null && population !== null && population > 0 ? value / population * 100000 : null;
    const rateMeasure = makeMeasure({ ...shared, id: "overdose-rate", label: "12-month-ending provisional overdose death rate", value: rate, unit: "per 100,000", numerator: value, denominator: population, status: rate === null ? "partial" : "current", note: rate === null ? `${note} A population denominator was not available for this view.` : `${note} Normalized with the selected geography's 2025 Census population estimate.` });
    return [countMeasure, rateMeasure];
}
