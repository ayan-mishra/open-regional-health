import type { Metadata } from "next";
import { NationalDashboard } from "@/components/national-dashboard";
import { getNationalOutlook } from "@/lib/national-live";
import { getCachedServerOutlookSnapshot, getServerOutlookSnapshot } from "@/lib/server-public-snapshot";
import { SIGNAL_CATALOG, isSignalId } from "@/lib/signal-catalog";
import { isIncludedJurisdiction } from "@/lib/us-geography";
export const metadata: Metadata = {
    title: "United States health dashboard",
    description: "Current disease, environmental, and health system signals across the contiguous United States.",
};
export default async function DashboardPage({ searchParams }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const signal = typeof params.signal === "string" && isSignalId(params.signal) ? params.signal : "covid-ed";
    const state = typeof params.state === "string" && isIncludedJurisdiction(params.state) ? params.state : null;
    const currentPeriod = new Date().toISOString().slice(0, 7);
    const period = typeof params.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.period) && params.period >= "2018-01" && params.period <= currentPeriod ? params.period : "";
    const [initialOutlook, initialStateOutlook] = await Promise.all([
        getServerOutlookSnapshot(signal, period),
        state ? getNationalOutlook({ signalId: signal, stateCode: state, period: period || null }) : null,
    ]);
    const allOutlooks = period ? null : new Map(SIGNAL_CATALOG.flatMap((catalogSignal) => {
        const cached = getCachedServerOutlookSnapshot(catalogSignal.id, "", false);
        return cached ? [[catalogSignal.id, cached] as const] : [];
    }));
    return <NationalDashboard initialSignal={signal} initialState={state} initialPeriod={period} initialOutlook={initialOutlook} initialStateOutlook={initialStateOutlook} allOutlooks={allOutlooks}/>;
}
