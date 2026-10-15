/**
 * Distributed rate limiting for ingestion.
 *
 * WHY NOT AN IN-MEMORY MAP
 *   On serverless, each request may land on a different instance. A per-process
 *   counter would let an attacker multiply their allowance by the number of
 *   warm instances, and would reset on every cold start. The default store is
 *   therefore Postgres, which every instance shares.
 *
 * TRADE-OFF
 *   Postgres as a rate limiter is correct and needs no new infrastructure, but
 *   it puts write load on the primary database. It is appropriate for ingestion
 *   volumes in the thousands-per-minute range. Above that, move `RateLimitStore`
 *   to a Redis/Upstash implementation — the interface exists so this is a
 *   drop-in swap, not a rewrite.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  /** Total allowance for the window. */
  limit: number;
  /** Seconds until the window resets — used for Retry-After. */
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  /**
   * Atomically records one request against `key` and returns the decision.
   * Implementations MUST be atomic under concurrency; a read-then-write
   * implementation allows a burst to exceed the limit.
   */
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision>;
}

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
}

/** Ingestion default: 600 requests per minute, per API key. */
export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  limit: 600,
  windowSeconds: 60,
};

export function rateLimitOptionsFromEnv(): RateLimitOptions {
  const limit = Number(process.env.HEXTRAIL_RATE_LIMIT ?? "");
  const windowSeconds = Number(process.env.HEXTRAIL_RATE_WINDOW_SECONDS ?? "");

  return {
    limit:
      Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : DEFAULT_RATE_LIMIT.limit,
    windowSeconds:
      Number.isFinite(windowSeconds) && windowSeconds > 0
        ? Math.floor(windowSeconds)
        : DEFAULT_RATE_LIMIT.windowSeconds,
  };
}
