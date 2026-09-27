import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/signal-catalog", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/signal-catalog")>();
    return { ...actual, SIGNAL_CATALOG: [actual.SIGNAL_BY_ID["ed-wait"]] };
});
vi.mock("@/lib/massachusetts-national-details", () => ({
    getMassachusettsOutlook: vi.fn(async () => ({ sourceWarnings: [] })),
    getMassachusettsCountyDetails: vi.fn(async () => [{
            id: "MA:ed-wait:BARNSTABLE",
            name: "Barnstable County",
            geographyType: "county",
            counties: ["Barnstable"],
            value: 200,
            displayValue: "200 minutes",
            observedThrough: "2025-06-30",
            comparisonEligible: true,
            note: "Massachusetts county detail.",
        }]),
}));
import { compactNationalFeed } from "@/lib/national-feed";
import { getNationalFeed } from "@/lib/national-live";
import { clearPublisherCache } from "@/lib/publisher-cache";
import { SIGNAL_CATALOG } from "@/lib/signal-catalog";
afterEach(() => { vi.unstubAllGlobals(); clearPublisherCache(); });
describe("national feed", () => {
    it("returns summary-only outlooks without fetching CMS hospital details or appending Massachusetts counties", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).includes("apyc-v239")) {
                return Response.json({ count: 1, results: [{ state: "MA", score: "149", start_date: "07/01/2024", end_date: "06/30/2025" }] });
            }
            return Response.json({ count: 1, results: [{ facility_id: "010001", facility_name: "HOSPITAL", state: "MA", countyparish: "BARNSTABLE", score: "217", start_date: "07/01/2024", end_date: "06/30/2025" }] });
        });
        vi.stubGlobal("fetch", fetchMock);
        const result = await getNationalFeed({ period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0][0])).toContain("apyc-v239");
        expect(result.outlooks["ed-wait"].details).toEqual([]);
        expect(result.outlooks["ed-wait"].states.find((state) => state.code === "MA")?.value).toBe(149);
        expect(result.catalog).toEqual(SIGNAL_CATALOG);
        expect(result.outlooks["ed-wait"]).not.toHaveProperty("catalog");
    });
    it("normalizes a persisted legacy feed without retaining per-outlook catalogs", () => {
        const signal = SIGNAL_CATALOG[0];
        const feed = compactNationalFeed({
            retrievedAt: "2026-08-31T12:00:00Z",
            refreshHours: 12,
            status: "current",
            errors: [],
            selectedState: null,
            period: null,
            outlooks: {
                [signal.id]: {
                    scope: "national",
                    signal,
                    catalog: SIGNAL_CATALOG,
                    retrievedAt: "2026-08-31T12:00:00Z",
                    status: "current",
                    isStale: false,
                    period: null,
                    states: [],
                    selectedState: null,
                    details: [],
                    geography: { level: "unavailable", countyDataStates: [], statewideOnlyStates: [], message: "Unavailable" },
                    errors: [],
                },
            } as never,
        });
        expect(feed.catalog).toEqual(SIGNAL_CATALOG);
        expect(feed.outlooks[signal.id]).not.toHaveProperty("catalog");
    });
});
