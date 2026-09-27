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
import ForecastsLoading from "@/app/forecasts/loading";
afterEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = "light";
});
describe("ForecastsLoading", () => {
    it("renders the local navigation before forecast data resolves", () => {
        render(<ForecastsLoading />);
        expect(screen.getByRole("heading", { name: "Your forecasts are opening." })).toBeVisible();
        const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
        expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Dashboard", "Forecasts", "Population health"]);
    });
    it("marks the surface as app and offers no theme control", () => {
        render(<ForecastsLoading />);
        expect(screen.getByRole("navigation", { name: "Workspace navigation" }).closest("[data-surface]")).toHaveAttribute("data-surface", "app");
        expect(screen.queryByRole("button", { name: /Switch to (dark|light) mode/ })).toBeNull();
    });
});
