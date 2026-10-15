import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RATE_LIMIT,
  rateLimitOptionsFromEnv,
  type RateLimitDecision,
} from "./rate-limit";
import { InMemoryRateLimitStore } from "./rate-limit-postgres";

describe("rateLimitOptionsFromEnv", () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.HEXTRAIL_RATE_LIMIT;
    delete process.env.HEXTRAIL_RATE_WINDOW_SECONDS;
  });

  it("falls back to defaults when unset", () => {
    expect(rateLimitOptionsFromEnv()).toEqual(DEFAULT_RATE_LIMIT);
  });

  it("reads a valid limit", () => {
    process.env.HEXTRAIL_RATE_LIMIT = "10";
    expect(rateLimitOptionsFromEnv().limit).toBe(10);
  });

  it("reads a valid window", () => {
    process.env.HEXTRAIL_RATE_WINDOW_SECONDS = "30";
    expect(rateLimitOptionsFromEnv().windowSeconds).toBe(30);
  });

  it("ignores a non-numeric limit", () => {
    process.env.HEXTRAIL_RATE_LIMIT = "abc";
    expect(rateLimitOptionsFromEnv().limit).toBe(DEFAULT_RATE_LIMIT.limit);
  });

  it("ignores a zero or negative limit", () => {
    process.env.HEXTRAIL_RATE_LIMIT = "0";
    expect(rateLimitOptionsFromEnv().limit).toBe(DEFAULT_RATE_LIMIT.limit);
    process.env.HEXTRAIL_RATE_LIMIT = "-5";
    expect(rateLimitOptionsFromEnv().limit).toBe(DEFAULT_RATE_LIMIT.limit);
  });

  it("floors a fractional limit", () => {
    process.env.HEXTRAIL_RATE_LIMIT = "7.9";
    expect(rateLimitOptionsFromEnv().limit).toBe(7);
  });

  afterEach(() => {
    process.env = { ...original };
  });
});

describe("InMemoryRateLimitStore", () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  it("allows requests up to the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      const decision = await store.consume("k", 5, 60);
      expect(decision.allowed).toBe(true);
    }
  });

  it("blocks the request after the limit", async () => {
    for (let i = 0; i < 5; i += 1) await store.consume("k", 5, 60);
    const decision = await store.consume("k", 5, 60);
    expect(decision.allowed).toBe(false);
  });

  it("reports decreasing remaining counts", async () => {
    const first = await store.consume("k", 5, 60);
    const second = await store.consume("k", 5, 60);
    expect(first.remaining).toBe(4);
    expect(second.remaining).toBe(3);
  });

  it("never reports negative remaining", async () => {
    for (let i = 0; i < 10; i += 1) await store.consume("k", 3, 60);
    const decision = await store.consume("k", 3, 60);
    expect(decision.remaining).toBe(0);
  });

  it("isolates separate keys", async () => {
    for (let i = 0; i < 5; i += 1) await store.consume("a", 5, 60);
    const other = await store.consume("b", 5, 60);
    expect(other.allowed).toBe(true);
  });

  it("exposes the configured limit", async () => {
    const decision = await store.consume("k", 42, 60);
    expect(decision.limit).toBe(42);
  });

  it("returns a positive retryAfter", async () => {
    const decision = await store.consume("k", 1, 60);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window expires", async () => {
    const tiny = new InMemoryRateLimitStore();
    await tiny.consume("k", 1, 1);
    const blocked = await tiny.consume("k", 1, 1);
    expect(blocked.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const afterReset = await tiny.consume("k", 1, 1);
    expect(afterReset.allowed).toBe(true);
  });

  it("allows a burst larger than the limit only up to the limit", async () => {
    // Concurrency is not a real concern for the in-memory store, but the
    // counting behaviour must still be exact.
    const results: RateLimitDecision[] = await Promise.all(
      Array.from({ length: 10 }, () => store.consume("burst", 4, 60)),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(4);
  });
});
