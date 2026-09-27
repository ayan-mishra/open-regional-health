import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadPhase1 } from "@/lib/population-health-phase1";
import { clearPublisherCache } from "@/lib/publisher-cache";
describe("population-health phase 1", () => {
    it("starts PLACES while the independent ACS request is still pending", async () => {
        vi.stubEnv("CENSUS_API_KEY", "test-key");
        let finishAcs!: (value: unknown) => void;
        const acs = new Promise((resolve) => { finishAcs = resolve; });
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            if (String(input).includes("api.census.gov"))
                return acs;
            return { ok: true, json: async () => [], text: async () => "" };
        });
        vi.stubGlobal("fetch", fetchMock);
        const request = loadPhase1("MA", null);
        try {
            await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("data.cdc.gov"))).toBe(true));
        }
        finally {
            finishAcs({ ok: true, json: async () => [] });
            await request;
        }
    });
    afterEach(() => {
        clearPublisherCache();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });
    it("bounds the Census ACS request to three seconds", async () => {
        vi.stubEnv("CENSUS_API_KEY", "test-key");
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => realTimeout(ms));
        let acsInit: RequestInit | undefined;
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("api.census.gov")) {
                acsInit = init;
                return { ok: true, json: async () => [["NAME", "B17001_001E", "B17001_002E", "B23025_003E", "B23025_005E"], ["Massachusetts", "1000000", "100000", "500000", "50000"]] };
            }
            if (url.includes("svi.cdc.gov"))
                return { ok: true, text: async () => "FIPS,RPL_THEMES\n25,0.5\n" };
            if (url.includes("www2.census.gov"))
                return { ok: true, text: async () => "STATE,COUNTY,POPESTIMATE2025\n25,000,7000000\n" };
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [] };
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        await loadPhase1("MA", null);
        expect(timeoutSpy).toHaveBeenCalledWith(3000);
        expect(acsInit?.signal).toBeInstanceOf(AbortSignal);
        expect(timeoutSpy.mock.results.map((result) => result.value)).toContain(acsInit?.signal);
    });
    it("does not call the ACS API without its required server-side key", async () => {
        vi.stubEnv("CENSUS_API_KEY", "");
        let acsRequested = false;
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("api.census.gov")) {
                acsRequested = true;
                throw new Error("ACS should not be requested without a key");
            }
            if (url.includes("svi.cdc.gov"))
                return { ok: true, text: async () => "FIPS,RPL_THEMES\n25,0.5\n" };
            if (url.includes("www2.census.gov"))
                return { ok: true, text: async () => "STATE,COUNTY,POPESTIMATE2025\n25,000,7000000\n" };
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [] };
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        const result = await loadPhase1("MA", null);
        const acs = result.section.measures.find((measure) => measure.id === "acs-poverty");
        expect(acsRequested).toBe(false);
        expect(acs).toBeUndefined();
        expect(result.section.measures.find((measure) => measure.id === "census-acs")).toMatchObject({ value: null, status: "unavailable" });
        expect(result.errors).toContainEqual(expect.objectContaining({ source: "U.S. Census Bureau ACS", message: expect.stringMatching(/API key is not configured/i) }));
    });
    it("does not treat a blank county identifier as the statewide Census row", async () => {
        vi.stubEnv("CENSUS_API_KEY", "");
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("svi.cdc.gov"))
                return { ok: true, text: async () => "FIPS,RPL_THEMES\n" };
            if (url.includes("www2.census.gov"))
                return { ok: true, text: async () => "STATE,COUNTY,POPESTIMATE2025\n25,,123\n" };
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [] };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase1("MA", null);
        expect(result.section.measures.find((measure) => measure.id === "population")).toBeUndefined();
        expect(result.section.measures.find((measure) => measure.id === "census-population")).toMatchObject({ value: null, status: "unavailable" });
    });
    it("loads one crude PLACES estimate by the publisher's measure identifier", async () => {
        let placesUrl = "";
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("api.census.gov")) {
                return { ok: true, json: async () => [
                        ["NAME", "B01001_001E", "B17001_001E", "B17001_002E", "B23025_003E", "B23025_005E", "state", "county"],
                        ["Middlesex County", "1600000", "1600000", "120000", "900000", "36000", "25", "017"],
                    ] };
            }
            if (url.includes("svi.cdc.gov"))
                return { ok: true, text: async () => "FIPS,RPL_THEMES,RPL_THEME1,RPL_THEME2,RPL_THEME3,RPL_THEME4\n25017,0.5,0.4,0.3,0.2,0.1\n" };
            if (url.includes("www2.census.gov"))
                return { ok: true, text: async () => "STATE,COUNTY,POPESTIMATE2025\n25,017,1600000\n" };
            if (url.includes("swc5-untb")) {
                placesUrl = url;
                return { ok: true, json: async () => [
                        { locationname: "Middlesex", locationid: "25017", measureid: "MHLTH", measure: "Frequent mental distress among adults", short_question_text: "Frequent mental distress", datavaluetypeid: "AgeAdjPrv", data_value: "15.9", year: "2023", data_value_unit: "%", low_confidence_limit: "15.1", high_confidence_limit: "16.7" },
                        { locationname: "Middlesex", locationid: "25017", measureid: "MHLTH", measure: "Frequent mental distress among adults", short_question_text: "Frequent mental distress", datavaluetypeid: "CrdPrv", data_value: "14.2", year: "2023", data_value_unit: "%", low_confidence_limit: "13.4", high_confidence_limit: "15.0" },
                    ] };
            }
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase1("MA", "25017");
        const places = result.section.measures.filter((measure) => measure.id.startsWith("places-"));
        const query = new URL(placesUrl);
        expect(places).toEqual([expect.objectContaining({ id: "places-mhlth-25017", value: 14.2, confidenceLow: 13.4, confidenceHigh: 15 })]);
        expect(query.searchParams.get("$select")).toContain("measureid");
        expect(query.searchParams.get("$select")).toContain("datavaluetypeid");
        expect(query.searchParams.get("$where")).toContain("measureid in");
        expect(query.searchParams.get("$where")).toContain("datavaluetypeid='CrdPrv'");
    });
    it("reuses one state ACS response without leaking the first selected county", async () => {
        vi.stubEnv("CENSUS_API_KEY", "test-key");
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("api.census.gov"))
                return { ok: true, json: async () => [
                        ["NAME", "B01001_001E", "B17001_001E", "B17001_002E", "B23025_003E", "B23025_005E", "state", "county"],
                        ["Middlesex County", "1000", "1000", "100", "600", "30", "25", "017"],
                        ["Suffolk County", "2000", "2000", "400", "1200", "120", "25", "025"],
                    ] };
            if (url.includes("svi.cdc.gov"))
                return { ok: true, text: async () => "FIPS,RPL_THEMES\n25017,0.5\n25025,0.6\n" };
            if (url.includes("www2.census.gov"))
                return { ok: true, text: async () => "STATE,COUNTY,POPESTIMATE2025\n25,017,1000\n25,025,2000\n" };
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [
                        { locationid: "25017", measureid: "MHLTH", short_question_text: "Mental health", datavaluetypeid: "CrdPrv", data_value: "10", year: "2025", data_value_unit: "%" },
                        { locationid: "25025", measureid: "MHLTH", short_question_text: "Mental health", datavaluetypeid: "CrdPrv", data_value: "20", year: "2024", data_value_unit: "%" },
                    ] };
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        const middlesex = await loadPhase1("MA", "25017");
        const suffolk = await loadPhase1("MA", "25025");
        expect(middlesex.section.measures.find((measure) => measure.id === "acs-poverty")).toMatchObject({ fips: "25017", value: 10 });
        expect(suffolk.section.measures.find((measure) => measure.id === "acs-poverty")).toMatchObject({ fips: "25025", value: 20 });
        expect(middlesex.section.measures.find((measure) => measure.id === "places-mhlth-25017")).toMatchObject({ value: 10 });
        expect(suffolk.section.measures.find((measure) => measure.id === "places-mhlth-25025")).toMatchObject({ value: 20 });
        expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("api.census.gov"))).toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("data.cdc.gov"))).toHaveLength(1);
    });
    it("rejects CDC and Census sentinel values from nonnegative measures", async () => {
        vi.stubEnv("CENSUS_API_KEY", "test-key");
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("api.census.gov")) {
                return { ok: true, json: async () => [
                        ["NAME", "B01001_001E", "B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E", "B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E", "B17001_001E", "B17001_002E", "B23025_003E", "B23025_005E", "state", "county"],
                        ["Middlesex County", "1600000", "100000", "100000", "100000", "100000", "100000", "100000", "100000", "100000", "1600000", "-666666666", "900000", "36000", "25", "017"],
                    ] };
            }
            if (url.includes("svi.cdc.gov"))
                return { ok: true, text: async () => "FIPS,RPL_THEMES,RPL_THEME1,RPL_THEME2,RPL_THEME3,RPL_THEME4\n25017,-999,-999,-999,-999,-999\n" };
            if (url.includes("www2.census.gov"))
                return { ok: true, text: async () => "STATE,COUNTY,POPESTIMATE2025\n25,017,1600000\n" };
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [] };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase1("MA", "25017");
        expect(result.section.measures.find((measure) => measure.id === "social-vulnerability")).toMatchObject({ value: null, status: "unavailable" });
        expect(result.section.measures.find((measure) => measure.id === "acs-poverty")).toMatchObject({ value: null, displayValue: "Unavailable" });
    });
    it("marks latest baseline releases stale in a historical brief", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("api.census.gov"))
                return { ok: true, json: async () => [["NAME", "B01001_001E", "B17001_001E", "B17001_002E", "B23025_003E", "B23025_005E"], ["Massachusetts", "7000000", "7000000", "700000", "4000000", "160000"]] };
            if (url.includes("svi.cdc.gov"))
                return { ok: true, text: async () => "FIPS,RPL_THEMES,RPL_THEME1,RPL_THEME2,RPL_THEME3,RPL_THEME4\n25017,0.5,0.4,0.3,0.2,0.1\n" };
            if (url.includes("www2.census.gov"))
                return { ok: true, text: async () => "STATE,COUNTY,POPESTIMATE2025\n25,000,7000000\n25,017,1600000\n" };
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [{ locationid: "25017", measureid: "MHLTH", measure: "Frequent mental distress", short_question_text: "Frequent mental distress", datavaluetypeid: "CrdPrv", data_value: "14", year: "2023", data_value_unit: "%" }] };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase1("MA", null, "2020-01");
        const published = result.section.measures.filter((measure) => measure.value !== null);
        expect(published.length).toBeGreaterThan(0);
        expect(published.every((measure) => measure.status === "stale")).toBe(true);
        expect(published.every((measure) => measure.note.includes("not backdated"))).toBe(true);
    });
    it("keeps an unavailable state SVI measure at state geography", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("api.census.gov"))
                return { ok: true, json: async () => [["NAME"], ["Massachusetts"]] };
            if (url.includes("svi.cdc.gov"))
                return { ok: true, text: async () => "FIPS,RPL_THEMES,RPL_THEME1,RPL_THEME2,RPL_THEME3,RPL_THEME4\n25017,-999,-999,-999,-999,-999\n" };
            if (url.includes("www2.census.gov"))
                return { ok: true, text: async () => "STATE,COUNTY,POPESTIMATE2025\n25,000,7000000\n25,017,1600000\n" };
            if (url.includes("data.cdc.gov"))
                return { ok: true, json: async () => [] };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase1("MA", null);
        expect(result.section.measures.find((measure) => measure.id === "social-vulnerability")).toMatchObject({ status: "unavailable", geographyType: "state" });
    });
});
