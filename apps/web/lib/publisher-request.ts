import "server-only";
export const TRANSIENT_PUBLISHER_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
export function publisherHeaders(url: string, accept: string) {
    const headers: Record<string, string> = {
        Accept: accept,
        "User-Agent": "Open Regional Health public-data connector",
    };
    if (new URL(url).hostname === "data.cdc.gov" && process.env.CDC_SOCRATA_APP_TOKEN) {
        headers["X-App-Token"] = process.env.CDC_SOCRATA_APP_TOKEN;
    }
    return headers;
}
