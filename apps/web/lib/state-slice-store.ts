import "server-only";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SignalId } from "@/lib/signal-catalog";
import type { IncludedStateCode } from "@/lib/us-geography";
export const STORE_VERSION = 1;
export type StoreManifest = {
    version: typeof STORE_VERSION;
    bakedAt: string;
    signals: SignalId[];
};
export function createStateSliceStore<Index extends {
    version: typeof STORE_VERSION;
}, Slice extends {
    version: typeof STORE_VERSION;
}>(directoryName: string, directoryOverride: string | undefined) {
    const storeDirectory = resolve(directoryOverride ?? join(process.cwd(), directoryName));
    const signalDirectory = (signalId: SignalId) => join(storeDirectory, signalId);
    async function readJson<T extends {
        version: typeof STORE_VERSION;
    }>(path: string): Promise<T | null> {
        try {
            const parsed = JSON.parse(gunzipSync(await readFile(path)).toString("utf8")) as Partial<T>;
            return parsed?.version === STORE_VERSION ? (parsed as T) : null;
        }
        catch {
            return null;
        }
    }
    let cachedManifest: StoreManifest | null | undefined;
    return {
        readIndex: (signalId: SignalId) => readJson<Index>(join(signalDirectory(signalId), "index.json.gz")),
        readSlice: (signalId: SignalId, stateCode: IncludedStateCode) => readJson<Slice>(join(signalDirectory(signalId), `${stateCode}.json.gz`)),
        async readManifest() {
            if (cachedManifest === undefined)
                cachedManifest = await readJson<StoreManifest>(join(storeDirectory, "manifest.json.gz"));
            return cachedManifest;
        },
        async writeSignal(signalId: SignalId, index: Index, byState: ReadonlyMap<IncludedStateCode, Slice>) {
            const directory = signalDirectory(signalId);
            await mkdir(directory, { recursive: true });
            for (const [stateCode, slice] of byState)
                await writeFile(join(directory, `${stateCode}.json.gz`), gzipSync(JSON.stringify(slice), { level: 9 }));
            await writeFile(join(directory, "index.json.gz"), gzipSync(JSON.stringify(index), { level: 9 }));
        },
        async writeManifest(signals: readonly SignalId[]) {
            await mkdir(storeDirectory, { recursive: true });
            const manifest: StoreManifest = { version: STORE_VERSION, bakedAt: new Date().toISOString(), signals: [...signals] };
            await writeFile(join(storeDirectory, "manifest.json.gz"), gzipSync(JSON.stringify(manifest), { level: 9 }));
            cachedManifest = manifest;
        },
    };
}
