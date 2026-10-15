import { TIME_RANGES, type TimeRangeKey } from "@/lib/data/time-ranges";

/**
 * Shared parsing of dashboard URL state.
 *
 * Next.js passes `searchParams` as `string | string[] | undefined`, so every
 * value is untrusted and may be an array (from a repeated query key). These
 * helpers normalise that into something a query can use without each page
 * repeating the same defensive dance.
 */

export function firstValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A valid time-range key, defaulting to 24h. */
export function parseRange(value: string | string[] | undefined): TimeRangeKey {
  const raw = firstValue(value);
  const match = TIME_RANGES.find((range) => range.key === raw);
  return match?.key ?? "24h";
}

/** ISO lower bound for a range key, relative to now. */
export function rangeSince(range: TimeRangeKey, now: number = Date.now()): string {
  const minutes =
    TIME_RANGES.find((entry) => entry.key === range)?.minutes ?? 60 * 24;
  return new Date(now - minutes * 60_000).toISOString();
}

/** A trace status filter, or undefined when absent/unrecognised. */
export function parseStatus(
  value: string | string[] | undefined,
): "ok" | "error" | "running" | undefined {
  const raw = firstValue(value);
  if (raw === "ok" || raw === "error" || raw === "running") return raw;
  return undefined;
}

/** A trimmed search string, or undefined when empty. */
export function parseQuery(
  value: string | string[] | undefined,
): string | undefined {
  const raw = firstValue(value)?.trim();
  return raw ? raw.slice(0, 100) : undefined;
}

/** A project id from the URL, constrained to a plausible uuid. */
export function parseProjectId(
  value: string | string[] | undefined,
): string | null {
  const raw = firstValue(value);
  if (!raw) return null;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuid.test(raw) ? raw : null;
}
