import { describe, expect, it } from "vitest";
import { enforceRateLimit } from "@/lib/api-guards";
describe("API rate limiting", () => {
    it("uses Render's first forwarded address instead of grouping visitors by the edge proxy", () => {
        const namespace = `forwarded-${crypto.randomUUID()}`;
        const first = enforceRateLimit(new Request("https://corvid.test/api", { headers: { "x-forwarded-for": "198.51.100.7, 192.0.2.1" } }), namespace);
        const second = enforceRateLimit(new Request("https://corvid.test/api", { headers: { "x-forwarded-for": "198.51.100.7, 192.0.2.2" } }), namespace);
        expect(first.headers["RateLimit-Remaining"]).toBe("59");
        expect(second.headers["RateLimit-Remaining"]).toBe("58");
    });
    it("prefers Cloudflare's canonical client address over a spoofable forwarded prefix", () => {
        const namespace = `cloudflare-${crypto.randomUUID()}`;
        const first = enforceRateLimit(new Request("https://corvid.test/api", { headers: {
                "cf-connecting-ip": "198.51.100.8",
                "x-forwarded-for": "203.0.113.1, 192.0.2.1",
            } }), namespace);
        const second = enforceRateLimit(new Request("https://corvid.test/api", { headers: {
                "cf-connecting-ip": "198.51.100.8",
                "x-forwarded-for": "203.0.113.2, 192.0.2.1",
            } }), namespace);
        expect(first.headers["RateLimit-Remaining"]).toBe("59");
        expect(second.headers["RateLimit-Remaining"]).toBe("58");
    });
});
