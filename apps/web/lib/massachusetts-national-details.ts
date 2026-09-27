import "server-only";
import type { NationalDetailReading } from "@/lib/national-contracts";
import { getHistoricalOutlook } from "@/lib/outlook-history";
import { getLiveRespiratoryOutlook, liveAirQualityContext, liveCapacityContext, liveWastewaterContext } from "@/lib/outlook-live";
import { LAST_VALID_OUTLOOK, type RespiratoryOutlook, type WastewaterTargetOutlook } from "@/lib/outlook-contracts";
import type { SignalId } from "@/lib/signal-catalog";
const COUNTY_NAMES: Record<string, string> = {
    BARNSTABLE: "Barnstable", BERKSHIRE: "Berkshire", BRISTOL: "Bristol", DUKES: "Dukes",
    ESSEX: "Essex", FRANKLIN: "Franklin", HAMPDEN: "Hampden", HAMPSHIRE: "Hampshire",
    MIDDLESEX: "Middlesex", NANTUCKET: "Nantucket", NORFOLK: "Norfolk", PLYMOUTH: "Plymouth",
    SUFFOLK: "Suffolk", WORCESTER: "Worcester",
};
const STATE_MEAN_COMPATIBLE_SIGNALS = new Set<SignalId>([
    "air-quality", "available-beds", "icu-availability",
    "measles-detection", "influenza-a-h5-detection", "mpox-detection",
]);
type CountyValue = {
    value: number;
    displayValue: string;
    observedThrough: string | null;
    note: string;
};
function countyDetails(signalId: SignalId, readings: Record<string, CountyValue>): NationalDetailReading[] {
    return Object.entries(readings).flatMap(([county, reading]) => {
        const name = COUNTY_NAMES[county];
        if (!name || !Number.isFinite(reading.value))
            return [];
        return [{
                id: `MA:${signalId}:${county}`,
                name: `${name} County`,
                geographyType: "county" as const,
                counties: [name],
                value: reading.value,
                displayValue: reading.displayValue,
                observedThrough: reading.observedThrough,
                comparisonEligible: true,
                stateAggregationEligible: STATE_MEAN_COMPATIBLE_SIGNALS.has(signalId),
                note: reading.note,
            }];
    });
}
function available(outlook: RespiratoryOutlook, key: string) {
    return outlook.view?.mode !== "historical" || outlook.view.layers[key]?.available === true;
}
const WASTEWATER_TARGETS = {
    "measles-detection": ["measles", 3],
    "influenza-a-h5-detection": ["influenzaAH5", 4],
    "mpox-detection": ["mpox", 5],
} as const;
function wastewaterDetails(signalId: SignalId, target: WastewaterTargetOutlook) {
    return countyDetails(signalId, Object.fromEntries(Object.entries(target.counties).filter(([, row]) => row.sitesReporting >= 3 && row.detectedSites >= 0 && row.detectedSites <= row.sitesReporting).map(([county, row]) => [county, {
            value: row.detectedSites / row.sitesReporting * 100,
            displayValue: `${row.detectedSites} of ${row.sitesReporting} sites`,
            observedThrough: target.observedThrough,
            note: `${row.detectedSites} of ${row.sitesReporting} reporting sewershed sites serving this county detected the target. Sewersheds can cross county lines.`,
        }])));
}
function wastewater(outlook: RespiratoryOutlook, signalId: SignalId) {
    const mapping = WASTEWATER_TARGETS[signalId as keyof typeof WASTEWATER_TARGETS];
    if (!mapping)
        return null;
    const [key, index] = mapping;
    if (!available(outlook, `wastewater:${index}`))
        return [];
    return wastewaterDetails(signalId, outlook.auxiliary.wastewater[key]);
}
function airQualityDetails(signalId: SignalId, airQuality: RespiratoryOutlook["auxiliary"]["environment"]["airQuality"]) {
    return countyDetails(signalId, Object.fromEntries(Object.entries(airQuality.counties).map(([county, row]) => [county, {
            value: row.aqi, displayValue: `AQI ${row.aqi}`, observedThrough: airQuality.observedThrough,
            note: `${row.reportingArea} reports ${row.category} air quality; ${row.pollutant} is the primary pollutant.`,
        }])));
}
function capacityDetails(signalId: SignalId, capacity: RespiratoryOutlook["auxiliary"]["capacity"]) {
    const rows: Record<string, CountyValue> = {};
    for (const [county, row] of Object.entries(capacity.counties)) {
        let value: number;
        let displayValue: string;
        if (signalId === "available-beds") {
            if (row.staffedBeds <= 0)
                continue;
            value = row.availableBeds / row.staffedBeds * 100;
            displayValue = `${value.toFixed(1)}% available`;
        }
        else {
            if (row.staffedIcuBeds <= 0)
                continue;
            value = row.availableIcuBeds / row.staffedIcuBeds * 100;
            displayValue = `${value.toFixed(1)}% available`;
        }
        rows[county] = { value, displayValue, observedThrough: capacity.observedThrough, note: "Massachusetts facility observations aggregated to county. Lower bed availability means higher pressure." };
    }
    return countyDetails(signalId, rows);
}
export type MassachusettsFallback = (source: string, observedThrough: string) => void;
async function fallingBackTo<T extends {
    observedThrough: string;
}>(source: string, load: () => Promise<T>, bundled: T, onFallback?: MassachusettsFallback): Promise<T> {
    try {
        return await load();
    }
    catch {
        onFallback?.(source, bundled.observedThrough);
        return bundled;
    }
}
async function liveCountyDetails(signalId: SignalId, onFallback?: MassachusettsFallback): Promise<NationalDetailReading[]> {
    const wastewaterTarget = WASTEWATER_TARGETS[signalId as keyof typeof WASTEWATER_TARGETS];
    if (wastewaterTarget) {
        const [key] = wastewaterTarget;
        return wastewaterDetails(signalId, await fallingBackTo(`MassDPH ${key} wastewater`, () => liveWastewaterContext(key), LAST_VALID_OUTLOOK.auxiliary.wastewater[key], onFallback));
    }
    if (signalId === "air-quality")
        return airQualityDetails(signalId, await fallingBackTo("AirNow Massachusetts monitors", liveAirQualityContext, LAST_VALID_OUTLOOK.auxiliary.environment.airQuality, onFallback));
    return capacityDetails(signalId, await fallingBackTo("MassDPH hospital capacity workbook", liveCapacityContext, LAST_VALID_OUTLOOK.auxiliary.capacity, onFallback));
}
export async function warmMassachusettsCountyConnectors(pause: () => Promise<unknown>) {
    const connectors: Array<readonly [
        string,
        () => Promise<unknown>
    ]> = [
        ["hospital capacity", liveCapacityContext],
        ["air quality", liveAirQualityContext],
        ...Object.values(WASTEWATER_TARGETS).map(([key]) => [`${key} wastewater`, () => liveWastewaterContext(key)] as const),
    ];
    for (const [name, load] of connectors) {
        await load().catch((error: unknown) => {
            console.error(`[warmup] Massachusetts ${name} connector failed`, error instanceof Error ? error.name : "unknown error");
        });
        await pause();
    }
}
export function getMassachusettsOutlook(period: string | null, strict = false): Promise<RespiratoryOutlook> {
    return period ? getHistoricalOutlook(period, { strict }) : getLiveRespiratoryOutlook({ strict });
}
export async function getMassachusettsCountyDetails(signalId: SignalId, period: string | null, preparedOutlook?: RespiratoryOutlook, onFallback?: MassachusettsFallback): Promise<NationalDetailReading[] | null> {
    if (!STATE_MEAN_COMPATIBLE_SIGNALS.has(signalId))
        return null;
    if (!preparedOutlook && !period)
        return liveCountyDetails(signalId, onFallback);
    const outlook = preparedOutlook ?? await getMassachusettsOutlook(period);
    const details = wastewater(outlook, signalId);
    if (details)
        return details;
    if (signalId === "air-quality")
        return available(outlook, "environment:1") ? airQualityDetails(signalId, outlook.auxiliary.environment.airQuality) : [];
    return available(outlook, `capacity:${signalId === "available-beds" ? 0 : 1}`) ? capacityDetails(signalId, outlook.auxiliary.capacity) : [];
}
