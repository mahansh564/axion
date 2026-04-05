import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

type TabsContextValue = {
  value: string;
  setValue: (value: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  className,
  children,
}: {
  defaultValue: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const [internal, setInternal] = useState(defaultValue);
  const active = value ?? internal;
  const setValue = (next: string): void => {
    onValueChange?.(next);
    if (value === undefined) setInternal(next);
  };

  const contextValue = useMemo(() => ({ value: active, setValue }), [active]);

  return (
    <TabsContext.Provider value={contextValue}>
      <div className={cn("w-full", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn("inline-flex h-10 items-center justify-center rounded-md bg-slate-100 p-1 text-slate-600", className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  value,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { value: string }): JSX.Element {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("TabsTrigger must be used inside Tabs");
  const active = ctx.value === value;

  return (
    <button
      className={cn(
        "inline-flex h-8 items-center justify-center rounded-sm px-3 text-sm font-medium transition-all",
        active ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
        className,
      )}
      onClick={() => ctx.setValue(value)}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  className,
  value,
  ...props
}: HTMLAttributes<HTMLDivElement> & { value: string }): JSX.Element | null {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("TabsContent must be used inside Tabs");
  if (ctx.value !== value) return null;
  return <div className={cn("mt-3", className)} {...props} />;
}
