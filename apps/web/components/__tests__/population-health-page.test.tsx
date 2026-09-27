import { act, fireEvent, render, screen } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PopulationHealthPage } from "@/components/population-health-page";
import type { PopulationHealthResponse } from "@/lib/population-health-contracts";
const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
const context: PopulationHealthResponse = {
    status: "current",
    period: null,
    selectedState: "MA",
    selectedCountyFips: null,
    geographyLabel: "Massachusetts",
    summary: "No high-pressure flags in the available comparison set.",
    retrievedAt: "2026-08-25T12:00:00.000Z",
    sections: [],
    signals: [],
    insights: [],
    coverage: { available: 0, partial: 0, unavailable: 0, total: 0, label: "0 of 0 measures are current" },
    sources: [],
    errors: [],
};
afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.documentElement.dataset.theme = "light";
});
describe("PopulationHealthPage", () => {
    it("opens as a region picker without generating a default report", () => {
        render(<PopulationHealthPage context={null} counties={[]}/>);
        expect(screen.getByRole("heading", { name: "Choose a region to build its population health brief." })).toBeVisible();
        expect(screen.getByRole("button", { name: "Open state brief" })).toBeEnabled();
        expect(screen.queryByText("Brief loaded")).not.toBeInTheDocument();
    });
    it("cuts to the loading screen while the very first geography loads", () => {
        render(<PopulationHealthPage context={null} counties={[]}/>);
        fireEvent.change(screen.getByLabelText("State"), { target: { value: "CA" } });
        fireEvent.click(screen.getByRole("button", { name: "Open state brief" }));
        expect(mocks.push).toHaveBeenCalledWith("/population-health?state=CA");
        expect(screen.getByRole("heading", { name: "Reading California" })).toBeVisible();
        expect(screen.getByText(/Loading the current evidence window and checking the available sources/i)).toBeVisible();
        expect(screen.queryByRole("button", { name: /Switch to (dark|light) mode/ })).toBeNull();
    });
    it("keeps the current brief visible and shows an inline update banner while a new geography loads, instead of resetting to a blank loading screen", () => {
        render(<PopulationHealthPage context={context} counties={[]}/>);
        fireEvent.change(screen.getByLabelText("State"), { target: { value: "CA" } });
        fireEvent.click(screen.getByRole("button", { name: "Change region" }));
        expect(mocks.push).toHaveBeenCalledWith("/population-health?state=CA");
        expect(screen.getByText("No high-pressure flags in the available comparison set.")).toBeVisible();
        expect(screen.queryByRole("heading", { name: "Reading California" })).not.toBeInTheDocument();
        expect(screen.getByText(/Updating California/i)).toBeVisible();
        expect(screen.getByLabelText("State")).toBeDisabled();
    });
    it("shows the selected county name instead of its FIPS", () => {
        render(<PopulationHealthPage context={{ ...context, selectedCountyFips: "25025", geographyLabel: "Massachusetts · county 25025" }} counties={[{ name: "Suffolk County", fips: "25025" }]}/>);
        expect(screen.getByText("Suffolk County, Massachusetts", { selector: "strong" })).toBeVisible();
        expect(screen.getByText(/Suffolk County, Massachusetts · Current evidence/)).toBeVisible();
        expect(screen.queryByText(/county 25025/i)).not.toBeInTheDocument();
    });
    it("keeps controls usable when Back returns to an earlier brief after navigation", () => {
        const view = render(<PopulationHealthPage context={context} counties={[]}/>);
        fireEvent.change(screen.getByLabelText("State"), { target: { value: "CA" } });
        fireEvent.click(screen.getByRole("button", { name: "Change region" }));
        view.rerender(<PopulationHealthPage context={{ ...context, selectedState: "CA" }} counties={[]}/>);
        expect(screen.getByLabelText("State")).toBeEnabled();
        view.rerender(<PopulationHealthPage context={context} counties={[]}/>);
        expect(screen.getByLabelText("State")).toBeEnabled();
        expect(screen.queryByText(/Updating California/i)).not.toBeInTheDocument();
    });
    it("hydrates the retrieved timestamp consistently across server and browser time zones", async () => {
        const originalTimeZone = process.env.TZ;
        process.env.TZ = "UTC";
        const markup = renderToString(<PopulationHealthPage context={context} counties={[]}/>);
        process.env.TZ = "America/Los_Angeles";
        const container = document.createElement("div");
        container.innerHTML = markup;
        document.body.append(container);
        const recoverableErrors: unknown[] = [];
        let root: Root | null = null;
        try {
            await act(async () => {
                root = hydrateRoot(container, <PopulationHealthPage context={context} counties={[]}/>, {
                    onRecoverableError: (error) => recoverableErrors.push(error),
                });
                await Promise.resolve();
            });
        }
        finally {
            if (root)
                await act(async () => root?.unmount());
            container.remove();
            if (originalTimeZone === undefined)
                delete process.env.TZ;
            else
                process.env.TZ = originalTimeZone;
        }
        expect(recoverableErrors).toEqual([]);
    });
    it("renders an unavailable date when a publisher date is malformed", () => {
        render(<PopulationHealthPage context={{
                ...context,
                signals: [{ id: "heatrisk", label: "HeatRisk", unit: "category", value: null, displayValue: "Unavailable", geographyType: "state", stateCode: "MA", source: "NOAA", sourceUrl: "https://example.com", observedThrough: "Current seven-day outlook", status: "unavailable", evidence: "official", note: "Historical outlook unavailable." }],
            }} counties={[]}/>);
        expect(screen.getByText("Valid through").nextElementSibling).toHaveTextContent("Unavailable");
    });
    it("does not normalize an impossible publisher date into a different day", () => {
        render(<PopulationHealthPage context={{
                ...context,
                signals: [{ id: "air-quality", label: "Air quality", unit: "AQI", value: 42, displayValue: "42", geographyType: "state", stateCode: "MA", source: "EPA", sourceUrl: "https://example.com", observedThrough: "2026-02-31", status: "current", evidence: "observed", note: "Publisher date is invalid." }],
            }} counties={[]}/>);
        expect(screen.getByText("Observed through").nextElementSibling).toHaveTextContent("Unavailable");
        expect(screen.queryByText("Mar 3, 2026")).not.toBeInTheDocument();
    });
    it("omits an empty confidence range", () => {
        render(<PopulationHealthPage context={{
                ...context,
                sections: [{ id: "prevention", title: "Prevention", description: "Test", measures: [{ id: "flu-vaccination", label: "Influenza vaccination coverage", category: "prevention", geographyType: "state", stateCode: "MA", value: 42, displayValue: "42.0%", unit: "%", vintage: "2024-25", period: "2024-25", cadence: "Seasonal", estimateType: "observed", status: "stale", source: "CDC VaxView", sourceUrl: "https://example.com", note: "Latest estimate.", confidenceLow: null, confidenceHigh: null }] }],
            }} counties={[]}/>);
        expect(screen.queryByText("Range")).not.toBeInTheDocument();
    });
    it("uses the correct ordinal suffix for pressure percentiles", () => {
        render(<PopulationHealthPage context={{
                ...context,
                signals: [{ id: "covid-ed", label: "COVID-19 ED visits", unit: "%", value: 2, displayValue: "2.0%", geographyType: "state", stateCode: "MA", source: "CDC", sourceUrl: "https://example.com", observedThrough: "2026-08-20", status: "current", evidence: "observed", note: "Comparable observation.", pressurePercentile: 21 }],
            }} counties={[]}/>);
        expect(screen.getByText(/21st state pressure percentile/)).toBeVisible();
        expect(screen.queryByText(/21th state pressure percentile/)).not.toBeInTheDocument();
    });
    it("does not repeat units already included in a formatted measure value", () => {
        render(<PopulationHealthPage context={{
                ...context,
                sections: [{ id: "baseline", title: "Baseline", description: "Test", measures: [
                            { id: "coverage", label: "Vaccination coverage", category: "baseline", geographyType: "state", stateCode: "MA", value: 42, displayValue: "42.0%", unit: "%", vintage: "2026", period: "2026", cadence: "Annual", estimateType: "observed", status: "current", source: "Test", sourceUrl: "https://example.com", note: "Test." },
                            { id: "vulnerability", label: "Vulnerability rank", category: "baseline", geographyType: "state", stateCode: "MA", value: 81, displayValue: "81st percentile", unit: "percentile", vintage: "2026", period: "2026", cadence: "Annual", estimateType: "ranked", status: "current", source: "Test", sourceUrl: "https://example.com", note: "Test." },
                        ] }],
            }} counties={[]}/>);
        expect(screen.getByRole("heading", { name: "Vaccination coverage" }).previousElementSibling).toHaveTextContent(/^42\.0%$/);
        expect(screen.getByRole("heading", { name: "Vulnerability rank" }).previousElementSibling).toHaveTextContent(/^81st percentile$/);
    });
});
