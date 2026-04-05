import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type ApiConfigContextValue = {
  apiBaseUrl: string;
  apiKey: string;
  setApiKey: (value: string) => void;
};

const API_KEY_STORAGE = "axion_api_key";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";

const ApiConfigContext = createContext<ApiConfigContextValue | null>(null);

export function ApiConfigProvider({ children }: { children: ReactNode }): JSX.Element {
  const [apiKey, setApiKeyState] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(API_KEY_STORAGE) ?? "";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (apiKey.trim().length === 0) {
      window.localStorage.removeItem(API_KEY_STORAGE);
      return;
    }
    window.localStorage.setItem(API_KEY_STORAGE, apiKey.trim());
  }, [apiKey]);

  const value = useMemo<ApiConfigContextValue>(
    () => ({
      apiBaseUrl: API_BASE_URL.replace(/\/+$/, ""),
      apiKey,
      setApiKey: (next: string) => setApiKeyState(next),
    }),
    [apiKey],
  );

  return <ApiConfigContext.Provider value={value}>{children}</ApiConfigContext.Provider>;
}

export function useApiConfig(): ApiConfigContextValue {
  const ctx = useContext(ApiConfigContext);
  if (!ctx) {
    throw new Error("useApiConfig must be used within ApiConfigProvider");
  }
  return ctx;
}
