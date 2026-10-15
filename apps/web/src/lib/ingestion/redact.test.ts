import { describe, expect, it } from "vitest";

import {
  REDACTED,
  isSensitiveKey,
  redactRecord,
  redactStringValue,
  redactValue,
} from "./redact";

describe("isSensitiveKey", () => {
  it.each([
    "password",
    "PASSWORD",
    "user_password",
    "db-password",
    "apiKey",
    "api_key",
    "secret",
    "client_secret",
    "access_token",
    "refresh_token",
    "authorization",
    "Authorization",
    "cookie",
    "session_id",
    "private_key",
    "credential",
  ])("flags %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["name", "model", "region", "latency_ms", "input", "output", "notes"])(
    "does not flag %s",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it("does not flag a key that merely contains a sensitive word", () => {
    expect(isSensitiveKey("passwordpolicy")).toBe(false);
  });
});

describe("redactStringValue", () => {
  it("masks a bearer token", () => {
    expect(redactStringValue("Bearer abc123DEF456ghi789")).toBe(REDACTED);
  });

  it("masks a bearer token inside a sentence", () => {
    const result = redactStringValue("sent header Bearer abc123DEF456ghi789 ok");
    expect(result).toContain(REDACTED);
    expect(result).not.toContain("abc123DEF456ghi789");
  });

  it("masks an hextrail key", () => {
    const result = redactStringValue("key=hx_live_1234567890abcdefghijklmnop");
    expect(result).toContain(REDACTED);
    expect(result).not.toContain("hx_live_1234567890abcdefghijklmnop");
  });

  it("masks a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactStringValue(jwt)).toBe(REDACTED);
  });

  it("masks an AWS access key id", () => {
    expect(redactStringValue("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED);
  });

  it("masks a GitHub token", () => {
    expect(redactStringValue("ghp_" + "a".repeat(36))).toBe(REDACTED);
  });

  it("masks an OpenAI-style key", () => {
    expect(redactStringValue("sk-" + "a".repeat(24))).toBe(REDACTED);
  });

  it("masks a private key header", () => {
    const result = redactStringValue("-----BEGIN RSA PRIVATE KEY-----");
    expect(result).toContain(REDACTED);
  });

  it("leaves ordinary text alone", () => {
    expect(redactStringValue("summarize the document")).toBe(
      "summarize the document",
    );
  });

  it("masks every occurrence, not just the first", () => {
    const result = redactStringValue("Bearer aaaaaaaaaaaaaaaa and Bearer bbbbbbbbbbbbbbbb");
    expect(result).not.toContain("aaaaaaaaaaaaaaaa");
    expect(result).not.toContain("bbbbbbbbbbbbbbbb");
  });
});

describe("redactValue", () => {
  it("masks a sensitive key at the top level", () => {
    expect(redactValue({ password: "hunter2", name: "test" })).toEqual({
      password: REDACTED,
      name: "test",
    });
  });

  it("masks a nested sensitive key", () => {
    const result = redactValue({
      trace: { config: { apiKey: "sk-secret-value-here-1234" } },
    });
    expect(result).toEqual({
      trace: { config: { apiKey: REDACTED } },
    });
  });

  it("masks a credential-shaped value under an innocent key", () => {
    const result = redactValue({
      context: "using Bearer abc123DEF456ghi789 to call the API",
    });
    expect(JSON.stringify(result)).not.toContain("abc123DEF456ghi789");
  });

  it("walks arrays", () => {
    const result = redactValue({
      headers: [
        { authorization: "Bearer aaaaaaaaaaaaaaaa" },
        { "content-type": "application/json" },
      ],
    });
    expect(result).toEqual({
      headers: [
        { authorization: REDACTED },
        { "content-type": "application/json" },
      ],
    });
  });

  it("preserves numbers and booleans", () => {
    expect(redactValue({ latency: 42, ok: true })).toEqual({
      latency: 42,
      ok: true,
    });
  });

  it("preserves null", () => {
    expect(redactValue({ value: null })).toEqual({ value: null });
  });

  it("drops functions and symbols", () => {
    const result = redactValue({ fn: () => 1, sym: Symbol("x") });
    expect(result).toEqual({ fn: undefined, sym: undefined });
  });

  it("survives deep nesting without unbounded recursion", () => {
    let deep: Record<string, unknown> = { end: "value" };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    const result = redactValue(deep);
    expect(JSON.stringify(result)).toContain(REDACTED);
  });

  it("handles circular references without hanging", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;
    expect(() => redactValue(circular)).not.toThrow();
  });

  it("bounds array size", () => {
    const big = Array.from({ length: 2000 }, (_, i) => i);
    const result = redactValue({ items: big }) as { items: unknown[] };
    expect(result.items.length).toBe(1000);
  });
});

describe("redactRecord", () => {
  it("returns a plain object", () => {
    expect(redactRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("returns an empty object for non-objects", () => {
    expect(redactRecord("string")).toEqual({});
    expect(redactRecord(null)).toEqual({});
    expect(redactRecord([1, 2])).toEqual({});
    expect(redactRecord(42)).toEqual({});
  });

  it("redacts inside the returned object", () => {
    expect(redactRecord({ token: "abc" })).toEqual({ token: REDACTED });
  });
});

describe("limitations (documented behaviour, not PII detection)", () => {
  it("does NOT catch credentials under innocent key names", () => {
    // "notes" is not sensitive and the value has no recognised shape.
    const result = redactValue({ notes: "my password is hunter2" });
    expect(result).toEqual({ notes: "my password is hunter2" });
  });

  it("does NOT detect personal data", () => {
    const result = redactValue({ email: "someone@example.com" });
    expect(result).toEqual({ email: "someone@example.com" });
  });

  it("does NOT catch an unrecognised key format", () => {
    const result = redactValue({ myCustomSecret256: "value123" });
    expect(result).toEqual({ myCustomSecret256: "value123" });
  });
});
