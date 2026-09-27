import "server-only";
import type { NationalFeedResponse, NationalOutlook } from "@/lib/national-contracts";
import { SIGNAL_CATALOG, type SignalDefinition, type SignalId } from "@/lib/signal-catalog";
type FeedInput = Omit<NationalFeedResponse, "catalog" | "outlooks"> & {
    catalog?: readonly SignalDefinition[];
    outlooks: Record<SignalId, NationalOutlook & {
        catalog?: readonly SignalDefinition[];
    }>;
};
export function compactNationalFeed(feed: FeedInput): NationalFeedResponse {
    const outlooks = Object.fromEntries(Object.entries(feed.outlooks).map(([signalId, value]) => {
        const { catalog, ...outlook } = value;
        void catalog;
        return [signalId, outlook];
    })) as NationalFeedResponse["outlooks"];
    return { ...feed, catalog: SIGNAL_CATALOG, outlooks };
}
