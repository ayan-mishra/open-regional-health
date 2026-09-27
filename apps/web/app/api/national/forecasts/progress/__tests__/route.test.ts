import { beforeEach, describe, expect, it, vi } from "vitest";
const getForecastProgress = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/national-forecast-live", () => ({ getForecastProgress }));
import { GET } from "@/app/api/national/forecasts/progress/route";
describe("national forecast progress route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getForecastProgress.mockReturnValue({ completed: 3, total: 49 });
    });
    it("serves progress without an account", async () => {
        const response = await GET(new Request("http://localhost/api/national/forecasts/progress?signal=covid-ed"));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ completed: 3, total: 49 });
        expect(getForecastProgress).toHaveBeenCalledWith("covid-ed", "");
    });
    it("retains query validation", async () => {
        expect((await GET(new Request("http://localhost/api/national/forecasts/progress?format=csv"))).status).toBe(400);
        expect((await GET(new Request("http://localhost/api/national/forecasts/progress?period=2017-12"))).status).toBe(400);
    });
});
