import "server-only";

import { randomBytes } from "node:crypto";

import { hashApiKey } from "@/lib/ingestion/auth";
import { getServiceClient } from "@/lib/supabase/service";
import { ownedProjectIds } from "@/lib/queries/traces";
import type { QueryResult } from "@/lib/queries/types";
import type { SessionUser } from "@/lib/auth/session";

/**
 * API key management.
 *
 * KEY FORMAT (reused from ingestion — do not change independently)
 *   `hx_live_` + 32 random bytes as base64url. 256 bits of entropy.
 *
 *   base64url is chosen because the value travels in an `Authorization`
 *   header, where `+`, `/` and `=` are awkward. 32 bytes encodes to 43
 *   characters, so a full key is 8 + 43 = 51 characters — comfortably above
 *   the 32-character minimum `authenticateApiKey` enforces.
 *
 * HASHING (reused)
 *   `hashApiKey` from the ingestion module is the single source of truth.
 *   Importing it rather than re-implementing it is deliberate: if the two
 *   ever diverged, every key created here would fail to authenticate.
 *   SHA-256 without a salt is correct for this input because the key is 256
 *   bits of uniform randomness — there is no dictionary to attack, unlike a
 *   password. That is exactly why passwords use bcrypt and keys do not.
 *
 * STORAGE
 *   Only the hash and the display prefix are persisted. The raw key exists in
 *   memory for the duration of one request and is returned exactly once.
 *
 * AUTHORIZATION
 *   Every function takes the authenticated session user and derives the
 *   allowed project ids from `hx_projects.owner_id`. An id supplied by the
 *   client is never trusted on its own.
 */

/** Prefix on every live key. */
export const KEY_PREFIX = "hx_live_";

/** Characters kept for display. Matches the 8..16 check on `key_prefix`. */
export const DISPLAY_PREFIX_LENGTH = 12;

/** Bytes of entropy in a key. 32 bytes = 256 bits. */
const KEY_BYTES = 32;

/**
 * Generates a new raw API key.
 *
 * Uses `randomBytes` (a CSPRNG), never `Math.random`, which is predictable and
 * would make every issued key guessable from a prior one.
 */
export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
}

/**
 * The display prefix for a raw key.
 *
 * `hx_live_` (8) + 4 entropy characters = 12, which sits inside the column's
 * 8..16 constraint. Four characters is enough to tell two keys apart in a
 * list without revealing enough to be useful — it leaves 236 bits unknown.
 */
export function displayPrefix(rawKey: string): string {
  return rawKey.slice(0, DISPLAY_PREFIX_LENGTH);
}

/**
 * A single key as the UI may see it.
 *
 * Deliberately excludes `key_hash` and `project_id`. The hash is a credential
 * equivalent (it is what authenticates a request) and has no business leaving
 * the server; the project is resolved to a name by the caller.
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  projectId: string;
  projectName: string;
}

/** The one-time result of creating a key. */
export interface CreatedApiKey {
  key: ApiKeySummary;
  /**
   * The raw key. Returned exactly once, at creation. Never persisted, never
   * logged, and never included in any other response.
   */
  rawKey: string;
}

interface ApiKeyRow {
  id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const KEY_COLUMNS =
  "id, project_id, name, key_prefix, created_at, last_used_at, revoked_at";

function unauthorized(): QueryResult<never> {
  return {
    ok: false,
    error: { kind: "unauthorized", message: "Not signed in." },
  };
}

function notFound(message: string): QueryResult<never> {
  return { ok: false, error: { kind: "not_found", message } };
}

function databaseError(message: string): QueryResult<never> {
  return { ok: false, error: { kind: "database", message } };
}

/**
 * Maps a row to the UI shape, resolving the project name from a lookup map.
 * The map is built once per request from the user's own projects, so a row
 * can never resolve a name it is not entitled to.
 */
function toSummary(
  row: ApiKeyRow,
  projectNames: Map<string, string>,
): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    projectId: row.project_id,
    projectName: projectNames.get(row.project_id) ?? "Unknown project",
  };
}

/** Project names for the user's owned projects, as a lookup map. */
async function ownedProjectNames(
  supabase: ReturnType<typeof getServiceClient>,
  user: SessionUser,
): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("hx_projects")
    .select("id, name")
    .eq("owner_id", user.id);

  const rows = (data ?? []) as { id: string; name: string }[];
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Lists every key belonging to the user's projects, newest first.
 *
 * Revoked keys are included so the UI can show history — but the status is
 * explicit, so a revoked key is never mistaken for a live one.
 */
export async function listApiKeys(
  user: SessionUser,
): Promise<QueryResult<ApiKeySummary[]>> {
  if (!user?.id) return unauthorized();

  const owned = await ownedProjectIds(user);
  if (!owned.ok) return owned;

  // No projects means no keys. Returning early avoids a query with an empty
  // `in` list, which PostgREST renders as `in.()` — a syntax error.
  if (owned.data.length === 0) return { ok: true, data: [] };

  const supabase = getServiceClient();
  const [{ data, error }, projectNames] = await Promise.all([
    supabase
      .from("hx_api_keys")
      .select(KEY_COLUMNS)
      .in("project_id", owned.data)
      .order("created_at", { ascending: false }),
    ownedProjectNames(supabase, user),
  ]);

  if (error) return databaseError("Could not load API keys.");

  const rows = (data ?? []) as ApiKeyRow[];
  return { ok: true, data: rows.map((row) => toSummary(row, projectNames)) };
}

export interface CreateApiKeyInput {
  /** The project to issue the key for. Must be owned by the session user. */
  projectId: string;
  name: string;
}

/**
 * Creates a key for one of the user's projects.
 *
 * The raw key is generated here, hashed here, and returned once. The caller is
 * responsible for showing it and then dropping it — nothing in this module
 * persists or logs it.
 *
 * Ownership is verified against `hx_projects.owner_id` before the insert, so a
 * project id belonging to another user cannot be used to mint a credential
 * against their data.
 */
export async function createApiKey(
  user: SessionUser,
  input: CreateApiKeyInput,
): Promise<QueryResult<CreatedApiKey>> {
  if (!user?.id) return unauthorized();

  const name = input.name.trim();
  if (name.length === 0) {
    return {
      ok: false,
      error: { kind: "not_found", message: "A key name is required." },
    };
  }
  if (name.length > 100) {
    return {
      ok: false,
      error: { kind: "not_found", message: "Key name is too long (max 100)." },
    };
  }

  const supabase = getServiceClient();

  // AUTHORIZATION: the project must be owned by this user. Checking here, in
  // the same predicate as the lookup, means an unowned id cannot proceed.
  const { data: project, error: projectError } = await supabase
    .from("hx_projects")
    .select("id, name")
    .eq("id", input.projectId)
    .eq("owner_id", user.id)
    .maybeSingle<{ id: string; name: string }>();

  if (projectError) return databaseError("Could not verify the project.");
  if (!project) return notFound("Project not found.");

  const rawKey = generateApiKey();

  const { data, error } = await supabase
    .from("hx_api_keys")
    .insert({
      project_id: project.id,
      name,
      key_hash: hashApiKey(rawKey),
      key_prefix: displayPrefix(rawKey),
    })
    .select(KEY_COLUMNS)
    .single<ApiKeyRow>();

  if (error || !data) return databaseError("Could not create the API key.");

  return {
    ok: true,
    data: {
      key: toSummary(data, new Map([[project.id, project.name]])),
      rawKey,
    },
  };
}

/**
 * Revokes a key, taking effect immediately for ingestion.
 *
 * Effective immediately because `authenticateApiKey` filters on
 * `revoked_at is null`. There is no cached key or token to expire, so the next
 * request with the revoked key fails. That is worth stating plainly: no
 * propagation delay exists here because none was designed in.
 *
 * IDEMPOTENT: revoking an already-revoked key succeeds without changing the
 * original timestamp, so a repeated click (or a retried request) cannot
 * rewrite history and is not an error.
 *
 * Scoped by ownership: the project predicate is applied in the update itself,
 * so a key id from another user's project matches zero rows and returns
 * `not_found` rather than revoking anything.
 */
export async function revokeApiKey(
  user: SessionUser,
  keyId: string,
): Promise<QueryResult<{ id: string; revokedAt: string }>> {
  if (!user?.id) return unauthorized();

  const owned = await ownedProjectIds(user);
  if (!owned.ok) return owned;
  if (owned.data.length === 0) return notFound("API key not found.");

  const supabase = getServiceClient();

  // Read first so an already-revoked key keeps its original timestamp and the
  // caller can tell the difference between "revoked now" and "was already".
  const { data: existing, error: readError } = await supabase
    .from("hx_api_keys")
    .select("id, revoked_at")
    .eq("id", keyId)
    // The isolation predicate: without it any key id would be revocable.
    .in("project_id", owned.data)
    .maybeSingle<{ id: string; revoked_at: string | null }>();

  if (readError) return databaseError("Could not load the API key.");
  if (!existing) return notFound("API key not found.");

  // Already revoked: report success, change nothing. Idempotent.
  if (existing.revoked_at) {
    return { ok: true, data: { id: existing.id, revokedAt: existing.revoked_at } };
  }

  const revokedAt = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("hx_api_keys")
    .update({ revoked_at: revokedAt })
    .eq("id", keyId)
    .in("project_id", owned.data)
    // Belt and braces: if a concurrent request revoked it between the read and
    // this update, this predicate makes our write a no-op instead of
    // overwriting the earlier timestamp.
    .is("revoked_at", null);

  if (updateError) return databaseError("Could not revoke the API key.");

  return { ok: true, data: { id: keyId, revokedAt } };
}
