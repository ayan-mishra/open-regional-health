import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getMassachusettsCountyDetails, warmMassachusettsCountyConnectors } from "@/lib/massachusetts-national-details";
import type { RespiratoryOutlook } from "@/lib/outlook-contracts";
import { clearPublisherCache } from "@/lib/publisher-cache";
afterEach(() => { vi.unstubAllGlobals(); clearPublisherCache(); });
describe("Massachusetts national detail enrichment", () => {
    it("requires three reporting wastewater sites and emits a percentage", async () => {
        const outlook = {
            auxiliary: {
                wastewater: {
                    measles: {
                        observedThrough: "2026-07-25",
                        sitesReporting: 5,
                        detectedSites: 2,
                        counties: {
                            MIDDLESEX: { sitesReporting: 2, detectedSites: 2 },
                            SUFFOLK: { sitesReporting: 3, detectedSites: 1 },
                        },
                    },
                },
            },
        } as unknown as RespiratoryOutlook;
        const details = await getMassachusettsCountyDetails("measles-detection", null, outlook);
        expect(details).toHaveLength(1);
        expect(details?.[0]).toMatchObject({ counties: ["Suffolk"], displayValue: "1 of 3 sites" });
        expect(details?.[0]?.value).toBeCloseTo(100 / 3);
    });
    it("does not replace national WVAL with a pathogen-detection percentage", async () => {
        const outlook = {
            auxiliary: {
                wastewater: {
                    sarsCov2: {
                        observedThrough: "2026-07-25",
                        sitesReporting: 3,
                        detectedSites: 1,
                        counties: { SUFFOLK: { sitesReporting: 3, detectedSites: 1 } },
                    },
                },
            },
        } as unknown as RespiratoryOutlook;
        expect(await getMassachusettsCountyDetails("sars-cov-2-wval", null, outlook)).toBeNull();
    });
    it("reads only the connector a live signal needs, not the whole Massachusetts outlook", async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (!url.includes("files.airnowtech.org"))
                throw new Error(`Unexpected request: ${url}`);
            return new Response("07/31/26|Boston Metro|MA|PM2.5|42|Good|42.3|-71.0|");
        });
        vi.stubGlobal("fetch", fetchMock);
        await getMassachusettsCountyDetails("air-quality", null).catch(() => undefined);
        expect(fetchMock.mock.calls.every(([input]) => String(input).includes("files.airnowtech.org"))).toBe(true);
        expect(fetchMock).toHaveBeenCalledOnce();
    });
    it("does not replace the national CMS ED length-of-stay connector", async () => {
        const outlook = {
            auxiliary: {
                wastewater: {},
            },
        } as unknown as RespiratoryOutlook;
        expect(await getMassachusettsCountyDetails("ed-wait", null, outlook)).toBeNull();
    });
    it("reports which connector fell back to the bundled snapshot instead of failing silently", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("mass.gov is unreachable"); }));
        const fallbacks: Array<[
            string,
            string
        ]> = [];
        const details = await getMassachusettsCountyDetails("available-beds", null, undefined, (source, observedThrough) => {
            fallbacks.push([source, observedThrough]);
        });
        expect(details?.length).toBeGreaterThan(0);
        expect(fallbacks).toHaveLength(1);
        expect(fallbacks[0][0]).toBe("MassDPH hospital capacity workbook");
        expect(fallbacks[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    it("warms every county connector even when one of them fails", async () => {
        const seen: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            seen.push(url);
            if (url.includes("mass.gov"))
                throw new Error("MassDPH is down");
            return new Response("07/31/26|Boston Metro|MA|PM2.5|42|Good|42.3|-71.0|");
        }));
        let pauses = 0;
        const pause = async () => { pauses += 1; };
        await expect(warmMassachusettsCountyConnectors(pause)).resolves.toBeUndefined();
        expect(pauses).toBe(5);
        expect(seen.some((url) => url.includes("files.airnowtech.org"))).toBe(true);
        expect(seen.some((url) => url.includes("data.cdc.gov"))).toBe(true);
    });
});
