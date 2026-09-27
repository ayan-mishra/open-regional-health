import type { RelativeDirection } from "./relative-map-colors";
export type ForecastTrend = "increase" | "decrease" | "steady";
export type ForecastOutlook = "worse" | "better" | "neutral";
const STEADY_RELATIVE_THRESHOLD = 0.02;
const STEADY_NEAR_ZERO_THRESHOLD = 0.01;
export function classifyForecastChange(current: number, forecast: number): ForecastTrend {
    const delta = forecast - current;
    if (Math.abs(delta) < 1e-12)
        return "steady";
    if (current === 0)
        return Math.abs(delta) < STEADY_NEAR_ZERO_THRESHOLD ? "steady" : delta > 0 ? "increase" : "decrease";
    return Math.abs(delta) / Math.abs(current) < STEADY_RELATIVE_THRESHOLD ? "steady" : delta > 0 ? "increase" : "decrease";
}
export function forecastOutlook(trend: ForecastTrend, direction: RelativeDirection): ForecastOutlook {
    if (trend === "steady")
        return "neutral";
    const worsening = direction === "higher-is-worse" ? trend === "increase" : trend === "decrease";
    return worsening ? "worse" : "better";
}
export function stateChangeOutlook(current: number | null | undefined, forecast: number | null | undefined, direction: RelativeDirection): ForecastOutlook | null {
    if (current === null || current === undefined || forecast === null || forecast === undefined || !Number.isFinite(current) || !Number.isFinite(forecast))
        return null;
    return forecastOutlook(classifyForecastChange(current, forecast), direction);
}
export function forecastChangeLabel(trend: ForecastTrend): string {
    if (trend === "increase")
        return "Expected to increase";
    if (trend === "decrease")
        return "Expected to decrease";
    return "Little change";
}
export function forecastOutlookLabel(outlook: ForecastOutlook): string {
    if (outlook === "worse")
        return "likely to worsen";
    if (outlook === "better")
        return "likely to improve";
    return "no material shift expected";
}
export function formatSignedDelta(delta: number): string {
    const rounded = Number(delta.toFixed(2));
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}
export function formatForecastPercentChange(current: number, forecast: number): string | null {
    if (current === 0)
        return null;
    const percent = ((forecast - current) / Math.abs(current)) * 100;
    const rounded = Number(percent.toFixed(Math.abs(percent) < 10 ? 1 : 0));
    return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
