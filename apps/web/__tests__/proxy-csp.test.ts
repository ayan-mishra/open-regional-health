import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../proxy";
afterEach(() => vi.unstubAllEnvs());
describe("local proxy CSP", () => {
    it("forwards a per-request nonce and allows no external services", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const response = await proxy(new NextRequest("https://localhost/dashboard"));
        const policy = response.headers.get("content-security-policy") ?? "";
        expect(policy).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
        expect(policy).toContain("connect-src 'self'");
        expect(policy).toContain("connect-src 'self'");
    });
    it("does not upgrade insecure HTTP local requests", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const response = await proxy(new NextRequest("http://127.0.0.1:3100/dashboard"));
        expect(response.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");
    });
});
