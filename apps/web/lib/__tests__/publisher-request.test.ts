import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { publisherHeaders } from "@/lib/publisher-request";
afterEach(() => { delete process.env.CDC_SOCRATA_APP_TOKEN; });
describe("publisherHeaders", () => {
    it("identifies the connector and sends a configured token only to CDC Socrata", () => {
        process.env.CDC_SOCRATA_APP_TOKEN = "test-token";
        expect(publisherHeaders("https://data.cdc.gov/resource/example.json", "application/json")).toMatchObject({
            Accept: "application/json",
            "User-Agent": "Open Regional Health public-data connector",
            "X-App-Token": "test-token",
        });
        expect(publisherHeaders("https://www.cdc.gov/data.csv", "text/csv")).not.toHaveProperty("X-App-Token");
    });
});
