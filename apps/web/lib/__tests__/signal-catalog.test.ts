import { describe, expect, it } from "vitest";
import { SIGNAL_CATALOG, SIGNAL_IDS } from "@/lib/signal-catalog";
describe("signal catalog", () => {
    it("defines the expanded stable monitoring catalog", () => {
        expect(SIGNAL_CATALOG).toHaveLength(40);
        expect(SIGNAL_IDS).toHaveLength(40);
        expect(new Set(SIGNAL_IDS).size).toBe(40);
        expect(SIGNAL_IDS).toEqual(expect.arrayContaining([
            "covid-ed", "wnv-activity", "lyme-cases", "b-miyamotoi-presence", "mpox-detection",
            "heatrisk", "ed-wait", "influenza-admissions", "icu-availability",
            "pertussis-cases", "measles-cases", "covid-admissions", "rsv-inpatient-burden",
        ]));
        expect(SIGNAL_IDS).not.toEqual(expect.arrayContaining(["eee-activity", "beach-closures", "ed-visits", "ambulance-activity"]));
    });
    it("gives every signal a stable evidence and pressure contract", () => {
        for (const signal of SIGNAL_CATALOG) {
            expect(signal.id).toMatch(/^[a-z0-9-]+$/);
            expect(signal.label.length).toBeGreaterThan(2);
            expect(signal.unit.length).toBeGreaterThan(1);
            expect(["higher-is-worse", "lower-is-worse"]).toContain(signal.direction);
            expect(["modeled", "official", "planning"]).toContain(signal.defaultEvidence);
        }
    });
});
