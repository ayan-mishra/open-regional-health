import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { writeBakedHistoryMonth } from "@/lib/history-store";
import * as historyStore from "@/lib/history-store";
import { clearSeasonalBaselineCache, describeSeasonalBaseline, priorYearPeriods, seasonalBaseline } from "@/lib/seasonal-baseline";
import { beforeEach } from "vitest";
beforeEach(clearSeasonalBaselineCache);
let directory: string;
const now = new Date("2026-09-15T00:00:00.000Z");
beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "corvid-seasonal-"));
    vi.stubEnv("CORVID_HISTORY_STORE_DIR", directory);
});
afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
});
const month = (states: Record<string, number | null>, absent?: {
    reason: string;
    detail: string;
}) => ({
    retrievedAt: "2026-01-01T00:00:00.000Z",
    status: "current" as const,
    states: Object.entries(states).map(([code, value]) => ({ code, value })) as never,
    details: [] as never,
    geography: { level: "statewide" as const, countyDataStates: [], statewideOnlyStates: [] } as never,
    errors: [],
    ...(absent ? { absent } : {}),
});
describe("prior year periods", () => {
    it("finds the same calendar month in earlier years the store covers", () => {
        expect(priorYearPeriods("2026-03", now)).toEqual(["2025-03", "2024-03"]);
    });
    it("returns nothing for a month with no earlier year in the store", () => {
        expect(priorYearPeriods("2024-01", now)).toEqual([]);
    });
});
describe("seasonal baseline", () => {
    it("shares cold history reads across concurrent regions", async () => {
        const read = vi.spyOn(historyStore, "readBakedHistoryMonth");
        try {
            await Promise.all([
                seasonalBaseline("covid-ed", ["MA"], 6, "2026-03", now),
                seasonalBaseline("covid-ed", ["TX"], 8, "2026-03", now),
            ]);
            expect(read).toHaveBeenCalledTimes(2);
        }
        finally {
            read.mockRestore();
        }
    });
    it("averages the same month across prior years, over only the states asked about", async () => {
        await writeBakedHistoryMonth("covid-ed", "2025-03", month({ MA: 2, TX: 4, CA: 100 }));
        await writeBakedHistoryMonth("covid-ed", "2024-03", month({ MA: 4, TX: 6, CA: 100 }));
        const baseline = await seasonalBaseline("covid-ed", ["MA", "TX"], 6, "2026-03", now);
        expect(baseline?.value).toBeCloseTo(4, 10);
        expect(baseline?.years).toBe(2);
        expect(baseline?.relative).toBeCloseTo(0.5, 10);
    });
    it("skips a month recorded as having no publisher data instead of counting it as zero", async () => {
        await writeBakedHistoryMonth("influenza-ed", "2025-04", month({ MA: 8 }));
        await writeBakedHistoryMonth("influenza-ed", "2024-04", month({}, { reason: "publisher-reported-nothing", detail: "none" }));
        const baseline = await seasonalBaseline("influenza-ed", ["MA"], 8, "2026-04", now);
        expect(baseline?.value).toBeCloseTo(8, 10);
        expect(baseline?.years).toBe(1);
    });
    it("withholds a comparison when the baseline is zero rather than dividing by it", async () => {
        await writeBakedHistoryMonth("mpox-cases", "2025-05", month({ MA: 0 }));
        expect(await seasonalBaseline("mpox-cases", ["MA"], 3, "2026-05", now)).toBeNull();
    });
    it("returns nothing when no prior month has data for these states", async () => {
        expect(await seasonalBaseline("rsv-ed", ["WY"], 5, "2026-06", now)).toBeNull();
    });
    it("returns nothing when there is no current reading to compare", async () => {
        expect(await seasonalBaseline("covid-ed", ["MA"], null, "2026-03", now)).toBeNull();
    });
});
describe("describing a baseline", () => {
    it("calls a small difference typical rather than inventing precision", () => {
        const text = describeSeasonalBaseline({ value: 4, years: 2, relative: 0.04, months: [] }, "%");
        expect(text).toMatch(/typical for this month/);
    });
    it("states the direction and size of a real difference", () => {
        expect(describeSeasonalBaseline({ value: 4, years: 2, relative: 0.5, months: [] }, "%")).toBe("50% above this month's average over 2 prior years (4.00 %)");
        expect(describeSeasonalBaseline({ value: 4, years: 1, relative: -0.25, months: [] }, "%")).toBe("25% below this month's average over 1 prior year (4.00 %)");
    });
    it("says nothing at all when there is no baseline", () => {
        expect(describeSeasonalBaseline(null, "%")).toBeNull();
    });
});
