import { StatusBadge } from "@/components/status-badge";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TraceDetail, TraceSpan, TraceStatus } from "@/lib/queries/types";

interface SpanRow {
  span: TraceSpan;
  depth: number;
}

/**
 * Flattens the span tree into depth-annotated rows.
 *
 * Parentage is expressed as `parent_external_span_id`, a client-supplied id
 * that is not guaranteed to reference a span in this trace. A missing parent
 * simply leaves the span at depth 0, and the `visited` set makes a cycle
 * terminate instead of looping forever.
 */
function flattenSpans(spans: readonly TraceSpan[]): SpanRow[] {
  const byExternalId = new Map(spans.map((span) => [span.externalId, span]));

  return spans.map((span) => {
    let depth = 0;
    let parentId = span.parentExternalId;
    const visited = new Set<string>([span.externalId]);

    while (parentId !== null && byExternalId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = byExternalId.get(parentId)?.parentExternalId ?? null;
    }
    return { span, depth };
  });
}

/** Bar color carries meaning: neutral = ok, red = error, amber = running. */
const BAR_COLORS: Record<TraceStatus, string> = {
  ok: "bg-muted-foreground/50",
  error: "bg-destructive",
  running: "bg-warning animate-pulse",
};

function SpanTimelineRow({ span, depth, totalMs }: SpanRow & { totalMs: number }) {
  // Guard against a zero-length trace so the bar width cannot divide by zero.
  const safeTotal = totalMs > 0 ? totalMs : 1;
  const startPct = Math.min((span.startOffsetMs / safeTotal) * 100, 100);
  const widthPct = Math.min(
    Math.max((span.durationMs / safeTotal) * 100, 1.5),
    100 - startPct,
  );

  return (
    <li className="rounded-sm px-1 py-1.5 hover:bg-accent/40">
      <div className="flex items-center gap-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-2"
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              span.status === "ok" && "bg-muted-foreground/60",
              span.status === "error" && "bg-destructive",
              span.status === "running" && "bg-warning",
            )}
          />
          <span className="truncate font-mono text-xs">{span.name}</span>
          <span className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            {span.kind}
          </span>
          <span className="sr-only">status: {span.status}</span>
        </div>

        <div
          aria-hidden="true"
          className="relative hidden h-3 w-28 shrink-0 rounded-sm bg-muted sm:block lg:w-44"
        >
          <div
            className={cn(
              "absolute top-0 h-full rounded-sm",
              BAR_COLORS[span.status],
            )}
            style={{ left: `${startPct}%`, width: `${widthPct}%` }}
          />
        </div>

        <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {span.endedAt ? formatDuration(span.durationMs) : "running"}
        </span>
      </div>

      {span.error ? (
        <div className="ml-6 mt-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 sm:ml-10">
          <p className="flex items-center gap-2 text-xs font-semibold text-destructive">
            {span.error.name}
          </p>
          <p className="mt-1 break-words font-mono text-xs text-destructive/90">
            {span.error.message}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function EmptySpans() {
  return (
    <p className="rounded-md border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
      This trace recorded no spans. It was submitted without a span list, or the
      spans failed to persist.
    </p>
  );
}

export function SpanTimeline({ trace }: { trace: TraceDetail }) {
  const rows = flattenSpans(trace.spans);
  const totalMs = trace.durationMs;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Span timeline</h3>
        {rows.length > 0 ? (
          <ul className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2 rounded-full bg-muted-foreground/60" />
              Success
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
              Error
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
              Running
            </li>
          </ul>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptySpans />
      ) : (
        <ol className="space-y-0.5 border-l pl-2">
          {rows.map((row) => (
            <SpanTimelineRow key={row.span.id} {...row} totalMs={totalMs} />
          ))}
        </ol>
      )}

      <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <span>
          {rows.length} span{rows.length === 1 ? "" : "s"} · status{" "}
        </span>
        <StatusBadge status={trace.status} />
      </div>
    </div>
  );
}
