import "server-only";
import { createStateSliceStore, STORE_VERSION } from "@/lib/state-slice-store";
import type { NationalForecastDetailReading, NationalForecastEvidence, NationalForecastResponse, NationalForecastState } from "@/lib/national-contracts";
export type BakedForecastIndex = {
    version: typeof STORE_VERSION;
    bakedAt: string;
    retrievedAt: string;
    status: NationalForecastResponse["status"];
    states: NationalForecastState[];
    errors: NationalForecastResponse["errors"];
    evidence?: NationalForecastEvidence;
    details?: NationalForecastDetailReading[];
};
export type BakedStateForecast = {
    version: typeof STORE_VERSION;
    evidence: NationalForecastEvidence;
    details: NationalForecastDetailReading[];
};
const store = createStateSliceStore<BakedForecastIndex, BakedStateForecast>("forecast-store", process.env.CORVID_FORECAST_STORE_DIR);
export const readBakedForecastIndex = store.readIndex;
export const readBakedStateForecast = store.readSlice;
export const readForecastStoreManifest = store.readManifest;
export const writeBakedForecast = store.writeSignal;
export const writeForecastStoreManifest = store.writeManifest;
