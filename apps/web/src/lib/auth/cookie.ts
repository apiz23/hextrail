/**
 * Session cookie name.
 *
 * Deliberately its own module with zero imports. The middleware runs on the
 * edge runtime, which has no Node built-ins — importing this from `session.ts`
 * would drag `node:crypto` and the Supabase client into the edge bundle and
 * fail the build. This constant is the only thing middleware needs.
 */
export const SESSION_COOKIE = "hx_session";
