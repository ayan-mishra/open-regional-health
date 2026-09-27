import type { SignalDefinition, SignalId } from "@/lib/signal-catalog";
import type { IncludedStateCode } from "@/lib/us-geography";
import type { ForecastEstimate, ForecastObservation } from "@/lib/forecast-contracts";
export type NationalStateReading = {
    ratioBasis?: import("@/lib/regional-math").RatioBasis;
    code: IncludedStateCode;
    name: string;
    value: number | null;
    displayValue: string;
    observedThrough: string | null;
    comparisonEligible: boolean;
    publisherEligible?: boolean;
    isStale?: boolean;
    countyAggregation?: {
        method: "county-mean";
        countyCount: number;
    };
    trend?: "Increasing" | "No Change" | "Decreasing";
    note: string;
};
export type NationalDetailReading = {
    ratioBasis?: import("@/lib/regional-math").RatioBasis;
    id: string;
    name: string;
    stateCode?: IncludedStateCode;
    geographyType: "county" | "hsa" | "state" | "site" | "reporting-area";
    counties: string[];
    value: number | null;
    displayValue: string;
    observedThrough: string | null;
    comparisonEligible: boolean;
    publisherEligible?: boolean;
    isStale?: boolean;
    stateAggregationEligible?: boolean;
    note: string;
    estimate?: ForecastEstimate | null;
    observations?: ForecastObservation[];
    estimates?: ForecastEstimate[];
};
export type NationalOutlookResponse = {
    scope: "national" | "state";
    signal: SignalDefinition;
    catalog: readonly SignalDefinition[];
    retrievedAt: string;
    status: "current" | "partial";
    isStale: boolean;
    period: string | null;
    states: NationalStateReading[];
    selectedState: IncludedStateCode | null;
    details: NationalDetailReading[];
    geography: {
        level: "county" | "hsa" | "site-to-county" | "statewide" | "unavailable";
        countyDataStates: IncludedStateCode[];
        statewideOnlyStates: IncludedStateCode[];
        message: string;
    };
    errors: Array<{
        source: string;
        message: string;
    }>;
};
export type NationalOutlook = Omit<NationalOutlookResponse, "catalog">;
export type NationalFeedResponse = {
    catalog: readonly SignalDefinition[];
    retrievedAt: string;
    refreshHours: 12;
    status: "current" | "partial";
    errors: Array<{
        source: string;
        message: string;
    }>;
    selectedState: IncludedStateCode | null;
    period: string | null;
    outlooks: Record<SignalId, NationalOutlook>;
};
export type NationalForecastState = NationalStateReading & {
    observations?: ForecastObservation[];
    estimate: ForecastEstimate | null;
    latestObserved?: number | null;
};
export type NationalForecastDetailReading = NationalDetailReading & {
    estimate: ForecastEstimate | null;
    observations: ForecastObservation[];
    estimates: ForecastEstimate[];
};
export type NationalForecastEvidence = {
    kind: "modeled";
    model: string;
    observations: ForecastObservation[];
    estimates: ForecastEstimate[];
    evidence: "supported" | "insufficient";
} | {
    kind: "official";
    validThrough: string;
    description: string;
} | {
    kind: "planning";
    description: string;
    latestValue: string;
    nextUpdate: string;
} | {
    kind: "none";
    description: string;
};
export type NationalForecastResponse = {
    signalId: SignalId;
    signal: SignalDefinition;
    catalog: readonly SignalDefinition[];
    horizon: 7 | 14 | 28;
    period: string | null;
    retrievedAt: string;
    status: "current" | "partial";
    states: NationalForecastState[];
    selectedState: IncludedStateCode | null;
    selectedStateName: string | null;
    evidence: NationalForecastEvidence;
    details: NationalForecastDetailReading[];
    errors: Array<{
        source: string;
        message: string;
    }>;
};
export type JurisdictionError = {
    error: "excluded_jurisdiction" | "invalid_jurisdiction";
    message: string;
};
