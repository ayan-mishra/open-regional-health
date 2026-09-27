import { describe, expect, it } from "vitest";
import { countyDisplayName, countyMatches, countyNames, detailMatchesCounty, normalizedCounty } from "@/lib/county-name";
describe("county name matching", () => {
    it("normalizes diacritics, abbreviations, and publisher spelling variants", () => {
        expect(normalizedCounty("Doña Ana County")).toBe("DONAANA");
        expect(normalizedCounty("Dona Ana")).toBe("DONAANA");
        expect(normalizedCounty("Do\u00c3\u00b1a Ana")).toBe("DONAANA");
        expect(normalizedCounty("St. Mary Parish")).toBe("SAINTMARY");
        expect(normalizedCounty("Sainte Genevieve County")).toBe("SAINTGENEVIEVE");
        expect(normalizedCounty("Ste. Genevieve County")).toBe("SAINTGENEVIEVE");
        expect(normalizedCounty("E. Baton Rouge Parish")).toBe("EASTBATONROUGE");
        expect(normalizedCounty("Capitol Planning Region")).toBe("CAPITOL");
        expect(normalizedCounty("Lake of Woods County")).toBe("LAKEOFTHEWOODS");
        expect(normalizedCounty("Bedford City")).toBe("BEDFORD");
        expect(normalizedCounty("Baltimore city")).toBe("BALTIMORECITY");
        expect(normalizedCounty("Baltimore County")).toBe("BALTIMORE");
    });
    it("splits publisher service areas without losing the full label", () => {
        expect(countyNames("Arlington and Prince George's")).toEqual([
            "ARLINGTONANDPRINCEGEORGES",
            "ARLINGTON",
            "PRINCEGEORGES",
        ]);
        expect(countyMatches("St. Louis County", "Saint Louis")).toBe(true);
    });
    it("prefers an exact county FIPS over an ambiguous county name", () => {
        const detail = { id: "county:51059", geographyType: "county", counties: ["Fairfax"] };
        expect(detailMatchesCounty(detail, { fips: "51059", name: "Fairfax" })).toBe(true);
        expect(detailMatchesCounty(detail, { fips: "51600", name: "Fairfax city" })).toBe(false);
    });
    it("distinguishes independent cities from same-named counties", () => {
        expect(countyMatches("Baltimore City", "Baltimore", "24510")).toBe(true);
        expect(countyMatches("Baltimore County", "Baltimore", "24510")).toBe(false);
        expect(countyMatches("Baltimore County", "Baltimore", "24005")).toBe(true);
        expect(countyMatches("Norfolk", "Norfolk", "51710")).toBe(true);
        expect(countyMatches("Fairfax", "Fairfax", "51600")).toBe(false);
        expect(countyDisplayName({ fips: "24510", name: "Baltimore" })).toBe("Baltimore city");
        expect(countyDisplayName({ fips: "22071", name: "Orleans" })).toBe("Orleans Parish");
        expect(countyDisplayName({ fips: "09110", name: "Capitol" })).toBe("Capitol Planning Region");
        expect(countyMatches("Capitol Planning Region", "Capitol", "09110")).toBe(true);
    });
});
