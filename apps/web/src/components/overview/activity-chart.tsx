"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { TimeRangeKey } from "@/lib/data/time-ranges";
import type { ActivityPoint } from "@/lib/queries/types";

/**
 * Trace activity chart.
 *
 * Library: Recharts (via the shadcn/ui `chart` wrapper) — chosen because it
 * is the chart library shadcn/ui supports officially, works client-side in
 * Next.js App Router, and needs no API keys.
 *
 * Data: bucketed counts of persisted traces in the selected window, computed
 * server-side from the same authorized query the trace list uses.
 */
const chartConfig = {
  traces: {
    label: "Traces",
    color: "var(--chart-1)",
  },
  errors: {
    label: "Errors",
    color: "var(--destructive)",
  },
} satisfies ChartConfig;

/** Formats a bucket label for the axis: time-only for short ranges. */
function formatBucketLabel(iso: string, range: TimeRangeKey): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (range === "1h" || range === "24h") {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ActivityChart({
  points,
  range,
}: {
  points: readonly ActivityPoint[];
  range: TimeRangeKey;
}) {
  // Labels are formatted for display here, keeping the server payload as raw
  // ISO buckets so the same data works in any timezone.
  const data = points.map((point) => ({
    ...point,
    label: formatBucketLabel(point.label, range),
  }));

  const total = data.reduce((sum, point) => sum + point.traces, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trace activity</CardTitle>
        <CardDescription>
          {total === 0
            ? "No traces in this window yet."
            : `${total.toLocaleString("en-US")} trace${total === 1 ? "" : "s"} in this window, bucketed by start time.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-52 w-full">
          <AreaChart
            data={data}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={16}
              fontSize={11}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={32}
              allowDecimals={false}
              fontSize={11}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area
              dataKey="traces"
              type="monotone"
              fill="var(--color-traces)"
              fillOpacity={0.12}
              stroke="var(--color-traces)"
              strokeWidth={2}
            />
            <Area
              dataKey="errors"
              type="monotone"
              fill="var(--color-errors)"
              fillOpacity={0.12}
              stroke="var(--color-errors)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
