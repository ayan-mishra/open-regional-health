"use client";
import { useEffect, useMemo, useState } from "react";
import { US_JURISDICTIONS } from "@/lib/us-geography";
type County = {
    fips: string;
    name: string;
};
type CountyGeometry = {
    counties: County[];
};
export type LocationValue = {
    stateCode: string;
    countyFips: string;
    countyName: string;
};
type LocationValidation = {
    field: "state" | "county";
    describedBy: string;
};
export function LocationPicker({ value, onChange, disabled = false, validation }: {
    value: LocationValue;
    onChange: (value: LocationValue) => void;
    disabled?: boolean;
    validation?: LocationValidation;
}) {
    const [counties, setCounties] = useState<County[]>([]);
    const [loadedFor, setLoadedFor] = useState("");
    const [failedFor, setFailedFor] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const selectedState = useMemo(() => US_JURISDICTIONS.find((state) => state.code === value.stateCode), [value.stateCode]);
    const loadError = failedFor === selectedState?.fips;
    const stateInvalid = validation?.field === "state";
    const countyInvalid = validation?.field === "county";
    const countyDescription = [loadError ? "county-load-error" : "", countyInvalid ? validation?.describedBy : ""].filter(Boolean).join(" ") || undefined;
    useEffect(() => {
        if (!selectedState)
            return;
        const controller = new AbortController();
        fetch(`/geometry/counties/${selectedState.fips}.json`, { signal: controller.signal })
            .then((response) => {
            if (!response.ok)
                throw new Error("County list unavailable");
            return response.json() as Promise<CountyGeometry>;
        })
            .then((body) => { setCounties(body.counties); setLoadedFor(selectedState.fips); setFailedFor(""); })
            .catch((error: unknown) => { if (!(error instanceof DOMException && error.name === "AbortError")) {
            setCounties([]);
            setFailedFor(selectedState.fips);
        } });
        return () => controller.abort();
    }, [selectedState, retryKey]);
    return <div className="location-fields">
    <label>State
      <select name="state" value={value.stateCode} disabled={disabled} required aria-invalid={stateInvalid || undefined} aria-describedby={stateInvalid ? validation?.describedBy : undefined} onChange={(event) => onChange({ stateCode: event.target.value, countyFips: "", countyName: "" })}>
        <option value="">Choose a state</option>
        {US_JURISDICTIONS.map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}
      </select>
    </label>
    <label>County
      <select name="county" value={value.countyFips} disabled={disabled || !selectedState || loadedFor !== selectedState.fips || loadError} required aria-invalid={loadError || countyInvalid || undefined} aria-describedby={countyDescription} onChange={(event) => {
            const county = counties.find((item) => item.fips === event.target.value);
            onChange({ ...value, countyFips: county?.fips ?? "", countyName: county?.name ?? "" });
        }}>
        <option value="">{selectedState && loadedFor !== selectedState.fips ? "Loading counties" : "Choose a county"}</option>
        {counties.map((county) => <option key={county.fips} value={county.fips}>{county.name} County</option>)}
      </select>
    </label>
    {loadError && <p id="county-load-error" role="alert">Could not load counties. <button type="button" disabled={disabled} onClick={() => setRetryKey((current) => current + 1)}>Try again</button></p>}
  </div>;
}
