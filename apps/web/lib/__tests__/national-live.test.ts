import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { clearNationalOutlookCache, GENEROUS_OUTLOOK_TIMEOUT_MS, getFeedProgress, getNationalFeed, getNationalOutlook, type OutlookTrace } from "@/lib/national-live";
import { clearPublisherCache } from "@/lib/publisher-cache";
import { SIGNAL_CATALOG } from "@/lib/signal-catalog";
afterEach(() => { vi.unstubAllGlobals(); clearPublisherCache(); clearNationalOutlookCache(); });
describe("feed progress tracking", () => {
    it("serializes the shared signal catalog once instead of repeating it in every outlook", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]))));
        const feed = await getNationalFeed({ period: null });
        expect(feed.catalog).toEqual(SIGNAL_CATALOG);
        expect(Object.values(feed.outlooks).every((outlook) => !("catalog" in outlook))).toBe(true);
    });
    it("reports a real, live-updating completion count while a feed is in flight, then clears it", async () => {
        let released = 0;
        const gate = () => new Promise<void>((resolve) => setTimeout(resolve, released++ * 2));
        vi.stubGlobal("fetch", vi.fn(async () => { await gate(); return new Response(JSON.stringify([])); }));
        expect(getFeedProgress("")).toBeNull();
        const feedPromise = getNationalFeed({ period: null });
        await vi.waitFor(() => {
            const progress = getFeedProgress("");
            expect(progress).not.toBeNull();
            expect(progress!.total).toBe(SIGNAL_CATALOG.length);
            expect(progress!.completed).toBeGreaterThan(0);
            expect(progress!.completed).toBeLessThan(SIGNAL_CATALOG.length);
        });
        await feedPromise;
        expect(getFeedProgress("")).toBeNull();
    });
    it("never lets completed exceed total, even under concurrent overlapping requests", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]))));
        await Promise.all([getNationalFeed({ period: null }), getNationalFeed({ period: null })]);
        expect(getFeedProgress("")).toBeNull();
    });
});
describe("national live outlook", () => {
    it("bounds a state-scoped request so a stalled publisher cannot hang past its timeout tier, instead of the up-to-90s retry chain underneath", async () => {
        vi.useFakeTimers();
        try {
            vi.stubGlobal("fetch", vi.fn(() => new Promise(() => { })));
            const pending = getNationalOutlook({ signalId: "covid-ed", stateCode: "AL", period: null, now: new Date("2026-07-29T12:00:00Z") });
            await vi.advanceTimersByTimeAsync(GENEROUS_OUTLOOK_TIMEOUT_MS);
            const result = await pending;
            expect(result.status).toBe("partial");
            expect(result.scope).toBe("state");
            expect(result.selectedState).toBe("AL");
            expect(result.errors).toEqual([{ source: "CDC NSSP", message: "Publisher did not respond in time." }]);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it("keeps blank and null publisher numerics missing instead of coercing them to zero", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
            { week_end: "2026-07-25T00:00:00.000", geography: "Alabama", county: "All", hsa_nci_id: "All", trend_source: "State", percent_visits_covid: null, percent_visits_influenza: "", percent_visits_rsv: "0.1" },
        ]), { status: 200 })));
        const result = await getNationalOutlook({ signalId: "covid-ed", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.find((state) => state.code === "AL")).toMatchObject({ value: null, displayValue: "No comparable data" });
        expect(result.errors).toEqual([]);
    });
    it("rejects respiratory shares above 100 percent", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([
            { week_end: "2026-07-25T00:00:00.000", geography: "Alabama", county: "All", hsa_nci_id: "All", trend_source: "State", percent_visits_covid: "101" },
        ])));
        const result = await getNationalOutlook({ signalId: "covid-ed", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.every((state) => state.value === null)).toBe(true);
        expect(result.errors).toEqual([{ source: "CDC NSSP", message: "Publisher data could not be validated." }]);
    });
    it("accepts hospital reporting coverage from 60% through 100%", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
            { weekendingdate: "2026-07-25T00:00:00.000", jurisdiction: "AL", totalconfflunewadmper100k: "2", totalconfflunewadmperchosprep: "60" },
            { weekendingdate: "2026-07-25T00:00:00.000", jurisdiction: "AZ", totalconfflunewadmper100k: "3", totalconfflunewadmperchosprep: "59" },
        ]), { status: 200 })));
        const result = await getNationalOutlook({ signalId: "influenza-admissions", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.find((state) => state.code === "AL")).toMatchObject({ value: 2, comparisonEligible: true });
        expect(result.states.find((state) => state.code === "AZ")).toMatchObject({ value: 3, comparisonEligible: false });
        expect(result.states.find((state) => state.code === "AZ")?.note).toMatch(/60% to 100%/);
    });
    it("rejects occupancy above 100 percent before converting it to availability", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([
            { weekendingdate: "2026-07-25T00:00:00.000", jurisdiction: "AL", pctinptbedsocc: "101", pctinptbedsoccperchosprep: "90" },
        ])));
        const result = await getNationalOutlook({ signalId: "available-beds", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.find((state) => state.code === "AL")?.value).toBeNull();
        expect(result.errors).toEqual([{ source: "CDC NHSN", message: "Publisher data could not be validated." }]);
    });
    it("keeps the states that validate when one row reports impossible occupancy", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([
            { weekendingdate: "2026-07-25T00:00:00.000", jurisdiction: "AL", pctinptbedsocc: "40", pctinptbedsoccperchosprep: "90" },
            { weekendingdate: "2026-07-25T00:00:00.000", jurisdiction: "AZ", pctinptbedsocc: "128.15", pctinptbedsoccperchosprep: "90" },
            { weekendingdate: "2026-07-25T00:00:00.000", jurisdiction: "CO", pctinptbedsocc: "25", pctinptbedsoccperchosprep: "90" },
        ])));
        const result = await getNationalOutlook({ signalId: "available-beds", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.find((state) => state.code === "AL")?.value).toBe(60);
        expect(result.states.find((state) => state.code === "CO")?.value).toBe(75);
        expect(result.states.find((state) => state.code === "AZ")?.value).toBeNull();
    });
    it("says the publisher reported nothing, not that the reading is old, when a current HSA row has no value", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([
            { week_end: "2026-07-25T00:00:00.000", geography: "Alabama", hsa_nci_id: "All", county: "All", trend_source: "State", percent_visits_covid: "1.5" },
            { week_end: "2026-07-25T00:00:00.000", geography: "Alabama", hsa_nci_id: "1", hsa: "Reported HSA, AL", county: "Autauga", trend_source: "HSA", percent_visits_covid: "2.0" },
            { week_end: "2026-07-25T00:00:00.000", geography: "Alabama", hsa_nci_id: "2", hsa: "Unreported HSA, AL", county: "Baldwin", trend_source: "HSA" },
        ])));
        const result = await getNationalOutlook({ signalId: "covid-ed", stateCode: "AL", period: null, now: new Date("2026-07-29T12:00:00Z") });
        const reported = result.details.find((detail) => detail.name === "Reported HSA, AL");
        const unreported = result.details.find((detail) => detail.name === "Unreported HSA, AL");
        expect(reported?.value).toBe(2);
        expect(unreported?.value).toBeNull();
        expect(unreported?.observedThrough).toBe(reported?.observedThrough);
        expect(unreported?.note).toMatch(/publishes no value/);
        expect(unreported?.note).not.toMatch(/[Oo]lder/);
    });
    it("colors an HSA reading from an older week instead of dropping it, and marks it", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([
            { week_end: "2026-07-25T00:00:00.000", geography: "Alabama", hsa_nci_id: "All", county: "All", trend_source: "State", percent_visits_covid: "1.5" },
            { week_end: "2026-07-25T00:00:00.000", geography: "Alabama", hsa_nci_id: "1", hsa: "Current HSA, AL", county: "Autauga", trend_source: "HSA", percent_visits_covid: "2.0" },
            { week_end: "2026-07-18T00:00:00.000", geography: "Alabama", hsa_nci_id: "3", hsa: "Late HSA, AL", county: "Blount", trend_source: "HSA", percent_visits_covid: "3.0" },
        ])));
        const result = await getNationalOutlook({ signalId: "covid-ed", stateCode: "AL", period: null, now: new Date("2026-07-29T12:00:00Z") });
        const late = result.details.find((detail) => detail.name === "Late HSA, AL");
        expect(late?.value).toBe(3);
        expect(late?.comparisonEligible).toBe(true);
        expect(late?.isStale).toBe(true);
        expect(late?.note).toMatch(/2026-07-18/);
    });
    it("rejects malformed NNDSS weeks instead of converting them into dates", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
            { states: "Alabama", year: "2026", week: "0", label: "Pertussis", m1: "10" },
        ]), { status: 200 })));
        const result = await getNationalOutlook({ signalId: "pertussis-cases", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.every((state) => state.value === null)).toBe(true);
        expect(result.errors).toEqual([{ source: "CDC NNDSS", message: "Publisher data could not be validated." }]);
    });
    it("normalizes publisher state rows, excludes AK, and preserves 49-state coverage", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
            { week_end: "2026-07-25T00:00:00.000", geography: "Alabama", county: "All", hsa_nci_id: "All", trend_source: "State", percent_visits_covid: "1.2", percent_visits_influenza: "0.3", percent_visits_rsv: "0.1", ed_trends_covid: "Increasing", ed_trends_influenza: "No Change", ed_trends_rsv: "Decreasing" },
            { week_end: "2026-07-25T00:00:00.000", geography: "Iowa", county: "All", hsa_nci_id: "All", trend_source: "State", percent_visits_covid: "0.4", percent_visits_influenza: "0.1", percent_visits_rsv: "0.05", ed_trends_covid: "Data Unavailable", ed_trends_influenza: "Data Unavailable", ed_trends_rsv: "Data Unavailable" },
            { week_end: "2026-07-25T00:00:00.000", geography: "Massachusetts", county: "All", hsa_nci_id: "All", trend_source: "State", percent_visits_covid: "0.8", percent_visits_influenza: "0.2", percent_visits_rsv: "0.05", ed_trends_covid: "No Change", ed_trends_influenza: "No Change", ed_trends_rsv: "No Change" },
            { week_end: "2026-07-25T00:00:00.000", geography: "Massachusetts", county: "Middlesex", hsa_nci_id: "22", hsa: "Boston HSA", hsa_counties: "Middlesex, Suffolk", trend_source: "HSA", percent_visits_covid: "1.0", percent_visits_influenza: "0.2", percent_visits_rsv: "0.1", ed_trends_covid: "Increasing", ed_trends_influenza: "No Change", ed_trends_rsv: "No Change" },
            { week_end: "2026-07-25T00:00:00.000", geography: "Alaska", county: "All", hsa_nci_id: "All", trend_source: "State", percent_visits_covid: "9", percent_visits_influenza: "9", percent_visits_rsv: "9" },
        ]), { status: 200 })));
        const result = await getNationalOutlook({ signalId: "covid-ed", stateCode: "MA", period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states).toHaveLength(49);
        expect(result.states.map((state) => String(state.code)).some((code) => code === "AK" || code === "HI")).toBe(false);
        expect(result.states.find((state) => state.code === "AL")?.value).toBe(1.2);
        expect(result.states.find((state) => state.code === "IA")?.value).toBe(.4);
        expect(result.states.find((state) => state.code === "IA")?.trend).toBeUndefined();
        expect(result.states.find((state) => state.code === "AZ")?.value).toBeNull();
        expect(result.details).toEqual(expect.arrayContaining([expect.objectContaining({ id: "22", geographyType: "hsa", value: 1 })]));
    });
    it("maps CMS ED length-of-stay state and hospital observations", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).includes("apyc-v239")
            ? new Response(JSON.stringify({ count: 1, results: [{ state: "AL", score: "149", start_date: "07/01/2024", end_date: "06/30/2025" }] }))
            : new Response(JSON.stringify({ count: 1, results: [{ facility_id: "010001", facility_name: "ALABAMA HOSPITAL", state: "AL", countyparish: "HOUSTON", score: "217", sample: "395", start_date: "07/01/2024", end_date: "06/30/2025" }] })));
        vi.stubGlobal("fetch", fetchMock);
        const result = await getNationalOutlook({ signalId: "ed-wait", stateCode: "AL", period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states).toHaveLength(49);
        expect(result.states.find((state) => state.code === "AL")).toMatchObject({ value: 149, displayValue: "149 minutes", comparisonEligible: true });
        expect(result.details).toEqual([expect.objectContaining({ id: "cms:010001:OP_18b", geographyType: "site", counties: ["HOUSTON"], value: 217 })]);
        expect(result.geography.level).toBe("site-to-county");
        const hospitalUrl = new URL(String(fetchMock.mock.calls.find(([input]) => String(input).includes("yv7e-xc69"))?.[0]));
        expect(hospitalUrl.searchParams.get("conditions[1][property]")).toBe("state");
        expect(hospitalUrl.searchParams.get("conditions[1][value]")).toBe("AL");
    });
    it("fetches only the CMS state summary when hospital details are not requested", async () => {
        const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => new Response(JSON.stringify({
            count: 1,
            results: [{ state: "AL", score: "149", start_date: "07/01/2024", end_date: "06/30/2025" }],
        })));
        vi.stubGlobal("fetch", fetchMock);
        const result = await getNationalOutlook({ signalId: "ed-wait", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z"), includeAllDetails: false });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0][0])).toContain("apyc-v239");
        expect(result.details).toEqual([]);
        expect(result.states.find((state) => state.code === "AL")?.value).toBe(149);
        expect(result.geography.level).toBe("site-to-county");
    });
    it("derives a state WVAL as the mean of its reporting sites, and says that it is derived", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([
            { state_territory: "Alabama", counties_served: "Jefferson", site: "s1", site_wval: 2, week_end: "2026-07-25T00:00:00.000" },
            { state_territory: "Alabama", counties_served: "Mobile", site: "s2", site_wval: 4, week_end: "2026-07-25T00:00:00.000" },
            { state_territory: "Arizona", counties_served: "Maricopa", site: "s3", site_wval: 9, week_end: "2026-07-25T00:00:00.000" },
        ])));
        const result = await getNationalOutlook({ signalId: "influenza-a-wval", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z"), includeAllDetails: true });
        const alabama = result.states.find((state) => state.code === "AL");
        expect(alabama?.value).toBeCloseTo(3, 10);
        expect(alabama?.comparisonEligible).toBe(true);
        expect(alabama?.note).toMatch(/derived/i);
        expect(alabama?.note).toMatch(/2 CDC NWSS reporting sites/);
        expect(result.states.find((state) => state.code === "AZ")?.value).toBe(9);
    });
    it("leaves a state with no reporting site empty rather than at zero", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([
            { state_territory: "Alabama", counties_served: "Jefferson", site: "s1", site_wval: 2, week_end: "2026-07-25T00:00:00.000" },
        ])));
        const result = await getNationalOutlook({ signalId: "influenza-a-wval", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z"), includeAllDetails: true });
        expect(result.states.find((state) => state.code === "WY")?.value).toBeNull();
    });
    it("requests only the selected state and cross-border providers for wastewater county detail", async () => {
        const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => Response.json([
            { state_territory: "Massachusetts", counties_served: "Suffolk", site: "site-1", site_wval: "2.1", week_end: "2026-07-25" },
        ]));
        vi.stubGlobal("fetch", fetchMock);
        const result = await getNationalOutlook({ signalId: "influenza-a-wval", stateCode: "MA", period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.details).toHaveLength(1);
        const where = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("$where");
        expect(where).toContain("state_territory in('Massachusetts','Rhode Island')");
    });
    it("assigns wastewater service counties to their actual state across state lines", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json([
            { state_territory: "DC", counties_served: "Arlington; Prince George's", site: "cross-state-site", sample_collect_date: "2026-07-28", pcr_target_detect: "yes" },
            { state_territory: "IA", counties_served: "Dakota; Union; Woodbury", site: "543", sample_collect_date: "2026-07-28", pcr_target_detect: "no" },
        ])));
        const result = await getNationalOutlook({ signalId: "measles-detection", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z"), includeAllDetails: true });
        expect(result.details).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "VA:cross-state-site", stateCode: "VA", counties: ["Arlington"] }),
            expect.objectContaining({ id: "MD:cross-state-site", stateCode: "MD", counties: ["Prince George's"] }),
            expect.objectContaining({ id: "NE:543", stateCode: "NE", counties: ["Dakota"] }),
            expect.objectContaining({ id: "SD:543", stateCode: "SD", counties: ["Union"] }),
            expect.objectContaining({ id: "IA:543", stateCode: "IA", counties: ["Woodbury"] }),
        ]));
    });
    it("evicts old derived wastewater periods instead of retaining every month forever", async () => {
        const fetchMock = vi.fn(async () => Response.json([
            { state_territory: "MA", county_fips: "25025", counties_served: "Suffolk", site: "site-1", sample_collect_date: "2026-07-28", pcr_target_detect: "yes" },
        ]));
        vi.stubGlobal("fetch", fetchMock);
        const periods = Array.from({ length: 25 }, (_, index) => new Date(Date.UTC(2023, index, 1)).toISOString().slice(0, 7));
        for (const period of periods) {
            await getNationalOutlook({ signalId: "measles-detection", stateCode: null, period, includeAllDetails: true });
        }
        clearPublisherCache();
        await getNationalOutlook({ signalId: "measles-detection", stateCode: null, period: periods[0], includeAllDetails: true });
        expect(fetchMock).toHaveBeenCalledTimes(periods.length + 1);
    });
    it("maps provisional NNDSS cases as comparable per-capita state incidence", async () => {
        const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => new Response(JSON.stringify([
            { states: "Alabama", year: "2026", week: "29", label: "Pertussis", m1: "10", location1: "Alabama" },
            { states: "Massachusetts", year: "2026", week: "29", label: "Pertussis", m1: "14", location1: "Massachusetts" },
            { states: "Alaska", year: "2026", week: "29", label: "Pertussis", m1: "50", location1: "Alaska" },
        ])));
        vi.stubGlobal("fetch", fetchMock);
        const result = await getNationalOutlook({ signalId: "pertussis-cases", stateCode: "MA", period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.find((state) => state.code === "AL")?.value).toBeCloseTo(10 / 5024279 * 100000);
        expect(result.states.find((state) => state.code === "MA")?.comparisonEligible).toBe(true);
        expect(result.states.map((state) => String(state.code)).some((code) => code === "AK")).toBe(false);
        expect(result.details[0]).toMatchObject({ id: "MA", geographyType: "state" });
        expect(result.geography.level).toBe("statewide");
        expect(result.geography.message).toBe("Statewide observations are available in 2 jurisdictions. No county values are inferred.");
        const where = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("$where");
        expect(where).toContain("year = '2026'");
        expect(where).not.toContain("year >=");
    });
    it("retries a transient CDC access denial before returning a partial outlook", async () => {
        let attempts = 0;
        vi.stubGlobal("fetch", vi.fn(async () => {
            attempts += 1;
            if (attempts === 1)
                return new Response("temporarily denied", { status: 403 });
            return new Response(JSON.stringify([{ states: "Massachusetts", year: "2026", week: "29", label: "Pertussis", m1: "14" }]));
        }));
        const result = await getNationalOutlook({ signalId: "pertussis-cases", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(attempts).toBe(2);
        expect(result.status).toBe("current");
        expect(result.errors).toEqual([]);
    });
    it("reuses a bounded normalized state response instead of refetching county data", async () => {
        const year = new Date().getUTCFullYear();
        const fetchMock = vi.fn(async () => Response.json([{ states: "Massachusetts", year, week: 29, label: "Pertussis", m1: "14" }]));
        vi.stubGlobal("fetch", fetchMock);
        await getNationalOutlook({ signalId: "pertussis-cases", stateCode: "MA", period: null });
        const callsAfterFirstRequest = fetchMock.mock.calls.length;
        await getNationalOutlook({ signalId: "pertussis-cases", stateCode: "MA", period: null });
        expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirstRequest);
    });
    it("runs one computation for concurrent identical state-scoped requests", async () => {
        const year = new Date().getUTCFullYear();
        const fetchMock = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return Response.json([{ states: "Massachusetts", year, week: 29, label: "Pertussis", m1: "14" }]);
        });
        vi.stubGlobal("fetch", fetchMock);
        const [first, second] = await Promise.all([
            getNationalOutlook({ signalId: "pertussis-cases", stateCode: "MA", period: null }),
            getNationalOutlook({ signalId: "pertussis-cases", stateCode: "MA", period: null }),
        ]);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(second).toBe(first);
    });
    it("does not share a computation between different states", async () => {
        const year = new Date().getUTCFullYear();
        const fetchMock = vi.fn(async () => Response.json([{ states: "Massachusetts", year, week: 29, label: "Pertussis", m1: "14" }]));
        vi.stubGlobal("fetch", fetchMock);
        const [massachusetts, california] = await Promise.all([
            getNationalOutlook({ signalId: "pertussis-cases", stateCode: "MA", period: null }),
            getNationalOutlook({ signalId: "pertussis-cases", stateCode: "CA", period: null }),
        ]);
        expect(massachusetts.selectedState).toBe("MA");
        expect(california.selectedState).toBe("CA");
    });
    it("maps live AirNow monitor AQI to county FIPS", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response([
            "07/31/26|250250001|Boston|PM2.5-24hr|UG/M3|8|24|MassDEP|42|0|42.3|-71.0|840250250001",
            "07/31/26|250250002|Boston 2|OZONE-8HR|PPB|31|8|MassDEP|55|1|42.4|-71.1|840250250002",
            "07/31/26|010730001|Birmingham|PM2.5-24hr|UG/M3|8|24|ADEM|33|0|33.5|-86.8|840010730001",
        ].join("\n"))));
        const result = await getNationalOutlook({ signalId: "air-quality", stateCode: "AL", period: null, now: new Date("2026-07-31T12:00:00Z") });
        expect(result.states.find((state) => state.code === "MA")).toMatchObject({ value: 55, displayValue: "55 AQI" });
        expect(result.details).toEqual(expect.arrayContaining([expect.objectContaining({ id: "airnow:010730001", geographyType: "site", value: 33, stateCode: "AL", counties: ["Jefferson"] })]));
        expect(result.geography.level).toBe("county");
    });
    it("reuses warmed AirNow county detail after the raw publisher payload is evicted", async () => {
        const fetchMock = vi.fn(async () => new Response("07/31/26|010730001|Birmingham|PM2.5-24hr|UG/M3|8|24|ADEM|42|0|33.5|-86.8|840010730001"));
        vi.stubGlobal("fetch", fetchMock);
        await getNationalOutlook({ signalId: "air-quality", stateCode: null, period: null, now: new Date("2026-07-31T12:00:00Z") });
        clearPublisherCache();
        const state = await getNationalOutlook({ signalId: "air-quality", stateCode: "AL", period: null, now: new Date("2026-07-31T12:00:00Z") });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(state.details).toEqual([expect.objectContaining({ id: "airnow:010730001", stateCode: "AL", counties: ["Jefferson"] })]);
    });
    it("normalizes county Lyme cases with the public Census population file", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("max%28year%29"))
                return new Response(JSON.stringify([{ year: "2023" }]));
            if (url.includes("group=state%2Cyear"))
                return new Response(JSON.stringify([{ state: "MA", year: "2023", cases: "100" }]));
            if (url.includes("group=fips"))
                return new Response(JSON.stringify([{ fips: "25025", cases: "50" }]));
            if (url.includes("co-est2025-alldata.csv"))
                return new Response("STATE,COUNTY,POPESTIMATE2025\n25,025,800000\n");
            throw new Error(`Unexpected URL ${url}`);
        }));
        const result = await getNationalOutlook({ signalId: "lyme-cases", stateCode: "MA", period: null, now: new Date("2026-07-31T12:00:00Z") });
        expect(result.details).toEqual(expect.arrayContaining([expect.objectContaining({ id: "county:25025", value: 6.25 })]));
        expect(result.geography.message).toBe("County observations are available in 1 jurisdiction. Counties without observations are striped; no county values are inferred.");
    });
    it("keeps an ArboNET county with non-human activity and zero human cases visible", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("co-est2025-alldata.csv")
            ? new Response("STATE,COUNTY,POPESTIMATE2025\n01,001,60000\n01,003,240000\n01,005,25000\n")
            : new Response('"County","Activity","Total human disease cases","Neuroinvasive disease cases"\n01001,"Non-human activity",0,0\n01003,"Non-human activity",-1,0\n01005,"Non-human activity",not available,0')));
        const result = await getNationalOutlook({ signalId: "wnv-activity", stateCode: "AL", period: null, now: new Date("2026-07-31T12:00:00Z") });
        expect(result.details).toEqual([expect.objectContaining({ id: "county:01001", value: 0, displayValue: "0.00 per 100k" })]);
        expect(result.states.find((state) => state.code === "AL")?.value).toBe(0);
        expect(result.details[0].note).toMatch(/non-human activity.*zero human disease cases/i);
    });
    it("serves the bundled CDC B. miyamotoi presence projection without a runtime workbook fetch", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const result = await getNationalOutlook({ signalId: "b-miyamotoi-presence", stateCode: null, period: null, now: new Date("2026-07-31T12:00:00Z"), includeAllDetails: true });
        expect(result.states.find((state) => state.code === "NY")).toMatchObject({ comparisonEligible: false });
        expect(result.details).toHaveLength(399);
        expect(result.details).toEqual(expect.arrayContaining([expect.objectContaining({ id: "county:36119", value: 1, displayValue: "Documented presence", stateCode: "NY", comparisonEligible: false })]));
        expect(result.geography.message).toMatch(/^County observations are available in \d+ jurisdictions\./);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("maps CDC's national tickborne county workbook to real anaplasmosis/babesiosis county detail nationwide, not just Massachusetts", async () => {
        const workbookXlsx = await import("@e965/xlsx");
        const worksheet = workbookXlsx.utils.aoa_to_sheet([
            ["State", "County", "FIPS", "Lyme disease", "Tularemia", "Babesiosis", "Anaplasmosis", "Ehrlichia ewingii ehrlichiosis", "Ehrlichia chaffeensis ehrlichiosis", "Spotted fever rickettsiosis", "Undetermined ehrlichiosis/ anaplasmosis"],
            ["Wisconsin", "Douglas", "55031", 3, 0, 1, 5, 0, 0, 0, 0],
            ["Wisconsin", "Adams", "55001", 0, 0, 0, 0, 0, 0, 0, 0],
        ]);
        const workbook = workbookXlsx.utils.book_new();
        workbookXlsx.utils.book_append_sheet(workbook, worksheet, "sheet 1");
        const buffer = workbookXlsx.write(workbook, { type: "array", bookType: "xlsx" });
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("co-est2025-alldata.csv")
            ? new Response("STATE,COUNTY,POPESTIMATE2025\n55,031,45000\n55,001,21000\n")
            : new Response(buffer, { status: 200 })));
        const result = await getNationalOutlook({ signalId: "anaplasmosis-cases", stateCode: "WI", period: null, now: new Date("2026-07-31T12:00:00Z") });
        expect(result.details).toEqual(expect.arrayContaining([expect.objectContaining({ id: "county:55031", value: 5 / 45000 * 100000, displayValue: "11.1 per 100k", stateCode: "WI", geographyType: "county" })]));
        expect(result.details.find((detail) => detail.id === "county:55001")).toMatchObject({ value: 0, displayValue: "0.0 per 100k" });
        expect(result.geography.message).toBe("County observations are available in 1 jurisdiction. Counties without observations are striped; no county values are inferred.");
    });
    it("does not apply the CDC tickborne county workbook to unrelated signals or historical periods", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => { void input; return new Response(JSON.stringify([{ states: "Wisconsin", year: "2026", week: "10", label: "Pertussis", m1: "5" }])); });
        vi.stubGlobal("fetch", fetchMock);
        await getNationalOutlook({ signalId: "pertussis-cases", stateCode: "WI", period: null, now: new Date("2026-07-31T12:00:00Z") });
        await getNationalOutlook({ signalId: "anaplasmosis-cases", stateCode: "WI", period: "2026-06", now: new Date("2026-07-31T12:00:00Z") });
        expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("AllTBD2022"))).toBe(true);
    });
    it("uses the full NOAA seven-day sample window for HeatRisk", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("getSamples")
            ? new Response(JSON.stringify({ samples: [{ locationId: 0, value: "1" }, { locationId: 0, value: "3" }, { locationId: 1, value: "2" }] }))
            : new Response(JSON.stringify({ timeInfo: { timeExtent: [Date.parse("2026-07-28T12:00:00Z"), Date.parse("2026-08-05T12:00:00Z")] } }))));
        const result = await getNationalOutlook({ signalId: "heatrisk", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states[0]).toMatchObject({ value: 3, comparisonEligible: true });
        expect(result.states[1]).toMatchObject({ value: 2, comparisonEligible: true });
    });
    it("hard-expires a NOAA HeatRisk window after its valid end", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("getSamples")
            ? new Response(JSON.stringify({ samples: [{ locationId: 0, value: "4" }] }))
            : new Response(JSON.stringify({ timeInfo: { timeExtent: [Date.parse("2026-07-20T12:00:00Z"), Date.parse("2026-07-27T12:00:00Z")] } }))));
        const result = await getNationalOutlook({ signalId: "heatrisk", stateCode: null, period: null, now: new Date("2026-07-29T12:00:00Z") });
        expect(result.states.every((state) => state.value === null && !state.comparisonEligible)).toBe(true);
    });
});
describe("county population reuse", () => {
    it("parses the Census county file once across county requests for different states", async () => {
        const censusCsv = [
            "SUMLEV,STATE,COUNTY,STNAME,CTYNAME,POPESTIMATE2025",
            "050,25,017,Massachusetts,Middlesex County,1632002",
            "050,48,201,Texas,Harris County,4835125",
        ].join("\n");
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = decodeURIComponent(String(input));
            if (url.includes("census.gov"))
                return new Response(censusCsv);
            if (url.includes("max(year)"))
                return Response.json([{ year: 2023 }]);
            if (url.includes("$group=state"))
                return Response.json([{ state: "MA", year: 2023, cases: "100" }]);
            return Response.json([{ fips: "25017", cases: "42" }]);
        });
        vi.stubGlobal("fetch", fetchMock);
        await getNationalOutlook({ signalId: "lyme-cases", stateCode: "MA", period: null });
        await getNationalOutlook({ signalId: "lyme-cases", stateCode: "TX", period: null });
        const censusFetches = fetchMock.mock.calls.filter(([input]) => String(input).includes("census.gov"));
        expect(censusFetches).toHaveLength(1);
    });
});
describe("historical months are the month's average, not its last week", () => {
    const week = (weekEnd: string, covid: number | undefined, geography = "Massachusetts") => ({
        week_end: weekEnd, geography, county: "All", hsa_nci_id: "All", trend_source: "State",
        percent_visits_covid: covid, percent_visits_influenza: 1, percent_visits_rsv: 1,
        ed_trends_covid: "No Change", ed_trends_influenza: "No Change", ed_trends_rsv: "No Change",
    });
    const stubWeeks = (rows: unknown[]) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rows))));
    const massachusetts = (outlook: Awaited<ReturnType<typeof getNationalOutlook>>) => outlook.states.find((state) => state.code === "MA");
    it("averages every reporting week in the requested month", async () => {
        stubWeeks([
            week("2024-03-02T00:00:00.000", 2),
            week("2024-03-09T00:00:00.000", 4),
            week("2024-03-16T00:00:00.000", 6),
            week("2024-03-23T00:00:00.000", 8),
        ]);
        const outlook = await getNationalOutlook({ signalId: "covid-ed", stateCode: "MA", period: "2024-03", recompute: true });
        expect(massachusetts(outlook)?.value).toBeCloseTo(5, 10);
    });
    it("still reports the latest week for the current view", async () => {
        stubWeeks([
            week("2026-08-15T00:00:00.000", 2),
            week("2026-08-22T00:00:00.000", 9),
        ]);
        const outlook = await getNationalOutlook({ signalId: "covid-ed", stateCode: "MA", period: null });
        expect(massachusetts(outlook)?.value).toBe(9);
    });
    it("leaves a measure absent rather than averaging it to zero when no week reported it", async () => {
        stubWeeks([
            week("2024-03-02T00:00:00.000", undefined),
            week("2024-03-09T00:00:00.000", undefined),
        ]);
        const outlook = await getNationalOutlook({ signalId: "covid-ed", stateCode: "MA", period: "2024-03", recompute: true });
        expect(massachusetts(outlook)?.value).toBeNull();
    });
    it("averages each state independently", async () => {
        stubWeeks([
            week("2024-03-02T00:00:00.000", 2), week("2024-03-09T00:00:00.000", 4),
            week("2024-03-02T00:00:00.000", 10, "California"), week("2024-03-09T00:00:00.000", 20, "California"),
        ]);
        const outlook = await getNationalOutlook({ signalId: "covid-ed", stateCode: null, period: "2024-03", recompute: true });
        expect(massachusetts(outlook)?.value).toBeCloseTo(3, 10);
        expect(outlook.states.find((state) => state.code === "CA")?.value).toBeCloseTo(15, 10);
    });
});
describe("resolution trace", () => {
    it("reports that an answer was computed when nothing is stored", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]))));
        const trace: OutlookTrace = {};
        await getNationalOutlook({ signalId: "covid-ed", stateCode: "MA", period: null, trace });
        expect(trace.source).toBe("computed");
    });
    it("reports the in-memory cache on an immediate repeat", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]))));
        await getNationalOutlook({ signalId: "covid-ed", stateCode: "MA", period: null });
        const trace: OutlookTrace = {};
        await getNationalOutlook({ signalId: "covid-ed", stateCode: "MA", period: null, trace });
        expect(trace.source).toBe("memory-cache");
    });
});
