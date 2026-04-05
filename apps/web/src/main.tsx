import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "@/App";
import { ApiConfigProvider } from "@/lib/api-config";
import "@/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ApiConfigProvider>
        <App />
      </ApiConfigProvider>
    </BrowserRouter>
  </StrictMode>,
);
