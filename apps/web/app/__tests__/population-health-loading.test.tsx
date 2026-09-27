import { render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({
    default: ({ prefetch, ...props }: ComponentProps<"a"> & {
        prefetch?: boolean;
    }) => {
        void prefetch;
        return <a {...props}/>;
    },
}));
import PopulationHealthLoading from "@/app/population-health/loading";
afterEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = "light";
});
describe("PopulationHealthLoading", () => {
    it("keeps workspace navigation available while the route opens, with no theme control", () => {
        render(<PopulationHealthLoading />);
        expect(screen.getByRole("heading", { name: "Opening population health." })).toBeVisible();
        const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
        expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Dashboard", "Forecasts", "Population health"]);
        expect(screen.queryByRole("button", { name: /Switch to (dark|light) mode/ })).toBeNull();
    });
});
