import { redirect } from "next/navigation";

import { StatePanel } from "@/components/states/state-panel";
import { TraceExplorer } from "@/components/traces/trace-explorer";
import {
  loadDashboardContext,
  loadTraceList,
  type DashboardSearchParams,
} from "@/lib/queries/dashboard";

/**
 * Trace explorer.
 *
 * Reads its filters from the URL, resolves the session, authorizes the project
 * scope, and runs the query server-side. Nothing is fetched in the browser
 * except the individual trace body, which is authorized again on its own.
 */

// Traces change as agents run, so this route must not be cached.
export const dynamic = "force-dynamic";

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const params = await searchParams;
  const loaded = await loadDashboardContext(params);

  if (!loaded.ok) {
    // Middleware normally redirects first; this is the authoritative check.
    if (loaded.reason === "unauthorized") redirect("/login?next=/traces");
    return (
      <StatePanel
        tone="error"
        title="Could not load the dashboard"
        description={loaded.message}
      />
    );
  }

  const list = await loadTraceList(loaded.context, params);

  return (
    <TraceExplorer
      traces={list.traces}
      shown={list.shown}
      total={list.total}
      nextCursor={list.nextCursor}
      hasMore={list.hasMore}
      scopedToProject={loaded.context.projectId !== null}
      loadError={list.error ? "The trace query failed." : null}
      noProjects={loaded.context.projects.length === 0}
    />
  );
}
