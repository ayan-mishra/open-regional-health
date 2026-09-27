import { expect, test } from "@playwright/test";
test("dashboard opens directly without an account", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "United States health signals" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("region", { name: "United States health intelligence map" })).toBeVisible();
});
test("mobile shows the existing desktop requirement", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Open Corvid on desktop." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "United States health signals" })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("forecast and population pages open without an account", async ({ page, request }) => {
    await page.goto("/forecasts");
    await expect(page.getByRole("heading", { level: 1, name: "Monthly forecasts" })).toBeVisible();
    await page.goto("/population-health");
    await expect(page.getByRole("heading", { level: 1, name: "Population health" })).toBeVisible();
    const invalidForecast = await request.get("/api/national/forecasts?horizon=30");
    expect(invalidForecast.status()).toBe(400);
});
