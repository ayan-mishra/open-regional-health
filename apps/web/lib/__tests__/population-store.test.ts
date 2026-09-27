import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readBakedPopulationState, writeBakedPopulationState } from "@/lib/population-store";
import type { PopulationHealthResponse } from "@/lib/population-health-contracts";
let directory: string;
beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "corvid-population-"));
    vi.stubEnv("CORVID_POPULATION_STORE_DIR", directory);
});
afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
});
const context = (label: string): PopulationHealthResponse => ({
    retrievedAt: "2026-09-01T00:00:00.000Z", period: null, status: "current",
    selectedState: "MA", selectedCountyFips: null, geographyLabel: label,
    sections: [], signals: [], insights: [],
    coverage: {} as PopulationHealthResponse["coverage"], errors: [], sources: [],
    summary: "",
});
describe("population health store", () => {
    it("round-trips a state through the compressed file", async () => {
        await writeBakedPopulationState("MA", context("Massachusetts"));
        expect((await readBakedPopulationState("MA"))?.geographyLabel).toBe("Massachusetts");
    });
    it("does not describe yesterday's weather alerts as currently active", async () => {
        const brief = context("Massachusetts");
        brief.sections = [{ id: "resilience", title: "Hazards", description: "", measures: [{ id: "hazard-exposure", status: "current", value: 2, note: "NWS alerts" } as never] }];
        await writeFile(join(directory, "MA.json.gz"), gzipSync(JSON.stringify({ version: 1, bakedAt: new Date(Date.now() - 86400000).toISOString(), context: brief })));
        const stored = await readBakedPopulationState("MA");
        expect(stored?.sections[0].measures[0]).toMatchObject({ status: "stale", note: expect.stringContaining("check the publisher") });
        expect(stored?.status).toBe("partial");
    });
    it("reports a state that was never baked as absent rather than throwing", async () => {
        expect(await readBakedPopulationState("WY")).toBeNull();
    });
    it("keeps states separate", async () => {
        await writeBakedPopulationState("TX", context("Texas"));
        expect((await readBakedPopulationState("TX"))?.geographyLabel).toBe("Texas");
        expect((await readBakedPopulationState("MA"))?.geographyLabel).toBe("Massachusetts");
    });
    it.each([new Date(Date.now() - 8 * 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString(), "not-a-date"])("refuses an expired or invalid bake timestamp: %s", async (bakedAt) => {
        await writeFile(join(directory, "CA.json.gz"), gzipSync(JSON.stringify({ version: 1, bakedAt, context: context("California") })));
        expect(await readBakedPopulationState("CA")).toBeNull();
    });
});
describe("counting what is on disk", () => {
    it("counts only baked state files", async () => {
        const { countBakedPopulationStates } = await import("@/lib/population-store");
        await writeBakedPopulationState("NV", context("Nevada"));
        expect(await countBakedPopulationStates()).toBeGreaterThan(0);
    });
    it("reports zero rather than throwing when the store was never written", async () => {
        const { countBakedPopulationStates } = await import("@/lib/population-store");
        vi.stubEnv("CORVID_POPULATION_STORE_DIR", "/nonexistent/corvid-test/population-store");
        expect(await countBakedPopulationStates()).toBe(0);
        vi.stubEnv("CORVID_POPULATION_STORE_DIR", directory);
    });
});
