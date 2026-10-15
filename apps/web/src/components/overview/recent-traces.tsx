"use client";

import Link from "next/link";
import { Waypoints } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatePanel } from "@/components/states/state-panel";
import { TraceTable } from "@/components/trace-table";
import type { TraceListItem } from "@/lib/queries/types";

/**
 * Recent traces on the overview.
 *
 * Filtering and paging live in the trace explorer, which owns the URL state
 * for them. This card shows the newest rows in the current window and links
 * across rather than duplicating the controls — one place to filter means one
 * place to get it wrong.
 */
export function RecentTraces({
  traces,
  totalCount,
  scopedToProject,
}: {
  traces: readonly TraceListItem[];
  totalCount: number;
  scopedToProject: boolean;
}) {
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Recent traces</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              The newest executions in the selected window.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/traces">Open trace explorer</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pb-4">
        <p className="mb-2 text-xs text-muted-foreground">
          Showing {traces.length} of {totalCount} in this window
        </p>
        <TraceTable
          traces={traces}
          showProject={!scopedToProject}
          emptyState={
            <StatePanel
              icon={<Waypoints className="size-5" />}
              title="No traces in this window"
              description={
                <>
                  Widen the time range above, or send a trace to{" "}
                  <code className="font-mono">POST /api/v1/traces</code>.
                </>
              }
            />
          }
        />
      </CardContent>
    </Card>
  );
}
