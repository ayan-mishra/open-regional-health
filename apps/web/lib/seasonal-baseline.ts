import "server-only";
import { readBakedHistoryMonth, historyPeriods } from "@/lib/history-store";
import type { SignalId } from "@/lib/signal-catalog";
import type { IncludedStateCode } from "@/lib/us-geography";
const MAX_CACHED_MONTHS = 240;
const monthValues = new Map<string, Map<string, number> | null>();
const pendingMonths = new Map<string, Promise<Map<string, number> | null>>();
async function stateValuesFor(signalId: SignalId, period: string): Promise<Map<string, number> | null> {
    const key = `${signalId}:${period}`;
    const cached = monthValues.get(key);
    if (cached !== undefined)
        return cached;
    const pending = pendingMonths.get(key);
    if (pending)
        return pending;
    const request = loadStateValues(signalId, period, key).finally(() => pendingMonths.delete(key));
    pendingMonths.set(key, request);
    return request;
}
async function loadStateValues(signalId: SignalId, period: string, key: string) {
    const month = await readBakedHistoryMonth(signalId, period);
    const values = !month || month.absent
        ? null
        : new Map(month.states.filter((state) => state.value !== null).map((state) => [state.code, state.value as number]));
    if (monthValues.size >= MAX_CACHED_MONTHS)
        monthValues.delete(monthValues.keys().next().value as string);
    monthValues.set(key, values);
    return values;
}
export function clearSeasonalBaselineCache() {
    monthValues.clear();
}
export type SeasonalBaseline = {
    value: number;
    years: number;
    relative: number;
    months: string[];
};
export function priorYearPeriods(period: string, now = new Date()): string[] {
    const month = period.slice(5, 7);
    const year = Number(period.slice(0, 4));
    const available = new Set(historyPeriods(now));
    const periods: string[] = [];
    for (let earlier = year - 1; earlier >= year - 5; earlier -= 1) {
        const candidate = `${earlier}-${month}`;
        if (available.has(candidate))
            periods.push(candidate);
    }
    return periods;
}
export async function seasonalBaseline(signalId: SignalId, stateCodes: readonly IncludedStateCode[], current: number | null, period = new Date().toISOString().slice(0, 7), now = new Date()): Promise<SeasonalBaseline | null> {
    if (current === null || !stateCodes.length)
        return null;
    const wanted = new Set<string>(stateCodes);
    const monthlyMeans: number[] = [];
    const months: string[] = [];
    for (const priorPeriod of priorYearPeriods(period, now)) {
        const byState = await stateValuesFor(signalId, priorPeriod);
        if (!byState)
            continue;
        const values = [...wanted].flatMap((code) => { const value = byState.get(code); return value === undefined ? [] : [value]; });
        if (!values.length)
            continue;
        monthlyMeans.push(values.reduce((sum, value) => sum + value, 0) / values.length);
        months.push(priorPeriod);
    }
    if (!monthlyMeans.length)
        return null;
    const value = monthlyMeans.reduce((sum, mean) => sum + mean, 0) / monthlyMeans.length;
    if (value === 0)
        return null;
    return { value, years: monthlyMeans.length, relative: (current - value) / value, months };
}
export function describeSeasonalBaseline(baseline: SeasonalBaseline | null, unit: string): string | null {
    if (!baseline)
        return null;
    const share = Math.abs(Math.round(baseline.relative * 100));
    const years = `${baseline.years} prior ${baseline.years === 1 ? "year" : "years"}`;
    if (share < 10)
        return `typical for this month against ${years} (${baseline.value.toFixed(2)} ${unit})`;
    return `${share}% ${baseline.relative > 0 ? "above" : "below"} this month's average over ${years} (${baseline.value.toFixed(2)} ${unit})`;
}
