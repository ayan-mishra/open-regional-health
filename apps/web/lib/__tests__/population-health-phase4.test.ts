import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/national-live", () => ({ getBakedNationalOutlook: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/national-forecast-live", () => ({ getBakedNationalForecast: vi.fn().mockResolvedValue(null) }));
import { loadPhase4 } from "@/lib/population-health-phase4";
import { clearPublisherCache } from "@/lib/publisher-cache";
describe("population-health phase 4", () => {
    afterEach(() => {
        clearPublisherCache();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
    it("preserves a valid zero when NOAA reports no active alerts", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [] };
            if (url.includes("api.weather.gov"))
                return { ok: true, json: async () => ({ features: [] }) };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase4("MA", null);
        const hazard = result.section.measures.find((measure) => measure.id === "hazard-exposure");
        expect(hazard).toMatchObject({ value: 0, displayValue: "0", status: "current" });
    });
    it("does not turn missing outbreak illness counts into zero", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [{ year: "2026", month: "7", illnesses: "" }] };
            if (url.includes("api.weather.gov"))
                return { ok: true, json: async () => ({ features: [] }) };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase4("MA", null);
        const outbreaks = result.section.measures.find((measure) => measure.id === "nors-events");
        expect(outbreaks).toMatchObject({ value: null, displayValue: "Unavailable", status: "partial" });
    });
    it("bounds the NWS active-alerts request to three seconds", async () => {
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => realTimeout(ms));
        let nwsInit: RequestInit | undefined;
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [] };
            if (url.includes("api.weather.gov")) {
                nwsInit = init;
                return { ok: true, json: async () => ({ features: [] }) };
            }
            throw new Error(`Unexpected request: ${url}`);
        }));
        await loadPhase4("MA", null);
        expect(timeoutSpy).toHaveBeenCalledWith(3000);
        expect(nwsInit?.signal).toBeInstanceOf(AbortSignal);
        expect(timeoutSpy.mock.results.map((result) => result.value)).toContain(nwsInit?.signal);
    });
    it("aggregates and orders NORS months at the publisher boundary", async () => {
        const norsUrls: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("5xkq-dg7x")) {
                norsUrls.push(url);
                const select = new URL(url).searchParams.get("$select") ?? "";
                return select.includes("count(illnesses)")
                    ? { ok: true, json: async () => [{ year: "2023", month: "12", illness_records: "3", death_records: "3" }, { year: "2023", month: "11", illness_records: "2", death_records: "2" }] }
                    : { ok: true, json: async () => [{ year: "2023", month: "12", events: "3", illnesses: "18", deaths: "1" }, { year: "2023", month: "11", events: "2", illnesses: "9", deaths: "0" }] };
            }
            if (url.includes("api.weather.gov"))
                return { ok: true, json: async () => ({ features: [] }) };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase4("MA", null);
        const outbreaks = result.section.measures.find((measure) => measure.id === "nors-events");
        const queries = norsUrls.map((url) => new URL(url));
        expect(outbreaks).toMatchObject({ value: 18, change: { value: 9 } });
        expect(queries.map((query) => query.searchParams.get("$select"))).toEqual(expect.arrayContaining([
            "year,month,count(*) as events,sum(illnesses) as illnesses,sum(deaths) as deaths",
            "year,month,count(illnesses) as illness_records,count(deaths) as death_records",
        ]));
        expect(queries).toHaveLength(2);
        expect(queries.every((query) => query.searchParams.get("$group") === "year,month")).toBe(true);
        expect(queries.every((query) => query.searchParams.get("$order") === "year DESC,month DESC")).toBe(true);
    });
    it("treats a malformed NOAA success payload as unavailable", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [] };
            if (url.includes("api.weather.gov"))
                return { ok: true, json: async () => ({}) };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase4("MA", null);
        const hazard = result.section.measures.find((measure) => measure.id === "hazard-exposure");
        expect(hazard).toMatchObject({ value: null, status: "unavailable" });
        expect(result.errors).toContainEqual({ source: "NOAA/NWS", message: "The publisher response could not be read." });
    });
    it("marks an incomplete NORS aggregate partial instead of presenting a complete total", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("data.cdc.gov"))
                return new URL(url).searchParams.get("$select")?.includes("count(illnesses)")
                    ? { ok: true, json: async () => [{ year: "2026", month: "7", illness_records: "2", death_records: "1" }] }
                    : { ok: true, json: async () => [{ year: "2026", month: "7", events: "3", illnesses: "18", deaths: "1" }] };
            if (url.includes("api.weather.gov"))
                return { ok: true, json: async () => ({ features: [] }) };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase4("MA", null);
        const illnesses = result.section.measures.find((measure) => measure.id === "nors-events");
        const deaths = result.section.measures.find((measure) => measure.id === "nors-deaths");
        expect(illnesses).toMatchObject({ value: 18, status: "partial" });
        expect(illnesses?.note).toContain("1 event omits illness counts");
        expect(deaths).toMatchObject({ value: 1, status: "partial" });
    });
    it("marks an old latest NORS month stale in a current brief", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("data.cdc.gov"))
                return new URL(url).searchParams.get("$select")?.includes("count(illnesses)")
                    ? { ok: true, json: async () => [{ year: "2023", month: "12", illness_records: "1", death_records: "1" }] }
                    : { ok: true, json: async () => [{ year: "2023", month: "12", events: "1", illnesses: "4", deaths: "0" }] };
            if (url.includes("api.weather.gov"))
                return { ok: true, json: async () => ({ features: [] }) };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase4("MA", null);
        expect(result.section.measures.find((measure) => measure.id === "nors-events")).toMatchObject({ status: "stale" });
    });
});
