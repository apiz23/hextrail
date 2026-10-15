#!/usr/bin/env node
/**
 * Creates a demo user + session for local dashboard work.
 *
 * WHY THIS EXISTS
 *   There is no public sign-up route — users are inserted with SQL or this
 *   script. Signing in through the UI requires a password hash, and the hash
 *   must be produced by bcrypt (which is what `password.ts` verifies), so this
 *   script does that rather than a raw SQL insert with a placeholder hash.
 *
 * WHAT IT WRITES
 *   One row in `hx_users`, and optionally one row in `hx_sessions`.
 *   It never deletes anything and never touches `hx_traces`/`hx_spans`.
 *
 * USAGE
 *   node scripts/seed-demo-user.mjs --email you@example.com --password 'secret'
 *
 *   It lives in `apps/web/scripts/` so that `@supabase/supabase-js` and
 *   `bcryptjs` resolve from that package's node_modules, and is run via:
 *
 *   pnpm --filter @hextrail/web seed:user -- --email you@example.com --password 'secret'
 *
 * Re-running with the same email updates the password instead of duplicating
 * the user.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
}

// Walk up from this file to the directory that actually contains
// `apps/web/.env.local`, so the script works from any working directory and
// whether it is run from `scripts/` or copied into `apps/web/` for module
// resolution.
function findEnvFile(start) {
  let current = start;
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = resolve(current, "apps/web/.env.local");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      current = resolve(current, "..");
    }
  }
  throw new Error("Could not locate apps/web/.env.local");
}

const env = loadEnv(findEnvFile(dirname(fileURLToPath(import.meta.url))));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const email = arg("email");
const password = arg("password");

if (!email || !password) {
  console.error(
    "Usage: node scripts/seed-demo-user.mjs --email you@example.com --password 'secret'",
  );
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const passwordHash = await bcrypt.hash(password, 12);
const normalized = email.trim().toLowerCase();

const { data: existing } = await supabase
  .from("hx_users")
  .select("id")
  .eq("email", normalized)
  .maybeSingle();

let userId = existing?.id;

if (userId) {
  const { error } = await supabase
    .from("hx_users")
    .update({ password_hash: passwordHash })
    .eq("id", userId);
  if (error) {
    console.error("Failed to update password:", error.message);
    process.exit(1);
  }
  console.log(`Updated password for existing user ${userId}`);
} else {
  const { data, error } = await supabase
    .from("hx_users")
    .insert({
      email: normalized,
      password_hash: passwordHash,
      display_name: arg("name", "Demo user"),
    })
    .select("id")
    .single();
  if (error) {
    console.error("Failed to create user:", error.message);
    process.exit(1);
  }
  userId = data.id;
  console.log(`Created user ${userId} (${normalized})`);
}

// A directly-inserted session, for scripted verification without the UI.
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const { error: sessionError } = await supabase.from("hx_sessions").insert({
  user_id: userId,
  token_hash: tokenHash,
  expires_at: expiresAt,
});

if (sessionError) {
  console.error("Failed to create session:", sessionError.message);
  process.exit(1);
}

console.log(`\nSession token (also a valid ${"hx_session"} cookie value):`);
console.log(token);
console.log(`\nExpires: ${expiresAt}`);
console.log(`User id: ${userId}`);
