import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { GET } from "@/app/healthz/route";
describe("web health check", () => {
    it("reports the local web process as ready", async () => {
        const response = await GET();
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: "ok", service: "open-regional-health-web", ready: true });
    });
});
