import { NextResponse } from "next/server";
type RateLimitEntry = {
    count: number;
    resetAt: number;
};
const buckets = new Map<string, RateLimitEntry>();
const WINDOW_MS = 60000;
const MAX_BUCKETS = 5000;
export function validateQuery(request: Request, allowed: ReadonlySet<string>): NextResponse | null {
    const params = new URL(request.url).searchParams;
    for (const key of new Set(params.keys())) {
        if (!allowed.has(key)) {
            return NextResponse.json({ error: "unknown_parameter", message: `Unsupported query parameter: ${key}.` }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
        if (params.getAll(key).length > 1) {
            return NextResponse.json({ error: "duplicate_parameter", message: `Query parameter may only appear once: ${key}.` }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
    }
    return null;
}
function requestIdentity(request: Request): string {
    const cloudflare = request.headers.get("cf-connecting-ip")?.trim();
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const candidate = cloudflare || forwarded || request.headers.get("x-real-ip") || "anonymous";
    return /^[a-fA-F0-9:.]{1,64}$/.test(candidate) ? candidate : "anonymous";
}
export function enforceRateLimit(request: Request, namespace: string, limit = 60): {
    headers: Record<string, string>;
    response: NextResponse | null;
} {
    const now = Date.now();
    if (buckets.size >= MAX_BUCKETS) {
        for (const [key, entry] of buckets) {
            if (entry.resetAt <= now)
                buckets.delete(key);
        }
        if (buckets.size >= MAX_BUCKETS)
            buckets.delete(buckets.keys().next().value as string);
    }
    const key = `${namespace}:${requestIdentity(request)}`;
    const previous = buckets.get(key);
    const entry = !previous || previous.resetAt <= now
        ? { count: 1, resetAt: now + WINDOW_MS }
        : { count: previous.count + 1, resetAt: previous.resetAt };
    buckets.set(key, entry);
    const remaining = Math.max(0, limit - entry.count);
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    const headers = {
        "RateLimit-Limit": String(limit),
        "RateLimit-Remaining": String(remaining),
        "RateLimit-Reset": String(resetSeconds),
    };
    if (entry.count <= limit)
        return { headers, response: null };
    return {
        headers,
        response: NextResponse.json({ error: "rate_limit_exceeded", message: "Too many requests. Try again shortly." }, { status: 429, headers: { ...headers, "Cache-Control": "no-store", "Retry-After": String(resetSeconds) } }),
    };
}
