import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { getServiceClient } from "@/lib/supabase/service";

/** SHA-256 hex, matching the `key_hash` column in `hx_api_keys`. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export interface AuthenticatedProject {
  projectId: string;
  apiKeyId: string;
}

interface ApiKeyRow {
  id: string;
  project_id: string;
  key_hash: string;
}

/**
 * Resolves a bearer token to the project it is allowed to write to.
 *
 * Returns null when the key is missing, malformed, unknown, or revoked. The
 * caller must treat null as 401 and must not distinguish between those cases
 * in the response.
 */
export async function authenticateApiKey(
  rawKey: string,
): Promise<AuthenticatedProject | null> {
  // Cheap shape check before touching the database.
  if (!rawKey.startsWith("hx_live_") || rawKey.length < 32) return null;

  const providedHash = hashApiKey(rawKey);
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("hx_api_keys")
    .select("id, project_id, key_hash")
    .eq("key_hash", providedHash)
    .is("revoked_at", null)
    .maybeSingle<ApiKeyRow>();

  if (error || !data) return null;

  // Constant-time comparison. We looked the row up by hash, so this guards
  // against a hash collision being reported as a match by the database.
  const a = Buffer.from(data.key_hash, "utf8");
  const b = Buffer.from(providedHash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Best-effort telemetry; never fail authentication because this write failed.
  await supabase
    .from("hx_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return { projectId: data.project_id, apiKeyId: data.id };
}

/** Extracts the bearer token from an Authorization header. */
export function readBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
