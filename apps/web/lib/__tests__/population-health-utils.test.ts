import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { displayNumber, fetchCsvRows, fetchJsonRows, normalizeFips, parseCsv, sourceError } from "@/lib/population-health-utils";
import { clearPublisherCache } from "@/lib/publisher-cache";
describe("population health source utilities", () => {
    it("does not expose connector or environment details", () => {
        expect(sourceError(new Error("Set CORVID_PRIVATE_ENDPOINT to enable this connector."))).toBe("The publisher response could not be read.");
    });
    it("parses quoted publisher CSV fields and preserves commas", () => {
        expect(parseCsv('name,value\n"County, One",12\n"County ""Two""",13')).toEqual([
            { name: "County, One", value: "12" },
            { name: 'County "Two"', value: "13" },
        ]);
    });
    it("materializes only selected columns for large publisher files", () => {
        expect(parseCsv("keep,discard,value\na,large payload,1", ["keep", "value"])).toEqual([{ keep: "a", value: "1" }]);
    });
    it("normalizes publisher FIPS values and displays contextual units", () => {
        expect(normalizeFips("25025.0")).toBe("25025");
        expect(normalizeFips(undefined)).toBe("");
        expect(normalizeFips("125025")).toBe("");
        expect(displayNumber(42.35, "%")).toBe("42.4%");
        expect(displayNumber(0.2663 * 100, "percentile")).toBe("27th percentile");
        expect([1, 2, 3, 11, 21].map((value) => displayNumber(value, "percentile"))).toEqual([
            "1st percentile", "2nd percentile", "3rd percentile", "11th percentile", "21st percentile",
        ]);
    });
});
describe("population health publisher request bounding", () => {
    afterEach(() => {
        clearPublisherCache();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
    it("bounds JSON and CSV publisher requests to three seconds", async () => {
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => realTimeout(ms));
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            void init;
            if (url.includes("/json"))
                return { ok: true, json: async () => [] };
            return { ok: true, text: async () => "a,b\n1,2" };
        });
        vi.stubGlobal("fetch", fetchMock);
        await fetchJsonRows("https://publisher.example/json", 60);
        await fetchCsvRows("https://publisher.example/csv", 60);
        expect(timeoutSpy).toHaveBeenNthCalledWith(1, 3000);
        expect(timeoutSpy).toHaveBeenNthCalledWith(2, 3000);
        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeoutSpy.mock.results[0]?.value);
        expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(timeoutSpy.mock.results[1]?.value);
    });
    it("aborts a hanging publisher instead of waiting on the socket indefinitely", async () => {
        const controller = new AbortController();
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
            void ms;
            setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), 10);
            return controller.signal;
        });
        const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
            void resolve;
            const signal = init?.signal;
            if (!signal)
                return;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(fetchJsonRows("https://publisher.example/hangs", 60)).rejects.toThrow("timeout");
        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    });
});
