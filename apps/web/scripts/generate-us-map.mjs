import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geoAlbers, geoCentroid, geoPath } from "d3-geo";
import { unzipSync } from "fflate";
import * as shapefile from "shapefile";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_URL = "https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_20m.zip";
const COUNTY_URL = "https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_20m.zip";
const INCLUDED_FIPS = new Set(["01", "04", "05", "06", "08", "09", "10", "11", "12", "13", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "44", "45", "46", "47", "48", "49", "50", "51", "53", "54", "55", "56"]);
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function download(url) {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`${url} responded with ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, hash: sha256(bytes), lastModified: response.headers.get("last-modified") };
}
function selectFile(files, suffix) {
    const entry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith(suffix));
    if (!entry)
        throw new Error(`Archive is missing ${suffix}`);
    return entry[1];
}
async function readFeatures(zipBytes) {
    const files = unzipSync(zipBytes);
    const shp = selectFile(files, ".shp");
    const dbf = selectFile(files, ".dbf");
    const source = await shapefile.open(shp.buffer.slice(shp.byteOffset, shp.byteOffset + shp.byteLength), dbf.buffer.slice(dbf.byteOffset, dbf.byteOffset + dbf.byteLength));
    const features = [];
    while (true) {
        const item = await source.read();
        if (item.done)
            break;
        features.push(item.value);
    }
    return features;
}
function featureCollection(features) { return { type: "FeatureCollection", features }; }
const [stateDownload, countyDownload] = await Promise.all([download(STATE_URL), download(COUNTY_URL)]);
const states = (await readFeatures(stateDownload.bytes)).filter((feature) => INCLUDED_FIPS.has(feature.properties.STATEFP));
const counties = (await readFeatures(countyDownload.bytes)).filter((feature) => INCLUDED_FIPS.has(feature.properties.STATEFP));
if (states.length !== 49)
    throw new Error(`Expected 49 state features, received ${states.length}`);
const nationalProjection = geoAlbers().fitExtent([[18, 18], [942, 582]], featureCollection(states));
const nationalPath = geoPath(nationalProjection);
const generatedAt = stateDownload.lastModified ?? "2026-04-15T00:00:00Z";
const statePayload = {
    viewBox: "0 0 960 600", source: STATE_URL, sourceSha256: stateDownload.hash, generatedAt,
    states: states.map((feature) => ({ code: feature.properties.STUSPS, fips: feature.properties.STATEFP, name: feature.properties.NAME, path: nationalPath(feature), centroid: nationalPath.centroid(feature), geoCentroid: geoCentroid(feature) })).sort((a, b) => a.name.localeCompare(b.name)),
};
const generatedDir = path.join(ROOT, "lib", "generated");
const countiesDir = path.join(ROOT, "public", "geometry", "counties");
await mkdir(generatedDir, { recursive: true });
await mkdir(countiesDir, { recursive: true });
await writeFile(path.join(generatedDir, "us-states.json"), `${JSON.stringify(statePayload)}\n`);
await writeFile(path.join(generatedDir, "us-county-centroids.json"), `${JSON.stringify(counties.map((feature) => ({
    fips: feature.properties.GEOID,
    stateFips: feature.properties.STATEFP,
    name: feature.properties.NAME,
    geoCentroid: geoCentroid(feature),
})).sort((a, b) => a.fips.localeCompare(b.fips)))}\n`);
for (const state of states) {
    const stateCounties = counties.filter((feature) => feature.properties.STATEFP === state.properties.STATEFP);
    const projection = geoAlbers().fitExtent([[18, 18], [742, 502]], featureCollection([state]));
    const render = geoPath(projection);
    const payload = {
        stateCode: state.properties.STUSPS, viewBox: "0 0 760 520", source: COUNTY_URL,
        sourceSha256: countyDownload.hash, generatedAt, statePath: render(state),
        counties: stateCounties.map((feature) => ({ fips: feature.properties.GEOID, name: feature.properties.NAME, path: render(feature) })).sort((a, b) => a.name.localeCompare(b.name)),
    };
    await writeFile(path.join(countiesDir, `${state.properties.STATEFP}.json`), `${JSON.stringify(payload)}\n`);
}
process.stdout.write(`Generated ${states.length} states and ${counties.length} counties from Census 2025 cartographic boundaries.\n`);
