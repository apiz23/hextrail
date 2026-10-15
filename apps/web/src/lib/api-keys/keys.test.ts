import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API key management tests.
 *
 * The Supabase client is mocked so each test declares exactly which rows exist
 * and can then assert on what the code asked for. The properties that matter
 * here are: key material is unpredictable and correctly hashed, the raw key is
 * returned once and never derived from storage, and every operation is scoped
 * by project ownership.
 */

interface QueryCall {
  table: string;
  select?: string;
  filters: [string, unknown][];
  order?: [string, unknown][];
  insert?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

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
      order: (column: string, options: unknown) => {
        call.order = [...(call.order ?? []), [column, options]];
        return api;
      },
      insert: (values: Record<string, unknown>) => {
        call.insert = values;
        return api;
      },
      update: (values: Record<string, unknown>) => {
        call.update = values;
        return api;
      },
      maybeSingle: async () => respond(call),
      single: async () => respond(call),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(respond(call)).then(resolve),
    };

    return api;
  }

  return { calls, client: { from: (table: string) => builder(table) } };
}

const getServiceClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/service", () => ({
  getServiceClient: getServiceClientMock,
}));

const {
  createApiKey,
  displayPrefix,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  DISPLAY_PREFIX_LENGTH,
  KEY_PREFIX,
} = await import("./keys");
const { hashApiKey } = await import("@/lib/ingestion/auth");

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
const KEY_A = "33333333-3333-3333-3333-333333333333";

async function withClient<T>(
  respond: (call: QueryCall) => unknown,
  run: () => Promise<T>,
): Promise<{ result: T; calls: QueryCall[] }> {
  const mock = createMockClient(respond);
  getServiceClientMock.mockReturnValue(mock.client);
  const result = await run();
  return { result, calls: mock.calls };
}

/** Routes each table to a sensible default so a test can vary just one. */
function tableResponder(
  overrides: Partial<Record<string, (call: QueryCall) => unknown>> = {},
) {
  return (call: QueryCall) => {
    const override = overrides[call.table];
    if (override) return override(call);
    if (call.table === "hx_projects") {
      return { data: [{ id: PROJECT_A, name: "Project A" }], error: null };
    }
    return { data: [], error: null };
  };
}

describe("generateApiKey", () => {
  it("uses the hx_live_ prefix that ingestion authentication requires", () => {
    expect(generateApiKey().startsWith(KEY_PREFIX)).toBe(true);
    expect(KEY_PREFIX).toBe("hx_live_");
  });

  it("is long enough for the length check in authenticateApiKey", () => {
    // authenticateApiKey rejects anything shorter than 32 characters.
    expect(generateApiKey().length).toBeGreaterThanOrEqual(32);
  });

  it("is url-safe, so it survives an Authorization header unescaped", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^hx_live_[A-Za-z0-9_-]+$/);
    expect(key).not.toContain("+");
    expect(key).not.toContain("/");
    expect(key).not.toContain("=");
  });

  it("does not repeat across many calls", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey()));
    expect(keys.size).toBe(500);
  });

  it("has no obvious structure — the suffix is not sequential or zero-padded", () => {
    // Guards against an accidental switch to a counter or a Math.random
    // scheme, which would make keys predictable from one another.
    const keys = Array.from({ length: 20 }, () => generateApiKey());
    const suffixes = keys.map((key) => key.slice(KEY_PREFIX.length));
    expect(new Set(suffixes.map((s) => s.slice(0, 8))).size).toBeGreaterThan(15);
  });
});

describe("displayPrefix", () => {
  it("returns a prefix inside the column's 8..16 constraint", () => {
    const prefix = displayPrefix(generateApiKey());
    expect(prefix.length).toBe(DISPLAY_PREFIX_LENGTH);
    expect(prefix.length).toBeGreaterThanOrEqual(8);
    expect(prefix.length).toBeLessThanOrEqual(16);
    expect(prefix.startsWith(KEY_PREFIX)).toBe(true);
  });

  it("leaves the vast majority of the key secret", () => {
    const key = generateApiKey();
    const prefix = displayPrefix(key);
    // Only 4 characters of entropy are revealed.
    expect(key.slice(prefix.length).length).toBeGreaterThan(30);
  });
});

describe("hashing contract", () => {
  it("hashes to 64 hex characters, matching the key_hash constraint", () => {
    expect(hashApiKey(generateApiKey())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic, so a stored hash can authenticate the same key", () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("does not contain the raw key", () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).not.toContain(key);
    expect(hashApiKey(key)).not.toContain(key.slice(KEY_PREFIX.length));
  });
});

describe("createApiKey", () => {
  beforeEach(() => getServiceClientMock.mockReset());

  it("returns the raw key exactly once", async () => {
    const { result } = await withClient(
      tableResponder({
        hx_projects: () => ({
          data: { id: PROJECT_A, name: "Project A" },
          error: null,
        }),
        hx_api_keys: (call) =>
          call.insert
            ? {
                data: {
                  id: KEY_A,
                  project_id: PROJECT_A,
                  name: call.insert.name,
                  key_prefix: call.insert.key_prefix,
                  created_at: "2026-10-15T10:00:00.000Z",
                  last_used_at: null,
                  revoked_at: null,
                },
                error: null,
              }
            : { data: [], error: null },
      }),
      () => createApiKey(USER_A, { projectId: PROJECT_A, name: "agent" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rawKey).toMatch(/^hx_live_[A-Za-z0-9_-]{43}$/);
  });

  it("stores only the hash and the prefix — never the raw key", async () => {
    const { result, calls } = await withClient(
      tableResponder({
        hx_projects: () => ({
          data: { id: PROJECT_A, name: "Project A" },
          error: null,
        }),
        hx_api_keys: (call) =>
          call.insert
            ? {
                data: {
                  id: KEY_A,
                  project_id: PROJECT_A,
                  name: "agent",
                  key_prefix: call.insert.key_prefix,
                  created_at: "2026-10-15T10:00:00.000Z",
                  last_used_at: null,
                  revoked_at: null,
                },
                error: null,
              }
            : { data: [], error: null },
      }),
      () => createApiKey(USER_A, { projectId: PROJECT_A, name: "agent" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const insert = calls.find((call) => call.insert)?.insert as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(insert);

    // The raw key must not appear anywhere in the write.
    expect(serialized).not.toContain(result.data.rawKey);
    // What must be there: the hash, matching the raw key.
    expect(insert.key_hash).toBe(hashApiKey(result.data.rawKey));
    expect(insert.key_prefix).toBe(displayPrefix(result.data.rawKey));
    // And nothing else that could reconstruct it.
    expect(Object.keys(insert).sort()).toEqual([
      "key_hash",
      "key_prefix",
      "name",
      "project_id",
    ]);
  });

  it("authorizes against owner_id before inserting", async () => {
    const { calls } = await withClient(
      tableResponder({
        hx_projects: () => ({
          data: { id: PROJECT_A, name: "Project A" },
          error: null,
        }),
      }),
      () => createApiKey(USER_A, { projectId: PROJECT_A, name: "agent" }),
    );

    const projectCall = calls.find((call) => call.table === "hx_projects");
    expect(projectCall?.filters).toContainEqual(["owner_id", USER_A.id]);
    expect(projectCall?.filters).toContainEqual(["id", PROJECT_A]);
  });

  it("refuses to mint a key for another user's project", async () => {
    const { result, calls } = await withClient(
      // The owner_id predicate makes the lookup miss.
      tableResponder({ hx_projects: () => ({ data: null, error: null }) }),
      () => createApiKey(USER_B, { projectId: PROJECT_A, name: "agent" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
    // No credential was created.
    expect(calls.some((call) => call.insert)).toBe(false);
  });

  it("requires a session user", async () => {
    const result = await createApiKey(
      { ...USER_A, id: "" },
      { projectId: PROJECT_A, name: "agent" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
    expect(getServiceClientMock).not.toHaveBeenCalled();
  });

  it("rejects an empty name before touching the database", async () => {
    const result = await createApiKey(USER_A, {
      projectId: PROJECT_A,
      name: "   ",
    });
    expect(result.ok).toBe(false);
    expect(getServiceClientMock).not.toHaveBeenCalled();
  });

  it("rejects a name longer than the column allows", async () => {
    const result = await createApiKey(USER_A, {
      projectId: PROJECT_A,
      name: "x".repeat(101),
    });
    expect(result.ok).toBe(false);
    expect(getServiceClientMock).not.toHaveBeenCalled();
  });

  it("trims the name before storing it", async () => {
    const { calls } = await withClient(
      tableResponder({
        hx_projects: () => ({
          data: { id: PROJECT_A, name: "Project A" },
          error: null,
        }),
        hx_api_keys: (call) =>
          call.insert
            ? {
                data: {
                  id: KEY_A,
                  project_id: PROJECT_A,
                  name: call.insert.name,
                  key_prefix: call.insert.key_prefix,
                  created_at: "2026-10-15T10:00:00.000Z",
                  last_used_at: null,
                  revoked_at: null,
                },
                error: null,
              }
            : { data: [], error: null },
      }),
      () => createApiKey(USER_A, { projectId: PROJECT_A, name: "  agent  " }),
    );

    const insert = calls.find((call) => call.insert)?.insert;
    expect(insert?.name).toBe("agent");
  });

  it("surfaces a database failure as an error rather than throwing", async () => {
    const { result } = await withClient(
      tableResponder({
        hx_projects: () => ({
          data: { id: PROJECT_A, name: "Project A" },
          error: null,
        }),
        hx_api_keys: () => ({ data: null, error: { message: "boom" } }),
      }),
      () => createApiKey(USER_A, { projectId: PROJECT_A, name: "agent" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("database");
  });
});

describe("listApiKeys", () => {
  it("scopes the query to the user's owned projects", async () => {
    const { calls } = await withClient(tableResponder(), () =>
      listApiKeys(USER_A),
    );

    const keyCall = calls.find((call) => call.table === "hx_api_keys");
    expect(keyCall?.filters).toContainEqual(["project_id", [PROJECT_A]]);
  });

  it("never selects key_hash", async () => {
    const { calls } = await withClient(tableResponder(), () =>
      listApiKeys(USER_A),
    );

    const keyCall = calls.find((call) => call.table === "hx_api_keys");
    expect(keyCall?.select).toBeDefined();
    expect(keyCall?.select).not.toContain("key_hash");
  });

  it("does not query keys at all when the user owns no projects", async () => {
    const { result, calls } = await withClient(
      tableResponder({ hx_projects: () => ({ data: [], error: null }) }),
      () => listApiKeys(USER_A),
    );

    expect(result).toEqual({ ok: true, data: [] });
    expect(calls.some((call) => call.table === "hx_api_keys")).toBe(false);
  });

  it("maps rows to the summary shape and resolves the project name", async () => {
    const { result } = await withClient(
      tableResponder({
        hx_api_keys: () => ({
          data: [
            {
              id: KEY_A,
              project_id: PROJECT_A,
              name: "agent",
              key_prefix: "hx_live_ab12",
              created_at: "2026-10-15T10:00:00.000Z",
              last_used_at: "2026-10-15T11:00:00.000Z",
              revoked_at: null,
            },
          ],
          error: null,
        }),
      }),
      () => listApiKeys(USER_A),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toEqual({
      id: KEY_A,
      name: "agent",
      prefix: "hx_live_ab12",
      createdAt: "2026-10-15T10:00:00.000Z",
      lastUsedAt: "2026-10-15T11:00:00.000Z",
      revokedAt: null,
      projectId: PROJECT_A,
      projectName: "Project A",
    });
    // The hash is not part of the shape.
    expect(result.data[0]).not.toHaveProperty("keyHash");
    expect(result.data[0]).not.toHaveProperty("key_hash");
  });

  it("uses placeholder text for a project that cannot be named", async () => {
    // A key can only be listed if its project is in the owned scope, and the
    // project-name lookup is built from that same scope. In practice the two
    // agree, so this covers the defensive branch: a key whose project id
    // resolves to no name must show a placeholder rather than the raw uuid.
    const { result } = await withClient(
      (call) => {
        if (call.table === "hx_projects") {
          // Present in the id list, absent from the name lookup.
          return call.select === "id"
            ? { data: [{ id: PROJECT_A }], error: null }
            : { data: [], error: null };
        }
        return {
          data: [
            {
              id: KEY_A,
              project_id: PROJECT_A,
              name: "agent",
              key_prefix: "hx_live_ab12",
              created_at: "2026-10-15T10:00:00.000Z",
              last_used_at: null,
              revoked_at: null,
            },
          ],
          error: null,
        };
      },
      () => listApiKeys(USER_A),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].projectName).toBe("Unknown project");
    expect(result.data[0].projectName).not.toBe(PROJECT_A);
  });
  it("requires a session user", async () => {
    const result = await listApiKeys({ ...USER_A, id: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
  });

  it("surfaces a database failure", async () => {
    const { result } = await withClient(
      tableResponder({
        hx_api_keys: () => ({ data: null, error: { message: "boom" } }),
      }),
      () => listApiKeys(USER_A),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("database");
  });
});

describe("revokeApiKey", () => {
  const liveKey = {
    id: KEY_A,
    revoked_at: null,
  };

  it("sets revoked_at on a live key", async () => {
    const { result, calls } = await withClient(
      tableResponder({
        hx_api_keys: (call) =>
          call.update ? { data: null, error: null } : { data: liveKey, error: null },
      }),
      () => revokeApiKey(USER_A, KEY_A),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number.isFinite(Date.parse(result.data.revokedAt))).toBe(true);

    const updateCall = calls.find((call) => call.update);
    expect(updateCall?.update?.revoked_at).toBe(result.data.revokedAt);
    // Also asserts the row is still live at write time, so a concurrent revoke
    // cannot have its timestamp overwritten.
    expect(updateCall?.filters).toContainEqual(["revoked_at", null]);
  });

  it("scopes both the read and the write to the user's projects", async () => {
    const { calls } = await withClient(
      tableResponder({
        hx_api_keys: (call) =>
          call.update ? { data: null, error: null } : { data: liveKey, error: null },
      }),
      () => revokeApiKey(USER_A, KEY_A),
    );

    const keyCalls = calls.filter((call) => call.table === "hx_api_keys");
    for (const call of keyCalls) {
      expect(call.filters).toContainEqual(["project_id", [PROJECT_A]]);
    }
  });

  it("is idempotent — revoking twice keeps the original timestamp", async () => {
    const alreadyRevoked = {
      id: KEY_A,
      revoked_at: "2026-01-01T00:00:00.000Z",
    };

    const { result, calls } = await withClient(
      tableResponder({
        hx_api_keys: () => ({ data: alreadyRevoked, error: null }),
      }),
      () => revokeApiKey(USER_A, KEY_A),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.revokedAt).toBe("2026-01-01T00:00:00.000Z");
    // No write was issued, so the earlier timestamp stands.
    expect(calls.some((call) => call.update)).toBe(false);
  });

  it("refuses another user's key with not_found, not forbidden", async () => {
    const { result, calls } = await withClient(
      // owner-scoped: the key is in a project this user does not own, so the
      // read misses even though the key id is real.
      tableResponder({ hx_api_keys: () => ({ data: null, error: null }) }),
      () => revokeApiKey(USER_B, KEY_A),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
    expect(calls.some((call) => call.update)).toBe(false);
  });

  it("refuses when the user owns no projects", async () => {
    const { result, calls } = await withClient(
      tableResponder({ hx_projects: () => ({ data: [], error: null }) }),
      () => revokeApiKey(USER_A, KEY_A),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
    expect(calls.some((call) => call.table === "hx_api_keys")).toBe(false);
  });

  it("requires a session user", async () => {
    const result = await revokeApiKey({ ...USER_A, id: "" }, KEY_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
  });

  it("surfaces a write failure without reporting success", async () => {
    const { result } = await withClient(
      tableResponder({
        hx_api_keys: (call) =>
          call.update ? { data: null, error: { message: "boom" } } : { data: liveKey, error: null },
      }),
      () => revokeApiKey(USER_A, KEY_A),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("database");
  });
});
