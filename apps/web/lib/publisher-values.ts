import { z } from "zod";
function blankToUndefined(value: unknown) {
    return value === null || value === undefined || (typeof value === "string" && value.trim() === "") ? undefined : value;
}
export const publisherNumber = z.preprocess(blankToUndefined, z.coerce.number().finite());
export const optionalPublisherNumber = z.preprocess(blankToUndefined, z.coerce.number().finite().optional());
export const nonNegativePublisherNumber = publisherNumber.pipe(z.number().nonnegative());
export const optionalNonNegativePublisherNumber = optionalPublisherNumber.pipe(z.number().nonnegative().optional());
export const nonNegativePublisherInteger = publisherNumber.pipe(z.number().int().nonnegative());
export const publisherPercentage = nonNegativePublisherNumber.pipe(z.number().max(100));
export const optionalPublisherPercentage = optionalNonNegativePublisherNumber.pipe(z.number().max(100).optional());
export function parseTrustedRows<T>(schema: z.ZodType<T>, rows: readonly unknown[]): T[] {
    const trusted: T[] = [];
    for (const row of rows) {
        const parsed = schema.safeParse(row);
        if (parsed.success)
            trusted.push(parsed.data);
    }
    if (rows.length && !trusted.length)
        throw new Error("Every publisher row failed validation.");
    return trusted;
}
