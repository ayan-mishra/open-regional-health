import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getNationalForecast } from "@/lib/national-forecast-live";
import { bakeCountyDetails, GENEROUS_OUTLOOK_TIMEOUT_MS, getNationalOutlook } from "@/lib/national-live";
import { bakeStateForecasts } from "@/lib/national-forecast-live";
import { writeForecastStoreManifest } from "@/lib/forecast-store";
import { writeCountyStoreManifest } from "@/lib/county-detail-store";
import type { NationalForecastResponse, NationalOutlookResponse } from "@/lib/national-contracts";
import { SIGNAL_CATALOG, type SignalId } from "@/lib/signal-catalog";
const SNAPSHOT_TTL_MS = 43200000;
const PARTIAL_SNAPSHOT_TTL_MS = 300000;
const MAX_OUTLOOK_CACHE_ENTRIES = 64;
const MAX_FORECAST_CACHE_ENTRIES = 96;
const MAX_HISTORICAL_PERIODS = 6;
const PERSISTED_SNAPSHOT_PATH = process.env.CORVID_PUBLIC_SNAPSHOT_PATH ?? join(tmpdir(), "open-regional-health-public-snapshot.json");
type Cached<T> = {
    value: T;
    cachedAt: number;
    ttl?: number;
};
type PersistedSnapshot = {
    version: 2;
    outlooks: Record<string, Cached<NationalOutlookResponse>>;
    forecasts: Record<string, Cached<NationalForecastResponse | null>>;
};
type PublicSnapshotState = {
    outlookCache: Map<string, Cached<NationalOutlookResponse>>;
    outlookPending: Map<string, Promise<NationalOutlookResponse>>;
    forecastCache: Map<string, Cached<NationalForecastResponse | null>>;
    forecastPending: Map<string, Promise<NationalForecastResponse | null>>;
    diskLoad: Promise<void> | null;
    diskLoaded: boolean;
};
const globalState = globalThis as typeof globalThis & {
    __corvidPublicSnapshotsV2?: PublicSnapshotState;
};
const snapshotState: PublicSnapshotState = globalState.__corvidPublicSnapshotsV2 ??= {
    outlookCache: new Map(),
    outlookPending: new Map(),
    forecastCache: new Map(),
    forecastPending: new Map(),
    diskLoad: null,
    diskLoaded: false,
};
const { outlookCache, outlookPending, forecastCache, forecastPending } = snapshotState;
const historicalPeriodRecency: string[] = [];
let persistPending = Promise.resolve();
function cacheKey(signalId: SignalId, period: string) {
    return `${signalId}:${period}`;
}
const WARM_PACE_MS = Number(process.env.CORVID_WARM_PACE_MS ?? (process.env.NODE_ENV === "production" ? 2000 : 0));
export const residentMegabytes = () => Math.round(process.memoryUsage().rss / 1048576);
export function pauseBetweenWarmedSignals() {
    return yieldForGc(true);
}
async function yieldForGc(paced: boolean) {
    const pace = paced ? WARM_PACE_MS : 0;
    await new Promise((resolve) => (pace > 0 ? setTimeout(resolve, pace) : setImmediate(resolve)));
    (globalThis as {
        gc?: () => void;
    }).gc?.();
}
function fresh<T>(entry: Cached<T> | undefined): entry is Cached<T> {
    return Boolean(entry && Date.now() - entry.cachedAt < (entry.ttl ?? SNAPSHOT_TTL_MS));
}
function matchesOutlook(value: unknown, signalId: SignalId, period: string): value is NationalOutlookResponse {
    if (!value || typeof value !== "object")
        return false;
    const outlook = value as Partial<NationalOutlookResponse>;
    return outlook.signal?.id === signalId && (outlook.period ?? "") === period && outlook.selectedState === null && Array.isArray(outlook.states) && outlook.states.length > 0;
}
function matchesForecast(value: NationalForecastResponse | null, signalId: SignalId, period: string) {
    return value === null || (value.signalId === signalId && value.horizon === 28 && (value.period ?? "") === period);
}
function touchHistoricalPeriod(period: string) {
    if (!period)
        return;
    const index = historicalPeriodRecency.indexOf(period);
    if (index !== -1)
        historicalPeriodRecency.splice(index, 1);
    historicalPeriodRecency.push(period);
    while (historicalPeriodRecency.length > MAX_HISTORICAL_PERIODS) {
        const evicted = historicalPeriodRecency.shift();
        if (!evicted)
            continue;
        for (const key of outlookCache.keys())
            if (key.endsWith(`:${evicted}`))
                outlookCache.delete(key);
        for (const key of forecastCache.keys())
            if (key.endsWith(`:${evicted}`))
                forecastCache.delete(key);
    }
}
function trimOutlooks() {
    while (outlookCache.size > MAX_OUTLOOK_CACHE_ENTRIES)
        outlookCache.delete(outlookCache.keys().next().value!);
}
function trimForecasts() {
    while (forecastCache.size > MAX_FORECAST_CACHE_ENTRIES)
        forecastCache.delete(forecastCache.keys().next().value!);
}
async function loadPersistedSnapshot() {
    try {
        const parsed = JSON.parse(await readFile(PERSISTED_SNAPSHOT_PATH, "utf8")) as Partial<PersistedSnapshot>;
        if (parsed.version !== 2)
            return;
        for (const [key, entry] of Object.entries(parsed.outlooks ?? {})) {
            const separator = key.indexOf(":");
            const signalId = key.slice(0, separator) as SignalId;
            const period = key.slice(separator + 1);
            if (separator > 0 && Number.isFinite(entry?.cachedAt) && matchesOutlook(entry?.value, signalId, period))
                outlookCache.set(key, entry);
        }
        for (const [key, entry] of Object.entries(parsed.forecasts ?? {})) {
            const separator = key.indexOf(":");
            const signalId = key.slice(0, separator) as SignalId;
            const period = key.slice(separator + 1);
            if (separator > 0 && Number.isFinite(entry?.cachedAt) && "value" in entry && matchesForecast(entry.value, signalId, period))
                forecastCache.set(key, entry);
        }
        trimOutlooks();
        trimForecasts();
    }
    catch {
    }
    finally {
        snapshotState.diskLoaded = true;
    }
}
function ensurePersistedSnapshotLoaded() {
    if (snapshotState.diskLoaded)
        return Promise.resolve();
    snapshotState.diskLoad ??= loadPersistedSnapshot();
    return snapshotState.diskLoad;
}
async function persistCurrentSnapshots() {
    const temporaryPath = `${PERSISTED_SNAPSHOT_PATH}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(PERSISTED_SNAPSHOT_PATH), { recursive: true });
    const currentOnly = <T,>(cache: Map<string, Cached<T>>) => Object.fromEntries([...cache].filter(([key]) => key.endsWith(":")));
    const snapshot: PersistedSnapshot = { version: 2, outlooks: currentOnly(outlookCache), forecasts: currentOnly(forecastCache) };
    await writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
    await rename(temporaryPath, PERSISTED_SNAPSHOT_PATH);
}
function queuePersistCurrentSnapshots() {
    persistPending = persistPending.catch(() => undefined).then(persistCurrentSnapshots);
    return persistPending;
}
export async function getServerOutlookSnapshot(signalId: SignalId, period = "", force = false, silent = false): Promise<NationalOutlookResponse> {
    await ensurePersistedSnapshotLoaded();
    const key = cacheKey(signalId, period);
    const cached = outlookCache.get(key);
    if (!force && fresh(cached))
        return cached.value;
    const pending = outlookPending.get(key);
    if (!force && cached) {
        if (!pending)
            void getServerOutlookSnapshot(signalId, period, true).catch(() => undefined);
        return cached.value;
    }
    if (pending)
        return pending;
    const request = getNationalOutlook({ signalId, stateCode: null, period: period || null, includeAllDetails: false, timeoutMs: silent ? GENEROUS_OUTLOOK_TIMEOUT_MS : undefined })
        .then((outlook) => {
        if (!matchesOutlook(outlook, signalId, period))
            throw new Error("Publisher returned a mismatched outlook.");
        outlookCache.delete(key);
        outlookCache.set(key, { value: outlook, cachedAt: Date.now(), ttl: outlook.status === "current" ? SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
        touchHistoricalPeriod(period);
        trimOutlooks();
        if (!period && !silent)
            void queuePersistCurrentSnapshots().catch(() => undefined);
        return outlook;
    })
        .catch((error: unknown) => {
        if (cached)
            return cached.value;
        throw error;
    })
        .finally(() => { outlookPending.delete(key); });
    outlookPending.set(key, request);
    return request;
}
export function getCachedServerOutlookSnapshot(signalId: SignalId, period = "", refresh = true) {
    const key = cacheKey(signalId, period);
    const cached = outlookCache.get(key);
    if (refresh && cached && !fresh(cached) && !outlookPending.has(key))
        void getServerOutlookSnapshot(signalId, period, true).catch(() => undefined);
    return cached?.value;
}
export async function getServerOutlookSnapshots(signalIds: readonly SignalId[], period = "", concurrency = 2, silent = false) {
    const results = new Map<SignalId, NationalOutlookResponse>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), signalIds.length) }, async () => {
        while (cursor < signalIds.length) {
            const signalId = signalIds[cursor++];
            results.set(signalId, await getServerOutlookSnapshot(signalId, period, false, silent));
            await yieldForGc(silent);
        }
    });
    await Promise.all(workers);
    return results;
}
export async function getServerForecastSnapshot(signalId: SignalId, period = "", force = false, silent = false): Promise<NationalForecastResponse | null> {
    await ensurePersistedSnapshotLoaded();
    const key = cacheKey(signalId, period);
    const cached = forecastCache.get(key);
    if (!force && fresh(cached) && matchesForecast(cached.value, signalId, period))
        return cached.value;
    const pending = forecastPending.get(key);
    if (!force && cached && matchesForecast(cached.value, signalId, period)) {
        if (!pending)
            void getServerForecastSnapshot(signalId, period, true);
        return cached.value;
    }
    if (pending)
        return pending;
    const request = getNationalForecast({ signalId, stateCode: null, horizon: 28, period: period || null })
        .then((forecast) => {
        if (!matchesForecast(forecast, signalId, period))
            throw new Error("Forecast service returned a mismatched response.");
        forecastCache.set(key, { value: forecast, cachedAt: Date.now(), ttl: forecast.status === "current" ? SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
        trimForecasts();
        touchHistoricalPeriod(period);
        if (!period && !silent)
            void queuePersistCurrentSnapshots().catch(() => undefined);
        return forecast;
    })
        .catch(() => {
        if (cached && matchesForecast(cached.value, signalId, period))
            return cached.value;
        forecastCache.set(key, { value: null, cachedAt: Date.now(), ttl: PARTIAL_SNAPSHOT_TTL_MS });
        trimForecasts();
        touchHistoricalPeriod(period);
        return null;
    })
        .finally(() => { forecastPending.delete(key); });
    forecastPending.set(key, request);
    return request;
}
export function getCachedServerForecastSnapshot(signalId: SignalId, period = "", refresh = true): NationalForecastResponse | null | undefined {
    const key = cacheKey(signalId, period);
    const cached = forecastCache.get(key);
    if (!cached || !matchesForecast(cached.value, signalId, period))
        return undefined;
    if (refresh && !fresh(cached) && !forecastPending.has(key))
        void getServerForecastSnapshot(signalId, period, true);
    return cached.value;
}
export async function refreshPublicData() {
    await getServerOutlookSnapshot("covid-ed", "", true);
}
export async function warmAllOutlooks() {
    await getServerOutlookSnapshots(SIGNAL_CATALOG.map((signal) => signal.id), "", 1, true);
    await queuePersistCurrentSnapshots();
}
export async function warmCountyDetails() {
    const baked: SignalId[] = [];
    for (const signal of SIGNAL_CATALOG) {
        const written = await bakeCountyDetails(signal.id).catch((error: unknown) => {
            console.error(`[county-warmup] ${signal.id} failed to bake`, error instanceof Error ? error.name : "unknown error");
            return null;
        });
        if (written !== null)
            baked.push(signal.id);
        await yieldForGc(true);
    }
    await writeCountyStoreManifest(baked).catch((error: unknown) => {
        console.error("[county-warmup] could not write the store manifest", error instanceof Error ? error.name : "unknown error");
    });
    return baked.length;
}
export async function warmStateForecasts() {
    const baked: SignalId[] = [];
    for (const signal of SIGNAL_CATALOG) {
        const result = await bakeStateForecasts(signal.id).catch((error: unknown) => {
            console.error(`[forecast-warmup] ${signal.id} failed to bake`, error instanceof Error ? error.name : "unknown error");
            return null;
        });
        if (result) {
            baked.push(signal.id);
            forecastCache.set(cacheKey(signal.id, ""), { value: result.national, cachedAt: Date.now(), ttl: result.national.status === "current" ? SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
            trimForecasts();
        }
        await yieldForGc(true);
    }
    await writeForecastStoreManifest(baked).catch((error: unknown) => {
        console.error("[forecast-warmup] could not write the store manifest", error instanceof Error ? error.name : "unknown error");
    });
    await queuePersistCurrentSnapshots();
    return baked.length;
}
const rotationBaked = { county: new Set<SignalId>(), forecast: new Set<SignalId>() };
let rotationCursor = 0;
export async function refreshNextSignal() {
    const signal = SIGNAL_CATALOG[rotationCursor % SIGNAL_CATALOG.length];
    rotationCursor += 1;
    const county = await bakeCountyDetails(signal.id).catch((error: unknown) => {
        console.error(`[rotation] ${signal.id} county bake failed`, error instanceof Error ? error.name : "unknown error");
        return null;
    });
    if (county !== null)
        rotationBaked.county.add(signal.id);
    await yieldForGc(true);
    const forecast = await bakeStateForecasts(signal.id).catch((error: unknown) => {
        console.error(`[rotation] ${signal.id} forecast bake failed`, error instanceof Error ? error.name : "unknown error");
        return null;
    });
    if (forecast) {
        rotationBaked.forecast.add(signal.id);
        forecastCache.set(cacheKey(signal.id, ""), { value: forecast.national, cachedAt: Date.now(), ttl: forecast.national.status === "current" ? SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
        trimForecasts();
    }
    await yieldForGc(true);
    if (rotationCursor % SIGNAL_CATALOG.length === 0) {
        await writeCountyStoreManifest([...rotationBaked.county]).catch(() => undefined);
        await writeForecastStoreManifest([...rotationBaked.forecast]).catch(() => undefined);
        console.log(`[rotation] completed: ${rotationBaked.county.size} county, ${rotationBaked.forecast.size} forecast signals refreshed`);
        rotationBaked.county.clear();
        rotationBaked.forecast.clear();
    }
    return signal.id;
}
export async function warmPublicData() {
    await ensurePersistedSnapshotLoaded();
    const cached = outlookCache.get(cacheKey("covid-ed", ""));
    if (cached && fresh(cached)) {
        void refreshPublicData().catch((error: unknown) => {
            console.error("[public-data-warmup] refresh failed; serving saved outlook", error instanceof Error ? error.name : "unknown error");
        });
        return;
    }
    await refreshPublicData();
    await queuePersistCurrentSnapshots();
}
export async function clearServerPublicSnapshotCache() {
    await persistPending.catch(() => undefined);
    rotationCursor = 0;
    rotationBaked.county.clear();
    rotationBaked.forecast.clear();
    outlookCache.clear();
    outlookPending.clear();
    forecastCache.clear();
    forecastPending.clear();
    historicalPeriodRecency.length = 0;
    snapshotState.diskLoad = null;
    snapshotState.diskLoaded = false;
}
