"use client";
import { useEffect, useRef, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { NationalMap } from "@/components/national-map";
import { detailMatchesCounty } from "@/lib/county-name";
import type { NationalOutlookResponse } from "@/lib/national-contracts";
import { SIGNAL_CATALOG, SIGNAL_DOMAINS, type SignalDomain, type SignalId } from "@/lib/signal-catalog";
import type { CountyGeometry } from "@/lib/us-map-geometry";
import { US_JURISDICTIONS, type IncludedStateCode } from "@/lib/us-geography";
import { getCachedNationalOutlook, getCachedStateOutlook, loadNationalOutlook, loadSiteCountyGeometry, loadStateOutlook, primeNationalOutlook, primeStateOutlook } from "@/lib/site-snapshot";
import styles from "./national-dashboard.module.css";
import { HistoryMonthPicker } from "./history-month-picker";
const REFRESH_MS = 43200000;
const DOMAIN_LABELS: Record<SignalDomain, string> = {
    respiratory: "Respiratory",
    mosquito: "Mosquito-borne",
    ticks: "Tick-borne",
    notifiable: "Notifiable diseases",
    wastewater: "Wastewater",
    environment: "Environment",
    hospital: "Hospital burden",
    capacity: "Health-system capacity",
};
export function NationalDashboard({ initialSignal = "covid-ed", initialState = null, initialPeriod = "", initialOutlook: serverOutlook, initialStateOutlook: serverStateOutlook = null, allOutlooks = null }: {
    initialSignal?: SignalId;
    initialState?: IncludedStateCode | null;
    initialPeriod?: string;
    initialOutlook?: NationalOutlookResponse;
    initialStateOutlook?: NationalOutlookResponse | null;
    allOutlooks?: Map<SignalId, NationalOutlookResponse> | null;
}) {
    const [initialOutlook] = useState(() => {
        if (allOutlooks)
            for (const outlook of allOutlooks.values())
                primeNationalOutlook(outlook, initialPeriod);
        if (serverOutlook)
            primeNationalOutlook(serverOutlook, initialPeriod);
        return serverOutlook ?? getCachedNationalOutlook(initialSignal, initialPeriod);
    });
    const [signalId, setSignalId] = useState<SignalId>(initialSignal);
    const [selectedState, setSelectedState] = useState<IncludedStateCode | null>(initialState);
    const [period, setPeriod] = useState(initialPeriod);
    const [outlook, setOutlook] = useState<NationalOutlookResponse | null>(initialOutlook ?? null);
    const [outlookError, setOutlookError] = useState<string | null>(null);
    const [preserved, setPreserved] = useState(false);
    const [refreshing, setRefreshing] = useState(!initialOutlook);
    const [outlookRetryKey, setOutlookRetryKey] = useState(0);
    const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + REFRESH_MS);
    const [clock, setClock] = useState(() => Date.now());
    const [countyGeometries, setCountyGeometries] = useState<Partial<Record<IncludedStateCode, CountyGeometry>>>({});
    const [countyError, setCountyError] = useState(false);
    const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
    const [selectedCountyName, setSelectedCountyName] = useState<string | null>(null);
    const [stateOutlook, setStateOutlook] = useState<NationalOutlookResponse | null>(() => {
        if (serverStateOutlook)
            primeStateOutlook(serverStateOutlook, initialPeriod);
        return serverStateOutlook ?? (initialState ? getCachedStateOutlook(initialSignal, initialState, initialPeriod) : null);
    });
    const [stateRequestError, setStateRequestError] = useState<{
        key: string;
        message: string;
    } | null>(null);
    const [stateOutlookRetryKey, setStateOutlookRetryKey] = useState(0);
    const useServerOutlook = useRef(Boolean(serverOutlook));
    const useServerStateOutlook = useRef(Boolean(serverStateOutlook));
    useEffect(() => {
        const params = new URLSearchParams();
        params.set("signal", signalId);
        if (selectedState)
            params.set("state", selectedState);
        if (period)
            params.set("period", period);
        window.history.replaceState(null, "", `/dashboard?${params}`);
    }, [signalId, selectedState, period]);
    useEffect(() => {
        let active = true;
        const applyOutlook = (next: Awaited<ReturnType<typeof loadNationalOutlook>>) => {
            setOutlook(next);
            setOutlookError(null);
            setPreserved(false);
            setRefreshing(false);
        };
        const refresh = (force = false) => {
            setNextRefreshAt(Date.now() + REFRESH_MS);
            if (!force) {
                const cached = getCachedNationalOutlook(signalId, period);
                if (cached) {
                    applyOutlook(cached);
                    return;
                }
            }
            setRefreshing(true);
            setOutlookError(null);
            loadNationalOutlook(signalId, period, force).then((next) => {
                if (!active)
                    return;
                applyOutlook(next);
            })
                .catch((error: unknown) => {
                if (active && !(error instanceof DOMException && error.name === "AbortError")) {
                    setPreserved(Boolean(getCachedNationalOutlook(signalId, period)));
                    setOutlookError(error instanceof Error ? error.message : "National surveillance is temporarily unavailable.");
                    setRefreshing(false);
                }
            });
        };
        if (useServerOutlook.current && serverOutlook && signalId === initialSignal && period === initialPeriod && outlookRetryKey === 0) {
            useServerOutlook.current = false;
            applyOutlook(serverOutlook);
        }
        else
            refresh();
        const timer = window.setInterval(() => refresh(true), REFRESH_MS);
        return () => { active = false; window.clearInterval(timer); };
    }, [initialPeriod, initialSignal, outlookRetryKey, period, serverOutlook, signalId]);
    useEffect(() => {
        if (!selectedState || countyGeometries[selectedState])
            return;
        let active = true;
        loadSiteCountyGeometry(selectedState).then((geometry) => {
            if (!active)
                return;
            setCountyGeometries((current) => ({ ...current, [selectedState]: geometry }));
            setCountyError(false);
        }).catch(() => {
            if (active)
                setCountyError(true);
        });
        return () => { active = false; };
    }, [countyGeometries, selectedState]);
    useEffect(() => {
        if (!selectedState)
            return;
        if (useServerStateOutlook.current && signalId === initialSignal && selectedState === initialState && period === initialPeriod && stateOutlookRetryKey === 0) {
            useServerStateOutlook.current = false;
            return;
        }
        const requestKey = `${signalId}:${selectedState}:${period}:${stateOutlookRetryKey}`;
        const cached = stateOutlookRetryKey === 0 ? getCachedStateOutlook(signalId, selectedState, period) : null;
        if (cached)
            return;
        loadStateOutlook(signalId, selectedState, period, stateOutlookRetryKey > 0).then(setStateOutlook).catch((error: unknown) => {
            setStateRequestError({ key: requestKey, message: error instanceof Error ? error.message : "State detail is temporarily unavailable." });
        });
    }, [initialState, initialPeriod, initialSignal, period, selectedState, signalId, stateOutlookRetryKey]);
    useEffect(() => {
        const timer = window.setInterval(() => {
            setClock(Date.now());
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);
    const baseOutlook = outlook?.signal.id === signalId && (outlook.period ?? "") === period ? outlook : null;
    const cachedStateOutlook = selectedState && stateOutlookRetryKey === 0 ? getCachedStateOutlook(signalId, selectedState, period) : null;
    const matchingStateOutlook = cachedStateOutlook?.signal && Array.isArray(cachedStateOutlook.states)
        ? cachedStateOutlook
        : stateOutlook?.signal?.id === signalId && stateOutlook.selectedState === selectedState && (stateOutlook.period ?? "") === period ? stateOutlook : null;
    const stateRequestKey = selectedState ? `${signalId}:${selectedState}:${period}:${stateOutlookRetryKey}` : null;
    const stateOutlookError = stateRequestError?.key === stateRequestKey ? stateRequestError.message : null;
    const stateName = selectedState ? US_JURISDICTIONS.find((state) => state.code === selectedState)?.name ?? selectedState : null;
    const baseStateDetails = selectedState ? baseOutlook?.details.filter((detail) => detail.stateCode === selectedState || (!detail.stateCode && selectedState === "MA")) ?? [] : [];
    const activeOutlook = selectedState
        ? matchingStateOutlook ?? (baseOutlook ? { ...baseOutlook, scope: "state" as const, selectedState, details: baseStateDetails } : null)
        : (baseOutlook ? { ...baseOutlook, scope: "national" as const, selectedState: null, details: [] } : null);
    const mapOutlook = selectedState ? activeOutlook : baseOutlook;
    const selectState = (state: IncludedStateCode | null) => {
        setSelectedState(state);
        setSelectedDetailId(null);
        setSelectedCountyName(null);
        setCountyError(false);
    };
    const selectedReading = activeOutlook?.states.find((state) => state.code === selectedState);
    const presenceMode = activeOutlook?.signal.id === "b-miyamotoi-presence";
    const visibleDetails = activeOutlook?.details.filter((detail) => detail.value !== null) ?? [];
    const eligibleDetails = visibleDetails.filter((detail) => detail.comparisonEligible);
    const eligibleSites = eligibleDetails.filter((detail) => detail.geographyType === "site");
    const activeCountyGeometry = selectedState ? countyGeometries[selectedState] ?? null : null;
    const selectedCountyFips = /^missing:(\d{5})$/.exec(selectedDetailId ?? "")?.[1];
    const selectedCounty = selectedCountyFips ? activeCountyGeometry?.counties.find((county) => county.fips === selectedCountyFips) : null;
    const selectedDetail = visibleDetails.find((detail) => detail.id === selectedDetailId)
        ?? (selectedCounty ? eligibleDetails.find((detail) => detailMatchesCounty(detail, selectedCounty)) : undefined);
    const hasLocalizedDetail = eligibleDetails.some((detail) => detail.counties.length > 0);
    const availableStates = activeOutlook?.states.filter((state) => presenceMode ? state.value !== null : state.comparisonEligible).length ?? 0;
    const maxPeriod = new Date().toISOString().slice(0, 7);
    const supportsSubstateRequests = baseOutlook && ["county", "hsa", "site-to-county"].includes(baseOutlook.geography.level);
    const supportedStates = supportsSubstateRequests ? US_JURISDICTIONS : US_JURISDICTIONS.filter((state) => state.code === selectedState
        || baseOutlook?.states.some((reading) => reading.code === state.code && reading.value !== null)
        || baseOutlook?.details.some((detail) => detail.stateCode === state.code && detail.value !== null)
        || baseOutlook?.geography.countyDataStates.includes(state.code));
    const untilRefresh = Math.max(0, nextRefreshAt - clock);
    const refreshCountdown = `${String(Math.floor(untilRefresh / 3600000)).padStart(2, "0")}:${String(Math.floor(untilRefresh / 60000) % 60).padStart(2, "0")}:${String(Math.floor(untilRefresh / 1000) % 60).padStart(2, "0")}`;
    const selectSignal = (nextSignal: SignalId) => { setSignalId(nextSignal); setSelectedDetailId(null); setSelectedCountyName(null); };
    if (!outlook && outlookError)
        return <div className={styles.page}><AppSidebar current="dashboard" status={<><i data-state="unavailable"/>Dashboard unavailable</>}/><main id="main-content" className={styles.siteUpdating} role="alert"><strong>Signal could not load</strong><p>{outlookError}</p><button type="button" onClick={() => setOutlookRetryKey((current) => current + 1)}>Try again</button></main></div>;
    return <div className={styles.page}>
    <AppSidebar current="dashboard" status={<><i data-state={refreshing ? "loading" : preserved || activeOutlook?.isStale ? "stale" : activeOutlook?.status ?? "loading"}/>{refreshing ? "Updating signal" : preserved ? "Last valid issue" : <span suppressHydrationWarning>{`Next update ${refreshCountdown}`}</span>}</>}/>
    <main id="main-content">
      <section className={styles.intro}><h1>United States health signals</h1><span>Compare 48 states and Washington DC, then click a county to see its observation wherever county-level data exists.</span></section>
       {baseOutlook?.status === "partial" ? <aside className={styles.feedNotice} role="status"><strong>This publisher is delayed.</strong><span>{baseOutlook.errors.slice(0, 2).map((error) => `${error.source}: ${error.message}`).join(" ")}</span></aside> : null}
      <section className={styles.workbench} aria-label="United States health intelligence map">
        <aside className={styles.rail}><div className={styles.railTop}><strong>Signals</strong></div>
          <label className={styles.mobileSignalPicker}><span>Signal</span><select aria-label="Map signal" value={signalId} onChange={(event) => selectSignal(event.target.value as SignalId)}>{SIGNAL_DOMAINS.map((domain) => <optgroup key={domain} label={DOMAIN_LABELS[domain]}>{SIGNAL_CATALOG.filter((signal) => signal.domain === domain).map((signal) => <option key={signal.id} value={signal.id}>{signal.shortLabel}</option>)}</optgroup>)}</select></label>
          <div className={styles.signalList} aria-label="Map signals">{SIGNAL_DOMAINS.map((domain) => { const signals = SIGNAL_CATALOG.filter((signal) => signal.domain === domain); return signals.length ? <section className={styles.signalGroup} key={domain}><h3>{DOMAIN_LABELS[domain]}</h3>{signals.map((signal) => <button key={signal.id} aria-pressed={signal.id === signalId} aria-label={signal.label} onClick={() => selectSignal(signal.id)}>{signal.shortLabel}</button>)}</section> : null; })}</div>
          <HistoryMonthPicker ariaLabel="Historical month" label="Historical month" inset min="2018-01" max={maxPeriod} value={period} onChange={(nextPeriod) => { setPeriod(nextPeriod); }}/>
          <p>{presenceMode ? "Color marks documented CDC presence. Stripes mean no record; they do not mean absence." : "Colors compare only eligible peers for the same signal and period. Stripes mean no comparable observation."}</p>
        </aside>
        <div className={styles.mapPanel}>
          <div className={styles.mapHead}><div><span>{selectedState ? selectedReading?.name ?? US_JURISDICTIONS.find((state) => state.code === selectedState)?.name : "National overview"}</span><h2>{activeOutlook?.signal.label ?? SIGNAL_CATALOG.find((signal) => signal.id === signalId)?.label}</h2></div><div className={styles.stateActions}>{selectedState && <button aria-label="Back to United States" onClick={() => selectState(null)}>&larr; United States</button>}<label><span>State or district</span><select aria-label="Choose a state" value={selectedState ?? ""} onChange={(event) => selectState(event.target.value ? event.target.value as IncludedStateCode : null)}><option value="">United States</option>{supportedStates.map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}</select></label></div></div>
          <div className={styles.mapFrame}>
            {selectedState && countyError ? <div className={styles.loading} role="alert"><strong>County boundaries for {stateName} are unavailable.</strong><button type="button" onClick={() => { setCountyError(false); setStateOutlookRetryKey((current) => current + 1); loadSiteCountyGeometry(selectedState, true).then((geometry) => { setCountyGeometries((current) => ({ ...current, [selectedState]: geometry })); }).catch(() => setCountyError(true)); }}>Try again</button></div> : selectedState && !activeCountyGeometry ? <div className={styles.loading} role="status"><strong>{`Loading ${stateName} map`}</strong></div> : mapOutlook ? <NationalMap outlook={mapOutlook} selectedState={selectedState} countyGeometry={activeCountyGeometry} onSelectState={selectState} selectedDetailId={selectedDetailId} selectedCountyName={selectedCountyName} onSelectDetail={(id, countyName) => { setSelectedDetailId(id); setSelectedCountyName(countyName ?? null); }}/> : <div className={styles.loading} role={outlookError ? "alert" : "status"}><strong>{outlookError ?? `Loading ${SIGNAL_CATALOG.find((signal) => signal.id === signalId)?.shortLabel}`}</strong>{outlookError ? <button type="button" onClick={() => setOutlookRetryKey((current) => current + 1)}>Try again</button> : null}</div>}
          </div>
          <div className={styles.legend}>{presenceMode ? <><span><i className={styles.high}/>Documented presence</span><span><i className={styles.hatch}/>No record; absence not inferred</span></> : <><span><i className={styles.best}/>Lowest relative level</span><span><i className={styles.middle}/>Middle</span><span><i className={styles.high}/>Highest relative level</span><span><i className={styles.hatch}/>No comparable data</span></>}</div>
        </div>
        <aside className={styles.readout} aria-label="Selected geography and signal" aria-live="polite"><p>{selectedState ? selectedCountyName ? "county" : selectedDetail ? selectedDetail.geographyType.replace("-", " ") : "Selected state" : "Coverage"}</p><h2>{selectedCountyName ?? selectedDetail?.name ?? selectedReading?.name ?? "Contiguous United States"}</h2>{eligibleSites.length ? <label><span>Reporting site</span><select aria-label="Reporting site" value={selectedDetail?.id ?? ""} onChange={(event) => { setSelectedDetailId(event.target.value || null); setSelectedCountyName(null); }}><option value="">{selectedReading?.value !== null && selectedReading?.value !== undefined ? "Statewide" : "Choose a reporting site"}</option>{eligibleSites.map((detail) => <option key={detail.id} value={detail.id}>{detail.name}</option>)}</select></label> : null}<div className={styles.metric}><strong>{selectedCountyName && (!selectedDetail || selectedDetail.geographyType === "state") ? presenceMode ? "No documented presence record" : "County data unavailable" : selectedDetail?.displayValue ?? selectedReading?.displayValue ?? (selectedState && hasLocalizedDetail ? "County detail available" : `${availableStates} / 49`)}</strong><span>{selectedState ? activeOutlook?.signal.unit : presenceMode ? "states with documented presence" : "states with comparable observations"}</span></div><p className={styles.detail}>{selectedCountyName && selectedDetail?.geographyType === "hsa" ? `${selectedCountyName} shares this Health Service Area observation. It is not a separate county estimate. ${selectedDetail.note}` : selectedCountyName && (!selectedDetail || selectedDetail.geographyType === "state") ? presenceMode ? "CDC has no documented B. miyamotoi presence record for this county. This does not mean the pathogen is absent; sampling or reporting may be unavailable." : `${activeOutlook?.geography.message ?? "County data are unavailable."}${selectedReading?.displayValue && selectedReading.value !== null ? ` The statewide value is ${selectedReading.displayValue}.` : ""}` : selectedDetail?.note ?? selectedReading?.note ?? (selectedState && hasLocalizedDetail ? "The publisher provides local observations for this state, but not a defensible statewide estimate. Choose a county or reporting site to inspect the available detail." : "Select a state to load its counties and finest defensible public detail.")}</p><dl><div><dt>{signalId === "heatrisk" ? "Outlook valid through" : "Observed through"}</dt><dd>{selectedDetail?.observedThrough ?? selectedReading?.observedThrough ?? "Varies by state"}</dd></div><div><dt>Publisher</dt><dd>{activeOutlook?.signal.source ?? "Connecting"}</dd></div><div><dt>Geography</dt><dd>{activeOutlook?.geography.level ?? "Checking"}</dd></div></dl>{stateOutlookError ? <p className={styles.error}>{stateOutlookError}</p> : null}{activeOutlook?.errors.map((error) => <p className={styles.error} key={error.source}>{error.source}: {error.message}</p>)}</aside>
      </section>
      <section className={styles.disclosure}><div><span>Geographic coverage</span><h2>Counties are selectable wherever county-level data exists. Every limitation is explicit.</h2></div><p>{activeOutlook?.geography.message ?? "Loading publisher geography."}</p></section>
    </main>

  </div>;
}
