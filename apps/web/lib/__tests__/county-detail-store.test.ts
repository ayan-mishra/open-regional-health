import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const storeDirectory = vi.hoisted(() => {
    const directory = `/tmp/corvid-county-store.${process.pid}.${Date.now()}`;
    process.env.CORVID_COUNTY_STORE_DIR = directory;
    return directory;
});
import { rm } from "node:fs/promises";
import { bakeCountyDetails, clearNationalOutlookCache, getNationalOutlook } from "@/lib/national-live";
import { readBakedSignalIndex, readBakedStateDetail, readCountyStoreManifest } from "@/lib/county-detail-store";
import { warmCountyDetails } from "@/lib/server-public-snapshot";
import { clearPublisherCache } from "@/lib/publisher-cache";
function mpoxRows(cases: Record<string, number>, daysAgo: number) {
    const observed = new Date(Date.now() - daysAgo * 86400000);
    observed.setUTCDate(observed.getUTCDate() - ((observed.getUTCDay() + 1) % 7));
    const year = observed.getUTCFullYear();
    const week = Math.floor((observed.getTime() - Date.UTC(year, 0, 4)) / (7 * 86400000)) + 1;
    return Object.entries(cases).map(([states, m1]) => ({ states, year: String(year), week: String(week), label: "Mpox", m1: String(m1) }));
}
function stubPublisher(rows: unknown[]) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}
beforeEach(() => { clearPublisherCache(); clearNationalOutlookCache(); });
afterEach(async () => {
    vi.unstubAllGlobals();
    clearPublisherCache();
    clearNationalOutlookCache();
    await rm(storeDirectory, { recursive: true, force: true });
});
describe("preloaded county detail store", () => {
    it("answers a state request from disk without going back to the publisher", async () => {
        await bakeCountyDetails("mpox-cases");
        const afterBake = stubPublisher([]);
        clearNationalOutlookCache();
        const texas = await getNationalOutlook({ signalId: "mpox-cases", stateCode: "TX", period: null });
        expect(afterBake).not.toHaveBeenCalled();
        expect(texas.scope).toBe("state");
        expect(texas.selectedState).toBe("TX");
        expect(texas.details.map((detail) => detail.stateCode)).toEqual(["TX"]);
        expect(texas.states).toHaveLength(49);
    });
    it("keeps each state's own slice rather than every state's detail in every file", async () => {
        await bakeCountyDetails("mpox-cases");
        const [index, texas, massachusetts] = await Promise.all([
            readBakedSignalIndex("mpox-cases"),
            readBakedStateDetail("mpox-cases", "TX"),
            readBakedStateDetail("mpox-cases", "MA"),
        ]);
        expect(index?.states).toHaveLength(49);
        expect(texas?.details.every((detail) => detail.stateCode === "TX")).toBe(true);
        expect(massachusetts?.details.every((detail) => detail.stateCode === "MA")).toBe(true);
    });
    it("writes a file for a state with no detail so the empty answer is served instantly too", async () => {
        stubPublisher(mpoxRows({ Texas: 12 }, 2));
        await bakeCountyDetails("mpox-cases");
        const wyoming = await readBakedStateDetail("mpox-cases", "WY");
        expect(wyoming).not.toBeNull();
        expect(wyoming?.details).toEqual([]);
    });
    it("replaces every state's answer as soon as the publisher has new data", async () => {
        stubPublisher(mpoxRows({ Texas: 10, Massachusetts: 4 }, 2));
        await bakeCountyDetails("mpox-cases");
        const before = await getNationalOutlook({ signalId: "mpox-cases", stateCode: "TX", period: null });
        clearPublisherCache();
        stubPublisher(mpoxRows({ Texas: 90, Massachusetts: 40 }, 2));
        await bakeCountyDetails("mpox-cases");
        const after = await getNationalOutlook({ signalId: "mpox-cases", stateCode: "TX", period: null });
        expect(before.details[0]?.value).toBeGreaterThan(0);
        expect(after.details[0]?.value).toBeCloseTo((before.details[0]!.value ?? 0) * 9, 4);
        expect(after.states.find((state) => state.code === "MA")?.value).toBeCloseTo(40 / 7029917 * 100000, 6);
    });
    it("judges freshness when the answer is served, not when it was baked", async () => {
        stubPublisher(mpoxRows({ Texas: 10 }, 40));
        await bakeCountyDetails("mpox-cases");
        clearNationalOutlookCache();
        stubPublisher([]);
        const texas = await getNationalOutlook({ signalId: "mpox-cases", stateCode: "TX", period: null });
        expect(texas.isStale).toBe(true);
        expect(texas.details[0]?.isStale).toBe(true);
    });
    it("computes live when nothing has been baked, so a missing store is never a failure", async () => {
        const fetchMock = stubPublisher(mpoxRows({ Texas: 7 }, 2));
        const texas = await getNationalOutlook({ signalId: "mpox-cases", stateCode: "TX", period: null });
        expect(fetchMock).toHaveBeenCalled();
        expect(texas.states.find((state) => state.code === "TX")?.value).toBeCloseTo(7 / 29145505 * 100000, 6);
    });
    it("records only the signals a refresh actually rewrote in the manifest /healthz reports", async () => {
        stubPublisher(mpoxRows({ Texas: 10, Massachusetts: 4 }, 2));
        const refreshed = await warmCountyDetails();
        const manifest = await readCountyStoreManifest();
        expect(manifest?.signals).toContain("mpox-cases");
        expect(manifest?.signals).toHaveLength(refreshed);
        expect(Date.parse(manifest!.bakedAt)).toBeGreaterThan(Date.now() - 600000);
    }, 120000);
    it("still serves the previous bake when a later one fails outright", async () => {
        stubPublisher(mpoxRows({ Texas: 10 }, 2));
        await bakeCountyDetails("mpox-cases");
        clearPublisherCache();
        clearNationalOutlookCache();
        vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
        await bakeCountyDetails("mpox-cases").catch(() => undefined);
        clearNationalOutlookCache();
        const texas = await getNationalOutlook({ signalId: "mpox-cases", stateCode: "TX", period: null });
        expect(texas.details[0]?.value).toBeCloseTo(10 / 29145505 * 100000, 6);
    });
});
describe("the national view is served from the store too", () => {
    it("answers a national request from the index without calling any publisher", async () => {
        const fetchMock = vi.fn(async () => Response.json(mpoxRows({ Massachusetts: 12, Texas: 30 }, 3)));
        vi.stubGlobal("fetch", fetchMock);
        await bakeCountyDetails("mpox-cases");
        clearNationalOutlookCache();
        const callsAfterBake = fetchMock.mock.calls.length;
        const national = await getNationalOutlook({ signalId: "mpox-cases", stateCode: null, period: null });
        expect(fetchMock.mock.calls.length).toBe(callsAfterBake);
        expect(national.scope).toBe("national");
        expect(national.selectedState).toBeNull();
        expect(national.states.find((state) => state.code === "MA")?.value).not.toBeNull();
        expect(national.geography).toBeTruthy();
    });
    it("carries no sub-state detail nationally, matching what a live national request returns", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(mpoxRows({ Massachusetts: 5 }, 3))));
        await bakeCountyDetails("mpox-cases");
        clearNationalOutlookCache();
        const national = await getNationalOutlook({ signalId: "mpox-cases", stateCode: null, period: null });
        expect(national.details).toEqual([]);
    });
});
describe("an index baked before the national geography existed", () => {
    it("still answers state requests, and defers the national one to the live path", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(mpoxRows({ Massachusetts: 7 }, 3))));
        await bakeCountyDetails("mpox-cases");
        const index = await readBakedSignalIndex("mpox-cases");
        const { writeBakedSignal } = await import("@/lib/county-detail-store");
        const detail = await readBakedStateDetail("mpox-cases", "MA");
        const withoutGeography = { ...index! };
        delete (withoutGeography as {
            geography?: unknown;
        }).geography;
        await writeBakedSignal("mpox-cases", withoutGeography as typeof index & object, new Map([["MA", detail!]]));
        clearNationalOutlookCache();
        const fetchMock = vi.fn(async () => Response.json(mpoxRows({ Massachusetts: 7 }, 3)));
        vi.stubGlobal("fetch", fetchMock);
        const state = await getNationalOutlook({ signalId: "mpox-cases", stateCode: "MA", period: null });
        expect(state.states.find((reading) => reading.code === "MA")?.value).not.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        clearNationalOutlookCache();
        clearPublisherCache();
        const national = await getNationalOutlook({ signalId: "mpox-cases", stateCode: null, period: null });
        expect(fetchMock).toHaveBeenCalled();
        expect(national.scope).toBe("national");
    });
});
