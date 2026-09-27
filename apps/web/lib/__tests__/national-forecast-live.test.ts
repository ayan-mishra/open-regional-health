import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { clearNationalForecastCache, getForecastProgress, getNationalForecast } from "@/lib/national-forecast-live";
import { clearPublisherCache } from "@/lib/publisher-cache";
import { US_JURISDICTIONS } from "@/lib/us-geography";
afterEach(() => { vi.unstubAllGlobals(); clearPublisherCache(); clearNationalForecastCache(); });
describe("forecast caching", () => {
    it("serves a repeat state-scoped forecast without recomputing it", async () => {
        const fetchMock = vi.fn(async () => Response.json([]));
        vi.stubGlobal("fetch", fetchMock);
        const first = await getNationalForecast({ signalId: "covid-ed", stateCode: "MA", horizon: 7, period: null });
        const callsAfterFirstRequest = fetchMock.mock.calls.length;
        const second = await getNationalForecast({ signalId: "covid-ed", stateCode: "MA", horizon: 7, period: null });
        expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirstRequest);
        expect(second).toBe(first);
    });
    it("runs one computation for concurrent identical forecast requests", async () => {
        const fetchMock = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return Response.json([]);
        });
        vi.stubGlobal("fetch", fetchMock);
        const [first, second] = await Promise.all([
            getNationalForecast({ signalId: "covid-ed", stateCode: "MA", horizon: 14, period: null }),
            getNationalForecast({ signalId: "covid-ed", stateCode: "MA", horizon: 14, period: null }),
        ]);
        expect(second).toBe(first);
    });
    it("hands the event loop back while modelling states", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
        let turns = 0;
        let running = true;
        const spin = () => { if (running) {
            turns += 1;
            setImmediate(spin);
        } };
        setImmediate(spin);
        const forecast = await getNationalForecast({ signalId: "covid-ed", stateCode: "CA", horizon: 7, period: null });
        running = false;
        expect(forecast.states).toHaveLength(US_JURISDICTIONS.length);
        expect(forecast.evidence.kind).not.toBe("none");
        expect(turns).toBeGreaterThanOrEqual(US_JURISDICTIONS.length);
    });
    it("keeps different horizons apart", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
        const seven = await getNationalForecast({ signalId: "covid-ed", stateCode: "MA", horizon: 7, period: null });
        const twentyEight = await getNationalForecast({ signalId: "covid-ed", stateCode: "MA", horizon: 28, period: null });
        expect(seven.horizon).toBe(7);
        expect(twentyEight.horizon).toBe(28);
    });
});
describe("forecast progress tracking", () => {
    it("leaves no progress entry behind after a successful modeled forecast", async () => {
        const start = new Date(Date.UTC(2024, 10, 2));
        const rows = Array.from({ length: 90 }, (_, index) => ({
            week_end: new Date(start.getTime() + index * 7 * 86400000).toISOString().slice(0, 10), geography: "Alabama", hsa_nci_id: "All", trend_source: "State",
            percent_visits_covid: String(.4 + Math.sin(index / 7) * .15 + index * .001), percent_visits_influenza: ".2", percent_visits_rsv: ".1",
        }));
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
        expect(getForecastProgress("covid-ed", "")).toBeNull();
        await getNationalForecast({ signalId: "covid-ed", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(getForecastProgress("covid-ed", "")).toBeNull();
    });
    it("leaves no progress entry behind when the underlying publisher fetch fails", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unreachable"); }));
        const result = await getNationalForecast({ signalId: "covid-ed", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.evidence.kind).toBe("none");
        expect(getForecastProgress("covid-ed", "")).toBeNull();
    });
    it("returns null for a signal/period with nothing in flight", () => {
        expect(getForecastProgress("covid-ed", "2024-03")).toBeNull();
    });
    it("keys progress by state and horizon, not just signal+period", async () => {
        const rows = [{ week_end: "2026-07-25", geography: "Alabama", hsa_nci_id: "All", trend_source: "State", percent_visits_covid: ".4" }];
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
        await getNationalForecast({ signalId: "covid-ed", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(getForecastProgress("covid-ed", "", "AL", 7)).toBeNull();
        expect(getForecastProgress("covid-ed", "", "CA", 7)).toBeNull();
        expect(getForecastProgress("covid-ed", "", "AL", 14)).toBeNull();
    });
});
describe("national forecast service", () => {
    it("builds one-request state forecasts without excluded jurisdictions", async () => {
        const start = new Date(Date.UTC(2024, 10, 2));
        const rows = Array.from({ length: 90 }, (_, index) => ({
            week_end: new Date(start.getTime() + index * 7 * 86400000).toISOString().slice(0, 10), geography: "Alabama", hsa_nci_id: "All", trend_source: "State",
            percent_visits_covid: String(.4 + Math.sin(index / 7) * .15 + index * .001), percent_visits_influenza: ".2", percent_visits_rsv: ".1",
        }));
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
        const result = await getNationalForecast({ signalId: "covid-ed", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.catalog).toHaveLength(40);
        expect(result.states).toHaveLength(49);
        expect(result.states.map((state) => String(state.code)).some((code) => code === "AK" || code === "HI")).toBe(false);
        const alabama = result.states.find((state) => state.code === "AL");
        expect(Boolean(alabama?.estimate)).toBe(alabama?.comparisonEligible);
        expect(["modeled", "planning"]).toContain(result.evidence.kind);
    });
    it("returns useful planning context for every non-modeled catalog signal", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("apyc-v239")
            ? new Response(JSON.stringify({ count: 1, results: [{ state: "AL", score: "149", start_date: "07/01/2024", end_date: "06/30/2025" }] }))
            : new Response(JSON.stringify({ count: 1, results: [{ facility_id: "010001", facility_name: "ALABAMA HOSPITAL", state: "AL", countyparish: "HOUSTON", score: "217", sample: "395", start_date: "07/01/2024", end_date: "06/30/2025" }] }))));
        const result = await getNationalForecast({ signalId: "ed-wait", stateCode: null, horizon: 14, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.evidence.kind).toBe("planning");
        expect(result.states).toHaveLength(49);
        expect(result.signal.label).toBe("Emergency-department length of stay");
    });
    it("does not publish a current forecast from stale observations", async () => {
        const start = new Date(Date.UTC(2020, 0, 4));
        const rows = Array.from({ length: 90 }, (_, index) => ({
            week_end: new Date(start.getTime() + index * 7 * 86400000).toISOString().slice(0, 10), geography: "Alabama", hsa_nci_id: "All", trend_source: "State",
            percent_visits_covid: String(.4 + Math.sin(index / 7) * .15 + index * .001), percent_visits_influenza: ".2", percent_visits_rsv: ".1",
        }));
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
        const result = await getNationalForecast({ signalId: "covid-ed", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.find((state) => state.code === "AL")?.comparisonEligible).toBe(false);
        expect(result.states.find((state) => state.code === "AL")?.estimate).toBeNull();
        expect(result.evidence.kind).toBe("planning");
    });
    it("does not publish a forecast from future-dated publisher observations", async () => {
        const start = new Date(Date.UTC(2024, 10, 16));
        const rows = Array.from({ length: 90 }, (_, index) => ({
            state_territory: "Massachusetts", counties_served: "Middlesex", site: "ID:future",
            week_end: new Date(start.getTime() + index * 7 * 86400000).toISOString().slice(0, 10),
            site_wval: String([1, 4, 2, 5][index % 4]),
        }));
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
        const result = await getNationalForecast({ signalId: "influenza-a-wval", stateCode: "MA", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.details[0].observedThrough).toBe("2026-08-01");
        expect(result.details[0]).toMatchObject({ value: null, comparisonEligible: false, estimate: null });
        expect(result.evidence.kind).toBe("planning");
    });
    it("does not train a hospital forecast from impossible reporting coverage", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
            { weekendingdate: "2026-07-25", jurisdiction: "AL", totalconfflunewadmper100k: "2", totalconfflunewadmperchosprep: "101" },
        ]))));
        const result = await getNationalForecast({ signalId: "influenza-admissions", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.find((state) => state.code === "AL")).toMatchObject({ value: null, comparisonEligible: false, estimate: null });
        expect(result.evidence.kind).toBe("planning");
    });
    it("keeps 60% hospital reporting observations in the forecast history", async () => {
        const start = new Date(Date.UTC(2024, 10, 16));
        const rows = Array.from({ length: 90 }, (_, index) => ({
            weekendingdate: new Date(start.getTime() + index * 7 * 86400000).toISOString().slice(0, 10),
            jurisdiction: "AL",
            totalconfflunewadmper100k: String(1 + index / 100),
            totalconfflunewadmperchosprep: "60",
        }));
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
        const result = await getNationalForecast({ signalId: "influenza-admissions", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.find((state) => state.code === "AL")?.latestObserved).not.toBeNull();
    });
    it("attempts forecasts for every connected NNDSS series and publishes only skilled ones", async () => {
        const rows = [
            ...Array.from({ length: 52 }, (_, index) => ({ states: "Alabama", year: "2025", week: String(index + 1), label: "Pertussis", m1: String(Math.max(0, Math.round(12 + Math.sin(index / 5) * 5))) })),
            ...Array.from({ length: 29 }, (_, index) => ({ states: "Alabama", year: "2026", week: String(index + 1), label: "Pertussis", m1: String(Math.max(0, Math.round(12 + Math.sin((index + 52) / 5) * 5))) })),
        ];
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
        const result = await getNationalForecast({ signalId: "pertussis-cases", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.signal.source).toBe("CDC NNDSS");
        const alabama = result.states.find((state) => state.code === "AL");
        expect(Boolean(alabama?.estimate)).toBe(alabama?.comparisonEligible);
        expect(["modeled", "planning"]).toContain(result.evidence.kind);
    });
    it("retries a transient publisher access denial before marking the forecast unavailable", async () => {
        let attempts = 0;
        vi.stubGlobal("fetch", vi.fn(async () => {
            attempts += 1;
            return attempts === 1 ? new Response("temporarily denied", { status: 403 }) : new Response(JSON.stringify([{ state_territory: "AL", county_fips: "01001", counties_served: "Autauga", site: "site-1", sample_collect_date: "2026-07-20", pcr_target_detect: "yes" }]));
        }));
        const result = await getNationalForecast({ signalId: "measles-detection", stateCode: "AL", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(attempts).toBe(2);
        expect(result.errors).toEqual([]);
        expect(result.status).toBe("current");
        expect(result.evidence.kind).toBe("planning");
    });
    it("keeps wastewater forecasts at reporting-site geography", async () => {
        const start = new Date(Date.UTC(2024, 10, 2));
        const rows = Array.from({ length: 90 }, (_, index) => ({
            state_territory: "Massachusetts", counties_served: "Middlesex; Suffolk", site: "ID:42",
            week_end: new Date(start.getTime() + index * 7 * 86400000).toISOString().slice(0, 10),
            site_wval: String([1, 4, 2, 5][index % 4]),
        }));
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
        const result = await getNationalForecast({ signalId: "influenza-a-wval", stateCode: "MA", horizon: 7, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.every((state) => state.value === null)).toBe(true);
        expect(result.details[0]).toMatchObject({ id: "ID:42", geographyType: "site", counties: ["Middlesex", "Suffolk"] });
        expect(result.details[0].estimate).not.toBeNull();
        expect(["modeled", "planning"]).toContain(result.evidence.kind);
    });
});
