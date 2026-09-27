import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONCURRENCY = 2;
function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
}
const base = argument("--base", "http://localhost:3000").replace(/\/$/, "");
const outDir = argument("--out", path.join(os.tmpdir(), "corvid-audit-feed"));
const log = (message) => console.log(new Date().toISOString().slice(11, 19), message);
const geographySource = await readFile(path.join(WEB_ROOT, "lib", "us-geography.ts"), "utf8");
const included = [...geographySource.matchAll(/\["([A-Z]{2})", "(\d{2})", "([^"]+)"\]/g)].map((match) => match[1]);
if (included.length !== 49)
    throw new Error(`Expected 49 included jurisdictions, found ${included.length}`);
const seedResponse = await fetch(`${base}/api/national/outlook?signal=covid-ed`, { headers: { Accept: "application/json" } });
if (!seedResponse.ok)
    throw new Error(`Seed outlook responded ${seedResponse.status}`);
const seed = await seedResponse.json();
if (!Array.isArray(seed.catalog))
    throw new Error("Seed outlook does not include the signal catalog");
const signalIds = seed.catalog.map((signal) => signal.id);
const baseFeed = { catalog: seed.catalog, retrievedAt: seed.retrievedAt, refreshHours: 12, status: "current", errors: [], selectedState: null, period: null, outlooks: {} };
for (const signalId of signalIds) {
    const response = await fetch(`${base}/api/national/outlook?signal=${signalId}`, { headers: { Accept: "application/json" } });
    if (!response.ok)
        throw new Error(`Base outlook ${signalId} responded ${response.status}`);
    baseFeed.outlooks[signalId] = await response.json();
}
const cache = new Map();
const failures = [];
async function fetchDetails(signalId, stateCode, attempt = 0) {
    const key = `${signalId}:${stateCode}`;
    if (cache.has(key))
        return cache.get(key);
    const response = await fetch(`${base}/api/national/outlook?signal=${signalId}&state=${stateCode}`, { headers: { Accept: "application/json" } });
    if (response.status === 503) {
        cache.set(key, []);
        return [];
    }
    if (response.status === 429) {
        if (attempt >= 4)
            throw new Error("429 after four backoff retries");
        await new Promise((resolve) => setTimeout(resolve, 65000 + Math.random() * 5000));
        return fetchDetails(signalId, stateCode, attempt + 1);
    }
    if (!response.ok)
        throw new Error(`${signalId}:${stateCode} responded ${response.status}`);
    const body = await response.json();
    const details = Array.isArray(body.details) ? body.details : [];
    cache.set(key, details);
    return details;
}
await mkdir(outDir, { recursive: true });
const queue = [];
for (const signalId of signalIds)
    for (const stateCode of included)
        queue.push([signalId, stateCode]);
let done = 0;
const startedAt = Date.now();
async function worker() {
    while (queue.length > 0) {
        const [signalId, stateCode] = queue.shift();
        try {
            const details = await fetchDetails(signalId, stateCode);
            const dir = path.join(outDir, signalId);
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, `${stateCode}.json`), JSON.stringify(details));
            done += 1;
            if (done % 100 === 0)
                log(`${done}/${queue.length + done} done`);
        }
        catch (error) {
            failures.push(`${signalId}:${stateCode} ${String(error.message ?? error).slice(0, 80)}`);
            log(`FAIL ${signalId}:${stateCode} ${String(error.message ?? error).slice(0, 60)}`);
        }
    }
}
log(`fetching ${queue.length} per-state outlooks from ${base} (concurrency ${CONCURRENCY})`);
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
log(`fetch phase done in ${Math.round((Date.now() - startedAt) / 1000)}s, failures=${failures.length}`);
const merged = { ...baseFeed, outlooks: {} };
let totalDetails = 0;
for (const signalId of signalIds) {
    const outlook = { ...baseFeed.outlooks[signalId] };
    const byId = new Map();
    for (const stateCode of included) {
        const file = path.join(outDir, signalId, `${stateCode}.json`);
        let raw;
        try {
            raw = await readFile(file, "utf8");
        }
        catch {
            continue;
        }
        for (const detail of JSON.parse(raw)) {
            const id = detail.id ?? `${detail.stateCode}:${detail.name}`;
            if (!byId.has(id))
                byId.set(id, detail);
        }
    }
    outlook.details = [...byId.values()];
    totalDetails += outlook.details.length;
    merged.outlooks[signalId] = outlook;
}
await writeFile(path.join(outDir, "merged-feed.json"), JSON.stringify(merged));
await writeFile(path.join(outDir, "failures.txt"), failures.join("\n"));
log(`merged feed written to ${path.join(outDir, "merged-feed.json")} (${totalDetails} detail readings, ${failures.length} failures)`);
