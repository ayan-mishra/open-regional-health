import "server-only";
import { createStateSliceStore, STORE_VERSION } from "@/lib/state-slice-store";
import type { NationalDetailReading, NationalOutlookResponse, NationalStateReading } from "@/lib/national-contracts";
export type BakedSignalIndex = {
    version: typeof STORE_VERSION;
    bakedAt: string;
    retrievedAt: string;
    status: NationalOutlookResponse["status"];
    states: NationalStateReading[];
    errors: NationalOutlookResponse["errors"];
    geography?: NationalOutlookResponse["geography"];
};
export type BakedStateDetail = {
    version: typeof STORE_VERSION;
    details: NationalDetailReading[];
    geography: NationalOutlookResponse["geography"];
};
const store = createStateSliceStore<BakedSignalIndex, BakedStateDetail>("county-store", process.env.CORVID_COUNTY_STORE_DIR);
export const readBakedSignalIndex = store.readIndex;
export const readBakedStateDetail = store.readSlice;
export const readCountyStoreManifest = store.readManifest;
export const writeBakedSignal = store.writeSignal;
export const writeCountyStoreManifest = store.writeManifest;
