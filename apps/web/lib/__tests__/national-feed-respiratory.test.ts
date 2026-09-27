import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/signal-catalog", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/signal-catalog")>();
    return {
        ...actual,
        SIGNAL_CATALOG: [
            actual.SIGNAL_BY_ID["covid-ed"],
            actual.SIGNAL_BY_ID["influenza-ed"],
            actual.SIGNAL_BY_ID["rsv-ed"],
        ],
    };
});
import { getNationalFeed } from "@/lib/national-live";
import { clearPublisherCache } from "@/lib/publisher-cache";
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearPublisherCache();
});
describe("national respiratory feed", () => {
    it("lets a cold shared NSSP request finish before marking respiratory signals unavailable", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
            setTimeout(() => resolve(Response.json([{
                    week_end: "2026-07-25T00:00:00.000",
                    geography: "Alabama",
                    county: "All",
                    hsa_nci_id: "All",
                    trend_source: "State",
                    percent_visits_covid: "1.2",
                    percent_visits_influenza: "0.3",
                    percent_visits_rsv: "0.1",
                }])), 6000);
        })));
        const pending = getNationalFeed({ period: null, now: new Date("2026-07-29T12:00:00Z") });
        await vi.advanceTimersByTimeAsync(6001);
        const result = await pending;
        for (const signal of ["covid-ed", "influenza-ed", "rsv-ed"] as const) {
            expect(result.outlooks[signal].status).toBe("current");
            expect(result.outlooks[signal].states.find((state) => state.code === "AL")?.value).not.toBeNull();
        }
    });
});
