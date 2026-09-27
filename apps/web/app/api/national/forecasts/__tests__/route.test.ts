import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getNationalForecast: vi.fn(), getServerForecastSnapshot: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/national-forecast-live", () => ({ getNationalForecast: mocks.getNationalForecast }));
vi.mock("@/lib/server-public-snapshot", () => ({ getServerForecastSnapshot: mocks.getServerForecastSnapshot }));
import { GET } from "@/app/api/national/forecasts/route";
describe("national forecasts route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getNationalForecast.mockResolvedValue({ status: "current", states: [{ value: 1 }], details: [] });
        mocks.getServerForecastSnapshot.mockResolvedValue({ status: "current", states: [{ value: 1 }], details: [] });
    });
    it("serves validated forecasts without an account", async () => {
        const response = await GET(new Request("http://localhost/api/national/forecasts?signal=covid-ed&horizon=7"));
        expect(response.status).toBe(200);
        expect(mocks.getNationalForecast).toHaveBeenCalledWith({ signalId: "covid-ed", stateCode: null, horizon: 7, period: null });
    });
    it("retains typed excluded-jurisdiction behavior", async () => {
        const response = await GET(new Request("http://localhost/api/national/forecasts?signal=covid-ed&state=HI&horizon=7"));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ error: "excluded_jurisdiction" });
    });
    it("rejects unsupported horizons, periods, and query parameters", async () => {
        expect((await GET(new Request("http://localhost/api/national/forecasts?horizon=30"))).status).toBe(400);
        expect((await GET(new Request("http://localhost/api/national/forecasts?period=2017-12"))).status).toBe(400);
        expect((await GET(new Request("http://localhost/api/national/forecasts?format=csv"))).status).toBe(400);
        expect((await GET(new Request("http://localhost/api/national/forecasts?horizon=7&horizon=14"))).status).toBe(400);
    });
});
