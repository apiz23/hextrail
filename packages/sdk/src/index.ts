/**
 * Wire contract for Hextrail trace ingestion.
 *
 * These types describe exactly what `POST /api/v1/traces` accepts. They are the
 * published surface of the SDK: changing a field here changes what every
 * external integration can send, so treat them as append-only. Adding an
 * optional field is backward compatible; removing one, or tightening a type,
 * is not.
 *
 * The server validates every payload independently at runtime. These types are
 * a compile-time convenience, not a security boundary — nothing stops a caller
 * from sending something else entirely.
 */

export {
  HextrailClient,
  DEFAULT_ENDPOINT,
  type HextrailClientOptions,
} from "./client.js";
export {
  HextrailError,
  isRetryableStatus,
  type HextrailErrorKind,
  type HextrailErrorInit,
} from "./errors.js";

/** Trace and span outcome. `running` is accepted for in-flight traces. */
export type TraceStatus = "ok" | "error" | "running";

export type SpanKind =
  | "agent"
  | "llm"
  | "tool"
  | "retriever"
  | "chain"
  | "custom";

/** A complete ingest request body. */
export interface TraceEnvelope {
  /** Contract version. Currently always `1`. */
  schemaVersion: 1;
  trace: TraceRecord;
  /** At most 500 spans per trace. */
  spans: SpanRecord[];
}

export interface TraceRecord {
  /** Your own trace identifier. Unique per project. */
  traceId: string;
  /**
   * Optional, and usually omitted.
   *
   * The API key already determines the project, so this is only needed to catch
   * a misconfigured client: when present it must match the key's project, or
   * the request is rejected with `403`. It can never be used to write into a
   * different project.
   */
  projectId?: string;
  name: string;
  /** ISO 8601 date-time. Must parse. */
  startedAt: string;
  /** ISO 8601 date-time. Must not precede `startedAt`. */
  endedAt?: string;
  status: TraceStatus;
  environment?: string;
  /**
   * Arbitrary JSON.
   *
   * Values under credential-looking key names are redacted by the server before
   * storage. See the README: redaction is key-name matching, not PII detection.
   */
  metadata?: Record<string, unknown>;
}

export interface SpanRecord {
  spanId: string;
  /**
   * The trace this span belongs to.
   *
   * OPTIONAL, and usually omitted: a span is nested inside a `TraceEnvelope`,
   * so the parent trace is unambiguous and the server does not read this field
   * at all. It exists only so callers holding a flat list of spans they built
   * for their own bookkeeping can pass it through unchanged.
   *
   * When present it is *not* validated against the parent trace, so it must not
   * be relied on to route a span. Nothing here implies a span can be attached
   * to a different trace.
   */
  traceId?: string;
  /** Must reference another span in the same trace, or be omitted for the root. */
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startedAt: string;
  endedAt?: string;
  status: TraceStatus;
  /** Arbitrary JSON. Redacted by key name, same as trace metadata. */
  attributes?: Record<string, unknown>;
  error?: SpanErrorRecord;
}

export interface SpanErrorRecord {
  name: string;
  message: string;
}

/** A successful ingest response (`200` or `201`). */
export interface IngestResponse {
  /** Hextrail's internal trace id. */
  traceId: string;
  /** The `traceId` you supplied. */
  externalTraceId: string;
  spansAccepted: number;
  /**
   * `true` when this `(project, traceId)` had already been ingested.
   *
   * A duplicate is a success, not an error: ingestion is idempotent, so
   * resubmitting — including after a retry — is safe.
   */
  duplicate: boolean;
}

/**
 * Validate timestamps and tree references before sending. Server-side validation
 * remains mandatory; these interfaces are compile-time contracts, not security.
 */
export function getDurationMs(startedAt: string, endedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("Trace timestamps must be valid ISO date strings");
  }
  if (end < start) throw new Error("Trace end must not precede its start");
  return end - start;
}
