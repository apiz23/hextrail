import "server-only";

import { getServiceClient } from "@/lib/supabase/service";
import type {
  RateLimitDecision,
  RateLimitStore,
} from "@/lib/ingestion/rate-limit";

interface ConsumeRow {
  allowed: boolean;
  remaining: number;
  reset_seconds: number;
}

/**
 * Postgres-backed rate limit store.
 *
 * Uses `hx_rate_limit_consume`, a single-statement atomic upsert (see
 * migration 0004). One round trip, no read-then-write race.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const supabase = getServiceClient();

    const { data, error } = await supabase.rpc("hx_rate_limit_consume", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });

    if (error) throw new Error(`rate limit store failed: ${error.message}`);

    const row = (data as ConsumeRow[] | null)?.[0];
    if (!row) throw new Error("rate limit store returned no row");

    return {
      allowed: row.allowed,
      remaining: row.remaining,
      limit,
      retryAfterSeconds: row.reset_seconds,
    };
  }
}

/**
 * In-memory store for local development only.
 *
 * Not distributed: each serverless instance has its own map, and it resets on
 * restart. Never enable this in production — see FAIL-OPEN note in
 * `resolveRateLimitStore`.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<
    string,
    { count: number; resetAt: number }
  >();

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return {
        allowed: true,
        remaining: Math.max(limit - 1, 0),
        limit,
        retryAfterSeconds: windowSeconds,
      };
    }

    bucket.count += 1;
    const allowed = bucket.count <= limit;
    return {
      allowed,
      remaining: Math.max(limit - bucket.count, 0),
      limit,
      retryAfterSeconds: Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1),
    };
  }
}

/**
 * Selects a store.
 *
 * `HEXTRAIL_RATE_LIMIT_STORE=memory` opts into the in-memory store and is
 * intended for local development and tests only — it is not distributed.
 * Anything else uses Postgres, which requires migration 0004.
 */
export function resolveRateLimitStore(): RateLimitStore {
  if (process.env.HEXTRAIL_RATE_LIMIT_STORE === "memory") {
    return new InMemoryRateLimitStore();
  }
  return new PostgresRateLimitStore();
}
