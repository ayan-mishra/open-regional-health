import { describe, expect, it } from "vitest";
import { hasRelativePeerCohort, RELATIVE_MAP_COLORS, relativeMapFill } from "@/lib/relative-map-colors";
describe("relative map colors", () => {
    it("requires four eligible peers before a relative cohort is considered usable", () => {
        expect(hasRelativePeerCohort([1, 2, 3])).toBe(false);
        expect(hasRelativePeerCohort([1, 2, 3, 4])).toBe(true);
    });
    it("maps the lowest peer extremely green, the middle peer yellow, and the highest peer red", () => {
        const worcesterSuffolkAndPeers = [51, 50, 49, 49, 49];
        expect(relativeMapFill(49, worcesterSuffolkAndPeers)).toBe(RELATIVE_MAP_COLORS.extremelyGood);
        expect(relativeMapFill(50, worcesterSuffolkAndPeers)).toBe(RELATIVE_MAP_COLORS.middle);
        expect(relativeMapFill(51, worcesterSuffolkAndPeers)).toBe(RELATIVE_MAP_COLORS.high);
    });
    it("keeps tied observations regular green because no relative rank exists", () => {
        expect(relativeMapFill(50, [50, 50, 50])).toBe(RELATIVE_MAP_COLORS.good);
    });
    it("reverses the scale when a lower value means more pressure", () => {
        expect(relativeMapFill(4, [4, 12, 20], "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.high);
        expect(relativeMapFill(12, [4, 12, 20], "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.middle);
        expect(relativeMapFill(20, [4, 12, 20], "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.extremelyGood);
    });
    it("separates good, super-good, and extremely-good ICU availability", () => {
        const availability = [17.1, 25, 30, 40, 50, 63.6, 73.3];
        expect(relativeMapFill(25, availability, "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.high);
        expect(relativeMapFill(63.6, availability, "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.superGood);
        expect(relativeMapFill(73.3, availability, "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.extremelyGood);
    });
    it("uses peer ranks so one outlier cannot make almost every observation red", () => {
        const availability = [4, 8, 9, 10, 11, 12, 13, 14, 18, 27, 29, 53];
        expect(relativeMapFill(4, availability, "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.high);
        expect(relativeMapFill(12, availability, "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.middle);
        expect(relativeMapFill(27, availability, "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.superGood);
        expect(relativeMapFill(53, availability, "lower-is-worse")).toBe(RELATIVE_MAP_COLORS.extremelyGood);
    });
});
