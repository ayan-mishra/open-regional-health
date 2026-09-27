const dateFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
});
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
});
const ordinalRules = new Intl.PluralRules("en-US", { type: "ordinal" });
const ordinalSuffix = { zero: "th", one: "st", two: "nd", few: "rd", many: "th", other: "th" } as const;
export function formatDate(value: string): string {
    return dateFormatter.format(new Date(value));
}
export function formatDateTime(value: string): string {
    return dateTimeFormatter.format(new Date(value));
}
export function formatPercent(value: number | null): string {
    return value === null ? "Not available" : `${Math.round(value * 100)}%`;
}
export function formatOrdinal(value: number): string {
    const rounded = Math.round(value);
    return `${rounded}${ordinalSuffix[ordinalRules.select(rounded)]}`;
}
export function titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
