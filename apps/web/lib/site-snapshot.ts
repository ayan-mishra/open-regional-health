"use client";
import type { NationalForecastResponse, NationalOutlookResponse } from "@/lib/national-contracts";
import type { SignalId } from "@/lib/signal-catalog";
import { loadCountyGeometry, type CountyGeometry } from "@/lib/us-map-geometry";
import type { IncludedStateCode } from "@/lib/us-geography";
export const SITE_SNAPSHOT_TTL_MS = 43200000;
const PARTIAL_SNAPSHOT_TTL_MS = 300000;
const NATIONAL_OUTLOOK_CACHE_LIMIT = 64;
const STATE_OUTLOOK_CACHE_LIMIT = 96;
const FORECAST_CACHE_LIMIT = 96;
type CachedValue<T> = {
    value: T;
    cachedAt: number;
    ttl: number;
};
const cachedCountyGeometries = new Map<IncludedStateCode, CachedValue<CountyGeometry>>();
const pendingCountyGeometries = new Map<IncludedStateCode, Promise<CountyGeometry>>();
const cachedForecastSnapshots = new Map<string, CachedValue<NationalForecastResponse>>();
const pendingForecastSnapshots = new Map<string, Promise<NationalForecastResponse>>();
const cachedNationalOutlooks = new Map<string, CachedValue<NationalOutlookResponse>>();
const pendingNationalOutlooks = new Map<string, Promise<NationalOutlookResponse>>();
const cachedStateOutlooks = new Map<string, CachedValue<NationalOutlookResponse>>();
const pendingStateOutlooks = new Map<string, Promise<NationalOutlookResponse>>();
function isFresh<T>(cached: CachedValue<T> | undefined): cached is CachedValue<T> {
    return Boolean(cached && Date.now() - cached.cachedAt < cached.ttl);
}
function trimCache<T>(cache: Map<string, T>, limit: number) {
    while (cache.size > limit)
        cache.delete(cache.keys().next().value!);
}
function stateOutlookKey(signalId: SignalId, stateCode: IncludedStateCode, period: string) {
    return `${signalId}:${stateCode}:${period}`;
}
function nationalOutlookKey(signalId: SignalId, period: string) {
    return `${signalId}:${period}`;
}
function readJsonError(payload: unknown, fallback: string) {
    return payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? payload.message : fallback;
}
export function loadForecastSnapshot(signalId: SignalId, horizon: 7 | 14 | 28, period = "", force = false, stateCode: IncludedStateCode | null = null): Promise<NationalForecastResponse> {
    const key = `${signalId}:${horizon}:${period}:${stateCode ?? ""}`;
    const cached = cachedForecastSnapshots.get(key);
    if (!force && isFresh(cached))
        return Promise.resolve(cached.value);
    const pending = pendingForecastSnapshots.get(key);
    if (!force && cached) {
        if (!pending)
            void loadForecastSnapshot(signalId, horizon, period, true, stateCode).catch(() => undefined);
        return Promise.resolve(cached.value);
    }
    if (pending)
        return pending;
    const params = new URLSearchParams({ signal: signalId, horizon: String(horizon) });
    if (period)
        params.set("period", period);
    if (stateCode)
        params.set("state", stateCode);
    const request = fetch(`/api/national/forecasts?${params.toString()}`, { cache: force ? "reload" : "default" }).then((response) => {
        return response.json().catch(() => null).then((payload: unknown) => {
            if (!response.ok) {
                const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? payload.message : "The forecast data could not be loaded.";
                throw new Error(message);
            }
            const forecast = payload as NationalForecastResponse;
            if (!forecast || forecast.signalId !== signalId || forecast.horizon !== horizon || (forecast.period ?? "") !== period || (forecast.selectedState ?? null) !== stateCode) {
                throw new Error("The forecast service returned a different signal, state, or period.");
            }
            return forecast;
        });
    }).then((forecast) => {
        cachedForecastSnapshots.set(key, { value: forecast, cachedAt: Date.now(), ttl: forecast.status === "current" ? SITE_SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
        trimCache(cachedForecastSnapshots, FORECAST_CACHE_LIMIT);
        return forecast;
    }).finally(() => { pendingForecastSnapshots.delete(key); });
    pendingForecastSnapshots.set(key, request);
    return request;
}
export function getCachedForecastSnapshot(signalId: SignalId, horizon: 7 | 14 | 28, period = "", stateCode: IncludedStateCode | null = null) {
    const cached = cachedForecastSnapshots.get(`${signalId}:${horizon}:${period}:${stateCode ?? ""}`);
    return isFresh(cached) ? cached.value : null;
}
export function loadNationalOutlook(signalId: SignalId, period = "", force = false): Promise<NationalOutlookResponse> {
    const key = nationalOutlookKey(signalId, period);
    const cached = cachedNationalOutlooks.get(key);
    if (!force && isFresh(cached))
        return Promise.resolve(cached.value);
    const pending = pendingNationalOutlooks.get(key);
    if (!force && cached) {
        if (!pending)
            void loadNationalOutlook(signalId, period, true).catch(() => undefined);
        return Promise.resolve(cached.value);
    }
    if (pending)
        return pending;
    const params = new URLSearchParams({ signal: signalId });
    if (period)
        params.set("period", period);
    const request = fetch(`/api/national/outlook?${params}`, { cache: force ? "reload" : "default" }).then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok)
            throw new Error(readJsonError(payload, "National surveillance is temporarily unavailable."));
        const outlook = payload as NationalOutlookResponse;
        if (outlook.signal?.id !== signalId || outlook.selectedState !== null || (outlook.period ?? "") !== period)
            throw new Error("The outlook service returned a different signal or period.");
        return outlook;
    }).then((outlook) => {
        cachedNationalOutlooks.set(key, { value: outlook, cachedAt: Date.now(), ttl: outlook.status === "current" ? SITE_SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
        trimCache(cachedNationalOutlooks, NATIONAL_OUTLOOK_CACHE_LIMIT);
        return outlook;
    }).finally(() => { pendingNationalOutlooks.delete(key); });
    pendingNationalOutlooks.set(key, request);
    return request;
}
export function getCachedNationalOutlook(signalId: SignalId, period = "") {
    const cached = cachedNationalOutlooks.get(nationalOutlookKey(signalId, period));
    return isFresh(cached) ? cached.value : null;
}
export function primeNationalOutlook(outlook: NationalOutlookResponse, period = "") {
    if (outlook.selectedState !== null)
        return;
    cachedNationalOutlooks.set(nationalOutlookKey(outlook.signal.id, period), { value: outlook, cachedAt: Date.now(), ttl: outlook.status === "current" ? SITE_SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
    trimCache(cachedNationalOutlooks, NATIONAL_OUTLOOK_CACHE_LIMIT);
}
export function loadSiteCountyGeometry(stateCode: IncludedStateCode, force = false): Promise<CountyGeometry> {
    const cached = cachedCountyGeometries.get(stateCode);
    if (!force && cached)
        return Promise.resolve(cached.value);
    const pending = pendingCountyGeometries.get(stateCode);
    if (pending)
        return pending;
    const request = loadCountyGeometry(stateCode).then((geometry) => {
        cachedCountyGeometries.set(stateCode, { value: geometry, cachedAt: Date.now(), ttl: Number.POSITIVE_INFINITY });
        return geometry;
    }).finally(() => { pendingCountyGeometries.delete(stateCode); });
    pendingCountyGeometries.set(stateCode, request);
    return request;
}
export function loadStateOutlook(signalId: SignalId, stateCode: IncludedStateCode, period = "", force = false): Promise<NationalOutlookResponse> {
    const key = stateOutlookKey(signalId, stateCode, period);
    const cached = cachedStateOutlooks.get(key);
    if (!force && isFresh(cached))
        return Promise.resolve(cached.value);
    const pending = pendingStateOutlooks.get(key);
    if (!force && cached) {
        if (!pending)
            void loadStateOutlook(signalId, stateCode, period, true).catch(() => undefined);
        return Promise.resolve(cached.value);
    }
    if (pending)
        return pending;
    const params = new URLSearchParams({ signal: signalId, state: stateCode });
    if (period)
        params.set("period", period);
    const request = fetch(`/api/national/outlook?${params}`).then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok)
            throw new Error(readJsonError(payload, "State detail is temporarily unavailable."));
        return payload as NationalOutlookResponse;
    }).then((outlook) => {
        cachedStateOutlooks.set(key, { value: outlook, cachedAt: Date.now(), ttl: outlook.status === "current" ? SITE_SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
        trimCache(cachedStateOutlooks, STATE_OUTLOOK_CACHE_LIMIT);
        return outlook;
    }).finally(() => { pendingStateOutlooks.delete(key); });
    pendingStateOutlooks.set(key, request);
    return request;
}
export function getCachedStateOutlook(signalId: SignalId, stateCode: IncludedStateCode, period = "") {
    const cached = cachedStateOutlooks.get(stateOutlookKey(signalId, stateCode, period));
    return isFresh(cached) ? cached.value : null;
}
export function primeStateOutlook(outlook: NationalOutlookResponse, period = "") {
    if (!outlook.selectedState)
        return;
    const key = stateOutlookKey(outlook.signal.id, outlook.selectedState, period);
    cachedStateOutlooks.set(key, { value: outlook, cachedAt: Date.now(), ttl: outlook.status === "current" ? SITE_SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
    trimCache(cachedStateOutlooks, STATE_OUTLOOK_CACHE_LIMIT);
}
export function primeForecastSnapshot(forecast: NationalForecastResponse, period = "") {
    const key = `${forecast.signalId}:${forecast.horizon}:${period}:${forecast.selectedState ?? ""}`;
    cachedForecastSnapshots.set(key, { value: forecast, cachedAt: Date.now(), ttl: forecast.status === "current" ? SITE_SNAPSHOT_TTL_MS : PARTIAL_SNAPSHOT_TTL_MS });
    trimCache(cachedForecastSnapshots, FORECAST_CACHE_LIMIT);
}
export function clearSiteSnapshotCache() {
    cachedCountyGeometries.clear();
    pendingCountyGeometries.clear();
    cachedForecastSnapshots.clear();
    pendingForecastSnapshots.clear();
    cachedNationalOutlooks.clear();
    pendingNationalOutlooks.clear();
    cachedStateOutlooks.clear();
    pendingStateOutlooks.clear();
}
