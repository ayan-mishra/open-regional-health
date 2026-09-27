import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { GET } from "@/app/api/national/outlook/route";
describe("national outlook route", () => {
    it("returns typed exclusion errors for Alaska and Hawaii", async () => {
        for (const code of ["AK", "HI"]) {
            const response = await GET(new Request(`http://localhost/api/national/outlook?signal=covid-ed&state=${code}`));
            expect(response.status).toBe(422);
            expect(await response.json()).toMatchObject({ error: "excluded_jurisdiction" });
        }
    });
    it("rejects unknown signals and jurisdictions without fallback", async () => {
        const signal = await GET(new Request("http://localhost/api/national/outlook?signal=made-up"));
        expect(signal.status).toBe(400);
        const state = await GET(new Request("http://localhost/api/national/outlook?signal=covid-ed&state=XX"));
        expect(state.status).toBe(400);
        expect(await state.json()).toMatchObject({ error: "invalid_jurisdiction" });
    });
    it("rejects unknown and duplicate query parameters", async () => {
        const unknown = await GET(new Request("http://localhost/api/national/outlook?debug=true"));
        expect(unknown.status).toBe(400);
        expect(await unknown.json()).toMatchObject({ error: "unknown_parameter" });
        const duplicate = await GET(new Request("http://localhost/api/national/outlook?signal=covid-ed&signal=rsv-ed"));
        expect(duplicate.status).toBe(400);
        expect(await duplicate.json()).toMatchObject({ error: "duplicate_parameter" });
    });
});
