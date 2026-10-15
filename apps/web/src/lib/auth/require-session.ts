import "server-only";

import { getSession, type Session } from "@/lib/auth/session";

/**
 * The dashboard's access gate, as a plain function.
 *
 * Lifted out of `(dashboard)/layout.tsx` so the decision — "may this request
 * see the dashboard, and as whom" — is a unit that can be tested without
 * rendering React or transforming JSX. The layout becomes a thin caller:
 * call this, redirect on `null`, render the shell otherwise.
 *
 * WHY THIS IS SERVER-ONLY
 *   It delegates to `getSession`, which reads the cookie via `next/headers`
 *   and validates the token against `hx_sessions` with the service-role
 *   client. Marking the module `server-only` makes a client import a build
 *   error rather than a silent bundling of the service client into the
 *   browser bundle.
 *
 * WHY THE FAILURE MODE IS `null`, NOT A THROW
 *   A signed-out visitor is an ordinary request, not an error. Returning null
 *   keeps the redirect decision in the caller, where the URL is known.
 */

export interface DashboardAccess {
  session: Session;
}

/**
 * Resolves the session for a dashboard request.
 *
 * Returns `null` when there is no valid session. Callers must treat that as
 * "redirect to /login" and render no dashboard markup.
 */
export async function requireSession(): Promise<DashboardAccess | null> {
  const session = await getSession();
  if (!session) return null;
  return { session };
}
