import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared layout for the non-happy-path states.
 *
 * Every page uses this so "no traces yet", "the query failed" and "not found"
 * look deliberately designed rather than like a rendering accident. The icon,
 * message and action slot are the only differences.
 */
export function StatePanel({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-4 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "grid size-10 place-items-center rounded-full",
            tone === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
