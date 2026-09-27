import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";
const repositoryRoot = resolve(__dirname, "..");
export default defineConfig({
    testDir: ".",
    testMatch: /.*\.spec\.ts/,
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [
        ["list"],
        ["html", { outputFolder: "../apps/web/playwright-report", open: "never" }],
        ["junit", { outputFile: "../apps/web/test-results/junit.xml" }],
    ],
    outputDir: "../apps/web/test-results/artifacts",
    use: {
        baseURL,
        colorScheme: "light",
        locale: "en-US",
        screenshot: "only-on-failure",
        timezoneId: "UTC",
        trace: "on-first-retry",
        video: "retain-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],
                viewport: { width: 1440, height: 1000 },
            },
        },
    ],
    webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
        command: "pnpm --dir apps/web build && node scripts/start-web-standalone.mjs",
        cwd: repositoryRoot,
        env: { TZ: "UTC", HOSTNAME: "127.0.0.1", PORT: "3100" },
        reuseExistingServer: !process.env.CI,
        timeout: 180000,
        url: `${baseURL}/healthz`,
    },
});
