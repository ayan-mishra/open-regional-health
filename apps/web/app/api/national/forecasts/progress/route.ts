import { NextResponse } from "next/server";
import { getForecastProgress } from "@/lib/national-forecast-live";
import { isValidHistoryPeriod } from "@/lib/outlook-history";
import { isSignalId } from "@/lib/signal-catalog";
import { US_JURISDICTIONS } from "@/lib/us-geography";
import { enforceRateLimit, validateQuery } from "@/lib/api-guards";
export async function GET(request: Request) {
    const rateLimit = enforceRateLimit(request, "national-forecasts-progress", 120);
    if (rateLimit.response)
        return rateLimit.response;
    const queryError = validateQuery(request, new Set(["signal", "period"]));
    if (queryError)
        return queryError;
    const params = new URL(request.url).searchParams;
    const signalId = params.get("signal") ?? "covid-ed";
    const period = params.get("period") ?? "";
    if (!isSignalId(signalId))
        return NextResponse.json({ error: "invalid_signal", message: "Signal is not part of Corvid's monitoring catalog." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (period && !isValidHistoryPeriod(period))
        return NextResponse.json({ error: "invalid_period", message: "History period must be a month from January 2018 through the current month." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const progress = getForecastProgress(signalId, period);
    const body = progress ?? { completed: US_JURISDICTIONS.length, total: US_JURISDICTIONS.length };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
