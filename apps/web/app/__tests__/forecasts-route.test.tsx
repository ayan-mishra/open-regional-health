import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getCachedServerForecastSnapshot: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-public-snapshot", () => mocks);
import ForecastsRoute from "@/app/forecasts/page";
describe("forecasts route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCachedServerForecastSnapshot.mockReturnValue(null);
    });
    it("renders public forecasts and loads the selected signal snapshot", async () => {
        const result = await ForecastsRoute({ searchParams: Promise.resolve({ signal: "influenza-ed", state: "ma" }) });
        expect(mocks.getCachedServerForecastSnapshot).toHaveBeenCalledWith("influenza-ed", "");
        expect(result.props.initialSignal).toBe("influenza-ed");
        expect(result.props.initialState).toBe("MA");
    });
});
