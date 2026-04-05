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

