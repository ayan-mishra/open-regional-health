export const RELATIVE_MAP_COLORS = {
    extremelyGood: "#00e676",
    superGood: "#2fbd78",
    good: "#69b98f",
    middle: "#f4d35e",
    elevated: "#f29e4c",
    high: "#d1495b",
} as const;
export type RelativeDirection = "higher-is-worse" | "lower-is-worse";
export function hasRelativePeerCohort(peerValues: readonly number[], minimum = 4) {
    return peerValues.filter(Number.isFinite).length >= minimum;
}
export function relativeMapFill(value: number, peerValues: readonly number[], direction: RelativeDirection = "higher-is-worse") {
    const finite = peerValues.filter(Number.isFinite);
    if (!Number.isFinite(value) || !finite.length)
        return RELATIVE_MAP_COLORS.good;
    const rankedValues = [...new Set(finite)].sort((left, right) => left - right);
    if (rankedValues.length === 1)
        return RELATIVE_MAP_COLORS.good;
    const position = rankedValues.indexOf(value) / (rankedValues.length - 1);
    const health = direction === "lower-is-worse" ? position : 1 - position;
    if (health < .2)
        return RELATIVE_MAP_COLORS.high;
    if (health < .4)
        return RELATIVE_MAP_COLORS.elevated;
    if (health < .6)
        return RELATIVE_MAP_COLORS.middle;
    if (health < .8)
        return RELATIVE_MAP_COLORS.good;
    if (health < .95)
        return RELATIVE_MAP_COLORS.superGood;
    return RELATIVE_MAP_COLORS.extremelyGood;
}
