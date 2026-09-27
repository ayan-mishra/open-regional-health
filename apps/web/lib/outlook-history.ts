import "server-only";
import { z } from "zod";
import * as XLSX from "@e965/xlsx";
import { strFromU8, unzipSync } from "fflate";
import { getHistoricalCapacityContext } from "@/lib/outlook-live";
import { nonNegativePublisherInteger, nonNegativePublisherNumber, publisherPercentage } from "@/lib/publisher-values";
import { cachedPublisherFetch } from "@/lib/publisher-cache";
import { LAST_VALID_OUTLOOK, REGION_META, type LayerAvailability, type RegionOutlook, type RespiratoryOutlook, type WastewaterTargetOutlook, } from "@/lib/outlook-contracts";
const twelveHours = 43200;
const countyFips: Record<string, string> = {
    "25001": "BARNSTABLE", "25003": "BERKSHIRE", "25005": "BRISTOL", "25007": "DUKES",
    "25009": "ESSEX", "25011": "FRANKLIN", "25013": "HAMPDEN", "25015": "HAMPSHIRE",
    "25017": "MIDDLESEX", "25019": "NANTUCKET", "25021": "NORFOLK", "25023": "PLYMOUTH",
    "25025": "SUFFOLK", "25027": "WORCESTER",
};
const focuses: Record<string, readonly string[]> = {
    respiratory: ["COVID-19", "Influenza", "RSV"],
    mosquito: ["EEE", "West Nile virus"],
    ticks: ["Lyme", "Anaplasmosis", "Babesiosis", "B. miyamotoi", "Powassan"],
    wastewater: ["Influenza A", "SARS-CoV-2", "RSV", "Measles", "Influenza A H5", "Mpox"],
    environment: ["HeatRisk", "Air quality"],
    water: ["Bacterial exceedances", "Beach closures", "No-swimming postings"],
    hospital: ["Influenza admissions"],
    capacity: ["Available beds", "ICU capacity", "Emergency-department visits", "Emergency-department length of stay", "Ambulance activity"],
};
const wastewaterIds = ["ymmh-divb", "j9g8-acpt", "45cq-cw4i", "akvg-8vrb", "mtpu-urpp", "xpxn-rzgz"];
const responseSchema = z.array(z.record(z.string(), z.string().optional()));
const publisherDateSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid publisher date");
const historicalRespiratoryRowSchema = z.object({
    week_end: publisherDateSchema,
    county: z.string().min(1),
    hsa_nci_id: z.string().min(1),
    percent_visits_covid: publisherPercentage,
    percent_visits_influenza: publisherPercentage,
    percent_visits_rsv: publisherPercentage,
    ed_trends_covid: z.enum(["Increasing", "No Change", "Decreasing"]),
    ed_trends_influenza: z.enum(["Increasing", "No Change", "Decreasing"]),
    ed_trends_rsv: z.enum(["Increasing", "No Change", "Decreasing"]),
    buildnumber: publisherDateSchema.optional(),
});
const historicalLymeRowSchema = z.object({
    fips: z.string().regex(/^\d{5}$/),
    cases: nonNegativePublisherInteger,
});
const historicalHospitalRowSchema = z.object({
    weekendingdate: publisherDateSchema,
    totalconfflunewadm: nonNegativePublisherNumber,
    totalconfflunewadmhosprep: nonNegativePublisherNumber,
    totalconfflunewadmperchosprep: nonNegativePublisherNumber.pipe(z.number().max(100)),
});
class HistoricalDataUnavailable extends Error {
}
async function historicalConnector<T>(promise: Promise<T>, source: string, strict: boolean, warnings: Array<{
    source: string;
    message: string;
}>): Promise<T | null> {
    try {
        return await promise;
    }
    catch (error) {
        const expectedAbsence = error instanceof HistoricalDataUnavailable || (error instanceof Error && error.message === "Capacity workbook has no observations for the requested month");
        if (strict && !expectedAbsence)
            throw new Error(`${source} historical connector failed`, { cause: error });
        if (!expectedAbsence)
            warnings.push({ source, message: "The historical publisher snapshot could not be loaded; the last valid layer remains visible." });
        return null;
    }
}
function periodBounds(period: string) {
    const [year, month] = period.split("-").map(Number);
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return {
        year,
        month,
        start: `${period}-01T00:00:00.000`,
        end: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00.000`,
        endDate: new Date(Date.UTC(nextYear, nextMonth - 1, 0)).toISOString().slice(0, 10),
    };
}
export function isValidHistoryPeriod(period: string, now = new Date()) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
        return false;
    return period >= "2018-01" && period <= now.toISOString().slice(0, 7);
}
async function socrata(id: string, params: Record<string, string>) {
    const url = `https://data.cdc.gov/resource/${id}.json?${new URLSearchParams(params)}`;
    return cachedPublisherFetch(url, twelveHours, async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(12000), cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok)
            throw new Error(`CDC dataset ${id} responded with ${response.status}`);
        return responseSchema.parse(await response.json());
    });
}
function setAvailability(layers: Record<string, LayerAvailability>, domain: string, index: number, available: boolean, note: string) {
    layers[`${domain}:${index}`] = { available, note };
}
function unavailableLayers(note: string) {
    return Object.fromEntries(Object.entries(focuses).flatMap(([domain, items]) => items.map((_, index) => [
        `${domain}:${index}`, { available: false, note },
    ]))) as Record<string, LayerAvailability>;
}
async function respiratorySnapshot(period: string) {
    const { start, end } = periodBounds(period);
    const rawRows = await socrata("rdmq-nq56", {
        "$select": "week_end,county,hsa_nci_id,percent_visits_covid,percent_visits_influenza,percent_visits_rsv,ed_trends_covid,ed_trends_influenza,ed_trends_rsv,buildnumber",
        "$where": `geography='Massachusetts' AND week_end >= '${start}' AND week_end < '${end}'`, "$order": "week_end DESC", "$limit": "100",
    });
    const rows = z.array(historicalRespiratoryRowSchema).parse(rawRows);
    if (!rows.length || !rows[0].week_end)
        throw new HistoricalDataUnavailable("No respiratory snapshot");
    const latestWeek = rows[0].week_end;
    const latest = rows.filter((row) => row.week_end === latestWeek);
    const state = latest.find((row) => row.hsa_nci_id === "All");
    if (!state)
        throw new Error("No statewide respiratory snapshot");
    const regions = (Object.keys(REGION_META) as RegionOutlook["id"][]).map((id) => {
        const row = latest.find((candidate) => candidate.hsa_nci_id === id);
        if (!row)
            throw new Error(`No historical row for HSA ${id}`);
        return { ...REGION_META[id], values: { covid: row.percent_visits_covid, influenza: row.percent_visits_influenza, rsv: row.percent_visits_rsv }, trends: { covid: row.ed_trends_covid, influenza: row.ed_trends_influenza, rsv: row.ed_trends_rsv } };
    });
    return {
        observedThrough: latestWeek.slice(0, 10), buildDate: (state.buildnumber ?? latestWeek).slice(0, 10), regions,
        state: { values: { covid: state.percent_visits_covid, influenza: state.percent_visits_influenza, rsv: state.percent_visits_rsv }, trends: { covid: state.ed_trends_covid, influenza: state.ed_trends_influenza, rsv: state.ed_trends_rsv } },
    };
}
async function wastewaterSnapshot(id: string, period: string): Promise<WastewaterTargetOutlook> {
    const { start, end } = periodBounds(period);
    const rows = await socrata(id, {
        "$select": "sample_collect_date,site,county_fips,pcr_target_detect",
        "$where": `state_territory='ma' AND sample_collect_date >= '${start}' AND sample_collect_date < '${end}'`,
        "$order": "sample_collect_date DESC", "$limit": "10000",
    });
    if (!rows.length || !rows[0].sample_collect_date)
        throw new HistoricalDataUnavailable("No wastewater snapshot");
    const latest = new Date(rows[0].sample_collect_date);
    const cutoff = new Date(latest);
    cutoff.setUTCDate(cutoff.getUTCDate() - 13);
    const recent = rows.filter((row) => row.sample_collect_date && new Date(row.sample_collect_date) >= cutoff);
    const reporting = new Map<string, Set<string>>();
    const detected = new Map<string, Set<string>>();
    for (const row of recent) {
        if (!row.site)
            continue;
        for (const fips of (row.county_fips ?? "").split(",").map((value) => value.trim())) {
            const county = countyFips[fips];
            if (!county)
                continue;
            const sites = reporting.get(county) ?? new Set<string>();
            sites.add(row.site);
            reporting.set(county, sites);
            if (row.pcr_target_detect?.toLowerCase() === "yes") {
                const sitesDetected = detected.get(county) ?? new Set<string>();
                sitesDetected.add(row.site);
                detected.set(county, sitesDetected);
            }
        }
    }
    const counties = Object.fromEntries([...reporting].map(([county, sites]) => [county, { sitesReporting: sites.size, detectedSites: detected.get(county)?.size ?? 0 }]));
    return { observedThrough: rows[0].sample_collect_date.slice(0, 10), sitesReporting: new Set(recent.map((row) => row.site).filter(Boolean)).size, detectedSites: new Set(recent.filter((row) => row.pcr_target_detect?.toLowerCase() === "yes").map((row) => row.site).filter(Boolean)).size, counties };
}
async function lymeSnapshot(year: number) {
    const rows = z.array(historicalLymeRowSchema).parse(await socrata("x5j9-wybp", { "$select": "fips,sum(frequency) as cases", "$where": `state='MA' and year='${year}'`, "$group": "fips", "$order": "fips" }));
    const counties = Object.fromEntries(rows.flatMap((row) => {
        const county = countyFips[row.fips];
        return county ? [[county, row.cases]] : [];
    }));
    if (!Object.keys(counties).length)
        throw new HistoricalDataUnavailable("No Lyme snapshot");
    return { observedYear: year, totalCases: Object.values(counties).reduce((sum, value) => sum + value, 0), countyCases: counties };
}
async function hospitalSnapshot(period: string) {
    const { start, end } = periodBounds(period);
    const rows = await socrata("ua7e-t2fy", { "$select": "weekendingdate,totalconfflunewadm,totalconfflunewadmhosprep,totalconfflunewadmperchosprep", "$where": `jurisdiction='MA' AND weekendingdate >= '${start}' AND weekendingdate < '${end}'`, "$order": "weekendingdate DESC", "$limit": "1" });
    if (!rows.length)
        throw new HistoricalDataUnavailable("No hospital snapshot");
    const row = historicalHospitalRowSchema.parse(rows[0]);
    return { observedThrough: row.weekendingdate.slice(0, 10), influenzaAdmissions: row.totalconfflunewadm, reportingHospitals: row.totalconfflunewadmhosprep, reportingPercent: row.totalconfflunewadmperchosprep };
}
async function airQualityYearRows(year: number) {
    const url = `https://aqs.epa.gov/aqsweb/airdata/daily_aqi_by_county_${year}.zip`;
    return cachedPublisherFetch(url, twelveHours, async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(20000), cache: "no-store" });
        if (!response.ok)
            throw new Error(`EPA AirData responded with ${response.status}`);
        const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
        const csv = Object.entries(files).find(([name]) => name.endsWith(".csv"));
        if (!csv)
            throw new Error("EPA AirData archive has no CSV");
        const workbook = XLSX.read(strFromU8(csv[1]), { type: "string" });
        return XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: false });
    });
}
async function airQualitySnapshot(period: string): Promise<RespiratoryOutlook["auxiliary"]["environment"]["airQuality"]> {
    const { year } = periodBounds(period);
    const rows = await airQualityYearRows(year);
    const selected = rows.filter((row) => row["State Name"] === "Massachusetts" && String(row.Date).slice(0, 7) === period);
    const counties: RespiratoryOutlook["auxiliary"]["environment"]["airQuality"]["counties"] = {};
    let observedThrough = "";
    for (const row of selected) {
        const fips = `${String(row["State Code"]).padStart(2, "0")}${String(row["County Code"]).padStart(3, "0")}`;
        const county = countyFips[fips];
        const aqi = Number(row.AQI);
        const countyName = String(row["county Name"] ?? row["County Name"] ?? "").trim();
        const category = String(row.Category ?? "").trim();
        const pollutant = String(row["Defining Parameter"] ?? "").trim();
        if (!county || !countyName || !category || !pollutant || !Number.isFinite(aqi) || aqi < 0 || aqi > 500)
            continue;
        observedThrough = String(row.Date) > observedThrough ? String(row.Date) : observedThrough;
        if (!counties[county] || aqi > counties[county].aqi)
            counties[county] = { aqi, category, pollutant, reportingArea: `${countyName} County` };
    }
    if (!Object.keys(counties).length) {
        if (selected.length)
            throw new Error("EPA county observations failed validation for period");
        throw new HistoricalDataUnavailable("No EPA county observations for period");
    }
    return { observedThrough: `${observedThrough}T23:59:59Z`, statewideMaxAqi: Math.max(...Object.values(counties).map((reading) => reading.aqi)), counties };
}
function plainText(html: string) {
    return html.replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").trim();
}
async function tickStateHtml() {
    const href = "https://www.mass.gov/lists/tick-borne-disease-surveillance-summaries-and-data";
    return cachedPublisherFetch(href, twelveHours, async () => {
        const response = await fetch(href, { signal: AbortSignal.timeout(12000), cache: "no-store", headers: { "User-Agent": "Corvid Health Intelligence public-data connector" } });
        if (!response.ok)
            throw new Error(`MassDPH tick table responded with ${response.status}`);
        return response.text();
    });
}
async function tickStateSnapshot(year: number) {
    const html = await tickStateHtml();
    const table = html.match(/<caption>Tickborne Diseases Reported in Massachusetts,[\s\S]*?<\/table>/i)?.[0];
    if (!table)
        throw new Error("MassDPH tick table not found");
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => plainText(cell[1])));
    const column = rows[0].findIndex((cell) => Number(cell.match(/\d{4}/)?.[0]) === year);
    if (column < 1)
        throw new HistoricalDataUnavailable("No tick table year");
    const names = { Lyme: "Lyme Disease", Anaplasmosis: "Human Granulocytic Anaplasmosis", Babesiosis: "Babesiosis", "B. miyamotoi": "Borrelia miyamotoi", Powassan: "Powassan virus" } as const;
    const cases = Object.fromEntries(Object.entries(names).map(([name, published]) => {
        const row = rows.find((candidate) => candidate[0].startsWith(published));
        if (!row)
            throw new Error(`Missing ${name} row`);
        return [name, nonNegativePublisherInteger.parse(row[column]?.replaceAll(",", ""))];
    })) as RespiratoryOutlook["auxiliary"]["tickState"]["cases"];
    return { observedThrough: `${year}-12-31`, cases };
}
export async function getHistoricalOutlook(period: string, options: {
    strict?: boolean;
} = {}): Promise<RespiratoryOutlook> {
    if (!isValidHistoryPeriod(period))
        throw new Error("Invalid history period");
    const strict = options.strict === true;
    const { year, endDate } = periodBounds(period);
    const base = structuredClone(LAST_VALID_OUTLOOK);
    const sourceWarnings: Array<{
        source: string;
        message: string;
    }> = [];
    const layers = unavailableLayers(`No machine-readable publisher snapshot is available for ${period}.`);
    const [respiratory, wastewater, details] = await Promise.all([
        historicalConnector(respiratorySnapshot(period), "CDC respiratory", strict, sourceWarnings),
        Promise.all(wastewaterIds.map((id) => historicalConnector(wastewaterSnapshot(id, period), `CDC wastewater ${id}`, strict, sourceWarnings))),
        Promise.all([
            historicalConnector(lymeSnapshot(year), "CDC Lyme", strict, sourceWarnings),
            historicalConnector(tickStateSnapshot(year), "MassDPH tick", strict, sourceWarnings),
            historicalConnector(hospitalSnapshot(period), "CDC hospital", strict, sourceWarnings),
            historicalConnector(airQualitySnapshot(period), "EPA AirData", strict, sourceWarnings),
            historicalConnector(getHistoricalCapacityContext(period), "MassDPH capacity", strict, sourceWarnings),
        ]),
    ]);
    if (respiratory) {
        Object.assign(base, respiratory);
        for (let index = 0; index < 3; index += 1)
            setAvailability(layers, "respiratory", index, true, `Latest CDC NSSP week available by ${endDate}.`);
    }
    const wastewaterKeys = ["influenzaA", "sarsCov2", "rsv", "measles", "influenzaAH5", "mpox"] as const;
    wastewater.forEach((snapshot, index) => {
        if (snapshot) {
            base.auxiliary.wastewater[wastewaterKeys[index]] = snapshot;
            setAvailability(layers, "wastewater", index, true, `Latest 14-day CDC NWSS sample window ending in ${period}.`);
        }
    });
    const [lyme, tickState, hospital, airQuality, capacity] = details;
    if (lyme) {
        base.auxiliary.lyme = lyme;
        setAvailability(layers, "ticks", 0, true, `CDC county Lyme data are annual; the ${year} total is shown for every month in that year.`);
    }
    if (tickState) {
        base.auxiliary.tickState = tickState;
        for (let index = 1; index < 5; index += 1)
            setAvailability(layers, "ticks", index, true, `MassDPH cases are annual; the ${year} total is shown for every month in that year.`);
    }
    if (year === 2022) {
        setAvailability(layers, "ticks", 1, true, "CDC county data are annual; the 2022 total is shown for every month in 2022.");
        setAvailability(layers, "ticks", 2, true, "CDC county data are annual; the 2022 total is shown for every month in 2022.");
    }
    if (hospital) {
        base.auxiliary.hospital = hospital;
        setAvailability(layers, "hospital", 0, true, `Latest CDC NHSN week available by ${endDate}.`);
    }
    if (airQuality) {
        base.auxiliary.environment.airQuality = airQuality;
        setAvailability(layers, "environment", 1, true, `Highest certified daily county AQI observed during ${period}.`);
    }
    if (capacity) {
        base.auxiliary.capacity = capacity;
        const readings = Object.values(capacity.counties);
        const available = [
            readings.some((reading) => reading.staffedBeds > 0),
            readings.some((reading) => reading.staffedIcuBeds > 0),
            readings.some((reading) => reading.edVisits > 0),
            readings.some((reading) => reading.edVisits > 0 && reading.edLengthOfStayMinutes > 0),
            readings.some((reading) => reading.ambulanceRuns > 0),
        ];
        available.forEach((hasData, index) => {
            if (hasData)
                setAvailability(layers, "capacity", index, true, `MassDPH facility and ambulance observations for ${period}.`);
        });
    }
    base.status = "historical";
    base.retrievedAt = new Date().toISOString();
    base.sourceWarnings = sourceWarnings.length ? sourceWarnings : undefined;
    base.view = { mode: "historical", requestedPeriod: period, layers };
    return base;
}
