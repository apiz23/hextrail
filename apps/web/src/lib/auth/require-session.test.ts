import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Access-gate tests.
 *
 * The dashboard gate is a plain function precisely so it can be tested without
 * rendering React — the assertions that matter are about the decision it makes,
 * not about markup.
 *
 * The negative cases carry the weight: anything other than a validated session
 * must yield `null`, because `null` is what makes the layout redirect before any
 * dashboard shell is rendered.
 */

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({
  getSession: getSessionMock,
}));

const { requireSession } = await import("./require-session");

const SESSION = {
  user: {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    email: "user@example.test",
    displayName: "User",
  },
  sessionId: "session-1",
};

beforeEach(() => {
  getSessionMock.mockReset();
});

describe("requireSession", () => {
  it("returns the session when one is valid", async () => {
    getSessionMock.mockResolvedValue(SESSION);

    const access = await requireSession();

    expect(access).not.toBeNull();
    expect(access?.session.user.id).toBe(SESSION.user.id);
  });

  it("returns null when there is no session", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(requireSession()).resolves.toBeNull();
  });

  it("delegates to getSession rather than reading a cookie itself", async () => {
    // If this ever read the cookie directly it would be a presence check, which
    // a revoked or expired session would defeat.
    getSessionMock.mockResolvedValue(SESSION);
    await requireSession();
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a database failure instead of granting access", async () => {
    getSessionMock.mockRejectedValue(new Error("connection refused"));
    await expect(requireSession()).rejects.toThrow("connection refused");
  });
});
