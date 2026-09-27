import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NationalMap } from "@/components/national-map";
import { US_JURISDICTIONS } from "@/lib/us-geography";
import type { NationalOutlookResponse } from "@/lib/national-contracts";
import { SIGNAL_BY_ID, SIGNAL_CATALOG } from "@/lib/signal-catalog";
import { US_STATE_GEOMETRY } from "@/lib/us-map-geometry";
const response: NationalOutlookResponse = {
    scope: "national", signal: SIGNAL_BY_ID["covid-ed"], catalog: SIGNAL_CATALOG, retrievedAt: "2026-07-29T12:00:00Z", status: "current", isStale: false, period: null,
    states: US_JURISDICTIONS.map((state, index) => ({ code: state.code, name: state.name, value: index / 10, displayValue: `${(index / 10).toFixed(1)}%`, observedThrough: "2026-07-25", comparisonEligible: true, note: "CDC state observation." })),
    selectedState: null, details: [], geography: { level: "hsa", countyDataStates: [], statewideOnlyStates: US_JURISDICTIONS.map((state) => state.code), message: "HSA coverage." }, errors: [],
};
function pathFor(container: HTMLElement, d: string) {
    return Array.from(container.querySelectorAll("path")).find((path) => path.getAttribute("d") === d);
}
function statePath(code: string) {
    return US_STATE_GEOMETRY.find((shape) => shape.code === code)!.path;
}
describe("NationalMap", () => {
    it("keeps all 49 pointer-only state shapes free of button and keyboard semantics", () => {
        const { container } = render(<NationalMap outlook={response} selectedState={null} countyGeometry={null} onSelectState={() => undefined}/>);
        const stateShapes = container.querySelectorAll("path");
        expect(stateShapes).toHaveLength(49);
        expect(container.querySelectorAll('[role="button"], [tabindex]')).toHaveLength(0);
    });
    it("selects Massachusetts from its true state path", () => {
        const onSelect = vi.fn();
        const { container } = render(<NationalMap outlook={response} selectedState={null} countyGeometry={null} onSelectState={onSelect}/>);
        fireEvent.click(pathFor(container, statePath("MA"))!);
        expect(onSelect).toHaveBeenCalledWith("MA");
    });
    it("explains a state's forecast and change on hover", () => {
        const { container } = render(<NationalMap outlook={response} selectedState={null} countyGeometry={null} onSelectState={() => undefined} mode="change" currentByState={{ MA: .2 }} forecastByState={{ MA: .5 }}/>);
        const title = pathFor(container, statePath("MA"))?.querySelector("title");
        expect(title).toHaveTextContent("Massachusetts: forecast 0.50; latest observed 0.20; higher than now by 0.30.");
    });
    it("does not select a state without a reading or eligible detail", () => {
        const onSelect = vi.fn();
        const outlook: NationalOutlookResponse = {
            ...response,
            states: response.states.map((state) => state.code === "CA"
                ? { ...state, value: null, displayValue: "No comparable data", comparisonEligible: false }
                : state),
            geography: { level: "statewide", countyDataStates: [], statewideOnlyStates: ["MA"], message: "Statewide only." },
        };
        const { container } = render(<NationalMap outlook={outlook} selectedState={null} countyGeometry={null} onSelectState={onSelect}/>);
        fireEvent.click(pathFor(container, statePath("CA"))!);
        fireEvent.click(pathFor(container, statePath("MA"))!);
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith("MA");
    });
    it("opens a missing state when the signal can load sub-state publisher detail", () => {
        const onSelect = vi.fn();
        const outlook: NationalOutlookResponse = {
            ...response,
            signal: SIGNAL_BY_ID["sars-cov-2-wval"],
            states: response.states.map((state) => ({ ...state, value: null, displayValue: "No comparable data", comparisonEligible: false })),
            geography: { level: "site-to-county", countyDataStates: [], statewideOnlyStates: [], message: "Load sites by state." },
        };
        const { container } = render(<NationalMap outlook={outlook} selectedState={null} countyGeometry={null} onSelectState={onSelect}/>);
        fireEvent.click(pathFor(container, statePath("CA"))!);
        expect(onSelect).toHaveBeenCalledWith("CA");
    });
    it("selects a state when eligible county detail backs a missing state reading", () => {
        const onSelect = vi.fn();
        const outlook: NationalOutlookResponse = {
            ...response,
            states: response.states.map((state) => state.code === "CA"
                ? { ...state, value: null, displayValue: "No comparable data", comparisonEligible: false }
                : state),
            details: [{ id: "county:06001", name: "Alameda County", stateCode: "CA", geographyType: "county", counties: ["Alameda"], value: 2.4, displayValue: "2.40", observedThrough: "2026-07-18", comparisonEligible: true, note: "County observation." }],
        };
        const { container } = render(<NationalMap outlook={outlook} selectedState={null} countyGeometry={null} onSelectState={onSelect}/>);
        fireEvent.click(pathFor(container, statePath("CA"))!);
        expect(onSelect).toHaveBeenCalledWith("CA");
        expect(pathFor(container, statePath("CA"))?.querySelector("title")).toHaveTextContent("county or reporting-site detail is available, but the publisher does not provide a defensible statewide estimate");
    });
    it("colors a county-derived state even when fewer than four states have readings", () => {
        const outlook: NationalOutlookResponse = {
            ...response,
            signal: SIGNAL_BY_ID["ed-wait"],
            states: response.states.map((state) => state.code === "MA"
                ? { ...state, value: 30, displayValue: "30.0 minutes", comparisonEligible: true, countyAggregation: { method: "county-mean" as const, countyCount: 2 } }
                : { ...state, value: null, displayValue: "No comparable data", comparisonEligible: false }),
            details: [
                { id: "MA:1", name: "Middlesex County", stateCode: "MA", geographyType: "county", counties: ["Middlesex"], value: 20, displayValue: "20 minutes", observedThrough: "2026-07-30", comparisonEligible: true, note: "County observation." },
                { id: "MA:2", name: "Suffolk County", stateCode: "MA", geographyType: "county", counties: ["Suffolk"], value: 40, displayValue: "40 minutes", observedThrough: "2026-07-30", comparisonEligible: true, note: "County observation." },
            ],
        };
        const { container } = render(<NationalMap outlook={outlook} selectedState={null} countyGeometry={null} onSelectState={() => undefined}/>);
        expect(pathFor(container, statePath("MA"))).not.toHaveAttribute("fill", "url(#national-hatch)");
    });
    it("uses one pointer callout target for each smallest jurisdiction", () => {
        const onSelect = vi.fn();
        const { container } = render(<NationalMap outlook={response} selectedState={null} countyGeometry={null} onSelectState={onSelect}/>);
        for (const code of ["DC", "DE", "RI"]) {
            const callout = Array.from(container.querySelectorAll("text")).find((text) => text.textContent === code)?.closest("g");
            expect(callout).not.toBeNull();
            fireEvent.click(callout!);
            expect(onSelect).toHaveBeenLastCalledWith(code);
        }
    });
    it("maps site forecasts to publisher-listed counties without inventing a state value", () => {
        const outlook: NationalOutlookResponse = { ...response, scope: "state", signal: SIGNAL_BY_ID["sars-cov-2-wval"], selectedState: "MA", states: response.states.map((state) => ({ ...state, value: null, displayValue: "No comparable data", comparisonEligible: false })), details: [{ id: "ID:42", name: "Wastewater site 42", geographyType: "site", counties: ["Middlesex"], value: 2.4, displayValue: "2.40", observedThrough: "2026-07-18", comparisonEligible: true, note: "Site forecast" }] };
        const countyGeometry = { stateCode: "MA" as const, viewBox: "0 0 100 100", statePath: "M0,0L100,0L100,100Z", source: "Census", sourceSha256: "test", generatedAt: "2026-01-01", counties: [{ fips: "25017", name: "Middlesex", path: "M0,0L50,0L50,50Z" }] };
        const onSelectDetail = vi.fn();
        const { container } = render(<NationalMap outlook={outlook} selectedState="MA" countyGeometry={countyGeometry} onSelectState={() => undefined} onSelectDetail={onSelectDetail}/>);
        expect(screen.getByRole("group", { name: /detail map/i })).toBeInTheDocument();
        expect(container.querySelectorAll('[role="button"], [tabindex]')).toHaveLength(0);
        fireEvent.click(pathFor(container, countyGeometry.counties[0].path)!);
        expect(onSelectDetail).toHaveBeenCalledWith("ID:42", "Middlesex County");
    });
    it("offers every county and leaves missing publisher detail explicit", () => {
        const outlook: NationalOutlookResponse = {
            ...response,
            scope: "state",
            selectedState: "MA",
            details: [{ id: "ID:42", name: "Wastewater site 42", stateCode: "MA", geographyType: "site", counties: ["Middlesex"], value: 2.4, displayValue: "2.40", observedThrough: "2026-07-18", comparisonEligible: true, note: "Site observation." }],
        };
        const countyGeometry = { stateCode: "MA" as const, viewBox: "0 0 100 100", statePath: "M0,0L100,0L100,100Z", source: "Census", sourceSha256: "test", generatedAt: "2026-01-01", counties: [
                { fips: "25017", name: "Middlesex", path: "M0,0L50,0L50,50Z" },
                { fips: "25025", name: "Suffolk", path: "M50,0L100,0L100,50Z" },
            ] };
        render(<NationalMap outlook={outlook} selectedState="MA" countyGeometry={countyGeometry} onSelectState={() => undefined}/>);
        expect(screen.getAllByRole("option")).toHaveLength(3);
        expect(screen.getByRole("option", { name: "Middlesex County" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Suffolk County" })).toBeInTheDocument();
    });
    it("keeps counties selectable when an HSA-capable publisher has no current local values", () => {
        const countyGeometry = { stateCode: "CA" as const, viewBox: "0 0 100 100", statePath: "M0,0Z", source: "Census", sourceSha256: "test", counties: [
                { fips: "06001", name: "Alameda", path: "M0,0L50,0L50,50Z" },
                { fips: "06013", name: "Contra Costa", path: "M50,0L100,0L100,50Z" },
            ] };
        const outlook = { ...response, scope: "state" as const, selectedState: "CA" as const, details: [] };
        render(<NationalMap outlook={outlook} selectedState="CA" countyGeometry={countyGeometry} onSelectState={() => undefined}/>);
        expect(screen.queryByRole("note", { name: "Statewide observation only" })).not.toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Alameda County" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Contra Costa County" })).toBeInTheDocument();
    });
    it("matches publisher city and compound county labels to current geometry", () => {
        const outlook: NationalOutlookResponse = { ...response, scope: "state", selectedState: "VA", states: response.states.map((state) => ({ ...state, value: null, displayValue: "No comparable data", comparisonEligible: false })), details: [{ id: "VA:30", name: "Alleghany HSA", geographyType: "hsa", counties: ["Alleghany Cnty and Clifton Forge Cty", "Bedford City"], value: 1.2, displayValue: "1.20%", observedThrough: "2026-07-25", comparisonEligible: true, note: "Shared HSA observation." }] };
        const countyGeometry = { stateCode: "VA" as const, viewBox: "0 0 100 100", statePath: "M0,0Z", source: "Census", sourceSha256: "test", generatedAt: "2026-01-01", counties: [
                { fips: "51005", name: "Alleghany", path: "M0,0L50,0L50,50Z" },
                { fips: "51019", name: "Bedford", path: "M50,0L100,0L100,50Z" },
            ] };
        render(<NationalMap outlook={outlook} selectedState="VA" countyGeometry={countyGeometry} onSelectState={() => undefined}/>);
        expect(screen.getByRole("option", { name: "Alleghany County" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Bedford County" })).toBeInTheDocument();
    });
    it("uses exact source FIPS when a county and independent city share a name", () => {
        const outlook: NationalOutlookResponse = {
            ...response,
            scope: "state",
            signal: SIGNAL_BY_ID["b-miyamotoi-presence"],
            selectedState: "VA",
            details: [{ id: "county:51059", name: "Fairfax County", stateCode: "VA", geographyType: "county", counties: ["Fairfax"], value: 1, displayValue: "Documented presence", observedThrough: "2025-12-31", publisherEligible: true, comparisonEligible: false, note: "CDC record." }],
        };
        const countyGeometry = { stateCode: "VA" as const, viewBox: "0 0 100 100", statePath: "M0,0Z", source: "Census", sourceSha256: "test", generatedAt: "2026-01-01", counties: [
                { fips: "51059", name: "Fairfax", path: "M0,0L50,0L50,50Z" },
                { fips: "51600", name: "Fairfax", path: "M50,0L100,0L100,50Z" },
            ] };
        const view = render(<NationalMap outlook={outlook} selectedState="VA" countyGeometry={countyGeometry} onSelectState={() => undefined}/>);
        expect(pathFor(view.container, countyGeometry.counties[0].path)).toBeInTheDocument();
        expect(pathFor(view.container, countyGeometry.counties[1].path)).toBeInTheDocument();
        view.rerender(<NationalMap outlook={outlook} selectedState="VA" countyGeometry={countyGeometry} onSelectState={() => undefined} selectedDetailId="county:51059" selectedCountyName="Fairfax County"/>);
        expect(screen.getByLabelText("Choose a county")).toHaveValue("51059");
        expect(screen.getByRole("option", { name: "Fairfax city" })).toBeInTheDocument();
        expect(pathFor(view.container, countyGeometry.counties[0].path)?.getAttribute("class")).toMatch(/_selected_/);
        expect(pathFor(view.container, countyGeometry.counties[1].path)?.getAttribute("class")).not.toMatch(/_selected_/);
    });
    it("keeps zero-record B. miyamotoi counties selectable without inferring absence", () => {
        const outlook: NationalOutlookResponse = {
            ...response,
            scope: "state",
            signal: SIGNAL_BY_ID["b-miyamotoi-presence"],
            selectedState: "MA",
            states: response.states.map((state) => state.code === "MA"
                ? { ...state, value: null, displayValue: "No documented presence records", comparisonEligible: false }
                : state),
            details: [],
        };
        const countyGeometry = { stateCode: "MA" as const, viewBox: "0 0 100 100", statePath: "M0,0L100,0L100,100Z", source: "Census", sourceSha256: "test", generatedAt: "2026-01-01", counties: [
                { fips: "25017", name: "Middlesex", path: "M0,0L50,0L50,50Z" },
                { fips: "25025", name: "Suffolk", path: "M50,0L100,0L100,50Z" },
            ] };
        const { container } = render(<NationalMap outlook={outlook} selectedState="MA" countyGeometry={countyGeometry} onSelectState={() => undefined}/>);
        expect(screen.queryByRole("note", { name: "Statewide observation only" })).not.toBeInTheDocument();
        expect(screen.getByRole("group", { name: /B\. miyamotoi documented presence detail map/i })).toBeInTheDocument();
        expect(screen.getAllByRole("option")).toHaveLength(3);
        expect(container.querySelectorAll('[role="button"], [tabindex]')).toHaveLength(0);
        expect(pathFor(container, countyGeometry.counties[0].path)).toBeInTheDocument();
        expect(pathFor(container, countyGeometry.counties[1].path)).toBeInTheDocument();
    });
    it("renders one non-interactive state outline when a publisher only releases a statewide value", () => {
        const outlook: NationalOutlookResponse = { ...response, scope: "state", selectedState: "MA", details: [], geography: { level: "statewide", countyDataStates: [], statewideOnlyStates: ["MA"], message: "Statewide only." } };
        const countyGeometry = { stateCode: "MA" as const, viewBox: "0 0 100 100", statePath: "M0,0L100,0L100,100Z", source: "Census", sourceSha256: "test", generatedAt: "2026-01-01", counties: [
                { fips: "25017", name: "Middlesex", path: "M0,0L50,0L50,50Z" },
                { fips: "25025", name: "Suffolk", path: "M50,0L100,0L100,50Z" },
            ] };
        const { container } = render(<NationalMap outlook={outlook} selectedState="MA" countyGeometry={countyGeometry} onSelectState={() => undefined}/>);
        expect(screen.getByRole("img", { name: /Massachusetts statewide observation.*county detail is not selectable/i })).toBeInTheDocument();
        expect(screen.getByRole("note", { name: "Statewide observation only" })).toBeVisible();
        expect(container.querySelectorAll("path")).toHaveLength(1);
        expect(container.querySelector("path")).toHaveAttribute("d", countyGeometry.statePath);
        expect(screen.queryAllByRole("button", { name: /Middlesex|Suffolk/i })).toHaveLength(0);
        expect(screen.queryByLabelText("Choose a county")).not.toBeInTheDocument();
    });
    it("does not let users open a county when the publisher only releases a statewide value", () => {
        const onSelectDetail = vi.fn();
        const outlook = { ...response, scope: "state" as const, selectedState: "MA" as const, states: response.states.map((state) => state.code === "MA" ? { ...state, value: 1.9, displayValue: "1.9%", comparisonEligible: true } : state), details: [], geography: { level: "statewide" as const, countyDataStates: [], statewideOnlyStates: ["MA" as const], message: "Statewide only." } };
        const countyGeometry = { stateCode: "MA" as const, viewBox: "0 0 100 100", statePath: "M0,0L100,0L100,100Z", source: "Census", sourceSha256: "test", generatedAt: "2026-01-01", counties: [{ fips: "25017", name: "Middlesex", path: "M0,0L50,0L50,50Z" }] };
        const { container } = render(<NationalMap outlook={outlook} selectedState="MA" countyGeometry={countyGeometry} onSelectState={() => undefined} onSelectDetail={onSelectDetail}/>);
        fireEvent.click(container.querySelector("path")!);
        expect(onSelectDetail).not.toHaveBeenCalled();
    });
    it("labels the level-mode tooltip as a current observed value, not a forecast, when no forecast is provided", () => {
        const maReading = response.states.find((s) => s.code === "MA")!;
        const { container } = render(<NationalMap outlook={response} selectedState={null} countyGeometry={null} onSelectState={() => undefined} mode="level" currentByState={{ MA: .2 }} forecastByState={{}}/>);
        const title = pathFor(container, statePath("MA"))?.querySelector("title");
        expect(title).toHaveTextContent(`Massachusetts: current observed value ${maReading.displayValue}.`);
        expect(title).not.toHaveTextContent("forecast");
    });
    it("labels the level-mode tooltip as a forecast when a forecast value is present", () => {
        const { container } = render(<NationalMap outlook={response} selectedState={null} countyGeometry={null} onSelectState={() => undefined} mode="level" currentByState={{ MA: .2 }} forecastByState={{ MA: .5 }}/>);
        const title = pathFor(container, statePath("MA"))?.querySelector("title");
        expect(title).toHaveTextContent("Massachusetts: forecast 0.50.");
    });
});
