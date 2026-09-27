import "server-only";
type Entry<T> = {
    value: T;
    fetchedAt: number;
    size: number;
};
const MEMORY_BUDGET_BYTES = 16 * 1024 * 1024;
const pinned = new Set<string>();
const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const FAILURE_TTL_MS = 300000;
const failures = new Map<string, {
    error: unknown;
    failedAt: number;
}>();
let totalSize = 0;
function estimateSize(value: unknown): number {
    try {
        return JSON.stringify(value)?.length ?? 0;
    }
    catch {
        return 0;
    }
}
function touch(key: string, entry: Entry<unknown>) {
    store.delete(key);
    store.set(key, entry);
}
function put(key: string, value: unknown) {
    const previous = store.get(key);
    if (previous)
        totalSize -= previous.size;
    const size = estimateSize(value);
    store.delete(key);
    store.set(key, { value, fetchedAt: Date.now(), size });
    totalSize += size;
    for (const [oldestKey, oldestEntry] of store) {
        if (totalSize <= MEMORY_BUDGET_BYTES)
            break;
        if (pinned.has(oldestKey))
            continue;
        store.delete(oldestKey);
        totalSize -= oldestEntry.size;
    }
}
export function cachedPublisherFetch<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = store.get(key) as Entry<T> | undefined;
    if (cached) {
        touch(key, cached);
        if (now - cached.fetchedAt < ttlSeconds * 1000)
            return Promise.resolve(cached.value);
        if (!inflight.has(key)) {
            const refresh = loader()
                .then((value) => { put(key, value); return value; })
                .catch(() => cached.value)
                .finally(() => inflight.delete(key));
            inflight.set(key, refresh);
        }
        return Promise.resolve(cached.value);
    }
    const pending = inflight.get(key) as Promise<T> | undefined;
    if (pending)
        return pending;
    const failure = failures.get(key);
    if (failure) {
        if (now - failure.failedAt < FAILURE_TTL_MS)
            return Promise.reject(failure.error);
        failures.delete(key);
    }
    const first = loader()
        .then((value) => { failures.delete(key); put(key, value); return value; })
        .catch((error: unknown) => { failures.set(key, { error, failedAt: Date.now() }); throw error; })
        .finally(() => inflight.delete(key));
    inflight.set(key, first);
    return first;
}
export function pinPublisherCacheKey(key: string) {
    pinned.add(key);
}
export function clearPublisherCache() {
    store.clear();
    pinned.clear();
    failures.clear();
    inflight.clear();
    totalSize = 0;
}
