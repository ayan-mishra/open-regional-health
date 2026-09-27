import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSiteSnapshotCache, getCachedForecastSnapshot, getCachedNationalOutlook, loadForecastSnapshot, loadNationalOutlook, loadSiteCountyGeometry, loadStateOutlook, primeForecastSnapshot, primeNationalOutlook } from "@/lib/site-snapshot";
import { SIGNAL_CATALOG } from "@/lib/signal-catalog";
afterEach(() => {
    clearSiteSnapshotCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
describe("site snapshot", () => {
    it("loads and deduplicates only the requested national signal", async () => {
        const response = { scope: "national", status: "current", signal: SIGNAL_CATALOG[1], selectedState: null, period: null, details: [], states: [], catalog: SIGNAL_CATALOG, geography: { level: "statewide", countyDataStates: [], statewideOnlyStates: [], message: "Statewide." }, retrievedAt: "2026-08-21T00:00:00Z", isStale: false, errors: [] };
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)));
        vi.stubGlobal("fetch", fetchMock);
        const [first, second] = await Promise.all([loadNationalOutlook("influenza-ed"), loadNationalOutlook("influenza-ed")]);
        expect(first).toBe(second);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toBe("/api/national/outlook?signal=influenza-ed");
    });
    it("primes and validates national outlook identity", async () => {
        const response = { scope: "national", status: "current", signal: SIGNAL_CATALOG[0], selectedState: null, period: null, details: [], states: [], catalog: SIGNAL_CATALOG, geography: { level: "statewide", countyDataStates: [], statewideOnlyStates: [], message: "Statewide." }, retrievedAt: "2026-08-21T00:00:00Z", isStale: false, errors: [] };
        primeNationalOutlook(response as never);
        expect(getCachedNationalOutlook("covid-ed")).toBe(response);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response))));
        await expect(loadNationalOutlook("influenza-ed")).rejects.toThrow("different signal");
    });
    it("memoizes state detail so changing away and back makes one request", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ scope: "state", status: "current", signal: SIGNAL_CATALOG[0], selectedState: "MA", period: null, details: [], states: [], catalog: SIGNAL_CATALOG, geography: { level: "statewide", countyDataStates: [], statewideOnlyStates: ["MA"], message: "Statewide." }, retrievedAt: "2026-08-21T00:00:00Z", isStale: false, errors: [] })));
        vi.stubGlobal("fetch", fetchMock);
        await loadStateOutlook("covid-ed", "MA");
        await loadStateOutlook("covid-ed", "MA");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it("primes a server forecast into the shared browser cache", async () => {
        const forecast = { signalId: "covid-ed", horizon: 28, period: null, status: "current" };
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        primeForecastSnapshot(forecast as never);
        expect(getCachedForecastSnapshot("covid-ed", 28)).toBe(forecast);
        await loadForecastSnapshot("covid-ed", 28);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("separates national and local forecasts and rejects the wrong state", async () => {
        const national = { signalId: "covid-ed", horizon: 28, period: null, status: "current", selectedState: null };
        const massachusetts = { ...national, selectedState: "MA" };
        primeForecastSnapshot(national as never);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(massachusetts))));
        expect(await loadForecastSnapshot("covid-ed", 28, "", false, "MA")).toEqual(massachusetts);
        expect(getCachedForecastSnapshot("covid-ed", 28)).toBe(national);
        await expect(loadForecastSnapshot("covid-ed", 28, "", false, "CA")).rejects.toThrow("different signal, state, or period");
        expect(getCachedForecastSnapshot("covid-ed", 28, "", "CA")).toBeNull();
    });
    it("rejects a forecast response for a different signal instead of poisoning the cache", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
            signalId: "covid-ed", signal: SIGNAL_CATALOG.find((signal) => signal.id === "covid-ed"), horizon: 28, period: null, status: "current",
        }))));
        await expect(loadForecastSnapshot("influenza-ed", 28)).rejects.toThrow("different signal");
        expect(getCachedForecastSnapshot("influenza-ed", 28)).toBeNull();
    });
    it("loads and deduplicates only the requested county geometry", async () => {
        const geometry = { stateCode: "MA", viewBox: "0 0 1 1", statePath: "M0,0Z", counties: [], source: "Census", sourceSha256: "hash" };
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            void input;
            return new Response(JSON.stringify(geometry));
        });
        vi.stubGlobal("fetch", fetchMock);
        const [first, second] = await Promise.all([loadSiteCountyGeometry("MA"), loadSiteCountyGeometry("MA")]);
        await loadSiteCountyGeometry("MA");
        expect(first).toEqual(geometry);
        expect(second).toBe(first);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/geometry/counties/25.json");
    });
});
