"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Manual refresh.
 *
 * Deliberately the simplest mechanism that works: `router.refresh()` re-runs
 * the server component tree and streams fresh data. No polling, no cache
 * invalidation keys, no client cache to go stale — the server is the single
 * source of truth and a refresh is an explicit user action.
 *
 * `useTransition` keeps the current data on screen while the refresh is in
 * flight, so the page does not flash empty.
 */
export function RefreshButton({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-9 gap-1.5 text-xs"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw
        aria-hidden="true"
        className={cn("size-3.5", pending && "animate-spin")}
      />
      {pending ? "Refreshing…" : label}
    </Button>
  );
}
