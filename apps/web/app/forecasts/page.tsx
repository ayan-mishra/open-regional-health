import type { Metadata } from "next";
import { ForecastsPage } from "@/components/forecasts-page";
import { getCachedServerForecastSnapshot } from "@/lib/server-public-snapshot";
import { SIGNAL_CATALOG, type SignalId } from "@/lib/signal-catalog";
import { isIncludedJurisdiction, type IncludedStateCode } from "@/lib/us-geography";
export const metadata: Metadata = { title: "Forecasts", description: "Transparent health forecasts across the contiguous United States with uncertainty and backtest evidence." };
export default async function Page({ searchParams }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const modeledSignals = SIGNAL_CATALOG.filter((signal) => signal.defaultEvidence === "modeled");
    const rawSignal = typeof params.signal === "string" ? params.signal : "";
    const signal = (modeledSignals.some((item) => item.id === rawSignal) ? rawSignal : "covid-ed") as SignalId;
    const rawState = typeof params.state === "string" ? params.state.toUpperCase() : "";
    const state = isIncludedJurisdiction(rawState) ? rawState as IncludedStateCode : null;
    const currentPeriod = new Date().toISOString().slice(0, 7);
    const rawPeriod = typeof params.period === "string" ? params.period : "";
    const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawPeriod) && rawPeriod >= "2018-01" && rawPeriod <= currentPeriod ? rawPeriod : "";
    const initialForecast = getCachedServerForecastSnapshot(signal, period);
    const initialForecasts = initialForecast ? { [signal]: initialForecast } : {};
    return <ForecastsPage initialForecasts={initialForecasts} initialSignal={signal} initialState={state} initialPeriod={period}/>;
}
