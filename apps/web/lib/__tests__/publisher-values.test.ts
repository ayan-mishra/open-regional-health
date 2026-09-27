import { describe, expect, it } from "vitest";
import { z } from "zod";
import { optionalPublisherNumber, parseTrustedRows, publisherNumber } from "@/lib/publisher-values";
describe("publisher numeric parsing", () => {
    it("keeps null and blank values missing", () => {
        expect(optionalPublisherNumber.parse(null)).toBeUndefined();
        expect(optionalPublisherNumber.parse(" ")).toBeUndefined();
        expect(publisherNumber.safeParse(null).success).toBe(false);
        expect(publisherNumber.parse("1.25")).toBe(1.25);
    });
});
describe("parseTrustedRows", () => {
    const schema = z.object({ state: z.string(), occupancy: z.coerce.number().max(100) });
    it("keeps the rows that validate instead of voiding the response over a few that do not", () => {
        const rows = parseTrustedRows(schema, [
            { state: "AL", occupancy: "40" },
            { state: "AZ", occupancy: "128.15" },
            { state: "CO", occupancy: "25" },
        ]);
        expect(rows.map((row) => row.state)).toEqual(["AL", "CO"]);
    });
    it("throws when nothing survives, so a reshaped feed still fails loudly", () => {
        expect(() => parseTrustedRows(schema, [{ state: "AZ", occupancy: "128.15" }])).toThrow();
    });
    it("returns nothing for a genuinely empty response rather than throwing", () => {
        expect(parseTrustedRows(schema, [])).toEqual([]);
    });
});
