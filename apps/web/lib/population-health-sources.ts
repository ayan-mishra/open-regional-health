import "server-only";
import { loadPhase1, warmPopulationHealthPhase1 } from "@/lib/population-health-phase1";
import { loadPhase2, warmPopulationHealthPhase2 } from "@/lib/population-health-phase2";
import { loadPhase3 } from "@/lib/population-health-phase3";
import { loadPhase4 } from "@/lib/population-health-phase4";
import type { PopulationHealthResponse, PopulationSection } from "@/lib/population-health-contracts";
import { buildPopulationIntelligence, POPULATION_CONTEXT_SIGNAL_IDS } from "@/lib/population-health-intelligence";
import { getServerOutlookSnapshots } from "@/lib/server-public-snapshot";
import { unavailableMeasure } from "@/lib/population-health-utils";
import { readBakedPopulationState } from "@/lib/population-store";
import { isIncludedJurisdiction, jurisdictionByCode, type IncludedStateCode } from "@/lib/us-geography";
export type PopulationPhaseResult = {
    section: PopulationSection;
    errors: Array<{
        source: string;
        message: string;
    }>;
    sources: PopulationHealthResponse["sources"];
};
const CONTEXT_TTL_MS = 43200000;
const PARTIAL_CONTEXT_TTL_MS = 300000;
const MAX_CONTEXTS = 100;
export const POPULATION_HISTORY_START = "2018-01";
type ContextEntry = {
    value: PopulationHealthResponse;
    cachedAt: number;
};
const contextCache = new Map<string, ContextEntry>();
const contextPending = new Map<string, Promise<PopulationHealthResponse>>();
export async function warmPopulationHealthData() {
    await warmPopulationHealthPhase1().catch(() => undefined);
    await warmPopulationHealthPhase2().catch(() => undefined);
    await getServerOutlookSnapshots(POPULATION_CONTEXT_SIGNAL_IDS, "", 1, true);
}
export async function getPopulationHealthContext(input: {
    stateCode?: string | null;
    countyFips?: string | null;
    period?: string | null;
    recompute?: boolean;
}): Promise<PopulationHealthResponse> {
    const normalizedState = input.stateCode?.toUpperCase() ?? "";
    const stateCode = normalizedState && isIncludedJurisdiction(normalizedState) ? normalizedState as IncludedStateCode : null;
    const countyFips = stateCode && input.countyFips && /^\d{5}$/.test(input.countyFips) && input.countyFips.startsWith(stateFips(stateCode)) ? input.countyFips : null;
    const period = normalizePopulationPeriod(input.period);
    if (input.recompute)
        return loadPopulationHealthContext(stateCode, countyFips, period);
    const key = (stateCode ?? "national") + ":" + (countyFips ?? "state") + ":" + (period ?? "current");
    if (stateCode && !countyFips && !period) {
        const baked = await readBakedPopulationState(stateCode);
        if (baked)
            return { ...baked, ...await buildPopulationIntelligence({ stateCode, countyFips, period, sections: baked.sections }) };
    }
    const cached = contextCache.get(key);
    const ttl = cached?.value.status === "current" ? CONTEXT_TTL_MS : PARTIAL_CONTEXT_TTL_MS;
    const pending = contextPending.get(key);
    const load = () => loadPopulationHealthContext(stateCode, countyFips, period).then((value) => {
        contextCache.delete(key);
        contextCache.set(key, { value, cachedAt: Date.now() });
        if (contextCache.size > MAX_CONTEXTS)
            contextCache.delete(contextCache.keys().next().value!);
        return value;
    }).finally(() => contextPending.delete(key));
    if (cached) {
        if (Date.now() - cached.cachedAt >= ttl && !pending) {
            const refresh = load().catch(() => cached.value);
            contextPending.set(key, refresh);
        }
        return cached.value;
    }
    if (pending)
        return pending;
    const request = load();
    contextPending.set(key, request);
    return request;
}
async function loadPopulationHealthContext(stateCode: IncludedStateCode | null, countyFips: string | null, period: string | null): Promise<PopulationHealthResponse> {
    const baseline = safePhase("baseline", loadPhase1(stateCode, countyFips, period));
    const access = safePhase("access", loadPhase2(stateCode, countyFips, period));
    const resilience = safePhase("resilience", loadPhase4(stateCode, countyFips, period));
    const baselineResult = await baseline;
    const population = baselineResult.section.measures.find((measure) => measure.id === "population")?.value ?? null;
    const prevention = safePhase("prevention", loadPhase3(stateCode, countyFips, period, population));
    const [accessResult, preventionResult, resilienceResult] = await Promise.all([access, prevention, resilience]);
    const results = [baselineResult, accessResult, preventionResult, resilienceResult];
    const sections = results.map((result) => result.section);
    const errors = results.flatMap((result) => result.errors);
    const sources = [...new Map(results.flatMap((result) => result.sources).map((source) => [source.name, source])).values()];
    const measures = sections.flatMap((section) => section.measures);
    const allCurrent = measures.length > 0 && measures.every((measure) => measure.status === "current");
    const hasUsable = measures.some((measure) => measure.status !== "unavailable");
    const intelligence = stateCode ? await buildPopulationIntelligence({ stateCode, countyFips, period, sections }) : { geographyLabel: "Choose a region", summary: "Choose a state to load population context.", signals: [], insights: [], coverage: { available: 0, partial: 0, unavailable: measures.length, total: measures.length, label: "No region selected" } };
    return { retrievedAt: new Date().toISOString(), period, status: !hasUsable ? "unavailable" : allCurrent && !errors.length ? "current" : "partial", selectedState: stateCode, selectedCountyFips: countyFips, sections, ...intelligence, errors, sources };
}
async function safePhase(name: string, request: Promise<PopulationPhaseResult>): Promise<PopulationPhaseResult> {
    try {
        return await request;
    }
    catch {
        const source = "Population health " + name;
        const label = name[0].toUpperCase() + name.slice(1) + " context";
        return {
            section: { id: name as PopulationSection["id"], title: label, description: "This phase could not be read during the current request.", measures: [unavailableMeasure({ id: name + "-unavailable", label, category: name as PopulationSection["id"], geographyType: "state", source, sourceUrl: "https://www.cdc.gov/", vintage: "Current request", cadence: "Varies", note: "The connector failed before it returned a usable value." })] },
            errors: [{ source, message: "The connector failed before it returned a usable value." }],
            sources: [],
        };
    }
}
export function clearPopulationHealthContextCache() {
    contextCache.clear();
    contextPending.clear();
}
function stateFips(stateCode: IncludedStateCode): string {
    return jurisdictionByCode(stateCode)!.fips;
}
export function normalizePopulationPeriod(value: string | null | undefined, now = new Date()): string | null {
    if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
        return null;
    const current = now.toISOString().slice(0, 7);
    return value >= POPULATION_HISTORY_START && value <= current ? value : null;
}
