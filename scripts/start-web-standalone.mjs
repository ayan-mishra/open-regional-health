import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const repositoryRoot = resolve(import.meta.dirname, "..");
const appRoot = resolve(repositoryRoot, "apps/web");
const standaloneRoot = resolve(appRoot, ".next/standalone");
const standaloneAppRoot = resolve(standaloneRoot, "apps/web");
const serverPath = resolve(standaloneAppRoot, "server.js");
if (!existsSync(serverPath)) {
    throw new Error(`Standalone Next server was not found at ${serverPath}`);
}
cpSync(resolve(appRoot, ".next/static"), resolve(standaloneAppRoot, ".next/static"), { recursive: true, force: true });
cpSync(resolve(appRoot, "public"), resolve(standaloneAppRoot, "public"), { recursive: true, force: true });
const child = spawn(process.execPath, [serverPath], {
    cwd: standaloneAppRoot,
    env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        CORVID_COUNTY_STORE_DIR: process.env.CORVID_COUNTY_STORE_DIR ?? resolve(appRoot, "county-store"),
        CORVID_FORECAST_STORE_DIR: process.env.CORVID_FORECAST_STORE_DIR ?? resolve(appRoot, "forecast-store"),
        CORVID_HISTORY_STORE_DIR: process.env.CORVID_HISTORY_STORE_DIR ?? resolve(appRoot, "history-store"),
        CORVID_POPULATION_STORE_DIR: process.env.CORVID_POPULATION_STORE_DIR ?? resolve(appRoot, "population-store"),
        HOSTNAME: "127.0.0.1",
        PORT: process.env.PORT ?? "3000",
    },
    stdio: "inherit",
});
const forwardSignal = (signal) => child.kill(signal);
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
