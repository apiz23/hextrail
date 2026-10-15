import { CircleAlert, Clock, FolderKanban, ListTree } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDuration, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OverviewStats } from "@/lib/queries/types";

interface MetricCardsProps {
  stats: OverviewStats;
}

export function MetricCards({ stats }: MetricCardsProps) {
  const cards = [
    {
      label: "Total traces",
      value: stats.totalTraces.toLocaleString("en-US"),
      hint: "Completed and in-flight traces in range",
      icon: ListTree,
      tone: "text-foreground",
    },
    {
      label: "Error rate",
      value: formatPercent(stats.errorRate),
      hint: "Share of traces with a failed span",
      icon: CircleAlert,
      tone: stats.errorRate > 0 ? "text-destructive" : "text-foreground",
    },
    {
      label: "Avg. latency",
      value: formatDuration(stats.avgLatencyMs),
      hint: "Mean trace duration in range",
      icon: Clock,
      tone: "text-foreground",
    },
    {
      label: "Active projects",
      value: stats.activeProjects.toLocaleString("en-US"),
      hint: "Projects with at least one trace in range",
      icon: FolderKanban,
      tone: "text-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
              <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div
                className={cn(
                  "text-2xl font-semibold tracking-tight tabular-nums",
                  card.tone,
                )}
              >
                {card.value}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
