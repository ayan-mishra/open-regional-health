import { NextResponse } from "next/server";
export async function GET() {
    return NextResponse.json({
        status: "ok",
        service: "open-regional-health-web",
        ready: true,
    }, { headers: { "Cache-Control": "no-store" } });
}
