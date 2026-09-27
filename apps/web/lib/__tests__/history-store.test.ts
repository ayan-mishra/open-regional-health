import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { historyPeriods, HISTORY_FIRST_PERIOD, isBakedHistoryPeriod, readBakedHistoryMonth, writeBakedHistoryMonth } from "@/lib/history-store";
let directory: string;
beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "corvid-history-"));
    vi.stubEnv("CORVID_HISTORY_STORE_DIR", directory);
});
afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
});
describe("history periods", () => {
    it("runs from the first offered month up to, but never including, the current one", async () => {
        const periods = historyPeriods(new Date("2024-04-15T00:00:00.000Z"));
        expect(periods).toEqual(["2024-01", "2024-02", "2024-03"]);
        expect(periods[0]).toBe(HISTORY_FIRST_PERIOD);
    });
    it("excludes the current month, whose average is still moving", async () => {
        const now = new Date("2026-09-02T00:00:00.000Z");
        expect(historyPeriods(now).at(-1)).toBe("2026-08");
        expect(isBakedHistoryPeriod("2026-09", now)).toBe(false);
        expect(isBakedHistoryPeriod("2026-08", now)).toBe(true);
    });
    it("does not offer a month before the first one baked", async () => {
        expect(isBakedHistoryPeriod("2023-12", new Date("2026-09-02T00:00:00.000Z"))).toBe(false);
    });
});
describe("reading and writing a month", () => {
    const month = {
        retrievedAt: "2024-04-01T00:00:00.000Z",
        status: "current" as const,
        states: [{ code: "MA", value: 1.5 }] as never,
        details: [{ id: "MA:1", value: 2.5 }] as never,
        geography: { level: "hsa" as const, countyDataStates: [], statewideOnlyStates: [] } as never,
        errors: [],
    };
    it("round-trips a month through the compressed file", async () => {
        await writeBakedHistoryMonth("covid-ed", "2024-03", month);
        const read = await readBakedHistoryMonth("covid-ed", "2024-03");
        expect(read?.states).toEqual(month.states);
        expect(read?.details).toEqual(month.details);
        expect(read?.retrievedAt).toBe(month.retrievedAt);
        expect(read?.bakedAt).toBeTruthy();
    });
    it("reports a month that was never baked as absent rather than throwing", async () => {
        expect(await readBakedHistoryMonth("covid-ed", "2024-11")).toBeNull();
    });
    it("keeps each signal's months separate", async () => {
        await writeBakedHistoryMonth("lyme-cases", "2024-03", { ...month, states: [{ code: "MA", value: 99 }] as never });
        const lyme = await readBakedHistoryMonth("lyme-cases", "2024-03");
        const covid = await readBakedHistoryMonth("covid-ed", "2024-03");
        expect((lyme?.states[0] as {
            value: number;
        }).value).toBe(99);
        expect((covid?.states[0] as {
            value: number;
        }).value).toBe(1.5);
    });
});
describe("months that produced nothing", () => {
    const empty = {
        retrievedAt: "2024-04-01T00:00:00.000Z",
        status: "partial" as const,
        states: [] as never,
        details: [] as never,
        geography: { level: "unavailable" as const, countyDataStates: [], statewideOnlyStates: [] } as never,
        errors: [],
    };
    it("records why a month is empty instead of leaving a hole", async () => {
        await writeBakedHistoryMonth("heatrisk", "2024-05", {
            ...empty,
            absent: { reason: "no-historical-coverage", detail: "no archive to average" },
        });
        const read = await readBakedHistoryMonth("heatrisk", "2024-05");
        expect(read?.absent?.reason).toBe("no-historical-coverage");
        expect(read?.absent?.detail).toBe("no archive to average");
    });
    it("leaves a month with real data unmarked", async () => {
        await writeBakedHistoryMonth("heatrisk", "2024-06", { ...empty, states: [{ code: "MA", value: 2 }] as never });
        expect((await readBakedHistoryMonth("heatrisk", "2024-06"))?.absent).toBeUndefined();
    });
});
describe("an absent month is not an outage", () => {
    it("is reported as a settled answer carrying its reason, not as temporarily unavailable", async () => {
        const { getNationalOutlook, clearNationalOutlookCache } = await import("@/lib/national-live");
        await writeBakedHistoryMonth("lyme-cases", "2025-06", {
            retrievedAt: "2025-07-01T00:00:00.000Z", status: "partial", states: [] as never, details: [] as never,
            geography: { level: "unavailable" as const, countyDataStates: [], statewideOnlyStates: [] } as never, errors: [],
            absent: { reason: "publisher-reported-nothing", detail: "The publisher's feed covers this period but returned no observations for it." },
        });
        clearNationalOutlookCache();
        const outlook = await getNationalOutlook({ signalId: "lyme-cases", stateCode: null, period: "2025-06", now: undefined });
        expect(outlook.status).toBe("current");
        expect(outlook.errors.some((error) => /returned no observations/.test(error.message))).toBe(true);
    });
});
