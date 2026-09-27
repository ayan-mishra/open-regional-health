import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { NationalDashboard } from "@/components/national-dashboard";
import type { NationalOutlookResponse } from "@/lib/national-contracts";
import { SIGNAL_BY_ID, SIGNAL_CATALOG, type SignalId } from "@/lib/signal-catalog";
import { clearSiteSnapshotCache } from "@/lib/site-snapshot";
import { US_JURISDICTIONS } from "@/lib/us-geography";
function outlook(signalId: SignalId = "covid-ed", overrides: Partial<NationalOutlookResponse> = {}): NationalOutlookResponse {
    return {
        scope: "national", signal: SIGNAL_BY_ID[signalId], catalog: SIGNAL_CATALOG, retrievedAt: "2026-07-29T12:00:00Z", status: "current", isStale: false, period: null,
        states: US_JURISDICTIONS.map((state) => ({ code: state.code, name: state.name, value: .2, displayValue: "0.20%", observedThrough: "2026-07-25", comparisonEligible: true, note: "CDC state observation." })),
        selectedState: null, details: [], geography: { level: "hsa", countyDataStates: [], statewideOnlyStates: US_JURISDICTIONS.map((state) => state.code), message: "HSA data." }, errors: [],
        ...overrides,
    };
}
afterEach(() => { clearSiteSnapshotCache(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("NationalDashboard", () => {
    it("renders the complete catalog from one server-provided signal", () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        render(<NationalDashboard initialOutlook={outlook()}/>);
        expect(screen.getByRole("complementary", { name: "Selected geography and signal" })).toHaveAttribute("aria-live", "polite");
        expect(screen.getByLabelText("Map signals").querySelectorAll("button")).toHaveLength(SIGNAL_CATALOG.length);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("switches instantly, then requests only the selected disease", async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("signal=influenza-ed"))
                await pending;
            return new Response(JSON.stringify(outlook("influenza-ed")));
        });
        vi.stubGlobal("fetch", fetchMock);
        render(<NationalDashboard initialOutlook={outlook()}/>);
        fireEvent.click(screen.getByRole("button", { name: /Influenza ED activity/i }));
        expect(screen.getByRole("heading", { name: "Influenza ED activity" })).toBeVisible();
        expect(screen.getByText("Updating signal")).toBeVisible();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toContain("/api/national/outlook?signal=influenza-ed");
        expect(String(fetchMock.mock.calls[0][0])).not.toContain("/api/national/feed");
        await act(async () => release());
        await waitFor(() => expect(screen.queryByText("Updating signal")).not.toBeInTheDocument());
    });
    it("switches with zero fetch and no loading flash when every signal is already primed from the server-warmed cache", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const allOutlooks = new Map(SIGNAL_CATALOG.map((signal) => [signal.id, outlook(signal.id)] as const));
        render(<NationalDashboard initialOutlook={outlook()} allOutlooks={allOutlooks}/>);
        fireEvent.click(screen.getByRole("button", { name: /Influenza ED activity/i }));
        expect(screen.getByRole("heading", { name: "Influenza ED activity" })).toBeVisible();
        expect(screen.queryByText("Updating signal")).not.toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("keeps a selected signal in the browser cache when switching back and forth", async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(outlook("influenza-ed"))));
        vi.stubGlobal("fetch", fetchMock);
        render(<NationalDashboard initialOutlook={outlook()}/>);
        fireEvent.click(screen.getByRole("button", { name: /Influenza ED activity/i }));
        await screen.findByRole("heading", { name: "Influenza ED activity" });
        await waitFor(() => expect(screen.queryByText("Updating signal")).not.toBeInTheDocument());
        fireEvent.click(screen.getByRole("button", { name: /COVID-19 ED activity/i }));
        fireEvent.click(screen.getByRole("button", { name: /Influenza ED activity/i }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it("counts down to the browser's scheduled refresh and hydrates consistently", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-29T13:00:00Z"));
        const initial = outlook();
        const markup = renderToString(<NationalDashboard initialOutlook={initial}/>);
        expect(markup).toContain("Next update 12:00:00");
        vi.setSystemTime(new Date("2026-07-29T13:00:01Z"));
        const container = document.createElement("div");
        container.innerHTML = markup;
        document.body.append(container);
        const recoverableErrors: unknown[] = [];
        let root: Root;
        await act(async () => {
            root = hydrateRoot(container, <NationalDashboard initialOutlook={initial}/>, { onRecoverableError: (error) => recoverableErrors.push(error) });
            await Promise.resolve();
        });
        await act(async () => root.unmount());
        container.remove();
        expect(recoverableErrors).toEqual([]);
    });
    it("does not leave the refresh countdown at zero when serving an older bake", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
        render(<NationalDashboard initialOutlook={outlook()}/>);
        expect(screen.getByText("Next update 12:00:00")).toBeVisible();
        act(() => { vi.advanceTimersByTime(1000); });
        expect(screen.getByText("Next update 11:59:59")).toBeVisible();
    });
    it("loads county boundaries without waiting for publisher detail", async () => {
        let releaseState!: () => void;
        const pendingState = new Promise<void>((resolve) => { releaseState = resolve; });
        const countyCapable = outlook("covid-ed", { geography: { level: "hsa", countyDataStates: [], statewideOnlyStates: ["MA"], message: "HSA detail loads by state." } });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/geometry/"))
                return new Response(JSON.stringify({ stateCode: "MA", viewBox: "0 0 100 100", statePath: "M0,0Z", counties: [{ fips: "25017", name: "Middlesex", path: "M0,0Z" }], source: "Census", sourceSha256: "hash" }));
            await pendingState;
            return new Response(JSON.stringify({ ...countyCapable, scope: "state", selectedState: "MA", details: [{ id: "22", name: "Boston HSA", stateCode: "MA", geographyType: "hsa", counties: ["Middlesex"], value: .9, displayValue: "0.90%", observedThrough: "2026-07-25", comparisonEligible: true, note: "Shared HSA observation." }] }));
        });
        vi.stubGlobal("fetch", fetchMock);
        render(<NationalDashboard initialOutlook={countyCapable}/>);
        fireEvent.change(screen.getByLabelText("Choose a state"), { target: { value: "MA" } });
        expect(await screen.findByRole("option", { name: "Middlesex County" })).toBeVisible();
        fireEvent.change(screen.getByLabelText("Choose a county"), { target: { value: "25017" } });
        releaseState();
        expect(await screen.findByText("0.90%")).toBeVisible();
        expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/geometry/counties/25.json"))).toHaveLength(1);
    });
    it("requests only one signal for a historical month", async () => {
        const historical = outlook("covid-ed", { period: "2026-07" });
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(historical)));
        vi.stubGlobal("fetch", fetchMock);
        render(<NationalDashboard initialPeriod="2026-07"/>);
        expect(await screen.findByLabelText("Choose a state")).toBeVisible();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toContain("signal=covid-ed&period=2026-07");
        expect(String(fetchMock.mock.calls[0][0])).not.toContain("/api/national/feed");
    });
    it("keeps the dashboard interactive while a scheduled refresh is pending", async () => {
        let releaseRefresh!: () => void;
        const pendingRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
        let scheduledRefresh!: () => void;
        vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
            if (delay === 43200000)
                scheduledRefresh = handler as () => void;
            return 1 as unknown as ReturnType<typeof setInterval>;
        });
        vi.stubGlobal("fetch", vi.fn(async () => {
            await pendingRefresh;
            return new Response(JSON.stringify(outlook()));
        }));
        render(<NationalDashboard initialOutlook={outlook()}/>);
        act(() => scheduledRefresh());
        expect(screen.getByLabelText("Choose a state")).toBeVisible();
        expect(screen.getByText("Updating signal")).toBeVisible();
        await act(async () => releaseRefresh());
    });
    it("keeps recovery chrome when the selected signal fails", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fixture failure"); }));
        render(<NationalDashboard />);
        expect(await screen.findByRole("alert")).toHaveTextContent("fixture failure");
        expect(screen.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    });
});
