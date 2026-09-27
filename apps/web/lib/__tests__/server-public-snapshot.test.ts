import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { SIGNAL_BY_ID, SIGNAL_CATALOG, type SignalId } from "@/lib/signal-catalog";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => {
    process.env.CORVID_PUBLIC_SNAPSHOT_PATH = `/tmp/corvid-public-snapshot-test.${process.pid}.${Date.now()}.json`;
    process.env.CORVID_FORECAST_STORE_DIR = `/tmp/corvid-forecast-warm.${process.pid}.${Date.now()}`;
    return { outlook: vi.fn(), forecast: vi.fn(), bake: vi.fn(), bakeCounty: vi.fn() };
});
vi.mock("@/lib/national-live", () => ({ getNationalOutlook: mocks.outlook, GENEROUS_OUTLOOK_TIMEOUT_MS: 40000, bakeCountyDetails: mocks.bakeCounty }));
vi.mock("@/lib/national-forecast-live", () => ({ getNationalForecast: mocks.forecast, bakeStateForecasts: mocks.bake }));
import { clearServerPublicSnapshotCache, getCachedServerForecastSnapshot, getCachedServerOutlookSnapshot, getServerForecastSnapshot, getServerOutlookSnapshot, getServerOutlookSnapshots, refreshNextSignal, refreshPublicData, warmAllOutlooks, warmPublicData, warmStateForecasts } from "@/lib/server-public-snapshot";
const SNAPSHOT_PATH = process.env.CORVID_PUBLIC_SNAPSHOT_PATH!;
const outlook = (signalId: SignalId, period = "") => ({
    scope: "national" as const, signal: SIGNAL_BY_ID[signalId], catalog: SIGNAL_CATALOG, retrievedAt: "2026-08-27T12:00:00Z", status: "current" as const,
    isStale: false, period: period || null, states: [{ code: "AL" as const, name: "Alabama", value: null, displayValue: "No comparable data", observedThrough: null, comparisonEligible: false, note: "fixture" }], selectedState: null, details: [], geography: { level: "statewide" as const, countyDataStates: [], statewideOnlyStates: [], message: "fixture" }, errors: [],
});
const forecast = (signalId: SignalId, period = "") => ({ signalId, signal: SIGNAL_BY_ID[signalId], catalog: SIGNAL_CATALOG, horizon: 28 as const, period: period || null, retrievedAt: "2026-08-27T12:00:00Z", status: "current" as const, states: [], selectedState: null, selectedStateName: null, evidence: { kind: "none" as const, description: "fixture" }, details: [], errors: [] });
afterAll(async () => { await clearServerPublicSnapshotCache(); await unlink(SNAPSHOT_PATH).catch(() => undefined); });
describe("bounded public snapshot cache", () => {
    beforeEach(async () => {
        vi.resetAllMocks();
        await clearServerPublicSnapshotCache();
        await unlink(SNAPSHOT_PATH).catch(() => undefined);
        mocks.outlook.mockImplementation(({ signalId, period }: {
            signalId: SignalId;
            period: string | null;
        }) => Promise.resolve(outlook(signalId, period ?? "")));
        mocks.forecast.mockImplementation(({ signalId, period }: {
            signalId: SignalId;
            period: string | null;
        }) => Promise.resolve(forecast(signalId, period ?? "")));
    });
    it("warms only the default signal instead of the 40-signal feed", async () => {
        await warmPublicData();
        expect(mocks.outlook).toHaveBeenCalledOnce();
        expect(mocks.outlook).toHaveBeenCalledWith(expect.objectContaining({ signalId: "covid-ed", stateCode: null }));
        expect(mocks.forecast).not.toHaveBeenCalled();
    });
    it("refreshes one live signal and persists the compact outlook", async () => {
        await refreshPublicData();
        expect(mocks.outlook).toHaveBeenCalledOnce();
        await vi.waitFor(async () => expect(JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")).outlooks["covid-ed:"].value.signal.id).toBe("covid-ed"));
    });
    it("deduplicates the requested signal and does not fetch its siblings", async () => {
        const [first, second] = await Promise.all([getServerOutlookSnapshot("influenza-ed"), getServerOutlookSnapshot("influenza-ed")]);
        expect(first).toBe(second);
        expect(mocks.outlook).toHaveBeenCalledOnce();
        expect(getCachedServerOutlookSnapshot("influenza-ed", "", false)).toBe(first);
    });
    it("bounds an explicit report batch to two publisher requests", async () => {
        let active = 0;
        let peak = 0;
        mocks.outlook.mockImplementation(async ({ signalId }: {
            signalId: SignalId;
        }) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return outlook(signalId);
        });
        await getServerOutlookSnapshots(["covid-ed", "influenza-ed", "rsv-ed", "lyme-cases"], "", 2);
        expect(peak).toBe(2);
    });
    it("refuses to cache or trust a degenerate empty-states outlook, and refetches instead", async () => {
        mocks.outlook.mockResolvedValueOnce({ ...outlook("influenza-ed"), states: [] });
        await expect(getServerOutlookSnapshot("influenza-ed")).rejects.toThrow();
        expect(getCachedServerOutlookSnapshot("influenza-ed", "", false)).toBeUndefined();
        mocks.outlook.mockResolvedValueOnce(outlook("influenza-ed"));
        const second = await getServerOutlookSnapshot("influenza-ed");
        expect(second.states.length).toBeGreaterThan(0);
        expect(mocks.outlook).toHaveBeenCalledTimes(2);
    });
    it("rejects a mismatched forecast before it can poison another signal", async () => {
        mocks.forecast.mockResolvedValueOnce(forecast("covid-ed"));
        expect(await getServerForecastSnapshot("influenza-ed", "", true)).toBeNull();
        expect(getCachedServerForecastSnapshot("influenza-ed", "", false)).toBeNull();
    });
    it("can inspect a stale prepared forecast without refreshing it", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
            await getServerForecastSnapshot("covid-ed", "forecast-peek");
            vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
            mocks.forecast.mockClear();
            expect(getCachedServerForecastSnapshot("covid-ed", "forecast-peek", false)).toBeDefined();
            await Promise.resolve();
            expect(mocks.forecast).not.toHaveBeenCalled();
        }
        finally {
            vi.useRealTimers();
        }
    });
});
describe("warmStateForecasts", () => {
    beforeEach(async () => {
        vi.resetAllMocks();
        await clearServerPublicSnapshotCache();
        await unlink(SNAPSHOT_PATH).catch(() => undefined);
        mocks.outlook.mockImplementation(({ signalId, period }: {
            signalId: SignalId;
            period: string | null;
        }) => Promise.resolve(outlook(signalId, period ?? "")));
        mocks.bake.mockImplementation((signalId: SignalId) => Promise.resolve({ written: 49, national: forecast(signalId) }));
    });
    it("bakes every signal in the catalog exactly once", async () => {
        await warmStateForecasts();
        expect(mocks.bake).toHaveBeenCalledTimes(SIGNAL_CATALOG.length);
    });
    it("seeds the national snapshot from the same pass instead of computing it again", async () => {
        await warmStateForecasts();
        expect(mocks.forecast).not.toHaveBeenCalled();
        expect(getCachedServerForecastSnapshot("covid-ed", "", false)).toMatchObject({ signalId: "covid-ed", horizon: 28 });
    });
    it("never runs two forecast computations concurrently, to bound peak memory on the 512MB instance", async () => {
        let inFlight = 0;
        let maxObservedConcurrency = 0;
        mocks.bake.mockImplementation(async (signalId: SignalId) => {
            inFlight += 1;
            maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return { written: 49, national: forecast(signalId) };
        });
        await warmStateForecasts();
        expect(maxObservedConcurrency).toBe(1);
    });
    it("continues baking the remaining signals even if one signal's forecast rejects", async () => {
        let call = 0;
        mocks.bake.mockImplementation(async (signalId: SignalId) => {
            call += 1;
            if (call === 3)
                throw new Error("publisher unavailable");
            return { written: 49, national: forecast(signalId) };
        });
        await expect(warmStateForecasts()).resolves.toBe(SIGNAL_CATALOG.length - 1);
        expect(mocks.bake).toHaveBeenCalledTimes(SIGNAL_CATALOG.length);
    });
    it("leaves a signal that declined to overwrite its previous bake out of the manifest count", async () => {
        mocks.bake.mockImplementation(async (signalId: SignalId) => signalId === "covid-ed" ? null : { written: 49, national: forecast(signalId) });
        await expect(warmStateForecasts()).resolves.toBe(SIGNAL_CATALOG.length - 1);
    });
});
describe("warmAllOutlooks", () => {
    beforeEach(async () => {
        vi.resetAllMocks();
        await clearServerPublicSnapshotCache();
        await unlink(SNAPSHOT_PATH).catch(() => undefined);
        mocks.outlook.mockImplementation(({ signalId, period }: {
            signalId: SignalId;
            period: string | null;
        }) => Promise.resolve(outlook(signalId, period ?? "")));
    });
    it("warms every signal in the full catalog, not just the modeled/default subset", async () => {
        await warmAllOutlooks();
        expect(mocks.outlook).toHaveBeenCalledTimes(SIGNAL_CATALOG.length);
        for (const signal of SIGNAL_CATALOG) {
            expect(getCachedServerOutlookSnapshot(signal.id, "", false)).toBeDefined();
        }
    });
    it("never runs two outlook computations concurrently, matching the sequential pattern warmAllForecasts already proved safe on the 512MB instance", async () => {
        let inFlight = 0;
        let maxObservedConcurrency = 0;
        mocks.outlook.mockImplementation(async ({ signalId, period }: {
            signalId: SignalId;
            period: string | null;
        }) => {
            inFlight += 1;
            maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return outlook(signalId, period ?? "");
        });
        await warmAllOutlooks();
        expect(maxObservedConcurrency).toBe(1);
    });
    it("does not persist to disk on every individual signal when warming silently", async () => {
        await getServerOutlookSnapshots(SIGNAL_CATALOG.map((signal) => signal.id), "", 1, true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await expect(readFile(SNAPSHOT_PATH, "utf8")).rejects.toThrow();
    });
    it("makes every subsequently requested signal an instant cache hit with no further publisher fetch", async () => {
        await warmAllOutlooks();
        mocks.outlook.mockClear();
        for (const signal of SIGNAL_CATALOG) {
            expect(await getServerOutlookSnapshot(signal.id)).toBeDefined();
        }
        expect(mocks.outlook).not.toHaveBeenCalled();
    });
});
describe("warm-up pacing", () => {
    const PACING_SNAPSHOT_PATH = `/tmp/corvid-pacing-snapshot.${process.pid}.${Date.now()}.json`;
    afterEach(async () => {
        vi.restoreAllMocks();
        delete process.env.CORVID_WARM_PACE_MS;
        process.env.CORVID_PUBLIC_SNAPSHOT_PATH = SNAPSHOT_PATH;
        vi.resetModules();
        await unlink(PACING_SNAPSHOT_PATH).catch(() => undefined);
    });
    it("paces bulk background warmers and leaves the request path unpaced", async () => {
        process.env.CORVID_WARM_PACE_MS = "30";
        process.env.CORVID_PUBLIC_SNAPSHOT_PATH = PACING_SNAPSHOT_PATH;
        vi.resetModules();
        const paced = await import("@/lib/server-public-snapshot");
        mocks.outlook.mockImplementation(({ signalId, period }: {
            signalId: SignalId;
            period: string | null;
        }) => Promise.resolve(outlook(signalId, period ?? "")));
        const ids: SignalId[] = ["covid-ed", "influenza-ed", "rsv-ed", "lyme-cases"];
        await paced.clearServerPublicSnapshotCache();
        const timers = vi.spyOn(globalThis, "setTimeout");
        await paced.getServerOutlookSnapshots(ids, "", 1, true);
        expect(timers.mock.calls.filter(([, delay]) => delay === 30)).toHaveLength(ids.length);
        timers.mockClear();
        await paced.clearServerPublicSnapshotCache();
        await paced.getServerOutlookSnapshots(ids, "", 1, false);
        expect(mocks.outlook).toHaveBeenCalledTimes(ids.length * 2);
        expect(timers.mock.calls.some(([, delay]) => delay === 30)).toBe(false);
    });
});
describe("refreshNextSignal", () => {
    beforeEach(async () => {
        vi.resetAllMocks();
        await clearServerPublicSnapshotCache();
        mocks.bakeCounty.mockResolvedValue(12);
        mocks.bake.mockImplementation((signalId: SignalId) => Promise.resolve({ written: 49, national: forecast(signalId) }));
    });
    it("advances one signal per call instead of rebuilding the whole catalog", async () => {
        const first = await refreshNextSignal();
        const second = await refreshNextSignal();
        expect(first).toBe(SIGNAL_CATALOG[0].id);
        expect(second).toBe(SIGNAL_CATALOG[1].id);
        expect(mocks.bakeCounty).toHaveBeenCalledTimes(2);
        expect(mocks.bake).toHaveBeenCalledTimes(2);
    });
    it("seeds the national forecast snapshot from the tick's own computation", async () => {
        await refreshNextSignal();
        expect(getCachedServerForecastSnapshot(SIGNAL_CATALOG[0].id, "", false)).toMatchObject({ signalId: SIGNAL_CATALOG[0].id, horizon: 28 });
    });
    it("keeps rotating when one signal's bake fails", async () => {
        mocks.bakeCounty.mockRejectedValueOnce(new Error("publisher unavailable"));
        await expect(refreshNextSignal()).resolves.toBe(SIGNAL_CATALOG[0].id);
        await expect(refreshNextSignal()).resolves.toBe(SIGNAL_CATALOG[1].id);
    });
});
