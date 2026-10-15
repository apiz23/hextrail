"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Waypoints } from "lucide-react";

import { ActivityChart } from "@/components/overview/activity-chart";
import { MetricCards } from "@/components/overview/metric-cards";
import { RecentTraces } from "@/components/overview/recent-traces";
import { RefreshButton } from "@/components/states/refresh-button";
import { StatePanel } from "@/components/states/state-panel";
import { useProject } from "@/components/project-context";
import type { TimeRangeKey } from "@/lib/data/time-ranges";
import type {
  ActivityPoint,
  OverviewStats,
  TraceListItem,
} from "@/lib/queries/types";

export interface OverviewViewProps {
  traces: readonly TraceListItem[];
  stats: OverviewStats;
  activity: readonly ActivityPoint[];
  rangeLabel: TimeRangeKey;
  scopedToProject: boolean;
  loadError: string | null;
  noProjects: boolean;
}

/**
 * Overview built entirely from persisted rows.
 *
 * The metric cards describe the whole range, while the table's search and
 * status filters narrow only the table — the same separation the previous
 * fixture version had, minus the fixtures.
 */
export function OverviewView({
  traces,
  stats,
  activity,
  rangeLabel,
  scopedToProject,
  loadError,
  noProjects,
}: OverviewViewProps) {
  const { projectId } = useProject();

  if (loadError) {
    return (
      <div className="space-y-6">
        <Header scopedToProject={scopedToProject} projectId={projectId} />
        <StatePanel
          tone="error"
          title="Could not load the overview"
          description={loadError}
          action={<RefreshButton label="Try again" />}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Header scopedToProject={scopedToProject} projectId={projectId} />
        <RefreshButton />
      </div>

      {noProjects ? (
        <StatePanel
          icon={<Waypoints className="size-5" />}
          title="No projects yet"
          description={
            <>
              Create a project and issue an API key, then send a trace to{" "}
              <code className="font-mono">POST /api/v1/traces</code>. Metrics
              will appear here.
            </>
          }
        />
      ) : (
        <>
          <MetricCards stats={stats} />
          {activity.length > 0 ? (
            <ActivityChart points={activity} range={rangeLabel} />
          ) : null}
          <RecentTraces
            traces={traces}
            totalCount={traces.length}
            scopedToProject={scopedToProject}
          />
        </>
      )}
    </div>
  );
}

function Header({
  scopedToProject,
  projectId,
}: {
  scopedToProject: boolean;
  projectId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Monitoring
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Agent overview</h1>
      <p className="text-sm text-muted-foreground">
        {scopedToProject ? (
          <>
            Persisted traces for the selected project.{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString());
                params.delete("project");
                const q = params.toString();
                router.push(q ? `${pathname}?${q}` : pathname);
              }}
            >
              Show all projects
            </button>
          </>
        ) : (
          "Persisted traces across every project you own."
        )}
      </p>
      {projectId ? <span className="sr-only">{projectId}</span> : null}
    </div>
  );
}
