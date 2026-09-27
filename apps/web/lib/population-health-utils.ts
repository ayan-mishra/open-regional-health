import "server-only";
import { cachedPublisherFetch } from "@/lib/publisher-cache";
import { formatOrdinal } from "@/lib/format";
import type { PopulationCategory, PopulationGeography, PopulationMeasure, PopulationEstimateType, PopulationMeasureStatus } from "@/lib/population-health-contracts";
import type { IncludedStateCode } from "@/lib/us-geography";
export type CsvRow = Record<string, string>;
export const POPULATION_PUBLISHER_TIMEOUT_MS = 3000;
export async function fetchJsonRows(url: string, ttlSeconds = 21600): Promise<Record<string, unknown>[]> {
    return cachedPublisherFetch(`population-health:json:${url}`, ttlSeconds, async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(POPULATION_PUBLISHER_TIMEOUT_MS), headers: { accept: "application/json" }, cache: "no-store" });
        if (!response.ok)
            throw new Error(`Publisher returned ${response.status}`);
        const body: unknown = await response.json();
        if (!Array.isArray(body))
            throw new Error("Publisher returned a non-list response");
        return body.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
    });
}
export async function fetchCsvRows(url: string, ttlSeconds = 86400): Promise<CsvRow[]> {
    return cachedPublisherFetch(`population-health:csv:${url}`, ttlSeconds, async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(POPULATION_PUBLISHER_TIMEOUT_MS), headers: { accept: "text/csv" }, cache: "no-store" });
        if (!response.ok)
            throw new Error(`Publisher returned ${response.status}`);
        return parseCsv(await response.text());
    });
}
export function parseCsv(text: string, selectedHeaders?: readonly string[]): CsvRow[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const next = text[index + 1];
        if (character === '"' && quoted && next === '"') {
            field += '"';
            index += 1;
            continue;
        }
        if (character === '"') {
            quoted = !quoted;
            continue;
        }
        if (character === "," && !quoted) {
            row.push(field);
            field = "";
            continue;
        }
        if ((character === "\n" || character === "\r") && !quoted) {
            if (character === "\r" && next === "\n")
                index += 1;
            row.push(field);
            field = "";
            if (row.some((value) => value.length > 0))
                rows.push(row);
            row = [];
            continue;
        }
        field += character;
    }
    if (field || row.length) {
        row.push(field);
        rows.push(row);
    }
    const headers = (rows.shift() ?? []).map((header) => header.trim().replace(/^\uFEFF/, ""));
    const selected = selectedHeaders ? selectedHeaders.map((header) => [header, headers.indexOf(header)] as const) : headers.map((header, index) => [header, index] as const);
    return rows.map((values) => Object.fromEntries(selected.map(([header, index]) => [header, index < 0 ? "" : values[index]?.trim() ?? ""])));
}
export function numberValue(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return null;
    const parsed = Number(value.replace(/[%,$]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
}
export function textValue(value: unknown): string {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function normalizeFips(value: unknown, width = 5): string {
    const digits = textValue(value).replace(/\.0$/, "").replace(/\D/g, "");
    return digits && digits.length <= width ? digits.padStart(width, "0") : "";
}
export function displayNumber(value: number | null, unit: string): string {
    if (value === null)
        return "Unavailable";
    if (unit === "%")
        return `${value.toFixed(1)}%`;
    if (unit === "percentile")
        return `${formatOrdinal(value)} percentile`;
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: Number.isInteger(value) ? 0 : 1 }).format(value);
}
export function sourceError(error: unknown): string {
    void error;
    return "The publisher response could not be read.";
}
export function makeMeasure(input: Omit<PopulationMeasure, "displayValue">): PopulationMeasure {
    return { ...input, displayValue: displayNumber(input.value, input.unit) };
}
export function unavailableMeasure(input: {
    id: string;
    label: string;
    category: PopulationCategory;
    geographyType: PopulationGeography;
    source: string;
    sourceUrl: string;
    vintage: string;
    cadence: string;
    note: string;
    stateCode?: IncludedStateCode;
    fips?: string;
    estimateType?: PopulationEstimateType;
    status?: PopulationMeasureStatus;
}): PopulationMeasure {
    return makeMeasure({ ...input, value: null, unit: "—", estimateType: input.estimateType ?? "observed", status: input.status ?? "unavailable", period: "" });
}
