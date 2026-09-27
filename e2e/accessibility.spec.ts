import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
test("dashboard has no automated WCAG 2.1 A/AA violations", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "United States health signals" })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
});
