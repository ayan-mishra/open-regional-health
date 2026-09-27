import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const hsaIds = ["112", "68", "74", "32", "22", "101"];
const countyFips = ["25001", "25003", "25005", "25007", "25009", "25011", "25013", "25015", "25017", "25019", "25021", "25023", "25025", "25027"];
function respiratoryRow(id: string) {
    return {
        week_end: "2026-07-18",
        county: id === "All" ? "Massachusetts" : "HSA",
        hsa_nci_id: id,
        percent_visits_covid: "0.1",
        percent_visits_influenza: "0.2",
        percent_visits_rsv: "0.3",
        ed_trends_covid: "No Change",
        ed_trends_influenza: "Increasing",
        ed_trends_rsv: "Decreasing",
        buildnumber: "2026-07-24",
    };
}
describe("live outlook public-data connectors", () => {
    beforeEach(() => vi.resetModules());
    afterEach(() => vi.unstubAllGlobals());
    it("returns county Lyme cases and county wastewater detections from the official CDC feeds", async () => {
        const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            void init;
            const url = new URL(String(input));
            let payload: unknown;
            if (url.pathname.endsWith("/rdmq-nq56.json")) {
                payload = [respiratoryRow("All"), ...hsaIds.map(respiratoryRow)];
            }
            else if (url.pathname.endsWith("/x5j9-wybp.json") && url.searchParams.get("$select") === "max(year) as year") {
                payload = [{ year: "2023" }];
            }
            else if (url.pathname.endsWith("/x5j9-wybp.json")) {
                payload = countyFips.map((fips, index) => ({ fips, cases: String(index + 1) }));
            }
            else if (url.pathname.endsWith("/ymmh-divb.json")) {
                payload = [{ sample_collect_date: "2026-07-20", site: "flu-site", county_fips: "25017", pcr_target_detect: "no" }];
            }
            else if (url.pathname.endsWith("/j9g8-acpt.json")) {
                payload = [
                    { sample_collect_date: "2026-07-20", site: "covid-a", county_fips: "25017, 25025", pcr_target_detect: "yes" },
                    { sample_collect_date: "2026-07-19", site: "covid-b", county_fips: "25013", pcr_target_detect: "no" },
                ];
            }
            else if (url.pathname.endsWith("/45cq-cw4i.json")) {
                payload = [{ sample_collect_date: "2026-07-20", site: "rsv-site", county_fips: "25027", pcr_target_detect: "yes" }];
            }
            else if (url.pathname.endsWith("/akvg-8vrb.json")) {
                payload = [{ sample_collect_date: "2026-07-20", site: "measles-site", county_fips: "25013", pcr_target_detect: "no" }];
            }
            else if (url.pathname.endsWith("/mtpu-urpp.json")) {
                payload = [{ sample_collect_date: "2026-07-20", site: "h5-site", county_fips: "25017", pcr_target_detect: "no" }];
            }
            else if (url.pathname.endsWith("/xpxn-rzgz.json")) {
                payload = [{ sample_collect_date: "2026-07-20", site: "mpox-site", county_fips: "25025", pcr_target_detect: "yes" }];
            }
            else if (url.pathname.endsWith("/ua7e-t2fy.json")) {
                payload = [{ weekendingdate: "2026-07-18", totalconfflunewadm: "2", totalconfflunewadmhosprep: "80", totalconfflunewadmperchosprep: "95" }];
            }
            else {
                return new Response("not found", { status: 404 });
            }
            return Response.json(payload);
        });
        vi.stubGlobal("fetch", fetchMock);
        const { getLiveRespiratoryOutlook } = await import("@/lib/outlook-live");
        const result = await getLiveRespiratoryOutlook();
        expect(result.status).toBe("live");
        expect(result.auxiliary.lyme).toMatchObject({ observedYear: 2023, totalCases: 105 });
        expect(result.auxiliary.lyme.countyCases.MIDDLESEX).toBe(9);
        expect(result.auxiliary.wastewater.influenzaA.counties.MIDDLESEX).toEqual({ sitesReporting: 1, detectedSites: 0 });
        expect(result.auxiliary.wastewater.sarsCov2).toMatchObject({ sitesReporting: 2, detectedSites: 1 });
        expect(result.auxiliary.wastewater.sarsCov2.counties.SUFFOLK).toEqual({ sitesReporting: 1, detectedSites: 1 });
        expect(result.auxiliary.wastewater.rsv.counties.WORCESTER).toEqual({ sitesReporting: 1, detectedSites: 1 });
        expect(result.auxiliary.wastewater.measles.counties.HAMPDEN).toEqual({ sitesReporting: 1, detectedSites: 0 });
        expect(result.auxiliary.wastewater.influenzaAH5.counties.MIDDLESEX).toEqual({ sitesReporting: 1, detectedSites: 0 });
        expect(result.auxiliary.wastewater.mpox.counties.SUFFOLK).toEqual({ sitesReporting: 1, detectedSites: 1 });
        expect(result.sourceWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ source: "MassDPH arbovirus" })]));
        expect(fetchMock.mock.calls.find(([input]) => String(input).includes("reportingarea.dat"))?.[1]).toMatchObject({ cache: "no-store" });
    });
    it("rejects the atomic feed when any required auxiliary connector fails", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith("/rdmq-nq56.json"))
                return Response.json([respiratoryRow("All"), ...hsaIds.map(respiratoryRow)]);
            return new Response("publisher unavailable", { status: 503 });
        }));
        const { getLiveRespiratoryOutlook } = await import("@/lib/outlook-live");
        await expect(getLiveRespiratoryOutlook({ strict: true })).rejects.toThrow(/connector failed/);
    });
    it("reads scoped, dense workbook sheets exactly as a full parse would", async () => {
        const XLSX = await import("@e965/xlsx");
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Ignore this sheet"]]), "Introduction");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ["Hospital name", "Street", "City", "County", "Zip", "Phone", "Beds", "Town"],
            ["Mercy Hospital", "1 Main St", "Springfield", "Hampden", "01103", "555", "100", "Springfield"],
        ]), "Hospital Information");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(Array.from({ length: 500 }, (_, index) => [`filler ${index}`, index])), "Nursing Home Data");
        const parsed = XLSX.read(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer, { type: "array", cellDates: true, dense: true, sheets: ["Hospital Information"] });
        expect(Object.keys(parsed.Sheets)).toEqual(["Hospital Information"]);
        expect(XLSX.utils.sheet_to_json(parsed.Sheets["Hospital Information"], { header: 1, defval: null, raw: true })).toEqual([
            ["Hospital name", "Street", "City", "County", "Zip", "Phone", "Beds", "Town"],
            ["Mercy Hospital", "1 Main St", "Springfield", "Hampden", "01103", "555", "100", "Springfield"],
        ]);
    });
    it("discovers only the current official capacity workbook from the dashboard page", async () => {
        const { capacityWorkbookUrlFromPage } = await import("@/lib/outlook-live");
        const html = `
      <a href="/doc/health-care-capacity-data/download">Archived data</a>
      <a href="/doc/health-care-capacity-data-file-71626/download">Download the data file</a>
    `;
        expect(capacityWorkbookUrlFromPage(html)).toBe("https://www.mass.gov/doc/health-care-capacity-data-file-71626/download");
        expect(() => capacityWorkbookUrlFromPage('<a href="https://example.com/doc/health-care-capacity-data-file-71626/download">Download</a>')).toThrow(/official current workbook/i);
        expect(() => capacityWorkbookUrlFromPage("<p>No current workbook</p>")).toThrow(/official current workbook/i);
    });
    it("maps official capacity workbook bed columns without mixing available and staffed beds", async () => {
        const { capacityBedTotals } = await import("@/lib/outlook-live");
        const header = Array<string | null>(22).fill(null);
        const row = Array<number | null>(22).fill(null);
        header[5] = "Available adult medical surgical beds (average)";
        header[6] = "Available adult ICU beds (average)";
        header[7] = "Available pediatric medical surgical beds (average)";
        header[8] = "Available pediatric ICU beds (average)";
        header[15] = "Staffed adult medical surgical beds (average)";
        header[17] = "Staffed adult ICU beds (average)";
        header[19] = "Staffed pediatric medical surgical beds (average)";
        header[21] = "Staffed pediatric ICU beds (average)";
        row[5] = 10;
        row[6] = 2;
        row[7] = 3;
        row[8] = 1;
        row[15] = 100;
        row[17] = 20;
        row[19] = 30;
        row[21] = 5;
        expect(capacityBedTotals(header, row)).toEqual({
            availableBeds: 13,
            availableIcuBeds: 3,
            staffedBeds: 130,
            staffedIcuBeds: 25,
        });
    });
    it("accepts only current AirNow rows on the official AQI scale with valid timestamps", async () => {
        const { airQualityFromAirNow } = await import("@/lib/outlook-live");
        const line = (aqi: string, time = "21:00") => [
            "08/03/26", "08/03/26", time, "EDT", "0", "O", "Y", "Boston Metro", "MA",
            "42.3601", "-71.0589", "PM2.5", aqi, "Good", "No", "", "MassDEP",
        ].join("|");
        expect(airQualityFromAirNow(line("42"))).toMatchObject({
            observedThrough: "2026-08-03T21:00:00-04:00",
            statewideMaxAqi: 42,
            counties: { SUFFOLK: { aqi: 42, category: "Good", pollutant: "PM2.5", reportingArea: "Boston Metro" } },
        });
        expect(() => airQualityFromAirNow(line("999"))).toThrow(/no current Massachusetts observations/i);
        expect(() => airQualityFromAirNow(line("42", "not-a-time"))).toThrow(/no current Massachusetts observations/i);
    });
    it("rejects HeatRisk categories outside NOAA's 0 to 4 scale", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({
            value: "999",
            properties: { Values: ["999"] },
            catalogItems: { features: [{ attributes: { idp_validtime: "1785796800000" } }] },
        })));
        const { getHeatRiskContext } = await import("@/lib/outlook-live");
        await expect(getHeatRiskContext()).rejects.toThrow();
    });
    it("rejects an empty HeatRisk county sample set instead of publishing an empty live layer", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({
            value: null,
            properties: { Values: [] },
            catalogItems: { features: [{ attributes: { idp_validtime: "1785796800000" } }] },
        })));
        const { getHeatRiskContext } = await import("@/lib/outlook-live");
        await expect(getHeatRiskContext()).rejects.toThrow(/no county observations/i);
    });
    it("rejects impossible Massachusetts hospital reporting percentages", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith("/rdmq-nq56.json"))
                return Response.json([respiratoryRow("All"), ...hsaIds.map(respiratoryRow)]);
            if (url.pathname.endsWith("/ua7e-t2fy.json"))
                return Response.json([{
                        weekendingdate: "2026-07-18",
                        totalconfflunewadm: "2",
                        totalconfflunewadmhosprep: "80",
                        totalconfflunewadmperchosprep: "101",
                    }]);
            return new Response("publisher unavailable", { status: 503 });
        }));
        const { getLiveRespiratoryOutlook } = await import("@/lib/outlook-live");
        const result = await getLiveRespiratoryOutlook();
        expect(result.auxiliary.hospital.reportingPercent).not.toBe(101);
        expect(result.sourceWarnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: "CDC hospital" }),
        ]));
    });
    it("rejects Massachusetts respiratory shares above 100 percent", async () => {
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = new URL(String(input));
            if (!url.pathname.endsWith("/rdmq-nq56.json"))
                return new Response("publisher unavailable", { status: 503 });
            return Response.json([
                { ...respiratoryRow("All"), percent_visits_covid: "101" },
                ...hsaIds.map(respiratoryRow),
            ]);
        }));
        const { getLiveRespiratoryOutlook } = await import("@/lib/outlook-live");
        await expect(getLiveRespiratoryOutlook()).rejects.toThrow();
    });
});
describe("MassDPH capacity workbook column mapping", () => {
    const HOSPITAL_SHEET = [
        ["Hospital", "ZIP code", "IDNUMBER", "Short name", "Address", "Town", "CHIA region", "Telephone"],
        ["Athol Memorial Hospital", "01331", "2226", "Athol", "2033 Main Street", "Athol", "Central Massachusetts", "(978) 249-3511"],
        ["Cape Cod Hospital", "02601", "2100", "Cape Cod", "27 Park Street", "Hyannis", "Southeast", "(508) 771-1800"],
    ];
    const bedColumns = (hospital: string, month: string, available: number, icu: number, staffed: number, staffedIcu: number) => ({
        "Hospital name ": hospital,
        "Year": "2026",
        "Available adult medical surgical beds (average)": available,
        "Available adult ICU beds (average)": icu,
        "Available pediatric medical surgical beds (average)": 0,
        "Available pediatric ICU beds (average)": 0,
        "Facility ID": "2039",
        "Month": month,
        "Staffed adult medical surgical beds (average)": staffed,
        "Staffed adult ICU beds (average)": staffedIcu,
        "Staffed pediatric medical surgical beds (average)": 0,
        "Staffed pediatric ICU beds (average)": 0,
    });
    const sheetFrom = (records: Record<string, unknown>[], order?: string[]) => {
        const header = order ?? Object.keys(records[0]);
        return [header, ...records.map((record) => header.map((name) => record[name] ?? null))];
    };
    const BED_RECORDS = [
        bedColumns("Athol Memorial Hospital", "July", 10.5, 2.5, 40, 8),
        bedColumns("Cape Cod Hospital", "July", 20, 4, 60, 12),
        bedColumns("Athol Memorial Hospital", "June", 99, 99, 99, 99),
    ];
    const ED_SHEET = [
        ["Month", "Year", "Hospital", "Percent of ED visits that discontinued care", "Average length of stay in the ED", "Total ED visits", "Last updated"],
        ["July", "2026", "Athol Memorial Hospital", 0.05, 300, 1000, "2026-08-21"],
        ["July", "2026", "Cape Cod Hospital", 0.02, 200, 1000, "2026-08-21"],
        ["June", "2026", "Athol Memorial Hospital", 0.09, 999, 999, "2026-08-21"],
    ];
    const AMBULANCE_SHEET = [
        ["Starting town/city", "Destination hospital", "Month", "Year", "Number of emergency runs", "Last updated"],
        ["Athol", "Athol Memorial Hospital", "July", "2026", 7, "2026-08-21"],
        ["Hyannis", "Cape Cod Hospital", "July", "2026", 11, "2026-08-21"],
    ];
    const TOWN_TO_COUNTY = { athol: "WORCESTER", hyannis: "BARNSTABLE" };
    async function stubWorkbook(bedSheet: unknown[][], edSheet: unknown[][] = ED_SHEET, ambulanceSheet: unknown[][] = AMBULANCE_SHEET) {
        const XLSX = await import("@e965/xlsx");
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(HOSPITAL_SHEET), "Hospital Information");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(bedSheet), "Inpatient Beds Data");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(edSheet), "Emergency Department Data");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(ambulanceSheet), "Ambulance Trip Data");
        const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
        vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
            const url = String(input);
            if (url.includes("/doc/health-care-capacity-data-file-"))
                return new Response(buffer);
            return new Response('<a href="/doc/health-care-capacity-data-file-8-21-2026/download">workbook</a>');
        }));
    }
    it("reads the live 2026 column layout and aggregates hospitals into counties", async () => {
        await stubWorkbook(sheetFrom(BED_RECORDS));
        const { getCapacityContext } = await import("@/lib/outlook-live");
        const capacity = await getCapacityContext(TOWN_TO_COUNTY);
        expect(capacity.observedThrough).toBe("2026-07-01");
        expect(capacity.counties.WORCESTER).toEqual({
            availableBeds: 10.5, availableIcuBeds: 2.5, staffedBeds: 40, staffedIcuBeds: 8,
            edVisits: 1000, edLengthOfStayMinutes: 300, ambulanceRuns: 7,
        });
        expect(capacity.counties.BARNSTABLE).toMatchObject({ availableBeds: 20, availableIcuBeds: 4, edVisits: 1000, edLengthOfStayMinutes: 200, ambulanceRuns: 11 });
    });
    it("is unaffected by a publisher reshuffling the columns", async () => {
        const shuffled = [...Object.keys(BED_RECORDS[0])].reverse();
        await stubWorkbook(sheetFrom(BED_RECORDS, shuffled));
        const { getCapacityContext } = await import("@/lib/outlook-live");
        const capacity = await getCapacityContext(TOWN_TO_COUNTY);
        expect(capacity.counties.WORCESTER).toMatchObject({ availableBeds: 10.5, availableIcuBeds: 2.5, edVisits: 1000 });
        expect(capacity.observedThrough).toBe("2026-07-01");
    });
    it("fails loudly naming the column when the publisher renames one", async () => {
        const renamed = sheetFrom(BED_RECORDS);
        renamed[0] = (renamed[0] as string[]).map((name) => name === "Month" ? "Reporting month" : name);
        await stubWorkbook(renamed);
        const { getCapacityContext } = await import("@/lib/outlook-live");
        await expect(getCapacityContext(TOWN_TO_COUNTY)).rejects.toThrow("Capacity workbook is missing column: Month");
    });
});
