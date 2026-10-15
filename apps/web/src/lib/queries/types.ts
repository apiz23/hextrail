/**
 * View models for the dashboard.
 *
 * These are deliberately separate from the raw database rows and from
 * `src/data/mock.ts`. The UI renders these shapes only, so there is exactly one
 * place where database columns become display values — `mappers.ts`.
 *
 * All timestamps stay ISO 8601 strings and all durations are computed
 * milliseconds, so server and client agree on the value without re-parsing.
 */

export type TraceStatus = "ok" | "error" | "running";

export const SPAN_KINDS = [
  "agent",
  "llm",
  "tool",
  "retriever",
  "chain",
  "custom",
] as const;

export type SpanKind = (typeof SPAN_KINDS)[number];

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  traceCount: number;
  /** ISO timestamp of the most recent trace, or null when the project is empty. */
  lastTraceAt: string | null;
}

export interface TraceSpanError {
  name: string;
  message: string;
}

export interface TraceSpan {
  /** Database id. Stable, and what React keys off. */
  id: string;
  /** Client-supplied span id from the SDK, shown to the user. */
  externalId: string;
  parentExternalId: string | null;
  name: string;
  kind: SpanKind;
  status: TraceStatus;
  startedAt: string;
  endedAt: string | null;
  /** Milliseconds after the trace start. */
  startOffsetMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  error: TraceSpanError | null;
}

/** Row shape for the trace list. Spans are not loaded here. */
export interface TraceListItem {
  id: string;
  externalId: string;
  projectId: string;
  projectName: string;
  name: string;
  status: TraceStatus;
  environment: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  /** Denormalised count so the list does not need a second query. */
  spanCount: number;
}

/** Full trace, with spans, for the detail view. */
export interface TraceDetail extends TraceListItem {
  metadata: Record<string, unknown>;
  spans: TraceSpan[];
}

/** Bounded pagination result. */
export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
  /** Whether more rows exist after this page. */
  hasMore: boolean;
}

export interface OverviewStats {
  totalTraces: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  /** Distinct projects with at least one trace in the window. */
  activeProjects: number;
}

export interface ActivityPoint {
  label: string;
  traces: number;
  errors: number;
}

/** Every query result is either data or a reason it could not be loaded. */
export type QueryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: QueryError };

export type QueryErrorKind = "unauthorized" | "not_found" | "database";

export interface QueryError {
  kind: QueryErrorKind;
  message: string;
}
