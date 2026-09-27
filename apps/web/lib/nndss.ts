import { z } from "zod";
import type { SignalId } from "@/lib/signal-catalog";
import { US_JURISDICTIONS, type IncludedStateCode } from "@/lib/us-geography";
import { optionalNonNegativePublisherNumber } from "@/lib/publisher-values";
export const NNDSS_ENDPOINT = "https://data.cdc.gov/resource/x9gk-5huc.json";
export const NNDSS_SIGNAL_LABELS = {
    "wnv-activity": ["Arboviral diseases, West Nile virus disease"],
    "anaplasmosis-cases": ["Ehrlichiosis and Anaplasmosis, Anaplasma phagocytophilum infection"],
    "babesiosis-cases": ["Babesiosis"],
    "powassan-cases": ["Arboviral diseases, Powassan virus disease"],
    "pertussis-cases": ["Pertussis"],
    "measles-cases": ["Measles, Imported", "Measles, Indigenous"],
    "mumps-cases": ["Mumps"],
    "hepatitis-a-cases": ["Hepatitis A, Confirmed", "Hepatitis, A, acute"],
    "campylobacteriosis-cases": ["Campylobacteriosis"],
    "salmonellosis-cases": ["Salmonellosis (excluding Salmonella Typhi infection and Salmonella Paratyphi infection)"],
    "shigellosis-cases": ["Shigellosis"],
    "stec-cases": ["Shiga toxin-producing Escherichia coli (STEC)"],
    "legionellosis-cases": ["Legionellosis"],
    "meningococcal-cases": ["Meningococcal disease, All serogroups"],
    "dengue-cases": ["Dengue virus infections, Dengue"],
    "mpox-cases": ["Mpox"],
    "pneumococcal-cases": ["Invasive pneumococcal disease, all ages, Confirmed"],
    "congenital-syphilis-cases": ["Syphilis, Congenital"],
} as const satisfies Partial<Record<SignalId, readonly string[]>>;
export const nndssRowSchema = z.object({
    states: z.string(),
    year: z.coerce.number().int().min(1900),
    week: z.coerce.number().int().min(1).max(53),
    label: z.string(),
    m1: optionalNonNegativePublisherNumber,
    m1_flag: z.string().optional(),
    location1: z.string().optional(),
});
export type NndssRow = z.infer<typeof nndssRowSchema>;
const STATE_POPULATION_2020: Record<IncludedStateCode, number> = {
    AL: 5024279, AZ: 7151502, AR: 3011524, CA: 39538223, CO: 5773714, CT: 3605944, DE: 989948, DC: 689545,
    FL: 21538187, GA: 10711908, ID: 1839106, IL: 12812508, IN: 6785528, IA: 3190369, KS: 2937880, KY: 4505836,
    LA: 4657757, ME: 1362359, MD: 6177224, MA: 7029917, MI: 10077331, MN: 5706494, MS: 2961279, MO: 6154913,
    MT: 1084225, NE: 1961504, NV: 3104614, NH: 1377529, NJ: 9288994, NM: 2117522, NY: 20201249, NC: 10439388,
    ND: 779094, OH: 11799448, OK: 3959353, OR: 4237256, PA: 13002700, RI: 1097379, SC: 5118425, SD: 886667,
    TN: 6910840, TX: 29145505, UT: 3271616, VT: 643077, VA: 8631393, WA: 7705281, WV: 1793716, WI: 5893718,
    WY: 576851,
};
const STATE_CODE_BY_NAME = new Map(US_JURISDICTIONS.map((state) => [state.name.toUpperCase(), state.code]));
export function nndssStateCode(name: string): IncludedStateCode | undefined {
    const normalized = name.toUpperCase();
    if (normalized === "NEW YORK CITY")
        return "NY";
    return STATE_CODE_BY_NAME.get(normalized);
}
export function mmwrWeekEnding(year: number, week: number) {
    const januaryFourth = new Date(Date.UTC(year, 0, 4));
    const firstSaturday = new Date(januaryFourth);
    firstSaturday.setUTCDate(januaryFourth.getUTCDate() + (6 - januaryFourth.getUTCDay() + 7) % 7 + (week - 1) * 7);
    return firstSaturday.toISOString().slice(0, 10);
}
export function nndssRate(count: number, stateCode: IncludedStateCode) {
    return count / STATE_POPULATION_2020[stateCode] * 100000;
}
export function nndssLabelWhere(signalId: SignalId) {
    const labels = NNDSS_SIGNAL_LABELS[signalId as keyof typeof NNDSS_SIGNAL_LABELS];
    if (!labels)
        return null;
    return labels.map((label) => `'${label.replaceAll("'", "''")}'`).join(",");
}
export function aggregateNndssRows(rows: NndssRow[]) {
    const counts = new Map<string, {
        code: IncludedStateCode;
        date: string;
        count: number;
    }>();
    for (const row of rows) {
        const code = nndssStateCode(row.states);
        const reportedCount = row.m1 ?? (row.m1_flag === "-" ? 0 : undefined);
        if (!code || reportedCount === undefined || !Number.isFinite(reportedCount))
            continue;
        const date = mmwrWeekEnding(row.year, row.week);
        const key = `${code}:${date}`;
        const current = counts.get(key);
        counts.set(key, { code, date, count: (current?.count ?? 0) + reportedCount });
    }
    return [...counts.values()].map((item) => ({ ...item, value: nndssRate(item.count, item.code) }));
}
