import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { cachedPublisherFetch, clearPublisherCache, pinPublisherCacheKey } from "@/lib/publisher-cache";
afterEach(() => { clearPublisherCache(); vi.useRealTimers(); });
describe("publisher cache", () => {
    it("does not retry a failing loader on every caller", async () => {
        const loader = vi.fn(async () => { throw new Error("Publisher responded with 500"); });
        await expect(cachedPublisherFetch("failing", 43200, loader)).rejects.toThrow("Publisher responded with 500");
        await expect(cachedPublisherFetch("failing", 43200, loader)).rejects.toThrow("Publisher responded with 500");
        await expect(cachedPublisherFetch("failing", 43200, loader)).rejects.toThrow("Publisher responded with 500");
        expect(loader).toHaveBeenCalledOnce();
    });
    it("retries once the failure window has passed", async () => {
        vi.useFakeTimers();
        let attempts = 0;
        const loader = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1)
                throw new Error("Publisher responded with 503");
            return "recovered";
        });
        await expect(cachedPublisherFetch("recovering", 43200, loader)).rejects.toThrow("Publisher responded with 503");
        vi.setSystemTime(Date.now() + 300001);
        await expect(cachedPublisherFetch("recovering", 43200, loader)).resolves.toBe("recovered");
    });
    it("does not remember a failure once the loader has succeeded", async () => {
        let attempts = 0;
        const loader = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1)
                throw new Error("Publisher responded with 500");
            return attempts;
        });
        await expect(cachedPublisherFetch("mixed", 0, loader)).rejects.toThrow();
        clearPublisherCache();
        await expect(cachedPublisherFetch("mixed", 0, loader)).resolves.toBe(2);
        await expect(cachedPublisherFetch("mixed", 0, loader)).resolves.toBe(2);
    });
    it("evicts unpinned entries before pinned ones when over budget", async () => {
        const megabyte = (fill: string) => fill.repeat(9 * 1024 * 1024);
        pinPublisherCacheKey("pinned");
        await cachedPublisherFetch("pinned", 43200, async () => megabyte("p"));
        await cachedPublisherFetch("bulky", 43200, async () => megabyte("b"));
        const loader = vi.fn(async () => "refetched");
        await expect(cachedPublisherFetch("pinned", 43200, loader)).resolves.toBe(megabyte("p"));
        expect(loader).not.toHaveBeenCalled();
    });
});
