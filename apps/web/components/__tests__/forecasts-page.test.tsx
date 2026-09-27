import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForecastsPage } from "@/components/forecasts-page";
import type { NationalForecastResponse, NationalForecastState } from "@/lib/national-contracts";
import { clearSiteSnapshotCache } from "@/lib/site-snapshot";
import { SIGNAL_CATALOG, type SignalId } from "@/lib/signal-catalog";
import { US_JURISDICTIONS, type IncludedStateCode } from "@/lib/us-geography";
type ForecastState = NationalForecastState;
const stateReading = (code: IncludedStateCode, name: string, observed: number | null, forecast: number | null, target = "2026-09-01"): ForecastState => ({
    code, name, value: observed ?? null, displayValue: observed === null ? "Unavailable" : `${observed.toFixed(2)} per 100k`,
    observedThrough: "2026-07-25", comparisonEligible: observed !== null,
    estimate: forecast === null ? null : { horizonDays: 28, targetDate: target, value: forecast, lower: forecast - .05, upper: forecast + .05, mae: .03, intervalCoverage: .78, skillVsPersistence: 22, evidence: "supported" },
    latestObserved: observed,
    note: "Statewide observation from public reporting.",
});
const forecastFixture = (signalId: SignalId, horizon: 7 | 14 | 28 = 28): NationalForecastResponse => ({
    signalId,
    signal: SIGNAL_CATALOG.find((signal) => signal.id === signalId)!,
    catalog: SIGNAL_CATALOG,
    horizon,
    period: null,
    retrievedAt: "2026-07-30T12:00:00Z",
    status: "current",
    states: US_JURISDICTIONS.map((jurisdiction) => stateReading(jurisdiction.code, jurisdiction.name, .2, .27)),
    selectedState: null,
    selectedStateName: "United States",
    evidence: {
        kind: "modeled",
        model: "Corvid seasonal ensemble",
        observations: [{ date: "2026-07-25", value: .2 }],
        estimates: [{ horizonDays: 28, targetDate: "2026-09-01", value: .27, lower: .22, upper: .32, mae: .03, intervalCoverage: .78, skillVsPersistence: 22, evidence: "supported" }],
        evidence: "supported",
    },
    details: [],
    errors: [],
});
afterEach(() => { window.history.replaceState(null, "", "/"); clearSiteSnapshotCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("ForecastsPage (monthly state-level, supported only)", () => {
    it("renders the authenticated product navigation without a client session round trip", () => {
        vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
        render(<ForecastsPage />);
        const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
        expect(within(nav).getByRole("link", { name: "Dashboard" })).toBeVisible();
        expect(within(nav).getByRole("link", { name: "Forecasts" })).toHaveAttribute("aria-current", "page");
    });
    it("opens immediately with an honest loading state while the forecast request runs", async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        vi.stubGlobal("fetch", vi.fn(async () => {
            await pending;
            return new Response(JSON.stringify(forecastFixture("covid-ed")));
        }));
        render(<ForecastsPage />);
        expect(screen.getByText("Opening forecasts")).toBeVisible();
        expect(screen.getByRole("status")).toHaveTextContent("Forecasts are opening");
        expect(screen.queryByText("Forecasts are temporarily unavailable")).not.toBeInTheDocument();
        release();
        expect(await screen.findByRole("heading", { name: /COVID-19 ED activity/i })).toBeVisible();
    });
    it("shows validated historical modeling progress without calling every unit a state", async () => {
        const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => String(input).includes("/progress")
            ? Promise.resolve(new Response(JSON.stringify({ completed: 2, total: 4 })))
            : new Promise(() => undefined));
        vi.stubGlobal("fetch", fetchMock);
        render(<ForecastsPage initialSignal="covid-ed" initialPeriod="2026-07"/>);
        expect(await screen.findByText(/2 of 4 series complete/)).toBeVisible();
        await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/progress"))).toBe(true));
    });
    it("primes the shared cache from the selected server forecast without a client request", async () => {
        const fixture = forecastFixture("covid-ed");
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        render(<ForecastsPage initialForecasts={{ "covid-ed": fixture }} initialSignal="covid-ed" initialState={null} initialPeriod=""/>);
        expect(await screen.findByRole("heading", { name: /COVID-19 ED activity/i })).toBeVisible();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("shows only the modeled signals, with no planning or official options", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(forecastFixture("covid-ed")))));
        render(<ForecastsPage />);
        const picker = await screen.findByLabelText("Forecast signal");
        const options = Array.from(picker.querySelectorAll("option")).map((option) => option.textContent);
        const modeledCount = SIGNAL_CATALOG.filter((signal) => signal.defaultEvidence === "modeled").length;
        expect(options).toHaveLength(modeledCount);
        expect(options).not.toContain("Lyme cases");
        expect(options).not.toContain("B. miyamotoi");
        expect(options).not.toContain("Measles detections");
        expect(options).not.toContain("Heat risk");
        expect(options).not.toContain("Air quality");
        expect(screen.queryByText("Planning context")).not.toBeInTheDocument();
    });
    it("has no horizon or weekly controls: the horizon is fixed to the monthly 28-day period", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(forecastFixture("covid-ed"))));
        vi.stubGlobal("fetch", fetchMock);
        render(<ForecastsPage />);
        await screen.findByLabelText("Forecast signal");
        expect(screen.queryByRole("button", { name: "7 days" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "14 days" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "28 days" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "4 weeks" })).not.toBeInTheDocument();
        const firstCall = fetchMock.mock.calls[0];
        expect(String(firstCall ? (firstCall as unknown[])[0] : "")).toContain("horizon=28");
    });
    it("loads state forecast detail and keeps the selection in the URL", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const selectedState = new URL(String(input), "http://localhost").searchParams.get("state");
            return new Response(JSON.stringify({ ...forecastFixture("covid-ed"), selectedState }));
        });
        vi.stubGlobal("fetch", fetchMock);
        render(<ForecastsPage />);
        const picker = await screen.findByLabelText("Forecast state");
        fireEvent.change(picker, { target: { value: "MA" } });
        const readout = screen.getByRole("complementary");
        expect(await within(readout).findByText("Massachusetts")).toBeVisible();
        fireEvent.change(screen.getByLabelText("Forecast state"), { target: { value: "CA" } });
        expect(await within(readout).findByText("California")).toBeVisible();
        const forecastRequests = fetchMock.mock.calls.filter((call) => String((call as unknown[])[0] ?? "").includes("/api/national/forecasts"));
        expect(forecastRequests.filter((call) => String((call as unknown[])[0] ?? "").includes("signal=covid-ed"))).toHaveLength(3);
        expect(window.location.search).toContain("state=CA");
    });
    it("loads local wastewater forecasts without calling them statewide estimates", async () => {
        const fixture = forecastFixture("sars-cov-2-wval");
        fixture.states = fixture.states.map((state) => ({ ...state, value: null, estimate: null, latestObserved: null, comparisonEligible: false }));
        const estimate = { horizonDays: 28 as const, targetDate: "2026-09-01", value: 4.2, lower: 3, upper: 5, mae: .3, intervalCoverage: .8, skillVsPersistence: 20, evidence: "supported" as const };
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            const selectedState = new URL(String(input), "http://localhost").searchParams.get("state");
            return new Response(JSON.stringify({ ...fixture, selectedState, details: selectedState ? [{ id: "boston-site", name: "Boston reporting site", geographyType: "site", stateCode: "MA", value: 4.2, displayValue: "4.2", observedThrough: "2026-07-25", comparisonEligible: true, note: "Site catchment, not a county or state estimate.", estimate, observations: [{ date: "2026-07-25", value: 3.5 }], estimates: [estimate] }] : [] }));
        }));
        render(<ForecastsPage initialSignal="sars-cov-2-wval" initialState="MA"/>);
        const picker = await screen.findByLabelText("Local forecast");
        fireEvent.change(picker, { target: { value: "boston-site" } });
        const readout = screen.getByRole("complementary");
        expect(within(readout).getByRole("heading", { name: "Boston reporting site" })).toBeVisible();
        expect(within(readout).getByText("4.20")).toBeVisible();
        expect(within(readout).getByText(/Site catchment/)).toBeVisible();
        fireEvent.change(screen.getByLabelText("Forecast signal"), { target: { value: "covid-ed" } });
        expect(window.location.search).toContain("state=MA");
    });
    it("renders historical months without trying to parse a month as a full date", async () => {
        const fixture = forecastFixture("covid-ed");
        fixture.period = "2026-07";
        fixture.selectedState = "MA";
        fixture.states = fixture.states.map((state) => ({ ...state, estimate: null }));
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture))));
        render(<ForecastsPage initialSignal="covid-ed" initialState="MA" initialPeriod="2026-07"/>);
        const readout = await screen.findByRole("complementary");
        expect(within(readout).getByText("July 2026")).toBeVisible();
        expect(within(readout).getAllByText("0.20%")[0]).toBeVisible();
    });
    it("reuses the same cached forecast across signal changes back to a prior signal", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(forecastFixture(String(input).includes("signal=influenza-ed") ? "influenza-ed" : "covid-ed"))));
        vi.stubGlobal("fetch", fetchMock);
        render(<ForecastsPage />);
        const signalPicker = await screen.findByLabelText("Forecast signal");
        fireEvent.change(signalPicker, { target: { value: "influenza-ed" } });
        await screen.findByRole("heading", { name: /Influenza ED activity/i });
        fireEvent.change(screen.getByLabelText("Forecast signal"), { target: { value: "covid-ed" } });
        await screen.findByRole("heading", { name: /COVID-19 ED activity/i });
        const forecastRequests = fetchMock.mock.calls.filter((call) => String((call as unknown[])[0] ?? "").includes("/api/national/forecasts"));
        expect(forecastRequests.filter((call) => String((call as unknown[])[0] ?? "").includes("signal=covid-ed"))).toHaveLength(1);
        expect(forecastRequests.filter((call) => String((call as unknown[])[0] ?? "").includes("signal=influenza-ed"))).toHaveLength(1);
    });
    it("shows a single primary map view with no chart, table, or map/table toggle", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(forecastFixture("covid-ed")))));
        const { container } = render(<ForecastsPage />);
        await screen.findByLabelText("Forecast signal");
        expect(screen.queryByRole("button", { name: "Change from now" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Forecast level" })).not.toBeInTheDocument();
        expect(screen.queryByRole("img", { name: "Forecast chart" })).not.toBeInTheDocument();
        expect(screen.queryByText("View chart data")).not.toBeInTheDocument();
        expect(container.querySelectorAll("table")).toHaveLength(0);
        expect(screen.getByText("Modeled projection")).toBeVisible();
        expect(screen.getByText(/projected level for next month/)).toBeVisible();
        expect(screen.queryByText(/difference between/)).not.toBeInTheDocument();
    });
    it("has no county detail: the state readout shows the monthly forecast fields", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(forecastFixture("covid-ed")))));
        render(<ForecastsPage />);
        const statePicker = await screen.findByLabelText("Forecast state");
        fireEvent.change(statePicker, { target: { value: "MA" } });
        const readout = screen.getByRole("complementary");
        expect(within(readout).getByText("Massachusetts")).toBeVisible();
        expect(within(readout).getByText("State monthly forecast")).toBeVisible();
        expect(within(readout).getByText("Type")).toBeVisible();
        expect(within(readout).getByText("Modeled forecast")).toBeVisible();
        expect(within(readout).getByText("0.27%")).toBeVisible();
        expect(within(readout).getByText("Month")).toBeVisible();
        expect(within(readout).getByText("80% range")).toBeVisible();
        expect(within(readout).getByText("Backtest error")).toBeVisible();
        expect(within(readout).getByText("Skill vs persistence")).toBeVisible();
        expect(screen.queryByLabelText("Choose a county")).not.toBeInTheDocument();
    });
    it("says a state is unavailable rather than inventing a value when the estimate is missing", async () => {
        const fixture = forecastFixture("covid-ed");
        fixture.states = fixture.states.map((state) => state.code === "WY"
            ? { ...state, estimate: null, latestObserved: null, value: null, displayValue: "Unavailable", comparisonEligible: false }
            : state);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture))));
        render(<ForecastsPage />);
        const picker = await screen.findByLabelText("Forecast state");
        fireEvent.change(picker, { target: { value: "WY" } });
        const readout = screen.getByRole("complementary");
        expect(await within(readout).findByText("Wyoming")).toBeVisible();
        expect(within(readout).getAllByText("Unavailable").length).toBeGreaterThan(0);
    });
    it("shows a caveat instead of confidence when the model is not supported", async () => {
        const fixture = forecastFixture("covid-ed");
        fixture.evidence = { kind: "planning", description: "Model has not outperformed its baseline.", latestValue: "0.20", nextUpdate: "Monthly" } as NationalForecastResponse["evidence"];
        fixture.states = fixture.states.map((state) => state.code === "MA" ? { ...state, estimate: null, comparisonEligible: false, displayValue: "Forecast unavailable" } : state);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture))));
        render(<ForecastsPage />);
        const picker = await screen.findByLabelText("Forecast state");
        fireEvent.change(picker, { target: { value: "MA" } });
        const readout = screen.getByRole("complementary");
        expect(await within(readout).findByText(/No defensible monthly forecast is available/)).toBeVisible();
    });
    it("never renders a numerical forecast for planning or official evidence", async () => {
        const fixture: NationalForecastResponse = {
            ...forecastFixture("covid-ed"),
            evidence: { kind: "planning", description: "Lyme case counts are planning context from CDC surveillance; a monthly numerical forecast is not produced for this signal.", latestValue: "1,204 cases", nextUpdate: "Weekly" },
        };
        fixture.states = fixture.states.map((state) => ({ ...state, estimate: null, comparisonEligible: false, displayValue: "Forecast unavailable" }));
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture))));
        render(<ForecastsPage />);
        const heading = await screen.findByRole("heading", { name: /COVID-19 ED activity/i });
        expect(heading).toBeInTheDocument();
        expect(screen.getByText("Why this signal is not a monthly forecast")).toBeVisible();
        expect(screen.getByText(/planning context/)).toBeVisible();
        expect(screen.queryByText("Forecast summary")).not.toBeInTheDocument();
        expect(screen.queryByText("Next month")).not.toBeInTheDocument();
    });
    it("does not color or summarize a modeled response that failed the evidence gate", async () => {
        const fixture = forecastFixture("covid-ed");
        fixture.evidence = {
            kind: "modeled",
            model: "Corvid seasonal ensemble",
            observations: [{ date: "2026-07-25", value: .2 }],
            estimates: [{ horizonDays: 28, targetDate: "2026-09-01", value: .27, lower: .22, upper: .32, mae: .03, intervalCoverage: .78, skillVsPersistence: -4, evidence: "insufficient" }],
            evidence: "insufficient",
        };
        fixture.states = fixture.states.map((state) => state.estimate ? { ...state, estimate: { ...state.estimate, evidence: "insufficient" } } : state);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture))));
        render(<ForecastsPage />);
        await screen.findByRole("heading", { name: /COVID-19 ED activity/i });
        expect(screen.getByText("No forecast available")).toBeVisible();
        expect(screen.queryByText("Forecast summary")).not.toBeInTheDocument();
        expect(screen.queryByText("Next month")).not.toBeInTheDocument();
    });
    it("shows the plain-English summary with now, next month, and the change", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(forecastFixture("covid-ed")))));
        render(<ForecastsPage />);
        await screen.findByLabelText("Forecast signal");
        const summary = screen.getByRole("region", { name: "Forecast detail" });
        expect(within(summary).getByText(/The latest observed value is 0\.20/)).toBeVisible();
        expect(within(summary).getByText("Now")).toBeVisible();
        expect(within(summary).getByText("Next month")).toBeVisible();
        expect(within(summary).getByText("Change")).toBeVisible();
        expect(within(summary).getByText(/expected to increase/)).toBeVisible();
    });
    it("never labels a prior signal's forecast as the newly selected disease", async () => {
        let releaseInfluenza!: () => void;
        const influenzaPending = new Promise<void>((resolve) => { releaseInfluenza = resolve; });
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("signal=covid-ed"))
                return new Response(JSON.stringify(forecastFixture("covid-ed")));
            await influenzaPending;
            return new Response(JSON.stringify(forecastFixture("influenza-ed")));
        }));
        render(<ForecastsPage />);
        await screen.findByRole("heading", { name: /COVID-19 ED activity/i });
        const signalPicker = screen.getByLabelText("Forecast signal");
        fireEvent.change(signalPicker, { target: { value: "influenza-ed" } });
        expect(screen.queryByRole("heading", { name: /COVID-19 ED activity/i })).not.toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("Forecasts are opening");
        releaseInfluenza();
        expect(await screen.findByRole("heading", { name: /Influenza ED activity/i })).toBeVisible();
    });
    it("corrects the planning count to match the UI-comparable count when the data layer embeds a different number", async () => {
        window.history.replaceState(null, "", "/forecasts");
        const fixture: NationalForecastResponse = {
            ...forecastFixture("covid-ed"),
            evidence: {
                kind: "planning",
                description: "36 state forecasts passed the evidence gates. Select a state to inspect its history and uncertainty.",
                latestValue: "0.20 per 100k",
                nextUpdate: "Monthly",
            },
        };
        const codesToInvalidate = fixture.states.slice(0, 14).map((s) => s.code);
        fixture.states = fixture.states.map((s) => codesToInvalidate.includes(s.code)
            ? { ...s, comparisonEligible: false, estimate: null, latestObserved: null, value: null, displayValue: "Unavailable" }
            : s);
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(fixture))));
        render(<ForecastsPage />);
        const heading = await screen.findByRole("heading", { name: /COVID-19 ED activity/i });
        expect(heading).toBeInTheDocument();
        expect(screen.getByText(/35 state forecasts passed/)).toBeVisible();
        expect(screen.queryByText(/36 state forecasts passed/)).not.toBeInTheDocument();
        expect(screen.getByText("35", { selector: "strong" })).toBeVisible();
        expect(screen.getByText("35 / 49")).toBeVisible();
    });
});
