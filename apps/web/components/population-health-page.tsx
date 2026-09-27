"use client";
import { AppSidebar } from "@/components/app-sidebar";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { formatOrdinal } from "@/lib/format";
import type { PopulationHealthResponse, PopulationMeasure, PopulationSignalContext } from "@/lib/population-health-contracts";
import { jurisdictionByCode, US_JURISDICTIONS } from "@/lib/us-geography";
import { HistoryMonthPicker } from "@/components/history-month-picker";
import { RavenLoadingScreen } from "@/components/raven-loading-screen";
import styles from "./population-health-page.module.css";
const HISTORY_START = "2018-01";
function monthLabel(period: string | null) {
    if (!period)
        return "Current evidence";
    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(period + "-01T00:00:00Z"));
}
function shortDate(value: string | null) {
    if (!value)
        return "Unavailable";
    const day = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
        return "Unavailable";
    const date = new Date(day + "T00:00:00Z");
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day)
        return "Unavailable";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}
function measureQuality(measure: PopulationMeasure) {
    return measure.quality ? measure.quality + " confidence" : measure.estimateType;
}
function signalEvidence(signal: PopulationSignalContext) {
    return signal.evidence === "modeled" ? "Modeled" : signal.evidence === "official" ? "Official" : signal.evidence === "planning" ? "Planning context" : "Observed";
}
function signalClass(signal: PopulationSignalContext) {
    return [styles.signal, signal.status === "partial" || signal.status === "stale" ? styles.signalPartial : "", signal.status === "unavailable" ? styles.signalUnavailable : ""].filter(Boolean).join(" ");
}
export function PopulationHealthPage({ context, counties }: {
    context: PopulationHealthResponse | null;
    counties: Array<{
        name: string;
        fips: string;
    }>;
}) {
    const router = useRouter();
    const [pending, setPending] = useState<{
        key: string;
        label: string;
        period: string;
    } | null>(null);
    const [isTransitioning, startTransition] = useTransition();
    const stateName = context?.selectedState ? jurisdictionByCode(context.selectedState)?.name : "No region selected";
    const countyName = context?.selectedCountyFips ? counties.find((county) => county.fips === context.selectedCountyFips)?.name : null;
    const geographyName = countyName && stateName ? `${countyName}, ${stateName}` : stateName;
    const contextKey = context ? (context.selectedState ?? "") + ":" + (context.selectedCountyFips ?? "") + ":" + (context.period ?? "current") : "picker";
    if (pending?.key === contextKey)
        setPending(null);
    const isPending = isTransitioning || Boolean(pending && pending.key !== contextKey);
    const maxPeriod = new Date().toISOString().slice(0, 7);
    function navigate(state: string, county: string, period: string) {
        const params = new URLSearchParams({ state });
        if (county)
            params.set("county", county);
        if (period)
            params.set("period", period);
        const label = jurisdictionByCode(state)?.name ?? state;
        setPending({ key: state + ":" + county + ":" + (period || "current"), label, period });
        startTransition(() => router.push("/population-health?" + params.toString()));
    }
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        navigate(String(form.get("state") ?? "MA"), String(form.get("county") ?? ""), String(form.get("period") ?? ""));
    }
    if (isPending && !context) {
        const target = pending?.period ? monthLabel(pending.period) : "the current evidence window";
        return <div className={styles.page}>
      <AppSidebar current="population-health" status={<><i data-state="loading"/>Loading population intelligence</>}/>
      <main id="main-content" className={styles.loadingMain}>
        <RavenLoadingScreen compact context="brief" title={"Reading " + (pending?.label ?? "your selected region")} detail={"Loading " + target + " and checking the available sources. Your brief will appear here when ready."}/>
      </main>

    </div>;
    }
    return <div className={styles.page}>
    <AppSidebar current="population-health" status={isPending ? <><i data-state="loading"/>Updating population intelligence</> : undefined}/>
    <main id="main-content">
      <section className={styles.intro}>
        <div className={styles.introCopy}>
          <h1>Population health</h1>
          <p>Denominators, vulnerability, access, prevention, and response capacity for the selected region.</p>
        </div>
        <div className={styles.introAside}>
          <span className={styles.asideLabel}>{context ? monthLabel(context.period) : "On-demand workspace"}</span>
          <strong>{geographyName}</strong>
          {context ? <span>{context.selectedCountyFips ? "County detail" : "State brief"}</span> : null}
        </div>
      </section>

      <section className={styles.controls} aria-label="Population health controls">
        <form key={contextKey} method="get" onSubmit={submit}>
          <label><span>State</span><select name="state" disabled={isPending} defaultValue={context?.selectedState ?? "MA"} onChange={(event) => {
            const county = event.currentTarget.form?.elements.namedItem("county");
            if (county instanceof HTMLSelectElement) {
                county.value = "";
                county.disabled = event.currentTarget.value !== context?.selectedState;
            }
        }}>{US_JURISDICTIONS.map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}</select></label>
          <label><span>County (optional)</span><select name="county" defaultValue={context?.selectedCountyFips ?? ""} disabled={!context || isPending}><option value="">{context ? "All available state context" : "Generate a state brief first"}</option>{counties.map((county) => <option key={county.fips} value={county.fips}>{county.name}</option>)}</select></label>
          <input type="hidden" name="period" value={context?.period ?? ""}/>
          <button type="submit" disabled={isPending}>{isPending ? "Loading brief" : context ? "Change region" : "Open state brief"}</button>
        </form>
        {context ? <HistoryMonthPicker ariaLabel="Population health historical month" label="Historical month" min={HISTORY_START} max={maxPeriod} value={context.period ?? ""} onChange={(period) => navigate(context.selectedState!, context.selectedCountyFips ?? "", period)} disabled={isPending}/> : null}
        <p className={styles.controlNote}>Choose a state to open its brief, then select a county for local detail. Your existing brief stays visible while another selection loads.</p>
      </section>

      {isPending && context ? <div className={styles.updating} role="status"><i data-state="loading" aria-hidden="true"/><span>Updating {pending?.label ?? geographyName}{pending?.period ? ` for ${monthLabel(pending.period)}` : ""}&hellip; the brief below is still the last loaded region.</span></div> : null}

      {!context ? <section className={styles.empty} aria-labelledby="population-empty-title">
        <div>
          <h2 id="population-empty-title">Choose a region to build its population health brief.</h2>
          <p>Select a state above to review its population, vulnerability, access to care, and response capacity. County choices become available after the state brief opens.</p>
        </div>
      </section> : <>
        <section className={styles.briefHeader} aria-labelledby="brief-title">
          <div>
            <p className="rubric">{geographyName} · {monthLabel(context.period)}</p>
            <h2 id="brief-title">{context.summary}</h2>
            <p className={styles.briefSubhead}>This is an evidence brief, not a diagnosis. A current value, a modeled estimate, an official outlook, and an unavailable value are different states and stay labeled as such.</p>
          </div>
          <dl className={styles.coverage}>
            <div><dt>Current measures</dt><dd>{context.coverage.available}</dd></div>
            <div><dt>Partial or stale</dt><dd>{context.coverage.partial}</dd></div>
            <div><dt>Unavailable</dt><dd>{context.coverage.unavailable}</dd></div>
          </dl>
        </section>

        {context.insights.length ? <section className={styles.insights} aria-labelledby="insights-title">
          <div className={styles.sectionHeading}><p className="rubric">Decision layer</p><h2 id="insights-title">What needs attention</h2><p>Priorities are derived from the evidence below. They are review prompts, not automatic operational orders.</p></div>
          <div className={styles.insightGrid}>{context.insights.map((insight) => <article className={styles.insight} data-priority={insight.priority} key={insight.id}>
            <div className={styles.insightTop}><span>{insight.priority}</span><span>{insight.category}</span></div>
            <h3>{insight.title}</h3>
            <p>{insight.summary}</p>
            <div className={styles.insightEvidence}><span>Evidence</span><strong>{insight.evidence.join(" · ")}</strong></div>
            <p className={styles.insightAction}><span>Suggested review</span>{insight.action}</p>
          </article>)}</div>
        </section> : <section className={styles.noInsights} aria-label="Decision layer"><p className="rubric">Decision layer</p><strong>No review prompts were generated from the available evidence.</strong><span>That means the available comparison set did not cross a rule threshold; it does not mean there is no local risk.</span></section>}

        {context.signals.length ? <section className={styles.signalSection} aria-labelledby="signals-title">
          <div className={styles.sectionHeading}><p className="rubric">Signal context</p><h2 id="signals-title">Surveillance context</h2><p>Review the latest available state observations alongside the population measures. Open Forecasts for modeled outlooks.</p></div>
          <div className={styles.signalGrid}>{context.signals.map((signal) => <article className={signalClass(signal)} data-status={signal.status} key={signal.id}>
            <div className={styles.signalTop}><span>{signalEvidence(signal)}</span><span>{signal.status}</span></div>
            <h3>{signal.label}</h3>
            <strong>{signal.displayValue}</strong>
            <p>{signal.pressurePercentile !== null && signal.pressurePercentile !== undefined ? formatOrdinal(signal.pressurePercentile) + " state pressure percentile · " : ""}{signal.note}</p>
            <dl><div><dt>{signal.id === "heatrisk" ? "Valid through" : "Observed through"}</dt><dd>{shortDate(signal.observedThrough)}</dd></div>{signal.forecast ? <div><dt>Prepared forecast</dt><dd>{signal.forecast.displayValue} by {shortDate(signal.forecast.targetDate)}</dd></div> : null}</dl>
          </article>)}</div>
        </section> : null}

        <div className={styles.status} data-status={context.status} role="status"><strong>{context.status === "current" ? "Brief loaded" : context.status === "unavailable" ? "Evidence unavailable" : "Brief loaded with gaps"}</strong><span>Retrieved {new Date(context.retrievedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })}. {context.coverage.label}.</span></div>

        <div className={styles.sections}>
          {context.sections.map((section, index) => <section className={styles.section} key={section.id} aria-labelledby={section.id + "-title"}>
            <div className={styles.sectionHeading}><p className="rubric">Evidence phase {String(index + 1).padStart(2, "0")}</p><h2 id={section.id + "-title"}>{section.title}</h2><p>{section.description}</p></div>
            <div className={styles.measureGrid}>{section.measures.map((measure) => <article className={styles.measure} data-status={measure.status} key={measure.id}>
              <div className={styles.measureTop}><span>{measure.geographyType}{measure.fips ? " · " + measure.fips : ""}</span><span>{measure.status}</span></div>
              <div className={styles.measureValue}><strong>{measure.displayValue}</strong>{measure.value !== null && measure.unit !== "—" && !measure.displayValue.endsWith(measure.unit) ? <span>{measure.unit}</span> : null}</div>
              <h3>{measure.label}</h3>
              {measure.change ? <p className={styles.change} data-trend={measure.trend}>{measure.change.displayValue} {measure.change.label}</p> : null}
              <p className={styles.measureNote}>{measure.note}</p>
              <dl><div><dt>Vintage</dt><dd>{measure.vintage || "Not published"}</dd></div><div><dt>Evidence</dt><dd>{measureQuality(measure)}</dd></div>{typeof measure.confidenceLow === "number" || typeof measure.confidenceHigh === "number" ? <div><dt>Range</dt><dd>{measure.confidenceLow ?? "—"} to {measure.confidenceHigh ?? "—"}</dd></div> : null}<div><dt>Source</dt><dd><a href={measure.sourceUrl} target="_blank" rel="noreferrer">{measure.source}</a></dd></div></dl>
            </article>)}</div>
          </section>)}
        </div>

        {context.errors.length ? <section className={styles.errors} aria-labelledby="source-notes-title"><p className="rubric">Source notes</p><h2 id="source-notes-title">Some connectors need attention.</h2><ul>{context.errors.map((error) => <li key={error.source + ":" + error.message}><strong>{error.source}</strong><span>{error.message}</span></li>)}</ul></section> : null}
        <section className={styles.sources} aria-labelledby="population-sources-title"><div className={styles.sectionHeading}><p className="rubric">Provenance</p><h2 id="population-sources-title">Expansion sources</h2><p>These measures provide context around Corvid signals. They do not replace surveillance, and they do not create a forecast when the source has no defensible estimate.</p></div><ul>{context.sources.map((source) => <li key={source.name}><strong>{source.name}</strong><span>{source.vintage} · {source.cadence}</span><a href={source.url} target="_blank" rel="noreferrer">Publisher source</a></li>)}</ul></section>
      </>}
    </main>

  </div>;
}
