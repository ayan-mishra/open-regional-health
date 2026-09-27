import "server-only";
import { getCachedServerForecastSnapshot, getCachedServerOutlookSnapshot } from "@/lib/server-public-snapshot";
import { getBakedNationalOutlook } from "@/lib/national-live";
import { getBakedNationalForecast } from "@/lib/national-forecast-live";
import { formatOrdinal } from "@/lib/format";
import type { NationalOutlook, NationalForecastResponse } from "@/lib/national-contracts";
import type { PopulationHealthResponse, PopulationInsight, PopulationMeasure, PopulationSection, PopulationSignalContext } from "@/lib/population-health-contracts";
import { SIGNAL_BY_ID, type SignalDefinition, type SignalId } from "@/lib/signal-catalog";
import { jurisdictionByCode, type IncludedStateCode } from "@/lib/us-geography";
export const POPULATION_CONTEXT_SIGNAL_IDS: SignalId[] = [
    "covid-ed", "influenza-ed", "covid-admissions", "influenza-admissions", "available-beds", "icu-availability", "heatrisk", "air-quality", "ed-wait",
];
const SOURCE_URLS: Partial<Record<SignalId, string>> = {
    "covid-ed": "https://data.cdc.gov/browse?tags=NSSP",
    "influenza-ed": "https://data.cdc.gov/browse?tags=NSSP",
    "covid-admissions": "https://data.cdc.gov/browse?tags=NHSN",
    "influenza-admissions": "https://data.cdc.gov/browse?tags=NHSN",
    "available-beds": "https://data.cdc.gov/browse?tags=NHSN",
    "icu-availability": "https://data.cdc.gov/browse?tags=NHSN",
    heatrisk: "https://www.wpc.ncep.noaa.gov/heatrisk/",
    "air-quality": "https://www.airnow.gov/aqi/",
    "ed-wait": "https://data.cms.gov/provider-data/",
};
type IntelligenceInput = {
    stateCode: IncludedStateCode;
    countyFips: string | null;
    period: string | null;
    sections: PopulationSection[];
};
export async function buildPopulationIntelligence({ stateCode, countyFips, period, sections }: IntelligenceInput): Promise<Pick<PopulationHealthResponse, "geographyLabel" | "summary" | "signals" | "insights" | "coverage" | "sections">> {
    const snapshots = await Promise.all(POPULATION_CONTEXT_SIGNAL_IDS.map(async (id) => {
        const [outlook, forecast] = period ? [null, null] : await Promise.all([
            getBakedNationalOutlook({ signalId: id, stateCode: null, period: null }),
            getBakedNationalForecast({ signalId: id, stateCode: null, period: null, horizon: 28 }),
        ]);
        return { id, outlook: outlook ?? getCachedServerOutlookSnapshot(id, period ?? "", false), forecast: forecast ?? getCachedServerForecastSnapshot(id, period ?? "", false) };
    }));
    const outlooks = Object.fromEntries(snapshots.map(({ id, outlook }) => [id, outlook]));
    const forecasts = Object.fromEntries(snapshots.map(({ id, forecast }) => [id, forecast]));
    if (!period)
        sections = sections.map((section) => ({ ...section, measures: section.measures.map((measure) => {
                const signalId = measure.id === "heat-risk" ? "heatrisk" : measure.id === "air-quality" ? "air-quality" : measure.id === "cms-ed-wait" ? "ed-wait" : null;
                const reading = signalId ? outlooks[signalId]?.states.find((state) => state.code === stateCode) : undefined;
                if (!reading || measure.geographyType !== "state")
                    return measure;
                return { ...measure, value: reading.value, displayValue: reading.displayValue, period: reading.observedThrough ?? "", vintage: reading.observedThrough ?? measure.vintage, note: reading.note, status: reading.value === null ? "unavailable" as const : reading.isStale ? "stale" as const : "current" as const };
            }) }));
    const signals = buildSignals(outlooks, forecasts, stateCode, period);
    const measures = sections.flatMap((section) => section.measures);
    const fallbackSignals = measuresToSignals(measures, stateCode, countyFips, signals);
    const combinedSignals = [...signals, ...fallbackSignals];
    const insights = buildInsights(combinedSignals, measures, stateCode);
    const available = measures.filter((measure) => measure.status === "current").length;
    const partial = measures.filter((measure) => measure.status === "partial" || measure.status === "stale").length;
    const unavailable = measures.filter((measure) => measure.status === "unavailable").length;
    const total = measures.length;
    const geographyLabel = jurisdictionByCode(stateCode)!.name + (countyFips ? " · county " + countyFips : "");
    const reviewCount = insights.filter((insight) => insight.priority === "review").length;
    const usableSignals = combinedSignals.filter((signal) => signal.value !== null && signal.status !== "unavailable");
    const summary = reviewCount
        ? reviewCount + " review flag" + (reviewCount === 1 ? "" : "s") + " from the available evidence. Validate the source notes before acting."
        : usableSignals.length
            ? "No high-pressure flags in the available comparison set. Use the phase detail to understand local susceptibility, access, and response capacity."
            : combinedSignals.length
                ? "Prepared surveillance context is unavailable for this brief. Review the phase detail and source notes for evidence gaps."
                : "Population context is loaded. Comparable surveillance signals appear when the prepared current feed is available.";
    return {
        geographyLabel,
        sections,
        summary,
        signals: combinedSignals,
        insights,
        coverage: { available, partial, unavailable, total, label: available + " of " + total + " measures are current" },
    };
}
function buildSignals(outlooks: Partial<Record<SignalId, NationalOutlook>>, forecasts: Partial<Record<SignalId, NationalForecastResponse>>, stateCode: IncludedStateCode, period: string | null): PopulationSignalContext[] {
    return POPULATION_CONTEXT_SIGNAL_IDS.flatMap((id) => {
        const outlook = outlooks[id];
        const reading = outlook?.states.find((state) => state.code === stateCode);
        if (!outlook || !reading)
            return [];
        const definition = SIGNAL_BY_ID[id];
        const forecast = forecasts[id];
        const forecastReading = forecast?.states.find((state) => state.code === stateCode);
        const estimate = forecastReading?.estimate?.evidence === "supported" && (period || forecastReading.estimate.targetDate > new Date().toISOString().slice(0, 10)) ? forecastReading.estimate : null;
        const value = reading.value;
        return [{
                id,
                label: definition.label,
                unit: definition.unit,
                value,
                displayValue: value === null ? "Unavailable" : reading.displayValue,
                geographyType: "state",
                stateCode,
                source: definition.source,
                sourceUrl: SOURCE_URLS[id] ?? "https://data.cdc.gov/",
                observedThrough: reading.observedThrough,
                status: value === null ? "unavailable" : reading.isStale ? "stale" : reading.comparisonEligible ? "current" : "partial",
                evidence: definition.defaultEvidence === "modeled" ? "observed" : definition.defaultEvidence,
                note: reading.note,
                direction: definition.direction,
                pressurePercentile: reading.comparisonEligible && !reading.isStale && definition.defaultEvidence !== "planning" ? pressurePercentile(outlook, value, definition) : null,
                forecast: estimate ? { value: estimate.value, displayValue: formatSignalValue(estimate.value, definition.unit), targetDate: estimate.targetDate, lower: estimate.lower, upper: estimate.upper } : null,
            } satisfies PopulationSignalContext];
    });
}
function measuresToSignals(measures: PopulationMeasure[], stateCode: IncludedStateCode, countyFips: string | null, existing: PopulationSignalContext[]) {
    const existingIds = new Set(existing.map((signal) => signal.id));
    return measures.flatMap((measure): PopulationSignalContext[] => {
        const id = measure.id === "heat-risk" ? "heatrisk" : measure.id === "cms-ed-wait" ? "ed-wait" : measure.id === "air-quality" ? "air-quality" : null;
        if (!id || existingIds.has(id))
            return [];
        const isCounty = measure.geographyType === "county" && Boolean(measure.fips);
        return [{
                id,
                label: measure.label,
                unit: measure.unit,
                value: measure.value,
                displayValue: measure.displayValue,
                geographyType: isCounty ? "county" : "state",
                stateCode,
                ...(isCounty ? { fips: measure.fips ?? countyFips! } : {}),
                source: measure.source,
                sourceUrl: measure.sourceUrl,
                observedThrough: isoDateOrNull(measure.period),
                status: measure.status,
                evidence: id === "heatrisk" || measure.estimateType === "projected" ? "official" : "observed",
                note: measure.note,
                direction: "higher-is-worse",
                pressurePercentile: null,
                forecast: null,
            } satisfies PopulationSignalContext];
    });
}
function isoDateOrNull(value: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return null;
    const parsed = new Date(value + "T00:00:00Z");
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
function pressurePercentile(outlook: NationalOutlook, value: number | null, definition: SignalDefinition) {
    if (value === null)
        return null;
    const values = outlook.states.filter((state) => state.comparisonEligible && !state.isStale && state.value !== null).map((state) => state.value!);
    if (values.length < 5)
        return null;
    const atOrWorse = definition.direction === "higher-is-worse"
        ? values.filter((candidate) => candidate <= value).length
        : values.filter((candidate) => candidate >= value).length;
    return Math.round(atOrWorse / values.length * 100);
}
function buildInsights(signals: PopulationSignalContext[], measures: PopulationMeasure[], stateCode: IncludedStateCode): PopulationInsight[] {
    const insights: PopulationInsight[] = [];
    for (const signal of [...signals].filter((candidate) => (candidate.pressurePercentile ?? 0) >= 80).sort((left, right) => (right.pressurePercentile ?? 0) - (left.pressurePercentile ?? 0)).slice(0, 3)) {
        const percentile = signal.pressurePercentile!;
        insights.push({ id: "signal-" + signal.id, title: signal.label + " is a high comparison pressure", summary: jurisdictionByCode(stateCode)!.name + " is at the " + formatOrdinal(percentile) + " percentile among states with comparable " + signal.label.toLowerCase() + " data.", category: categoryForSignal(signal.id), priority: percentile >= 90 ? "review" : "watch", evidence: [signal.id], action: "Review this signal with the source note and local operating capacity before changing plans." });
    }
    const vulnerability = measures.find((measure) => measure.id === "social-vulnerability");
    if (vulnerability && vulnerability.value !== null && vulnerability.value >= 75) {
        insights.push({ id: "social-vulnerability", title: "Community vulnerability is elevated", summary: "The selected geography is at the " + formatOrdinal(Math.round(vulnerability.value)) + " SVI percentile; higher values indicate greater vulnerability relative to U.S. counties.", category: "baseline", priority: vulnerability.value >= 90 ? "review" : "watch", evidence: [vulnerability.id], action: "Use the theme scores to target outreach, access, and continuity planning rather than treating the rank as a diagnosis." });
    }
    const primaryCare = measures.find((measure) => measure.id === "hpsa-primary-care");
    const mentalHealth = measures.find((measure) => measure.id === "hpsa-mental-health");
    if ((primaryCare?.value ?? 0) > 0 || (mentalHealth?.value ?? 0) > 0) {
        const designations = (primaryCare?.value ?? 0) + (mentalHealth?.value ?? 0);
        insights.push({ id: "care-access", title: "Care access has active shortage designations", summary: designations + " current HRSA primary-care or mental-health designations are in the selected geography.", category: "access", priority: "watch", evidence: ["hpsa-primary-care", "hpsa-mental-health"], action: "Check referral, staffing, and surge pathways; HPSA designations are not a complete provider-capacity measure." });
    }
    const heat = measures.find((measure) => measure.id === "heat-risk");
    const olderAdults = measures.find((measure) => measure.id === "acs-older-adults");
    if (heat?.status === "current" && (heat.value ?? 0) >= 3) {
        insights.push({ id: "heat-exposure", title: "Official HeatRisk is elevated", summary: (heat?.displayValue ?? "The current HeatRisk category") + (olderAdults?.value !== null && olderAdults?.value !== undefined ? " with " + olderAdults.displayValue + " of residents age 65 and older" : "") + ".", category: "environment", priority: "review", evidence: ["heat-risk", ...(olderAdults ? [olderAdults.id] : [])], action: "Review heat-response capacity, outreach, and cooling access for the current outlook window." });
    }
    const overdose = measures.find((measure) => measure.id === "overdose-deaths");
    if (overdose?.trend === "worsening") {
        insights.push({ id: "overdose-trend", title: "12-month-ending provisional overdose deaths increased", summary: overdose.displayValue + " is " + (overdose.change?.displayValue ?? "higher") + " compared with the prior 12-month-ending period; the total remains provisional.", category: "prevention", priority: "review", evidence: [overdose.id], action: "Validate the latest release and coordinate with local prevention and response partners." });
    }
    return insights.sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority)).slice(0, 6);
}
function categoryForSignal(id: string) {
    const domain = SIGNAL_BY_ID[id as SignalId]?.domain;
    return domain === "environment" ? "environment" as const : domain === "hospital" || domain === "capacity" ? "resilience" as const : "prevention" as const;
}
function priorityRank(priority: PopulationInsight["priority"]) {
    return priority === "review" ? 0 : priority === "watch" ? 1 : 2;
}
function formatSignalValue(value: number, unit: string) {
    if (unit.includes("%"))
        return value.toFixed(1) + "%";
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
