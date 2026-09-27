import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getCachedServerOutlookSnapshot: vi.fn() }));
vi.mock("@/lib/server-public-snapshot", () => ({ getCachedServerOutlookSnapshot: mocks.getCachedServerOutlookSnapshot }));
import { loadPhase2 } from "@/lib/population-health-phase2";
import { clearPublisherCache } from "@/lib/publisher-cache";
describe("population-health phase 2", () => {
    afterEach(() => {
        clearPublisherCache();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });
    it("queries HRSA by geography and counts unique active designations", async () => {
        const requested: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            requested.push(url);
            if (url.includes("/hpsafind/find"))
                return {
                    ok: true,
                    json: async () => [
                        { StrippedHPSA: "primary-1", hpsa_discipline_desc: "Primary Care", hpsa_status_desc: "Designated", hpsa_population: "100", practitioners_needed_remove: "2.5" },
                        { StrippedHPSA: "primary-1", hpsa_discipline_desc: "Primary Care", hpsa_status_desc: "Designated", hpsa_population: "100", practitioners_needed_remove: "2.5" },
                        { StrippedHPSA: "primary-old", hpsa_discipline_desc: "Primary Care", hpsa_status_desc: "Withdrawn", hpsa_population: "999", practitioners_needed_remove: "99" },
                        { StrippedHPSA: "primary-unknown", hpsa_discipline_desc: "Primary Care", hpsa_status_desc: null, hpsa_population: "777", practitioners_needed_remove: "77" },
                        { StrippedHPSA: "mental-1", hpsa_discipline_desc: "Mental Health", hpsa_status_desc: "Designated", hpsa_population: "80", practitioners_needed_remove: "1.5" },
                    ],
                };
            if (url.includes("MUA_DET.csv"))
                return {
                    ok: true,
                    text: async () => "MUA/P ID,State Abbreviation,County or County Equivalent Federal Information Processing Standard Code,MUA/P Status Description\narea-1,MA,25017,Designated\narea-1,MA,25017,Designated\narea-2,MA,25025,Designated\n",
                };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase2("MA", "25017");
        const measures = new Map(result.section.measures.map((measure) => [measure.id, measure]));
        expect(requested.some((url) => url.includes("/hpsafind/find?state=MA&counties=017&id="))).toBe(true);
        expect(requested.some((url) => url.includes("BCD_HPSA_FCT_DET"))).toBe(false);
        expect(measures.get("hpsa-primary-care")?.value).toBe(1);
        expect(measures.get("hpsa-mental-health")?.value).toBe(1);
        expect(measures.get("hpsa-population")).toMatchObject({ value: 180, label: "Published population across shortage designations" });
        expect(measures.get("hpsa-population")?.note).toContain("not a unique-person count");
        expect(measures.get("hpsa-practitioners-needed")?.value).toBe(4);
        expect(measures.get("mua-p")?.value).toBe(1);
        expect(result.errors).toEqual([]);
    });
    it("bounds the HRSA MUA download to three seconds", async () => {
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => realTimeout(ms));
        let muaInit: RequestInit | undefined;
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("/hpsafind/find"))
                return { ok: true, json: async () => [] };
            if (url.includes("MUA_DET.csv")) {
                muaInit = init;
                return { ok: true, text: async () => "MUA/P ID,State Abbreviation,MUA/P Status Description\n" };
            }
            throw new Error(`Unexpected request: ${url}`);
        }));
        await loadPhase2("MA", null);
        expect(timeoutSpy).toHaveBeenCalledWith(3000);
        expect(muaInit?.signal).toBeInstanceOf(AbortSignal);
        expect(timeoutSpy.mock.results.map((result) => result.value)).toContain(muaInit?.signal);
    });
    it("does not download HRSA's oversized statewide HPSA response", async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("/hpsafind/find"))
                throw new Error("Statewide HPSA should stay bounded");
            if (url.includes("MUA_DET.csv"))
                return { ok: true, text: async () => "MUA/P ID,State Abbreviation,MUA/P Status Description\n" };
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        const result = await loadPhase2("CA", null);
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/hpsafind/find"))).toBe(false);
        expect(result.section.measures.find((measure) => measure.id === "hpsa-primary-care")).toMatchObject({ status: "unavailable", geographyType: "state" });
        expect(result.section.measures.find((measure) => measure.id === "hpsa-primary-care")?.note).toContain("Choose a county");
    });
    it("downloads the nationwide MUA file once and filters each county after the cache", async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("/hpsafind/find"))
                return { ok: true, json: async () => [] };
            if (url.includes("MUA_DET.csv"))
                return {
                    ok: true,
                    text: async () => "MUA/P ID,State Abbreviation,County or County Equivalent Federal Information Processing Standard Code,MUA/P Status Description\narea-1,MA,25017,Designated\narea-2,MA,25025,Designated\n",
                };
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        const middlesex = await loadPhase2("MA", "25017");
        const suffolk = await loadPhase2("MA", "25025");
        expect(middlesex.section.measures.find((measure) => measure.id === "mua-p")?.note).toContain("1 matching records");
        expect(suffolk.section.measures.find((measure) => measure.id === "mua-p")?.note).toContain("1 matching records");
        expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("MUA_DET.csv"))).toHaveLength(1);
    });
    it("marks current HRSA releases stale in a historical brief", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("/hpsafind/find"))
                return { ok: true, json: async () => [{ StrippedHPSA: "primary-1", hpsa_discipline_desc: "Primary Care", hpsa_status_desc: "Designated" }] };
            if (url.includes("MUA_DET.csv"))
                return { ok: true, text: async () => "MUA/P ID,State Abbreviation,County or County Equivalent Federal Information Processing Standard Code,MUA/P Status Description\narea-1,MA,25017,Designated\n" };
            throw new Error(`Unexpected request: ${url}`);
        }));
        const result = await loadPhase2("MA", "25017", "2020-01");
        expect(result.section.measures.find((measure) => measure.id === "hpsa-primary-care")).toMatchObject({ status: "stale" });
        expect(result.section.measures.find((measure) => measure.id === "mua-p")).toMatchObject({ status: "stale" });
        expect(result.section.measures.find((measure) => measure.id === "hpsa-primary-care")?.note).toContain("not backdated");
    });
});
