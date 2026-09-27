import { NextResponse } from "next/server";
import { getNationalForecast } from "@/lib/national-forecast-live";
import { getServerForecastSnapshot } from "@/lib/server-public-snapshot";
import { isValidHistoryPeriod } from "@/lib/outlook-history";
import { isSignalId } from "@/lib/signal-catalog";
import { EXCLUDED_JURISDICTIONS, isIncludedJurisdiction } from "@/lib/us-geography";
import { enforceRateLimit, validateQuery } from "@/lib/api-guards";
export const revalidate = 43200;
export async function GET(request: Request) {
    const rateLimit = enforceRateLimit(request, "national-forecasts");
    if (rateLimit.response)
        return rateLimit.response;
    const queryError = validateQuery(request, new Set(["signal", "state", "period", "horizon"]));
    if (queryError)
        return queryError;
    const params = new URL(request.url).searchParams;
    const signalId = params.get("signal") ?? "covid-ed";
    const state = params.get("state")?.toUpperCase() ?? null;
    const period = params.get("period");
    const horizonParam = params.get("horizon") ?? "7";
    if (!isSignalId(signalId))
        return NextResponse.json({ error: "invalid_signal", message: "Signal is not part of Corvid's monitoring catalog." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (!["7", "14", "28"].includes(horizonParam))
        return NextResponse.json({ error: "invalid_horizon", message: "Forecast horizon must be 7, 14, or 28 days." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (state && EXCLUDED_JURISDICTIONS.has(state))
        return NextResponse.json({ error: "excluded_jurisdiction", message: "Alaska, Hawaii, and U.S. territories are outside this contiguous U.S. release." }, { status: 422, headers: { "Cache-Control": "no-store" } });
    if (state && !isIncludedJurisdiction(state))
        return NextResponse.json({ error: "invalid_jurisdiction", message: "State code is not supported." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (period && !isValidHistoryPeriod(period))
        return NextResponse.json({ error: "invalid_period", message: "History period must be a month from January 2018 through the current month." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    try {
        const horizon = Number(horizonParam) as 7 | 14 | 28;
        const body = !state && !period && horizon === 28
            ? await getServerForecastSnapshot(signalId, "")
            : await getNationalForecast({ signalId, stateCode: state && isIncludedJurisdiction(state) ? state : null, horizon, period });
        if (!body)
            throw new Error("No forecast snapshot is available.");
        const hasUsableData = body.states.some((state) => state.value !== null) || body.details.some((detail) => detail.value !== null);
        if (body.status === "partial" && !hasUsableData)
            return NextResponse.json({ error: "national_forecast_unavailable", message: "National forecasts are temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
        return NextResponse.json(body, { headers: { "Cache-Control": body.status === "current" ? "public, max-age=300" : "no-store" } });
    }
    catch {
        return NextResponse.json({ error: "national_forecast_unavailable", message: "National forecasts are temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
}
