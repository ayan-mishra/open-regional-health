export const RESPIRATORY_LAYERS = ["covid", "influenza", "rsv"] as const;
export type RespiratoryLayer = (typeof RESPIRATORY_LAYERS)[number];
export type Trend = "Increasing" | "No Change" | "Decreasing";
export type RegionOutlook = {
    id: "22" | "32" | "68" | "74" | "101" | "112";
    name: string;
    shortName: string;
    counties: string[];
    values: Record<RespiratoryLayer, number>;
    trends: Record<RespiratoryLayer, Trend>;
};
export type StateOutlook = {
    values: Record<RespiratoryLayer, number>;
    trends: Record<RespiratoryLayer, Trend>;
};
export type WastewaterCountyReading = {
    sitesReporting: number;
    detectedSites: number;
};
export type WastewaterTargetOutlook = {
    observedThrough: string;
    sitesReporting: number;
    detectedSites: number;
    counties: Record<string, WastewaterCountyReading>;
};
export type MosquitoRisk = "Remote" | "Low" | "Moderate" | "High" | "Critical";
export type CountyCapacityReading = {
    availableBeds: number;
    availableIcuBeds: number;
    staffedBeds: number;
    staffedIcuBeds: number;
    edVisits: number;
    edLengthOfStayMinutes: number;
    ambulanceRuns: number;
};
export type LayerAvailability = {
    available: boolean;
    note: string;
};
export type OutlookView = {
    mode: "live" | "historical";
    requestedPeriod: string | null;
    layers: Record<string, LayerAvailability>;
};
export type RespiratoryOutlook = {
    status: "live" | "last-valid" | "historical";
    observedThrough: string;
    buildDate: string;
    retrievedAt: string;
    sourceWarnings?: Array<{
        source: string;
        message: string;
    }>;
    view?: OutlookView;
    state: StateOutlook;
    regions: RegionOutlook[];
    auxiliary: {
        wastewater: {
            influenzaA: WastewaterTargetOutlook;
            sarsCov2: WastewaterTargetOutlook;
            rsv: WastewaterTargetOutlook;
            measles: WastewaterTargetOutlook;
            influenzaAH5: WastewaterTargetOutlook;
            mpox: WastewaterTargetOutlook;
        };
        mosquito: {
            observedThrough: string;
            targets: Record<"EEE" | "West Nile virus", {
                counties: Record<string, {
                    maximumRisk: MosquitoRisk;
                    townsAtMaximum: number;
                    positiveSamples: number;
                    humanCases: number;
                }>;
            }>;
        };
        lyme: {
            observedYear: number;
            totalCases: number;
            countyCases: Record<string, number>;
        };
        tickState: {
            observedThrough: string;
            cases: Record<"Lyme" | "Anaplasmosis" | "Babesiosis" | "B. miyamotoi" | "Powassan", number>;
        };
        tickCounty: {
            observedYear: number;
            cases: Record<"Anaplasmosis" | "Babesiosis", {
                countyCases: Record<string, number>;
            }>;
        };
        environment: {
            heatRisk: {
                observedThrough: string;
                forecastThrough: string;
                counties: Record<string, {
                    currentRisk: number;
                    maxRisk: number;
                }>;
            };
            airQuality: {
                observedThrough: string;
                statewideMaxAqi: number;
                counties: Record<string, {
                    aqi: number;
                    category: string;
                    pollutant: string;
                    reportingArea: string;
                }>;
            };
        };
        recreationalWater: {
            observedThrough: string;
            totalClosures: number;
            bacterialClosures: number;
            latestExceedances: number;
            counties: Record<string, {
                beachesMonitored: number;
                closures: number;
                bacterialClosures: number;
                latestExceedances: number;
            }>;
        };
        hospital: {
            observedThrough: string;
            influenzaAdmissions: number;
            reportingHospitals: number;
            reportingPercent: number;
        };
        capacity: {
            observedThrough: string;
            counties: Record<string, CountyCapacityReading>;
        };
    };
};
export const LAYER_LABELS: Record<RespiratoryLayer, string> = {
    covid: "COVID-19",
    influenza: "Influenza",
    rsv: "RSV",
};
export const REGION_META: Record<RegionOutlook["id"], Omit<RegionOutlook, "values" | "trends">> = {
    "112": { id: "112", name: "Berkshire HSA", shortName: "Berkshire", counties: ["Berkshire"] },
    "68": { id: "68", name: "Bristol HSA", shortName: "Bristol", counties: ["Bristol"] },
    "74": { id: "74", name: "Essex (Lynn) HSA", shortName: "Essex", counties: ["Essex"] },
    "32": { id: "32", name: "Hampden–Hampshire HSA", shortName: "Pioneer Valley", counties: ["Hampden", "Hampshire"] },
    "22": { id: "22", name: "Middlesex–Suffolk (Boston) HSA", shortName: "Greater Boston + Cape", counties: ["Barnstable", "Dukes", "Middlesex", "Nantucket", "Norfolk", "Plymouth", "Suffolk"] },
    "101": { id: "101", name: "Worcester–Franklin HSA", shortName: "Central Massachusetts", counties: ["Worcester", "Franklin"] },
};
const FALLBACK_VALUES: Record<RegionOutlook["id"], [
    number,
    number,
    number
]> = {
    "112": [.31, 0, 0],
    "68": [.07, .03, .02],
    "74": [.19, 0, 0],
    "32": [.06, .03, 0],
    "22": [.06, .02, .01],
    "101": [.03, .01, .03],
};
const FALLBACK_TRENDS: Record<RegionOutlook["id"], [
    Trend,
    Trend,
    Trend
]> = {
    "112": ["No Change", "No Change", "No Change"],
    "68": ["No Change", "No Change", "No Change"],
    "74": ["No Change", "No Change", "Decreasing"],
    "32": ["No Change", "No Change", "Decreasing"],
    "22": ["No Change", "No Change", "No Change"],
    "101": ["No Change", "No Change", "No Change"],
};
const FALLBACK_WASTEWATER_ZERO: WastewaterTargetOutlook = {
    observedThrough: "2026-07-20", sitesReporting: 6, detectedSites: 0,
    counties: {
        ESSEX: { sitesReporting: 1, detectedSites: 0 }, HAMPDEN: { sitesReporting: 1, detectedSites: 0 },
        MIDDLESEX: { sitesReporting: 3, detectedSites: 0 }, NORFOLK: { sitesReporting: 2, detectedSites: 0 },
        PLYMOUTH: { sitesReporting: 1, detectedSites: 0 }, SUFFOLK: { sitesReporting: 3, detectedSites: 0 },
        WORCESTER: { sitesReporting: 2, detectedSites: 0 },
    },
};
const FALLBACK_COUNTIES = ["BARNSTABLE", "BERKSHIRE", "BRISTOL", "DUKES", "ESSEX", "FRANKLIN", "HAMPDEN", "HAMPSHIRE", "MIDDLESEX", "NANTUCKET", "NORFOLK", "PLYMOUTH", "SUFFOLK", "WORCESTER"] as const;
const FALLBACK_MOSQUITO_COUNTS: Record<string, [
    number,
    number,
    number
]> = {
    BARNSTABLE: [15, 2, 0], BERKSHIRE: [32, 3, 0], BRISTOL: [20, 0, 0], DUKES: [7, 0, 0],
    ESSEX: [34, 0, 0], FRANKLIN: [26, 3, 0], HAMPDEN: [23, 0, 0], HAMPSHIRE: [20, 0, 0],
    MIDDLESEX: [5, 9, 0], NANTUCKET: [1, 0, 0], NORFOLK: [1, 2, 0], PLYMOUTH: [27, 1, 0],
    SUFFOLK: [1, 9, 0], WORCESTER: [4, 13, 0],
};
const FALLBACK_AQI: Record<string, [
    number,
    string,
    string,
    string
]> = {
    BARNSTABLE: [44, "Good", "OZONE", "Cape Cod and Islands"], BERKSHIRE: [59, "Moderate", "PM2.5", "Berkshire"],
    BRISTOL: [54, "Moderate", "PM2.5", "North Bristol-Plymouth"], DUKES: [44, "Good", "OZONE", "Cape Cod and Islands"],
    ESSEX: [51, "Moderate", "PM2.5", "Essex"], FRANKLIN: [54, "Moderate", "PM2.5", "Franklin"],
    HAMPDEN: [55, "Moderate", "PM2.5", "Hampden-Hampshire"], HAMPSHIRE: [55, "Moderate", "PM2.5", "Hampden-Hampshire"],
    MIDDLESEX: [56, "Moderate", "PM2.5", "West Middlesex"], NANTUCKET: [44, "Good", "OZONE", "Cape Cod and Islands"],
    NORFOLK: [49, "Good", "PM2.5", "Norfolk"], PLYMOUTH: [54, "Moderate", "PM2.5", "North Bristol-Plymouth"],
    SUFFOLK: [54, "Moderate", "PM2.5", "Boston Metro"], WORCESTER: [52, "Moderate", "PM2.5", "Worcester"],
};
const FALLBACK_CAPACITY: Record<string, CountyCapacityReading> = {
    BARNSTABLE: { availableBeds: 8.7, availableIcuBeds: 3.9, staffedBeds: 71, staffedIcuBeds: 10, edVisits: 2806, edLengthOfStayMinutes: 285, ambulanceRuns: 2413 },
    BERKSHIRE: { availableBeds: 52.5, availableIcuBeds: 7.1, staffedBeds: 196, staffedIcuBeds: 16, edVisits: 2142, edLengthOfStayMinutes: 950.6, ambulanceRuns: 1585 },
    BRISTOL: { availableBeds: 27.3, availableIcuBeds: 13.2, staffedBeds: 691.9, staffedIcuBeds: 69.7, edVisits: 25519, edLengthOfStayMinutes: 219.5, ambulanceRuns: 5741 },
    DUKES: { availableBeds: 5, availableIcuBeds: 1.2, staffedBeds: 17, staffedIcuBeds: 3, edVisits: 1303, edLengthOfStayMinutes: 292.7, ambulanceRuns: 31 },
    ESSEX: { availableBeds: 56.9, availableIcuBeds: 10.4, staffedBeds: 605.4, staffedIcuBeds: 58, edVisits: 21076, edLengthOfStayMinutes: 297, ambulanceRuns: 7475 },
    FRANKLIN: { availableBeds: 4.5, availableIcuBeds: 4.4, staffedBeds: 43, staffedIcuBeds: 6, edVisits: 2767, edLengthOfStayMinutes: 379.3, ambulanceRuns: 711 },
    HAMPDEN: { availableBeds: 68.8, availableIcuBeds: 22.1, staffedBeds: 792.2, staffedIcuBeds: 86.2, edVisits: 28330, edLengthOfStayMinutes: 493.4, ambulanceRuns: 6604 },
    HAMPSHIRE: { availableBeds: 15.2, availableIcuBeds: 7, staffedBeds: 85.5, staffedIcuBeds: 11, edVisits: 3561, edLengthOfStayMinutes: 354, ambulanceRuns: 1314 },
    MIDDLESEX: { availableBeds: 189.6, availableIcuBeds: 53.6, staffedBeds: 1382, staffedIcuBeds: 181.7, edVisits: 49391, edLengthOfStayMinutes: 261.3, ambulanceRuns: 11479 },
    NANTUCKET: { availableBeds: 5.3, availableIcuBeds: 0, staffedBeds: 10, staffedIcuBeds: 0, edVisits: 827, edLengthOfStayMinutes: 227.3, ambulanceRuns: 66 },
    NORFOLK: { availableBeds: 36.4, availableIcuBeds: 9.1, staffedBeds: 480.7, staffedIcuBeds: 35.5, edVisits: 17270, edLengthOfStayMinutes: 257.2, ambulanceRuns: 5517 },
    PLYMOUTH: { availableBeds: 51.6, availableIcuBeds: 14.6, staffedBeds: 418.2, staffedIcuBeds: 52.5, edVisits: 16312, edLengthOfStayMinutes: 355.3, ambulanceRuns: 5279 },
    SUFFOLK: { availableBeds: 288.4, availableIcuBeds: 108.8, staffedBeds: 2879.1, staffedIcuBeds: 614.4, edVisits: 54923, edLengthOfStayMinutes: 371.2, ambulanceRuns: 8369 },
    WORCESTER: { availableBeds: 133.9, availableIcuBeds: 30.4, staffedBeds: 1018.3, staffedIcuBeds: 177.4, edVisits: 30644, edLengthOfStayMinutes: 289.4, ambulanceRuns: 7512 },
};
export const LAST_VALID_OUTLOOK: RespiratoryOutlook = {
    status: "last-valid",
    observedThrough: "2026-07-18",
    buildDate: "2026-07-24",
    retrievedAt: "2026-07-28T00:00:00.000Z",
    state: {
        values: { covid: .08, influenza: .02, rsv: .01 },
        trends: { covid: "No Change", influenza: "No Change", rsv: "Decreasing" },
    },
    auxiliary: {
        wastewater: {
            influenzaA: {
                observedThrough: "2026-07-20",
                sitesReporting: 6,
                detectedSites: 0,
                counties: {
                    ESSEX: { sitesReporting: 1, detectedSites: 0 },
                    HAMPDEN: { sitesReporting: 1, detectedSites: 0 },
                    MIDDLESEX: { sitesReporting: 3, detectedSites: 0 },
                    NORFOLK: { sitesReporting: 2, detectedSites: 0 },
                    PLYMOUTH: { sitesReporting: 1, detectedSites: 0 },
                    SUFFOLK: { sitesReporting: 3, detectedSites: 0 },
                    WORCESTER: { sitesReporting: 2, detectedSites: 0 },
                },
            },
            sarsCov2: {
                observedThrough: "2026-07-20",
                sitesReporting: 6,
                detectedSites: 5,
                counties: {
                    ESSEX: { sitesReporting: 1, detectedSites: 1 },
                    HAMPDEN: { sitesReporting: 1, detectedSites: 0 },
                    MIDDLESEX: { sitesReporting: 3, detectedSites: 3 },
                    NORFOLK: { sitesReporting: 2, detectedSites: 2 },
                    PLYMOUTH: { sitesReporting: 1, detectedSites: 1 },
                    SUFFOLK: { sitesReporting: 3, detectedSites: 3 },
                    WORCESTER: { sitesReporting: 2, detectedSites: 2 },
                },
            },
            rsv: FALLBACK_WASTEWATER_ZERO,
            measles: { ...FALLBACK_WASTEWATER_ZERO, sitesReporting: 1, counties: { HAMPDEN: { sitesReporting: 1, detectedSites: 0 } } },
            influenzaAH5: FALLBACK_WASTEWATER_ZERO,
            mpox: FALLBACK_WASTEWATER_ZERO,
        },
        mosquito: {
            observedThrough: "2026-07-28",
            targets: {
                EEE: { counties: Object.fromEntries(FALLBACK_COUNTIES.map((county) => [county, { maximumRisk: "Low" as const, townsAtMaximum: FALLBACK_MOSQUITO_COUNTS[county][0], positiveSamples: 0, humanCases: 0 }])) },
                "West Nile virus": { counties: Object.fromEntries(FALLBACK_COUNTIES.map((county) => [county, { maximumRisk: (["MIDDLESEX", "NORFOLK", "SUFFOLK", "WORCESTER"].includes(county) ? "Moderate" : "Low") as MosquitoRisk, townsAtMaximum: FALLBACK_MOSQUITO_COUNTS[county][0], positiveSamples: FALLBACK_MOSQUITO_COUNTS[county][1], humanCases: FALLBACK_MOSQUITO_COUNTS[county][2] }])) },
            },
        },
        lyme: {
            observedYear: 2023,
            totalCases: 9682,
            countyCases: {
                BARNSTABLE: 774, BERKSHIRE: 588, BRISTOL: 1688, DUKES: 337, ESSEX: 640,
                FRANKLIN: 143, HAMPDEN: 218, HAMPSHIRE: 260, MIDDLESEX: 1348, NANTUCKET: 185,
                NORFOLK: 743, PLYMOUTH: 1385, SUFFOLK: 229, WORCESTER: 1144,
            },
        },
        tickState: {
            observedThrough: "2026-06-30",
            cases: { Lyme: 2761, Anaplasmosis: 720, Babesiosis: 114, "B. miyamotoi": 23, Powassan: 8 },
        },
        tickCounty: {
            observedYear: 2022,
            cases: {
                Anaplasmosis: { countyCases: { BARNSTABLE: 145, BERKSHIRE: 220, BRISTOL: 215, DUKES: 32, ESSEX: 101, FRANKLIN: 113, HAMPDEN: 73, HAMPSHIRE: 111, MIDDLESEX: 409, NANTUCKET: 8, NORFOLK: 115, PLYMOUTH: 238, SUFFOLK: 35, WORCESTER: 307 } },
                Babesiosis: { countyCases: { BARNSTABLE: 183, BERKSHIRE: 44, BRISTOL: 229, DUKES: 51, ESSEX: 60, FRANKLIN: 4, HAMPDEN: 26, HAMPSHIRE: 9, MIDDLESEX: 145, NANTUCKET: 53, NORFOLK: 77, PLYMOUTH: 208, SUFFOLK: 18, WORCESTER: 108 } },
            },
        },
        environment: {
            heatRisk: {
                observedThrough: "2026-07-28", forecastThrough: "2026-08-03",
                counties: Object.fromEntries(FALLBACK_COUNTIES.map((county) => [county, { currentRisk: 1, maxRisk: county === "BARNSTABLE" ? 2 : 1 }])),
            },
            airQuality: {
                observedThrough: "2026-07-28T17:00:00-04:00", statewideMaxAqi: 59,
                counties: Object.fromEntries(Object.entries(FALLBACK_AQI).map(([county, [aqi, category, pollutant, reportingArea]]) => [county, { aqi, category, pollutant, reportingArea }])),
            },
        },
        recreationalWater: {
            observedThrough: "2026-07-27", totalClosures: 26, bacterialClosures: 19, latestExceedances: 15,
            counties: {
                BARNSTABLE: { beachesMonitored: 246, closures: 0, bacterialClosures: 0, latestExceedances: 0 }, BERKSHIRE: { beachesMonitored: 27, closures: 0, bacterialClosures: 0, latestExceedances: 1 },
                BRISTOL: { beachesMonitored: 50, closures: 1, bacterialClosures: 1, latestExceedances: 1 }, DUKES: { beachesMonitored: 41, closures: 3, bacterialClosures: 1, latestExceedances: 1 },
                ESSEX: { beachesMonitored: 100, closures: 12, bacterialClosures: 11, latestExceedances: 8 }, FRANKLIN: { beachesMonitored: 10, closures: 0, bacterialClosures: 0, latestExceedances: 0 },
                HAMPDEN: { beachesMonitored: 14, closures: 1, bacterialClosures: 0, latestExceedances: 0 }, HAMPSHIRE: { beachesMonitored: 7, closures: 2, bacterialClosures: 2, latestExceedances: 0 },
                MIDDLESEX: { beachesMonitored: 52, closures: 1, bacterialClosures: 0, latestExceedances: 0 }, NANTUCKET: { beachesMonitored: 16, closures: 0, bacterialClosures: 0, latestExceedances: 0 },
                NORFOLK: { beachesMonitored: 34, closures: 1, bacterialClosures: 1, latestExceedances: 0 }, PLYMOUTH: { beachesMonitored: 98, closures: 1, bacterialClosures: 1, latestExceedances: 2 },
                SUFFOLK: { beachesMonitored: 20, closures: 1, bacterialClosures: 1, latestExceedances: 0 }, WORCESTER: { beachesMonitored: 47, closures: 3, bacterialClosures: 1, latestExceedances: 2 },
            },
        },
        hospital: { observedThrough: "2026-07-18", influenzaAdmissions: 0, reportingHospitals: 86, reportingPercent: 95.56 },
        capacity: { observedThrough: "2026-05-01", counties: FALLBACK_CAPACITY },
    },
    regions: (Object.keys(REGION_META) as RegionOutlook["id"][]).map((id) => ({
        ...REGION_META[id],
        values: { covid: FALLBACK_VALUES[id][0], influenza: FALLBACK_VALUES[id][1], rsv: FALLBACK_VALUES[id][2] },
        trends: { covid: FALLBACK_TRENDS[id][0], influenza: FALLBACK_TRENDS[id][1], rsv: FALLBACK_TRENDS[id][2] },
    })),
};
