import { describe, expect, it } from "vitest";

import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  safeEqual,
  verifyPassword,
} from "./password";

describe("hashPassword / verifyPassword", () => {
  it("produces a bcrypt string the column constraint accepts", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    // hx_users.password_hash requires at least 20 chars; bcrypt is 60.
    expect(hash.length).toBe(60);
  });

  it("verifies the correct password", async () => {
    const hash = await hashPassword("s3cret-password");
    await expect(verifyPassword("s3cret-password", hash)).resolves.toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("s3cret-password");
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("salts, so the same password hashes differently", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("returns false for a null hash (unknown user) without throwing", async () => {
    await expect(verifyPassword("anything", null)).resolves.toBe(false);
  });

  it("still runs a comparison for a null hash, so timing does not leak", async () => {
    // Indirect but meaningful: the null-hash path must not short-circuit, or
    // "user does not exist" would be measurably faster than "wrong password".
    const start = performance.now();
    await verifyPassword("anything", null);
    const elapsed = performance.now() - start;
    // A bcrypt cost-12 comparison takes tens of milliseconds; a short-circuit
    // would return in well under one.
    expect(elapsed).toBeGreaterThan(1);
  });
});

describe("session tokens", () => {
  it("generates a high-entropy token", () => {
    const token = generateSessionToken();
    // 32 random bytes base64url encoded -> 43 chars.
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not repeat", () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => generateSessionToken()),
    );
    expect(tokens.size).toBe(50);
  });

  it("hashes deterministically to 64 hex chars", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
  });

  it("does not put the raw token in the hash", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it("hashes different tokens differently", () => {
    expect(hashSessionToken("token-a")).not.toBe(hashSessionToken("token-b"));
  });
});

describe("safeEqual", () => {
  it("accepts identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("rejects strings of different length without throwing", () => {
    // timingSafeEqual throws on a length mismatch, so the guard matters.
    expect(safeEqual("short", "much longer string")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "x")).toBe(false);
  });
});
