import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Authorization tests for the query layer.
 *
 * These are the tests that matter most in this module: they assert that the
 * server refuses to return another user's data, not that the UI would hide it.
 * The Supabase client is mocked so each test can declare exactly which rows
 * exist and then assert on what the query asked for.
 */

interface QueryCall {
  table: string;
  select?: string;
  filters: [string, unknown][];
  order?: [string, unknown][];
  limit?: number;
  or?: string[];
}

/**
 * A minimal PostgREST-ish mock. Each builder method records what the caller
 * asked for and returns the same builder, so the code under test can be
 * awaited at the end. `respond` decides what the final await yields.
 */
function createMockClient(respond: (call: QueryCall) => unknown) {
  const calls: QueryCall[] = [];

  function builder(table: string) {
    const call: QueryCall = { table, filters: [] };
    calls.push(call);

    const api = {
      select: (columns: string) => {
        call.select = columns;
        return api;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return api;
      },
      is: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return api;
      },
      in: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return api;
      },
      gte: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return api;
      },
      like: (column: string, value: unknown) => {
        call.filters.push([column, value]);
        return api;
      },
      or: (expression: string) => {
        call.or = [...(call.or ?? []), expression];
        return api;
      },
      order: (column: string, options: unknown) => {
        call.order = [...(call.order ?? []), [column, options]];
        return api;
      },
      limit: (value: number) => {
        call.limit = value;
        return api;
      },
      maybeSingle: async () => respond(call),
      single: async () => respond(call),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(respond(call)).then(resolve),
    };

    return api;
  }

  return {
    calls,
    client: {
      from: (table: string) => builder(table),
      rpc: vi.fn(),
    },
  };
}

const getServiceClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/service", () => ({
  getServiceClient: getServiceClientMock,
}));

const USER_A = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: "a@example.test",
  displayName: "A",
};

const USER_B = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  email: "b@example.test",
  displayName: "B",
};

const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "22222222-2222-2222-2222-222222222222";
const TRACE_A = "33333333-3333-3333-3333-333333333333";

// Imported after the mock is registered.
const { getTrace, listTraces, ownedProject, ownedProjectIds, listProjects } =
  await import("./traces");

async function withClient<T>(
  respond: (call: QueryCall) => unknown,
  run: () => Promise<T>,
): Promise<{ result: T; calls: QueryCall[] }> {
  const mock = createMockClient(respond);
  getServiceClientMock.mockReturnValue(mock.client);
  const result = await run();
  return { result, calls: mock.calls };
}

describe("ownedProjectIds", () => {
  beforeEach(() => {
    getServiceClientMock.mockReset();
  });

  it("filters by owner_id", async () => {
    const { calls } = await withClient(
      () => ({ data: [{ id: PROJECT_A }], error: null }),
      () => ownedProjectIds(USER_A),
    );

    expect(calls[0].table).toBe("hx_projects");
    expect(calls[0].filters).toContainEqual(["owner_id", USER_A.id]);
  });

  it("refuses a user with no id", async () => {
    const result = await ownedProjectIds({ ...USER_A, id: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
    // The database must not be touched at all.
    expect(getServiceClientMock).not.toHaveBeenCalled();
  });

  it("surfaces a database error", async () => {
    const result = await withClient(
      () => ({ data: null, error: { message: "boom" } }),
      () => ownedProjectIds(USER_A),
    );
    expect(result.result.ok).toBe(false);
    if (!result.result.ok) {
      expect(result.result.error.kind).toBe("database");
    }
  });

  it("returns an empty scope when the user owns nothing", async () => {
    const result = await withClient(
      () => ({ data: [], error: null }),
      () => ownedProjectIds(USER_A),
    );
    expect(result.result).toEqual({ ok: true, data: [] });
  });
});

describe("ownedProject", () => {
  it("scopes the lookup by owner_id as well as id", async () => {
    const { calls } = await withClient(
      () => ({ data: { id: PROJECT_A, name: "A" }, error: null }),
      () => ownedProject(USER_A, PROJECT_A),
    );

    const filters = calls[0].filters;
    expect(filters).toContainEqual(["owner_id", USER_A.id]);
    expect(filters).toContainEqual(["id", PROJECT_A]);
  });

  it("returns null when the project belongs to another user", async () => {
    // The mock answers as the database would with the owner_id predicate in
    // place: no row.
    const result = await withClient(
      () => ({ data: null, error: null }),
      () => ownedProject(USER_A, PROJECT_B),
    );
    expect(result.result).toEqual({ ok: true, data: null });
  });
});

describe("listTraces isolation", () => {
  it("scopes an unscoped list to every owned project", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: [], error: null },
      () => listTraces(USER_A, { projectId: null }),
    );

    const traceCall = calls.find((call) => call.table === "hx_traces");
    expect(traceCall?.filters).toContainEqual(["project_id", [PROJECT_A]]);
  });

  it("returns an empty page when the user owns no projects", async () => {
    const { result, calls } = await withClient(
      () => ({ data: [], error: null }),
      () => listTraces(USER_A, { projectId: null }),
    );

    expect(result).toEqual({
      ok: true,
      data: { items: [], nextCursor: null, hasMore: false },
    });
    // No trace query should have been issued at all.
    expect(calls.some((call) => call.table === "hx_traces")).toBe(false);
  });

  it("does not query traces when the project is not owned", async () => {
    const { result, calls } = await withClient(
      // Authorization lookup finds nothing, because owner_id is wrong.
      () => ({ data: null, error: null }),
      () => listTraces(USER_B, { projectId: PROJECT_A }),
    );

    expect(result).toEqual({
      ok: true,
      data: { items: [], nextCursor: null, hasMore: false },
    });
    expect(calls.some((call) => call.table === "hx_traces")).toBe(false);
  });

  it("requires a user id", async () => {
    const result = await listTraces({ ...USER_A, id: "" }, { projectId: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
  });
});

describe("listTraces paging", () => {
  function traceRow(index: number) {
    return {
      id: `trace-${index}`,
      project_id: PROJECT_A,
      external_trace_id: `ext-${index}`,
      name: "agent",
      status: "ok",
      started_at: `2026-10-15T10:00:${String(index).padStart(2, "0")}.000Z`,
      ended_at: `2026-10-15T10:00:${String(index).padStart(2, "0")}.500Z`,
      environment: null,
      hx_projects: { name: "A" },
      hx_spans: [{ count: 0 }],
    };
  }

  it("requests one extra row to detect more pages", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: [], error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A, limit: 10 }),
    );

    const traceCall = calls.find((call) => call.table === "hx_traces");
    expect(traceCall?.limit).toBe(11);
  });

  it("caps the page size regardless of what the caller asks", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: [], error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A, limit: 100_000 }),
    );

    const traceCall = calls.find((call) => call.table === "hx_traces");
    expect(traceCall?.limit).toBe(101); // MAX_PAGE_SIZE + 1
  });

  it("orders by started_at then id, descending, for a total order", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: [], error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A }),
    );

    const traceCall = calls.find((call) => call.table === "hx_traces");
    expect(traceCall?.order).toEqual([
      ["started_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  it("returns a cursor and drops the extra row when more exist", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => traceRow(index));

    const { result } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: rows, error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A, limit: 2 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(2);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextCursor).not.toBeNull();
  });

  it("omits the cursor on the last page", async () => {
    const rows = Array.from({ length: 2 }, (_, index) => traceRow(index));

    const { result } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: rows, error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A, limit: 2 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(2);
    expect(result.data.hasMore).toBe(false);
    expect(result.data.nextCursor).toBeNull();
  });

  it("encodes the last row of the page into the cursor", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => traceRow(index));

    const { result } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: rows, error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A, limit: 2 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { decodeCursor } = await import("./traces");
    expect(decodeCursor(result.data.nextCursor ?? undefined)).toEqual({
      startedAt: rows[1].started_at,
      id: rows[1].id,
    });
  });

  it("applies the keyset predicate for a cursor", async () => {
    const { encodeCursor } = await import("./traces");
    const cursor = encodeCursor({
      startedAt: "2026-10-15T10:00:00.000Z",
      id: TRACE_A,
    });

    const { calls } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: [], error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A, cursor }),
    );

    const traceCall = calls.find((call) => call.table === "hx_traces");
    expect(traceCall?.or?.some((expr) => expr.includes("started_at.lt."))).toBe(
      true,
    );
  });
});

describe("listTraces filters", () => {
  it("strips PostgREST metacharacters from a search string", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: [], error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A, query: "a,b(c)" }),
    );

    const traceCall = calls.find((call) => call.table === "hx_traces");
    const search = traceCall?.or?.find((expr) => expr.includes("ilike"));
    expect(search).toBeDefined();
    // The injected comma/parens must not survive into the filter expression.
    expect(search).not.toContain("a,b(c)");
    expect(search).toContain("a b c");
  });

  it("applies the status filter", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: [], error: null },
      () => listTraces(USER_A, { projectId: PROJECT_A, status: "error" }),
    );

    const traceCall = calls.find((call) => call.table === "hx_traces");
    expect(traceCall?.filters).toContainEqual(["status", "error"]);
  });

  it("applies the time window", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_projects"
          ? { data: [{ id: PROJECT_A }], error: null }
          : { data: [], error: null },
      () =>
        listTraces(USER_A, {
          projectId: PROJECT_A,
          since: "2026-10-15T00:00:00.000Z",
        }),
    );

    const traceCall = calls.find((call) => call.table === "hx_traces");
    expect(traceCall?.filters).toContainEqual([
      "started_at",
      "2026-10-15T00:00:00.000Z",
    ]);
  });
});

describe("getTrace authorization", () => {
  const traceRow = {
    id: TRACE_A,
    project_id: PROJECT_A,
    external_trace_id: "ext",
    name: "agent",
    status: "ok",
    started_at: "2026-10-15T10:00:00.000Z",
    ended_at: "2026-10-15T10:00:01.000Z",
    environment: null,
    metadata: {},
  };

  it("returns the trace when the session user owns the project", async () => {
    const { result } = await withClient(
      (call) => {
        if (call.table === "hx_traces") {
          return {
            data: {
              ...traceRow,
              hx_projects: { name: "A", owner_id: USER_A.id },
              hx_spans: [{ count: 0 }],
            },
            error: null,
          };
        }
        return { data: [], error: null };
      },
      () => getTrace(USER_A, TRACE_A),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe(TRACE_A);
  });

  it("reports not_found for a trace owned by another user", async () => {
    const { result } = await withClient(
      () => ({
        data: {
          ...traceRow,
          hx_projects: { name: "B", owner_id: USER_B.id },
          hx_spans: [{ count: 0 }],
        },
        error: null,
      }),
      // USER_A asks for USER_B's trace.
      () => getTrace(USER_A, TRACE_A),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // not_found, not forbidden: the response must not confirm the id exists.
      expect(result.error.kind).toBe("not_found");
    }
  });

  it("never loads spans for a trace the user does not own", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_traces"
          ? {
              data: {
                ...traceRow,
                hx_projects: { name: "B", owner_id: USER_B.id },
                hx_spans: [{ count: 3 }],
              },
              error: null,
            }
          : { data: [], error: null },
      () => getTrace(USER_A, TRACE_A),
    );

    // The span query is only reached after the ownership check passes.
    expect(calls.some((call) => call.table === "hx_spans")).toBe(false);
  });

  it("reports not_found for a trace that does not exist", async () => {
    const { result } = await withClient(
      () => ({ data: null, error: null }),
      () => getTrace(USER_A, TRACE_A),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("returns spans ordered by start time", async () => {
    const { calls } = await withClient(
      (call) =>
        call.table === "hx_traces"
          ? {
              data: {
                ...traceRow,
                hx_projects: { name: "A", owner_id: USER_A.id },
                hx_spans: [{ count: 1 }],
              },
              error: null,
            }
          : { data: [], error: null },
      () => getTrace(USER_A, TRACE_A),
    );

    const spanCall = calls.find((call) => call.table === "hx_spans");
    expect(spanCall?.filters).toContainEqual(["trace_id", TRACE_A]);
    expect(spanCall?.order?.[0]).toEqual([
      "started_at",
      { ascending: true },
    ]);
  });

  it("requires a session user", async () => {
    const result = await getTrace({ ...USER_A, id: "" }, TRACE_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
  });

  it.each([
    "not-a-uuid",
    "1; drop table hx_traces",
    "",
    "11111111-1111-1111-1111",
    "11111111-1111-1111-1111-11111111111g",
  ])("rejects the malformed id %j without querying", async (badId) => {
    // A malformed id must be a not_found, not a 500 from a Postgres type
    // error, and it must never reach the database.
    const result = await getTrace(USER_A, badId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
    expect(getServiceClientMock).not.toHaveBeenCalled();
  });

  it("accepts a well-formed uuid through to the query", async () => {
    const { calls } = await withClient(
      () => ({ data: null, error: null }),
      () => getTrace(USER_A, TRACE_A),
    );
    expect(calls.some((call) => call.table === "hx_traces")).toBe(true);
  });
});

describe("listProjects", () => {
  it("scopes by owner_id", async () => {
    const { calls } = await withClient(
      () => ({ data: [], error: null }),
      () => listProjects(USER_A),
    );

    expect(calls[0].filters).toContainEqual(["owner_id", USER_A.id]);
  });

  it("computes the trace count and latest activity", async () => {
    const { result } = await withClient(
      () => ({
        data: [
          {
            id: PROJECT_A,
            name: "A",
            description: null,
            created_at: "2026-10-01T00:00:00.000Z",
            hx_traces: [
              { started_at: "2026-10-15T10:00:00.000Z" },
              { started_at: "2026-10-15T12:00:00.000Z" },
            ],
          },
        ],
        error: null,
      }),
      () => listProjects(USER_A),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].traceCount).toBe(2);
    expect(result.data[0].lastTraceAt).toBe("2026-10-15T12:00:00.000Z");
  });

  it("reports no activity for an empty project", async () => {
    const { result } = await withClient(
      () => ({
        data: [
          {
            id: PROJECT_A,
            name: "A",
            description: null,
            created_at: "2026-10-01T00:00:00.000Z",
            hx_traces: [],
          },
        ],
        error: null,
      }),
      () => listProjects(USER_A),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].traceCount).toBe(0);
    expect(result.data[0].lastTraceAt).toBeNull();
  });
});
