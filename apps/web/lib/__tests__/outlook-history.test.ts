import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/outlook-live", () => ({
    getHistoricalCapacityContext: vi.fn(() => Promise.reject(new Error("No capacity month"))),
}));
const hsaIds = ["112", "68", "74", "32", "22", "101"];
function airQualityArchive(aqi: string) {
    const csv = [
        '"State Name","county Name","State Code","County Code","Date","AQI","Category","Defining Parameter","Defining Site","Number of Sites Reporting"',
        `"Massachusetts","Middlesex","25","017","2022-10-15",${aqi},"Moderate","PM2.5","25-017-0001",1`,
    ].join("\n");
    return Uint8Array.from(zipSync({ "daily_aqi_by_county_2022.csv": strToU8(csv) }));
}
function tickTable(value: string) {
    return `
    <table>
      <caption>Tickborne Diseases Reported in Massachusetts, 2025</caption>
      <tr><th>Disease</th><th>2025</th></tr>
      <tr><td>Lyme Disease</td><td>${value}</td></tr>
      <tr><td>Human Granulocytic Anaplasmosis</td><td>100</td></tr>
      <tr><td>Babesiosis</td><td>50</td></tr>
      <tr><td>Borrelia miyamotoi</td><td>12</td></tr>
      <tr><td>Powassan virus</td><td>3</td></tr>
    </table>
  `;
}
describe("historical map snapshots", () => {
    beforeEach(() => vi.resetModules());
    afterEach(() => vi.unstubAllGlobals());
    it("accepts months from 2018 through the present and rejects other periods", async () => {
        const { isValidHistoryPeriod } = await import("@/lib/outlook-history");
        const now = new Date("2026-07-29T12:00:00Z");
        expect(isValidHistoryPeriod("2018-01", now)).toBe(true);
        expect(isValidHistoryPeriod("2026-07", now)).toBe(true);
        expect(isValidHistoryPeriod("2017-12", now)).toBe(false);
        expect(isValidHistoryPeriod("2026-08", now)).toBe(false);
        expect(isValidHistoryPeriod("2022-13", now)).toBe(false);
    });
    it("builds one period-specific map payload and marks unsupported layers unavailable", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = new URL(String(input));
            if (url.hostname === "aqs.epa.gov")
                return new Response("not found", { status: 404 });
            if (url.hostname === "www.mass.gov")
                return new Response("not found", { status: 404 });
            if (url.pathname.endsWith("/rdmq-nq56.json")) {
                const row = (id: string) => ({ week_end: "2022-10-29T00:00:00.000", county: id === "All" ? "Massachusetts" : "HSA", hsa_nci_id: id, percent_visits_covid: "2.1", percent_visits_influenza: "1.2", percent_visits_rsv: "0.7", ed_trends_covid: "Increasing", ed_trends_influenza: "No Change", ed_trends_rsv: "Decreasing", buildnumber: "2022-11-01" });
                return Response.json([row("All"), ...hsaIds.map(row)]);
            }
            if (url.pathname.endsWith("/x5j9-wybp.json"))
                return Response.json([{ fips: "25017", cases: "123" }]);
            if (url.pathname.endsWith("/ua7e-t2fy.json"))
                return Response.json([{ weekendingdate: "2022-10-29", totalconfflunewadm: "8", totalconfflunewadmhosprep: "70", totalconfflunewadmperchosprep: "90" }]);
            return Response.json([{ sample_collect_date: "2022-10-28", site: "site-1", county_fips: "25017", pcr_target_detect: "yes" }]);
        }));
        const { getHistoricalOutlook } = await import("@/lib/outlook-history");
        const outlook = await getHistoricalOutlook("2022-10");
        expect(outlook.status).toBe("historical");
        expect(outlook.view?.requestedPeriod).toBe("2022-10");
        expect(outlook.state.values.covid).toBe(2.1);
        expect(outlook.auxiliary.wastewater.influenzaA.counties.MIDDLESEX).toEqual({ sitesReporting: 1, detectedSites: 1 });
        expect(outlook.auxiliary.lyme.countyCases.MIDDLESEX).toBe(123);
        expect(outlook.view?.layers["respiratory:0"].available).toBe(true);
        expect(outlook.view?.layers["environment:0"].available).toBe(false);
    });
    it("rejects an atomic historical issue on connector failure", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("publisher unavailable", { status: 503 })));
        const { getHistoricalOutlook } = await import("@/lib/outlook-history");
        await expect(getHistoricalOutlook("2022-10", { strict: true })).rejects.toThrow(/historical connector failed/);
    });
    it("keeps missing historical publisher numerics unavailable instead of fabricating zeroes", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith("/rdmq-nq56.json")) {
                const row = (id: string) => ({
                    week_end: "2022-10-29T00:00:00.000",
                    county: id === "All" ? "Massachusetts" : "HSA",
                    hsa_nci_id: id,
                    percent_visits_covid: id === "All" ? "" : "2.1",
                    percent_visits_influenza: "1.2",
                    percent_visits_rsv: "0.7",
                    ed_trends_covid: "Increasing",
                    ed_trends_influenza: "No Change",
                    ed_trends_rsv: "Decreasing",
                    buildnumber: "2022-11-01",
                });
                return Response.json([row("All"), ...hsaIds.map(row)]);
            }
            if (url.pathname.endsWith("/ua7e-t2fy.json")) {
                return Response.json([{
                        weekendingdate: "2022-10-29",
                        totalconfflunewadm: "",
                        totalconfflunewadmhosprep: "70",
                        totalconfflunewadmperchosprep: "90",
                    }]);
            }
            if (url.pathname.endsWith("/x5j9-wybp.json")) {
                return Response.json([{ fips: "25017", cases: "" }]);
            }
            return new Response("publisher unavailable", { status: 503 });
        }));
        const { getHistoricalOutlook } = await import("@/lib/outlook-history");
        const outlook = await getHistoricalOutlook("2022-10");
        expect(outlook.view?.layers["respiratory:0"].available).toBe(false);
        expect(outlook.view?.layers["hospital:0"].available).toBe(false);
        expect(outlook.view?.layers["ticks:0"].available).toBe(false);
        expect(outlook.sourceWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: "CDC respiratory" }),
            expect.objectContaining({ source: "CDC hospital" }),
            expect.objectContaining({ source: "CDC Lyme" }),
        ]));
    });
    it("reads the publisher's county-name field from historical EPA AirData archives", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = new URL(String(input));
            return url.hostname === "aqs.epa.gov"
                ? new Response(airQualityArchive("42"))
                : new Response("publisher unavailable", { status: 503 });
        }));
        const { getHistoricalOutlook } = await import("@/lib/outlook-history");
        const outlook = await getHistoricalOutlook("2022-10");
        expect(outlook.view?.layers["environment:1"].available).toBe(true);
        expect(outlook.auxiliary.environment.airQuality.counties.MIDDLESEX).toMatchObject({
            aqi: 42,
            reportingArea: "Middlesex County",
        });
    });
    it("rejects historical EPA AQI values outside the official 0 to 500 scale", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = new URL(String(input));
            return url.hostname === "aqs.epa.gov"
                ? new Response(airQualityArchive("999"))
                : new Response("publisher unavailable", { status: 503 });
        }));
        const { getHistoricalOutlook } = await import("@/lib/outlook-history");
        const outlook = await getHistoricalOutlook("2022-10");
        expect(outlook.view?.layers["environment:1"].available).toBe(false);
        expect(outlook.sourceWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: "EPA AirData" }),
        ]));
    });
    it("keeps blank MassDPH historical tick counts unavailable instead of fabricating zero", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = new URL(String(input));
            return url.hostname === "www.mass.gov"
                ? new Response(tickTable(""))
                : new Response("publisher unavailable", { status: 503 });
        }));
        const { getHistoricalOutlook } = await import("@/lib/outlook-history");
        const outlook = await getHistoricalOutlook("2025-10");
        expect(outlook.view?.layers["ticks:1"].available).toBe(false);
        expect(outlook.auxiliary.tickState.cases.Lyme).not.toBe(0);
        expect(outlook.sourceWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: "MassDPH tick" }),
        ]));
    });
});
