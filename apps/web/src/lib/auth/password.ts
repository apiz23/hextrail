import "server-only";

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";

/**
 * Password and token cryptography.
 *
 * PASSWORDS
 *   Hashed with bcrypt (cost 12). The `hx_users.password_hash` column stores a
 *   standard 60-char bcrypt string, which is what the column's check
 *   constraint expects.
 *
 *   Note: migration 0002 also enables pgcrypto so `crypt()`/`gen_salt()` can
 *   produce hashes in SQL. We hash in Node instead, so the plaintext password
 *   never travels to the database as a query parameter. Both produce verifiable
 *   bcrypt strings, but hashing in Node keeps the plaintext inside one process.
 *
 * SESSION TOKENS
 *   A 32-byte random token, base64url. Only the SHA-256 hash is stored in
 *   `hx_sessions.token_hash`, so a database leak does not yield usable
 *   sessions. SHA-256 (not bcrypt) is correct here because the token is
 *   256 bits of entropy — there is nothing to brute-force.
 */

/** bcrypt work factor. 12 is ~250ms on commodity hardware. */
const BCRYPT_COST = 12;

/** Session lifetime. Sessions are opaque rows, so revoking is a DB update. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verifies a password against a stored bcrypt hash.
 *
 * Always runs a bcrypt comparison, even for a missing user, so response time
 * does not reveal whether an email exists.
 */
export async function verifyPassword(
  plaintext: string,
  storedHash: string | null,
): Promise<boolean> {
  const hash = storedHash ?? DUMMY_HASH;
  const ok = await bcrypt.compare(plaintext, hash);
  return storedHash !== null && ok;
}

/**
 * A fixed bcrypt hash of a random string, used to equalise timing when the
 * user does not exist. Never matches any real password.
 */
const DUMMY_HASH = "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYqJqZ8mJzS";

/** Cryptographically random session token (raw value, cookie-side only). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex of a session token, matching `hx_sessions.token_hash`. */
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Constant-time string comparison for tokens and hashes. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
