import "server-only";
import type { PopulationPhaseResult } from "@/lib/population-health-sources";
import { cachedPublisherFetch, pinPublisherCacheKey } from "@/lib/publisher-cache";
import populationBaseline from "@/lib/generated/population-health-baseline.json";
import { getCachedServerOutlookSnapshot } from "@/lib/server-public-snapshot";
import { jurisdictionByCode, type IncludedStateCode } from "@/lib/us-geography";
import { fetchJsonRows, makeMeasure, normalizeFips, numberValue, parseCsv, POPULATION_PUBLISHER_TIMEOUT_MS, sourceError, textValue, unavailableMeasure } from "@/lib/population-health-utils";
const HPSA_FIND_URL = "https://data.hrsa.gov/hpsafind/find";
const HPSA_CATALOG = "https://data.hrsa.gov/topics/health-workforce/shortage-areas/hpsa-find";
const MUA_URL = "https://data.hrsa.gov/DataDownload/DD_Files/MUA_DET.csv";
const TRACKING_CATALOG = "https://ephtracking.cdc.gov/";
const HEATRISK_CATALOG = "https://www.wpc.ncep.noaa.gov/heatrisk/";
type MuaRow = {
    state: string;
    fips: string;
    status: string;
    id: string;
};
export async function loadPhase2(stateCode: IncludedStateCode | null, countyFips: string | null, period: string | null = null): Promise<PopulationPhaseResult> {
    const section = { id: "access" as const, title: "Exposure and care access", description: "Exposure and access context can change how a surveillance signal becomes a burden for a community.", measures: [] as ReturnType<typeof makeMeasure>[] };
    const errors: Array<{
        source: string;
        message: string;
    }> = [];
    const sources = [
        { name: "HRSA Health Professional Shortage Areas", url: HPSA_CATALOG, vintage: "Current query", cadence: "Monthly" },
        { name: "HRSA Medically Underserved Areas/Populations", url: MUA_URL, vintage: "Current download", cadence: "Periodic" },
        { name: "NOAA HeatRisk", url: HEATRISK_CATALOG, vintage: "Current seven-day outlook", cadence: "Daily" },
        { name: "EPA AirNow", url: "https://www.airnow.gov/aqi/", vintage: "Current monitor report", cadence: "Daily" },
        { name: "CDC Environmental Public Health Tracking", url: TRACKING_CATALOG, vintage: "Publisher portal", cadence: "Varies" },
    ];
    if (!stateCode) {
        section.measures.push(unavailableMeasure({ id: "care-access", label: "Care access", category: "access", geographyType: "state", source: "HRSA", sourceUrl: HPSA_CATALOG, vintage: "Current query", cadence: "Monthly", note: "Choose a state to load shortage-area counts." }));
        return { section, errors, sources };
    }
    const [hpsa, mua, heatRisk, airQuality] = await Promise.allSettled([
        countyFips ? fetchHpsa(stateCode, countyFips) : Promise.resolve(null),
        fetchMua(stateCode, countyFips),
        period ? Promise.resolve(null) : fetchHeatRisk(stateCode),
        period ? Promise.resolve(null) : fetchAirQuality(stateCode),
    ]);
    if (hpsa.status === "fulfilled" && hpsa.value) {
        section.measures.push(hpsaMeasure("hpsa-primary-care", "Primary-care shortage areas", "Primary Care", hpsa.value, stateCode, countyFips));
        section.measures.push(hpsaMeasure("hpsa-mental-health", "Mental-health shortage areas", "Mental Health", hpsa.value, stateCode, countyFips));
        section.measures.push(hpsaPopulationMeasure(hpsa.value, stateCode, countyFips));
        section.measures.push(hpsaNeedMeasure(hpsa.value, stateCode, countyFips));
    }
    else if (hpsa.status === "fulfilled") {
        const note = "Choose a county for live HPSA designation detail. HRSA's statewide HPSA Find response is too large for a bounded interactive request; statewide MUA/P context remains available below.";
        for (const [id, label] of [["hpsa-primary-care", "Primary-care shortage areas"], ["hpsa-mental-health", "Mental-health shortage areas"], ["hpsa-population", "Published population across shortage designations"], ["hpsa-practitioners-needed", "Practitioners needed"]]) {
            section.measures.push(unavailableMeasure({ id, label, category: "access", geographyType: "state", stateCode, source: "HRSA", sourceUrl: HPSA_CATALOG, vintage: "Current query", cadence: "Monthly", note }));
        }
    }
    else {
        const message = sourceError(hpsa.reason);
        errors.push({ source: "HRSA Health Professional Shortage Areas", message });
        for (const [id, label] of [["hpsa-primary-care", "Primary-care shortage areas"], ["hpsa-mental-health", "Mental-health shortage areas"], ["hpsa-population", "Published population across shortage designations"], ["hpsa-practitioners-needed", "Practitioners needed"]]) {
            section.measures.push(unavailableMeasure({ id, label, category: "access", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), source: "HRSA", sourceUrl: HPSA_CATALOG, vintage: "Current query", cadence: "Monthly", note: message }));
        }
    }
    if (mua.status === "fulfilled") {
        const rows = mua.value;
        const activeRows = rows.filter((row) => !/inactive|withdrawn|terminated/i.test(row.status));
        const ids = new Set(activeRows.map((row) => row.id).filter(Boolean));
        const active = ids.size || activeRows.length;
        section.measures.push(makeMeasure({ id: "mua-p", label: "Medically underserved areas/populations", category: "access", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), value: active, unit: "designations", vintage: "Current download", period: "Current", cadence: "Periodic", estimateType: "facility", status: "current", quality: "moderate", source: "HRSA", sourceUrl: MUA_URL, note: `${rows.length} matching records; active records counted where status was available.` }));
    }
    else {
        const message = sourceError(mua.reason);
        errors.push({ source: "HRSA Medically Underserved Areas/Populations", message });
        section.measures.push(unavailableMeasure({ id: "mua-p", label: "Medically underserved areas/populations", category: "access", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), source: "HRSA", sourceUrl: MUA_URL, vintage: "Current download", cadence: "Periodic", note: message }));
    }
    if (period) {
        section.measures.push(unavailableMeasure({ id: "heat-risk", label: "Official HeatRisk category", category: "environment", geographyType: "state", stateCode, source: "NOAA HeatRisk", sourceUrl: HEATRISK_CATALOG, vintage: "Current seven-day outlook", cadence: "Daily", estimateType: "projected", note: "Historical HeatRisk is not inferred from the current seven-day outlook." }));
        section.measures.push(unavailableMeasure({ id: "air-quality", label: "Air quality", category: "environment", geographyType: "state", stateCode, source: "EPA AirNow", sourceUrl: "https://www.airnow.gov/aqi/", vintage: "Current monitor report", cadence: "Daily", estimateType: "observed", note: "Historical AirNow monitor data is not inferred from today's report." }));
    }
    else {
        for (const result of [heatRisk, airQuality]) {
            if (result.status === "fulfilled" && result.value)
                section.measures.push(result.value);
            else if (result.status === "rejected") {
                const source = result === heatRisk ? "NOAA HeatRisk" : "EPA AirNow";
                const message = sourceError(result.reason);
                errors.push({ source, message });
                section.measures.push(unavailableMeasure({ id: source === "NOAA HeatRisk" ? "heat-risk" : "air-quality", label: source === "NOAA HeatRisk" ? "Official HeatRisk category" : "Air quality", category: "environment", geographyType: "state", stateCode, source, sourceUrl: source === "NOAA HeatRisk" ? HEATRISK_CATALOG : "https://www.airnow.gov/aqi/", vintage: "Current publisher report", cadence: "Daily", estimateType: "observed", note: message }));
            }
        }
    }
    const trackingEndpoint = process.env.CORVID_TRACKING_ENDPOINT;
    if (trackingEndpoint) {
        try {
            const endpoint = trackingEndpoint.replace(/\/$/, "");
            const separator = endpoint.includes("?") ? "&" : "?";
            const rows = await fetchJsonRows(`${endpoint}${separator}state=${stateCode}${countyFips ? `&fips=${countyFips}` : ""}`);
            const value = numberValue(rows[0]?.value);
            section.measures.push(makeMeasure({ id: "environmental-exposure", label: textValue(rows[0]?.label) || "Environmental health indicator", category: "environment", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), value, unit: textValue(rows[0]?.unit) || "index", vintage: textValue(rows[0]?.vintage) || "Current", period: textValue(rows[0]?.period), cadence: "Varies", estimateType: "observed", status: value === null ? "partial" : "current", quality: value === null ? "limited" : "moderate", source: "CDC Environmental Public Health Tracking", sourceUrl: trackingEndpoint, note: "Configured Environmental Public Health Tracking connector." }));
        }
        catch (error) {
            errors.push({ source: "CDC Environmental Public Health Tracking", message: sourceError(error) });
            section.measures.push(unavailableMeasure({ id: "environmental-exposure", label: "Environmental health indicator", category: "environment", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), source: "CDC Environmental Public Health Tracking", sourceUrl: TRACKING_CATALOG, vintage: "Publisher portal", cadence: "Varies", note: sourceError(error) }));
        }
    }
    else {
        section.measures.push(unavailableMeasure({ id: "environmental-exposure", label: "Environmental health indicator", category: "environment", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), source: "CDC Environmental Public Health Tracking", sourceUrl: TRACKING_CATALOG, vintage: "Publisher portal", cadence: "Varies", note: "The portal is identified for integration; no stable public query was configured for this deployment." }));
    }
    if (period) {
        section.measures = section.measures.map((measure) => measure.source === "HRSA" && measure.value !== null ? { ...measure, status: "stale", note: `${measure.note} Latest release; not backdated to the selected month.` } : measure);
    }
    return { section, errors, sources };
}
async function fetchHpsa(stateCode: IncludedStateCode, countyFips: string | null) {
    const params = new URLSearchParams({ state: stateCode, counties: countyFips?.slice(2) ?? "", id: "" });
    const sourceUrl = `${HPSA_FIND_URL}?${params}`;
    return cachedPublisherFetch(`population-health:hpsa:${stateCode}:${countyFips ?? "state"}`, 21600, async () => {
        const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(POPULATION_PUBLISHER_TIMEOUT_MS), headers: { accept: "application/json" }, cache: "no-store" });
        if (!response.ok)
            throw new Error(`Publisher returned ${response.status}`);
        const body: unknown = await response.json();
        if (!Array.isArray(body))
            throw new Error("Publisher returned malformed JSON rows");
        return body.flatMap((value): Record<string, unknown>[] => {
            if (!value || typeof value !== "object" || Array.isArray(value))
                return [];
            const row = value as Record<string, unknown>;
            return [{ hpsa_discipline_desc: row.hpsa_discipline_desc, hpsa_status_desc: row.hpsa_status_desc, StrippedHPSA: row.StrippedHPSA, hpsa_id: row.hpsa_id, hpsa_population: row.hpsa_population, hpsa_population_served: row.hpsa_population_served, population: row.population, hpsa_practitioners_needed: row.hpsa_practitioners_needed, practitioners_needed_remove: row.practitioners_needed_remove, practitioners_needed: row.practitioners_needed, hpsa_need: row.hpsa_need, needed_practitioners: row.needed_practitioners }];
        });
    });
}
function hpsaMatches(rows: Record<string, unknown>[], discipline: string) {
    return rows.filter((row) => textValue(row.hpsa_discipline_desc).trim().toLowerCase().includes(discipline.toLowerCase()) && isActiveHpsa(row));
}
function isActiveHpsa(row: Record<string, unknown>) {
    return /^(designated|proposed for withdrawal)$/i.test(textValue(row.hpsa_status_desc).trim());
}
function hpsaMeasure(id: string, label: string, discipline: string, rows: Record<string, unknown>[], stateCode: IncludedStateCode, countyFips: string | null) {
    const matches = hpsaMatches(rows, discipline);
    const active = new Set(matches.map((row) => textValue(row.StrippedHPSA || row.hpsa_id)).filter(Boolean)).size;
    return makeMeasure({ id, label, category: "access", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), value: active, unit: "designations", vintage: "Current query", period: "Current", cadence: "Monthly", estimateType: "facility", status: "current", quality: "moderate", source: "HRSA", sourceUrl: HPSA_CATALOG, note: `${active} unique active designations in the current HRSA geography query.` });
}
function sumDesignationField(rows: Record<string, unknown>[], fields: string[]) {
    const values = new Map<string, number>();
    for (const row of rows.filter(isActiveHpsa)) {
        const id = textValue(row.StrippedHPSA || row.hpsa_id);
        const value = fields.map((field) => numberValue(row[field])).find((candidate): candidate is number => candidate !== null);
        if (id && value !== undefined && !values.has(id))
            values.set(id, value);
    }
    return values.size ? [...values.values()].reduce((sum, value) => sum + value, 0) : null;
}
function hpsaPopulationMeasure(rows: Record<string, unknown>[], stateCode: IncludedStateCode, countyFips: string | null) {
    const value = sumDesignationField(rows, ["hpsa_population", "hpsa_population_served", "population"]);
    return makeMeasure({ id: "hpsa-population", label: "Published population across shortage designations", category: "access", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), value, unit: "people", vintage: "Current query", period: "Current", cadence: "Monthly", estimateType: "observed", status: value === null ? "partial" : "current", quality: "limited", source: "HRSA", sourceUrl: HPSA_CATALOG, note: "Sum of population fields once per active HPSA designation when published. Designations can overlap, so this is not a unique-person count." });
}
function hpsaNeedMeasure(rows: Record<string, unknown>[], stateCode: IncludedStateCode, countyFips: string | null) {
    const value = sumDesignationField(rows, ["hpsa_practitioners_needed", "practitioners_needed_remove", "practitioners_needed", "hpsa_need", "needed_practitioners"]);
    return makeMeasure({ id: "hpsa-practitioners-needed", label: "Practitioners needed", category: "access", geographyType: countyFips ? "county" : "state", stateCode, ...(countyFips ? { fips: countyFips } : {}), value, unit: "practitioners", vintage: "Current query", period: "Current", cadence: "Monthly", estimateType: "observed", status: value === null ? "partial" : "current", quality: value === null ? "limited" : "moderate", source: "HRSA", sourceUrl: HPSA_CATALOG, note: "Sum of the additional-practitioner fields when published by HRSA; a missing value is not treated as zero." });
}
async function fetchMua(stateCode: IncludedStateCode, countyFips: string | null) {
    const rows = await fetchMuaRows();
    return rows.filter((row) => row.state === stateCode && (!countyFips || row.fips === countyFips));
}
async function fetchMuaRows(): Promise<MuaRow[]> {
    return cachedPublisherFetch(MUA_KEY, 86400, async () => {
        const response = await fetch(MUA_URL, { signal: AbortSignal.timeout(POPULATION_PUBLISHER_TIMEOUT_MS), headers: { accept: "text/csv, application/octet-stream;q=0.9, */*;q=0.8" }, cache: "no-store" });
        if (!response.ok)
            throw new Error(`Publisher returned ${response.status}`);
        return parseCsv(await response.text()).flatMap((row): MuaRow[] => {
            const state = textValue(row["State Abbreviation"]).toUpperCase();
            const jurisdiction = jurisdictionByCode(state);
            const rawCounty = textValue(row["State and County Federal Information Processing Standard Code"] || row["County or County Equivalent Federal Information Processing Standard Code"]);
            const digits = rawCounty.replace(/\D/g, "");
            const fips = digits.length === 3 && jurisdiction ? `${jurisdiction.fips}${digits}` : normalizeFips(digits);
            return jurisdiction && fips ? [{ state, fips, status: textValue(row["MUA/P Status Description"] || row["Status Description"]), id: textValue(row["MUA/P ID"]) }] : [];
        });
    });
}
const MUA_KEY = "population-health:mua:all";
export async function warmPopulationHealthPhase2() {
    pinPublisherCacheKey(MUA_KEY);
    await cachedPublisherFetch(MUA_KEY, 86400, async () => populationBaseline.mua as MuaRow[]);
}
async function fetchHeatRisk(stateCode: IncludedStateCode) {
    const reading = getCachedServerOutlookSnapshot("heatrisk", "", false)?.states.find((state) => state.code === stateCode);
    return makeMeasure({ id: "heat-risk", label: "Official HeatRisk category", category: "environment", geographyType: "state", stateCode, value: reading?.value ?? null, unit: "category / 4", vintage: reading?.observedThrough ?? "Current seven-day outlook", period: reading?.observedThrough ?? "", cadence: "Daily", estimateType: "projected", status: reading?.value === null || reading?.value === undefined ? "partial" : "current", quality: reading?.value === null || reading?.value === undefined ? "limited" : "high", source: "NOAA HeatRisk", sourceUrl: HEATRISK_CATALOG, note: reading?.note ?? "No valid official HeatRisk sample was returned for this state." });
}
async function fetchAirQuality(stateCode: IncludedStateCode) {
    const reading = getCachedServerOutlookSnapshot("air-quality", "", false)?.states.find((state) => state.code === stateCode);
    return makeMeasure({ id: "air-quality", label: "Highest reported air quality index", category: "environment", geographyType: "state", stateCode, value: reading?.value ?? null, unit: "AQI", vintage: reading?.observedThrough ?? "Current monitor report", period: reading?.observedThrough ?? "", cadence: "Daily", estimateType: "observed", status: reading?.value === null || reading?.value === undefined ? "partial" : "current", quality: reading?.value === null || reading?.value === undefined ? "limited" : "moderate", source: "EPA AirNow", sourceUrl: "https://www.airnow.gov/aqi/", note: reading?.note ?? "No valid current AirNow monitor value was returned for this state." });
}
