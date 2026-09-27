import { expect, it } from "vitest";
import { aggregateRegionalReadings, alignedRegionalSeries } from "@/lib/regional-math";
const reading = (value: number, denominator = 100) => ({ value, comparisonEligible: true, observedThrough: "2026-08-30", ratioBasis: { numerator: value * denominator / 100, denominator, scale: 100, denominatorVintage: "2025" } });
it("pools denominators rather than averaging rates", () => {
    const result = aggregateRegionalReadings([reading(10, 100), reading(20, 900)], 2);
    expect(result.value).toBe(19);
    expect(result.method).toBe("pooled-rate");
});
it("refuses mixed periods and preserves incomplete coverage", () => {
    expect(aggregateRegionalReadings([reading(10), { ...reading(20), observedThrough: "2026-08-23" }], 2).value).toBeNull();
    expect(aggregateRegionalReadings([reading(10)], 2).reporting).toBe(1);
});
it("builds a fixed-cohort series without filling missing dates", () => {
    const a = [{ date: "2026-08-16", value: 10 }, { date: "2026-08-23", value: 20 }];
    expect(alignedRegionalSeries([a, [{ date: "2026-08-23", value: 40 }]])).toEqual([{ date: "2026-08-23", value: 30 }]);
    expect(alignedRegionalSeries([a, [{ date: "2026-08-16", value: 40 }]])).toEqual([]);
});
