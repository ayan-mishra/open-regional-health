import { describe, expect, it } from "vitest";
import { isIncludedJurisdiction, jurisdictionByCode, US_JURISDICTIONS } from "@/lib/us-geography";
describe("contiguous US geography", () => {
    it("contains the 48 contiguous states and Washington DC", () => {
        expect(US_JURISDICTIONS).toHaveLength(49);
        expect(new Set(US_JURISDICTIONS.map((state) => state.fips)).size).toBe(49);
        expect(US_JURISDICTIONS.map((state) => state.name)).toEqual([...US_JURISDICTIONS.map((state) => state.name)].sort());
        expect(jurisdictionByCode("DC")?.fips).toBe("11");
    });
    it("excludes Alaska, Hawaii, territories, and invalid codes", () => {
        expect(isIncludedJurisdiction("AK")).toBe(false);
        expect(isIncludedJurisdiction("HI")).toBe(false);
        expect(isIncludedJurisdiction("PR")).toBe(false);
        expect(isIncludedJurisdiction("XX")).toBe(false);
        expect(isIncludedJurisdiction("MA")).toBe(true);
        expect(isIncludedJurisdiction("dc")).toBe(true);
    });
});
