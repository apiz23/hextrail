import "server-only";

import { cookies } from "next/headers";

import { getServiceClient } from "@/lib/supabase/service";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import {
  SESSION_TTL_MS,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  safeEqual,
  verifyPassword,
} from "@/lib/auth/password";

/**
 * Session authentication, backed by `hx_sessions`.
 *
 * SECURITY MODEL
 *   Custom auth — there is no Supabase Auth and `auth.uid()` is always NULL, so
 *   RLS on the hx_ tables is default-deny with zero policies. This module is
 *   the only thing that turns a cookie into an identity, and it runs
 *   server-side with the service-role client.
 *
 *   Consequences that the callers must honour:
 *     - `getSession()` returning null means "unauthenticated", full stop. There
 *       is no fallback identity and no anonymous access to any table.
 *     - Every query MUST be scoped by the session's user id. The database will
 *       not do it for us.
 */

export { SESSION_COOKIE };

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Session {
  user: SessionUser;
  sessionId: string;
}

interface SessionRow {
  id: string;
  expires_at: string;
  revoked_at: string | null;
  hx_users: {
    id: string;
    email: string;
    display_name: string | null;
  } | null;
}

/**
 * Resolves the current session from the request cookie.
 *
 * Returns null for: no cookie, malformed token, unknown token, revoked
 * session, expired session, or a session whose user row has gone. The caller
 * must treat every one of those identically.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const rawToken = store.get(SESSION_COOKIE)?.value;
  if (!rawToken) return null;

  return validateSessionToken(rawToken);
}

/**
 * Validates a raw session token against the database.
 *
 * Separated from `getSession` so tests can exercise it without a cookie jar.
 */
export async function validateSessionToken(
  rawToken: string,
): Promise<Session | null> {
  if (!rawToken || rawToken.length < 20) return null;

  const tokenHash = hashSessionToken(rawToken);
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("hx_sessions")
    .select("id, expires_at, revoked_at, hx_users(id, email, display_name)")
    .eq("token_hash", tokenHash)
    .maybeSingle<SessionRow>();

  if (error || !data) return null;
  if (data.revoked_at !== null) return null;
  if (Date.parse(data.expires_at) <= Date.now()) return null;
  if (!data.hx_users) return null;

  return {
    sessionId: data.id,
    user: {
      id: data.hx_users.id,
      email: data.hx_users.email,
      displayName: data.hx_users.display_name,
    },
  };
}

export interface SignInResult {
  ok: boolean;
  /** Raw token — set as a cookie by the caller. Never persisted in this form. */
  token?: string;
  expiresAt?: Date;
  user?: SessionUser;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
}

/**
 * Verifies credentials and creates a session.
 *
 * Returns `{ ok: false }` for both "no such user" and "wrong password", and
 * runs a bcrypt comparison in the first case too, so neither the response body
 * nor the response time reveals whether an email is registered.
 */
export async function signIn(
  email: string,
  password: string,
): Promise<SignInResult> {
  const supabase = getServiceClient();
  const normalizedEmail = email.trim().toLowerCase();

  const { data: user, error } = await supabase
    .from("hx_users")
    .select("id, email, password_hash, display_name")
    .eq("email", normalizedEmail)
    .maybeSingle<UserRow>();

  if (error) throw new Error(`session lookup failed: ${error.message}`);

  const valid = await verifyPassword(password, user?.password_hash ?? null);
  if (!valid || !user) return { ok: false };

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const { error: insertError } = await supabase.from("hx_sessions").insert({
    user_id: user.id,
    token_hash: hashSessionToken(token),
    expires_at: expiresAt.toISOString(),
  });

  if (insertError) {
    throw new Error(`session creation failed: ${insertError.message}`);
  }

  return {
    ok: true,
    token,
    expiresAt,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    },
  };
}

/** Revokes a session by its raw token. Idempotent. */
export async function signOut(rawToken: string): Promise<void> {
  if (!rawToken) return;
  const supabase = getServiceClient();
  await supabase
    .from("hx_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", hashSessionToken(rawToken))
    .is("revoked_at", null);
}

/**
 * Creates a user with a hashed password. Used by the seed script and tests —
 * there is no public sign-up route.
 */
export async function createUser(
  email: string,
  password: string,
  displayName?: string,
): Promise<SessionUser> {
  const supabase = getServiceClient();
  const passwordHash = await hashPassword(password);

  const { data, error } = await supabase
    .from("hx_users")
    .insert({
      email: email.trim().toLowerCase(),
      password_hash: passwordHash,
      display_name: displayName ?? null,
    })
    .select("id, email, display_name")
    .single<{ id: string; email: string; display_name: string | null }>();

  if (error) throw new Error(`user creation failed: ${error.message}`);

  return {
    id: data.id,
    email: data.email,
    displayName: data.display_name,
  };
}

/**
 * Timing-safe check that a session token matches an expected hash.
 * Exported for tests; `validateSessionToken` does not need it because it looks
 * the row up by hash rather than comparing client-supplied values.
 */
export function tokenMatchesHash(rawToken: string, hash: string): boolean {
  return safeEqual(hashSessionToken(rawToken), hash);
}
