import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Real HTTP-to-Postgres integration tests.
 *
 * THESE ARE SKIPPED BY DEFAULT.
 *
 * They run only when an *isolated* test database is configured:
 *
 *   TEST_SUPABASE_URL=https://<test-project>.supabase.co
 *   TEST_SUPABASE_SERVICE_ROLE_KEY=<test project service role key>
 *
 * They write rows and delete them afterwards. Pointing them at a database with
 * real data is destructive to that data. The guard below requires the URL to
 * differ from NEXT_PUBLIC_SUPABASE_URL, so a misconfigured environment cannot
 * silently target the development project.
 *
 * These tests currently exercise the database layer directly (RPC + tables).
 * Driving the real route handler requires a running Next.js server; see the
 * README for the curl-based manual check.
 */

const TEST_URL = process.env.TEST_SUPABASE_URL;
const TEST_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const DEV_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

const sameAsDev = Boolean(TEST_URL && DEV_URL && TEST_URL === DEV_URL);
const enabled = Boolean(TEST_URL && TEST_KEY) && !sameAsDev;

// Every row these tests create is namespaced so cleanup can never touch
// anything a human made.
const NS = `itest_${Date.now()}`;

describe.skipIf(!enabled)("ingestion: real database integration", () => {
  let supabase: SupabaseClient;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    supabase = createClient(TEST_URL!, TEST_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Two throwaway users/projects, so cross-project isolation is testable.
    const { data: users, error: userError } = await supabase
      .from("hx_users")
      .insert([
        { email: `${NS}_a@example.test`, password_hash: "x".repeat(60) },
        { email: `${NS}_b@example.test`, password_hash: "x".repeat(60) },
      ])
      .select("id");
    if (userError) throw userError;

    const { data: projects, error: projectError } = await supabase
      .from("hx_projects")
      .insert([
        { owner_id: users![0].id, name: `${NS}_project_a` },
        { owner_id: users![1].id, name: `${NS}_project_b` },
      ])
      .select("id");
    if (projectError) throw projectError;

    projectId = projects![0].id;
    otherProjectId = projects![1].id;
  });

  afterAll(async () => {
    // Scoped to the test project name. Deleting the projects cascades to
    // traces and spans; the users are removed last.
    if (!supabase) return;
    const { data: projects } = await supabase
      .from("hx_projects")
      .select("id, owner_id")
      .like("name", `${NS}%`);

    if (projects?.length) {
      await supabase
        .from("hx_projects")
        .delete()
        .in("id", projects.map((p) => p.id));
      await supabase
        .from("hx_users")
        .delete()
        .in("id", projects.map((p) => p.owner_id));
    }
  });

  async function ingest(
    targetProject: string,
    traceId: string,
    spans: unknown[] = [],
  ) {
    return supabase.rpc("hx_ingest_trace", {
      p_project_id: targetProject,
      p_external_trace_id: traceId,
      p_name: "integration-test-agent",
      p_status: "ok",
      p_started_at: new Date(Date.now() - 1000).toISOString(),
      p_ended_at: new Date().toISOString(),
      p_environment: "test",
      p_metadata: { region: "test" },
      p_spans: spans,
    });
  }

  it("writes a trace and its spans", async () => {
    const traceId = `${NS}_write`;
    const { data, error } = await ingest(projectId, traceId, [
      {
        externalSpanId: "spn_1",
        name: "llm.plan",
        kind: "llm",
        status: "ok",
        startedAt: new Date(Date.now() - 900).toISOString(),
        endedAt: new Date(Date.now() - 500).toISOString(),
        attributes: { model: "local" },
      },
    ]);

    expect(error).toBeNull();
    expect(data![0].inserted).toBe(true);

    const { data: trace } = await supabase
      .from("hx_traces")
      .select("id, name, status")
      .eq("external_trace_id", traceId)
      .single();
    expect(trace!.name).toBe("integration-test-agent");

    const { data: spans } = await supabase
      .from("hx_spans")
      .select("name, kind")
      .eq("trace_id", trace!.id);
    expect(spans).toHaveLength(1);
    expect(spans![0].kind).toBe("llm");
  });

  it("treats a duplicate submission as a no-op", async () => {
    const traceId = `${NS}_dup`;
    const first = await ingest(projectId, traceId, [
      {
        externalSpanId: "spn_1",
        name: "llm.plan",
        kind: "llm",
        status: "ok",
        startedAt: new Date(Date.now() - 900).toISOString(),
      },
    ]);
    expect(first.data![0].inserted).toBe(true);

    // Same trace id, different span set. The original must win.
    const second = await ingest(projectId, traceId, []);
    expect(second.error).toBeNull();
    expect(second.data![0].inserted).toBe(false);
    expect(second.data![0].trace_id).toBe(first.data![0].trace_id);

    const { data: spans } = await supabase
      .from("hx_spans")
      .select("id")
      .eq("trace_id", first.data![0].trace_id);
    expect(spans).toHaveLength(1);
  });

  it("isolates traces between projects", async () => {
    const sharedId = `${NS}_shared`;
    await ingest(projectId, sharedId);
    await ingest(otherProjectId, sharedId);

    const { data } = await supabase
      .from("hx_traces")
      .select("project_id")
      .eq("external_trace_id", sharedId);

    // The same external id in two projects produces two independent rows.
    expect(data).toHaveLength(2);
    const projectIds = data!.map((r) => r.project_id).sort();
    expect(projectIds).toEqual([projectId, otherProjectId].sort());
  });

  it("rolls back the whole insert when a span is invalid", async () => {
    const traceId = `${NS}_atomic`;

    // Second span has an ended_at before started_at, violating a check
    // constraint. Neither the trace nor the first span may survive.
    const { error } = await ingest(projectId, traceId, [
      {
        externalSpanId: "spn_ok",
        name: "llm.plan",
        kind: "llm",
        status: "ok",
        startedAt: new Date(Date.now() - 900).toISOString(),
      },
      {
        externalSpanId: "spn_bad",
        name: "tool.bad",
        kind: "tool",
        status: "ok",
        startedAt: new Date().toISOString(),
        endedAt: new Date(Date.now() - 5000).toISOString(),
      },
    ]);

    expect(error).not.toBeNull();

    const { data: traces } = await supabase
      .from("hx_traces")
      .select("id")
      .eq("external_trace_id", traceId);
    expect(traces).toHaveLength(0);

    const { data: spans } = await supabase
      .from("hx_spans")
      .select("id")
      .eq("external_span_id", "spn_ok");
    expect(spans).toHaveLength(0);
  });

  it("rejects a trace whose ended_at precedes started_at", async () => {
    const { error } = await supabase.rpc("hx_ingest_trace", {
      p_project_id: projectId,
      p_external_trace_id: `${NS}_badtrace`,
      p_name: "bad",
      p_status: "ok",
      p_started_at: new Date().toISOString(),
      p_ended_at: new Date(Date.now() - 10_000).toISOString(),
      p_environment: null,
      p_metadata: {},
      p_spans: [],
    });
    expect(error).not.toBeNull();
  });

  it("rejects an unknown status value", async () => {
    const { error } = await supabase.rpc("hx_ingest_trace", {
      p_project_id: projectId,
      p_external_trace_id: `${NS}_badstatus`,
      p_name: "bad",
      p_status: "not-a-status",
      p_started_at: new Date().toISOString(),
      p_ended_at: null,
      p_environment: null,
      p_metadata: {},
      p_spans: [],
    });
    expect(error).not.toBeNull();
  });

  it("rejects a trace for a project that does not exist", async () => {
    const { error } = await supabase.rpc("hx_ingest_trace", {
      p_project_id: "00000000-0000-0000-0000-000000000000",
      p_external_trace_id: `${NS}_orphan`,
      p_name: "orphan",
      p_status: "ok",
      p_started_at: new Date().toISOString(),
      p_ended_at: null,
      p_environment: null,
      p_metadata: {},
      p_spans: [],
    });
    expect(error).not.toBeNull();
  });

  it("stores redacted metadata when the caller redacts first", async () => {
    const traceId = `${NS}_redact`;
    const { redactRecord } = await import("./redact");

    await supabase.rpc("hx_ingest_trace", {
      p_project_id: projectId,
      p_external_trace_id: traceId,
      p_name: "redaction-test",
      p_status: "ok",
      p_started_at: new Date().toISOString(),
      p_ended_at: null,
      p_environment: null,
      p_metadata: redactRecord({
        region: "eu-west-1",
        access_token: "this-should-not-be-stored",
        nested: { password: "also-not-stored" },
      }),
      p_spans: [],
    });

    const { data } = await supabase
      .from("hx_traces")
      .select("metadata")
      .eq("external_trace_id", traceId)
      .single();

    const stored = JSON.stringify(data!.metadata);
    expect(stored).not.toContain("this-should-not-be-stored");
    expect(stored).not.toContain("also-not-stored");
    expect(data!.metadata).toMatchObject({ region: "eu-west-1" });
  });
});
