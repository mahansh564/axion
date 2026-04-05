import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function ScrollArea({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn("max-h-[420px] overflow-auto", className)} {...props} />;
}
