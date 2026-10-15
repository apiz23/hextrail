/**
 * Shared Vitest setup.
 *
 * Integration tests are skipped unless an isolated test database is
 * configured. They never run against the development project.
 */

export const INTEGRATION_ENABLED =
  Boolean(process.env.TEST_SUPABASE_URL) &&
  Boolean(process.env.TEST_SUPABASE_SERVICE_ROLE_KEY);

// Make the default unit run quiet about the disabled suite.
if (!INTEGRATION_ENABLED) {
  process.env.HEXTRAIL_RATE_LIMIT_STORE ??= "memory";
}
