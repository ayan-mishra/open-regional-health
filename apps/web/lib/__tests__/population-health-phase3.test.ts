import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadPhase3 } from "@/lib/population-health-phase3";
import { clearPublisherCache } from "@/lib/publisher-cache";
describe("population-health phase 3", () => {
    afterEach(() => {
        clearPublisherCache();
        vi.unstubAllGlobals();
    });
    it("does not turn a suppressed overdose count into zero", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("vh55-3he6"))
                return { ok: true, json: async () => [] };
            if (url.includes("gb4e-yj24"))
                return { ok: true, json: async () => [{ monthendingdate: "2026-07-31", provisional_drug_overdose: "", data_as_of: "2026-08-20" }] };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase3("MA", null);
        const overdose = result.section.measures.find((measure) => measure.id === "overdose-deaths");
        expect(overdose).toMatchObject({ value: null, displayValue: "Unavailable", status: "partial" });
    });
    it("labels seasonal coverage as stale in a historical brief", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("vh55-3he6"))
                return { ok: true, json: async () => [{ vaccine: "Influenza", geography: "Massachusetts", fips: "25", dimension_type: "Age", dimension: ">=6 months", year_season: "2025-2026", month: "7", coverage_estimate: "42", coverage_estimate_lcl: "40", coverage_estimate_ucl: "44" }] };
            if (url.includes("gb4e-yj24"))
                return { ok: true, json: async () => [] };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase3("MA", null, "2024-01");
        const vaccination = result.section.measures.find((measure) => measure.id === "flu-vaccination");
        expect(vaccination).toMatchObject({ value: 42, status: "stale" });
        expect(vaccination?.note).toContain("not backdated");
    });
    it("uses VaxView's published interval and all-ages state estimate", async () => {
        let vaccinationUrl = "";
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("vh55-3he6")) {
                vaccinationUrl = url;
                return { ok: true, json: async () => [
                        { vaccine: "Influenza", geography_type: "States", geography: "Massachusetts", fips: "25", year_season: "2025-2026", month: "7", dimension_type: "Age", dimension: "18-49 Years", coverage_estimate: "35.1", _95_ci: "33.4 to 36.8" },
                        { vaccine: "Influenza", geography_type: "States", geography: "Massachusetts", fips: "25", year_season: "2025-2026", month: "7", dimension_type: "Age", dimension: ">=6 Months", coverage_estimate: "46.1", _95_ci: "44.5 to 47.7" },
                    ] };
            }
            if (url.includes("gb4e-yj24"))
                return { ok: true, json: async () => [] };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase3("MA", null);
        const vaccination = result.section.measures.find((measure) => measure.id === "flu-vaccination");
        const select = new URL(vaccinationUrl).searchParams.get("$select") ?? "";
        expect(vaccination).toMatchObject({ value: 46.1, confidenceLow: 44.5, confidenceHigh: 47.7 });
        expect(select).toContain("_95_ci");
        expect(select).not.toContain("coverage_estimate_lcl");
        expect(select).not.toContain("coverage_estimate_ucl");
    });
    it("uses VaxView's adult estimate for a county", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("vh55-3he6"))
                return { ok: true, json: async () => [
                        { vaccine: "Influenza", geography_type: "Counties", geography: "Middlesex County", fips: "25017", year_season: "2022", month: "1", dimension_type: "Age", dimension: ">=18 Years", coverage_estimate: "43.8", _95_ci: "41.2 to 46.4" },
                    ] };
            if (url.includes("gb4e-yj24"))
                return { ok: true, json: async () => [] };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase3("MA", "25017");
        const vaccination = result.section.measures.find((measure) => measure.id === "flu-vaccination");
        expect(vaccination).toMatchObject({ value: 43.8, confidenceLow: 41.2, confidenceHigh: 46.4, geographyType: "county", fips: "25017", status: "stale" });
    });
    it("reuses state-bounded CDC responses across county switches", async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("vh55-3he6"))
                return { ok: true, json: async () => [
                        { vaccine: "Influenza", geography: "Middlesex", fips: "25017", year_season: "2025-2026", month: "7", dimension_type: "Age", dimension: ">=18 years", coverage_estimate: "45" },
                        { vaccine: "Influenza", geography: "Suffolk", fips: "25025", year_season: "2025-2026", month: "7", dimension_type: "Age", dimension: ">=18 years", coverage_estimate: "55" },
                    ] };
            if (url.includes("gb4e-yj24"))
                return { ok: true, json: async () => [
                        { st_abbrev: "MA", fips: "25017", monthendingdate: "2026-07-31", provisional_drug_overdose: "12", data_as_of: "2026-08-20" },
                        { st_abbrev: "MA", fips: "25025", monthendingdate: "2026-07-31", provisional_drug_overdose: "34", data_as_of: "2026-08-20" },
                    ] };
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        const middlesex = await loadPhase3("MA", "25017", null, 1000);
        const suffolk = await loadPhase3("MA", "25025", null, 2000);
        expect(middlesex.section.measures.find((measure) => measure.id === "overdose-deaths")).toMatchObject({ value: 12 });
        expect(suffolk.section.measures.find((measure) => measure.id === "overdose-deaths")).toMatchObject({ value: 34 });
        expect(middlesex.section.measures.find((measure) => measure.id === "flu-vaccination")).toMatchObject({ value: 45 });
        expect(suffolk.section.measures.find((measure) => measure.id === "flu-vaccination")).toMatchObject({ value: 55 });
        expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("gb4e-yj24"))).toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("vh55-3he6"))).toHaveLength(1);
    });
    it("labels and orders provisional overdose data as 12-month-ending counts", async () => {
        let overdoseUrl = "";
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("vh55-3he6"))
                return { ok: true, json: async () => [] };
            if (url.includes("gb4e-yj24")) {
                overdoseUrl = url;
                return { ok: true, json: async () => [
                        { monthendingdate: "2026-07-31", provisional_drug_overdose: "120", data_as_of: "2026-08-20" },
                        { monthendingdate: "2026-06-30", provisional_drug_overdose: "116", data_as_of: "2026-08-20" },
                    ] };
            }
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase3("MA", null, null, 7000000);
        const overdose = result.section.measures.find((measure) => measure.id === "overdose-deaths");
        const query = new URL(overdoseUrl);
        expect(overdose?.label).toBe("12-month-ending provisional overdose deaths across state counties");
        expect(overdose?.change?.label).toBe("vs prior 12-month-ending period");
        expect(overdose?.note).toContain("12-month-ending");
        expect(query.searchParams.get("$order")).toBe("monthendingdate DESC");
    });
    it("loads the prior 12-month-ending period for a historical change", async () => {
        let overdoseUrl = "";
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("vh55-3he6"))
                return { ok: true, json: async () => [] };
            if (url.includes("gb4e-yj24")) {
                overdoseUrl = url;
                return { ok: true, json: async () => [
                        { monthendingdate: "2024-01-31T00:00:00.000", provisional_drug_overdose: "120", data_as_of: "2024-03-01T00:00:00.000" },
                        { monthendingdate: "2023-12-31T00:00:00.000", provisional_drug_overdose: "116", data_as_of: "2024-03-01T00:00:00.000" },
                    ] };
            }
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase3("MA", null, "2024-01", 7000000);
        const overdose = result.section.measures.find((measure) => measure.id === "overdose-deaths");
        const where = new URL(overdoseUrl).searchParams.get("$where") ?? "";
        expect(overdose?.change).toMatchObject({ value: 4, label: "vs prior 12-month-ending period" });
        expect(where).toContain("monthendingdate >= '2023-12-01'");
        expect(where).toContain("monthendingdate < '2024-02-01'");
    });
});
