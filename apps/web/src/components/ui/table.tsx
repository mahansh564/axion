import type { HTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>): JSX.Element {
  return <table className={cn("w-full caption-bottom text-sm", className)} {...props} />;
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return <thead className={cn("[&_tr]:border-b", className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>): JSX.Element {
  return <tr className={cn("border-b transition-colors", className)} {...props} />;
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return <th className={cn("h-10 px-2 text-left align-middle text-xs text-muted", className)} {...props} />;
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return <td className={cn("p-2 align-middle", className)} {...props} />;
}
