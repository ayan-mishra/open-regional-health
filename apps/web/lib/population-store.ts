import "server-only";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PopulationHealthResponse } from "@/lib/population-health-contracts";
import type { IncludedStateCode } from "@/lib/us-geography";
export const POPULATION_STORE_VERSION = 1;
const MAX_BAKE_AGE_MS = 7 * 86400000;
export type BakedPopulationState = {
    version: typeof POPULATION_STORE_VERSION;
    bakedAt: string;
    context: PopulationHealthResponse;
};
const storeDirectory = () => resolve(process.env.CORVID_POPULATION_STORE_DIR ?? join(process.cwd(), "population-store"));
const stateFile = (stateCode: IncludedStateCode) => join(storeDirectory(), `${stateCode}.json.gz`);
export async function readBakedPopulationState(stateCode: IncludedStateCode): Promise<PopulationHealthResponse | null> {
    try {
        const parsed = JSON.parse(gunzipSync(await readFile(stateFile(stateCode))).toString("utf8")) as BakedPopulationState;
        const age = Date.now() - Date.parse(parsed.bakedAt);
        if (parsed?.version !== POPULATION_STORE_VERSION || !Number.isFinite(age) || age < 0 || age > MAX_BAKE_AGE_MS)
            return null;
        if (age > 15 * 60000) {
            for (const measure of parsed.context.sections.flatMap((section) => section.measures)) {
                if (measure.id.startsWith("hazard-") && measure.status === "current") {
                    measure.status = "stale";
                    measure.note = `Alert snapshot from ${parsed.bakedAt}; check the publisher for currently active alerts. ${measure.note}`;
                }
            }
            if (parsed.context.sections.some((section) => section.measures.some((measure) => measure.status === "stale")))
                parsed.context.status = "partial";
        }
        return parsed.context;
    }
    catch {
        return null;
    }
}
export async function writeBakedPopulationState(stateCode: IncludedStateCode, context: PopulationHealthResponse) {
    await mkdir(storeDirectory(), { recursive: true });
    const payload: BakedPopulationState = { version: POPULATION_STORE_VERSION, bakedAt: new Date().toISOString(), context };
    await writeFile(stateFile(stateCode), gzipSync(JSON.stringify(payload), { level: 9 }));
}
export async function countBakedPopulationStates(): Promise<number> {
    try {
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(storeDirectory());
        return entries.filter((name) => name.endsWith(".json.gz")).length;
    }
    catch {
        return 0;
    }
}
