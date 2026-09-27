const COUNTY_ALIASES: Record<string, string> = {
    DISTRICT: "DISTRICTOFCOLUMBIA",
    THEDISTRICT: "DISTRICTOFCOLUMBIA",
    EBATONROUGE: "EASTBATONROUGE",
    JEFFRSONDAVIS: "JEFFERSONDAVIS",
    LAKEOFWOODS: "LAKEOFTHEWOODS",
    YELLOWMEDCINE: "YELLOWMEDICINE",
    SCOTTBLUFF: "SCOTTSBLUFF",
    BEDFORDCITY: "BEDFORD",
    DOAANA: "DONAANA",
    DOAAANA: "DONAANA",
};
export function normalizedCounty(value: string) {
    const normalized = value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/\b(SAINT|SAINTE|STE|ST)\b/g, "SAINT")
        .replace(/\b(COUNTY|CNTY|PARISH|BOROUGH|CENSUS AREA|PLANNING REGION|CTY)\b/g, "")
        .replace(/[^A-Z0-9]/g, "");
    return COUNTY_ALIASES[normalized] ?? normalized;
}
export function countyNames(value: string) {
    return [normalizedCounty(value), ...value.split(/\s+(?:AND|WITH)\s+|\s*&\s*/i).map(normalizedCounty)].filter(Boolean);
}
export function isIndependentCityFips(fips: string) {
    const stateFips = fips.slice(0, 2);
    const countyCode = Number(fips.slice(2));
    return fips === "24510" || fips === "29510" || fips === "32510" || (stateFips === "51" && countyCode >= 500);
}
const AMBIGUOUS_INDEPENDENT_CITY_FIPS = new Set(["24510", "29510", "51600", "51620", "51760", "51770"]);
export function normalizedGeometryCounty(value: string, fips: string) {
    const normalized = normalizedCounty(value);
    return isIndependentCityFips(fips) && !normalized.endsWith("CITY") ? `${normalized}CITY` : normalized;
}
export function countyDisplayName(county: {
    fips: string;
    name: string;
}) {
    if (isIndependentCityFips(county.fips))
        return /\bcity$/i.test(county.name) ? county.name : `${county.name} city`;
    if (county.fips.startsWith("22"))
        return `${county.name} Parish`;
    if (county.fips.startsWith("09"))
        return `${county.name} Planning Region`;
    if (county.fips === "11001")
        return county.name;
    return `${county.name} County`;
}
export function countyMatches(sourceName: string, geometryName: string, geometryFips?: string) {
    const target = geometryFips ? normalizedGeometryCounty(geometryName, geometryFips) : normalizedCounty(geometryName);
    const sourceNames = countyNames(sourceName);
    if (sourceNames.some((name) => name === target))
        return true;
    return Boolean(geometryFips
        && isIndependentCityFips(geometryFips)
        && !AMBIGUOUS_INDEPENDENT_CITY_FIPS.has(geometryFips)
        && sourceNames.some((name) => name === target.replace(/CITY$/, "")));
}
export function detailMatchesCounty(detail: {
    id: string;
    geographyType: string;
    counties: string[];
}, county: {
    fips: string;
    name: string;
}) {
    if (detail.geographyType === "county") {
        const exactFips = /(?:^|:)(\d{5})$/.exec(detail.id)?.[1];
        if (exactFips)
            return exactFips === county.fips;
    }
    return detail.counties.some((name) => countyMatches(name, county.name, county.fips));
}
