import { describe, expect, it } from "vitest";
import { aggregateNndssRows, mmwrWeekEnding } from "@/lib/nndss";
describe("NNDSS normalization", () => {
    it("turns MMWR weeks into Saturday issue dates", () => {
        expect(mmwrWeekEnding(2026, 1)).toBe("2026-01-10");
        expect(mmwrWeekEnding(2026, 29)).toBe("2026-07-25");
    });
    it("combines multi-label counts and folds New York City into New York", () => {
        const rows = [
            { states: "New York", year: 2026, week: 29, label: "Measles, Imported", m1: 2 },
            { states: "New York City", year: 2026, week: 29, label: "Measles, Indigenous", m1: 3 },
            { states: "Alaska", year: 2026, week: 29, label: "Measles, Imported", m1: 20 },
        ];
        const result = aggregateNndssRows(rows);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ code: "NY", date: "2026-07-25", count: 5 });
        expect(result[0].value).toBeCloseTo(5 / 20201249 * 100000);
    });
    it("normalizes dash-coded no-case weeks to zero and excludes unavailable flags", () => {
        const rows = [
            { states: "Alabama", year: 2026, week: 29, label: "Pertussis", m1_flag: "-" },
            { states: "Arizona", year: 2026, week: 29, label: "Pertussis", m1_flag: "U" },
            { states: "Arkansas", year: 2026, week: 29, label: "Pertussis", m1_flag: "N" },
            { states: "California", year: 2026, week: 29, label: "Pertussis", m1_flag: "NN" },
            { states: "Colorado", year: 2026, week: 29, label: "Pertussis", m1_flag: "NP" },
        ];
        expect(aggregateNndssRows(rows)).toEqual([{ code: "AL", date: "2026-07-25", count: 0, value: 0 }]);
    });
});
