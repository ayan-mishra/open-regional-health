import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import NotFound from "@/app/not-found";
describe("shared status routes", () => {
    it("keeps direct recovery actions on the error route", () => {
        const error = new Error("boom");
        render(<ErrorPage error={error} reset={vi.fn()}/>);
        expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
        expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
        expect(screen.getByRole("link", { name: "Open dashboard" })).toHaveAttribute("href", "/dashboard");
        expect(screen.queryAllByRole("link", { current: "page" })).toHaveLength(0);
    });
    it("keeps home and dashboard recovery links on the not-found route", () => {
        render(<NotFound />);
        expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
        expect(screen.getByRole("link", { name: "Open dashboard" })).toHaveAttribute("href", "/dashboard");
        expect(screen.queryAllByRole("link", { current: "page" })).toHaveLength(0);
    });
});
