"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search, Waypoints } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatePanel } from "@/components/states/state-panel";
import { RefreshButton } from "@/components/states/refresh-button";
import { TraceTable } from "@/components/trace-table";
import { TraceDetailView } from "@/components/traces/trace-detail-view";
import type { TraceListItem, TraceStatus } from "@/lib/queries/types";

type StatusFilter = "all" | TraceStatus;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ok", label: "Success" },
  { value: "error", label: "Error" },
  { value: "running", label: "Running" },
];

export interface TraceExplorerProps {
  traces: readonly TraceListItem[];
  /** Rows after the current filters, for the "showing N" line. */
  shown: number;
  /** Total matching rows, or null when not counted. */
  total: number | null;
  nextCursor: string | null;
  hasMore: boolean;
  /** True when a project is selected, so the Project column is redundant. */
  scopedToProject: boolean;
  /** Reason the list could not be loaded, if any. */
  loadError: string | null;
  /** True when the account owns no projects at all. */
  noProjects: boolean;
}

/**
 * Trace list with server-driven filtering and pagination.
 *
 * Filters live in the URL (`?q=`, `?status=`, `?cursor=`, `?trace=`) so the
 * server component reads the same values the user sees and runs the query.
 * That is what keeps filtering authoritative: the client never receives rows it
 * is not entitled to and then hides them.
 */
export function TraceExplorer({
  traces,
  shown,
  total,
  nextCursor,
  hasMore,
  scopedToProject,
  loadError,
  noProjects,
}: TraceExplorerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const selectedTraceId = searchParams.get("trace");
  const query = searchParams.get("q") ?? "";
  const status = (searchParams.get("status") as StatusFilter | null) ?? "all";

  // Local state mirrors the URL so typing does not fire a request per keystroke.
  const [queryDraft, setQueryDraft] = useState(query);

  function pushParams(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    // Any filter change invalidates the current page position.
    params.delete("cursor");
    const queryString = params.toString();
    startTransition(() => {
      router.push(queryString ? `${pathname}?${queryString}` : pathname);
    });
  }

  function openTrace(trace: TraceListItem) {
    pushParams((params) => params.set("trace", trace.id));
  }

  function closeTrace() {
    pushParams((params) => params.delete("trace"));
  }

  function applyQuery() {
    const trimmed = queryDraft.trim();
    pushParams((params) => {
      if (trimmed) params.set("q", trimmed);
      else params.delete("q");
    });
  }

  const clearFilters = () => {
    setQueryDraft("");
    pushParams((params) => {
      params.delete("q");
      params.delete("status");
      params.delete("trace");
    });
  };

  const emptyState = noProjects ? (
    <StatePanel
      icon={<Waypoints className="size-5" />}
      title="No projects yet"
      description={
        <>
          Create a project and issue an API key, then send a trace to{" "}
          <code className="font-mono">POST /api/v1/traces</code>. It will appear
          here.
        </>
      }
    />
  ) : query || status !== "all" ? (
    <StatePanel
      icon={<Search className="size-5" />}
      title="No traces match your filters"
      description="Widen the time range, clear the search box, or pick another status."
      action={
        <Button variant="outline" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <StatePanel
      icon={<Waypoints className="size-5" />}
      title="No traces yet"
      description={
        <>
          Send one to <code className="font-mono">POST /api/v1/traces</code> with
          a project API key and it will show up here.
        </>
      }
    />
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Exploration
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Trace explorer</h1>
          <p className="text-sm text-muted-foreground">
            Search persisted executions, then open a trace to inspect its spans.
          </p>
        </div>
        <RefreshButton />
      </div>

      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Traces</CardTitle>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <form
                className="relative w-full sm:w-64"
                onSubmit={(event) => {
                  event.preventDefault();
                  applyQuery();
                }}
              >
                <Search
                  aria-hidden="true"
                  className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={queryDraft}
                  onChange={(event) => setQueryDraft(event.target.value)}
                  placeholder="Search, then press Enter"
                  aria-label="Search traces"
                  className="h-9 pl-8"
                />
              </form>
              <Select
                value={status}
                onValueChange={(value) =>
                  pushParams((params) => {
                    if (value === "all") params.delete("status");
                    else params.set("status", value);
                  })
                }
              >
                <SelectTrigger
                  className="h-9 w-full sm:w-40"
                  aria-label="Filter by status"
                >
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pb-4">
          {loadError ? (
            <StatePanel
              tone="error"
              title="Could not load traces"
              description={loadError}
              action={<RefreshButton label="Try again" />}
            />
          ) : (
            <>
              <p className="mb-2 text-xs text-muted-foreground" aria-live="polite">
                {total === null
                  ? `Showing ${shown} trace${shown === 1 ? "" : "s"}`
                  : `Showing ${shown} of ${total} trace${total === 1 ? "" : "s"}`}
                {pending ? " · updating…" : ""}
              </p>

              <TraceTable
                traces={traces}
                onSelect={openTrace}
                emptyState={emptyState}
                showProject={!scopedToProject}
              />

              {hasMore && nextCursor ? (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      pushParams((params) => params.set("cursor", nextCursor))
                    }
                  >
                    {pending ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Sheet
        open={selectedTraceId !== null}
        onOpenChange={(open) => {
          if (!open) closeTrace();
        }}
      >
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl"
        >
          {selectedTraceId ? (
            <>
              <SheetHeader className="border-b">
                <SheetTitle className="text-sm">Trace detail</SheetTitle>
                <SheetDescription className="font-mono text-xs">
                  {selectedTraceId}
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 p-5">
                <TraceDetailView
                  traceId={selectedTraceId}
                  onClose={closeTrace}
                />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
