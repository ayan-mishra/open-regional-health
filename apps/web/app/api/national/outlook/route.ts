import { NextResponse } from "next/server";
import { getNationalOutlook, type OutlookTrace } from "@/lib/national-live";
import { getServerOutlookSnapshot } from "@/lib/server-public-snapshot";
import { isValidHistoryPeriod } from "@/lib/outlook-history";
import { isSignalId } from "@/lib/signal-catalog";
import { EXCLUDED_JURISDICTIONS, isIncludedJurisdiction } from "@/lib/us-geography";
import { enforceRateLimit, validateQuery } from "@/lib/api-guards";
export const revalidate = 43200;
export async function GET(request: Request) {
    const queryError = validateQuery(request, new Set(["signal", "state", "period"]));
    if (queryError)
        return queryError;
    const rateLimit = enforceRateLimit(request, "national-outlook");
    if (rateLimit.response)
        return rateLimit.response;
    const params = new URL(request.url).searchParams;
    const signalId = params.get("signal") ?? "covid-ed";
    const stateParam = params.get("state")?.toUpperCase() ?? null;
    const period = params.get("period");
    if (!isSignalId(signalId))
        return NextResponse.json({ error: "invalid_signal", message: "Signal is not part of Corvid's monitoring catalog." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (stateParam && EXCLUDED_JURISDICTIONS.has(stateParam))
        return NextResponse.json({ error: "excluded_jurisdiction", message: "Alaska, Hawaii, and U.S. territories are outside this contiguous U.S. release." }, { status: 422, headers: { "Cache-Control": "no-store" } });
    if (stateParam && !isIncludedJurisdiction(stateParam))
        return NextResponse.json({ error: "invalid_jurisdiction", message: "State code is not a supported contiguous U.S. jurisdiction." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (period && !isValidHistoryPeriod(period))
        return NextResponse.json({ error: "invalid_period", message: "History period must be a month from January 2018 through the current month." }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const trace: OutlookTrace = {};
    const startedAt = performance.now();
    const timing = () => `corvid;desc="${trace.source ?? "snapshot"}";dur=${Math.round(performance.now() - startedAt)}`;
    try {
        const stateCode = stateParam && isIncludedJurisdiction(stateParam) ? stateParam : null;
        const body = stateCode
            ? await getNationalOutlook({ signalId, stateCode, period, trace })
            : await getServerOutlookSnapshot(signalId, period ?? "");
        const hasUsableData = body.states.some((state) => state.value !== null) || body.details.some((detail) => detail.value !== null);
        if (body.status === "partial" && !hasUsableData)
            return NextResponse.json({ error: "national_outlook_unavailable", message: "National surveillance is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
        return NextResponse.json(body, { headers: { "Cache-Control": body.status === "current" ? "public, s-maxage=43200" : "no-store", "Server-Timing": timing() } });
    }
    catch {
        return NextResponse.json({ error: "national_outlook_unavailable", message: "National surveillance is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
}
