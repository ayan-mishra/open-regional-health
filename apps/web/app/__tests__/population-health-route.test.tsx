import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ countyReference: vi.fn(), getPopulationHealthContext: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/county-reference", () => ({ countyReference: mocks.countyReference }));
vi.mock("@/lib/population-health-sources", () => ({
    getPopulationHealthContext: mocks.getPopulationHealthContext,
    normalizePopulationPeriod: (value: string | null) => value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null,
}));
import PopulationHealthRoute from "@/app/population-health/page";
describe("population health route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.countyReference.mockResolvedValue({ counties: [{ name: "Barnstable County", fips: "25001" }], nameToFips: new Map([["barnstable county", "25001"]]) });
        mocks.getPopulationHealthContext.mockResolvedValue({ selectedState: "MA", selectedCountyFips: null });
    });
    it("renders the picker without loading publishers or counties", async () => {
        const result = await PopulationHealthRoute({ searchParams: Promise.resolve({}) });
        expect(result.props.context).toBeNull();
        expect(result.props.counties).toEqual([]);
        expect(mocks.getPopulationHealthContext).not.toHaveBeenCalled();
        expect(mocks.countyReference).not.toHaveBeenCalled();
    });
    it.each(["ZZ", "AK"])("does not substitute Massachusetts for unsupported state %s", async (state) => {
        const result = await PopulationHealthRoute({ searchParams: Promise.resolve({ state }) });
        expect(result.props.context).toBeNull();
        expect(result.props.counties).toEqual([]);
        expect(mocks.getPopulationHealthContext).not.toHaveBeenCalled();
    });
    it("passes a validated county and period to the public data loader", async () => {
        await PopulationHealthRoute({ searchParams: Promise.resolve({ state: "ma", county: "25001", period: "2026-07" }) });
        expect(mocks.getPopulationHealthContext).toHaveBeenCalledWith({ stateCode: "MA", countyFips: "25001", period: "2026-07" });
    });
});
