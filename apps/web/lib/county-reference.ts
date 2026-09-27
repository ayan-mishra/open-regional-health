import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
interface CountyGeometryFile {
    stateCode: string;
    counties: {
        fips: string;
        name: string;
    }[];
}
interface CountyReference {
    counties: {
        fips: string;
        name: string;
    }[];
    nameToFips: Map<string, string>;
}
const cache = new Map<string, CountyReference>();
export async function countyReference(stateFips: string): Promise<CountyReference> {
    const hit = cache.get(stateFips);
    if (hit)
        return hit;
    const reference: CountyReference = { counties: [], nameToFips: new Map() };
    try {
        const file = path.join(process.cwd(), "public", "geometry", "counties", `${stateFips}.json`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as CountyGeometryFile;
        for (const county of parsed.counties ?? []) {
            if (typeof county.name === "string" && typeof county.fips === "string") {
                reference.counties.push({ name: county.name, fips: county.fips });
                reference.nameToFips.set(county.name.toLowerCase(), county.fips);
            }
        }
    }
    catch {
    }
    cache.set(stateFips, reference);
    return reference;
}
export async function countyNameToFips(stateFips: string): Promise<Map<string, string>> {
    return (await countyReference(stateFips)).nameToFips;
}
