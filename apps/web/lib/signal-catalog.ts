export const SIGNAL_DOMAINS = ["respiratory", "mosquito", "ticks", "notifiable", "wastewater", "environment", "hospital", "capacity"] as const;
export type SignalDomain = (typeof SIGNAL_DOMAINS)[number];
export type EvidenceMode = "modeled" | "official" | "planning";
export const SIGNAL_CATALOG = [
    { id: "covid-ed", domain: "respiratory", label: "COVID-19 ED activity", shortLabel: "COVID-19", unit: "% of ED visits", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NSSP" },
    { id: "influenza-ed", domain: "respiratory", label: "Influenza ED activity", shortLabel: "Influenza", unit: "% of ED visits", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NSSP" },
    { id: "rsv-ed", domain: "respiratory", label: "RSV ED activity", shortLabel: "RSV", unit: "% of ED visits", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NSSP" },
    { id: "wnv-activity", domain: "mosquito", label: "West Nile incidence", shortLabel: "West Nile", unit: "cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "lyme-cases", domain: "ticks", label: "Lyme disease", shortLabel: "Lyme", unit: "cases per 100,000", direction: "higher-is-worse", defaultEvidence: "planning", source: "CDC" },
    { id: "anaplasmosis-cases", domain: "ticks", label: "Anaplasmosis", shortLabel: "Anaplasmosis", unit: "cases per 100,000", direction: "higher-is-worse", defaultEvidence: "planning", source: "CDC NNDSS through 2023" },
    { id: "babesiosis-cases", domain: "ticks", label: "Babesiosis", shortLabel: "Babesiosis", unit: "cases per 100,000", direction: "higher-is-worse", defaultEvidence: "planning", source: "CDC NNDSS through 2024" },
    { id: "b-miyamotoi-presence", domain: "ticks", label: "B. miyamotoi documented presence", shortLabel: "B. miyamotoi", unit: "documented county presence", direction: "higher-is-worse", defaultEvidence: "planning", source: "CDC ArboNET Tick Module" },
    { id: "powassan-cases", domain: "ticks", label: "Powassan", shortLabel: "Powassan", unit: "cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "pertussis-cases", domain: "notifiable", label: "Pertussis incidence", shortLabel: "Pertussis", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "measles-cases", domain: "notifiable", label: "Measles incidence", shortLabel: "Measles cases", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "mumps-cases", domain: "notifiable", label: "Mumps incidence", shortLabel: "Mumps", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "hepatitis-a-cases", domain: "notifiable", label: "Hepatitis A incidence", shortLabel: "Hepatitis A", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "campylobacteriosis-cases", domain: "notifiable", label: "Campylobacteriosis incidence", shortLabel: "Campylobacteriosis", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "salmonellosis-cases", domain: "notifiable", label: "Salmonellosis incidence", shortLabel: "Salmonellosis", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "shigellosis-cases", domain: "notifiable", label: "Shigellosis incidence", shortLabel: "Shigellosis", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "stec-cases", domain: "notifiable", label: "STEC incidence", shortLabel: "STEC", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "legionellosis-cases", domain: "notifiable", label: "Legionellosis incidence", shortLabel: "Legionellosis", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "meningococcal-cases", domain: "notifiable", label: "Meningococcal disease incidence", shortLabel: "Meningococcal", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "dengue-cases", domain: "notifiable", label: "Dengue incidence", shortLabel: "Dengue", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "mpox-cases", domain: "notifiable", label: "Mpox incidence", shortLabel: "Mpox cases", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "pneumococcal-cases", domain: "notifiable", label: "Invasive pneumococcal disease", shortLabel: "Pneumococcal", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "congenital-syphilis-cases", domain: "notifiable", label: "Congenital syphilis incidence", shortLabel: "Congenital syphilis", unit: "weekly cases per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NNDSS" },
    { id: "influenza-a-wval", domain: "wastewater", label: "Influenza A wastewater", shortLabel: "Influenza A", unit: "viral activity level", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NWSS" },
    { id: "sars-cov-2-wval", domain: "wastewater", label: "SARS-CoV-2 wastewater", shortLabel: "SARS-CoV-2", unit: "viral activity level", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NWSS" },
    { id: "rsv-wval", domain: "wastewater", label: "RSV wastewater", shortLabel: "RSV", unit: "viral activity level", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NWSS" },
    { id: "measles-detection", domain: "wastewater", label: "Measles wastewater", shortLabel: "Measles", unit: "% reporting sites detected", direction: "higher-is-worse", defaultEvidence: "planning", source: "CDC NWSS" },
    { id: "influenza-a-h5-detection", domain: "wastewater", label: "Influenza A H5 wastewater", shortLabel: "Influenza A H5", unit: "% reporting sites detected", direction: "higher-is-worse", defaultEvidence: "planning", source: "CDC NWSS" },
    { id: "mpox-detection", domain: "wastewater", label: "Mpox wastewater", shortLabel: "Mpox", unit: "% reporting sites detected", direction: "higher-is-worse", defaultEvidence: "planning", source: "CDC NWSS" },
    { id: "heatrisk", domain: "environment", label: "HeatRisk", shortLabel: "HeatRisk", unit: "HeatRisk level 0 to 4", direction: "higher-is-worse", defaultEvidence: "official", source: "NOAA NWS" },
    { id: "air-quality", domain: "environment", label: "Air quality", shortLabel: "Air quality", unit: "AQI", direction: "higher-is-worse", defaultEvidence: "official", source: "EPA AirNow" },
    { id: "influenza-admissions", domain: "hospital", label: "Influenza hospital admissions", shortLabel: "Influenza admissions", unit: "admissions per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NHSN" },
    { id: "covid-admissions", domain: "hospital", label: "COVID-19 hospital admissions", shortLabel: "COVID-19 admissions", unit: "admissions per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NHSN" },
    { id: "rsv-admissions", domain: "hospital", label: "RSV hospital admissions", shortLabel: "RSV admissions", unit: "admissions per 100,000", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NHSN" },
    { id: "covid-inpatient-burden", domain: "hospital", label: "Inpatient beds occupied by COVID-19", shortLabel: "COVID-19 bed burden", unit: "% inpatient beds", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NHSN" },
    { id: "influenza-inpatient-burden", domain: "hospital", label: "Inpatient beds occupied by influenza", shortLabel: "Influenza bed burden", unit: "% inpatient beds", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NHSN" },
    { id: "rsv-inpatient-burden", domain: "hospital", label: "Inpatient beds occupied by RSV", shortLabel: "RSV bed burden", unit: "% inpatient beds", direction: "higher-is-worse", defaultEvidence: "modeled", source: "CDC NHSN" },
    { id: "available-beds", domain: "capacity", label: "Available inpatient beds", shortLabel: "Available beds", unit: "% beds available", direction: "lower-is-worse", defaultEvidence: "modeled", source: "CDC NHSN" },
    { id: "icu-availability", domain: "capacity", label: "ICU availability", shortLabel: "ICU availability", unit: "% ICU beds available", direction: "lower-is-worse", defaultEvidence: "modeled", source: "CDC NHSN" },
    { id: "ed-wait", domain: "capacity", label: "Emergency-department length of stay", shortLabel: "ED length of stay", unit: "minutes", direction: "higher-is-worse", defaultEvidence: "planning", source: "CMS Care Compare" },
] as const satisfies readonly {
    id: string;
    domain: SignalDomain;
    label: string;
    shortLabel: string;
    unit: string;
    direction: "higher-is-worse" | "lower-is-worse";
    defaultEvidence: EvidenceMode;
    source: string;
}[];
export type SignalDefinition = (typeof SIGNAL_CATALOG)[number];
export type SignalId = SignalDefinition["id"];
export const SIGNAL_IDS = SIGNAL_CATALOG.map((signal) => signal.id) as SignalId[];
export const SIGNAL_BY_ID = Object.fromEntries(SIGNAL_CATALOG.map((signal) => [signal.id, signal])) as Record<SignalId, SignalDefinition>;
export function isSignalId(value: string): value is SignalId {
    return Object.hasOwn(SIGNAL_BY_ID, value);
}
