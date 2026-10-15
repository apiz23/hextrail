import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Session validation tests.
 *
 * `getSession` reads a cookie via `next/headers`, which is stubbed here so the
 * validation logic can be exercised without a running Next.js server. The
 * important cases are the negative ones: an expired, revoked, unknown or
 * orphaned session must all be indistinguishable from "not signed in".
 */

const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "hx_session" && cookieValue.current !== undefined
        ? { name, value: cookieValue.current }
        : undefined,
  }),
}));

const getServiceClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/service", () => ({
  getServiceClient: getServiceClientMock,
}));

const { getSession, validateSessionToken, SESSION_COOKIE } = await import(
  "./session"
);
const { hashSessionToken } = await import("./password");

const USER = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: "user@example.test",
  display_name: "User",
};

/** Builds a client whose single `.maybeSingle()` resolves to `row`. */
function clientReturning(row: unknown, error: unknown = null) {
  const filters: [string, unknown][] = [];
  const api = {
    select: () => api,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return api;
    },
    maybeSingle: async () => ({ data: row, error }),
  };
  return { client: { from: () => api }, filters };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    revoked_at: null,
    hx_users: USER,
    ...overrides,
  };
}

describe("getSession", () => {
  beforeEach(() => {
    getServiceClientMock.mockReset();
    cookieValue.current = undefined;
  });

  it("returns null when there is no cookie", async () => {
    await expect(getSession()).resolves.toBeNull();
    // No cookie means no database round trip.
    expect(getServiceClientMock).not.toHaveBeenCalled();
  });

  it("returns the session for a valid cookie", async () => {
    const token = "a".repeat(43);
    cookieValue.current = token;
    getServiceClientMock.mockReturnValue(clientReturning(sessionRow()).client);

    const session = await getSession();
    expect(session?.user.id).toBe(USER.id);
    expect(session?.user.email).toBe(USER.email);
    expect(session?.sessionId).toBe("session-1");
  });

  it("looks the session up by hash, never by the raw token", async () => {
    const token = "b".repeat(43);
    cookieValue.current = token;
    const mock = clientReturning(sessionRow());
    getServiceClientMock.mockReturnValue(mock.client);

    await getSession();

    expect(mock.filters).toContainEqual(["token_hash", hashSessionToken(token)]);
    expect(mock.filters).not.toContainEqual(["token_hash", token]);
  });

  it("returns null for an unknown token", async () => {
    cookieValue.current = "c".repeat(43);
    getServiceClientMock.mockReturnValue(clientReturning(null).client);
    await expect(getSession()).resolves.toBeNull();
  });

  it("returns null on a database error", async () => {
    cookieValue.current = "d".repeat(43);
    getServiceClientMock.mockReturnValue(
      clientReturning(null, { message: "connection refused" }).client,
    );
    await expect(getSession()).resolves.toBeNull();
  });
});

describe("validateSessionToken", () => {
  beforeEach(() => {
    getServiceClientMock.mockReset();
  });

  it("rejects a token that is too short to be real", async () => {
    await expect(validateSessionToken("short")).resolves.toBeNull();
    expect(getServiceClientMock).not.toHaveBeenCalled();
  });

  it("rejects an empty token", async () => {
    await expect(validateSessionToken("")).resolves.toBeNull();
  });

  it("accepts a live session", async () => {
    getServiceClientMock.mockReturnValue(clientReturning(sessionRow()).client);
    const session = await validateSessionToken("e".repeat(43));
    expect(session).not.toBeNull();
  });

  it("rejects an expired session", async () => {
    getServiceClientMock.mockReturnValue(
      clientReturning(
        sessionRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      ).client,
    );
    await expect(validateSessionToken("f".repeat(43))).resolves.toBeNull();
  });

  it("rejects a revoked session even when unexpired", async () => {
    getServiceClientMock.mockReturnValue(
      clientReturning(
        sessionRow({ revoked_at: new Date().toISOString() }),
      ).client,
    );
    await expect(validateSessionToken("g".repeat(43))).resolves.toBeNull();
  });

  it("rejects a session whose user row is gone", async () => {
    getServiceClientMock.mockReturnValue(
      clientReturning(sessionRow({ hx_users: null })).client,
    );
    await expect(validateSessionToken("h".repeat(43))).resolves.toBeNull();
  });

  it("rejects exactly at the expiry boundary", async () => {
    getServiceClientMock.mockReturnValue(
      clientReturning(
        sessionRow({ expires_at: new Date(Date.now() - 1).toISOString() }),
      ).client,
    );
    await expect(validateSessionToken("i".repeat(43))).resolves.toBeNull();
  });

  it("accepts a session that expires in the future", async () => {
    getServiceClientMock.mockReturnValue(
      clientReturning(
        sessionRow({ expires_at: new Date(Date.now() + 60_000).toISOString() }),
      ).client,
    );
    await expect(validateSessionToken("j".repeat(43))).resolves.not.toBeNull();
  });
});

describe("SESSION_COOKIE", () => {
  it("is the documented name", () => {
    expect(SESSION_COOKIE).toBe("hx_session");
  });
});
