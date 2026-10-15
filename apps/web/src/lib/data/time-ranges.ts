/**
 * Time-range options for the dashboard.
 *
 * Extracted from the fixture module so the persisted-data path has no
 * dependency on `src/data/mock.ts`. The mock module now re-exports these for
 * backwards compatibility with anything still using it.
 */

export type TimeRangeKey = "1h" | "24h" | "7d" | "30d";

export interface TimeRange {
  key: TimeRangeKey;
  label: string;
  minutes: number;
}

export const TIME_RANGES: readonly TimeRange[] = [
  { key: "1h", label: "Last hour", minutes: 60 },
  { key: "24h", label: "Last 24 hours", minutes: 60 * 24 },
  { key: "7d", label: "Last 7 days", minutes: 60 * 24 * 7 },
  { key: "30d", label: "Last 30 days", minutes: 60 * 24 * 30 },
] as const;
