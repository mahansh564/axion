import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  beliefEvidence,
  beliefRecords,
  episodicEvents,
  graphEdges,
  graphNodes,
  researchArtifacts,
} from "./db/schema.js";

const MAJOR_TIMELINE_EVENTS = new Set([
  "transcribe_completed",
  "extract_completed",
  "research_run_requested",
  "research_run_started",
  "sub_question_resolved",
  "research_run_completed",
  "research_run_failed",
]);

type SubgraphNode = {
  id: string;
  node_type: "experience" | "research" | "belief";
  kind: string;
  label: string;
  confidence: number | null;
  document_id: string | null;
  valid_from: number;
  valid_to: number | null;
};

type SubgraphEdge = {
  id: string;
  edge_type: "experience_relation" | "belief_evidence" | "belief_supersedes";
  src_id: string;
  dst_id: string;
  predicate: string;
  confidence: number | null;
  document_id: string | null;
  valid_from: number;
  valid_to: number | null;
};

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summarizeResearchLabel(title: string | null, content: string): string {
  const source = title ? `${title}: ${content}` : content;
  const normalized = collapseWhitespace(source);
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function matchesWindow(
  validFrom: number,
  validTo: number | null,
  timeFrom?: number,
  timeTo?: number,
): boolean {
  if (timeFrom === undefined && timeTo === undefined) return true;
  if (timeFrom !== undefined && validTo !== null && validTo < timeFrom) return false;
  if (timeTo !== undefined && validFrom > timeTo) return false;
  return true;
}

function timelineEventTitle(eventType: string, payload: Record<string, unknown>): string {
  if (eventType === "transcribe_completed") {
    const documentId = typeof payload.document_id === "string" ? payload.document_id : null;
    return documentId ? `Transcript stored (${documentId})` : "Transcript stored";
  }
  if (eventType === "extract_completed") {
    const count = typeof payload.entity_count === "number" ? payload.entity_count : null;
    return typeof count === "number" ? `Extraction completed (${count} entities)` : "Extraction completed";
  }
  if (eventType === "research_run_requested") {
    const goal = typeof payload.goal === "string" ? payload.goal : null;
    return goal ? `Research requested: ${goal}` : "Research requested";
  }
  if (eventType === "research_run_started") {
    const goal = typeof payload.goal === "string" ? payload.goal : null;
    return goal ? `Research started: ${goal}` : "Research started";
  }
  if (eventType === "sub_question_resolved") {
    const question = typeof payload.question === "string" ? payload.question : null;
    return question ? `Sub-question resolved: ${question}` : "Sub-question resolved";
  }
  if (eventType === "research_run_completed") return "Research run completed";
  if (eventType === "research_run_failed") return "Research run failed";
  return eventType;
}

function timelineEventTopic(eventType: string, payload: Record<string, unknown>): string | null {
  if (eventType.startsWith("research_run_")) {
    const goal = typeof payload.goal === "string" ? payload.goal.trim() : "";
    return goal ? goal.toLowerCase() : null;
  }
  if (eventType === "sub_question_resolved") {
    const question = typeof payload.question === "string" ? payload.question.trim() : "";
    return question ? question.toLowerCase() : null;
  }
  return null;
}

function filterByTopic(value: string | null, topic: string): boolean {
  if (!value) return false;
  return value.toLowerCase().includes(topic);
}

export async function getBeliefSubgraph(input?: {
  topic?: string;
  timeFrom?: number;
  timeTo?: number;
  confidenceMin?: number;
  maxNodes?: number;
  maxEdges?: number;
}): Promise<{
  filters: {
    topic: string | null;
    time_from: number | null;
    time_to: number | null;
    confidence_min: number | null;
  };
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  stats: { node_count: number; edge_count: number };
}> {
  const topic = input?.topic?.trim().toLowerCase() || null;
  const timeFrom = input?.timeFrom;
  const timeTo = input?.timeTo;
  const confidenceMin = input?.confidenceMin;
  const maxNodes = Math.max(10, Math.min(input?.maxNodes ?? 300, 1000));
  const maxEdges = Math.max(10, Math.min(input?.maxEdges ?? 500, 2000));

  const experienceEdgeClauses = [];
  if (confidenceMin !== undefined) {
    experienceEdgeClauses.push(sql`coalesce(${graphEdges.confidence}, 0) >= ${confidenceMin}`);
  }
  if (timeFrom !== undefined) {
    experienceEdgeClauses.push(or(isNull(graphEdges.validTo), sql`${graphEdges.validTo} >= ${timeFrom}`));
  }
  if (timeTo !== undefined) {
    experienceEdgeClauses.push(lte(graphEdges.validFrom, timeTo));
  }

  const experienceNodeClauses = [];
  if (timeFrom !== undefined) {
    experienceNodeClauses.push(or(isNull(graphNodes.validTo), sql`${graphNodes.validTo} >= ${timeFrom}`));
  }
  if (timeTo !== undefined) {
    experienceNodeClauses.push(lte(graphNodes.validFrom, timeTo));
  }

  const beliefClauses = [];
  if (topic) {
    beliefClauses.push(
      or(
        eq(beliefRecords.topic, topic),
        sql`lower(${beliefRecords.statement}) like ${"%" + topic + "%"}`,
      ),
    );
  }
  if (timeFrom !== undefined) {
    beliefClauses.push(or(isNull(beliefRecords.validTo), sql`${beliefRecords.validTo} >= ${timeFrom}`));
  }
  if (timeTo !== undefined) {
    beliefClauses.push(lte(beliefRecords.validFrom, timeTo));
  }
  if (confidenceMin !== undefined) {
    beliefClauses.push(sql`${beliefRecords.confidence} >= ${confidenceMin}`);
  }

  const researchClauses = [
    ...(timeFrom !== undefined ? [sql`${researchArtifacts.retrievedAt} >= ${timeFrom}`] : []),
    ...(timeTo !== undefined ? [sql`${researchArtifacts.retrievedAt} <= ${timeTo}`] : []),
    ...(topic
      ? [
          or(
            sql`lower(${researchArtifacts.content}) like ${"%" + topic + "%"}`,
            sql`lower(${researchArtifacts.title}) like ${"%" + topic + "%"}`,
          ),
        ]
      : []),
  ];

  const [rawExperienceNodes, rawExperienceEdges, beliefRows, researchRows] = await Promise.all([
    experienceNodeClauses.length > 0
      ? db.select().from(graphNodes).where(and(...experienceNodeClauses)).limit(maxNodes).all()
      : db.select().from(graphNodes).limit(maxNodes).all(),
    experienceEdgeClauses.length > 0
      ? db.select().from(graphEdges).where(and(...experienceEdgeClauses)).limit(maxEdges).all()
      : db.select().from(graphEdges).limit(maxEdges).all(),
    beliefClauses.length > 0
      ? db.select().from(beliefRecords).where(and(...beliefClauses)).limit(maxNodes).all()
      : db.select().from(beliefRecords).limit(maxNodes).all(),
    researchClauses.length > 0
      ? db.select().from(researchArtifacts).where(and(...researchClauses)).limit(maxNodes).all()
      : db
          .select()
          .from(researchArtifacts)
          .where(or(eq(researchArtifacts.kind, "claim"), eq(researchArtifacts.kind, "excerpt")))
          .limit(maxNodes)
          .all(),
  ]);

  let filteredExperienceEdges = rawExperienceEdges.filter((edge) =>
    matchesWindow(edge.validFrom, edge.validTo, timeFrom, timeTo),
  );
  let filteredExperienceNodes = rawExperienceNodes.filter((node) =>
    matchesWindow(node.validFrom, node.validTo, timeFrom, timeTo),
  );

  if (topic) {
    const seedNodeIds = new Set(
      filteredExperienceNodes
        .filter((node) => node.label.toLowerCase().includes(topic) || node.kind.toLowerCase().includes(topic))
        .map((node) => node.id),
    );
    filteredExperienceEdges = filteredExperienceEdges.filter(
      (edge) => seedNodeIds.has(edge.srcId) || seedNodeIds.has(edge.dstId),
    );
    const connectedNodeIds = new Set<string>();
    for (const edge of filteredExperienceEdges) {
      connectedNodeIds.add(edge.srcId);
      connectedNodeIds.add(edge.dstId);
    }
    filteredExperienceNodes = filteredExperienceNodes.filter(
      (node) => connectedNodeIds.has(node.id) || seedNodeIds.has(node.id),
    );
  } else {
    const edgeNodeIds = new Set<string>();
    for (const edge of filteredExperienceEdges) {
      edgeNodeIds.add(edge.srcId);
      edgeNodeIds.add(edge.dstId);
    }
    if (edgeNodeIds.size > 0) {
      filteredExperienceNodes = filteredExperienceNodes.filter((node) => edgeNodeIds.has(node.id));
    }
  }

  filteredExperienceEdges = filteredExperienceEdges.slice(0, maxEdges);
  filteredExperienceNodes = filteredExperienceNodes.slice(0, maxNodes);

  const beliefIds = beliefRows.map((belief) => belief.id);
  const evidenceRows =
    beliefIds.length > 0
      ? await db.select().from(beliefEvidence).where(inArray(beliefEvidence.beliefId, beliefIds)).all()
      : [];

  const artifactIdsFromEvidence = [
    ...new Set(
      evidenceRows
        .map((evidence) => evidence.refId)
        .filter((refId): refId is string => typeof refId === "string" && refId.length > 0),
    ),
  ];
  const artifactRowsFromEvidence =
    artifactIdsFromEvidence.length > 0
      ? await db
          .select()
          .from(researchArtifacts)
          .where(inArray(researchArtifacts.id, artifactIdsFromEvidence))
          .all()
      : [];

  const researchRowMap = new Map<string, (typeof researchRows)[number]>();
  for (const artifact of researchRows) researchRowMap.set(artifact.id, artifact);
  for (const artifact of artifactRowsFromEvidence) researchRowMap.set(artifact.id, artifact);

  const nodes = new Map<string, SubgraphNode>();
  const edges = new Map<string, SubgraphEdge>();

  for (const node of filteredExperienceNodes) {
    nodes.set(`experience:${node.id}`, {
      id: `experience:${node.id}`,
      node_type: "experience",
      kind: node.kind,
      label: node.label,
      confidence: null,
      document_id: node.documentId,
      valid_from: node.validFrom,
      valid_to: node.validTo,
    });
  }

  for (const edge of filteredExperienceEdges) {
    const srcId = `experience:${edge.srcId}`;
    const dstId = `experience:${edge.dstId}`;
    if (!nodes.has(srcId) || !nodes.has(dstId)) continue;
    edges.set(edge.id, {
      id: edge.id,
      edge_type: "experience_relation",
      src_id: srcId,
      dst_id: dstId,
      predicate: edge.predicate,
      confidence: edge.confidence,
      document_id: edge.documentId,
      valid_from: edge.validFrom,
      valid_to: edge.validTo,
    });
  }

  for (const belief of beliefRows) {
    const beliefId = `belief:${belief.id}`;
    nodes.set(beliefId, {
      id: beliefId,
      node_type: "belief",
      kind: belief.sourceKind,
      label: belief.statement,
      confidence: belief.confidence,
      document_id: belief.sourceDocumentId,
      valid_from: belief.validFrom,
      valid_to: belief.validTo,
    });
  }

  for (const artifact of researchRowMap.values()) {
    const researchId = `research:${artifact.id}`;
    nodes.set(researchId, {
      id: researchId,
      node_type: "research",
      kind: artifact.kind,
      label: summarizeResearchLabel(artifact.title, artifact.content),
      confidence: null,
      document_id: null,
      valid_from: artifact.retrievedAt,
      valid_to: null,
    });
  }

  for (const belief of beliefRows) {
    if (!belief.supersedesBeliefId) continue;
    const src = `belief:${belief.id}`;
    const dst = `belief:${belief.supersedesBeliefId}`;
    if (!nodes.has(src) || !nodes.has(dst)) continue;
    edges.set(`belief-supersedes:${belief.id}`, {
      id: `belief-supersedes:${belief.id}`,
      edge_type: "belief_supersedes",
      src_id: src,
      dst_id: dst,
      predicate: "supersedes",
      confidence: belief.confidence,
      document_id: null,
      valid_from: belief.validFrom,
      valid_to: belief.validTo,
    });
  }

  for (const evidence of evidenceRows) {
    const beliefNodeId = `belief:${evidence.beliefId}`;
    if (!nodes.has(beliefNodeId)) continue;
    if (!evidence.refId) continue;
    if (evidence.evidenceType !== "artifact") continue;
    const researchNodeId = `research:${evidence.refId}`;
    if (!nodes.has(researchNodeId)) continue;

    const edgeId = `belief-evidence:${evidence.id}`;
    edges.set(edgeId, {
      id: edgeId,
      edge_type: "belief_evidence",
      src_id: beliefNodeId,
      dst_id: researchNodeId,
      predicate: "supported_by",
      confidence: null,
      document_id: null,
      valid_from: evidence.createdAt,
      valid_to: null,
    });
  }

  let nodesOut = [...nodes.values()];
  let edgesOut = [...edges.values()];

  if (topic) {
    const topicNodes = new Set(
      nodesOut
        .filter(
          (node) =>
            node.label.toLowerCase().includes(topic) ||
            node.kind.toLowerCase().includes(topic),
        )
        .map((node) => node.id),
    );
    edgesOut = edgesOut.filter((edge) => topicNodes.has(edge.src_id) || topicNodes.has(edge.dst_id));
    const connected = new Set<string>();
    for (const edge of edgesOut) {
      connected.add(edge.src_id);
      connected.add(edge.dst_id);
    }
    nodesOut = nodesOut.filter((node) => topicNodes.has(node.id) || connected.has(node.id));
  }

  nodesOut = nodesOut
    .sort((a, b) => b.valid_from - a.valid_from || a.label.localeCompare(b.label))
    .slice(0, maxNodes);
  const allowedNodeIds = new Set(nodesOut.map((node) => node.id));
  edgesOut = edgesOut
    .filter((edge) => allowedNodeIds.has(edge.src_id) && allowedNodeIds.has(edge.dst_id))
    .sort((a, b) => b.valid_from - a.valid_from)
    .slice(0, maxEdges);

  return {
    filters: {
      topic,
      time_from: timeFrom ?? null,
      time_to: timeTo ?? null,
      confidence_min: confidenceMin ?? null,
    },
    nodes: nodesOut,
    edges: edgesOut,
    stats: { node_count: nodesOut.length, edge_count: edgesOut.length },
  };
}

export async function listTimelineEvents(input?: {
  topic?: string;
  timeFrom?: number;
  timeTo?: number;
  limit?: number;
}): Promise<{
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
}> {
  const topic = input?.topic?.trim().toLowerCase() || null;
  const timeFrom = input?.timeFrom;
  const timeTo = input?.timeTo;
  const limit = Math.max(10, Math.min(input?.limit ?? 200, 500));

  const beliefClauses = [];
  if (topic) beliefClauses.push(eq(beliefRecords.topic, topic));
  if (timeFrom !== undefined) beliefClauses.push(sql`${beliefRecords.validFrom} >= ${timeFrom}`);
  if (timeTo !== undefined) beliefClauses.push(sql`${beliefRecords.validFrom} <= ${timeTo}`);

  const episodicClauses = [
    inArray(episodicEvents.eventType, [...MAJOR_TIMELINE_EVENTS]),
    ...(timeFrom !== undefined ? [sql`${episodicEvents.createdAt} >= ${timeFrom}`] : []),
    ...(timeTo !== undefined ? [sql`${episodicEvents.createdAt} <= ${timeTo}`] : []),
  ];

  const [beliefRows, eventRows] = await Promise.all([
    beliefClauses.length > 0
      ? db.select().from(beliefRecords).where(and(...beliefClauses)).orderBy(desc(beliefRecords.validFrom)).all()
      : db.select().from(beliefRecords).orderBy(desc(beliefRecords.validFrom)).all(),
    db.select().from(episodicEvents).where(and(...episodicClauses)).orderBy(desc(episodicEvents.createdAt)).all(),
  ]);

  const beliefEvents = beliefRows.map((belief) => ({
    id: `belief:${belief.id}`,
    kind: "belief_record" as const,
    event_type: "belief_record",
    occurred_at: belief.validFrom,
    title: belief.statement,
    topic: belief.topic,
    confidence: belief.confidence,
    metadata: {
      belief_id: belief.id,
      source_kind: belief.sourceKind,
      valid_to: belief.validTo,
      supersedes_belief_id: belief.supersedesBeliefId,
    },
  }));

  const episodicEventsOut = eventRows
    .map((event) => {
      const payload = parseJsonObject(event.payload);
      const derivedTopic = timelineEventTopic(event.eventType, payload);
      return {
        id: event.id,
        kind: "episodic_event" as const,
        event_type: event.eventType,
        occurred_at: event.createdAt,
        title: timelineEventTitle(event.eventType, payload),
        topic: derivedTopic,
        confidence: null,
        metadata: payload,
      };
    })
    .filter((event) => (topic ? filterByTopic(event.topic, topic) : true));

  const events = [...beliefEvents, ...episodicEventsOut]
    .sort((a, b) => b.occurred_at - a.occurred_at)
    .slice(0, limit);

  return {
    filters: {
      topic,
      time_from: timeFrom ?? null,
      time_to: timeTo ?? null,
      limit,
    },
    events,
  };
}

function renderAppShell(title: string, appId: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7fb;
        --panel: #ffffff;
        --line: #d6d8e1;
        --text: #151620;
        --muted: #59607a;
        --accent: #2f5cf7;
        --good: #11875d;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--text);
        background: radial-gradient(1200px 600px at 100% -20%, #e9eeff, transparent), var(--bg);
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 24px 16px 40px;
      }
      h1 { margin: 0 0 10px; font-size: 1.8rem; }
      .sub { color: var(--muted); margin-bottom: 16px; }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        margin-bottom: 14px;
      }
      .controls {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        align-items: end;
      }
      label {
        display: grid;
        gap: 4px;
        font-size: 0.85rem;
        color: var(--muted);
      }
      input, button {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px 10px;
        font: inherit;
      }
      button {
        cursor: pointer;
        color: #fff;
        background: var(--accent);
        border: none;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.92rem;
      }
      th, td {
        border-bottom: 1px solid var(--line);
        padding: 8px;
        text-align: left;
        vertical-align: top;
      }
      th { color: var(--muted); font-weight: 600; }
      .chip {
        display: inline-block;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 0.78rem;
        color: var(--muted);
      }
      .status {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 10px;
      }
      .muted { color: var(--muted); }
      .timeline-item {
        border-left: 3px solid #cfd5ec;
        padding: 8px 10px;
        margin: 8px 0;
      }
      .timeline-item.belief_record { border-left-color: var(--good); }
      .mono { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
      .grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      }
      @media (max-width: 720px) { main { padding: 18px 12px 32px; } }
    </style>
  </head>
  <body>
    <main id="${appId}"></main>
  </body>
</html>`;
}

export function renderGraphViewHtml(): string {
  const shell = renderAppShell("Axion Graph Explorer", "graph-root");
  const script = `<script>
const root = document.getElementById("graph-root");
root.innerHTML = \`
  <h1>Graph Explorer</h1>
  <div class="sub">Subgraph by topic, time, and confidence, with experience/research/belief node cues.</div>
  <section class="panel">
    <div class="controls">
      <label>Topic<input id="topic" placeholder="rapamycin" /></label>
      <label>Time From (ms)<input id="timeFrom" type="number" /></label>
      <label>Time To (ms)<input id="timeTo" type="number" /></label>
      <label>Confidence Min<input id="confidence" type="number" min="0" max="1" step="0.01" /></label>
      <label>API Key (optional)<input id="apiKey" placeholder="for API_KEY mode" /></label>
      <button id="load">Load Subgraph</button>
    </div>
  </section>
  <section class="panel">
    <div id="stats" class="status"></div>
    <div class="grid">
      <div>
        <h3>Nodes</h3>
        <table><thead><tr><th>Label</th><th>Type</th><th>Kind</th><th>Recency</th></tr></thead><tbody id="nodes"></tbody></table>
      </div>
      <div>
        <h3>Edges</h3>
        <table><thead><tr><th>Link</th><th>Type</th><th>Predicate</th><th>Confidence</th></tr></thead><tbody id="edges"></tbody></table>
      </div>
    </div>
  </section>
\`;

function fmtTime(ts) { return typeof ts === "number" ? new Date(ts).toISOString() : "-"; }
function initialApiKey() {
  const key = new URLSearchParams(window.location.search).get("api_key");
  return key || localStorage.getItem("axion_api_key") || "";
}
function authHeaders() {
  const token = document.getElementById("apiKey").value.trim();
  if (!token) return {};
  localStorage.setItem("axion_api_key", token);
  return { Authorization: "Bearer " + token };
}
document.getElementById("apiKey").value = initialApiKey();

async function load() {
  const params = new URLSearchParams();
  const topic = document.getElementById("topic").value.trim();
  const timeFrom = document.getElementById("timeFrom").value.trim();
  const timeTo = document.getElementById("timeTo").value.trim();
  const confidence = document.getElementById("confidence").value.trim();
  if (topic) params.set("topic", topic);
  if (timeFrom) params.set("time_from", timeFrom);
  if (timeTo) params.set("time_to", timeTo);
  if (confidence) params.set("confidence_min", confidence);
  const res = await fetch("/beliefs/subgraph?" + params.toString(), { headers: authHeaders() });
  if (!res.ok) {
    document.getElementById("stats").innerHTML = '<span class="chip">request failed: ' + res.status + '</span>';
    return;
  }
  const data = await res.json();
  const stats = document.getElementById("stats");
  stats.innerHTML = [
    '<span class="chip">nodes: ' + data.stats.node_count + '</span>',
    '<span class="chip">edges: ' + data.stats.edge_count + '</span>',
    '<span class="chip">topic: ' + (data.filters.topic || "all") + '</span>'
  ].join("");

  const nodes = document.getElementById("nodes");
  nodes.innerHTML = data.nodes.map((n) => \`<tr>
    <td>\${n.label}</td><td><span class="chip">\${n.node_type}</span></td><td><span class="chip">\${n.kind}</span></td><td class="mono">\${fmtTime(n.valid_from)}</td>
  </tr>\`).join("");

  const edges = document.getElementById("edges");
  edges.innerHTML = data.edges.map((e) => \`<tr>
    <td class="mono">\${e.src_id.slice(0,8)} → \${e.dst_id.slice(0,8)}</td>
    <td><span class="chip">\${e.edge_type}</span></td>
    <td>\${e.predicate}</td>
    <td>\${typeof e.confidence === "number" ? e.confidence.toFixed(2) : "-"}</td>
  </tr>\`).join("");
}

document.getElementById("load").addEventListener("click", load);
load();
</script>`;
  return shell.replace("</body>", `${script}</body>`);
}

export function renderTimelineViewHtml(): string {
  const shell = renderAppShell("Axion Timeline", "timeline-root");
  const script = `<script>
const root = document.getElementById("timeline-root");
root.innerHTML = \`
  <h1>Belief + Activity Timeline</h1>
  <div class="sub">Beliefs plus major ingest/research markers with recency and confidence cues.</div>
  <section class="panel">
    <div class="controls">
      <label>Topic<input id="topic" placeholder="rapamycin longevity" /></label>
      <label>Time From (ms)<input id="timeFrom" type="number" /></label>
      <label>Time To (ms)<input id="timeTo" type="number" /></label>
      <label>API Key (optional)<input id="apiKey" placeholder="for API_KEY mode" /></label>
      <button id="load">Load Timeline</button>
    </div>
  </section>
  <section class="panel">
    <div id="timeline"></div>
  </section>
\`;

function fmtTime(ts) { return typeof ts === "number" ? new Date(ts).toISOString() : "-"; }
function initialApiKey() {
  const key = new URLSearchParams(window.location.search).get("api_key");
  return key || localStorage.getItem("axion_api_key") || "";
}
function authHeaders() {
  const token = document.getElementById("apiKey").value.trim();
  if (!token) return {};
  localStorage.setItem("axion_api_key", token);
  return { Authorization: "Bearer " + token };
}
document.getElementById("apiKey").value = initialApiKey();

async function load() {
  const params = new URLSearchParams();
  const topic = document.getElementById("topic").value.trim();
  const timeFrom = document.getElementById("timeFrom").value.trim();
  const timeTo = document.getElementById("timeTo").value.trim();
  if (topic) params.set("topic", topic);
  if (timeFrom) params.set("time_from", timeFrom);
  if (timeTo) params.set("time_to", timeTo);
  const res = await fetch("/timeline/events?" + params.toString(), { headers: authHeaders() });
  if (!res.ok) {
    document.getElementById("timeline").innerHTML = '<div class="muted">request failed: ' + res.status + '</div>';
    return;
  }
  const data = await res.json();
  const out = document.getElementById("timeline");
  out.innerHTML = data.events.map((ev) => \`<article class="timeline-item \${ev.kind}">
    <div><strong>\${ev.title}</strong></div>
    <div class="muted">\${ev.event_type} · \${fmtTime(ev.occurred_at)}</div>
    <div class="muted">\${ev.topic ? "topic: " + ev.topic : ""} \${typeof ev.confidence === "number" ? " · confidence: " + ev.confidence.toFixed(2) : ""}</div>
  </article>\`).join("");
}

document.getElementById("load").addEventListener("click", load);
load();
</script>`;
  return shell.replace("</body>", `${script}</body>`);
}

export function renderReplayViewHtml(runId: string): string {
  const shell = renderAppShell("Axion Research Replay", "replay-root");
  const safeRunId = runId.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const script = `<script>
const runId = ${JSON.stringify(safeRunId)};
const root = document.getElementById("replay-root");
root.innerHTML = \`
  <h1>Research Replay</h1>
  <div class="sub">Read-only narrative stitched from run steps, episodic events, and artifacts.</div>
  <section class="panel">
    <div class="controls">
      <label>Run ID<input id="runId" value="\${runId}" /></label>
      <label>API Key (optional)<input id="apiKey" placeholder="for API_KEY mode" /></label>
      <button id="load">Load Replay</button>
    </div>
  </section>
  <section class="panel">
    <div id="summary" class="status"></div>
    <div id="story"></div>
  </section>
\`;

function fmtTime(ts) { return typeof ts === "number" ? new Date(ts).toISOString() : "-"; }
function initialApiKey() {
  const key = new URLSearchParams(window.location.search).get("api_key");
  return key || localStorage.getItem("axion_api_key") || "";
}
function authHeaders() {
  const token = document.getElementById("apiKey").value.trim();
  if (!token) return {};
  localStorage.setItem("axion_api_key", token);
  return { Authorization: "Bearer " + token };
}
document.getElementById("apiKey").value = initialApiKey();

function sentence(item) {
  if (item.type === "step") return item.at + " · step: " + item.title + " (" + item.kind + ")";
  if (item.type === "event") return item.at + " · event: " + item.event_type;
  return item.at + " · artifact: " + item.kind + (item.title ? " · " + item.title : "");
}

async function load() {
  const activeRunId = document.getElementById("runId").value.trim();
  if (!activeRunId) return;
  const res = await fetch("/runs/" + encodeURIComponent(activeRunId) + "/replay", { headers: authHeaders() });
  if (!res.ok) {
    document.getElementById("story").innerHTML =
      "<div class='muted'>Run not found or unauthorized (" + res.status + ").</div>";
    return;
  }
  const data = await res.json();
  const summary = document.getElementById("summary");
  summary.innerHTML = [
    '<span class="chip">run: ' + data.run.id + '</span>',
    '<span class="chip">status: ' + data.run.status + '</span>',
    '<span class="chip">steps: ' + data.steps.length + '</span>',
    '<span class="chip">artifacts: ' + data.artifacts.length + '</span>'
  ].join("");

  const stream = [
    ...data.steps.map((step) => ({ type: "step", at: fmtTime(step.created_at), kind: step.kind, title: step.title })),
    ...data.events.map((event) => ({ type: "event", at: fmtTime(event.created_at), event_type: event.event_type })),
    ...data.artifacts.map((artifact) => ({ type: "artifact", at: fmtTime(artifact.retrieved_at), kind: artifact.kind, title: artifact.title }))
  ].sort((a, b) => a.at.localeCompare(b.at));

  document.getElementById("story").innerHTML = stream.map((item) => '<article class="timeline-item"><div>' + sentence(item) + '</div></article>').join("");
}

document.getElementById("load").addEventListener("click", load);
load();
</script>`;
  return shell.replace("</body>", `${script}</body>`);
}
