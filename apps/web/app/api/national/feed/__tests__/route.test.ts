import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { GET } from "@/app/api/national/feed/route";
describe("national feed route", () => {
    it("rejects query parameters on the retired endpoint", async () => {
        const response = await GET(new Request("http://localhost/api/national/feed?state=MA"));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "unknown_parameter" });
    });
    it("retires the catalog-wide production endpoint before it can fan out", async () => {
        const response = await GET(new Request("http://localhost/api/national/feed"));
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ error: "national_feed_retired" });
    });
});
