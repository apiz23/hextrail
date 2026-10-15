/**
 * Runtime-validatable schema contract for ingestion payloads.
 *
 * This subpath exists so the server can import the shared contract without
 * pulling in the client (which would drag a `fetch`-using module into code that
 * never sends a request).
 *
 * It has **no runtime dependencies** — only type exports. That is deliberate:
 * the SDK ships zero dependencies, and a validator library is the consuming
 * application's choice. The server pairs these types with its own Zod schemas.
 */

export type {
  SpanKind,
  SpanRecord,
  TraceEnvelope,
  TraceRecord,
  TraceStatus,
  SpanErrorRecord,
  IngestResponse,
} from "./index.js";

/** Fields accepted on the wire, for consumers writing their own validator. */
export const SPAN_KINDS = [
  "agent",
  "llm",
  "tool",
  "retriever",
  "chain",
  "custom",
] as const;

/** Accepted `status` values, for consumers writing their own validator. */
export const TRACE_STATUSES = ["ok", "error", "running"] as const;

/** The only accepted `schemaVersion`. */
export const SCHEMA_VERSION = 1 as const;

/** Maximum spans per trace, enforced by the server. */
export const MAX_SPANS_PER_TRACE = 500;

/** Maximum request body size in bytes (~1 MB), enforced by the server. */
export const MAX_BODY_BYTES = 1_000_000;
