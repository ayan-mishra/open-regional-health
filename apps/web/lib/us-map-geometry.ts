import stateGeometry from "@/lib/generated/us-states.json";
import { jurisdictionByCode, type IncludedStateCode } from "@/lib/us-geography";
export type StatePath = {
    code: IncludedStateCode;
    fips: string;
    name: string;
    path: string;
    centroid: [
        number,
        number
    ];
    geoCentroid: [
        number,
        number
    ];
};
export type CountyPath = {
    fips: string;
    name: string;
    path: string;
};
export type CountyGeometry = {
    stateCode: IncludedStateCode;
    viewBox: string;
    statePath: string;
    counties: CountyPath[];
    source: string;
    sourceSha256: string;
};
export const US_MAP_VIEWBOX = stateGeometry.viewBox;
export const US_STATE_GEOMETRY = stateGeometry.states as StatePath[];
export const US_MAP_SOURCE = { url: stateGeometry.source, sha256: stateGeometry.sourceSha256, generatedAt: stateGeometry.generatedAt };
export function countyGeometryUrl(stateCode: IncludedStateCode) {
    const state = jurisdictionByCode(stateCode);
    if (!state)
        throw new Error("Jurisdiction is not included in the contiguous U.S. map");
    return `/geometry/counties/${state.fips}.json`;
}
export async function loadCountyGeometry(stateCode: IncludedStateCode, signal?: AbortSignal): Promise<CountyGeometry> {
    const response = await fetch(countyGeometryUrl(stateCode), { signal });
    if (!response.ok)
        throw new Error(`County geometry responded with ${response.status}`);
    return response.json() as Promise<CountyGeometry>;
}
