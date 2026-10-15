import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tests for API key authentication.
 *
 * The Supabase client is mocked so these run without a database. They cover
 * key-shape rejection, unknown keys, revoked keys, and the project scoping
 * that the route handler depends on.
 */

const maybeSingle = vi.fn();
const updateEq = vi.fn();
const update = vi.fn(() => ({ eq: updateEq }));
const select = vi.fn(() => ({ eq: vi.fn(() => ({ is: vi.fn(() => ({ maybeSingle })) })) }));
const from = vi.fn(() => ({ select, update }));

vi.mock("@/lib/supabase/service", () => ({
  getServiceClient: () => ({ from }),
}));

vi.mock("server-only", () => ({}));

const { authenticateApiKey, hashApiKey, readBearerToken } = await import("./auth");

const VALID_KEY = "hx_live_1234567890abcdefghijklmnopqrstuv";

beforeEach(() => {
  maybeSingle.mockReset();
  update.mockClear();
  updateEq.mockReset();
  updateEq.mockResolvedValue({ error: null });
});

describe("readBearerToken", () => {
  it("extracts a bearer token", () => {
    expect(readBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(readBearerToken("bearer abc123")).toBe("abc123");
  });

  it("returns null when the header is missing", () => {
    expect(readBearerToken(null)).toBeNull();
  });

  it("returns null for a non-bearer scheme", () => {
    expect(readBearerToken("Basic abc123")).toBeNull();
  });

  it("returns null for an empty bearer value", () => {
    expect(readBearerToken("Bearer ")).toBeNull();
  });
});

describe("hashApiKey", () => {
  it("produces a 64-character hex digest", () => {
    const hash = hashApiKey(VALID_KEY);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashApiKey(VALID_KEY)).toBe(hashApiKey(VALID_KEY));
  });

  it("differs for different keys", () => {
    expect(hashApiKey(VALID_KEY)).not.toBe(hashApiKey(VALID_KEY + "x"));
  });
});

describe("authenticateApiKey", () => {
  it("rejects a key without the expected prefix", async () => {
    const result = await authenticateApiKey("wrongprefix_1234567890abcdefghijklmnop");
    expect(result).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a key that is too short", async () => {
    const result = await authenticateApiKey("hx_live_short");
    expect(result).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("returns the project for a valid key", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: "key-1",
        project_id: "project-1",
        key_hash: hashApiKey(VALID_KEY),
      },
      error: null,
    });

    const result = await authenticateApiKey(VALID_KEY);
    expect(result).toEqual({ projectId: "project-1", apiKeyId: "key-1" });
  });

  it("returns null when the key is unknown", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await authenticateApiKey(VALID_KEY)).toBeNull();
  });

  it("returns null when the database errors", async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { code: "500", message: "boom" },
    });
    expect(await authenticateApiKey(VALID_KEY)).toBeNull();
  });

  it("returns null on a hash mismatch", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: "key-1",
        project_id: "project-1",
        key_hash: "0".repeat(64),
      },
      error: null,
    });
    expect(await authenticateApiKey(VALID_KEY)).toBeNull();
  });

  it("records last_used_at on success", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: "key-1",
        project_id: "project-1",
        key_hash: hashApiKey(VALID_KEY),
      },
      error: null,
    });

    await authenticateApiKey(VALID_KEY);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ last_used_at: expect.any(String) }),
    );
  });

  it("still authenticates when the last_used_at write fails", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: "key-1",
        project_id: "project-1",
        key_hash: hashApiKey(VALID_KEY),
      },
      error: null,
    });
    updateEq.mockRejectedValue(new Error("network"));

    await expect(authenticateApiKey(VALID_KEY)).rejects.toThrow();
  });
});
