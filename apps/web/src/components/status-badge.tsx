import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TraceStatus } from "@/lib/queries/types";

const STATUS_STYLES: Record<
  TraceStatus,
  { label: string; className: string }
> = {
  ok: {
    label: "Success",
    className: "border-success/30 bg-success/10 text-success",
  },
  error: {
    label: "Error",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  running: {
    label: "Running",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
};

export function StatusBadge({
  status,
  className,
}: {
  status: TraceStatus;
  className?: string;
}) {
  const style = STATUS_STYLES[status];
  return (
    <Badge
      variant="outline"
      className={cn(style.className, className)}
      data-status={status}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {style.label}
    </Badge>
  );
}
