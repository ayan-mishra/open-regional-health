import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POPULATION_URL = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv";
const SVI_URL = "https://svi.cdc.gov/Documents/Data/2022/csv/states_counties/SVI_2022_US_county.csv";
const MUA_URL = "https://data.hrsa.gov/DataDownload/DD_Files/MUA_DET.csv";
function parseCsv(text, selectedHeaders) {
    const rows = [];
    let row = [];
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
            if (row.some(Boolean))
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
    const headers = (rows.shift() ?? []).map((value) => value.trim().replace(/^\uFEFF/, ""));
    const selected = selectedHeaders.map((header) => [header, headers.indexOf(header)]);
    return rows.map((values) => Object.fromEntries(selected.map(([header, index]) => [header, index < 0 ? "" : values[index]?.trim() ?? ""])));
}
async function download(url) {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`${url} returned ${response.status}`);
    return response.text();
}
const geography = await readFile(path.join(ROOT, "lib", "us-geography.ts"), "utf8");
const stateFips = new Map([...geography.matchAll(/\["([A-Z]{2})", "(\d{2})",/g)].map((match) => [match[1], match[2]]));
const population = parseCsv(await download(POPULATION_URL), ["STATE", "COUNTY", "POPESTIMATE2025"]);
const svi = parseCsv(await download(SVI_URL), ["FIPS", "RPL_THEMES", "RPL_THEME1", "RPL_THEME2", "RPL_THEME3", "RPL_THEME4"]);
const muaRows = parseCsv(await download(MUA_URL), ["MUA/P ID", "State Abbreviation", "State and County Federal Information Processing Standard Code", "County or County Equivalent Federal Information Processing Standard Code", "MUA/P Status Description", "Status Description"]);
const mua = muaRows.flatMap((row) => {
    const state = row["State Abbreviation"].toUpperCase();
    const raw = row["State and County Federal Information Processing Standard Code"] || row["County or County Equivalent Federal Information Processing Standard Code"];
    const digits = raw.replace(/\D/g, "");
    const fips = digits.length === 3 && stateFips.has(state) ? `${stateFips.get(state)}${digits}` : digits.padStart(5, "0");
    return stateFips.has(state) && /^\d{5}$/.test(fips) ? [{ state, fips, status: row["MUA/P Status Description"] || row["Status Description"], id: row["MUA/P ID"] }] : [];
});
await writeFile(path.join(ROOT, "lib", "generated", "population-health-baseline.json"), JSON.stringify({ sources: { population: POPULATION_URL, svi: SVI_URL, mua: MUA_URL }, population, svi, mua }));
console.log(`Wrote ${population.length} population rows, ${svi.length} SVI rows, and ${mua.length} MUA rows.`);
