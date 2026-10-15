import { redirect } from "next/navigation";

import { StatePanel } from "@/components/states/state-panel";
import { OverviewView } from "@/components/overview/overview-view";
import {
  loadActivity,
  loadDashboardContext,
  loadTraceList,
  type DashboardSearchParams,
} from "@/lib/queries/dashboard";
import { computeOverviewStats } from "@/lib/queries/mappers";

/**
 * Agent overview.
 *
 * Aggregates the same authorized trace list the explorer shows, so the two
 * pages can never disagree about what the user is allowed to see. The metrics
 * are computed from persisted rows — no fixture numbers remain.
 */

export const dynamic = "force-dynamic";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const params = await searchParams;
  const loaded = await loadDashboardContext(params);

  if (!loaded.ok) {
    if (loaded.reason === "unauthorized") redirect("/login?next=/");
    return (
      <StatePanel
        tone="error"
        title="Could not load the dashboard"
        description={loaded.message}
      />
    );
  }

  const [list, activity] = await Promise.all([
    loadTraceList(loaded.context, params),
    loadActivity(loaded.context),
  ]);

  return (
    <OverviewView
      traces={list.traces}
      stats={computeOverviewStats(list.traces)}
      activity={activity.points}
      rangeLabel={loaded.context.range}
      scopedToProject={loaded.context.projectId !== null}
      loadError={list.error ? "The trace query failed." : null}
      noProjects={loaded.context.projects.length === 0}
    />
  );
}
