import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-slate-500 focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
      {...props}
    />
  );
}
