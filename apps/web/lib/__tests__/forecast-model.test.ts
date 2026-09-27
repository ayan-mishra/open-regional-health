import { describe, expect, it } from "vitest";
import { buildWeeklyForecast } from "@/lib/forecast-model";
function weeklySeries(length = 104, value = (index: number) => 1 + index * .02) {
    const start = new Date("2024-01-06T00:00:00Z");
    return Array.from({ length }, (_, index) => {
        const date = new Date(start);
        date.setUTCDate(date.getUTCDate() + index * 7);
        return { date: date.toISOString().slice(0, 10), value: value(index) };
    });
}
describe("weekly forecast ensemble", () => {
    it("publishes calibrated 7-day, 14-day, and 4-week estimates", () => {
        const forecasts = buildWeeklyForecast(weeklySeries());
        expect(forecasts.map((forecast) => forecast.horizonDays)).toEqual([7, 14, 28]);
        expect(forecasts.every((forecast) => forecast.lower >= 0)).toBe(true);
        expect(forecasts[1].upper - forecasts[1].lower).toBeGreaterThanOrEqual(forecasts[0].upper - forecasts[0].lower);
        expect(forecasts[2].upper - forecasts[2].lower).toBeGreaterThanOrEqual(forecasts[1].upper - forecasts[1].lower);
    });
    it("rejects undersized and recently gapped series", () => {
        expect(buildWeeklyForecast(weeklySeries(63))).toEqual([]);
        const gapped = weeklySeries();
        gapped[90] = { ...gapped[90], date: "2026-02-20" };
        expect(buildWeeklyForecast(gapped)).toEqual([]);
    });
    it("never produces negative estimates or bounds", () => {
        const forecasts = buildWeeklyForecast(weeklySeries(104, (index) => Math.max(0, 10 - index * .2)));
        expect(forecasts.every((forecast) => forecast.value >= 0 && forecast.lower >= 0)).toBe(true);
    });
    it("evaluates intervals on later outcomes, never on their calibration residuals", () => {
        const estimates = buildWeeklyForecast(weeklySeries(156));
        expect(estimates).toHaveLength(3);
        for (const estimate of estimates) {
            expect(estimate.diagnostics?.intervalEvaluationOrigins).toBeGreaterThanOrEqual(12);
            expect(estimate.diagnostics?.modelVersion).toBe("adaptive-ensemble-v2");
            expect(estimate.diagnostics?.backtestOrigins).toBeGreaterThan(estimate.diagnostics?.intervalEvaluationOrigins ?? 0);
        }
    });
    it("beats persistence on sustained trends and seasonal series", () => {
        for (const points of [weeklySeries(156), weeklySeries(208, (i) => 10 + 5 * Math.sin(2 * Math.PI * i / 52))]) {
            const forecast = buildWeeklyForecast(points).find((entry) => entry.horizonDays === 28)!;
            expect(forecast.skillVsPersistence).toBeGreaterThan(0);
            expect(forecast.diagnostics?.weights).toBeDefined();
        }
    });
    it("rejects invalid dates and daily observations masquerading as weekly history", () => {
        const invalid = weeklySeries();
        invalid[50].date = "2024-02-30";
        expect(buildWeeklyForecast(invalid)).toEqual([]);
        const daily = weeklySeries().map((p, i) => ({ ...p, date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10) }));
        expect(buildWeeklyForecast(daily)).toEqual([]);
    });
});
it("respects physical percentage bounds during fitting and interval evaluation", () => {
    const forecasts = buildWeeklyForecast(weeklySeries(156, (i) => 90 + i * .06), { upperBound: 100 });
    expect(forecasts).toHaveLength(3);
    expect(forecasts.every((f) => f.value <= 100 && f.upper <= 100)).toBe(true);
    expect(buildWeeklyForecast(weeklySeries(104, () => 101), { upperBound: 100 })).toEqual([]);
});
