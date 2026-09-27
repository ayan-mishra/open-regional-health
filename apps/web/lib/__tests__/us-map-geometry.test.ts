import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { countyGeometryUrl, loadCountyGeometry, US_STATE_GEOMETRY } from "@/lib/us-map-geometry";
import { US_JURISDICTIONS } from "@/lib/us-geography";
const countyGeometryDirectory = resolve(process.cwd(), "public/geometry/counties");
describe("generated US geometry", () => {
    it("contains one path for every included jurisdiction", () => {
        expect(US_STATE_GEOMETRY).toHaveLength(49);
        expect(new Set(US_STATE_GEOMETRY.map((state) => state.fips)).size).toBe(49);
        expect(US_STATE_GEOMETRY.map((state) => String(state.code)).some((code) => code === "AK" || code === "HI")).toBe(false);
        expect(US_STATE_GEOMETRY.every((state) => state.path.startsWith("M"))).toBe(true);
    });
    it("contains a valid county asset for every included jurisdiction", () => {
        let countyCount = 0;
        for (const state of US_JURISDICTIONS) {
            const asset = JSON.parse(readFileSync(`${countyGeometryDirectory}/${state.fips}.json`, "utf8")) as {
                stateCode: string;
                counties: Array<{
                    fips: string;
                    path: string;
                }>;
            };
            const fips = asset.counties.map((county) => county.fips);
            expect(asset.stateCode).toBe(state.code);
            expect(fips.length).toBeGreaterThan(0);
            expect(new Set(fips).size).toBe(fips.length);
            expect(fips.every((value) => value.startsWith(state.fips))).toBe(true);
            expect(asset.counties.every((county) => county.path.startsWith("M"))).toBe(true);
            countyCount += fips.length;
        }
        expect(countyCount).toBe(3109);
    });
    it("loads a selected state's counties from its lazy public asset", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
            stateCode: "MA", viewBox: "0 0 760 520", statePath: "M0,0Z",
            counties: [{ fips: "25017", name: "Middlesex", path: "M1,1Z" }],
        }))));
        expect(countyGeometryUrl("MA")).toBe("/geometry/counties/25.json");
        expect((await loadCountyGeometry("MA")).counties[0].name).toBe("Middlesex");
        vi.unstubAllGlobals();
    });
});
