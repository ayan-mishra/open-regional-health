import { afterEach, describe, expect, it, vi } from "vitest";
import type { NationalOutlookResponse } from "@/lib/national-contracts";
import type { PopulationMeasure } from "@/lib/population-health-contracts";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/national-live", () => ({ getBakedNationalOutlook: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/national-forecast-live", () => ({ getBakedNationalForecast: vi.fn().mockResolvedValue(null) }));
const mocks = vi.hoisted(() => ({ outlook: vi.fn(), forecast: vi.fn() }));
vi.mock("@/lib/server-public-snapshot", () => ({ getCachedServerOutlookSnapshot: mocks.outlook, getCachedServerForecastSnapshot: mocks.forecast }));
import { getBakedNationalOutlook } from "@/lib/national-live";
afterEach(() => { vi.mocked(getBakedNationalOutlook).mockReset().mockResolvedValue(null); });
import { buildPopulationIntelligence } from "@/lib/population-health-intelligence";
function measure(id: string, value: number | null): PopulationMeasure {
    return { id, label: id, category: id === "hpsa-primary-care" ? "access" : "baseline", geographyType: "state", value, displayValue: value === null ? "Unavailable" : String(value), unit: "%", vintage: "2026", period: "2026", cadence: "Annual", estimateType: "observed", status: value === null ? "unavailable" : "current", source: "Test", sourceUrl: "https://example.com", note: "Test measure" };
}
describe("population health intelligence", async () => {
    it("turns comparable state pressure and local context into bounded review prompts", async () => {
        const outlook = {
            states: [
                { code: "MA", name: "Massachusetts", value: 90, displayValue: "90", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
                { code: "CT", name: "Connecticut", value: 10, displayValue: "10", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
                { code: "RI", name: "Rhode Island", value: 20, displayValue: "20", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
                { code: "NY", name: "New York", value: 30, displayValue: "30", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
                { code: "VT", name: "Vermont", value: 40, displayValue: "40", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
            ],
        } as NationalOutlookResponse;
        mocks.outlook.mockImplementation((id: string) => id === "covid-ed" ? outlook : undefined);
        mocks.forecast.mockReturnValue(undefined);
        const result = await buildPopulationIntelligence({
            stateCode: "MA",
            countyFips: null,
            period: null,
            sections: [{ id: "baseline", title: "Baseline", description: "Test", measures: [measure("social-vulnerability", 80)] }, { id: "access", title: "Access", description: "Test", measures: [measure("hpsa-primary-care", 1)] }, { id: "prevention", title: "Prevention", description: "Test", measures: [] }, { id: "resilience", title: "Resilience", description: "Test", measures: [] }],
        });
        expect(result.signals[0]).toMatchObject({ id: "covid-ed", evidence: "observed", pressurePercentile: 100 });
        expect(result.insights.map((insight) => insight.id)).toEqual(expect.arrayContaining(["signal-covid-ed", "social-vulnerability", "care-access"]));
        expect(result.coverage).toMatchObject({ available: 2, total: 2 });
    });
    it("uses prepared observations on a cold server without ranking delayed evidence", async () => {
        mocks.outlook.mockReturnValue(undefined);
        mocks.forecast.mockReturnValue(undefined);
        vi.mocked(getBakedNationalOutlook).mockImplementation(async ({ signalId }) => signalId === "covid-ed" ? { states: [{ code: "MA", value: .12, displayValue: "0.12%", observedThrough: "2026-09-12", comparisonEligible: true, isStale: true }] } as NationalOutlookResponse : null);
        const result = await buildPopulationIntelligence({ stateCode: "MA", countyFips: null, period: null, sections: [] });
        expect(result.signals).toContainEqual(expect.objectContaining({ id: "covid-ed", value: .12, observedThrough: "2026-09-12", status: "stale", pressurePercentile: null }));
        expect(result.insights).toEqual([]);
    });
    it("does not rank or flag a state excluded from the comparison set", async () => {
        const outlook = {
            states: [
                { code: "MA", name: "Massachusetts", value: 90, displayValue: "90", observedThrough: "2026-08-20", comparisonEligible: false, note: "Insufficient coverage" },
                { code: "CT", name: "Connecticut", value: 10, displayValue: "10", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
                { code: "RI", name: "Rhode Island", value: 20, displayValue: "20", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
                { code: "NY", name: "New York", value: 30, displayValue: "30", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
                { code: "VT", name: "Vermont", value: 40, displayValue: "40", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
                { code: "NH", name: "New Hampshire", value: 50, displayValue: "50", observedThrough: "2026-08-20", comparisonEligible: true, note: "Comparable" },
            ],
        } as NationalOutlookResponse;
        mocks.outlook.mockImplementation((id: string) => id === "covid-ed" ? outlook : undefined);
        mocks.forecast.mockReturnValue(undefined);
        const result = await buildPopulationIntelligence({ stateCode: "MA", countyFips: null, period: null, sections: [] });
        expect(result.signals[0]).toMatchObject({ id: "covid-ed", status: "partial", pressurePercentile: null });
        expect(result.insights).not.toContainEqual(expect.objectContaining({ id: "signal-covid-ed" }));
    });
    it("keeps a statewide fallback signal statewide in a county brief", async () => {
        mocks.outlook.mockReturnValue(undefined);
        const heat = { ...measure("heat-risk", 3), label: "HeatRisk", category: "environment" as const, geographyType: "state" as const, period: "2026-08-20" };
        const result = await buildPopulationIntelligence({ stateCode: "MA", countyFips: "25017", period: null, sections: [{ id: "environment", title: "Environment", description: "Test", measures: [heat] }] });
        expect(result.signals[0]).toMatchObject({ id: "heatrisk", geographyType: "state", stateCode: "MA" });
        expect(result.signals[0]).not.toHaveProperty("fips");
    });
    it("does not turn a publisher label into an observed date", async () => {
        mocks.outlook.mockReturnValue(undefined);
        const heat = { ...measure("heat-risk", null), label: "HeatRisk", category: "environment" as const, geographyType: "state" as const, period: "", vintage: "Current seven-day outlook" };
        const result = await buildPopulationIntelligence({ stateCode: "MA", countyFips: null, period: "2024-01", sections: [{ id: "environment", title: "Environment", description: "Test", measures: [heat] }] });
        expect(result.signals[0]?.observedThrough).toBeNull();
    });
    it("reports unavailable signal context instead of claiming no pressure flags", async () => {
        mocks.outlook.mockReturnValue(undefined);
        const heat = { ...measure("heat-risk", null), label: "HeatRisk", category: "environment" as const, geographyType: "state" as const, period: "", vintage: "Current seven-day outlook" };
        const result = await buildPopulationIntelligence({ stateCode: "MA", countyFips: null, period: null, sections: [{ id: "environment", title: "Environment", description: "Test", measures: [heat] }] });
        expect(result.summary).toContain("unavailable");
        expect(result.summary).not.toContain("No high-pressure flags");
    });
    it("describes provisional overdose data as 12-month-ending totals", async () => {
        mocks.outlook.mockReturnValue(undefined);
        const overdose = {
            ...measure("overdose-deaths", 123),
            category: "prevention" as const,
            displayValue: "123",
            trend: "worsening" as const,
            change: { value: 12, displayValue: "+12", label: "vs prior 12-month-ending period", period: "2025" },
        };
        const result = await buildPopulationIntelligence({ stateCode: "MA", countyFips: null, period: null, sections: [{ id: "prevention", title: "Prevention", description: "Test", measures: [overdose] }] });
        expect(result.insights).toContainEqual(expect.objectContaining({
            id: "overdose-trend",
            title: "12-month-ending provisional overdose deaths increased",
            summary: "123 is +12 compared with the prior 12-month-ending period; the total remains provisional.",
        }));
    });
    it("uses the correct ordinal suffix for vulnerability percentiles", async () => {
        mocks.outlook.mockReturnValue(undefined);
        const vulnerability = { ...measure("social-vulnerability", 81), displayValue: "81st percentile" };
        const result = await buildPopulationIntelligence({ stateCode: "MA", countyFips: null, period: null, sections: [{ id: "baseline", title: "Baseline", description: "Test", measures: [vulnerability] }] });
        expect(result.insights).toContainEqual(expect.objectContaining({
            id: "social-vulnerability",
            summary: expect.stringContaining("81st SVI percentile"),
        }));
    });
});
