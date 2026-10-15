"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import { TIME_RANGES, type TimeRangeKey } from "@/lib/data/time-ranges";

interface TimeRangeContextValue {
  range: TimeRangeKey;
  setRange: (range: TimeRangeKey) => void;
  /** Window length of the selected range in minutes. */
  minutes: number;
}

const TimeRangeContext = createContext<TimeRangeContextValue | null>(null);

/**
 * Selected time range, carried in the URL as `?range=`.
 *
 * Same reasoning as `ProjectContext`: the server component has to read the
 * same value the user picked so the *query* is bounded by the range, rather
 * than the client fetching everything and filtering it down.
 */
export function TimeRangeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = searchParams.get("range");
  const range: TimeRangeKey =
    TIME_RANGES.find((entry) => entry.key === raw)?.key ?? "24h";

  const setRange = useCallback(
    (next: TimeRangeKey) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "24h") params.delete("range");
      else params.set("range", next);
      // Changing the window invalidates the current page position.
      params.delete("cursor");
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const value = useMemo(() => {
    const minutes =
      TIME_RANGES.find((r) => r.key === range)?.minutes ??
      TIME_RANGES[1].minutes;
    return { range, setRange, minutes };
  }, [range, setRange]);

  return (
    <TimeRangeContext.Provider value={value}>
      {children}
    </TimeRangeContext.Provider>
  );
}

export function useTimeRange(): TimeRangeContextValue {
  const context = useContext(TimeRangeContext);
  if (!context) {
    throw new Error("useTimeRange must be used within a TimeRangeProvider");
  }
  return context;
}
