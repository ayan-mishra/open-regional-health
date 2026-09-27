export type ForecastHorizon = 7 | 14 | 28;
export type ForecastObservation = {
    date: string;
    value: number;
};
export type ForecastEstimate = {
    horizonDays: ForecastHorizon;
    targetDate: string;
    value: number;
    lower: number;
    upper: number;
    mae: number;
    intervalCoverage: number;
    skillVsPersistence: number;
    evidence: "supported" | "insufficient";
    diagnostics?: {
        modelVersion: string;
        backtestOrigins: number;
        intervalEvaluationOrigins: number;
        calibrationOrigins: number;
        nominalCoverage: number;
        weights: Record<string, number>;
        evaluation: string;
    };
};
