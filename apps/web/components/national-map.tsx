"use client";
import { hasRelativePeerCohort, RELATIVE_MAP_COLORS, relativeMapFill } from "@/lib/relative-map-colors";
import { countyDisplayName, countyMatches, detailMatchesCounty } from "@/lib/county-name";
import type { NationalForecastEvidence, NationalOutlook } from "@/lib/national-contracts";
import { US_MAP_VIEWBOX, US_STATE_GEOMETRY, type CountyGeometry, type CountyPath } from "@/lib/us-map-geometry";
import type { IncludedStateCode } from "@/lib/us-geography";
import styles from "./national-map.module.css";
const CALLOUTS: Partial<Record<IncludedStateCode, {
    x: number;
    y: number;
}>> = {
    DC: { x: 901, y: 210 }, DE: { x: 901, y: 166 }, RI: { x: 901, y: 122 },
};
function mapValue(value: number) {
    return value.toFixed(2);
}
function stateTooltip(name: string, displayValue: string, mode: "level" | "change", current: number | null, forecast: number | null, evidenceKind?: NationalForecastEvidence["kind"], hasLocalizedDetail = false, statewideValue: number | null = null) {
    if (statewideValue === null && hasLocalizedDetail)
        return `${name}: county or reporting-site detail is available, but the publisher does not provide a defensible statewide estimate.`;
    if ((evidenceKind === "planning" || evidenceKind === "none") && forecast === null) {
        return mode === "change"
            ? `${name}: no numerical forecast is available for this signal. Latest published value: ${displayValue}.`
            : `${name}: latest published value ${displayValue}. No numerical forecast is available for this signal.`;
    }
    if (mode === "change" && current !== null && forecast !== null) {
        const delta = Number((forecast - current).toFixed(2));
        const comparison = delta === 0 ? "about the same as now" : `${delta > 0 ? "higher" : "lower"} than now by ${mapValue(Math.abs(delta))}`;
        const projectionLabel = evidenceKind === "official" ? "publisher outlook" : "forecast";
        return `${name}: ${projectionLabel} ${mapValue(forecast)}; latest observed ${mapValue(current)}; ${comparison}.`;
    }
    if (mode === "change")
        return `${name}: forecast comparison is unavailable; published value is ${displayValue}.`;
    if (evidenceKind === "official") {
        return `${name}: publisher outlook ${forecast === null ? displayValue : mapValue(forecast)}.`;
    }
    if (forecast !== null) {
        return `${name}: forecast ${mapValue(forecast)}.`;
    }
    return `${name}: current observed value ${displayValue}.`;
}
export function NationalMap({ outlook, selectedState, countyGeometry, onSelectState, selectedDetailId = null, selectedCountyName = null, onSelectDetail = () => undefined, mode = "level", currentByState = {}, forecastByState = {}, evidenceKind }: {
    outlook: NationalOutlook;
    selectedState: IncludedStateCode | null;
    countyGeometry: CountyGeometry | null;
    onSelectState: (state: IncludedStateCode) => void;
    selectedDetailId?: string | null;
    selectedCountyName?: string | null;
    onSelectDetail?: (id: string, countyName?: string) => void;
    mode?: "level" | "change";
    currentByState?: Partial<Record<IncludedStateCode, number | null>>;
    forecastByState?: Partial<Record<IncludedStateCode, number | null>>;
    evidenceKind?: NationalForecastEvidence["kind"];
}) {
    const presenceMode = outlook.signal.id === "b-miyamotoi-presence";
    const supportsSubstateRequests = ["county", "hsa", "site-to-county"].includes(outlook.geography.level);
    const statePeers = outlook.states.filter((state) => state.comparisonEligible && state.value !== null).map((state) => state.value as number);
    const direction = outlook.signal.direction;
    const eligibleDetails = outlook.details.filter((detail) => detail.value !== null && (presenceMode ? detail.publisherEligible === true : detail.comparisonEligible));
    const selectedDetail = outlook.details.find((detail) => detail.id === selectedDetailId);
    const selectedCountyFips = /^missing:(\d{5})$/.exec(selectedDetailId ?? "")?.[1]
        ?? (selectedDetail?.geographyType === "county" ? /(?:^|:)(\d{5})$/.exec(selectedDetail.id)?.[1] : undefined);
    const countyIsSelected = (county: CountyPath) => selectedCountyFips
        ? county.fips === selectedCountyFips
        : Boolean(selectedCountyName && countyMatches(selectedCountyName, county.name, county.fips));
    if (selectedState && countyGeometry) {
        const selected = outlook.states.find((state) => state.code === selectedState);
        const details = outlook.details.filter((detail) => detail.value !== null);
        const detailPeers = eligibleDetails.map((detail) => detail.value as number);
        const localized = details.some((detail) => detail.counties.length > 0);
        if (!supportsSubstateRequests && !localized && selected?.value !== null && selected?.value !== undefined) {
            const statewideFill = selected?.value === null || selected?.value === undefined || !selected.comparisonEligible || !hasRelativePeerCohort(statePeers) ? "url(#national-hatch)" : relativeMapFill(selected.value, statePeers, direction);
            return <div className={styles.countyMap}><p className={styles.countyPicker} role="note" aria-label="Statewide observation only">Statewide observation only</p><svg className={styles.map} viewBox={countyGeometry.viewBox} role="img" aria-label={`${selected?.name ?? selectedState} statewide observation; ${outlook.signal.label} is only available statewide, county detail is not selectable`}>
        <defs><Hatch /></defs>
        <path d={countyGeometry.statePath} fill={statewideFill} className={styles.stateOnly}><title>{`${selected?.name ?? selectedState}: statewide value ${selected.displayValue}. County detail is not published for this signal.`}</title></path>
      </svg></div>;
        }
        const pickerCounties = countyGeometry.counties;
        return <div className={styles.countyMap}><CountyPicker counties={pickerCounties} selectedCountyName={selectedCountyName} selectedCountyFips={selectedCountyFips} onSelectCounty={(county) => {
                const matches = eligibleDetails.filter((item) => detailMatchesCounty(item, county));
                const detail = matches.sort((left, right) => direction === "higher-is-worse" ? (right.value ?? 0) - (left.value ?? 0) : (left.value ?? 0) - (right.value ?? 0))[0];
                onSelectDetail(detail?.id ?? `missing:${county.fips}`, countyDisplayName(county));
            }}/><svg className={styles.map} viewBox={countyGeometry.viewBox} role="group" aria-label={`${selected?.name ?? selectedState} ${outlook.signal.label} detail map`}>
      <defs><Hatch /></defs>
      {countyGeometry.counties.map((county) => {
                const matches = eligibleDetails.filter((item) => detailMatchesCounty(item, county));
                const detail = matches.sort((left, right) => direction === "higher-is-worse" ? (right.value ?? 0) - (left.value ?? 0) : (left.value ?? 0) - (right.value ?? 0))[0];
                const value = detail?.value;
                const fill = value === null || value === undefined ? "url(#national-hatch)" : presenceMode ? RELATIVE_MAP_COLORS.high : !hasRelativePeerCohort(detailPeers) ? "url(#national-hatch)" : relativeMapFill(value, detailPeers, direction);
                const displayName = countyDisplayName(county);
                const isSelected = countyIsSelected(county) || (!selectedCountyName && selectedDetailId === detail?.id);
                const tooltip = detail ? `${displayName}: ${detail.displayValue}. ${detail.note}` : `${displayName}: no published value for this signal.`;
                return <path key={county.fips} d={county.path} fill={fill} className={`${styles.county} ${isSelected ? styles.selected : ""}`} aria-hidden="true" focusable="false" onClick={() => onSelectDetail(detail?.id ?? `missing:${county.fips}`, displayName)}><title>{tooltip}</title></path>;
            })}
    </svg><ul className={styles.accessibleSummary} aria-label="County values">{countyGeometry.counties.map((county) => {
                const detail = eligibleDetails.find((item) => detailMatchesCounty(item, county));
                return <li key={county.fips}>{detail ? `${countyDisplayName(county)}: ${detail.displayValue}. ${detail.note}` : `${countyDisplayName(county)}: no published value for this signal.`}</li>;
            })}</ul></div>;
    }
    const stateTooltips = US_STATE_GEOMETRY.map((shape) => {
        const reading = outlook.states.find((state) => state.code === shape.code);
        const hasLocalizedDetail = eligibleDetails.some((detail) => detail.stateCode === shape.code && detail.counties.length > 0);
        return stateTooltip(reading?.name ?? shape.code, reading?.displayValue ?? "No published value", mode, currentByState[shape.code] ?? null, forecastByState[shape.code] ?? null, evidenceKind, hasLocalizedDetail, reading?.value ?? null);
    });
    return <><svg className={styles.map} viewBox={US_MAP_VIEWBOX} role="group" aria-label={`${outlook.signal.label} across the contiguous United States`}>
    <defs><Hatch /></defs>
    {US_STATE_GEOMETRY.map((shape) => {
            const reading = outlook.states.find((state) => state.code === shape.code);
            const hasEligibleDetail = eligibleDetails.some((detail) => detail.stateCode === shape.code);
            const selectable = supportsSubstateRequests || (reading?.value !== null && reading?.value !== undefined) || hasEligibleDetail;
            const change = reading ? (forecastByState[shape.code] ?? null) !== null && (currentByState[shape.code] ?? null) !== null ? (forecastByState[shape.code] as number) - (currentByState[shape.code] as number) : null : null;
            const mapValue = mode === "change" ? change : reading?.value;
            const peers = mode === "change"
                ? outlook.states.map((state) => (forecastByState[state.code] ?? null) !== null && (currentByState[state.code] ?? null) !== null ? (forecastByState[state.code] as number) - (currentByState[state.code] as number) : null).filter((value): value is number => value !== null)
                : statePeers;
            const fill = mode === "change" && mapValue !== null && mapValue !== undefined && hasRelativePeerCohort(peers)
                ? relativeMapFill(mapValue, peers, direction)
                : presenceMode && reading?.value !== null && reading?.value !== undefined
                    ? RELATIVE_MAP_COLORS.high
                    : mapValue === null || mapValue === undefined || !reading?.comparisonEligible
                        ? "url(#national-hatch)"
                        : hasRelativePeerCohort(peers)
                            ? relativeMapFill(mapValue, peers, direction)
                            : reading.countyAggregation
                                ? RELATIVE_MAP_COLORS.good
                                : "url(#national-hatch)";
            const callout = CALLOUTS[shape.code];
            const tooltip = stateTooltip(reading?.name ?? shape.code, reading?.displayValue ?? "No published value", mode, currentByState[shape.code] ?? null, forecastByState[shape.code] ?? null, evidenceKind, hasEligibleDetail, reading?.value ?? null);
            return <g key={shape.code}>
        <path d={shape.path} fill={fill} className={`${styles.state} ${callout ? styles.smallShape : ""}`} aria-hidden="true" focusable="false" onClick={!callout && selectable ? () => onSelectState(shape.code) : undefined}><title>{tooltip}</title></path>
        {callout && <g aria-hidden="true" focusable="false" className={styles.callout} onClick={selectable ? () => onSelectState(shape.code) : undefined}>
          <title>{tooltip}</title>
          <line x1={shape.centroid[0]} y1={shape.centroid[1]} x2={callout.x} y2={callout.y} aria-hidden="true"/>
          <rect x={callout.x - 14} y={callout.y - 14} width="28" height="28" rx="4" fill={fill}/>
          <text x={callout.x - 20} y={callout.y + 4} textAnchor="end">{shape.code}</text>
        </g>}
      </g>;
        })}
  </svg><ul className={styles.accessibleSummary} aria-label="State values">{stateTooltips.map((tooltip) => <li key={tooltip}>{tooltip}</li>)}</ul></>;
}
function Hatch() {
    return <pattern id="national-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="9" height="9" fill="#25362e"/><rect width="2.5" height="9" fill="#71847a"/></pattern>;
}
function CountyPicker({ counties, selectedCountyName, selectedCountyFips, onSelectCounty }: {
    counties: readonly CountyPath[];
    selectedCountyName: string | null;
    selectedCountyFips?: string;
    onSelectCounty: (county: CountyPath) => void;
}) {
    const selected = counties.find((county) => selectedCountyFips ? county.fips === selectedCountyFips : selectedCountyName && countyMatches(selectedCountyName, county.name, county.fips));
    return <label className={styles.countyPicker}><span>County</span><select aria-label="Choose a county" value={selected?.fips ?? ""} onChange={(event) => {
            const county = counties.find((item) => item.fips === event.target.value);
            if (county)
                onSelectCounty(county);
        }}><option value="">Choose a county</option>{counties.map((county) => <option key={county.fips} value={county.fips}>{countyDisplayName(county)}</option>)}</select></label>;
}
