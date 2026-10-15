"use client";

import { useEffect } from "react";
import { CircleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/states/state-panel";

/**
 * Route-level error boundary.
 *
 * Catches render-time failures in a page (a query throwing rather than
 * returning an error result). The message shown is deliberately generic: the
 * `error` object can contain internals, so it is logged, not rendered.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Route error:", error);
  }, [error]);

  return (
    <StatePanel
      tone="error"
      icon={<CircleAlert className="size-5" />}
      title="Something went wrong"
      description="This page could not be rendered. Retrying re-runs the request."
      action={
        <Button variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
