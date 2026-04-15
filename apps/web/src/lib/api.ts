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

// Stage 5: Stale Edge Detection Types
export type StaleEdgeCandidate = {
  id: string;
  candidate_type: "expired_belief" | "research_contradiction" | "stale_edge" | "unsuperseded_expired";
  topic: string | null;
  summary: string;
  confidence: number;
  severity: "low" | "medium" | "high";
  detected_at: number;
  evidence: Record<string, unknown>;
};

export type StaleEdgeCandidatesResponse = {
  generated_at: number;
  stale_candidates: StaleEdgeCandidate[];
};

export type RefreshDecision = "refresh_belief" | "archive_belief" | "schedule_research" | "ignore";

export type StaleEdgeResolutionResponse = {
  resolution_id: string;
  candidate_id: string;
  decision: RefreshDecision;
  created_at: number;
  actions_taken: string[];
};

// Stage 5: Curiosity Engine Types
export type CuriositySuggestion = {
  id: string;
  suggestion_type: "research_task" | "reflection_prompt";
  signal_type:
    | "dormant_open_question"
    | "recurring_topic"
    | "repeated_confusion_phrase"
    | "conversation_gap"
    | "unanswered_question"
    | "follow_up_needed";
  topic: string;
  prompt: string;
  score: number;
  detected_at: number;
  evidence: Record<string, unknown>;
};

export type CuriositySuggestionsResponse = {
  generated_at: number;
  suggestions: CuriositySuggestion[];
};

// Stage 5: Contradiction Types
export type ContradictionCandidate = {
  id: string;
  candidate_type: "belief_conflict" | "observer_flag";
  topic: string | null;
  summary: string;
  confidence: number;
  status: string;
  detected_at: number;
  evidence: Record<string, unknown>;
};

export type ContradictionCandidatesResponse = {
  contradiction_candidates: ContradictionCandidate[];
};

export type ContradictionResolutionResponse = {
  resolution_id: string;
  candidate_id: string;
  candidate_type: string;
  decision: string;
  target_belief_id: string | null;
  resolution_belief_id: string | null;
  created_at: number;
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

async function postJson<T>(input: {
  apiBaseUrl: string;
  apiKey: string;
  pathname: string;
  body: Record<string, unknown>;
}): Promise<T> {
  const url = `${input.apiBaseUrl}${input.pathname}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(input.apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`request failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
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

// Stage 5: Stale Edge API
export async function fetchStaleEdgeCandidates(input: {
  apiBaseUrl: string;
  apiKey: string;
  topic?: string;
  minConfidence?: number;
  staleDays?: number;
  limit?: number;
}): Promise<StaleEdgeCandidatesResponse> {
  return getJson<StaleEdgeCandidatesResponse>({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    pathname: "/stale-edge/candidates",
    query: {
      topic: input.topic,
      min_confidence: input.minConfidence,
      stale_days: input.staleDays,
      limit: input.limit,
    },
  });
}

export async function resolveStaleEdge(input: {
  apiBaseUrl: string;
  apiKey: string;
  candidateId: string;
  decision: RefreshDecision;
  refreshStatement?: string;
  refreshConfidence?: number;
  rationale?: string;
}): Promise<StaleEdgeResolutionResponse> {
  return postJson<StaleEdgeResolutionResponse>({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    pathname: "/stale-edge/resolve",
    body: {
      candidate_id: input.candidateId,
      decision: input.decision,
      refresh_statement: input.refreshStatement,
      refresh_confidence: input.refreshConfidence,
      rationale: input.rationale,
    },
  });
}

// Stage 5: Curiosity API
export async function fetchCuriositySuggestions(input: {
  apiBaseUrl: string;
  apiKey: string;
  topic?: string;
  limit?: number;
  minScore?: number;
  dormantDays?: number;
}): Promise<CuriositySuggestionsResponse> {
  return getJson<CuriositySuggestionsResponse>({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    pathname: "/curiosity/suggestions",
    query: {
      topic: input.topic,
      limit: input.limit,
      min_score: input.minScore,
      dormant_days: input.dormantDays,
    },
  });
}

// Stage 5: Contradiction API
export async function fetchContradictionCandidates(input: {
  apiBaseUrl: string;
  apiKey: string;
  topic?: string;
  confidenceMin?: number;
  limit?: number;
}): Promise<ContradictionCandidatesResponse> {
  return getJson<ContradictionCandidatesResponse>({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    pathname: "/contradiction-candidates",
    query: {
      topic: input.topic,
      confidence_min: input.confidenceMin,
      limit: input.limit,
    },
  });
}

export async function resolveContradiction(input: {
  apiBaseUrl: string;
  apiKey: string;
  candidateId: string;
  decision: "invalidate_belief" | "supersede_belief" | "keep_both";
  targetBeliefId?: string;
  statement?: string;
  topic?: string;
  confidence?: number;
  rationale?: string;
}): Promise<ContradictionResolutionResponse> {
  return postJson<ContradictionResolutionResponse>({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    pathname: "/contradictions/resolve",
    body: {
      candidate_id: input.candidateId,
      decision: input.decision,
      target_belief_id: input.targetBeliefId,
      statement: input.statement,
      topic: input.topic,
      confidence: input.confidence,
      rationale: input.rationale,
    },
  });
}
