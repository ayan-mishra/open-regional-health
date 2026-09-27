import "server-only";
import { z } from "zod";
import * as XLSX from "@e965/xlsx";
import { LAST_VALID_OUTLOOK, REGION_META, type RegionOutlook, type RespiratoryOutlook, type Trend, type WastewaterTargetOutlook, type MosquitoRisk, } from "@/lib/outlook-contracts";
import { nonNegativePublisherNumber, optionalNonNegativePublisherNumber, publisherPercentage } from "@/lib/publisher-values";
import { cachedPublisherFetch } from "@/lib/publisher-cache";
const CDC_NSSP_ENDPOINT = "https://data.cdc.gov/resource/rdmq-nq56.json";
const CDC_LYME_ENDPOINT = "https://data.cdc.gov/resource/x5j9-wybp.json";
const CDC_TICK_COUNTY_WORKBOOK_ENDPOINT = "https://www.cdc.gov/ticks/media/files/2024/05/AllTBD2022_Public.xlsx";
const CDC_INFLUENZA_WASTEWATER_ENDPOINT = "https://data.cdc.gov/resource/ymmh-divb.json";
const CDC_COVID_WASTEWATER_ENDPOINT = "https://data.cdc.gov/resource/j9g8-acpt.json";
const CDC_RSV_WASTEWATER_ENDPOINT = "https://data.cdc.gov/resource/45cq-cw4i.json";
const CDC_MEASLES_WASTEWATER_ENDPOINT = "https://data.cdc.gov/resource/akvg-8vrb.json";
const CDC_H5_WASTEWATER_ENDPOINT = "https://data.cdc.gov/resource/mtpu-urpp.json";
const CDC_MPOX_WASTEWATER_ENDPOINT = "https://data.cdc.gov/resource/xpxn-rzgz.json";
const ARBOVIRUS_WORKBOOK_ENDPOINT = `https://www.mass.gov/doc/${new Date().getUTCFullYear()}-eee-and-wnv-risk-level-and-data/download`;
const CAPACITY_DASHBOARD_ENDPOINT = "https://www.mass.gov/info-details/health-care-capacity-interactive-dashboard";
const BEACH_CLOSURES_ENDPOINT = "https://datavisualization.dph.mass.gov/views/BeachWaterQualityDashboard/Closures.csv?:refresh=y";
const BEACH_RESULTS_ENDPOINT = "https://datavisualization.dph.mass.gov/views/BeachWaterQualityDashboard/ResultsTable.csv?:refresh=y";
const BEACH_MAP_ENDPOINT = "https://datavisualization.dph.mass.gov/views/BeachWaterQualityDashboard/BeachesMap.csv?:refresh=y";
const HEATRISK_ENDPOINT = "https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer";
const AIRNOW_ENDPOINT = "https://files.airnowtech.org/airnow/today/reportingarea.dat";
const TICK_SURVEILLANCE_ENDPOINT = "https://www.mass.gov/lists/tick-borne-disease-surveillance-summaries-and-data";
const twelveHours = 43200;
const PUBLIC_WORKBOOK_HEADERS = {
    Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, */*",
    "User-Agent": "Corvid Health Intelligence public-data connector",
};
const MASS_PUBLISHER_HEADERS = {
    Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, text/html, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    Referer: "https://www.mass.gov/",
    "User-Agent": "Mozilla/5.0 Corvid-Health-Intelligence/1.0",
};
const COUNTY_FIPS_TO_KEY: Record<string, string> = {
    "25001": "BARNSTABLE", "25003": "BERKSHIRE", "25005": "BRISTOL", "25007": "DUKES",
    "25009": "ESSEX", "25011": "FRANKLIN", "25013": "HAMPDEN", "25015": "HAMPSHIRE",
    "25017": "MIDDLESEX", "25019": "NANTUCKET", "25021": "NORFOLK", "25023": "PLYMOUTH",
    "25025": "SUFFOLK", "25027": "WORCESTER",
};
const rowSchema = z.object({
    week_end: z.string(),
    county: z.string(),
    hsa_nci_id: z.string(),
    percent_visits_covid: publisherPercentage,
    percent_visits_influenza: publisherPercentage,
    percent_visits_rsv: publisherPercentage,
    ed_trends_covid: z.enum(["Increasing", "No Change", "Decreasing"]),
    ed_trends_influenza: z.enum(["Increasing", "No Change", "Decreasing"]),
    ed_trends_rsv: z.enum(["Increasing", "No Change", "Decreasing"]),
    buildnumber: z.string(),
});
const wastewaterRowSchema = z.object({
    sample_collect_date: z.string(),
    site: z.string(),
    county_fips: z.string(),
    pcr_target_detect: z.string().optional(),
});
const lymeRowSchema = z.object({
    fips: z.string(),
    cases: nonNegativePublisherNumber.pipe(z.number().int().nonnegative()),
});
const hospitalRowSchema = z.object({
    weekendingdate: z.string(),
    totalconfflunewadm: nonNegativePublisherNumber,
    totalconfflunewadmhosprep: nonNegativePublisherNumber,
    totalconfflunewadmperchosprep: publisherPercentage,
});
function isoDate(value: string): string {
    return value.slice(0, 10);
}
const COUNTY_CENTROIDS: Record<string, [
    number,
    number
]> = {
    BARNSTABLE: [-70.3, 41.7], BERKSHIRE: [-73.21, 42.37], BRISTOL: [-71.09, 41.75], DUKES: [-70.67, 41.39],
    ESSEX: [-70.95, 42.64], FRANKLIN: [-72.62, 42.58], HAMPDEN: [-72.63, 42.14], HAMPSHIRE: [-72.66, 42.34],
    MIDDLESEX: [-71.39, 42.48], NANTUCKET: [-70.1, 41.28], NORFOLK: [-71.18, 42.17], PLYMOUTH: [-70.77, 41.99],
    SUFFOLK: [-71.1, 42.3], WORCESTER: [-71.91, 42.31],
};
const AIRNOW_AREAS: Record<string, string[]> = {
    Berkshire: ["BERKSHIRE"], "Boston Metro": ["SUFFOLK", "MIDDLESEX"],
    "Cape Cod and Islands": ["BARNSTABLE", "DUKES", "NANTUCKET"], Essex: ["ESSEX"], Franklin: ["FRANKLIN"],
    "Hampden-Hampshire": ["HAMPDEN", "HAMPSHIRE"], Norfolk: ["NORFOLK"],
    "North Bristol-Plymouth": ["BRISTOL", "PLYMOUTH"], "South Bristol-Plymouth": ["BRISTOL", "PLYMOUTH"],
    "West Middlesex": ["MIDDLESEX"], Worcester: ["WORCESTER"],
};
const MONTH_NUMBER: Record<string, number> = {
    January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
    July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};
async function fetchWorkbook(url: string, sheets?: readonly string[]): Promise<XLSX.WorkBook> {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(10000), cache: "no-store",
        headers: url.includes("mass.gov") ? MASS_PUBLISHER_HEADERS : PUBLIC_WORKBOOK_HEADERS,
    });
    if (!response.ok)
        throw new Error(`Massachusetts workbook responded with ${response.status}`);
    return XLSX.read(await response.arrayBuffer(), { type: "array", cellDates: true, dense: true, ...(sheets ? { sheets: [...sheets] } : {}) });
}
function worksheetRows(workbook: XLSX.WorkBook, name: string): unknown[][] {
    const sheet = workbook.Sheets[name];
    if (!sheet)
        throw new Error(`Workbook is missing ${name}`);
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }) as unknown[][];
}
function cellText(value: unknown): string {
    return value === null || value === undefined ? "" : String(value).trim();
}
function cellNumber(value: unknown): number | null {
    if (value === null || value === undefined || cellText(value) === "")
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function cellDate(value: unknown): string {
    const date = value instanceof Date ? value : new Date(cellText(value));
    if (Number.isNaN(date.getTime()))
        throw new Error(`Invalid workbook date: ${cellText(value)}`);
    return date.toISOString().slice(0, 10);
}
function parseCsv(text: string): Record<string, string>[] {
    const workbook = XLSX.read(text, { type: "string" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "", raw: false });
}
function plainText(html: string) {
    return html.replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").trim();
}
export function capacityWorkbookUrlFromPage(html: string) {
    const href = html.match(/href=["']([^"']*\/doc\/health-care-capacity-data-file-[a-z0-9-]+\/download(?:\?[^"']*)?)["']/i)?.[1];
    if (!href)
        throw new Error("MassDPH capacity dashboard did not publish an official current workbook");
    const url = new URL(href.replaceAll("&amp;", "&"), CAPACITY_DASHBOARD_ENDPOINT);
    if (url.origin !== "https://www.mass.gov" || !/^\/doc\/health-care-capacity-data-file-[a-z0-9-]+\/download$/i.test(url.pathname)) {
        throw new Error("MassDPH capacity dashboard did not publish an official current workbook");
    }
    return url.toString();
}
const CAPACITY_SHEETS = ["Hospital Information", "Inpatient Beds Data", "Emergency Department Data", "Ambulance Trip Data"] as const;
const ARBOVIRUS_SHEETS = ["Risk by Town", "Positive Samples and Cases"] as const;
async function fetchCapacityWorkbook() {
    const response = await fetch(CAPACITY_DASHBOARD_ENDPOINT, {
        signal: AbortSignal.timeout(10000), cache: "no-store", headers: MASS_PUBLISHER_HEADERS,
    });
    if (!response.ok)
        throw new Error(`MassDPH capacity dashboard responded with ${response.status}`);
    return fetchWorkbook(capacityWorkbookUrlFromPage(await response.text()), CAPACITY_SHEETS);
}
async function getTickStateContext(): Promise<RespiratoryOutlook["auxiliary"]["tickState"]> {
    const response = await fetch(TICK_SURVEILLANCE_ENDPOINT, {
        signal: AbortSignal.timeout(12000), cache: "no-store", headers: MASS_PUBLISHER_HEADERS,
    });
    if (!response.ok)
        throw new Error(`MassDPH tick table responded with ${response.status}`);
    const html = await response.text();
    const table = html.match(/<caption>Tickborne Diseases Reported in Massachusetts,[\s\S]*?<\/table>/i)?.[0];
    if (!table)
        throw new Error("MassDPH tick morbidity table was not found");
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => plainText(cell[1])));
    const asOf = html.match(/Data are current as of (\d{2})\/(\d{2})\/(\d{4})/i);
    const observedThrough = asOf ? `${asOf[3]}-${asOf[1]}-${asOf[2]}` : new Date().toISOString().slice(0, 10);
    const year = Number(observedThrough.slice(0, 4));
    const column = rows[0].findIndex((cell) => Number(cell.match(/\d{4}/)?.[0]) === year);
    if (column < 1)
        throw new Error("MassDPH tick table has no current-year column");
    const names = { Lyme: "Lyme Disease", Anaplasmosis: "Human Granulocytic Anaplasmosis", Babesiosis: "Babesiosis", "B. miyamotoi": "Borrelia miyamotoi", Powassan: "Powassan virus" } as const;
    const cases = Object.fromEntries(Object.entries(names).map(([name, published]) => {
        const row = rows.find((candidate) => candidate[0].startsWith(published));
        if (!row)
            throw new Error(`MassDPH tick table is missing ${name}`);
        const value = cellNumber(cellText(row[column]).replaceAll(",", ""));
        if (value === null || !Number.isInteger(value) || value < 0)
            throw new Error(`MassDPH tick table has an invalid ${name} value`);
        return [name, value];
    })) as RespiratoryOutlook["auxiliary"]["tickState"]["cases"];
    return { observedThrough, cases };
}
async function getWastewaterTarget(endpoint: string): Promise<WastewaterTargetOutlook> {
    const query = new URLSearchParams({
        "$select": "sample_collect_date,site,county_fips,pcr_target_detect",
        "$where": "state_territory='ma'",
        "$order": "sample_collect_date DESC",
        "$limit": "250",
    });
    const response = await fetch(`${endpoint}?${query}`, {
        signal: AbortSignal.timeout(6000), cache: "no-store", headers: { Accept: "application/json" },
    });
    if (!response.ok)
        throw new Error(`CDC NWSS responded with ${response.status}`);
    const rows = z.array(wastewaterRowSchema).parse(await response.json());
    if (!rows.length)
        throw new Error("CDC NWSS returned no Massachusetts records");
    const latest = new Date(rows[0].sample_collect_date);
    const cutoff = new Date(latest);
    cutoff.setUTCDate(cutoff.getUTCDate() - 13);
    const recent = rows.filter((row) => new Date(row.sample_collect_date) >= cutoff);
    const countySites = new Map<string, Set<string>>();
    const countyDetectedSites = new Map<string, Set<string>>();
    for (const row of recent) {
        for (const fips of row.county_fips.split(",").map((value) => value.trim())) {
            const county = COUNTY_FIPS_TO_KEY[fips];
            if (!county)
                continue;
            const reporting = countySites.get(county) ?? new Set<string>();
            reporting.add(row.site);
            countySites.set(county, reporting);
            if (row.pcr_target_detect?.toLowerCase() === "yes") {
                const detected = countyDetectedSites.get(county) ?? new Set<string>();
                detected.add(row.site);
                countyDetectedSites.set(county, detected);
            }
        }
    }
    const counties = Object.fromEntries([...countySites].map(([county, sites]) => [county, {
            sitesReporting: sites.size,
            detectedSites: countyDetectedSites.get(county)?.size ?? 0,
        }]));
    return {
        observedThrough: isoDate(rows[0].sample_collect_date),
        sitesReporting: new Set(recent.map((row) => row.site)).size,
        detectedSites: new Set(recent.filter((row) => row.pcr_target_detect?.toLowerCase() === "yes").map((row) => row.site)).size,
        counties,
    };
}
async function getLymeContext(): Promise<RespiratoryOutlook["auxiliary"]["lyme"]> {
    const yearQuery = new URLSearchParams({
        "$select": "max(year) as year",
        "$where": "state='MA'",
    });
    const yearResponse = await fetch(`${CDC_LYME_ENDPOINT}?${yearQuery}`, {
        signal: AbortSignal.timeout(6000), cache: "no-store", headers: { Accept: "application/json" },
    });
    if (!yearResponse.ok)
        throw new Error(`CDC Lyme surveillance responded with ${yearResponse.status}`);
    const [yearRow] = z.array(z.object({ year: z.coerce.number().int() })).parse(await yearResponse.json());
    if (!yearRow)
        throw new Error("CDC Lyme surveillance returned no Massachusetts year");
    const countyQuery = new URLSearchParams({
        "$select": "fips,sum(frequency) as cases",
        "$where": `state='MA' and year='${yearRow.year}'`,
        "$group": "fips",
        "$order": "fips",
    });
    const countyResponse = await fetch(`${CDC_LYME_ENDPOINT}?${countyQuery}`, {
        signal: AbortSignal.timeout(6000), cache: "no-store", headers: { Accept: "application/json" },
    });
    if (!countyResponse.ok)
        throw new Error(`CDC Lyme surveillance responded with ${countyResponse.status}`);
    const rows = z.array(lymeRowSchema).parse(await countyResponse.json());
    const countyCases = Object.fromEntries(rows.flatMap((row) => {
        const county = COUNTY_FIPS_TO_KEY[row.fips];
        return county ? [[county, row.cases]] : [];
    }));
    if (Object.keys(countyCases).length !== 14)
        throw new Error("CDC Lyme surveillance did not return all Massachusetts counties");
    return { observedYear: yearRow.year, totalCases: Object.values(countyCases).reduce((sum, value) => sum + value, 0), countyCases };
}
async function getTickCountyContext(): Promise<RespiratoryOutlook["auxiliary"]["tickCounty"]> {
    const workbook = await fetchWorkbook(CDC_TICK_COUNTY_WORKBOOK_ENDPOINT);
    const rows = worksheetRows(workbook, workbook.SheetNames[0]).slice(1);
    const anaplasmosis: Record<string, number> = {};
    const babesiosis: Record<string, number> = {};
    for (const row of rows) {
        const county = COUNTY_FIPS_TO_KEY[cellText(row[2]).padStart(5, "0")];
        if (!county)
            continue;
        const anaplasmosisValue = cellNumber(row[6]);
        const babesiosisValue = cellNumber(row[5]);
        if (anaplasmosisValue === null || babesiosisValue === null || anaplasmosisValue < 0 || babesiosisValue < 0)
            continue;
        anaplasmosis[county] = anaplasmosisValue;
        babesiosis[county] = babesiosisValue;
    }
    if (Object.keys(anaplasmosis).length !== 14 || Object.keys(babesiosis).length !== 14) {
        throw new Error("CDC tickborne workbook did not return all Massachusetts counties");
    }
    return { observedYear: 2022, cases: { Anaplasmosis: { countyCases: anaplasmosis }, Babesiosis: { countyCases: babesiosis } } };
}
type ArbovirusContext = {
    mosquito: RespiratoryOutlook["auxiliary"]["mosquito"];
    townToCounty: Record<string, string>;
};
async function getArbovirusContext(): Promise<ArbovirusContext> {
    const workbook = await fetchWorkbook(ARBOVIRUS_WORKBOOK_ENDPOINT, ARBOVIRUS_SHEETS);
    const riskRows = worksheetRows(workbook, "Risk by Town").slice(1);
    const targetCounties = {
        EEE: {} as RespiratoryOutlook["auxiliary"]["mosquito"]["targets"]["EEE"]["counties"],
        "West Nile virus": {} as RespiratoryOutlook["auxiliary"]["mosquito"]["targets"]["West Nile virus"]["counties"],
    };
    const townToCounty: Record<string, string> = {};
    const riskRank: Record<MosquitoRisk, number> = { Remote: 0, Low: 1, Moderate: 2, High: 3, Critical: 4 };
    let observedThrough = "";
    for (const row of riskRows) {
        const town = cellText(row[0]);
        const county = cellText(row[1]).toUpperCase();
        if (!town || !COUNTY_CENTROIDS[county])
            continue;
        townToCounty[town.toLowerCase()] = county;
        const rowDate = cellDate(row[4]);
        if (rowDate > observedThrough)
            observedThrough = rowDate;
        for (const [target, column] of [["EEE", 2], ["West Nile virus", 3]] as const) {
            const risk = cellText(row[column]) as MosquitoRisk;
            if (!(risk in riskRank))
                throw new Error(`Unexpected ${target} risk: ${risk}`);
            const current = targetCounties[target][county];
            if (!current || riskRank[risk] > riskRank[current.maximumRisk]) {
                targetCounties[target][county] = { maximumRisk: risk, townsAtMaximum: 1, positiveSamples: 0, humanCases: 0 };
            }
            else if (risk === current.maximumRisk) {
                current.townsAtMaximum += 1;
            }
        }
    }
    for (const row of worksheetRows(workbook, "Positive Samples and Cases").slice(1)) {
        const target = cellText(row[1]) === "WNV" ? "West Nile virus" : "EEE";
        const county = cellText(row[3]).toUpperCase();
        const reading = targetCounties[target][county];
        if (!reading)
            continue;
        if (cellText(row[2]).toLowerCase() === "human")
            reading.humanCases += 1;
        else
            reading.positiveSamples += 1;
    }
    if (Object.keys(townToCounty).length < 350)
        throw new Error("Arbovirus workbook did not return all Massachusetts municipalities");
    return { mosquito: { observedThrough, targets: { EEE: { counties: targetCounties.EEE }, "West Nile virus": { counties: targetCounties["West Nile virus"] } } }, townToCounty };
}
async function getRecreationalWaterContext(townToCounty: Record<string, string>): Promise<RespiratoryOutlook["auxiliary"]["recreationalWater"]> {
    const [closuresResponse, resultsResponse, mapResponse] = await Promise.all([
        fetch(BEACH_CLOSURES_ENDPOINT, { signal: AbortSignal.timeout(10000), cache: "no-store" }),
        fetch(BEACH_RESULTS_ENDPOINT, { signal: AbortSignal.timeout(10000), cache: "no-store" }),
        fetch(BEACH_MAP_ENDPOINT, { signal: AbortSignal.timeout(10000), cache: "no-store" }),
    ]);
    if (!closuresResponse.ok || !resultsResponse.ok || !mapResponse.ok)
        throw new Error("Massachusetts beach dashboard CSV export failed");
    const closures = parseCsv(await closuresResponse.text());
    const results = parseCsv(await resultsResponse.text());
    const beachRows = parseCsv(await mapResponse.text());
    const beachTypes = Object.fromEntries(beachRows.map((row) => [`${cellText(row.Town).toLowerCase()}|${cellText(row["Beach Name"]).toLowerCase()}`, cellText(row["Marine or Freshwater"])]));
    const counties: RespiratoryOutlook["auxiliary"]["recreationalWater"]["counties"] = {};
    const countyReading = (county: string) => counties[county] ??= { beachesMonitored: 0, closures: 0, bacterialClosures: 0, latestExceedances: 0 };
    for (const row of beachRows) {
        const county = townToCounty[cellText(row.Town).toLowerCase()];
        if (county)
            countyReading(county).beachesMonitored += 1;
    }
    for (const row of closures) {
        const county = townToCounty[cellText(row.Town).toLowerCase()];
        if (!county)
            continue;
        countyReading(county).closures += 1;
        if (cellText(row["Posting Reason"]).toLowerCase().includes("bacterial"))
            countyReading(county).bacterialClosures += 1;
    }
    const latest = new Map<string, {
        timestamp: number;
        row: Record<string, string>;
    }>();
    for (const row of results) {
        const timestamp = new Date(cellText(row.Date)).getTime();
        if (!Number.isFinite(timestamp))
            continue;
        const key = `${cellText(row.Town).toLowerCase()}|${cellText(row.Name).toLowerCase()}`;
        const previous = latest.get(key);
        if (!previous || timestamp > previous.timestamp)
            latest.set(key, { timestamp, row });
    }
    for (const { row } of latest.values()) {
        const county = townToCounty[cellText(row.Town).toLowerCase()];
        const indicator = cellText(row.Indicator).toLowerCase();
        const waterType = beachTypes[`${cellText(row.Town).toLowerCase()}|${cellText(row.Name).toLowerCase()}`];
        const threshold = indicator.includes("coli") ? 235 : indicator.includes("entero") ? (waterType === "Freshwater" ? 61 : 104) : null;
        const result = Number(cellText(row["Results (CFU/100 ml)"]).replace(/[^0-9.-]/g, ""));
        if (county && threshold !== null && Number.isFinite(result) && result > threshold)
            countyReading(county).latestExceedances += 1;
    }
    const timestamps = [...latest.values()].map((value) => value.timestamp);
    if (!timestamps.length)
        throw new Error("Massachusetts beach dashboard returned no dated samples");
    return {
        observedThrough: new Date(Math.max(...timestamps)).toISOString().slice(0, 10),
        totalClosures: closures.length,
        bacterialClosures: closures.filter((row) => cellText(row["Posting Reason"]).toLowerCase().includes("bacterial")).length,
        latestExceedances: Object.values(counties).reduce((sum, reading) => sum + reading.latestExceedances, 0),
        counties,
    };
}
function latestWorkbookMonth(rows: unknown[][], monthColumn: number, yearColumn: number): [
    number,
    number
] {
    const values = rows.flatMap((row) => {
        const month = MONTH_NUMBER[cellText(row[monthColumn])];
        const year = cellNumber(row[yearColumn]);
        return month && year !== null ? [[year, month] as [
                number,
                number
            ]] : [];
    });
    if (!values.length)
        throw new Error("Capacity workbook has no dated rows");
    return values.reduce((latest, value) => value[0] > latest[0] || (value[0] === latest[0] && value[1] > latest[1]) ? value : latest);
}
export function capacityBedTotals(header: unknown[], row: unknown[]) {
    const value = (name: string) => {
        const index = header.findIndex((cell) => cellText(cell) === name);
        if (index < 0)
            throw new Error(`Capacity workbook is missing column: ${name}`);
        return cellNumber(row[index]);
    };
    const values = [
        value("Available adult medical surgical beds (average)"),
        value("Available adult ICU beds (average)"),
        value("Available pediatric medical surgical beds (average)"),
        value("Available pediatric ICU beds (average)"),
        value("Staffed adult medical surgical beds (average)"),
        value("Staffed adult ICU beds (average)"),
        value("Staffed pediatric medical surgical beds (average)"),
        value("Staffed pediatric ICU beds (average)"),
    ];
    if (values.some((item) => item === null || item < 0))
        return null;
    const [availableAdult, availableAdultIcu, availablePediatric, availablePediatricIcu, staffedAdult, staffedAdultIcu, staffedPediatric, staffedPediatricIcu] = values as number[];
    return {
        availableBeds: availableAdult + availablePediatric,
        availableIcuBeds: availableAdultIcu + availablePediatricIcu,
        staffedBeds: staffedAdult + staffedPediatric,
        staffedIcuBeds: staffedAdultIcu + staffedPediatricIcu,
    };
}
function columnIndex(header: unknown[], name: string): number {
    const index = header.findIndex((cell) => cellText(cell) === name);
    if (index < 0)
        throw new Error(`Capacity workbook is missing column: ${name}`);
    return index;
}
export async function getCapacityContext(townToCounty: Record<string, string>, selectedMonth?: [
    number,
    number
]): Promise<RespiratoryOutlook["auxiliary"]["capacity"]> {
    const workbook = await fetchCapacityWorkbook();
    const [hospitalHeader = [], ...hospitalRows] = worksheetRows(workbook, "Hospital Information");
    const hospitalNameColumn = columnIndex(hospitalHeader, "Hospital");
    const hospitalTownColumn = columnIndex(hospitalHeader, "Town");
    const hospitalTown = Object.fromEntries(hospitalRows.flatMap((row) => {
        const hospital = cellText(row[hospitalNameColumn]);
        const town = cellText(row[hospitalTownColumn]).toLowerCase();
        return hospital && town ? [[hospital, town]] : [];
    }));
    const counties: RespiratoryOutlook["auxiliary"]["capacity"]["counties"] = {};
    const countyReading = (county: string) => counties[county] ??= { availableBeds: 0, availableIcuBeds: 0, staffedBeds: 0, staffedIcuBeds: 0, edVisits: 0, edLengthOfStayMinutes: 0, ambulanceRuns: 0 };
    const lengthOfStayNumerator: Record<string, number> = {};
    const [bedHeader = [], ...bedRows] = worksheetRows(workbook, "Inpatient Beds Data");
    const bedHospitalColumn = columnIndex(bedHeader, "Hospital name");
    const bedYearColumn = columnIndex(bedHeader, "Year");
    const bedMonthColumn = columnIndex(bedHeader, "Month");
    const bedMonth = selectedMonth ?? latestWorkbookMonth(bedRows, bedMonthColumn, bedYearColumn);
    for (const row of bedRows) {
        if (cellNumber(row[bedYearColumn]) !== bedMonth[0] || MONTH_NUMBER[cellText(row[bedMonthColumn])] !== bedMonth[1])
            continue;
        const county = townToCounty[hospitalTown[cellText(row[bedHospitalColumn])]];
        if (!county)
            continue;
        const totals = capacityBedTotals(bedHeader, row);
        if (!totals)
            continue;
        const reading = countyReading(county);
        reading.availableBeds += totals.availableBeds;
        reading.availableIcuBeds += totals.availableIcuBeds;
        reading.staffedBeds += totals.staffedBeds;
        reading.staffedIcuBeds += totals.staffedIcuBeds;
    }
    const [edHeader = [], ...edRows] = worksheetRows(workbook, "Emergency Department Data");
    const edMonthColumn = columnIndex(edHeader, "Month");
    const edYearColumn = columnIndex(edHeader, "Year");
    const edHospitalColumn = columnIndex(edHeader, "Hospital");
    const edVisitsColumn = columnIndex(edHeader, "Total ED visits");
    const edLengthOfStayColumn = columnIndex(edHeader, "Average length of stay in the ED");
    const edMonth = selectedMonth ?? latestWorkbookMonth(edRows, edMonthColumn, edYearColumn);
    for (const row of edRows) {
        if (cellNumber(row[edYearColumn]) !== edMonth[0] || MONTH_NUMBER[cellText(row[edMonthColumn])] !== edMonth[1])
            continue;
        const county = townToCounty[hospitalTown[cellText(row[edHospitalColumn])]];
        if (!county)
            continue;
        const visits = cellNumber(row[edVisitsColumn]);
        const wait = cellNumber(row[edLengthOfStayColumn]);
        if (visits === null || wait === null || visits < 0 || wait < 0)
            continue;
        countyReading(county).edVisits += visits;
        lengthOfStayNumerator[county] = (lengthOfStayNumerator[county] ?? 0) + wait * visits;
    }
    const [ambulanceHeader = [], ...ambulanceRows] = worksheetRows(workbook, "Ambulance Trip Data");
    const ambulanceTownColumn = columnIndex(ambulanceHeader, "Starting town/city");
    const ambulanceMonthColumn = columnIndex(ambulanceHeader, "Month");
    const ambulanceYearColumn = columnIndex(ambulanceHeader, "Year");
    const ambulanceRunsColumn = columnIndex(ambulanceHeader, "Number of emergency runs");
    const ambulanceMonth = selectedMonth ?? latestWorkbookMonth(ambulanceRows, ambulanceMonthColumn, ambulanceYearColumn);
    for (const row of ambulanceRows) {
        if (cellNumber(row[ambulanceYearColumn]) !== ambulanceMonth[0] || MONTH_NUMBER[cellText(row[ambulanceMonthColumn])] !== ambulanceMonth[1])
            continue;
        const county = townToCounty[cellText(row[ambulanceTownColumn]).toLowerCase()];
        const runs = cellNumber(row[ambulanceRunsColumn]);
        if (county && runs !== null && runs >= 0)
            countyReading(county).ambulanceRuns += runs;
    }
    for (const [county, reading] of Object.entries(counties)) {
        reading.availableBeds = Number(reading.availableBeds.toFixed(1));
        reading.availableIcuBeds = Number(reading.availableIcuBeds.toFixed(1));
        reading.staffedBeds = Number(reading.staffedBeds.toFixed(1));
        reading.staffedIcuBeds = Number(reading.staffedIcuBeds.toFixed(1));
        reading.edLengthOfStayMinutes = reading.edVisits ? Number(((lengthOfStayNumerator[county] ?? 0) / reading.edVisits).toFixed(1)) : 0;
    }
    if (!Object.keys(counties).length)
        throw new Error("Capacity workbook has no observations for the requested month");
    const [year, month] = [bedMonth, edMonth, ambulanceMonth].reduce((oldest, value) => value[0] < oldest[0] || (value[0] === oldest[0] && value[1] < oldest[1]) ? value : oldest);
    return { observedThrough: `${year}-${String(month).padStart(2, "0")}-01`, counties };
}
export async function getHistoricalCapacityContext(period: string): Promise<RespiratoryOutlook["auxiliary"]["capacity"]> {
    const match = /^(\d{4})-(\d{2})$/.exec(period);
    if (!match)
        throw new Error("Invalid capacity period");
    const arbovirus = await getArbovirusContext();
    return getCapacityContext(arbovirus.townToCounty, [Number(match[1]), Number(match[2])]);
}
const heatRiskCategorySchema = nonNegativePublisherNumber.pipe(z.number().max(4));
const optionalHeatRiskCategorySchema = optionalNonNegativePublisherNumber.pipe(z.number().max(4).optional());
const heatRiskIdentifySchema = z.object({
    value: optionalHeatRiskCategorySchema,
    properties: z.object({ Values: z.array(heatRiskCategorySchema).optional() }).nullable().optional(),
    catalogItems: z.object({ features: z.array(z.object({ attributes: z.object({ idp_validtime: nonNegativePublisherNumber }) })) }).optional(),
});
export async function getHeatRiskContext(): Promise<RespiratoryOutlook["auxiliary"]["environment"]["heatRisk"]> {
    const dates: number[] = [];
    const entries = await Promise.all(Object.entries(COUNTY_CENTROIDS).map(async ([county, [x, y]]) => {
        const query = new URLSearchParams({
            geometry: JSON.stringify({ x, y, spatialReference: { wkid: 4326 } }), geometryType: "esriGeometryPoint",
            returnGeometry: "false", returnCatalogItems: "true", f: "json",
        });
        const response = await fetch(`${HEATRISK_ENDPOINT}/identify?${query}`, {
            signal: AbortSignal.timeout(8000), cache: "no-store", headers: { Accept: "application/json" },
        });
        if (!response.ok)
            throw new Error(`NOAA HeatRisk responded with ${response.status}`);
        const parsed = heatRiskIdentifySchema.parse(await response.json());
        dates.push(...(parsed.catalogItems?.features.map((feature) => feature.attributes.idp_validtime) ?? []));
        const values = parsed.properties?.Values ?? [];
        const current = parsed.value;
        if (current === undefined || values.length === 0)
            return null;
        return [county, { currentRisk: current, maxRisk: Math.max(...values) }] as const;
    }));
    if (!dates.length)
        throw new Error("NOAA HeatRisk returned no forecast dates");
    const counties = Object.fromEntries(entries.flatMap((entry) => entry ? [entry] : []));
    if (!Object.keys(counties).length)
        throw new Error("NOAA HeatRisk returned no county observations");
    return {
        observedThrough: new Date(Math.min(...dates)).toISOString().slice(0, 10),
        forecastThrough: new Date(Math.max(...dates)).toISOString().slice(0, 10),
        counties,
    };
}
function airNowTimestamp(fields: string[]) {
    const dateMatch = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(fields[1] ?? "");
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(fields[2] ?? "");
    const offset = fields[3] === "EST" ? "-05:00" : fields[3] === "EDT" ? "-04:00" : null;
    if (!dateMatch || !timeMatch || !offset)
        return null;
    const [month, day, year, hour, minute] = [dateMatch[1], dateMatch[2], `20${dateMatch[3]}`, timeMatch[1], timeMatch[2]].map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day || hour > 23 || minute > 59)
        return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}`;
}
export function airQualityFromAirNow(text: string): RespiratoryOutlook["auxiliary"]["environment"]["airQuality"] {
    const counties: RespiratoryOutlook["auxiliary"]["environment"]["airQuality"]["counties"] = {};
    let observedThrough: string | null = null;
    let observedTimestamp = Number.NEGATIVE_INFINITY;
    for (const line of text.split(/\r?\n/)) {
        const fields = line.split("|");
        if (fields[8] !== "MA" || fields[5] !== "O" || fields[6] !== "Y")
            continue;
        const aqi = Number(fields[12]);
        const timestamp = airNowTimestamp(fields);
        const reportingArea = fields[7]?.trim();
        const pollutant = fields[11]?.trim();
        const category = fields[13]?.trim();
        if (!Number.isInteger(aqi) || aqi < 0 || aqi > 500 || !timestamp || !reportingArea || !pollutant || !category)
            continue;
        const timestampValue = Date.parse(timestamp);
        if (timestampValue > observedTimestamp) {
            observedTimestamp = timestampValue;
            observedThrough = timestamp;
        }
        for (const county of AIRNOW_AREAS[reportingArea] ?? []) {
            if (!counties[county] || aqi > counties[county].aqi) {
                counties[county] = { aqi, category, pollutant, reportingArea };
            }
        }
    }
    if (!Object.keys(counties).length || !observedThrough)
        throw new Error("EPA AirNow returned no current Massachusetts observations");
    return { observedThrough, statewideMaxAqi: Math.max(...Object.values(counties).map((reading) => reading.aqi)), counties };
}
async function getAirQualityContext(): Promise<RespiratoryOutlook["auxiliary"]["environment"]["airQuality"]> {
    const response = await fetch(AIRNOW_ENDPOINT, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!response.ok)
        throw new Error(`EPA AirNow responded with ${response.status}`);
    return airQualityFromAirNow(await response.text());
}
async function getHospitalContext(): Promise<RespiratoryOutlook["auxiliary"]["hospital"]> {
    const query = new URLSearchParams({
        "$select": "weekendingdate,totalconfflunewadm,totalconfflunewadmhosprep,totalconfflunewadmperchosprep",
        "$where": "jurisdiction='MA'",
        "$order": "weekendingdate DESC",
        "$limit": "1",
    });
    const response = await fetch(`https://data.cdc.gov/resource/ua7e-t2fy.json?${query}`, {
        signal: AbortSignal.timeout(6000), cache: "no-store", headers: { Accept: "application/json" },
    });
    if (!response.ok)
        throw new Error(`CDC NHSN responded with ${response.status}`);
    const [row] = z.array(hospitalRowSchema).parse(await response.json());
    if (!row)
        throw new Error("CDC NHSN returned no Massachusetts record");
    return { observedThrough: isoDate(row.weekendingdate), influenzaAdmissions: row.totalconfflunewadm, reportingHospitals: row.totalconfflunewadmhosprep, reportingPercent: row.totalconfflunewadmperchosprep };
}
export function liveAirQualityContext() {
    return cachedPublisherFetch("ma:air-quality", twelveHours, () => getAirQualityContext());
}
export async function liveCapacityContext(): Promise<RespiratoryOutlook["auxiliary"]["capacity"]> {
    const arbovirus = await cachedPublisherFetch("ma:arbovirus", twelveHours, () => getArbovirusContext());
    return cachedPublisherFetch("ma:capacity", twelveHours, () => getCapacityContext(arbovirus.townToCounty));
}
const WASTEWATER_TARGET_ENDPOINTS = {
    measles: ["ma:wastewater:measles", CDC_MEASLES_WASTEWATER_ENDPOINT],
    influenzaAH5: ["ma:wastewater:h5", CDC_H5_WASTEWATER_ENDPOINT],
    mpox: ["ma:wastewater:mpox", CDC_MPOX_WASTEWATER_ENDPOINT],
} as const;
export function liveWastewaterContext(target: keyof typeof WASTEWATER_TARGET_ENDPOINTS): Promise<WastewaterTargetOutlook> {
    const [key, endpoint] = WASTEWATER_TARGET_ENDPOINTS[target];
    return cachedPublisherFetch(key, twelveHours, () => getWastewaterTarget(endpoint));
}
function connectorFallback<T>(source: string, fallback: T, strict: boolean, warnings: Array<{
    source: string;
    message: string;
}>) {
    return (error: unknown): T => {
        if (strict)
            throw new Error(`${source} connector failed`, { cause: error });
        warnings.push({ source, message: "The publisher did not return a usable current snapshot; the last valid data remain visible." });
        return fallback;
    };
}
export async function getLiveRespiratoryOutlook(options: {
    strict?: boolean;
} = {}): Promise<RespiratoryOutlook> {
    const strict = options.strict === true;
    const sourceWarnings: Array<{
        source: string;
        message: string;
    }> = [];
    const query = new URLSearchParams({
        "$select": "week_end,county,hsa_nci_id,percent_visits_covid,percent_visits_influenza,percent_visits_rsv,ed_trends_covid,ed_trends_influenza,ed_trends_rsv,buildnumber",
        "$where": "geography='Massachusetts'",
        "$order": "week_end DESC",
        "$limit": "100",
    });
    const response = await fetch(`${CDC_NSSP_ENDPOINT}?${query}`, {
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
        headers: { Accept: "application/json" },
    });
    if (!response.ok)
        throw new Error(`CDC NSSP responded with ${response.status}`);
    const parsed = z.array(rowSchema).parse(await response.json());
    if (!parsed.length)
        throw new Error("CDC NSSP returned no Massachusetts records");
    const latestWeek = parsed[0].week_end;
    const latest = parsed.filter((row) => row.week_end === latestWeek);
    const stateRow = latest.find((row) => row.hsa_nci_id === "All");
    if (!stateRow)
        throw new Error("CDC NSSP returned no statewide record");
    const ids = Object.keys(REGION_META) as RegionOutlook["id"][];
    const regions = ids.map((id) => {
        const row = latest.find((candidate) => candidate.hsa_nci_id === id);
        if (!row)
            throw new Error(`CDC NSSP returned no row for HSA ${id}`);
        return {
            ...REGION_META[id],
            values: { covid: row.percent_visits_covid, influenza: row.percent_visits_influenza, rsv: row.percent_visits_rsv },
            trends: {
                covid: row.ed_trends_covid as Trend,
                influenza: row.ed_trends_influenza as Trend,
                rsv: row.ed_trends_rsv as Trend,
            },
        };
    });
    const [influenzaA, sarsCov2, rsv, measles, influenzaAH5, mpox, lyme, tickCounty, tickState, hospital, heatRisk, airQuality, arbovirus] = await Promise.all([
        cachedPublisherFetch("ma:wastewater:influenza-a", twelveHours, () => getWastewaterTarget(CDC_INFLUENZA_WASTEWATER_ENDPOINT)).catch(connectorFallback("CDC influenza wastewater", LAST_VALID_OUTLOOK.auxiliary.wastewater.influenzaA, strict, sourceWarnings)),
        cachedPublisherFetch("ma:wastewater:sars-cov-2", twelveHours, () => getWastewaterTarget(CDC_COVID_WASTEWATER_ENDPOINT)).catch(connectorFallback("CDC COVID wastewater", LAST_VALID_OUTLOOK.auxiliary.wastewater.sarsCov2, strict, sourceWarnings)),
        cachedPublisherFetch("ma:wastewater:rsv", twelveHours, () => getWastewaterTarget(CDC_RSV_WASTEWATER_ENDPOINT)).catch(connectorFallback("CDC RSV wastewater", LAST_VALID_OUTLOOK.auxiliary.wastewater.rsv, strict, sourceWarnings)),
        cachedPublisherFetch("ma:wastewater:measles", twelveHours, () => getWastewaterTarget(CDC_MEASLES_WASTEWATER_ENDPOINT)).catch(connectorFallback("CDC measles wastewater", LAST_VALID_OUTLOOK.auxiliary.wastewater.measles, strict, sourceWarnings)),
        cachedPublisherFetch("ma:wastewater:h5", twelveHours, () => getWastewaterTarget(CDC_H5_WASTEWATER_ENDPOINT)).catch(connectorFallback("CDC H5 wastewater", LAST_VALID_OUTLOOK.auxiliary.wastewater.influenzaAH5, strict, sourceWarnings)),
        cachedPublisherFetch("ma:wastewater:mpox", twelveHours, () => getWastewaterTarget(CDC_MPOX_WASTEWATER_ENDPOINT)).catch(connectorFallback("CDC mpox wastewater", LAST_VALID_OUTLOOK.auxiliary.wastewater.mpox, strict, sourceWarnings)),
        cachedPublisherFetch("ma:lyme", twelveHours, () => getLymeContext()).catch(connectorFallback("CDC Lyme", LAST_VALID_OUTLOOK.auxiliary.lyme, strict, sourceWarnings)),
        cachedPublisherFetch("ma:tick-county", twelveHours, () => getTickCountyContext()).catch(connectorFallback("CDC tick county", LAST_VALID_OUTLOOK.auxiliary.tickCounty, strict, sourceWarnings)),
        cachedPublisherFetch("ma:tick-state", twelveHours, () => getTickStateContext()).catch(connectorFallback("MassDPH tick statewide", LAST_VALID_OUTLOOK.auxiliary.tickState, strict, sourceWarnings)),
        cachedPublisherFetch("ma:hospital", twelveHours, () => getHospitalContext()).catch(connectorFallback("CDC hospital", LAST_VALID_OUTLOOK.auxiliary.hospital, strict, sourceWarnings)),
        cachedPublisherFetch("ma:heat-risk", twelveHours, () => getHeatRiskContext()).catch(connectorFallback("NOAA HeatRisk", LAST_VALID_OUTLOOK.auxiliary.environment.heatRisk, strict, sourceWarnings)),
        cachedPublisherFetch("ma:air-quality", twelveHours, () => getAirQualityContext()).catch(connectorFallback("EPA AirNow", LAST_VALID_OUTLOOK.auxiliary.environment.airQuality, strict, sourceWarnings)),
        cachedPublisherFetch("ma:arbovirus", twelveHours, () => getArbovirusContext()).catch(connectorFallback("MassDPH arbovirus", null, strict, sourceWarnings)),
    ]);
    const [recreationalWater, capacity] = arbovirus ? await Promise.all([
        cachedPublisherFetch("ma:recreational-water", twelveHours, () => getRecreationalWaterContext(arbovirus.townToCounty)).catch(connectorFallback("MassDPH recreational water", LAST_VALID_OUTLOOK.auxiliary.recreationalWater, strict, sourceWarnings)),
        cachedPublisherFetch("ma:capacity", twelveHours, () => getCapacityContext(arbovirus.townToCounty)).catch(connectorFallback("MassDPH hospital capacity", LAST_VALID_OUTLOOK.auxiliary.capacity, strict, sourceWarnings)),
    ]) : [LAST_VALID_OUTLOOK.auxiliary.recreationalWater, LAST_VALID_OUTLOOK.auxiliary.capacity];
    return {
        status: "live",
        observedThrough: isoDate(stateRow.week_end),
        buildDate: isoDate(stateRow.buildnumber),
        retrievedAt: new Date().toISOString(),
        sourceWarnings: sourceWarnings.length ? sourceWarnings : undefined,
        state: {
            values: { covid: stateRow.percent_visits_covid, influenza: stateRow.percent_visits_influenza, rsv: stateRow.percent_visits_rsv },
            trends: {
                covid: stateRow.ed_trends_covid,
                influenza: stateRow.ed_trends_influenza,
                rsv: stateRow.ed_trends_rsv,
            },
        },
        auxiliary: {
            wastewater: { influenzaA, sarsCov2, rsv, measles, influenzaAH5, mpox },
            mosquito: arbovirus?.mosquito ?? LAST_VALID_OUTLOOK.auxiliary.mosquito,
            lyme,
            tickState,
            tickCounty,
            environment: { heatRisk, airQuality },
            recreationalWater,
            hospital,
            capacity,
        },
        regions,
    };
}
