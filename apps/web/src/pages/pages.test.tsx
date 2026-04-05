import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiConfigProvider } from "@/lib/api-config";
import { App } from "@/App";

const graphPayload = {
  filters: { topic: "berlin", time_from: null, time_to: null, confidence_min: 0.3 },
  nodes: [
    {
      id: "experience:n1",
      node_type: "experience",
      kind: "place",
      label: "Berlin",
      confidence: null,
      document_id: "doc-1",
      valid_from: Date.now(),
      valid_to: null,
    },
  ],
  edges: [
    {
      id: "e1",
      edge_type: "experience_relation",
      src_id: "experience:n1",
      dst_id: "experience:n1",
      predicate: "mentioned_with",
      confidence: 0.5,
      document_id: "doc-1",
      valid_from: Date.now(),
      valid_to: null,
    },
  ],
  stats: { node_count: 1, edge_count: 1 },
};

const timelinePayload = {
  filters: { topic: "rapamycin", time_from: null, time_to: null, limit: 200 },
  events: [
    {
      id: "event1",
      kind: "belief_record",
      event_type: "belief_record",
      occurred_at: Date.now(),
      title: "Rapamycin may improve some longevity markers.",
      topic: "rapamycin",
      confidence: 0.72,
      metadata: {},
    },
  ],
};

const replayPayload = {
  run: { id: "run-1", status: "completed", trace_id: "trace-1" },
  steps: [{ id: "step-1", kind: "plan", title: "decompose", created_at: Date.now() - 1000 }],
  events: [{ id: "event-1", event_type: "research_run_completed", created_at: Date.now() - 500 }],
  artifacts: [{ id: "artifact-1", kind: "claim", title: "Claim", retrieved_at: Date.now() }],
};

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiConfigProvider>
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      </ApiConfigProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("visualization pages", () => {
  it("renders graph page with data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(graphPayload), { status: 200, headers: { "content-type": "application/json" } }),
    );

    renderAt("/beliefs/graph");

    await waitFor(() => {
      expect(screen.getByText("Graph Explorer")).toBeInTheDocument();
      expect(screen.getByText("Berlin")).toBeInTheDocument();
    });
  });

  it("renders timeline page with markers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(timelinePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    renderAt("/beliefs/timeline");

    await waitFor(() => {
      expect(screen.getByText("Belief + Activity Timeline")).toBeInTheDocument();
      expect(screen.getByText("Rapamycin may improve some longevity markers.")).toBeInTheDocument();
    });
  });

  it("renders replay page with stream items", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(replayPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    renderAt("/runs/run-1/replay");

    await waitFor(() => {
      expect(screen.getByText("Research Replay")).toBeInTheDocument();
      expect(screen.getByText("decompose (plan)")).toBeInTheDocument();
    });
  });
});
