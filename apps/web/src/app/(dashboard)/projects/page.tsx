import Link from "next/link";
import { redirect } from "next/navigation";
import { FolderKanban } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatePanel } from "@/components/states/state-panel";
import { formatRelativeTime } from "@/lib/format";
import { loadDashboardContext } from "@/lib/queries/dashboard";
import type { DashboardSearchParams } from "@/lib/queries/dashboard";

/**
 * Projects owned by the signed-in user, with real trace counts.
 *
 * `loadDashboardContext` already scoped the list to `owner_id = session.user`,
 * so a project belonging to anyone else is not in this array and cannot be
 * rendered.
 */

export const dynamic = "force-dynamic";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const loaded = await loadDashboardContext(await searchParams);

  if (!loaded.ok) {
    if (loaded.reason === "unauthorized") redirect("/login?next=/projects");
    return (
      <StatePanel
        tone="error"
        title="Could not load projects"
        description={loaded.message}
      />
    );
  }

  const { projects } = loaded.context;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Projects you own and the traces recorded against them.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            disabled
            aria-disabled="true"
            title="Requires a project-creation endpoint"
          >
            Create project — coming soon
          </Button>
          <p className="text-right text-xs text-muted-foreground">
            Project creation needs a write endpoint, which is not built yet.
          </p>
        </div>
      </div>

      {projects.length === 0 ? (
        <StatePanel
          icon={<FolderKanban className="size-5" />}
          title="No projects yet"
          description={
            <>
              Projects are created with SQL today. See the README for the insert
              statement, then issue an API key for it.
            </>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Card key={project.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="grid size-8 place-items-center rounded-md bg-muted"
                    >
                      <FolderKanban className="size-4 text-muted-foreground" />
                    </span>
                    <CardTitle className="text-base">{project.name}</CardTitle>
                  </div>
                  <Badge variant="secondary" className="tabular-nums">
                    {project.traceCount} trace
                    {project.traceCount === 1 ? "" : "s"}
                  </Badge>
                </div>
                <CardDescription className="text-xs leading-relaxed">
                  {project.description ?? "No description."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {project.lastTraceAt
                    ? `Last trace ${formatRelativeTime(project.lastTraceAt)}`
                    : "No traces recorded yet"}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  id <span className="font-mono">{project.id}</span>
                </p>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/traces?project=${project.id}`}>
                    View traces
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
