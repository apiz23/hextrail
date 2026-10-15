/**
 * Payload redaction for ingestion.
 *
 * PURPOSE
 *   Ingestion accepts `metadata` (trace) and `attributes` (spans) as free-form
 *   JSON. Clients routinely put things in there they should not — API keys,
 *   bearer tokens, passwords, cookies, personal data. This module masks values
 *   whose KEY looks sensitive before anything is persisted.
 *
 * WHAT THIS IS NOT
 *   This is NOT PII detection. It does not understand content, language, or
 *   context. It matches key names against a list, and it matches a small number
 *   of high-confidence value shapes. Anything a client sends under an innocent
 *   key name ("notes", "payload", "input") passes through untouched.
 *
 *   Do not describe this as "PII-safe". It reduces accidental credential
 *   leakage. It does not make stored data safe to share.
 */

/** Replaces a redacted value. Fixed length so the original cannot be inferred. */
export const REDACTED = "[REDACTED]";

/**
 * Keys whose VALUES are masked, matched case-insensitively against the full key
 * and against underscore/dash-separated segments.
 *
 * Segment matching means `user_password`, `db-password` and `PASSWORD` all
 * match, while `passwordpolicy` does not.
 */
const SENSITIVE_KEY_SEGMENTS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "cookie",
  "session",
  "credential",
  "privatekey",
  "private_key",
  "accesskey",
  "access_key",
  "refresh_token",
  "access_token",
  "bearer",
  "passphrase",
  "signature",
  "client_secret",
];

/**
 * High-confidence value shapes. These are masked regardless of key name,
 * because a raw credential sitting under a key like "context" is still a leak.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // Bearer tokens embedded in a string.
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  // Hextrail's own API keys.
  /\bhx_(live|test)_[A-Za-z0-9]{16,}\b/,
  // Supabase-style service/anon JWT (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  // AWS access key ids.
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  // OpenAI-style keys.
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // Private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Maximum traversal breadth, to bound work on hostile payloads. */
const MAX_ARRAY_ITEMS = 1000;
const MAX_DEPTH = 12;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s.\-\]]+/g, "_").replace(/\[/g, "");
}

/**
 * True when a key name looks like it holds a credential.
 *
 * Matching is segment-based, never substring-based: `user_password` and
 * `api-key` match, while `passwordpolicy` and `myCustomSecret256` do not. A
 * substring rule would mask unrelated fields and produce false confidence.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);

  // Split camelCase runs into segments too: myCustomSecret -> my_custom_secret.
  const withCamelSplit = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const segments = new Set(
    normalizeKey(withCamelSplit).split("_").filter(Boolean),
  );
  segments.add(normalized);

  for (const sensitive of SENSITIVE_KEY_SEGMENTS) {
    // Multi-word entries ("api_key", "access_token") only match exactly.
    if (sensitive.includes("_")) {
      if (normalized === sensitive) return true;
      continue;
    }
    if (segments.has(sensitive)) return true;
  }
  return false;
}

/** Masks credential-shaped substrings inside a string value. */
export function redactStringValue(value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags + "g"), REDACTED);
  }
  return result;
}

/**
 * Recursively redacts a JSON-like value.
 *
 * - Values under a sensitive key name become REDACTED, whatever their type.
 * - Strings matching a credential pattern are masked in place.
 * - Arrays and nested objects are walked, depth- and breadth-bounded.
 * - Non-JSON values (functions, symbols) are dropped, so the result is always
 *   safe to hand to JSON.stringify.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactStringValue(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(source)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return output;
  }

  return undefined;
}

/**
 * Redacts a JSON object, guaranteeing a plain object result.
 * Returns `{}` for anything that is not an object.
 */
export function redactRecord(value: unknown): Record<string, unknown> {
  const redacted = redactValue(value);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return {};
}
