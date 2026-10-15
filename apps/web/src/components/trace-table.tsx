import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { formatDuration, formatRelativeTime } from "@/lib/format";
import type { TraceListItem } from "@/lib/queries/types";

interface TraceTableProps {
  traces: readonly TraceListItem[];
  /** When provided, rows become selectable (keyboard + click). */
  onSelect?: (trace: TraceListItem) => void;
  /** Rendered instead of the table when there are no rows. */
  emptyState?: ReactNode;
  /** Adds a Project column; used when the list spans multiple projects. */
  showProject?: boolean;
}

export function TraceTable({
  traces,
  onSelect,
  emptyState,
  showProject = false,
}: TraceTableProps) {
  if (traces.length === 0) {
    return <>{emptyState ?? null}</>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Trace</TableHead>
          <TableHead>Agent / workflow</TableHead>
          {showProject ? <TableHead>Project</TableHead> : null}
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            Spans
          </TableHead>
          <TableHead className="hidden text-right md:table-cell">
            Started
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {traces.map((trace) => (
          <TableRow
            key={trace.id}
            className={onSelect ? "cursor-pointer" : undefined}
            onClick={onSelect ? () => onSelect(trace) : undefined}
          >
            <TableCell>
              {onSelect ? (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 font-mono text-xs"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(trace);
                  }}
                  aria-label={`Open trace ${trace.externalId}`}
                >
                  {trace.externalId}
                </Button>
              ) : (
                <span className="font-mono text-xs">{trace.externalId}</span>
              )}
            </TableCell>
            <TableCell className="text-sm">{trace.name}</TableCell>
            {showProject ? (
              <TableCell className="text-xs text-muted-foreground">
                {trace.projectName}
              </TableCell>
            ) : null}
            <TableCell>
              <StatusBadge status={trace.status} />
            </TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">
              {/* A running trace has no end time, so no duration to show. */}
              {trace.endedAt ? formatDuration(trace.durationMs) : "—"}
            </TableCell>
            <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">
              {trace.spanCount}
            </TableCell>
            <TableCell className="hidden text-right text-xs text-muted-foreground md:table-cell">
              {formatRelativeTime(trace.startedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
