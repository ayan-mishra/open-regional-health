import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const storeDirectory = vi.hoisted(() => {
    const directory = `/tmp/corvid-forecast-store.${process.pid}.${Date.now()}`;
    process.env.CORVID_FORECAST_STORE_DIR = directory;
    return directory;
});
import { rm } from "node:fs/promises";
import { bakeStateForecasts, clearNationalForecastCache, getNationalForecast } from "@/lib/national-forecast-live";
import { readBakedForecastIndex, readBakedStateForecast, writeBakedForecast } from "@/lib/forecast-store";
import { clearPublisherCache } from "@/lib/publisher-cache";
const WEEK_MS = 7 * 86400000;
function nndssRows(scale: Record<string, number>) {
    const rows: Array<Record<string, string>> = [];
    const latest = new Date(Date.now() - WEEK_MS);
    for (const [state, amplitude] of Object.entries(scale)) {
        for (let weeksAgo = 234; weeksAgo >= 1; weeksAgo -= 1) {
            const observed = new Date(latest.getTime() - weeksAgo * WEEK_MS);
            const year = observed.getUTCFullYear();
            const week = Math.floor((observed.getTime() - Date.UTC(year, 0, 4)) / WEEK_MS) + 1;
            if (week < 1 || week > 52)
                continue;
            const seasonal = 1 + Math.sin((week / 52) * Math.PI * 2);
            rows.push({ states: state, year: String(year), week: String(week), label: "Mpox", m1: String(amplitude * (1 + seasonal)) });
        }
    }
    return rows;
}
function stubPublisher(rows: unknown[]) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}
beforeEach(() => { clearPublisherCache(); clearNationalForecastCache(); });
afterEach(async () => {
    vi.unstubAllGlobals();
    clearPublisherCache();
    clearNationalForecastCache();
    await rm(storeDirectory, { recursive: true, force: true });
});
describe("preloaded forecast store", () => {
    it("answers a state-scoped forecast from disk without refitting any model", async () => {
        stubPublisher(nndssRows({ Texas: 40, Massachusetts: 12 }));
        await bakeStateForecasts("mpox-cases");
        const afterBake = stubPublisher([]);
        clearNationalForecastCache();
        const texas = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null });
        expect(afterBake).not.toHaveBeenCalled();
        expect(texas.selectedState).toBe("TX");
        expect(texas.selectedStateName).toBe("Texas");
        expect(texas.states).toHaveLength(49);
        expect(texas.horizon).toBe(28);
    });
    it("gives every state its own evidence rather than repeating the selected one", async () => {
        stubPublisher(nndssRows({ Texas: 40, Massachusetts: 12 }));
        await bakeStateForecasts("mpox-cases");
        const [index, texas, wyoming] = await Promise.all([
            readBakedForecastIndex("mpox-cases"),
            readBakedStateForecast("mpox-cases", "TX"),
            readBakedStateForecast("mpox-cases", "WY"),
        ]);
        expect(index?.states).toHaveLength(49);
        expect(texas?.evidence).toBeDefined();
        expect(wyoming?.evidence.kind).toBe("planning");
        expect(texas?.details.every((detail) => detail.id === "TX")).toBe(true);
    });
    it("serves exactly what a live computation would have returned", async () => {
        stubPublisher(nndssRows({ Texas: 40, Massachusetts: 12, California: 25 }));
        const live = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null, recompute: true });
        await bakeStateForecasts("mpox-cases");
        clearNationalForecastCache();
        const baked = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null });
        expect(baked.evidence).toEqual(live.evidence);
        expect(baked.details).toEqual(live.details);
        expect(baked.states.map((state) => [state.code, state.value, state.comparisonEligible]))
            .toEqual(live.states.map((state) => [state.code, state.value, state.comparisonEligible]));
    });
    it("replaces every state's answer as soon as the publisher has new data", async () => {
        stubPublisher(nndssRows({ Texas: 10 }));
        await bakeStateForecasts("mpox-cases");
        const before = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null });
        clearPublisherCache();
        stubPublisher(nndssRows({ Texas: 90 }));
        await bakeStateForecasts("mpox-cases");
        const after = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null });
        const observedBefore = before.states.find((state) => state.code === "TX")?.latestObserved ?? 0;
        const observedAfter = after.states.find((state) => state.code === "TX")?.latestObserved ?? 0;
        expect(observedBefore).toBeGreaterThan(0);
        expect(observedAfter).toBeCloseTo(observedBefore * 9, 6);
    });
    it("refuses a bake older than a publication cycle instead of calling it current", async () => {
        stubPublisher(nndssRows({ Texas: 10 }));
        await bakeStateForecasts("mpox-cases");
        const index = (await readBakedForecastIndex("mpox-cases"))!;
        const slice = (await readBakedStateForecast("mpox-cases", "TX"))!;
        const staleValue = index.states.find((state) => state.code === "TX")?.latestObserved ?? 0;
        await writeBakedForecast("mpox-cases", { ...index, bakedAt: new Date(Date.now() - 8 * 86400000).toISOString() }, new Map([["TX", slice]]));
        clearNationalForecastCache();
        clearPublisherCache();
        stubPublisher(nndssRows({ Texas: 70 }));
        const served = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null });
        expect(staleValue).toBeGreaterThan(0);
        expect(served.states.find((state) => state.code === "TX")?.latestObserved).toBeCloseTo(staleValue * 7, 6);
    });
    it("computes live when nothing has been baked, so a missing store is never a failure", async () => {
        const fetchMock = stubPublisher(nndssRows({ Texas: 40 }));
        const texas = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null });
        expect(fetchMock).toHaveBeenCalled();
        expect(texas.selectedState).toBe("TX");
    });
    it("still serves the previous bake when a later one fails outright", async () => {
        stubPublisher(nndssRows({ Texas: 40 }));
        await bakeStateForecasts("mpox-cases");
        const good = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null });
        clearPublisherCache();
        clearNationalForecastCache();
        vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
        await bakeStateForecasts("mpox-cases").catch(() => undefined);
        clearNationalForecastCache();
        const afterFailure = await getNationalForecast({ signalId: "mpox-cases", stateCode: "TX", horizon: 28, period: null });
        expect(afterFailure.states.find((state) => state.code === "TX")?.latestObserved)
            .toBe(good.states.find((state) => state.code === "TX")?.latestObserved);
    });
});
describe("the national forecast view is served from the store too", () => {
    it("answers a national request from the index without calling any publisher", async () => {
        const fetchMock = vi.fn(async () => Response.json(nndssRows({ Massachusetts: 12, Texas: 30 })));
        vi.stubGlobal("fetch", fetchMock);
        await bakeStateForecasts("mpox-cases");
        clearNationalForecastCache();
        const callsAfterBake = fetchMock.mock.calls.length;
        const national = await getNationalForecast({ signalId: "mpox-cases", stateCode: null, horizon: 28, period: null });
        expect(fetchMock.mock.calls.length).toBe(callsAfterBake);
        expect(national.selectedState).toBeNull();
        expect(national.selectedStateName).toBeNull();
        expect(national.states.length).toBeGreaterThan(0);
        expect(national.evidence).toBeTruthy();
    });
    it("matches what the live computation would have returned", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(nndssRows({ Massachusetts: 9 }))));
        const baked = await bakeStateForecasts("mpox-cases");
        clearNationalForecastCache();
        const fromStore = await getNationalForecast({ signalId: "mpox-cases", stateCode: null, horizon: 28, period: null });
        expect(fromStore.evidence).toEqual(baked!.national.evidence);
        expect(fromStore.states).toEqual(baked!.national.states);
    });
    it("falls through to a live computation when the index predates the national fields", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(nndssRows({ Massachusetts: 5 }))));
        await bakeStateForecasts("mpox-cases");
        const index = await readBakedForecastIndex("mpox-cases");
        const slice = await readBakedStateForecast("mpox-cases", "MA");
        const withoutNational = { ...index! };
        delete (withoutNational as {
            evidence?: unknown;
        }).evidence;
        await writeBakedForecast("mpox-cases", withoutNational, new Map([["MA", slice!]]));
        clearNationalForecastCache();
        const state = await getNationalForecast({ signalId: "mpox-cases", stateCode: "MA", horizon: 28, period: null });
        expect(state.selectedState).toBe("MA");
        clearNationalForecastCache();
        const national = await getNationalForecast({ signalId: "mpox-cases", stateCode: null, horizon: 28, period: null });
        expect(national.selectedState).toBeNull();
        expect(national.evidence).toBeTruthy();
    });
});
