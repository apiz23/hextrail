import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Revocation takes effect immediately for ingestion.
 *
 * This is the property that makes revocation worth anything, and it is a
 * cross-module claim: `revokeApiKey` writes `revoked_at`, and
 * `authenticateApiKey` must refuse a key in that state. Testing either side
 * alone would not prove it, so this file drives both against one mock
 * database whose `hx_api_keys` row is shared.
 */

interface ApiKeyRecord {
  id: string;
  project_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const getServiceClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/service", () => ({
  getServiceClient: getServiceClientMock,
}));

const { createApiKey, revokeApiKey } = await import("./keys");
const { authenticateApiKey } = await import("@/lib/ingestion/auth");

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

/**
 * A tiny in-memory stand-in for the `hx_api_keys` table that actually applies
 * the predicates the production code relies on: `key_hash`, `project_id in
 * (...)`, and `revoked_at is null`. That fidelity is the point — a mock that
 * ignored `revoked_at` would make this suite pass while the real thing failed.
 */
function createStatefulClient(rows: ApiKeyRecord[]) {
  const updates: Record<string, unknown>[] = [];

  function matches(row: ApiKeyRecord, filters: [string, unknown][]): boolean {
    return filters.every(([column, value]) => {
      switch (column) {
        case "key_hash":
          return row.key_hash === value;
        case "id":
          return row.id === value;
        case "project_id":
          return Array.isArray(value)
            ? (value as string[]).includes(row.project_id)
            : row.project_id === value;
        case "revoked_at":
          return row.revoked_at === value;
        case "owner_id":
          // hx_projects only; not a column on the key row.
          return false;
        default:
          return true;
      }
    });
  }

  function table(name: string) {
    const filters: [string, unknown][] = [];
    let patch: Record<string, unknown> | null = null;
    let inserted: Record<string, unknown> | null = null;
    // PostgREST returns an array for a list query and a single row (or null)
    // for `maybeSingle`/`single`. Tracking which one was asked for keeps the
    // mock faithful: a list query must not resolve to a bare object.
    let single = false;

    const api = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return api;
      },
      is: (column: string, value: unknown) => {
        filters.push([column, value]);
        return api;
      },
      in: (column: string, value: unknown) => {
        filters.push([column, value]);
        return api;
      },
      order: () => api,
      insert: (values: Record<string, unknown>) => {
        inserted = values;
        const row: ApiKeyRecord = {
          id: `key-${rows.length + 1}`,
          project_id: String(values.project_id),
          name: String(values.name),
          key_hash: String(values.key_hash),
          key_prefix: String(values.key_prefix),
          created_at: new Date().toISOString(),
          last_used_at: null,
          revoked_at: null,
        };
        rows.push(row);
        return api;
      },
      update: (values: Record<string, unknown>) => {
        patch = values;
        updates.push(values);
        return api;
      },
      maybeSingle: async () => {
        single = true;
        return resolve();
      },
      single: async () => {
        single = true;
        return resolve();
      },
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled),
    };

    function resolve() {
      if (name === "hx_projects") {
        // Only PROJECT_A exists, and only USER_A owns it.
        const owner = filters.find(([column]) => column === "owner_id")?.[1];
        const wanted = filters.find(([column]) => column === "id")?.[1];

        const owned =
          owner === USER_A.id && (wanted === undefined || wanted === PROJECT_A);

        if (single) {
          return { data: owned ? { id: PROJECT_A, name: "Project A" } : null, error: null };
        }
        return {
          data: owner === USER_A.id ? [{ id: PROJECT_A, name: "Project A" }] : [],
          error: null,
        };
      }

      if (name !== "hx_api_keys") return { data: null, error: null };

      if (inserted) {
        const row = rows.find((r) => r.key_hash === inserted?.key_hash);
        return { data: row ?? null, error: null };
      }

      const matching = rows.filter((row) => matches(row, filters));

      if (patch) {
        for (const row of matching) Object.assign(row, patch);
        return { data: null, error: null };
      }

      return { data: matching[0] ?? null, error: null };
    }

    return api;
  }

  return { client: { from: table }, updates, rows };
}

describe("revocation is immediate for ingestion", () => {
  beforeEach(() => getServiceClientMock.mockReset());

  it("a freshly created key authenticates", async () => {
    const state = createStatefulClient([]);
    getServiceClientMock.mockReturnValue(state.client);

    const created = await createApiKey(USER_A, {
      projectId: PROJECT_A,
      name: "agent",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const auth = await authenticateApiKey(created.data.rawKey);
    expect(auth).not.toBeNull();
    expect(auth?.projectId).toBe(PROJECT_A);
  });

  it("the same key is rejected after revocation", async () => {
    const state = createStatefulClient([]);
    getServiceClientMock.mockReturnValue(state.client);

    const created = await createApiKey(USER_A, {
      projectId: PROJECT_A,
      name: "agent",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rawKey = created.data.rawKey;
    const keyId = created.data.key.id;

    // Live first, so the test would fail loudly if the key never worked.
    expect(await authenticateApiKey(rawKey)).not.toBeNull();

    const revoked = await revokeApiKey(USER_A, keyId);
    expect(revoked.ok).toBe(true);

    // Rejected with no cache to expire and no delay to wait for.
    expect(await authenticateApiKey(rawKey)).toBeNull();
  });

  it("an unauthenticated user cannot revoke someone else's key, and it stays live", async () => {
    const state = createStatefulClient([]);
    getServiceClientMock.mockReturnValue(state.client);

    const created = await createApiKey(USER_A, {
      projectId: PROJECT_A,
      name: "agent",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rawKey = created.data.rawKey;

    // USER_B owns no projects, so the key is not in their scope.
    const revoked = await revokeApiKey(USER_B, created.data.key.id);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.kind).toBe("not_found");

    // The critical assertion: the failed attempt did not revoke it.
    expect(await authenticateApiKey(rawKey)).not.toBeNull();
  });

  it("a revoked key cannot be revived by revoking it again", async () => {
    const state = createStatefulClient([]);
    getServiceClientMock.mockReturnValue(state.client);

    const created = await createApiKey(USER_A, {
      projectId: PROJECT_A,
      name: "agent",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rawKey = created.data.rawKey;
    const keyId = created.data.key.id;

    await revokeApiKey(USER_A, keyId);
    const first = state.rows.find((row) => row.id === keyId)?.revoked_at;

    await revokeApiKey(USER_A, keyId);
    const second = state.rows.find((row) => row.id === keyId)?.revoked_at;

    expect(second).toBe(first);
    expect(await authenticateApiKey(rawKey)).toBeNull();
  });
});
