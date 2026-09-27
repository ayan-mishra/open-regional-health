import type { ForecastObservation } from "@/lib/forecast-contracts";
export type RatioBasis = {
    numerator: number;
    denominator: number;
    scale: number;
    denominatorVintage: string;
};
export type RegionalInput = {
    value: number | null;
    observedThrough: string | null;
    comparisonEligible: boolean;
    isStale?: boolean;
    ratioBasis?: RatioBasis;
};
export type RegionalAggregation = {
    value: number | null;
    observedThrough: string | null;
    method: "single" | "pooled-rate" | "constituent-mean" | "maximum" | "unavailable";
    reporting: number;
    total: number;
    note: string;
};
export function aggregateRegionalReadings(readings: RegionalInput[], total: number): RegionalAggregation {
    const eligible = readings.filter((r) => r.comparisonEligible && !r.isStale && r.value !== null && Number.isFinite(r.value) && r.observedThrough);
    const dates = [...new Set(eligible.map((r) => r.observedThrough!))];
    const unavailable: RegionalAggregation = { value: null, observedThrough: null, method: "unavailable", reporting: eligible.length, total, note: "No aligned evidence for the selected geography. Missing values are not zero." };
    if (!eligible.length || dates.length !== 1)
        return { ...unavailable, note: dates.length > 1 ? "Observation periods differ. Read the constituent values separately." : unavailable.note };
    const common = { observedThrough: dates[0], reporting: eligible.length, total };
    if (eligible.length === 1)
        return { ...common, value: eligible[0].value, method: "single", note: `Published value for ${eligible.length} of ${total} selected places; not an estimate for missing places.` };
    const bases = eligible.map((r) => r.ratioBasis);
    const first = bases[0];
    if (first && bases.every((b) => b && Number.isFinite(b.numerator) && b.numerator >= 0 && Number.isFinite(b.denominator) && b.denominator > 0 && b.scale === first.scale && b.denominatorVintage === first.denominatorVintage) && Number.isFinite(first.scale) && first.scale > 0) {
        return { ...common, value: bases.reduce((sum, b) => sum + b!.numerator, 0) / bases.reduce((sum, b) => sum + b!.denominator, 0) * first.scale,
            method: "pooled-rate", note: `Pooled numerator / denominator across ${eligible.length} of ${total} places; denominator vintage ${first.denominatorVintage}.` };
    }
    return { ...common, value: eligible.reduce((sum, r) => sum + r.value!, 0) / eligible.length, method: "constituent-mean",
        note: `Unweighted mean of ${eligible.length} of ${total} constituent readings, not a population rate or regional burden estimate. Denominators are unavailable or incompatible.` };
}
export function alignedRegionalSeries(series: ForecastObservation[][]): ForecastObservation[] {
    if (!series.length || series.some((points) => !points.length))
        return [];
    if (new Set(series.map((points) => points.at(-1)!.date)).size !== 1)
        return [];
    const maps = series.map((points) => new Map(points.map((p) => [p.date, p.value])));
    return [...maps[0]].flatMap(([date]) => {
        const values = maps.map((map) => map.get(date));
        return values.every((v) => v !== undefined && Number.isFinite(v)) ? [{ date, value: values.reduce<number>((sum, v) => sum + v!, 0) / values.length }] : [];
    }).sort((a, b) => a.date.localeCompare(b.date));
}
