import "server-only";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NationalOutlookResponse } from "@/lib/national-contracts";
import type { SignalId } from "@/lib/signal-catalog";
export const HISTORY_STORE_VERSION = 1;
export const HISTORY_FIRST_PERIOD = "2024-01";
export type BakedHistoryMonth = {
    version: typeof HISTORY_STORE_VERSION;
    bakedAt: string;
    retrievedAt: string;
    status: NationalOutlookResponse["status"];
    states: NationalOutlookResponse["states"];
    details: NationalOutlookResponse["details"];
    geography: NationalOutlookResponse["geography"];
    errors: NationalOutlookResponse["errors"];
    absent?: {
        reason: string;
        detail: string;
    };
};
export type HistoryAbsence = NonNullable<BakedHistoryMonth["absent"]>;
const storeDirectory = () => resolve(process.env.CORVID_HISTORY_STORE_DIR ?? join(process.cwd(), "history-store"));
const monthFile = (signalId: SignalId, period: string) => join(storeDirectory(), signalId, `${period}.json.gz`);
export function historyPeriods(now = new Date()): string[] {
    const periods: string[] = [];
    const [firstYear, firstMonth] = HISTORY_FIRST_PERIOD.split("-").map(Number);
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (let cursor = new Date(Date.UTC(firstYear, firstMonth - 1, 1)); cursor < end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
        periods.push(cursor.toISOString().slice(0, 7));
    }
    return periods;
}
export function isBakedHistoryPeriod(period: string, now = new Date()): boolean {
    return historyPeriods(now).includes(period);
}
export async function readBakedHistoryMonth(signalId: SignalId, period: string): Promise<BakedHistoryMonth | null> {
    try {
        const parsed = JSON.parse(gunzipSync(await readFile(monthFile(signalId, period))).toString("utf8")) as BakedHistoryMonth;
        return parsed?.version === HISTORY_STORE_VERSION ? parsed : null;
    }
    catch {
        return null;
    }
}
export async function writeBakedHistoryMonth(signalId: SignalId, period: string, month: Omit<BakedHistoryMonth, "version" | "bakedAt">) {
    await mkdir(join(storeDirectory(), signalId), { recursive: true });
    const payload: BakedHistoryMonth = { version: HISTORY_STORE_VERSION, bakedAt: new Date().toISOString(), ...month };
    await writeFile(monthFile(signalId, period), gzipSync(JSON.stringify(payload), { level: 9 }));
}
