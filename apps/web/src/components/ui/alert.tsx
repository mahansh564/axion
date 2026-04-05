import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn("rounded-md border border-border bg-white px-4 py-3", className)} role="alert" {...props} />;
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>): JSX.Element {
  return <h5 className={cn("mb-1 text-sm font-semibold", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cn("text-sm text-muted", className)} {...props} />;
}
