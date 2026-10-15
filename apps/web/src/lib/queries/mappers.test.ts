import { describe, expect, it } from "vitest";

import {
  asRecord,
  asSpanError,
  asSpanKind,
  asTraceStatus,
  computeOverviewStats,
  durationMs,
  mapSpanRow,
  mapTraceDetail,
  mapTraceRow,
  type SpanRow,
  type TraceRow,
} from "./mappers";
import type { TraceListItem } from "./types";

const TRACE_ROW: TraceRow = {
  id: "11111111-1111-1111-1111-111111111111",
  project_id: "22222222-2222-2222-2222-222222222222",
  external_trace_id: "trc_abc",
  name: "support-assistant",
  status: "ok",
  started_at: "2026-10-15T10:00:00.000Z",
  ended_at: "2026-10-15T10:00:01.240Z",
  environment: "production",
  metadata: { region: "eu" },
  hx_projects: { name: "Support" },
  hx_spans: [{ count: 5 }],
};

const SPAN_ROW: SpanRow = {
  id: "33333333-3333-3333-3333-333333333333",
  external_span_id: "spn_1",
  parent_external_span_id: null,
  name: "llm.plan",
  kind: "llm",
  status: "ok",
  started_at: "2026-10-15T10:00:00.400Z",
  ended_at: "2026-10-15T10:00:00.900Z",
  attributes: { model: "local" },
  error: null,
};

describe("asRecord", () => {
  it("passes objects through", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("defaults everything else to an empty object", () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord(undefined)).toEqual({});
    expect(asRecord("string")).toEqual({});
    expect(asRecord(42)).toEqual({});
    expect(asRecord([1, 2])).toEqual({});
  });
});

describe("asTraceStatus", () => {
  it.each(["ok", "error", "running"])("accepts %s", (value) => {
    expect(asTraceStatus(value)).toBe(value);
  });

  it("defaults an unknown status to running", () => {
    expect(asTraceStatus("weird")).toBe("running");
    expect(asTraceStatus(null)).toBe("running");
    expect(asTraceStatus(42)).toBe("running");
  });
});

describe("asSpanKind", () => {
  it.each(["agent", "llm", "tool", "retriever", "chain", "custom"])(
    "accepts %s",
    (value) => {
      expect(asSpanKind(value)).toBe(value);
    },
  );

  it("defaults an unknown kind to custom", () => {
    expect(asSpanKind("nope")).toBe("custom");
    expect(asSpanKind(undefined)).toBe("custom");
  });
});

describe("asSpanError", () => {
  it("accepts a well-formed error", () => {
    expect(asSpanError({ name: "Timeout", message: "took too long" })).toEqual({
      name: "Timeout",
      message: "took too long",
    });
  });

  it("rejects a partial error", () => {
    expect(asSpanError({ name: "Timeout" })).toBeNull();
    expect(asSpanError({ message: "took too long" })).toBeNull();
  });

  it("rejects empty strings", () => {
    expect(asSpanError({ name: "", message: "x" })).toBeNull();
    expect(asSpanError({ name: "x", message: "" })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(asSpanError(null)).toBeNull();
    expect(asSpanError("boom")).toBeNull();
    expect(asSpanError([1, 2])).toBeNull();
  });
});

describe("durationMs", () => {
  it("computes the duration from ISO timestamps", () => {
    expect(durationMs("2026-10-15T10:00:00.000Z", "2026-10-15T10:00:01.240Z")).toBe(1240);
  });

  it("returns 0 for a trace that has not ended", () => {
    expect(durationMs("2026-10-15T10:00:00.000Z", null)).toBe(0);
  });

  it("returns 0 rather than throwing on unparseable input", () => {
    expect(durationMs("not-a-date", "2026-10-15T10:00:01.000Z")).toBe(0);
  });
});

describe("mapTraceRow", () => {
  it("maps a full row", () => {
    const mapped = mapTraceRow(TRACE_ROW);
    expect(mapped).toEqual({
      id: TRACE_ROW.id,
      externalId: "trc_abc",
      projectId: TRACE_ROW.project_id,
      projectName: "Support",
      name: "support-assistant",
      status: "ok",
      environment: "production",
      startedAt: "2026-10-15T10:00:00.000Z",
      endedAt: "2026-10-15T10:00:01.240Z",
      durationMs: 1240,
      spanCount: 5,
    });
  });

  it("falls back for a missing joined project", () => {
    const mapped = mapTraceRow({ ...TRACE_ROW, hx_projects: null });
    expect(mapped.projectName).toBe("Unknown project");
  });

  it("reads an absent span count as zero", () => {
    expect(mapTraceRow({ ...TRACE_ROW, hx_spans: null }).spanCount).toBe(0);
    expect(mapTraceRow({ ...TRACE_ROW, hx_spans: [] }).spanCount).toBe(0);
  });

  it("keeps a running trace with no end time", () => {
    const mapped = mapTraceRow({
      ...TRACE_ROW,
      status: "running",
      ended_at: null,
    });
    expect(mapped.endedAt).toBeNull();
    expect(mapped.durationMs).toBe(0);
    expect(mapped.status).toBe("running");
  });

  it("normalises an unexpected status", () => {
    expect(mapTraceRow({ ...TRACE_ROW, status: "exploded" }).status).toBe(
      "running",
    );
  });
});

describe("mapSpanRow", () => {
  it("computes the offset from the trace start", () => {
    const span = mapSpanRow(SPAN_ROW, TRACE_ROW.started_at);
    expect(span.startOffsetMs).toBe(400);
    expect(span.durationMs).toBe(500);
  });

  it("clamps a span that starts before the trace to zero offset", () => {
    const span = mapSpanRow(
      { ...SPAN_ROW, started_at: "2026-10-15T09:59:59.000Z" },
      TRACE_ROW.started_at,
    );
    expect(span.startOffsetMs).toBe(0);
  });

  it("keeps the external span id and parent for tree building", () => {
    const span = mapSpanRow(
      { ...SPAN_ROW, parent_external_span_id: "spn_parent" },
      TRACE_ROW.started_at,
    );
    expect(span.externalId).toBe("spn_1");
    expect(span.parentExternalId).toBe("spn_parent");
  });

  it("maps a running span with no end time", () => {
    const span = mapSpanRow(
      { ...SPAN_ROW, status: "running", ended_at: null },
      TRACE_ROW.started_at,
    );
    expect(span.endedAt).toBeNull();
    expect(span.durationMs).toBe(0);
  });

  it("defaults missing attributes to an empty object", () => {
    expect(
      mapSpanRow({ ...SPAN_ROW, attributes: null }, TRACE_ROW.started_at)
        .attributes,
    ).toEqual({});
  });
});

describe("mapTraceDetail", () => {
  it("uses the real span length, not the embedded count", () => {
    const detail = mapTraceDetail(TRACE_ROW, [SPAN_ROW]);
    expect(detail.spanCount).toBe(1);
    expect(detail.spans).toHaveLength(1);
  });

  it("maps metadata", () => {
    expect(mapTraceDetail(TRACE_ROW, []).metadata).toEqual({ region: "eu" });
  });

  it("returns empty metadata when the column is null", () => {
    expect(mapTraceDetail({ ...TRACE_ROW, metadata: null }, []).metadata).toEqual(
      {},
    );
  });

  it("handles a trace with no spans", () => {
    const detail = mapTraceDetail(TRACE_ROW, []);
    expect(detail.spans).toEqual([]);
    expect(detail.spanCount).toBe(0);
  });

  it("keeps the trace's own fields alongside the spans", () => {
    const detail = mapTraceDetail(TRACE_ROW, [SPAN_ROW]);
    expect(detail.externalId).toBe("trc_abc");
    expect(detail.projectName).toBe("Support");
    expect(detail.durationMs).toBe(1240);
  });
});

describe("computeOverviewStats", () => {
  function item(overrides: Partial<TraceListItem>): TraceListItem {
    return {
      id: "id",
      externalId: "ext",
      projectId: "project-a",
      projectName: "A",
      name: "agent",
      status: "ok",
      environment: null,
      startedAt: "2026-10-15T10:00:00.000Z",
      endedAt: "2026-10-15T10:00:01.000Z",
      durationMs: 1000,
      spanCount: 0,
      ...overrides,
    };
  }

  it("returns zeroes for an empty list", () => {
    expect(computeOverviewStats([])).toEqual({
      totalTraces: 0,
      errorCount: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      activeProjects: 0,
    });
  });

  it("counts traces and errors", () => {
    const stats = computeOverviewStats([
      item({ status: "ok" }),
      item({ status: "error" }),
      item({ status: "ok" }),
    ]);
    expect(stats.totalTraces).toBe(3);
    expect(stats.errorCount).toBe(1);
    expect(stats.errorRate).toBeCloseTo(1 / 3);
  });

  it("averages latency over ended traces only", () => {
    const stats = computeOverviewStats([
      item({ durationMs: 1000 }),
      item({ durationMs: 3000 }),
      // A running trace has no duration and must not drag the mean to 0.
      item({ endedAt: null, durationMs: 0, status: "running" }),
    ]);
    expect(stats.avgLatencyMs).toBe(2000);
  });

  it("counts distinct projects", () => {
    const stats = computeOverviewStats([
      item({ projectId: "a" }),
      item({ projectId: "b" }),
      item({ projectId: "a" }),
    ]);
    expect(stats.activeProjects).toBe(2);
  });

  it("reports a 100% error rate when everything failed", () => {
    const stats = computeOverviewStats([item({ status: "error" })]);
    expect(stats.errorRate).toBe(1);
  });
});
