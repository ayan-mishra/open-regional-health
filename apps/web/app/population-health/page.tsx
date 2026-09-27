import type { Metadata } from "next";
import { PopulationHealthPage } from "@/components/population-health-page";
import { countyReference } from "@/lib/county-reference";
import { getPopulationHealthContext, normalizePopulationPeriod } from "@/lib/population-health-sources";
import { isIncludedJurisdiction, jurisdictionByCode, type IncludedStateCode } from "@/lib/us-geography";
export const metadata: Metadata = {
    title: "Population health",
    description: "Population denominators, vulnerability, access, prevention, outbreaks, and hazard context for Corvid planning.",
};
export const dynamic = "force-dynamic";
export default async function PopulationHealthRoute({ searchParams }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    if (typeof params.state !== "string")
        return <PopulationHealthPage context={null} counties={[]}/>;
    const requestedState = params.state.toUpperCase();
    if (!isIncludedJurisdiction(requestedState))
        return <PopulationHealthPage context={null} counties={[]}/>;
    const state = requestedState as IncludedStateCode;
    const stateFips = jurisdictionByCode(state)!.fips;
    const countyReferenceForState = await countyReference(stateFips);
    const countyFips = new Set(countyReferenceForState.nameToFips.values());
    const requestedCounty = typeof params.county === "string" && countyFips.has(params.county) ? params.county : null;
    const requestedPeriod = typeof params.period === "string" ? normalizePopulationPeriod(params.period) : null;
    const context = await getPopulationHealthContext({ stateCode: state, countyFips: requestedCounty, period: requestedPeriod });
    const counties = countyReferenceForState.counties.toSorted((left, right) => left.name.localeCompare(right.name));
    return <PopulationHealthPage context={context} counties={counties}/>;
}
