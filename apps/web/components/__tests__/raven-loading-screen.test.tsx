import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RavenLoadingScreen } from "@/components/raven-loading-screen";
describe("RavenLoadingScreen", () => {
    it("announces what is loading, with no synthetic ETA", () => {
        render(<RavenLoadingScreen context="dashboard" title="Gathering the field notes" detail="Validating public observations."/>);
        expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
        expect(screen.getByRole("heading", { name: "Gathering the field notes" })).toBeVisible();
        expect(screen.getByText("Loading dashboard")).toBeVisible();
        expect(screen.getByText("Validating public observations.")).toBeVisible();
        expect(screen.queryByText("01:45")).not.toBeInTheDocument();
        expect(screen.queryByText(/Estimated arrival/i)).not.toBeInTheDocument();
    });
    it("carries no decorative branding on a workspace surface", () => {
        const { container } = render(<RavenLoadingScreen context="forecast" title="Forecasts are opening" detail="Loading the prepared monthly forecast."/>);
        expect(screen.queryByRole("img")).toBeNull();
        expect(container.textContent).not.toMatch(/FIELD STATION/i);
    });
});
