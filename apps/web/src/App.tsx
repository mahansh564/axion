import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/AppShell";
import { GraphPage } from "@/pages/GraphPage";
import { ReplayPage } from "@/pages/ReplayPage";
import { TimelinePage } from "@/pages/TimelinePage";

export function App(): JSX.Element {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/beliefs/graph" replace />} />
        <Route path="/beliefs/graph" element={<GraphPage />} />
        <Route path="/beliefs/timeline" element={<TimelinePage />} />
        <Route path="/runs/:runId/replay" element={<ReplayPage />} />
        <Route path="*" element={<Navigate to="/beliefs/graph" replace />} />
      </Routes>
    </AppShell>
  );
}
