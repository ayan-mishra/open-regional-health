import type { IncludedStateCode } from "@/lib/us-geography";
export const POPULATION_CATEGORIES = ["baseline", "environment", "access", "prevention", "resilience"] as const;
export type PopulationCategory = (typeof POPULATION_CATEGORIES)[number];
export type PopulationGeography = "national" | "state" | "county" | "facility" | "hazard";
export type PopulationEstimateType = "observed" | "model-based" | "ranked" | "facility" | "projected";
export type PopulationMeasureStatus = "current" | "stale" | "partial" | "unavailable";
export type PopulationMeasureQuality = "high" | "moderate" | "limited";
export type PopulationTrend = "improving" | "worsening" | "stable" | "unknown";
export type PopulationMeasure = {
    id: string;
    label: string;
    category: PopulationCategory;
    geographyType: PopulationGeography;
    stateCode?: IncludedStateCode;
    fips?: string;
    value: number | null;
    displayValue: string;
    unit: string;
    vintage: string;
    period: string;
    cadence: string;
    estimateType: PopulationEstimateType;
    status: PopulationMeasureStatus;
    source: string;
    sourceUrl: string;
    note: string;
    marginOfError?: number | null;
    numerator?: number | null;
    denominator?: number | null;
    confidenceLow?: number | null;
    confidenceHigh?: number | null;
    comparison?: {
        value: number;
        displayValue: string;
        label: string;
    };
    change?: {
        value: number;
        displayValue: string;
        label: string;
        period: string;
    };
    trend?: PopulationTrend;
    quality?: PopulationMeasureQuality;
};
export type PopulationSection = {
    id: PopulationCategory;
    title: string;
    description: string;
    measures: PopulationMeasure[];
};
export type PopulationSignalContext = {
    id: string;
    label: string;
    unit: string;
    value: number | null;
    displayValue: string;
    geographyType: "state" | "county" | "hsa" | "site";
    stateCode?: IncludedStateCode;
    fips?: string;
    source: string;
    sourceUrl: string;
    observedThrough: string | null;
    status: PopulationMeasureStatus;
    evidence: "observed" | "modeled" | "official" | "planning";
    note: string;
    direction?: "higher-is-worse" | "lower-is-worse";
    pressurePercentile?: number | null;
    forecast?: {
        value: number;
        displayValue: string;
        targetDate: string;
        lower: number;
        upper: number;
    } | null;
};
export type PopulationInsight = {
    id: string;
    title: string;
    summary: string;
    category: PopulationCategory;
    priority: "review" | "watch" | "context";
    evidence: string[];
    action: string;
};
export type PopulationCoverage = {
    available: number;
    partial: number;
    unavailable: number;
    total: number;
    label: string;
};
export type PopulationHealthResponse = {
    retrievedAt: string;
    period: string | null;
    status: "current" | "partial" | "unavailable";
    selectedState: IncludedStateCode | null;
    selectedCountyFips: string | null;
    geographyLabel: string;
    summary: string;
    sections: PopulationSection[];
    signals: PopulationSignalContext[];
    insights: PopulationInsight[];
    coverage: PopulationCoverage;
    errors: Array<{
        source: string;
        message: string;
    }>;
    sources: Array<{
        name: string;
        url: string;
        vintage: string;
        cadence: string;
    }>;
};
