import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";

import { Input } from "@/components/ui/input";
import { useApiConfig } from "@/lib/api-config";

function NavItem({ to, label }: { to: string; label: string }): JSX.Element {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-md px-3 py-2 text-sm ${isActive ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`
      }
    >
      {label}
    </NavLink>
  );
}

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { apiKey, setApiKey, apiBaseUrl } = useApiConfig();

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 via-background to-background">
      <header className="border-b border-border bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Link to="/beliefs/graph" className="text-sm font-semibold tracking-wide text-slate-900">
              Axion Visualization
            </Link>
            <div className="inline-flex rounded-lg bg-slate-100 p-1">
              <NavItem to="/beliefs/graph" label="Graph" />
              <NavItem to="/beliefs/timeline" label="Timeline" />
              <NavItem to="/runs/demo/replay" label="Replay" />
            </div>
          </div>
          <div className="grid w-full max-w-md gap-1">
            <label className="text-xs font-medium text-muted" htmlFor="api-key">
              API Key (optional)
            </label>
            <Input
              id="api-key"
              placeholder="Bearer key for protected API"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <p className="text-xs text-muted">API base: {apiBaseUrl}</p>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
