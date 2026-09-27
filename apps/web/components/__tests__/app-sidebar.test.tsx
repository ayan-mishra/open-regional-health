import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "@/components/app-sidebar";
afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });
describe("AppSidebar", () => {
    it("shows only the public workspace destinations", () => {
        render(<AppSidebar current="dashboard"/>);
        const navigation = screen.getByRole("navigation", { name: "Workspace navigation" });
        expect(navigation.querySelectorAll("a")).toHaveLength(3);
        expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
        expect(screen.getByRole("link", { name: "Forecasts" })).toHaveAttribute("href", "/forecasts");
        expect(screen.getByRole("link", { name: "Population health" })).toHaveAttribute("href", "/population-health");
        expect(screen.queryByRole("navigation", { name: "Account" })).not.toBeInTheDocument();
        expect(screen.queryByText(/privacy choices|ask ai|reports/i)).not.toBeInTheDocument();
    });
    it("still toggles when localStorage is blocked", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
        render(<AppSidebar />);
        fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
        expect(screen.getByRole("button", { name: "Expand navigation" })).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
        expect(screen.getByRole("button", { name: "Collapse navigation" })).toHaveAttribute("aria-expanded", "true");
    });
});
