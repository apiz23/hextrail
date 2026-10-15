import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/lib/auth/require-session";
import { listProjects } from "@/lib/queries/traces";

/**
 * Authenticated dashboard layout.
 *
 * A route group, so `(dashboard)` contributes no URL segment: `/`,
 * `/traces`, `/projects` and `/settings` keep exactly the paths they had.
 * It exists so the dashboard shell — sidebar, top bar, account menu — is
 * rendered by the layout that owns authentication, and never by the root
 * layout, which every route including `/login` inherits.
 *
 * AUTHORIZATION
 *   `requireSession()` performs the real server-side check against
 *   `hx_sessions` — not a cookie-presence test. A null result redirects before
 *   any dashboard markup is produced, so a signed-out visitor receives a 307 to
 *   `/login` and no sidebar. This is the authoritative gate; `middleware.ts`
 *   only short-circuits the common case earlier using cookie presence, because
 *   the edge runtime cannot reach the database.
 *
 *   The `?next=` destination is set by `middleware.ts`, which sees the full
 *   pathname and query string and runs before this layout renders. A layout
 *   cannot read `searchParams`, so it does not try to reconstruct the target
 *   here: it redirects to a bare `/login`, and middleware supplies the accurate
 *   destination in the cases it handles. Reaching this branch with a cookie
 *   present means the session was revoked or expired between the edge check and
 *   the database lookup — a legitimate arrival at `/login`, just without a
 *   return path.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const access = await requireSession();
  if (!access) redirect("/login");

  const { session } = access;

  // One query, and a failure yields an empty list rather than crashing the
  // shell — the pages themselves surface the error state.
  const projectResult = await listProjects(session.user);
  const projects = projectResult.ok ? projectResult.data : [];

  return (
    <AppShell
      user={{
        email: session.user.email,
        displayName: session.user.displayName,
      }}
      projects={projects.map((project) => ({
        id: project.id,
        name: project.name,
      }))}
    >
      {children}
    </AppShell>
  );
}
