export type BeliefSubgraphResponse = {
  filters: {
    topic: string | null;
    time_from: number | null;
    time_to: number | null;
    confidence_min: number | null;
  };
  nodes: Array<{
    id: string;
    node_type: "experience" | "research" | "belief";
    kind: string;
    label: string;
    confidence: number | null;
    document_id: string | null;
    valid_from: number;
    valid_to: number | null;
  }>;
  edges: Array<{
    id: string;
    edge_type: "experience_relation" | "belief_evidence" | "belief_supersedes";
    src_id: string;
    dst_id: string;
    predicate: string;
    confidence: number | null;
    document_id: string | null;
    valid_from: number;
    valid_to: number | null;
  }>;
  stats: {
    node_count: number;
    edge_count: number;
  };
};

export type TimelineEventsResponse = {
  filters: {
    topic: string | null;
    time_from: number | null;
    time_to: number | null;
    limit: number;
  };
  events: Array<{
    id: string;
    kind: "belief_record" | "episodic_event";
    event_type: string;
    occurred_at: number;
    title: string;
    topic: string | null;
    confidence: number | null;
    metadata: Record<string, unknown>;
  }>;
};

export type ReplayResponse = {
  run: {
    id: string;
    status: string;
    trace_id: string;
  };
  steps: Array<{
    id: string;
    kind: string;
    title: string;
    created_at: number;
  }>;
  events: Array<{
    id: string;
    event_type: string;
    created_at: number;
  }>;
  artifacts: Array<{
    id: string;
    kind: string;
    title: string | null;
    retrieved_at: number;
  }>;
};

export function buildAuthHeaders(apiKey: string): HeadersInit {
  const trimmed = apiKey.trim();
  if (!trimmed) return {};
  return {
    Authorization: `Bearer ${trimmed}`,
  };
}

function withQuery(pathname: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return pathname;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export async function getJson<T>(input: {
  apiBaseUrl: string;
  apiKey: string;
  pathname: string;
  query?: Record<string, string | number | undefined>;
}): Promise<T> {
  const url = `${input.apiBaseUrl}${withQuery(input.pathname, input.query)}`;
  const res = await fetch(url, {
    headers: buildAuthHeaders(input.apiKey),
  });
  if (!res.ok) {
    throw new Error(`request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchBeliefSubgraph(input: {
  apiBaseUrl: string;
  apiKey: string;
  topic?: string;
  timeFrom?: number;
  timeTo?: number;
  confidenceMin?: number;
}): Promise<BeliefSubgraphResponse> {
  return getJson<BeliefSubgraphResponse>({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    pathname: "/beliefs/subgraph",
    query: {
      topic: input.topic,
      time_from: input.timeFrom,
      time_to: input.timeTo,
      confidence_min: input.confidenceMin,
    },
  });
}

export async function fetchTimelineEvents(input: {
  apiBaseUrl: string;
  apiKey: string;
  topic?: string;
  timeFrom?: number;
  timeTo?: number;
}): Promise<TimelineEventsResponse> {
  return getJson<TimelineEventsResponse>({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    pathname: "/timeline/events",
    query: {
      topic: input.topic,
      time_from: input.timeFrom,
      time_to: input.timeTo,
    },
  });
}

export async function fetchReplay(input: {
  apiBaseUrl: string;
  apiKey: string;
  runId: string;
}): Promise<ReplayResponse> {
  return getJson<ReplayResponse>({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    pathname: `/runs/${encodeURIComponent(input.runId)}/replay`,
  });
}
