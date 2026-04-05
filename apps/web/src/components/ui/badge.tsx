import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "secondary" | "outline";

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }): JSX.Element {
  const styles =
    variant === "secondary"
      ? "bg-slate-100 text-slate-700"
      : variant === "outline"
        ? "border border-border text-slate-700"
        : "bg-blue-100 text-blue-800";

  return (
    <span
      className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", styles, className)}
      {...props}
    />
  );
}
