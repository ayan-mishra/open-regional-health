import { NextResponse } from "next/server";
import { getFeedProgress } from "@/lib/national-live";
import { isValidHistoryPeriod } from "@/lib/outlook-history";
import { SIGNAL_CATALOG } from "@/lib/signal-catalog";
import { enforceRateLimit, validateQuery } from "@/lib/api-guards";
export async function GET(request: Request) {
    const queryError = validateQuery(request, new Set(["period"]));
    if (queryError)
        return queryError;
    const rateLimit = enforceRateLimit(request, "national-feed-progress", 120);
    if (rateLimit.response)
        return rateLimit.response;
    const params = new URL(request.url).searchParams;
    const period = params.get("period");
    if (period && !isValidHistoryPeriod(period))
        return NextResponse.json({ error: "invalid_period", message: "History period must be a month from January 2018 through the current month." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const progress = getFeedProgress(period ?? "");
    const body = progress ?? { completed: SIGNAL_CATALOG.length, total: SIGNAL_CATALOG.length };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
