import "server-only";
import type { PopulationPhaseResult } from "@/lib/population-health-sources";
import { cachedPublisherFetch } from "@/lib/publisher-cache";
import { getBakedNationalOutlook } from "@/lib/national-live";
import { getCachedServerOutlookSnapshot } from "@/lib/server-public-snapshot";
import { jurisdictionByCode, type IncludedStateCode } from "@/lib/us-geography";
import { fetchJsonRows, makeMeasure, numberValue, POPULATION_PUBLISHER_TIMEOUT_MS, sourceError, textValue, unavailableMeasure } from "@/lib/population-health-utils";
const NORS_URL = "https://data.cdc.gov/resource/5xkq-dg7x.json";
const NORS_CATALOG = "https://data.cdc.gov/Foodborne-Waterborne-and-Related-Diseases/NORS/5xkq-dg7x";
const CMS_CATALOG = "https://data.cms.gov/provider-data/";
const HAZARD_CATALOG = "https://api.weather.gov/alerts/active";
export async function loadPhase4(stateCode: IncludedStateCode | null, countyFips: string | null, period: string | null = null): Promise<PopulationPhaseResult> {
    const section = { id: "resilience" as const, title: "Facilities, outbreaks, and hazards", description: "Operational capacity and hazard context are the final layer for interpreting community burden and response readiness.", measures: [] as ReturnType<typeof makeMeasure>[] };
    const errors: Array<{
        source: string;
        message: string;
    }> = [];
    const sources = [
        { name: "CDC National Outbreak Reporting System", url: NORS_CATALOG, vintage: "Historical and latest published records", cadence: "Event-based" },
        { name: "CMS Care Compare", url: CMS_CATALOG, vintage: "Latest published ED measure", cadence: "Quarterly" },
        { name: "NOAA/NWS hazards", url: HAZARD_CATALOG, vintage: "Current active alerts", cadence: "Event-based" },
    ];
    if (!stateCode) {
        section.measures.push(unavailableMeasure({ id: "nors-events", label: "Reported outbreak illnesses", category: "resilience", geographyType: "state", source: "CDC NORS", sourceUrl: NORS_CATALOG, vintage: "Latest published records", cadence: "Event-based", note: "Choose a state to load event-based outbreak context." }));
        return { section, errors, sources };
    }
    const [nors, cms, hazards] = await Promise.allSettled([
        fetchNors(stateCode, period),
        period ? Promise.resolve(null) : fetchCmsEdWait(stateCode),
        period ? Promise.resolve(null) : fetchNwsHazards(stateCode),
    ]);
    if (nors.status === "fulfilled")
        section.measures.push(...nors.value);
    else {
        errors.push({ source: "CDC NORS", message: sourceError(nors.reason) });
        section.measures.push(unavailableMeasure({ id: "nors-events", label: "Reported outbreak illnesses", category: "resilience", geographyType: "state", stateCode, source: "CDC NORS", sourceUrl: NORS_CATALOG, vintage: "Latest published records", cadence: "Event-based", note: errors.at(-1)!.message }));
    }
    if (period) {
        section.measures.push(unavailableMeasure({ id: "cms-ed-wait", label: "Emergency-department length of stay", category: "resilience", geographyType: "state", stateCode, source: "CMS Care Compare", sourceUrl: CMS_CATALOG, vintage: "Latest published measure", cadence: "Quarterly", estimateType: "facility", note: "Historical CMS facility detail is not inferred when the selected month predates the current Care Compare release." }));
        section.measures.push(unavailableMeasure({ id: "hazard-exposure", label: "Active weather alerts", category: "resilience", geographyType: "state", stateCode, source: "NOAA/NWS", sourceUrl: HAZARD_CATALOG, vintage: "Current active alerts", cadence: "Event-based", note: "Historical active alerts are not reconstructed from today's alert feed." }));
        section.measures.push(unavailableMeasure({ id: "hazard-severe", label: "Severe or extreme weather alerts", category: "resilience", geographyType: "state", stateCode, source: "NOAA/NWS", sourceUrl: HAZARD_CATALOG, vintage: "Current active alerts", cadence: "Event-based", note: "Historical active alerts are not reconstructed from today's alert feed." }));
    }
    else {
        if (cms.status === "fulfilled" && cms.value)
            section.measures.push(cms.value);
        else if (cms.status === "rejected") {
            const message = sourceError(cms.reason);
            errors.push({ source: "CMS Care Compare", message });
            section.measures.push(unavailableMeasure({ id: "cms-ed-wait", label: "Emergency-department length of stay", category: "resilience", geographyType: "state", stateCode, source: "CMS Care Compare", sourceUrl: CMS_CATALOG, vintage: "Latest published measure", cadence: "Quarterly", estimateType: "facility", note: message }));
        }
        if (hazards.status === "fulfilled" && hazards.value)
            section.measures.push(...hazards.value);
        else if (hazards.status === "rejected") {
            const message = sourceError(hazards.reason);
            errors.push({ source: "NOAA/NWS", message });
            section.measures.push(unavailableMeasure({ id: "hazard-exposure", label: "Active weather alerts", category: "resilience", geographyType: "state", stateCode, source: "NOAA/NWS", sourceUrl: HAZARD_CATALOG, vintage: "Current active alerts", cadence: "Event-based", note: message }));
            section.measures.push(unavailableMeasure({ id: "hazard-severe", label: "Severe or extreme weather alerts", category: "resilience", geographyType: "state", stateCode, source: "NOAA/NWS", sourceUrl: HAZARD_CATALOG, vintage: "Current active alerts", cadence: "Event-based", note: message }));
        }
    }
    return { section, errors, sources };
}
async function fetchNors(stateCode: IncludedStateCode, period: string | null) {
    const where = [`state='${jurisdictionByCode(stateCode)!.name.replaceAll("'", "''")}'`];
    if (period) {
        const [year, month] = period.split("-").map(Number);
        where.push(`year='${year}' AND month='${month}'`);
    }
    const sharedParams = { "$where": where.join(" AND "), "$group": "year,month", "$order": "year DESC,month DESC", "$limit": period ? "1" : "2" };
    const totalsParams = new URLSearchParams({ "$select": "year,month,count(*) as events,sum(illnesses) as illnesses,sum(deaths) as deaths", ...sharedParams });
    const completenessParams = new URLSearchParams({ "$select": "year,month,count(illnesses) as illness_records,count(deaths) as death_records", ...sharedParams });
    const [totals, completeness] = await Promise.all([fetchJsonRows(`${NORS_URL}?${totalsParams}`), fetchJsonRows(`${NORS_URL}?${completenessParams}`)]);
    const rows = totals.map((row) => ({ ...row, ...completeness.find((candidate) => textValue(candidate.year) === textValue(row.year) && textValue(candidate.month) === textValue(row.month)) }));
    const periods = [...new Set(rows.map((row) => `${textValue(row.year)}-${textValue(row.month).padStart(2, "0")}`))].filter((value) => value !== "-").sort((left, right) => right.localeCompare(left));
    const latest = period ?? periods[0] ?? "";
    const latestRows = rows.filter((row) => `${textValue(row.year)}-${textValue(row.month).padStart(2, "0")}` === latest);
    const previous = periods.find((candidate) => candidate !== latest);
    const previousRows = previous ? rows.filter((row) => `${textValue(row.year)}-${textValue(row.month).padStart(2, "0")}` === previous) : [];
    const illnesses = sumField(latestRows, "illnesses");
    const deaths = sumField(latestRows, "deaths");
    const previousIllnesses = sumField(previousRows, "illnesses");
    const events = numberValue(latestRows[0]?.events);
    const illnessRecords = numberValue(latestRows[0]?.illness_records);
    const deathRecords = numberValue(latestRows[0]?.death_records);
    const previousEvents = numberValue(previousRows[0]?.events);
    const previousIllnessRecords = numberValue(previousRows[0]?.illness_records);
    const missingIllnesses = events !== null && illnessRecords !== null ? Math.max(0, events - illnessRecords) : null;
    const missingDeaths = events !== null && deathRecords !== null ? Math.max(0, events - deathRecords) : null;
    const illnessComplete = events !== null && illnessRecords === events;
    const deathComplete = events !== null && deathRecords === events;
    const previousComplete = previousEvents !== null && previousIllnessRecords === previousEvents;
    const change = illnesses !== null && previousIllnesses !== null && illnessComplete && previousComplete ? illnesses - previousIllnesses : null;
    const stale = !period && isOldMonth(latest);
    const illnessStatus = illnesses === null || !illnessComplete ? "partial" as const : stale ? "stale" as const : "current" as const;
    const deathStatus = deaths === null || !deathComplete ? "partial" as const : stale ? "stale" as const : "current" as const;
    const note = latestRows.length ? `${events === null ? "An unknown number of" : events} NORS event ${events === 1 ? "record" : "records"} in the latest reported month${missingIllnesses ? `; ${missingIllnesses} ${missingIllnesses === 1 ? "event omits" : "events omit"} illness counts` : ""}. This event-based extract is not a complete incidence estimate.` : "No NORS records were returned for this state and period.";
    return [
        makeMeasure({ id: "nors-events", label: "Reported outbreak illnesses", category: "resilience", geographyType: "state", stateCode, value: illnesses, unit: "illnesses", vintage: latest || "Historical", period: latest, cadence: "Event-based", estimateType: "observed", status: illnessStatus, quality: illnessStatus === "current" ? "moderate" : "limited", source: "CDC NORS", sourceUrl: NORS_CATALOG, note, change: change === null ? undefined : { value: change, displayValue: `${change > 0 ? "+" : ""}${change.toFixed(0)}`, label: "vs prior reported month", period: previous ?? "" }, trend: change === null ? "unknown" : change > 0 ? "worsening" : change < 0 ? "improving" : "stable" }),
        makeMeasure({ id: "nors-deaths", label: "Reported outbreak deaths", category: "resilience", geographyType: "state", stateCode, value: deaths, unit: "deaths", vintage: latest || "Historical", period: latest, cadence: "Event-based", estimateType: "observed", status: deathStatus, quality: deathStatus === "current" ? "moderate" : "limited", source: "CDC NORS", sourceUrl: NORS_CATALOG, note: `Reported deaths in the NORS event extract${missingDeaths ? `; ${missingDeaths} ${missingDeaths === 1 ? "event omits" : "events omit"} death counts` : ""}. Missing values are not treated as zero.` }),
    ];
}
function isOldMonth(period: string) {
    if (!/^\d{4}-\d{2}$/.test(period))
        return false;
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
    return period < cutoff.toISOString().slice(0, 7);
}
function sumField(rows: Record<string, unknown>[], field: string) {
    const values = rows.map((row) => numberValue(row[field])).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}
async function fetchCmsEdWait(stateCode: IncludedStateCode) {
    const outlook = await getBakedNationalOutlook({ signalId: "ed-wait", stateCode: null, period: null }) ?? getCachedServerOutlookSnapshot("ed-wait", "", false);
    const reading = outlook?.states.find((state) => state.code === stateCode);
    return makeMeasure({ id: "cms-ed-wait", label: "Emergency-department length of stay", category: "resilience", geographyType: "state", stateCode, value: reading?.value ?? null, unit: "minutes", vintage: reading?.observedThrough ?? "Latest published measure", period: reading?.observedThrough ?? "", cadence: "Quarterly", estimateType: "facility", status: reading?.value === null || reading?.value === undefined ? "partial" : "current", quality: reading?.value === null || reading?.value === undefined ? "limited" : "moderate", source: "CMS Care Compare", sourceUrl: CMS_CATALOG, note: reading?.note ?? "No current CMS Care Compare statewide ED measure was returned." });
}
async function fetchNwsHazards(stateCode: IncludedStateCode) {
    const sourceUrl = `${HAZARD_CATALOG}?area=${stateCode}`;
    const body: unknown = await cachedPublisherFetch(`population-health:hazards:${stateCode}`, 900, async () => {
        const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(POPULATION_PUBLISHER_TIMEOUT_MS), headers: { accept: "application/geo+json", "user-agent": "Corvid Health Intelligence public-data connector" }, cache: "no-store" });
        if (!response.ok)
            throw new Error(`Publisher returned ${response.status}`);
        return response.json() as Promise<unknown>;
    });
    if (!body || typeof body !== "object" || !Array.isArray((body as {
        features?: unknown;
    }).features))
        throw new Error("Publisher returned malformed alert data");
    const alerts = (body as {
        features: Array<{
            properties?: {
                severity?: string;
                event?: string;
            };
        }>;
    }).features;
    const highSeverity = alerts.filter((alert) => /extreme|severe/i.test(textValue(alert.properties?.severity))).length;
    const shared = { category: "resilience" as const, geographyType: "state" as const, stateCode, vintage: "Current", period: new Date().toISOString().slice(0, 10), cadence: "Event-based", estimateType: "observed" as const, status: "current" as const, quality: "limited" as const, source: "NOAA/NWS", sourceUrl, note: "Alert counts are situational context, not a health-risk estimate." };
    return [
        makeMeasure({ ...shared, id: "hazard-exposure", label: "Active weather alerts", value: alerts.length, unit: "alerts", note: `${highSeverity} active alerts are marked severe or extreme. ${shared.note}` }),
        makeMeasure({ ...shared, id: "hazard-severe", label: "Severe or extreme weather alerts", value: highSeverity, unit: "alerts", note: `Count of active alerts whose publisher severity is severe or extreme. ${shared.note}` }),
    ];
}
