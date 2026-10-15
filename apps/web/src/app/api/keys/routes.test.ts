import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route-level tests for the API key endpoints.
 *
 * These assert the HTTP contract: which status code each situation produces,
 * that unauthenticated callers are refused before any query runs, and that no
 * response body ever carries a hash. The query layer is mocked so each case
 * can be forced without a database.
 */

const getSessionMock = vi.hoisted(() => vi.fn());
const listApiKeysMock = vi.hoisted(() => vi.fn());
const createApiKeyMock = vi.hoisted(() => vi.fn());
const revokeApiKeyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/api-keys/keys", () => ({
  listApiKeys: listApiKeysMock,
  createApiKey: createApiKeyMock,
  revokeApiKey: revokeApiKeyMock,
}));

const { GET, POST } = await import("./route");
const { DELETE } = await import("./[keyId]/route");

const USER = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: "a@example.test",
  displayName: "A",
};

const SESSION = { user: USER, sessionId: "session-1" };
const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const KEY_A = "33333333-3333-3333-3333-333333333333";

const KEY_SUMMARY = {
  id: KEY_A,
  name: "agent",
  prefix: "hx_live_ab12",
  createdAt: "2026-10-15T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  projectId: PROJECT_A,
  projectName: "Project A",
};

function jsonRequest(body: unknown) {
  // A real NextRequest, not a cast plain Request — the route calls
  // `request.json()`, which is a NextRequest method.
  return new NextRequest("http://localhost/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/keys", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    listApiKeysMock.mockReset();
  });

  it("requires a session", async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(listApiKeysMock).not.toHaveBeenCalled();
  });

  it("returns the key list for a signed-in user", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    listApiKeysMock.mockResolvedValue({ ok: true, data: [KEY_SUMMARY] });

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].prefix).toBe("hx_live_ab12");
  });

  it("never includes a hash in the listing response", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    listApiKeysMock.mockResolvedValue({ ok: true, data: [KEY_SUMMARY] });

    const response = await GET();
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain("key_hash");
    expect(text).not.toContain("keyHash");
    // A SHA-256 hex digest is 64 characters; none should appear.
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("marks the listing uncacheable", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    listApiKeysMock.mockResolvedValue({ ok: true, data: [] });

    const response = await GET();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("maps a database failure to 500 without echoing the message", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    listApiKeysMock.mockResolvedValue({
      ok: false,
      error: { kind: "database", message: "relation hx_api_keys does not exist" },
    });

    const response = await GET();
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error.code).toBe("internal_error");
    // The database detail must not reach the client.
    expect(JSON.stringify(body)).not.toContain("relation");
  });
});

describe("POST /api/keys", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    createApiKeyMock.mockReset();
  });

  it("requires a session", async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await POST(jsonRequest({ projectId: PROJECT_A, name: "x" }));
    expect(response.status).toBe(401);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("creates a key and returns the raw value once", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    const rawKey = `hx_live_${"A".repeat(43)}`;
    createApiKeyMock.mockResolvedValue({
      ok: true,
      data: { key: KEY_SUMMARY, rawKey },
    });

    const response = await POST(
      jsonRequest({ projectId: PROJECT_A, name: "agent" }),
    );
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.rawKey).toBe(rawKey);
    expect(body.key.prefix).toBe("hx_live_ab12");
  });

  it("marks the create response uncacheable so the secret is not retained", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    createApiKeyMock.mockResolvedValue({
      ok: true,
      data: { key: KEY_SUMMARY, rawKey: `hx_live_${"A".repeat(43)}` },
    });

    const response = await POST(
      jsonRequest({ projectId: PROJECT_A, name: "agent" }),
    );
    const cacheControl = response.headers.get("Cache-Control") ?? "";
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).toContain("no-cache");
  });

  it("passes the session user and parsed input to the query layer", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    createApiKeyMock.mockResolvedValue({
      ok: true,
      data: { key: KEY_SUMMARY, rawKey: "hx_live_x" },
    });

    await POST(jsonRequest({ projectId: PROJECT_A, name: "  agent  " }));

    expect(createApiKeyMock).toHaveBeenCalledWith(USER, {
      projectId: PROJECT_A,
      name: "agent",
    });
  });

  it.each([
    ["a non-uuid project id", { projectId: "not-a-uuid", name: "agent" }],
    ["an empty name", { projectId: PROJECT_A, name: "" }],
    ["a whitespace-only name", { projectId: PROJECT_A, name: "   " }],
    ["a name over 100 characters", { projectId: PROJECT_A, name: "x".repeat(101) }],
    ["a missing project", { name: "agent" }],
  ])("rejects %s with 400 before any query", async (_label, body) => {
    getSessionMock.mockResolvedValue(SESSION);
    const response = await POST(jsonRequest(body));
    expect(response.status).toBe(400);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    const response = await POST(jsonRequest("{not json"));
    expect(response.status).toBe(400);
    expect(createApiKeyMock).not.toHaveBeenCalled();
  });

  it.each([
    // A Postgres-valid uuid whose version nibble is not 1-8. Zod's `uuid()`
    // rejects these, but the column accepts them, so the route must too.
    "11111111-1111-1111-1111-111111111111",
    "00000000-0000-0000-0000-000000000000",
  ])("accepts the Postgres-valid project id %s", async (projectId) => {
    getSessionMock.mockResolvedValue(SESSION);
    createApiKeyMock.mockResolvedValue({
      ok: true,
      data: { key: KEY_SUMMARY, rawKey: "hx_live_x" },
    });

    const response = await POST(jsonRequest({ projectId, name: "agent" }));
    expect(response.status).toBe(201);
  });

  it("maps an unowned project to 404", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    createApiKeyMock.mockResolvedValue({
      ok: false,
      error: { kind: "not_found", message: "Project not found." },
    });

    const response = await POST(
      jsonRequest({ projectId: PROJECT_A, name: "agent" }),
    );
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/keys/[keyId]", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    revokeApiKeyMock.mockReset();
  });

  const params = Promise.resolve({ keyId: KEY_A });

  it("requires a session", async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await DELETE(new Request("http://localhost") as never, {
      params,
    });
    expect(response.status).toBe(401);
    expect(revokeApiKeyMock).not.toHaveBeenCalled();
  });

  it("revokes a key the user owns", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    revokeApiKeyMock.mockResolvedValue({
      ok: true,
      data: { id: KEY_A, revokedAt: "2026-10-15T12:00:00.000Z" },
    });

    const response = await DELETE(new Request("http://localhost") as never, {
      params,
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.id).toBe(KEY_A);
    expect(body.revokedAt).toBe("2026-10-15T12:00:00.000Z");
  });

  it("is idempotent — a second revoke also succeeds", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    revokeApiKeyMock.mockResolvedValue({
      ok: true,
      data: { id: KEY_A, revokedAt: "2026-10-15T12:00:00.000Z" },
    });

    const first = await DELETE(new Request("http://localhost") as never, {
      params,
    });
    const second = await DELETE(new Request("http://localhost") as never, {
      params,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("returns 404 for another user's key", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    revokeApiKeyMock.mockResolvedValue({
      ok: false,
      error: { kind: "not_found", message: "API key not found." },
    });

    const response = await DELETE(new Request("http://localhost") as never, {
      params,
    });
    expect(response.status).toBe(404);
  });

  it.each([
    "not-a-uuid",
    "1; drop table hx_api_keys",
    "11111111-1111-1111-1111",
    "11111111-1111-1111-1111-11111111111g",
  ])("rejects the malformed id %j with 404 and no query", async (badId) => {
    getSessionMock.mockResolvedValue(SESSION);
    const response = await DELETE(new Request("http://localhost") as never, {
      params: Promise.resolve({ keyId: badId }),
    });
    expect(response.status).toBe(404);
    // Must not reach Postgres, which would raise a uuid type error.
    expect(revokeApiKeyMock).not.toHaveBeenCalled();
  });

  it("maps a database failure to 500", async () => {
    getSessionMock.mockResolvedValue(SESSION);
    revokeApiKeyMock.mockResolvedValue({
      ok: false,
      error: { kind: "database", message: "connection refused" },
    });

    const response = await DELETE(new Request("http://localhost") as never, {
      params,
    });
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });
});
