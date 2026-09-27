"use client";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { NationalMap } from "@/components/national-map";
import { classifyForecastChange, forecastChangeLabel, forecastOutlook, forecastOutlookLabel, formatForecastPercentChange, formatSignedDelta } from "@/lib/forecast-comparison";
import type { NationalForecastResponse, NationalOutlookResponse } from "@/lib/national-contracts";
import { getCachedForecastSnapshot, loadForecastSnapshot, primeForecastSnapshot } from "@/lib/site-snapshot";
import { SIGNAL_CATALOG, type SignalId } from "@/lib/signal-catalog";
import { US_JURISDICTIONS, type IncludedStateCode } from "@/lib/us-geography";
import styles from "./forecasts-page.module.css";
import { HistoryMonthPicker } from "./history-month-picker";
import { RavenLoadingScreen } from "./raven-loading-screen";
const REFRESH_MS = 43200000;
const MODELED_SIGNALS = SIGNAL_CATALOG.filter((signal) => signal.defaultEvidence === "modeled");
function formatDate(value: string | null) {
    if (!value)
        return "Unavailable";
    if (/^\d{4}-\d{2}$/.test(value))
        return monthLabel(value);
    if (Number.isNaN(Date.parse(value)))
        return "Unavailable";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}
function monthLabel(period: string): string {
    const parsed = new Date(`${period}-01T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? period : parsed.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
function initialQuery() {
    if (typeof window === "undefined")
        return { signal: "covid-ed" as SignalId, state: null as IncludedStateCode | null, period: "" };
    const params = new URLSearchParams(window.location.search);
    const rawSignal = params.get("signal");
    const signal = rawSignal && MODELED_SIGNALS.some((item) => item.id === rawSignal) ? rawSignal as SignalId : "covid-ed";
    const rawState = params.get("state");
    const rawPeriod = params.get("period") ?? "";
    const currentPeriod = new Date().toISOString().slice(0, 7);
    const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawPeriod) && rawPeriod >= "2018-01" && rawPeriod <= currentPeriod ? rawPeriod : "";
    return { signal, state: rawState && US_JURISDICTIONS.some((state) => state.code === rawState) ? rawState as IncludedStateCode : null, period };
}
export function ForecastsPage({ initialForecasts, initialSignal, initialState, initialPeriod }: {
    initialForecasts?: Partial<Record<SignalId, NationalForecastResponse>>;
    initialSignal?: SignalId;
    initialState?: IncludedStateCode | null;
    initialPeriod?: string;
}) {
    const [serverForecasts] = useState(() => {
        for (const forecast of Object.values(initialForecasts ?? {})) {
            if (forecast)
                primeForecastSnapshot(forecast, initialPeriod ?? "");
        }
        return initialForecasts;
    });
    const [initial] = useState(() => initialSignal ? { signal: initialSignal, state: initialState ?? null, period: initialPeriod ?? "" } : initialQuery());
    const initialForecast = serverForecasts?.[initial.signal] ?? getCachedForecastSnapshot(initial.signal, 28, initial.period);
    const [signalId, setSignalId] = useState<SignalId>(initial.signal);
    const [selectedState, setSelectedState] = useState<IncludedStateCode | null>(initial.state);
    const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
    const [period, setPeriod] = useState(initial.period);
    const [response, setResponse] = useState<NationalForecastResponse | null>(initialForecast);
    const [loadState, setLoadState] = useState<"loading" | "current" | "preserved" | "unavailable">(initialForecast ? "current" : "loading");
    const [forecastError, setForecastError] = useState<string | null>(null);
    const [forecastRetryKey, setForecastRetryKey] = useState(0);
    const [loadProgress, setLoadProgress] = useState<{
        completed: number;
        total: number;
    } | null>(null);
    useEffect(() => {
        if (loadState !== "loading" || !period)
            return;
        let active = true;
        const poll = () => {
            const params = new URLSearchParams({ signal: signalId, period });
            if (selectedState)
                params.set("state", selectedState);
            fetch(`/api/national/forecasts/progress?${params}`).then(async (response) => {
                if (!response.ok)
                    return;
                const data = await response.json() as {
                    completed?: unknown;
                    total?: unknown;
                };
                if (active && typeof data.completed === "number" && typeof data.total === "number")
                    setLoadProgress({ completed: data.completed, total: data.total });
            }).catch(() => undefined);
        };
        poll();
        const timer = window.setInterval(poll, 800);
        return () => { active = false; window.clearInterval(timer); };
    }, [loadState, signalId, period, selectedState]);
    useEffect(() => {
        const params = new URLSearchParams({ signal: signalId, horizon: "28" });
        if (selectedState)
            params.set("state", selectedState);
        if (period)
            params.set("period", period);
        window.history.replaceState(null, "", `/forecasts?${params}`);
        let active = true;
        const refresh = (force = false) => {
            const serverForecast = serverForecasts?.[signalId];
            if (!force && !selectedState && serverForecast?.signalId === signalId && serverForecast.horizon === 28 && (serverForecast.period ?? "") === period && period === (initialPeriod ?? "") && forecastRetryKey === 0) {
                setResponse(serverForecast);
                setForecastError(null);
                setLoadState("current");
                return;
            }
            setLoadState(response?.signalId === signalId && (response.period ?? "") === period ? "preserved" : "loading");
            const request = loadForecastSnapshot(signalId, 28, period, force || forecastRetryKey > 0, selectedState);
            request.then((next) => {
                if (!active)
                    return;
                setResponse(next);
                setForecastError(null);
                setLoadState("current");
            }).catch((error: unknown) => {
                if (!active)
                    return;
                setForecastError(error instanceof Error ? error.message : "Forecasts are temporarily unavailable.");
                setLoadState((current) => current === "current" || current === "preserved" ? "preserved" : "unavailable");
            });
        };
        refresh();
        const timer = window.setInterval(() => refresh(true), REFRESH_MS);
        return () => { active = false; window.clearInterval(timer); };
    }, [signalId, selectedState, period, forecastRetryKey]);
    const activeResponse = response?.signalId === signalId && response.horizon === 28 && (response.period ?? "") === period ? response : null;
    const visibleLoadState = activeResponse ? loadState : loadState === "unavailable" ? "unavailable" : "loading";
    const evidence = activeResponse?.selectedState === selectedState ? activeResponse.evidence : undefined;
    const supportedStateCount = activeResponse?.states.filter((state) => state.comparisonEligible && state.estimate?.evidence === "supported").length ?? 0;
    const hasSupportedStateForecasts = activeResponse?.states.some((state) => state.estimate?.evidence === "supported") ?? false;
    const supported = evidence?.kind === "modeled" && evidence.evidence === "supported";
    const mapOutlook: NationalOutlookResponse | null = activeResponse ? {
        scope: "national", signal: activeResponse.signal, catalog: activeResponse.catalog, retrievedAt: activeResponse.retrievedAt, status: activeResponse.status,
        isStale: visibleLoadState === "preserved", period: activeResponse.period, states: activeResponse.states, selectedState: null, details: [],
        geography: { level: "statewide", countyDataStates: [], statewideOnlyStates: activeResponse.states.filter((state) => state.value !== null).map((state) => state.code), message: "Monthly statewide forecasts." },
        errors: activeResponse.errors,
    } : null;
    const localDetails = activeResponse?.selectedState === selectedState && selectedState ? activeResponse.details.filter((detail) => detail.geographyType !== "state") : [];
    const selectedDetail = localDetails.find((detail) => detail.id === selectedDetailId);
    const selectedReading = selectedDetail ?? activeResponse?.states.find((state) => state.code === selectedState);
    const latestObserved = selectedDetail ? selectedDetail.observations.at(-1)?.value ?? null : activeResponse?.states.find((state) => state.code === selectedState)?.latestObserved ?? null;
    const formatValue = (value: number) => `${value.toFixed(2)}${activeResponse?.signal.unit.includes("%") ? "%" : activeResponse?.signal.unit.includes("per 100") ? " per 100k" : ""}`;
    const selectedEstimate = selectedReading?.estimate?.evidence === "supported" ? selectedReading.estimate : null;
    const issue = activeResponse ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(activeResponse.retrievedAt)) : "Connecting";
    const maxPeriod = new Date().toISOString().slice(0, 7);
    const currentByState = Object.fromEntries(activeResponse?.states.map((state) => [state.code, state.latestObserved ?? null]) ?? []) as Partial<Record<IncludedStateCode, number | null>>;
    const forecastByState = Object.fromEntries(activeResponse?.states.map((state) => [state.code, state.comparisonEligible && state.estimate?.evidence === "supported" ? state.estimate.value : null]) ?? []) as Partial<Record<IncludedStateCode, number | null>>;
    const mapDescription = hasSupportedStateForecasts
        ? "States with a supported model are colored by their projected level for next month, using the same scale as the dashboard: lowest levels are dark green and highest are red. Hover a state for the numbers; select one for detail."
        : "No comparable statewide forecast is available. Select a state to check local forecasts and the latest published observations.";
    const modeledEvidence = selectedState
        ? selectedEstimate && selectedReading?.observations?.length ? { observations: selectedReading.observations, estimates: [selectedEstimate] } : null
        : supported && evidence?.kind === "modeled" ? evidence : null;
    const comparableCount = activeResponse?.states.filter((state) => state.comparisonEligible && state.estimate?.evidence === "supported").length ?? 0;
    const headerCount = hasSupportedStateForecasts ? supportedStateCount : comparableCount;
    const headerLabel = hasSupportedStateForecasts ? "states with a supported monthly forecast" : "states with a comparable monthly forecast";
    const panelHeadLabel = supported ? "Modeled projection" : hasSupportedStateForecasts ? "State forecasts" : "No forecast available";
    const planningDescription = evidence && evidence.kind === "planning"
        ? selectedState
            ? selectedEstimate
                ? "This geography passed the history, recency, and skill checks for a monthly forecast."
                : "This state did not pass the history, recency, and skill checks for a monthly forecast."
            : evidence.description.replace(/(\d+) state forecasts? passed/g, `${comparableCount} state forecast${comparableCount === 1 ? "" : "s"} passed`)
        : evidence && evidence.kind === "official"
            ? evidence.description
            : evidence && evidence.kind === "none"
                ? evidence.description
                : "";
    return <><AppSidebar current="forecasts" status={<><i data-state={visibleLoadState}/>{visibleLoadState === "loading" ? "Opening forecasts" : visibleLoadState === "unavailable" ? "No current issue" : visibleLoadState === "preserved" ? `Last valid issue ${issue}` : `Issued ${issue}`}</>}/>
    <main id="main-content" className={styles.page}><section className={styles.intro}><h1>Monthly forecasts</h1><span>Only signals with a defensible monthly model are shown. Select a state to read statewide and available local forecasts, their confidence, and their limitations.</span><p className={styles.count}><strong>{headerCount}</strong> {headerLabel}</p></section>
      {!activeResponse ? visibleLoadState === "loading" ? <RavenLoadingScreen compact context="forecast" title={period ? `Loading ${monthLabel(period)}` : "Forecasts are opening"} detail={period && loadProgress ? `Modeling ${MODELED_SIGNALS.find((signal) => signal.id === signalId)?.shortLabel ?? "this signal"} — ${loadProgress.completed} of ${loadProgress.total} series complete.` : "Loading the prepared monthly forecast while the page remains available."}/> : <section className={styles.empty}><strong>Forecasts are temporarily unavailable</strong><p>{forecastError ?? "No current forecast is available. Try again when the public sources recover."}</p><button type="button" onClick={() => { setForecastError(null); setLoadState("loading"); setForecastRetryKey((current) => current + 1); }}>Try again</button></section> : <>
        <section className={styles.controls} aria-label="Forecast controls"><label><span>Signal</span><select aria-label="Forecast signal" value={signalId} onChange={(event) => { const nextSignal = event.target.value as SignalId; setSignalId(nextSignal); setSelectedDetailId(null); }}>{MODELED_SIGNALS.map((signal) => <option key={signal.id} value={signal.id}>{signal.shortLabel}</option>)}</select></label><label><span>State detail</span><select aria-label="Forecast state" value={selectedState ?? ""} onChange={(event) => { const nextState = event.target.value ? event.target.value as IncludedStateCode : null; setSelectedState(nextState); setSelectedDetailId(null); }}><option value="">United States</option>{US_JURISDICTIONS.map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}</select></label><HistoryMonthPicker ariaLabel="Forecast historical month" label="Historical month" min="2018-01" max={maxPeriod} value={period} onChange={(nextPeriod) => { setPeriod(nextPeriod); setSelectedDetailId(null); }}/><p><i data-state={activeResponse.status}/>{activeResponse.status === "partial" ? `${activeResponse.errors.length} source issue${activeResponse.errors.length === 1 ? "" : "s"}` : "Forecast source current"}</p></section>
        <section className={styles.forecastGrid}><div className={styles.visualPanel}><div className={styles.panelHead}><div><span>{panelHeadLabel}</span><h2>{activeResponse.signal.label}</h2></div><p>{activeResponse.signal.source}<br />{mapDescription}</p></div><div className={`${styles.mapFrame} ${styles.nationalMapFrame}`}>{mapOutlook && <NationalMap outlook={mapOutlook} mode="level" evidenceKind={evidence?.kind} currentByState={currentByState} forecastByState={forecastByState} selectedState={null} countyGeometry={null} onSelectState={(state) => { setSelectedState(state); setSelectedDetailId(null); }}/>}</div>{modeledEvidence && modeledEvidence.observations.length && modeledEvidence.estimates.length ? <section className={styles.chartWrap} aria-label="Forecast detail"><div className={styles.chartSummary}><h3>Forecast summary</h3><p>{forecastSummaryText(modeledEvidence.observations, modeledEvidence.estimates, activeResponse.signal.direction)}</p><dl className={styles.comparisonGrid}>{(() => { const latest = modeledEvidence.observations.at(-1)!; const forecast = modeledEvidence.estimates.at(-1)!; return <><div><dt>Now</dt><dd>{latest.value.toFixed(2)}</dd></div><div><dt>Next month</dt><dd>{forecast.value.toFixed(2)}</dd></div><div><dt>Change</dt><dd>{formatSignedDelta(forecast.value - latest.value)}{(() => { const percent = formatForecastPercentChange(latest.value, forecast.value); return percent ? ` (${percent})` : ""; })()}</dd></div></>; })()}</dl></div></section> : null}{evidence && evidence.kind !== "modeled" && <div className={styles.planningPanel}><span>{hasSupportedStateForecasts ? "Why some states are not a monthly forecast" : "Why this signal is not a monthly forecast"}</span><strong>{planningDescription}</strong>{evidence!.kind === "planning" && <dl><div><dt>Latest evidence</dt><dd>{evidence!.latestValue}</dd></div><div><dt>Expected update</dt><dd>{evidence!.nextUpdate}</dd></div></dl>}</div>}</div>
          <aside className={styles.readout} aria-live="polite"><p className={styles.rubric}>Selected geography</p><h2>{selectedReading?.name ?? "Contiguous United States"}</h2><span className={styles.resolution}>{selectedDetail ? `${selectedDetail.geographyType === "hsa" ? "Health Service Area" : selectedDetail.geographyType} monthly forecast` : selectedState ? "State monthly forecast" : "National forecast comparison"}</span>{localDetails.length ? <label><span>Local forecast · {localDetails.filter((detail) => detail.estimate?.evidence === "supported").length} supported</span><select aria-label="Local forecast" value={selectedDetail?.id ?? ""} onChange={(event) => setSelectedDetailId(event.target.value || null)}><option value="">Statewide</option>{localDetails.map((detail) => <option key={detail.id} value={detail.id}>{detail.name}{detail.estimate?.evidence === "supported" ? "" : " — forecast unavailable"}</option>)}</select></label> : null}{selectedState && response?.selectedState !== selectedState && <p>{forecastError ?? "Loading local forecasts…"}{forecastError && <button type="button" onClick={() => setForecastRetryKey((key) => key + 1)}>Retry local forecasts</button>}</p>}<div className={styles.primaryMetric}><strong>{selectedState ? (selectedEstimate ? formatValue(selectedEstimate.value) : latestObserved !== null ? formatValue(latestObserved) : "Unavailable") : `${supportedStateCount} / 49`}</strong><span>{selectedState ? (selectedEstimate ? "Modeled value for the selected month" : "Latest published value") : "states with a comparable monthly forecast"}</span></div>{selectedState ? <dl><div><dt>Type</dt><dd>{selectedEstimate ? "Modeled forecast" : "Observation only"}</dd></div><div><dt>Month</dt><dd>{(() => { const month = selectedEstimate ? selectedEstimate.targetDate : activeResponse.period ?? ""; return formatDate(month || null); })()}</dd></div><div><dt>Latest observed</dt><dd>{latestObserved !== null ? formatValue(latestObserved) : "Unavailable"}</dd></div><div><dt>80% range</dt><dd>{selectedEstimate ? `${selectedEstimate.lower.toFixed(2)} to ${selectedEstimate.upper.toFixed(2)}` : "Unavailable"}</dd></div><div><dt>Backtest error</dt><dd>{selectedEstimate ? selectedEstimate.mae.toFixed(2) : "Unavailable"}</dd></div><div><dt>Skill vs persistence</dt><dd>{selectedEstimate ? `${selectedEstimate.skillVsPersistence.toFixed(1)}%` : "Unavailable"}</dd></div><div><dt>Observed through</dt><dd>{formatDate(selectedReading?.observedThrough ?? null)}</dd></div></dl> : <p>Choose a state on the map or in the list to read its forecast, its confidence, and its limitations.</p>}<p>{selectedDetail?.note}</p><p>{selectedState ? "A supported forecast is a modeled projection, not a guarantee. It does not predict outbreaks, individual risk, or short-term movement inside the state." : "The map compares each state to its own latest observed value. States without a defensible forecast are not colored."}</p>{selectedState && !selectedEstimate && <p className={styles.caveat}>No defensible monthly forecast is available for this geography. Corvid shows the latest observation without inventing a projection.</p>}</aside></section>
        <section className={styles.disclosure}><strong>How to read this</strong><p>Forecast values are modeled projections produced by Corvid&apos;s seasonal ensemble; observations are labeled separately. Local site and Health Service Area forecasts are not county or statewide estimates. A Corvid forecast is not a publisher projection and it is not a clinical, safety, or personal-risk statement. Confidence is shown so you can judge how much weight to give each number.</p>{activeResponse.errors.length ? <ul>{activeResponse.errors.map((error) => <li key={error.source}><b>{error.source}:</b> {error.message}</li>)}</ul> : null}</section>
      </>}
    </main></>;
}
function forecastSummaryText(observations: {
    date: string;
    value: number;
}[], estimates: {
    value: number;
    lower: number;
    upper: number;
    targetDate: string;
}[], direction: "higher-is-worse" | "lower-is-worse") {
    const latest = observations.at(-1)!;
    const forecast = estimates.at(-1)!;
    const trend = classifyForecastChange(latest.value, forecast.value);
    const outlook = forecastOutlook(trend, direction);
    const percent = formatForecastPercentChange(latest.value, forecast.value);
    return `The latest observed value is ${latest.value.toFixed(2)} on ${formatDate(latest.date)}. The model projects ${forecast.value.toFixed(2)} by ${formatDate(forecast.targetDate)}: ${forecastChangeLabel(trend).toLowerCase()}${percent ? ` (${percent})` : ""}. In plain terms, that is ${forecastOutlookLabel(outlook).toLowerCase()} for the selected month.`;
}
