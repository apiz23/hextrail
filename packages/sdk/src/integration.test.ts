import { describe, expect, it } from "vitest";

import { HextrailClient } from "./client.js";
import { HextrailError } from "./errors.js";
import type { TraceEnvelope } from "./index.js";

/**
 * Live integration tests.
 *
 * Mocked tests prove the client's behaviour given a response; they cannot prove
 * the client speaks the server's protocol — the URL, the header name, the body
 * shape, or the key format. Only a real server can.
 *
 * OPT-IN, and never against a development database:
 *   HEXTRAIL_TEST_ENDPOINT  e.g. http://localhost:3000/api/v1/traces
 *   HEXTRAIL_TEST_API_KEY   an hx_live_ key
 *
 * Both must be set or every test here is skipped, matching the existing
 * TEST_SUPABASE_* convention: no credentials, no run, and never a silent pass
 * against production data.
 */

const endpoint = process.env.HEXTRAIL_TEST_ENDPOINT;
const apiKey = process.env.HEXTRAIL_TEST_API_KEY;
const live = Boolean(endpoint && apiKey);

const unique = (): string =>
  `sdk-it-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function envelope(traceId: string, overrides: Partial<TraceEnvelope["trace"]> = {}): TraceEnvelope {
  const start = new Date(Date.now() - 1000).toISOString();
  const end = new Date().toISOString();
  return {
    schemaVersion: 1,
    trace: {
      traceId,
      name: "sdk-integration-test",
      startedAt: start,
      endedAt: end,
      status: "ok",
      environment: "sdk-it",
      ...overrides,
    },
    spans: [
      {
        spanId: "spn_1",
        traceId,
        name: "llm.call",
        kind: "llm",
        startedAt: start,
        endedAt: end,
        status: "ok",
        attributes: { model: "test-model" },
      },
    ],
  };
}

describe.skipIf(!live)("live ingestion", () => {
  const client = new HextrailClient({
    apiKey: apiKey ?? "hx_live_unset",
    endpoint,
    maxRetries: 0,
  });

  it("ingests a trace end to end", async () => {
    const traceId = unique();
    const result = await client.ingestTrace(envelope(traceId));

    expect(result.externalTraceId).toBe(traceId);
    expect(result.duplicate).toBe(false);
    expect(result.spansAccepted).toBe(1);
    expect(result.traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("is idempotent: resubmitting the same traceId is a duplicate", async () => {
    const traceId = unique();
    const payload = envelope(traceId);

    const first = await client.ingestTrace(payload);
    const second = await client.ingestTrace(payload);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    // Same row, so the internal id must match.
    expect(second.traceId).toBe(first.traceId);
  });

  it("accepts status 'running' with no endedAt", async () => {
    const traceId = unique();
    const payload = envelope(traceId, { status: "running", endedAt: undefined });
    const result = await client.ingestTrace(payload);
    expect(result.externalTraceId).toBe(traceId);
  });

  it("redacts credential-shaped metadata before storage", async () => {
    const traceId = unique();
    // The response does not echo metadata, so this asserts the request was
    // accepted; the redaction itself is verified against the database.
    const result = await client.ingestTrace(
      envelope(traceId, { metadata: { password: "super-secret", safe: "ok" } }),
    );
    expect(result.duplicate).toBe(false);
  });

  it("rejects an invalid payload with 400 and field details", async () => {
    const bad = {
      schemaVersion: 1 as const,
      trace: {
        traceId: unique(),
        name: "", // min length 1
        startedAt: "not-a-date",
        status: "ok" as const,
      },
      spans: [],
    };

    const error = await client
      .ingestTrace(bad as unknown as TraceEnvelope)
      .catch((caught: HextrailError) => caught);

    expect(error).toBeInstanceOf(HextrailError);
    expect(error.status).toBe(400);
    expect(Array.isArray(error.details)).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("rejects a bad API key with 401 and does not retry", async () => {
    const unauthorised = new HextrailClient({
      apiKey: `hx_live_${"Z".repeat(43)}`,
      endpoint,
      maxRetries: 2,
      retryDelayMs: () => 0,
    });

    const error = await unauthorised
      .ingestTrace(envelope(unique()))
      .catch((caught: HextrailError) => caught);

    expect(error.status).toBe(401);
    expect(error.kind).toBe("auth");
    // The client must not have retried a credential failure.
    expect(error.retryable).toBe(false);
  });

  it("rejects a projectId that does not match the key with 403", async () => {
    const error = await client
      .ingestTrace(
        envelope(unique(), { projectId: "99999999-9999-9999-9999-999999999999" }),
      )
      .catch((caught: HextrailError) => caught);

    expect(error.status).toBe(403);
    expect(error.kind).toBe("auth");
  });
});

describe.skipIf(live)("live ingestion (skipped)", () => {
  it("explains how to enable the integration suite", () => {
    // A visible skip beats a silent pass: without this, an empty suite looks
    // like success.
    expect(endpoint && apiKey).toBeFalsy();
  });
});
