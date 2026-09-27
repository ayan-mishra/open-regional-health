import { describe, expect, it } from "vitest";
import type { NationalDetailReading, NationalStateReading } from "@/lib/national-contracts";
import { applyCountyStateAverages, applyNationalReadingPolicy, applyStaleFallback } from "@/lib/national-reading-policy";
import { SIGNAL_BY_ID } from "@/lib/signal-catalog";
function state(overrides: Partial<NationalStateReading> = {}): NationalStateReading {
    return { code: "MA", name: "Massachusetts", value: null, displayValue: "No comparable data", observedThrough: null, comparisonEligible: false, note: "No statewide release.", ...overrides };
}
function county(id: string, name: string, value: number): NationalDetailReading {
    return { id, name: `${name} County`, stateCode: "MA", geographyType: "county", counties: [name], value, displayValue: `${value} minutes`, observedThrough: "2026-07-30", publisherEligible: true, comparisonEligible: true, stateAggregationEligible: true, note: "County observation." };
}
describe("national reading policy", () => {
    it("fills an unavailable state with an equal-weight mean of viable county observations", () => {
        const states = [state()];
        applyCountyStateAverages(states, [county("MA:1", "Middlesex", 20), county("MA:2", "Suffolk", 40)], SIGNAL_BY_ID["ed-wait"]);
        expect(states[0]).toMatchObject({ value: 30, displayValue: "30.0 minutes", comparisonEligible: true, publisherEligible: true, countyAggregation: { method: "county-mean", countyCount: 2 } });
        expect(states[0].note).toMatch(/not a publisher-issued statewide estimate/i);
    });
    it("does not aggregate county metrics that the connector has not declared unit-compatible", () => {
        const states = [state()];
        const incompatible = { ...county("MA:1", "Middlesex", 20), stateAggregationEligible: false };
        applyCountyStateAverages(states, [incompatible], SIGNAL_BY_ID["covid-ed"]);
        expect(states[0]).toMatchObject({ value: null, comparisonEligible: false });
    });
    it("restores the last viable observation when no newer release arrives within seven days", () => {
        const readings = [state({ value: 2, observedThrough: "2026-07-20", publisherEligible: true })];
        expect(applyStaleFallback(readings, null, new Date("2026-08-03T12:00:00Z"))).toBe(true);
        expect(readings[0]).toMatchObject({ isStale: true, comparisonEligible: true });
        expect(readings[0].note).toBe("No statewide release.");
    });
    it("discloses an old source-invalid reading without making it comparison eligible", () => {
        const readings = [state({ value: 2, observedThrough: "2026-07-20", publisherEligible: false })];
        applyStaleFallback(readings, null, new Date("2026-08-03T12:00:00Z"));
        expect(readings[0]).toMatchObject({ isStale: true, comparisonEligible: false });
    });
    it("does not label an intentionally historical view as stale", () => {
        const readings = [state({ value: 2, observedThrough: "2020-01-31", publisherEligible: true, comparisonEligible: true })];
        expect(applyStaleFallback(readings, "2020-01", new Date("2026-08-03T12:00:00Z"))).toBe(false);
        expect(readings[0].isStale).toBeUndefined();
    });
    it("does not apply the weekly stale rule to planning-context signals", () => {
        const readings = [state({ value: 2, observedThrough: "2023-12-31", publisherEligible: true, comparisonEligible: true })];
        expect(applyNationalReadingPolicy(readings, [], SIGNAL_BY_ID["lyme-cases"], null, new Date("2026-08-03T12:00:00Z"))).toBe(false);
        expect(readings[0].isStale).toBeUndefined();
    });
});
