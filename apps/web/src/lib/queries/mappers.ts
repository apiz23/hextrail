import { getDurationMs } from "@hextrail/sdk";

import type {
  SpanKind,
  TraceDetail,
  TraceListItem,
  TraceSpan,
  TraceSpanError,
  TraceStatus,
} from "@/lib/queries/types";
import { SPAN_KINDS } from "@/lib/queries/types";

/**
 * Database row -> view model.
 *
 * Every value the UI shows comes through here. That keeps two things honest:
 *   1. Nothing in the UI reaches into a raw row and guesses a column name.
 *   2. Bad data is normalised in one place instead of crashing a component.
 *
 * Rows arriving from PostgREST are `unknown`-ish by design: the generated types
 * are not available, so each field is narrowed defensively. A malformed row
 * degrades to a sensible default rather than throwing during render.
 */

/** Raw `hx_traces` row with its embedded project. */
export interface TraceRow {
  id: string;
  project_id: string;
  external_trace_id: string;
  name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  environment: string | null;
  metadata?: unknown;
  hx_projects?: { name: string | null } | null;
  hx_spans?: { count: number }[] | null;
}

/** Raw `hx_spans` row. */
export interface SpanRow {
  id: string;
  external_span_id: string;
  parent_external_span_id: string | null;
  name: string;
  kind: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  attributes: unknown;
  error: unknown;
}

/** Coerces an arbitrary value to a plain JSON object, defaulting to `{}`. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Maps a raw status string onto the known set, defaulting to "running". */
export function asTraceStatus(value: unknown): TraceStatus {
  if (value === "ok" || value === "error" || value === "running") return value;
  return "running";
}

/** Maps a raw span kind onto the known set, defaulting to "custom". */
export function asSpanKind(value: unknown): SpanKind {
  if (typeof value === "string" && (SPAN_KINDS as readonly string[]).includes(value)) {
    return value as SpanKind;
  }
  return "custom";
}

/**
 * Narrows the `error` jsonb column.
 *
 * The ingesting schema requires `{ name, message }`, but the column is free
 * jsonb, so this validates rather than casts. An unrecognised shape becomes
 * null instead of rendering `undefined` inside the error panel.
 */
export function asSpanError(value: unknown): TraceSpanError | null {
  const record = asRecord(value);
  const name = record.name;
  const message = record.message;
  if (typeof name !== "string" || typeof message !== "string") return null;
  if (name === "" || message === "") return null;
  return { name, message };
}

/**
 * Duration in whole milliseconds.
 *
 * Uses the SDK's `getDurationMs` so the dashboard and the ingestion contract
 * cannot drift. An unended trace (still running) has no duration — the SDK
 * throws on that, so it is handled before the call.
 */
export function durationMs(
  startedAt: string,
  endedAt: string | null,
): number {
  if (!endedAt) return 0;
  try {
    return getDurationMs(startedAt, endedAt);
  } catch {
    return 0;
  }
}

/** PostgREST returns embedded counts as `[{ count: n }]`. */
function readEmbeddedCount(value: { count: number }[] | null | undefined): number {
  if (!Array.isArray(value) || value.length === 0) return 0;
  const first = value[0];
  return typeof first?.count === "number" ? first.count : 0;
}

export function mapTraceRow(row: TraceRow): TraceListItem {
  return {
    id: row.id,
    externalId: row.external_trace_id,
    projectId: row.project_id,
    projectName: row.hx_projects?.name ?? "Unknown project",
    name: row.name,
    status: asTraceStatus(row.status),
    environment: row.environment,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: durationMs(row.started_at, row.ended_at),
    spanCount: readEmbeddedCount(row.hx_spans),
  };
}

export function mapSpanRow(row: SpanRow, traceStartedAt: string): TraceSpan {
  const startOffsetMs = Math.max(
    Date.parse(row.started_at) - Date.parse(traceStartedAt),
    0,
  );

  return {
    id: row.id,
    externalId: row.external_span_id,
    parentExternalId: row.parent_external_span_id,
    name: row.name,
    kind: asSpanKind(row.kind),
    status: asTraceStatus(row.status),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startOffsetMs: Number.isFinite(startOffsetMs) ? startOffsetMs : 0,
    durationMs: durationMs(row.started_at, row.ended_at),
    attributes: asRecord(row.attributes),
    error: asSpanError(row.error),
  };
}

export function mapTraceDetail(
  row: TraceRow,
  spans: SpanRow[],
): TraceDetail {
  const base = mapTraceRow({ ...row, hx_spans: null });
  const mapped = spans.map((span) => mapSpanRow(span, row.started_at));

  return {
    ...base,
    // Prefer the real span count over the embedded aggregate, which is absent
    // on the detail path.
    spanCount: mapped.length,
    metadata: asRecord(row.metadata),
    spans: mapped,
  };
}

/** Aggregates a trace list into the overview metrics. */
export function computeOverviewStats(
  traces: readonly TraceListItem[],
): {
  totalTraces: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  activeProjects: number;
} {
  const totalTraces = traces.length;
  if (totalTraces === 0) {
    return {
      totalTraces: 0,
      errorCount: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      activeProjects: 0,
    };
  }

  const errorCount = traces.filter((t) => t.status === "error").length;
  const ended = traces.filter((t) => t.endedAt !== null);
  const avgLatencyMs = ended.length
    ? Math.round(ended.reduce((sum, t) => sum + t.durationMs, 0) / ended.length)
    : 0;

  return {
    totalTraces,
    errorCount,
    errorRate: errorCount / totalTraces,
    avgLatencyMs,
    activeProjects: new Set(traces.map((t) => t.projectId)).size,
  };
}
