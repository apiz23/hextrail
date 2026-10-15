import { describe, expect, it } from "vitest";

import { ingestPayloadSchema } from "./schema";

const validPayload = {
  schemaVersion: 1,
  trace: {
    traceId: "trc_test_001",
    name: "support-assistant",
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: "2026-10-15T10:00:01.000Z",
    status: "ok",
    environment: "production",
    metadata: { region: "eu-west-1" },
  },
  spans: [
    {
      spanId: "spn_1",
      name: "llm.plan",
      kind: "llm",
      startedAt: "2026-10-15T10:00:00.100Z",
      endedAt: "2026-10-15T10:00:00.400Z",
      status: "ok",
      attributes: { model: "local" },
    },
    {
      spanId: "spn_2",
      parentSpanId: "spn_1",
      name: "tool.fetch_document",
      kind: "tool",
      startedAt: "2026-10-15T10:00:00.500Z",
      endedAt: "2026-10-15T10:00:00.900Z",
      status: "error",
      error: { name: "TimeoutError", message: "upstream timeout" },
    },
  ],
};

describe("ingestPayloadSchema", () => {
  it("accepts a well-formed payload", () => {
    const result = ingestPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("accepts a trace with no spans", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      spans: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed timestamps", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      trace: { ...validPayload.trace, startedAt: "not-a-date" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain("startedAt");
    }
  });

  it("rejects an unknown status", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      trace: { ...validPayload.trace, status: "failed" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown span kind", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      spans: [{ ...validPayload.spans[0], kind: "database" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a span whose endedAt precedes its startedAt", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      spans: [
        {
          ...validPayload.spans[0],
          startedAt: "2026-10-15T10:00:05.000Z",
          endedAt: "2026-10-15T10:00:01.000Z",
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("endedAt"))).toBe(
        true,
      );
    }
  });

  it("rejects a trace whose endedAt precedes its startedAt", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      trace: {
        ...validPayload.trace,
        startedAt: "2026-10-15T10:00:10.000Z",
        endedAt: "2026-10-15T10:00:00.000Z",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 500 spans", () => {
    const spans = Array.from({ length: 501 }, (_, i) => ({
      ...validPayload.spans[0],
      spanId: `spn_${i}`,
    }));
    const result = ingestPayloadSchema.safeParse({ ...validPayload, spans });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported schema version", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      schemaVersion: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing trace object", () => {
    const result = ingestPayloadSchema.safeParse({
      schemaVersion: 1,
      spans: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid projectId when present", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      trace: { ...validPayload.trace, projectId: "not-a-uuid" },
    });
    expect(result.success).toBe(false);
  });

  // REGRESSION. `z.string().uuid()` enforces an RFC 4122 version nibble and
  // variant, which rejects ids Postgres accepts. When this schema used it, a
  // well-formed but foreign projectId failed *validation* and the route
  // answered `400 invalid_payload` — so the ownership check that produces
  // `403 projectId does not match your key` was unreachable for exactly the
  // ids it exists to reject.
  it.each([
    ["a repeated-digit uuid (version nibble 1)", "99999999-9999-9999-9999-999999999999"],
    ["an all-zero uuid", "00000000-0000-0000-0000-000000000000"],
    ["the nil-ish uuid used in tests", "11111111-1111-1111-1111-111111111111"],
    ["an uppercase uuid", "B04F2DDA-8E2C-49E2-B2D7-81D7696F674D"],
  ])("accepts %s so the ownership check can run", (_label, projectId) => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      trace: { ...validPayload.trace, projectId },
    });
    // Validation must pass. Whether the key is *authorized* for that project is
    // a separate decision made later, by the route.
    expect(result.success).toBe(true);
  });

  it("accepts a running trace with no endedAt", () => {
    const result = ingestPayloadSchema.safeParse({
      ...validPayload,
      trace: {
        traceId: "trc_running",
        name: "support-assistant",
        startedAt: "2026-10-15T10:00:00.000Z",
        status: "running",
      },
      spans: [],
    });
    expect(result.success).toBe(true);
  });
});
