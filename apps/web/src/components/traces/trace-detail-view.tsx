"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatePanel } from "@/components/states/state-panel";
import { StatusBadge } from "@/components/status-badge";
import { SpanTimeline } from "@/components/traces/span-timeline";
import {
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
} from "@/lib/format";
import type { TraceDetail } from "@/lib/queries/types";

type DetailState =
  | { status: "loading" }
  | { status: "ready"; trace: TraceDetail }
  | { status: "error"; message: string; notFound: boolean };

/**
 * Loads and renders a single trace.
 *
 * Fetches on open rather than shipping every trace body with the list: the
 * list row only needs a summary, and pulling all spans up front would send
 * data the user has not asked to see. It also means the detail request carries
 * the session cookie and is authorized independently — the list being
 * authorized does not imply the detail is.
 */
export function TraceDetailView({
  traceId,
  onClose,
}: {
  traceId: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    async function load() {
      try {
        const response = await fetch(`/api/v1/traces/${traceId}`, {
          headers: { Accept: "application/json" },
        });

        if (cancelled) return;

        if (response.status === 404) {
          setState({
            status: "error",
            notFound: true,
            message: "This trace does not exist, or it belongs to another account.",
          });
          return;
        }

        if (response.status === 401) {
          setState({
            status: "error",
            notFound: false,
            message: "Your session has expired. Sign in again to view this trace.",
          });
          return;
        }

        if (!response.ok) {
          setState({
            status: "error",
            notFound: false,
            message: "Could not load this trace. Try again.",
          });
          return;
        }

        const body = await response.json();
        if (!cancelled) setState({ status: "ready", trace: body.trace });
      } catch {
        if (!cancelled) {
          setState({
            status: "error",
            notFound: false,
            message: "Could not reach the server. Check your connection.",
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [traceId, attempt]);

  if (state.status === "loading") {
    return (
      <div
        className="flex items-center gap-2 px-5 py-10 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        Loading trace…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <StatePanel
        tone={state.notFound ? "neutral" : "error"}
        title={state.notFound ? "Trace not found" : "Could not load trace"}
        description={state.message}
        action={
          state.notFound ? (
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          )
        }
      />
    );
  }

  const { trace } = state;
  const metadata: { label: string; value: string }[] = [
    { label: "Agent / workflow", value: trace.name },
    { label: "Project", value: trace.projectName },
    { label: "Environment", value: trace.environment ?? "—" },
    { label: "Started", value: formatAbsoluteTime(trace.startedAt) },
    { label: "Relative", value: formatRelativeTime(trace.startedAt) },
    {
      label: "Total duration",
      value: trace.endedAt ? formatDuration(trace.durationMs) : "Still running",
    },
    { label: "Span count", value: String(trace.spans.length) },
    { label: "External ID", value: trace.externalId },
  ];

  const metadataEntries = Object.entries(trace.metadata);

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {metadata.map((item) => (
          <div key={item.label}>
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="mt-0.5 break-words text-sm">{item.value}</dd>
          </div>
        ))}
      </dl>

      <Separator />

      <SpanTimeline trace={trace} />

      {metadataEntries.length > 0 ? (
        <>
          <Separator />
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Metadata</h3>
            <p className="text-xs text-muted-foreground">
              Credential-shaped fields are masked at ingestion; anything under an
              unrecognised key is stored as sent.
            </p>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
              {JSON.stringify(trace.metadata, null, 2)}
            </pre>
          </div>
        </>
      ) : null}

      <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <span className="font-mono">{trace.id}</span>
        <StatusBadge status={trace.status} />
      </div>
    </div>
  );
}
