import { NextResponse, type NextRequest } from "next/server";

import { authenticateApiKey, readBearerToken } from "@/lib/ingestion/auth";
import { rateLimitOptionsFromEnv } from "@/lib/ingestion/rate-limit";
import { resolveRateLimitStore } from "@/lib/ingestion/rate-limit-postgres";
import { redactRecord } from "@/lib/ingestion/redact";
import { ingestPayloadSchema } from "@/lib/ingestion/schema";
import { getServiceClient } from "@/lib/supabase/service";

/** Ingestion bodies are small; reject anything larger before parsing. */
const MAX_BODY_BYTES = 1_000_000; // ~1 MB

/** Reused across requests within an instance; safe, the store is stateless. */
const rateLimitStore = resolveRateLimitStore();

interface IngestResult {
  trace_id: string;
  inserted: boolean;
}

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: NextRequest) {
  // --- Authentication -----------------------------------------------------
  const token = readBearerToken(request.headers.get("authorization"));
  if (!token) {
    return jsonError(401, "unauthorized", "A bearer API key is required.");
  }

  let project: Awaited<ReturnType<typeof authenticateApiKey>>;
  try {
    project = await authenticateApiKey(token);
  } catch {
    // Configuration or network failure — never leak the reason.
    return jsonError(500, "internal_error", "Ingestion is temporarily unavailable.");
  }

  if (!project) {
    return jsonError(401, "unauthorized", "The API key is invalid or revoked.");
  }

  // --- Rate limit ---------------------------------------------------------
  // Keyed per API key, so one noisy agent cannot starve another project.
  // Runs after auth (so unauthenticated traffic cannot fill the table) and
  // before body parsing (so a throttled client costs us almost nothing).
  const { limit, windowSeconds } = rateLimitOptionsFromEnv();
  try {
    const decision = await rateLimitStore.consume(
      `ingest:${project.apiKeyId}`,
      limit,
      windowSeconds,
    );

    if (!decision.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many requests. Retry after the window resets.",
          },
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(decision.retryAfterSeconds),
            "X-RateLimit-Limit": String(decision.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(decision.retryAfterSeconds),
          },
        },
      );
    }
  } catch {
    // Fail closed: if the limiter is unavailable, refuse rather than allow an
    // unbounded stream. This trades availability for protection of the
    // database, which is the right call for an ingestion endpoint.
    return jsonError(
      503,
      "rate_limiter_unavailable",
      "Ingestion is temporarily unavailable.",
    );
  }

  // --- Request size -------------------------------------------------------
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large", "Payload exceeds the 1 MB limit.");
  }

  // --- Parse + validate ---------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const parsed = ingestPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "The payload did not match the expected trace schema.",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  const { trace, spans } = parsed.data;

  // --- Ownership ----------------------------------------------------------
  // The API key determines the project. A projectId in the body is only
  // accepted when it matches, so a key can never write into another project.
  if (trace.projectId !== undefined && trace.projectId !== project.projectId) {
    return jsonError(
      403,
      "forbidden",
      "This API key is not authorized for the requested project.",
    );
  }

  // --- Atomic write -------------------------------------------------------
  try {
    const supabase = getServiceClient();

    const { data, error } = await supabase.rpc("hx_ingest_trace", {
      p_project_id: project.projectId,
      p_external_trace_id: trace.traceId,
      p_name: trace.name,
      p_status: trace.status,
      p_started_at: trace.startedAt,
      p_ended_at: trace.endedAt ?? null,
      p_environment: trace.environment ?? null,
      // Redact before persistence. Values under credential-looking keys, and
      // credential-shaped strings, are masked. See redact.ts for limits.
      p_metadata: redactRecord(trace.metadata ?? {}),
      p_spans: spans.map((span) => ({
        externalSpanId: span.spanId,
        parentExternalSpanId: span.parentSpanId ?? null,
        name: span.name,
        kind: span.kind,
        status: span.status,
        startedAt: span.startedAt,
        endedAt: span.endedAt ?? null,
        attributes: redactRecord(span.attributes ?? {}),
        ...(span.error ? { error: span.error } : {}),
      })),
    });

    if (error) {
      // Constraint violations mean the payload was structurally valid but
      // semantically wrong (e.g. a span timestamp before its trace).
      if (error.code === "23514" || error.code === "23503") {
        return jsonError(
          400,
          "invalid_payload",
          "The payload violated a database constraint.",
        );
      }
      return jsonError(500, "internal_error", "Failed to persist the trace.");
    }

    const result = (data as IngestResult[] | null)?.[0];
    if (!result) {
      return jsonError(500, "internal_error", "Failed to persist the trace.");
    }

    return NextResponse.json(
      {
        traceId: result.trace_id,
        externalTraceId: trace.traceId,
        spansAccepted: spans.length,
        duplicate: !result.inserted,
      },
      { status: result.inserted ? 201 : 200 },
    );
  } catch {
    return jsonError(500, "internal_error", "Failed to persist the trace.");
  }
}
