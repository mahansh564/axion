import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "outline";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({ className, variant = "default", ...props }: ButtonProps): JSX.Element {
  const variantClass =
    variant === "secondary"
      ? "bg-slate-700 text-white hover:bg-slate-600"
      : variant === "outline"
        ? "border border-border bg-card hover:bg-slate-50"
        : "bg-primary text-white hover:bg-blue-700";

  return (
    <button
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variantClass,
        className,
      )}
      {...props}
    />
  );
}
