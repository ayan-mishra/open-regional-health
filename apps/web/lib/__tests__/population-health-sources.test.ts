import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/national-live", () => ({ getBakedNationalOutlook: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/national-forecast-live", () => ({ getBakedNationalForecast: vi.fn().mockResolvedValue(null) }));
const mocks = vi.hoisted(() => ({ phase1: vi.fn(), phase2: vi.fn(), phase3: vi.fn(), phase4: vi.fn(), warm1: vi.fn(), warm2: vi.fn(), outlooks: vi.fn(), baked: vi.fn() }));
vi.mock("@/lib/population-store", () => ({ readBakedPopulationState: mocks.baked }));
vi.mock("@/lib/population-health-phase1", () => ({ loadPhase1: mocks.phase1, warmPopulationHealthPhase1: mocks.warm1 }));
vi.mock("@/lib/population-health-phase2", () => ({ loadPhase2: mocks.phase2, warmPopulationHealthPhase2: mocks.warm2 }));
vi.mock("@/lib/population-health-phase3", () => ({ loadPhase3: mocks.phase3 }));
vi.mock("@/lib/population-health-phase4", () => ({ loadPhase4: mocks.phase4 }));
vi.mock("@/lib/server-public-snapshot", () => ({ getServerOutlookSnapshots: mocks.outlooks, getCachedServerOutlookSnapshot: vi.fn(), getCachedServerForecastSnapshot: vi.fn() }));
import { clearPopulationHealthContextCache, getPopulationHealthContext, normalizePopulationPeriod, warmPopulationHealthData } from "@/lib/population-health-sources";
function result(id: "baseline" | "access" | "prevention" | "resilience", measures: Array<{
    id: string;
    value?: number | null;
    status?: string;
}> = []) {
    return { section: { id, title: id, description: id, measures }, errors: [], sources: [] };
}
describe("population health context cache", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearPopulationHealthContextCache();
        mocks.baked.mockReset().mockResolvedValue(null);
        mocks.phase1.mockResolvedValue(result("baseline"));
        mocks.phase2.mockResolvedValue(result("access"));
        mocks.phase3.mockResolvedValue(result("prevention"));
        mocks.phase4.mockResolvedValue(result("resilience"));
        mocks.warm1.mockResolvedValue(undefined);
        mocks.warm2.mockResolvedValue(undefined);
        mocks.outlooks.mockResolvedValue(new Map());
    });
    it("accepts only bounded historical months", () => {
        const now = new Date("2026-08-25T12:00:00Z");
        expect(normalizePopulationPeriod("2018-01", now)).toBe("2018-01");
        expect(normalizePopulationPeriod("2026-08", now)).toBe("2026-08");
        expect(normalizePopulationPeriod("2017-12", now)).toBeNull();
        expect(normalizePopulationPeriod("2026-09", now)).toBeNull();
        expect(normalizePopulationPeriod("not-a-month", now)).toBeNull();
    });
    it("deduplicates and reuses a geography response", async () => {
        const [first, joined] = await Promise.all([
            getPopulationHealthContext({ stateCode: "MA", countyFips: null }),
            getPopulationHealthContext({ stateCode: "MA", countyFips: null }),
        ]);
        const cached = await getPopulationHealthContext({ stateCode: "MA", countyFips: null });
        expect(joined).toBe(first);
        expect(cached).toBe(first);
        expect(mocks.phase1).toHaveBeenCalledOnce();
        expect(mocks.phase4).toHaveBeenCalledOnce();
    });
    it("warms only the shared current-period sources", async () => {
        await warmPopulationHealthData();
        expect(mocks.warm1).toHaveBeenCalledOnce();
        expect(mocks.warm2).toHaveBeenCalledOnce();
        expect(mocks.outlooks).toHaveBeenCalledWith(expect.any(Array), "", 1, true);
        expect(mocks.outlooks.mock.calls[0][0]).toHaveLength(9);
        expect(mocks.phase1).not.toHaveBeenCalled();
    });
    it("recomputes a bake from the phases instead of re-stamping the old stored brief", async () => {
        const old = await getPopulationHealthContext({ stateCode: "MA" });
        mocks.baked.mockResolvedValue(old);
        expect(await getPopulationHealthContext({ stateCode: "MA" })).toEqual(old);
        const fresh = await getPopulationHealthContext({ stateCode: "MA", recompute: true });
        expect(fresh).not.toBe(old);
        expect(mocks.phase1).toHaveBeenCalledTimes(2);
        expect(mocks.phase4).toHaveBeenCalledTimes(2);
    });
    it("returns a stale report immediately while refreshing it in the background", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-25T12:00:00Z"));
        const first = await getPopulationHealthContext({ stateCode: "MA", countyFips: null });
        vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
        let finishRefresh!: () => void;
        mocks.phase1.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = () => resolve(result("baseline")); }));
        const stale = await getPopulationHealthContext({ stateCode: "MA", countyFips: null });
        expect(stale).toBe(first);
        expect(mocks.phase1).toHaveBeenCalledTimes(2);
        finishRefresh();
        await vi.runAllTimersAsync();
        vi.useRealTimers();
    });
    it("starts independent phases immediately and passes the baseline denominator to prevention", async () => {
        let release!: (value: unknown) => void;
        mocks.phase1.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const request = getPopulationHealthContext({ stateCode: "MA", countyFips: null, period: "2026-07" });
        await Promise.resolve();
        expect(mocks.phase2).toHaveBeenCalledOnce();
        expect(mocks.phase4).toHaveBeenCalledOnce();
        expect(mocks.phase3).not.toHaveBeenCalled();
        release(result("baseline", [{ id: "population", value: 123, status: "current" }]));
        await request;
        expect(mocks.phase3).toHaveBeenCalledWith("MA", null, "2026-07", 123);
        expect(mocks.phase4).toHaveBeenCalledWith("MA", null, "2026-07");
    });
    it("drops a county when its state is missing or invalid", async () => {
        const response = await getPopulationHealthContext({ stateCode: "ZZ", countyFips: "25017" });
        expect(mocks.phase1).toHaveBeenCalledWith(null, null, null);
        expect(response.selectedState).toBeNull();
        expect(response.selectedCountyFips).toBeNull();
    });
    it("marks a report partial when its only usable measures are partial or stale", async () => {
        mocks.phase1.mockResolvedValue(result("baseline", [{ id: "population", value: 123, status: "partial" }]));
        mocks.phase2.mockResolvedValue(result("access", [{ id: "access", value: 1, status: "stale" }]));
        const response = await getPopulationHealthContext({ stateCode: "MA" });
        expect(response.status).toBe("partial");
    });
    it("marks an empty report unavailable", async () => {
        const response = await getPopulationHealthContext({ stateCode: "MA" });
        expect(response.status).toBe("unavailable");
    });
});
