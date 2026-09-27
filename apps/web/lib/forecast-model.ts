import type { ForecastEstimate, ForecastHorizon, ForecastObservation } from "@/lib/forecast-contracts";
export const FORECAST_MODEL_VERSION = "adaptive-ensemble-v2";
const WEEK = 7 * 86400000;
const METHODS = ["persistence", "robust-trend", "seasonal", "adjusted-seasonal"] as const;
type Method = typeof METHODS[number];
type Candidates = Partial<Record<Method, number>>;
type Trial = {
    target: string;
    actual: number;
    candidates: Candidates;
    prediction: number;
    scale: number;
    width: number | null;
};
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const dateAfter = (date: string, weeks: number) => new Date(time(date) + weeks * WEEK).toISOString().slice(0, 10);
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
function validSeries(points: ForecastObservation[]) {
    return points.length >= 64 && points.slice(-64).every((point, i, recent) => {
        const gap = i ? (time(point.date) - time(recent[i - 1].date)) / WEEK : 1;
        return gap >= 1 && gap <= 2 && Number.isInteger(gap);
    });
}
function candidates(points: ForecastObservation[], steps: number, upperBound: number): Candidates {
    const recent = points.slice(-8);
    const last = points.at(-1)!;
    const slopes = recent.flatMap((a, i) => recent.slice(i + 1).map((b) => (b.value - a.value) / ((time(b.date) - time(a.date)) / WEEK)));
    const slope = median(slopes);
    const level = median(recent.map((p) => p.value + slope * (time(last.date) - time(p.date)) / WEEK));
    const dampedSteps = Array.from({ length: steps }, (_, i) => .9 ** i).reduce((a, b) => a + b, 0);
    const result: Candidates = { persistence: last.value, "robust-trend": Math.max(0, level + slope * dampedSteps) };
    const byDate = new Map(points.map((p) => [p.date, p.value]));
    const seasonal = byDate.get(dateAfter(last.date, steps - 52));
    if (seasonal !== undefined) {
        result.seasonal = seasonal;
        const shifts = recent.slice(-4).flatMap((p) => { const previous = byDate.get(dateAfter(p.date, -52)); return previous === undefined ? [] : [p.value - previous]; });
        if (shifts.length >= 3)
            result["adjusted-seasonal"] = Math.max(0, seasonal + median(shifts));
    }
    return Object.fromEntries(Object.entries(result).map(([method, value]) => [method, Math.min(upperBound, value)])) as Candidates;
}
function blend(values: Candidates, past: Trial[]) {
    const methods = METHODS.filter((method) => values[method] !== undefined);
    const losses = methods.map((method) => {
        const errors = past.slice(-26).flatMap((trial) => trial.candidates[method] === undefined ? [] : [Math.abs(trial.actual - trial.candidates[method]!)]);
        return errors.length >= 8 ? mean(errors) : null;
    });
    const floor = Math.max(1e-8, median(Object.values(values)) * .005);
    const scores = losses.every((loss) => loss !== null) ? losses.map((loss) => 1 / (loss! + floor) ** 2) : methods.map(() => 1);
    const total = scores.reduce((a, b) => a + b, 0);
    const weights = Object.fromEntries(methods.map((method, i) => [method, scores[i] / total]));
    return { value: methods.reduce((sum, method) => sum + values[method]! * weights[method], 0), weights };
}
function intervalWidth(past: Trial[], scale: number): number | null {
    if (past.length < 12)
        return null;
    const scores = past.slice(-52).map((trial) => Math.abs(trial.actual - trial.prediction) / trial.scale).sort((a, b) => a - b);
    return scores[Math.min(scores.length - 1, Math.ceil((scores.length + 1) * .8) - 1)] * scale;
}
export function buildWeeklyForecast(points: ForecastObservation[], options: {
    upperBound?: number;
} = {}): ForecastEstimate[] {
    const upperBound = options.upperBound ?? Number.POSITIVE_INFINITY;
    if (!(upperBound > 0) || points.some((p) => p.value > upperBound))
        return [];
    if (points.some((p) => !Number.isFinite(p.value) || p.value < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !Number.isFinite(time(p.date)) || new Date(time(p.date)).toISOString().slice(0, 10) !== p.date))
        return [];
    const clean = [...new Map(points.map((point) => [point.date, point])).values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!validSeries(clean))
        return [];
    const observations = new Map(clean.map((point) => [point.date, point.value]));
    let previousWidth = 0;
    return ([7, 14, 28] as ForecastHorizon[]).flatMap((horizonDays) => {
        const steps = horizonDays / 7;
        const trials: Trial[] = [];
        for (let origin = Math.max(63, clean.length - 156); origin < clean.length; origin++) {
            const training = clean.slice(0, origin + 1);
            if (!validSeries(training))
                continue;
            const target = dateAfter(clean[origin].date, steps);
            const actual = observations.get(target);
            if (actual === undefined)
                continue;
            const past = trials.filter((trial) => trial.target <= clean[origin].date);
            const values = candidates(training, steps, upperBound);
            const scale = Math.max(.01, median(training.slice(-8).map((p) => p.value)));
            trials.push({ target, actual, candidates: values, prediction: blend(values, past).value, scale, width: intervalWidth(past, scale) });
        }
        const evaluated = trials.filter((trial) => trial.width !== null).slice(-52);
        if (trials.length < 12 || evaluated.length < 12)
            return [];
        const errors = evaluated.map((trial) => Math.abs(trial.actual - trial.prediction));
        const mae = mean(errors);
        const persistenceMae = mean(evaluated.map((trial) => Math.abs(trial.actual - trial.candidates.persistence!)));
        const skill = persistenceMae > 0 ? (1 - mae / persistenceMae) * 100 : 0;
        const coverage = mean(evaluated.map((trial, i) => errors[i] <= trial.width! + 1e-10 ? 1 : 0)) * 100;
        const current = candidates(clean, steps, upperBound);
        const { value, weights } = blend(current, trials);
        const width = Math.max(previousWidth, intervalWidth(trials, Math.max(.01, median(clean.slice(-8).map((p) => p.value))))!);
        previousWidth = width;
        if (![value, width, mae, skill, coverage].every(Number.isFinite))
            return [];
        return [{ horizonDays, targetDate: dateAfter(clean.at(-1)!.date, steps), value,
                lower: Math.max(0, value - width), upper: Math.min(upperBound, value + width), mae,
                intervalCoverage: Math.round(coverage * 10) / 10, skillVsPersistence: Math.round(skill * 10) / 10,
                evidence: skill > 0 && coverage >= 70 ? "supported" as const : "insufficient" as const,
                diagnostics: { modelVersion: FORECAST_MODEL_VERSION, backtestOrigins: trials.length, intervalEvaluationOrigins: evaluated.length,
                    calibrationOrigins: Math.min(trials.length, 52), nominalCoverage: 80, weights,
                    evaluation: "rolling-origin; only matured residuals; revised observations, not prospective vintages" },
            }];
    });
}
