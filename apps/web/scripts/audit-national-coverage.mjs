import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = process.env.CORVID_FEED_URL ?? "http://localhost:3000/api/national/outlook?signal=covid-ed";
const STATE_TOTAL = 49;
const REMOVAL_MISSING_RATE = 0.90;
function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}
function positionalArgument() {
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--source" || args[index] === "--format") {
            index += 1;
            continue;
        }
        if (!args[index].startsWith("--"))
            return args[index];
    }
    return null;
}
const source = argument("--source") ?? positionalArgument() ?? DEFAULT_SOURCE;
const format = argument("--format") ?? "markdown";
const failOnThreshold = process.argv.includes("--fail-on-threshold");
async function loadFeed(value) {
    if (/^https?:\/\//i.test(value)) {
        const response = await fetch(value, { headers: { Accept: "application/json" } });
        if (!response.ok)
            throw new Error(`${value} responded with ${response.status}`);
        const body = await response.json();
        if (body?.outlooks)
            return body;
        if (!body?.signal || !Array.isArray(body.catalog))
            return body;
        const outlooks = {};
        for (const signal of body.catalog) {
            const url = new URL(value);
            url.search = "";
            url.searchParams.set("signal", signal.id);
            const outlookResponse = await fetch(url, { headers: { Accept: "application/json" } });
            if (!outlookResponse.ok)
                throw new Error(`${url} responded with ${outlookResponse.status}`);
            outlooks[signal.id] = await outlookResponse.json();
        }
        const errors = Object.values(outlooks).flatMap((outlook) => outlook.errors ?? []);
        return { catalog: body.catalog, retrievedAt: body.retrievedAt, refreshHours: 12, status: errors.length ? "partial" : "current", errors, selectedState: null, period: body.period, outlooks };
    }
    return JSON.parse(await readFile(path.resolve(value), "utf8"));
}
function normalizedCounty(value) {
    const aliases = { DISTRICT: "DISTRICTOFCOLUMBIA", THEDISTRICT: "DISTRICTOFCOLUMBIA", EBATONROUGE: "EASTBATONROUGE", JEFFRSONDAVIS: "JEFFERSONDAVIS", LAKEOFWOODS: "LAKEOFTHEWOODS", YELLOWMEDCINE: "YELLOWMEDICINE", SCOTTBLUFF: "SCOTTSBLUFF", BEDFORDCITY: "BEDFORD", DOAANA: "DONAANA", DOAAANA: "DONAANA" };
    const normalized = String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\b(SAINT|SAINTE|STE|ST)\b/g, "SAINT").replace(/\b(COUNTY|CNTY|PARISH|BOROUGH|CENSUS AREA|CTY)\b/g, "").replace(/[^A-Z0-9]/g, "");
    return aliases[normalized] ?? normalized;
}
function countyNames(value) {
    return [normalizedCounty(value), ...String(value).split(/\s+(?:AND|WITH)\s+|\s*&\s*/i).map(normalizedCounty)].filter(Boolean);
}
function normalizedGeometryCounty(value, fips) {
    const stateFips = fips.slice(0, 2);
    const countyCode = Number(fips.slice(2));
    const independentCity = fips === "24510" || fips === "29510" || fips === "32510" || (stateFips === "51" && countyCode >= 500);
    const normalized = normalizedCounty(value);
    return independentCity && !normalized.endsWith("CITY") ? `${normalized}CITY` : normalized;
}
function independentCityBaseAlias(value, fips) {
    const ambiguous = new Set(["24510", "29510", "51600", "51620", "51760", "51770"]);
    const target = normalizedGeometryCounty(value, fips);
    return target.endsWith("CITY") && !ambiguous.has(fips) ? target.replace(/CITY$/, "") : null;
}
function percent(count, total) {
    return `${(count / total * 100).toFixed(1)}%`;
}
const [feed, countyCentroids, geographySource] = await Promise.all([
    loadFeed(source),
    readFile(path.join(WEB_ROOT, "lib", "generated", "us-county-centroids.json"), "utf8").then(JSON.parse),
    readFile(path.join(WEB_ROOT, "lib", "us-geography.ts"), "utf8"),
]);
if (!feed?.outlooks || typeof feed.outlooks !== "object")
    throw new Error("Input is not a Corvid national feed response");
const jurisdictions = [...geographySource.matchAll(/\["([A-Z]{2})", "(\d{2})", "([^"]+)"\]/g)]
    .map((match) => ({ code: match[1], fips: match[2], name: match[3] }));
if (jurisdictions.length !== STATE_TOTAL)
    throw new Error(`Expected ${STATE_TOTAL} supported jurisdictions, found ${jurisdictions.length}`);
const codeByFips = new Map(jurisdictions.map((state) => [state.fips, state.code]));
const countyIndex = new Map();
for (const county of countyCentroids) {
    const stateCode = codeByFips.get(county.stateFips);
    if (!stateCode)
        continue;
    const key = `${stateCode}:${normalizedGeometryCounty(county.name, county.fips)}`;
    const matches = countyIndex.get(key) ?? [];
    matches.push(county.fips);
    countyIndex.set(key, matches);
    const baseAlias = independentCityBaseAlias(county.name, county.fips);
    if (baseAlias) {
        const aliasKey = `${stateCode}:${baseAlias}`;
        const aliasMatches = countyIndex.get(aliasKey) ?? [];
        aliasMatches.push(county.fips);
        countyIndex.set(aliasKey, aliasMatches);
    }
}
const countyTotal = countyCentroids.filter((county) => codeByFips.has(county.stateFips)).length;
const supportedCountyFips = new Set(countyCentroids.filter((county) => codeByFips.has(county.stateFips)).map((county) => county.fips));
function countyCoverage(details, predicate) {
    const matched = new Set();
    const unmatched = new Set();
    for (const detail of details.filter(predicate)) {
        if (!detail.stateCode || !Array.isArray(detail.counties))
            continue;
        const exactFips = detail.geographyType === "county" ? /(?:^|:)(\d{5})$/.exec(detail.id)?.[1] : null;
        if (exactFips && supportedCountyFips.has(exactFips)) {
            matched.add(exactFips);
            continue;
        }
        for (const publisherName of detail.counties) {
            let found = false;
            for (const name of countyNames(publisherName)) {
                const fipsCodes = countyIndex.get(`${detail.stateCode}:${name}`) ?? [];
                for (const fips of fipsCodes) {
                    matched.add(fips);
                    found = true;
                }
            }
            if (!found)
                unmatched.add(`${detail.stateCode}:${publisherName}`);
        }
    }
    return { matched, unmatched };
}
const rows = Object.entries(feed.outlooks).map(([id, outlook]) => {
    const states = Array.isArray(outlook.states) ? outlook.states : [];
    const details = Array.isArray(outlook.details) ? outlook.details : [];
    const statePublished = states.filter((reading) => Number.isFinite(reading.value)).length;
    const stateValid = states.filter((reading) => Number.isFinite(reading.value) && (reading.publisherEligible ?? reading.comparisonEligible)).length;
    const stateComparable = states.filter((reading) => Number.isFinite(reading.value) && reading.comparisonEligible).length;
    const stateStale = states.filter((reading) => Number.isFinite(reading.value) && reading.isStale).length;
    const countyPublished = countyCoverage(details, (reading) => Number.isFinite(reading.value));
    const countyValid = countyCoverage(details, (reading) => Number.isFinite(reading.value) && (reading.publisherEligible ?? reading.comparisonEligible));
    const countyComparable = countyCoverage(details, (reading) => Number.isFinite(reading.value) && reading.comparisonEligible);
    const countyStale = countyCoverage(details, (reading) => Number.isFinite(reading.value) && reading.isStale);
    const stateMissingRate = 1 - stateValid / STATE_TOTAL;
    const countyMissingRate = 1 - countyValid.matched.size / countyTotal;
    return {
        id,
        label: outlook.signal?.label ?? id,
        statePublished,
        stateValid,
        stateComparable,
        stateStale,
        countyPublished: countyPublished.matched.size,
        countyValid: countyValid.matched.size,
        countyComparable: countyComparable.matched.size,
        countyStale: countyStale.matched.size,
        unmatchedCountyNames: [...countyPublished.unmatched].sort(),
        errors: Array.isArray(outlook.errors) ? outlook.errors.length : 0,
        remove: stateMissingRate >= REMOVAL_MISSING_RATE && countyMissingRate >= REMOVAL_MISSING_RATE,
    };
});
const result = {
    source,
    retrievedAt: feed.retrievedAt,
    feedStatus: feed.status,
    feedErrors: feed.errors ?? [],
    denominators: { states: STATE_TOTAL, counties: countyTotal },
    threshold: { missingRate: REMOVAL_MISSING_RATE, basis: "source-valid observations", rule: "remove only when both state and county missingness are at least 90%" },
    signals: rows,
};
if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
else {
    const lines = [
        `# Corvid national coverage audit`,
        "",
        `Feed retrieved: ${feed.retrievedAt ?? "unknown"}  `,
        `Feed status: ${feed.status ?? "unknown"}  `,
        `Denominators: ${STATE_TOTAL} jurisdictions and ${countyTotal.toLocaleString()} counties/county-equivalents  `,
        `Removal rule: source-valid observations are at least 90% missing at both state and county levels.`,
        "",
        "| Signal | Published states | Source-valid states | Comparable states | Published counties | Source-valid counties | Comparable counties | Stale states/counties | Source errors | Rule |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ...rows.map((row) => `| ${row.label} (\`${row.id}\`) | ${row.statePublished}/${STATE_TOTAL} (${percent(row.statePublished, STATE_TOTAL)}) | ${row.stateValid}/${STATE_TOTAL} | ${row.stateComparable}/${STATE_TOTAL} | ${row.countyPublished}/${countyTotal} (${percent(row.countyPublished, countyTotal)}) | ${row.countyValid}/${countyTotal} | ${row.countyComparable}/${countyTotal} | ${row.stateStale}/${row.countyStale} | ${row.errors} | ${row.remove ? "REMOVE" : "keep"} |`),
        "",
    ];
    const unmatched = rows.flatMap((row) => row.unmatchedCountyNames.map((name) => `${row.id}: ${name}`));
    if (unmatched.length)
        lines.push(`Unmatched publisher county labels (${unmatched.length}): ${unmatched.slice(0, 30).join(", ")}${unmatched.length > 30 ? ", …" : ""}`, "");
    process.stdout.write(`${lines.join("\n")}\n`);
}
if (failOnThreshold && rows.some((row) => row.remove))
    process.exitCode = 2;
