import type { NationalDetailReading, NationalStateReading } from "@/lib/national-contracts";
import type { SignalDefinition } from "@/lib/signal-catalog";
const DAY_MS = 86400000;
export const STALE_AFTER_DAYS = 7;
type Reading = Pick<NationalStateReading, "value" | "observedThrough" | "comparisonEligible" | "publisherEligible" | "isStale" | "note">;
function observationTimestamp(value: string) {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
        return Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59, 999);
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}
function isOlderThanSevenDays(observedThrough: string, now: Date) {
    const timestamp = observationTimestamp(observedThrough);
    return timestamp !== null && now.getTime() - timestamp > STALE_AFTER_DAYS * DAY_MS;
}
export function applyStaleFallback<T extends Reading>(readings: T[], period: string | null, now: Date) {
    if (period)
        return false;
    let hasStaleReading = false;
    for (const reading of readings) {
        if (!Number.isFinite(reading.value) || !reading.observedThrough || !isOlderThanSevenDays(reading.observedThrough, now))
            continue;
        reading.isStale = true;
        hasStaleReading = true;
        const publisherEligible = reading.publisherEligible ?? reading.comparisonEligible;
        if (publisherEligible)
            reading.comparisonEligible = true;
    }
    return hasStaleReading;
}
function formatCountyMean(value: number, signal: SignalDefinition) {
    const unit = signal.unit.toLowerCase();
    if (unit === "aqi")
        return `${Math.round(value)} AQI`;
    if (unit.includes("heatrisk"))
        return `${value.toFixed(1)} of 4`;
    if (unit.includes("%"))
        return `${value.toFixed(2)}%`;
    if (unit.includes("per 100,000"))
        return `${value.toFixed(1)} per 100k`;
    if (unit === "minutes")
        return `${value.toFixed(1)} minutes`;
    return `${value.toFixed(2)} ${signal.unit}`;
}
export function applyCountyStateAverages(states: NationalStateReading[], details: NationalDetailReading[], signal: SignalDefinition) {
    const countiesByState = new Map<string, Map<string, NationalDetailReading[]>>();
    for (const detail of details) {
        if (!detail.stateCode || detail.geographyType !== "county" || !detail.stateAggregationEligible || !Number.isFinite(detail.value) || !(detail.publisherEligible ?? detail.comparisonEligible))
            continue;
        const stateCounties = countiesByState.get(detail.stateCode) ?? new Map<string, NationalDetailReading[]>();
        const countyId = detail.id;
        const countyReadings = stateCounties.get(countyId) ?? [];
        countyReadings.push(detail);
        stateCounties.set(countyId, countyReadings);
        countiesByState.set(detail.stateCode, stateCounties);
    }
    for (const state of states) {
        if (state.comparisonEligible && Number.isFinite(state.value))
            continue;
        const countyGroups = countiesByState.get(state.code);
        if (!countyGroups?.size)
            continue;
        const countyDetails = [...countyGroups.values()].flat();
        const countyValues = [...countyGroups.values()].map((group) => group.reduce((sum, detail) => sum + (detail.value as number), 0) / group.length);
        const value = countyValues.reduce((sum, countyValue) => sum + countyValue, 0) / countyValues.length;
        const dates = countyDetails.map((detail) => detail.observedThrough).filter((date): date is string => Boolean(date)).sort();
        state.value = value;
        state.displayValue = formatCountyMean(value, signal);
        state.observedThrough = dates[0] ?? null;
        state.comparisonEligible = true;
        state.publisherEligible = true;
        state.isStale = countyDetails.some((detail) => detail.isStale);
        state.countyAggregation = { method: "county-mean", countyCount: countyValues.length };
        state.note = `Equal-weight mean of ${countyValues.length} source-valid county observation${countyValues.length === 1 ? "" : "s"}. This is a county rollup for map continuity, not a publisher-issued statewide estimate.`;
    }
}
export function applyNationalReadingPolicy(states: NationalStateReading[], details: NationalDetailReading[], signal: SignalDefinition, period: string | null, now: Date) {
    const applyFreshness = signal.defaultEvidence !== "planning";
    const staleDetails = applyFreshness && applyStaleFallback(details, period, now);
    const staleStates = applyFreshness && applyStaleFallback(states, period, now);
    applyCountyStateAverages(states, details, signal);
    const staleAggregates = applyFreshness && applyStaleFallback(states, period, now);
    if (signal.id === "b-miyamotoi-presence") {
        for (const reading of [...states, ...details])
            reading.comparisonEligible = false;
    }
    return staleDetails || staleStates || staleAggregates || states.some((state) => state.isStale);
}
