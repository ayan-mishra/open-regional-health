import { NextResponse } from "next/server";
import { enforceRateLimit, validateQuery } from "@/lib/api-guards";
export const revalidate = 43200;
export async function GET(request: Request) {
    const queryError = validateQuery(request, new Set());
    if (queryError)
        return queryError;
    const rateLimit = enforceRateLimit(request, "national-feed");
    if (rateLimit.response)
        return rateLimit.response;
    return NextResponse.json({ error: "national_feed_retired", message: "Request one signal through /api/national/outlook." }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
