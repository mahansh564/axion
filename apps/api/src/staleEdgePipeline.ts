import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  beliefRecords,
  episodicEvents,
  graphEdges,
  graphNodes,
  observerNotes,
  researchArtifacts,
} from "./db/schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_DAYS = 90;

function now(): number {
  return Date.now();
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

type StaleEdgeCandidateType =
  | "expired_belief"
  | "research_contradiction"
  | "stale_edge"
  | "unsuperseded_expired";

type StaleEdgeCandidate = {
  id: string;
  candidate_type: StaleEdgeCandidateType;
  topic: string | null;
  summary: string;
  confidence: number;
  severity: "low" | "medium" | "high";
  detected_at: number;
  evidence: Record<string, unknown>;
};

function buildCandidateId(
  type: StaleEdgeCandidateType,
  primaryId: string,
  secondaryId?: string,
): string {
  return secondaryId ? `${type}:${primaryId}:${secondaryId}` : `${type}:${primaryId}`;
}

function parseCandidateRef(candidateId: string): {
  type: StaleEdgeCandidateType;
  primaryId: string;
  secondaryId: string | null;
} {
  const parts = candidateId.split(":");
  if (parts.length < 2) throw new Error("invalid candidate_id");

  const type = parts[0] as StaleEdgeCandidateType;
  const primaryId = parts[1];
  const secondaryId = parts[2] ?? null;

  if (
    !["expired_belief", "research_contradiction", "stale_edge", "unsuperseded_expired"].includes(
      type,
    )
  ) {
    throw new Error("invalid candidate_type");
  }

  return { type, primaryId, secondaryId };
}

async function findExpiredBeliefs(
  cutoffMs: number,
  topicFilter?: string,
): Promise<StaleEdgeCandidate[]> {
  const clauses = [
    isNotNull(beliefRecords.validTo),
    lte(beliefRecords.validTo, now()),
  ];
  if (topicFilter) clauses.push(eq(beliefRecords.topic, topicFilter));

  const rows = await db
    .select({
      id: beliefRecords.id,
      topic: beliefRecords.topic,
      statement: beliefRecords.statement,
      confidence: beliefRecords.confidence,
      validTo: beliefRecords.validTo,
      validFrom: beliefRecords.validFrom,
      supersedesBeliefId: beliefRecords.supersedesBeliefId,
    })
    .from(beliefRecords)
    .where(and(...clauses))
    .orderBy(desc(beliefRecords.validTo))
    .all();

  return rows.map((row) => ({
    id: buildCandidateId("expired_belief", row.id),
    candidate_type: "expired_belief" as const,
    topic: row.topic,
    summary: `Expired belief: "${row.statement}"`,
    confidence: row.confidence,
    severity: row.confidence > 0.7 ? ("high" as const) : ("medium" as const),
    detected_at: now(),
    evidence: {
      belief_id: row.id,
      statement: row.statement,
      valid_from: row.validFrom,
      valid_to: row.validTo,
      supersedes_belief_id: row.supersedesBeliefId,
      days_expired: Math.floor((now() - (row.validTo ?? now())) / DAY_MS),
    },
  }));
}

async function findUnsupersededExpiredBeliefs(
  cutoffMs: number,
  topicFilter?: string,
): Promise<StaleEdgeCandidate[]> {
  const clauses = [
    isNotNull(beliefRecords.validTo),
    lte(beliefRecords.validTo, cutoffMs),
    isNull(beliefRecords.supersedesBeliefId),
  ];
  if (topicFilter) clauses.push(eq(beliefRecords.topic, topicFilter));

  const rows = await db
    .select({
      id: beliefRecords.id,
      topic: beliefRecords.topic,
      statement: beliefRecords.statement,
      confidence: beliefRecords.confidence,
      validTo: beliefRecords.validTo,
      validFrom: beliefRecords.validFrom,
    })
    .from(beliefRecords)
    .where(and(...clauses))
    .orderBy(desc(beliefRecords.validTo))
    .all();

  return rows.map((row) => ({
    id: buildCandidateId("unsuperseded_expired", row.id),
    candidate_type: "unsuperseded_expired" as const,
    topic: row.topic,
    summary: `Expired belief without successor: "${row.statement}"`,
    confidence: row.confidence,
    severity: "high" as const,
    detected_at: now(),
    evidence: {
      belief_id: row.id,
      statement: row.statement,
      valid_from: row.validFrom,
      valid_to: row.validTo,
      days_expired: Math.floor((now() - (row.validTo ?? now())) / DAY_MS),
      needs_attention: true,
    },
  }));
}

const NEGATION_RE = /\b(no|not|never|none|without|can't|cannot|doesn't|does not|isn't|is not|insufficient|ineffective|unsafe|harmful|risk|risks|uncertain|disagree|conflict|contradict)\b/i;

function tokenize(statement: string): Set<string> {
  return new Set(
    statement
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  const union = a.size + b.size - overlap;
  return union === 0 ? 0 : overlap / union;
}

async function findResearchContradictions(
  minConfidence: number,
  topicFilter?: string,
): Promise<StaleEdgeCandidate[]> {
  // Get active beliefs
  const beliefClauses = [isNull(beliefRecords.validTo)];
  if (topicFilter) beliefClauses.push(eq(beliefRecords.topic, topicFilter));
  if (minConfidence > 0) beliefClauses.push(gte(beliefRecords.confidence, minConfidence));

  const [beliefs, artifacts] = await Promise.all([
    db
      .select({
        id: beliefRecords.id,
        topic: beliefRecords.topic,
        statement: beliefRecords.statement,
        confidence: beliefRecords.confidence,
        validFrom: beliefRecords.validFrom,
      })
      .from(beliefRecords)
      .where(and(...beliefClauses))
      .all(),
    db
      .select({
        id: researchArtifacts.id,
        url: researchArtifacts.url,
        title: researchArtifacts.title,
        content: researchArtifacts.content,
        retrievedAt: researchArtifacts.retrievedAt,
      })
      .from(researchArtifacts)
      .where(eq(researchArtifacts.kind, "claim"))
      .orderBy(desc(researchArtifacts.retrievedAt))
      .limit(200)
      .all(),
  ]);

  const candidates: StaleEdgeCandidate[] = [];

  for (const belief of beliefs) {
    const beliefTokens = tokenize(belief.statement);
    const beliefNegated = NEGATION_RE.test(belief.statement);

    for (const artifact of artifacts) {
      const artifactTokens = tokenize(artifact.content);
      const artifactNegated = NEGATION_RE.test(artifact.content);

      // Must have one negated and one not
      if (beliefNegated === artifactNegated) continue;

      const similarity = jaccardSimilarity(beliefTokens, artifactTokens);
      if (similarity < 0.25) continue;

      const confidence = clamp((belief.confidence + 0.5) * (0.6 + similarity / 2), 0, 1);

      candidates.push({
        id: buildCandidateId("research_contradiction", belief.id, artifact.id),
        candidate_type: "research_contradiction" as const,
        topic: belief.topic,
        summary: `Research claim may contradict belief: "${artifact.content}" vs "${belief.statement}"`,
        confidence,
        severity: confidence > 0.7 ? ("high" as const) : ("medium" as const),
        detected_at: now(),
        evidence: {
          belief_id: belief.id,
          belief_statement: belief.statement,
          belief_confidence: belief.confidence,
          artifact_id: artifact.id,
          artifact_url: artifact.url,
          artifact_title: artifact.title,
          artifact_content: artifact.content,
          artifact_retrieved_at: artifact.retrievedAt,
          lexical_overlap: Number(similarity.toFixed(3)),
          days_since_retrieval: Math.floor((now() - artifact.retrievedAt) / DAY_MS),
        },
      });
    }
  }

  // Deduplicate by belief_id and keep highest confidence
  const byBelief = new Map<string, StaleEdgeCandidate>();
  for (const candidate of candidates) {
    const beliefId = candidate.evidence.belief_id as string;
    const existing = byBelief.get(beliefId);
    if (!existing || candidate.confidence > existing.confidence) {
      byBelief.set(beliefId, candidate);
    }
  }

  return Array.from(byBelief.values()).sort((a, b) => b.confidence - a.confidence);
}

async function findStaleGraphEdges(staleThresholdMs: number): Promise<StaleEdgeCandidate[]> {
  const staleCutoff = now() - staleThresholdMs;

  // Find edges that haven't been refreshed and connect to current beliefs
  const edgeRows = await db
    .select({
      edgeId: graphEdges.id,
      srcId: graphEdges.srcId,
      dstId: graphEdges.dstId,
      predicate: graphEdges.predicate,
      confidence: graphEdges.confidence,
      validFrom: graphEdges.validFrom,
      nodeId: graphNodes.id,
      nodeLabel: graphNodes.label,
      nodeKind: graphNodes.kind,
      documentId: graphNodes.documentId,
    })
    .from(graphEdges)
    .innerJoin(graphNodes, or(eq(graphEdges.srcId, graphNodes.id), eq(graphEdges.dstId, graphNodes.id)))
    .where(
      and(
        isNull(graphEdges.validTo),
        lte(graphEdges.validFrom, staleCutoff),
        isNotNull(graphEdges.confidence),
      ),
    )
    .orderBy(desc(graphEdges.validFrom))
    .limit(100)
    .all();

  // Group by edge
  const edgeMap = new Map<
    string,
    {
      edge: {
        id: string;
        srcId: string;
        dstId: string;
        predicate: string;
        confidence: number | null;
        validFrom: number;
      };
      nodes: Array<{ id: string; label: string; kind: string }>;
    }
  >();

  for (const row of edgeRows) {
    const existing = edgeMap.get(row.edgeId);
    if (existing) {
      existing.nodes.push({ id: row.nodeId, label: row.nodeLabel, kind: row.nodeKind });
    } else {
      edgeMap.set(row.edgeId, {
        edge: {
          id: row.edgeId,
          srcId: row.srcId,
          dstId: row.dstId,
          predicate: row.predicate,
          confidence: row.confidence,
          validFrom: row.validFrom,
        },
        nodes: [{ id: row.nodeId, label: row.nodeLabel, kind: row.nodeKind }],
      });
    }
  }

  const candidates: StaleEdgeCandidate[] = [];

  for (const { edge, nodes } of edgeMap.values()) {
    if (nodes.length < 2) continue;

    const srcNode = nodes.find((n) => n.id === edge.srcId);
    const dstNode = nodes.find((n) => n.id === edge.dstId);
    if (!srcNode || !dstNode) continue;

    const ageDays = Math.floor((now() - edge.validFrom) / DAY_MS);
    const confidence = edge.confidence ?? 0.5;

    // Higher severity for high-confidence edges that are stale
    const severity = confidence > 0.7 && ageDays > 180 ? ("high" as const) : ("medium" as const);

    candidates.push({
      id: buildCandidateId("stale_edge", edge.id),
      candidate_type: "stale_edge" as const,
      topic: null, // Could derive from nodes
      summary: `Stale edge: "${srcNode.label}" ${edge.predicate} "${dstNode.label}"`,
      confidence,
      severity,
      detected_at: now(),
      evidence: {
        edge_id: edge.id,
        src_id: edge.srcId,
        dst_id: edge.dstId,
        src_label: srcNode.label,
        dst_label: dstNode.label,
        predicate: edge.predicate,
        edge_confidence: edge.confidence,
        valid_from: edge.validFrom,
        days_since_refresh: ageDays,
        node_kinds: nodes.map((n) => n.kind),
      },
    });
  }

  return candidates;
}

export async function listStaleEdgeCandidates(input?: {
  topic?: string;
  minConfidence?: number;
  staleDays?: number;
  limit?: number;
  includeTypes?: StaleEdgeCandidateType[];
}): Promise<{
  generated_at: number;
  stale_candidates: StaleEdgeCandidate[];
}> {
  const generatedAt = now();
  const topic = input?.topic?.trim().toLowerCase();
  const minConfidence = clamp(input?.minConfidence ?? 0.3, 0, 1);
  const staleDays = clamp(input?.staleDays ?? DEFAULT_STALE_DAYS, 7, 730);
  const limit = clamp(input?.limit ?? 25, 1, 100);
  const includeTypes = new Set(input?.includeTypes ?? ["expired_belief", "research_contradiction", "stale_edge", "unsuperseded_expired"]);

  const staleThresholdMs = staleDays * DAY_MS;
  const expirationCutoff = now() - staleThresholdMs;

  const promises: Promise<StaleEdgeCandidate[]>[] = [];

  if (includeTypes.has("expired_belief")) {
    promises.push(findExpiredBeliefs(expirationCutoff, topic));
  }
  if (includeTypes.has("unsuperseded_expired")) {
    promises.push(findUnsupersededExpiredBeliefs(expirationCutoff, topic));
  }
  if (includeTypes.has("research_contradiction")) {
    promises.push(findResearchContradictions(minConfidence, topic));
  }
  if (includeTypes.has("stale_edge")) {
    promises.push(findStaleGraphEdges(staleThresholdMs));
  }

  const results = await Promise.all(promises);
  const allCandidates = results.flat();

  // Sort by severity then confidence
  const severityOrder = { high: 0, medium: 1, low: 2 };
  const sorted = allCandidates
    .filter((c) => c.confidence >= minConfidence)
    .sort((a, b) => {
      const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return b.confidence - a.confidence;
    })
    .slice(0, limit);

  return {
    generated_at: generatedAt,
    stale_candidates: sorted,
  };
}

export type RefreshDecision = "refresh_belief" | "archive_belief" | "schedule_research" | "ignore";

export async function resolveStaleEdge(input: {
  candidateId: string;
  decision: RefreshDecision;
  traceId: string;
  refreshStatement?: string;
  refreshConfidence?: number;
  rationale?: string;
}): Promise<{
  resolution_id: string;
  candidate_id: string;
  decision: RefreshDecision;
  created_at: number;
  actions_taken: string[];
}> {
  const decision = input.decision;
  if (!["refresh_belief", "archive_belief", "schedule_research", "ignore"].includes(decision)) {
    throw new Error("invalid decision");
  }

  const ref = parseCandidateRef(input.candidateId);
  const candidateNow = now();
  const resolutionId = randomUUID();
  const actionsTaken: string[] = [];

  await db.transaction((tx) => {
    // Record resolution event
    tx.insert(episodicEvents).values({
      id: randomUUID(),
      eventType: "stale_edge_resolved",
      traceId: input.traceId,
      payload: JSON.stringify({
        resolution_id: resolutionId,
        candidate_id: input.candidateId,
        candidate_type: ref.type,
        decision,
        rationale: input.rationale ?? null,
        primary_id: ref.primaryId,
        secondary_id: ref.secondaryId,
      }),
      createdAt: candidateNow,
    }).run();

    if (decision === "refresh_belief" && ref.type === "expired_belief") {
      // Mark old belief as superseded if statement changes
      const oldBelief = tx
        .select({
          id: beliefRecords.id,
          topic: beliefRecords.topic,
          statement: beliefRecords.statement,
          confidence: beliefRecords.confidence,
          validTo: beliefRecords.validTo,
        })
        .from(beliefRecords)
        .where(eq(beliefRecords.id, ref.primaryId))
        .get();

      if (oldBelief && input.refreshStatement && input.refreshStatement !== oldBelief.statement) {
        const newConfidence = input.refreshConfidence ?? oldBelief.confidence;
        const newBeliefId = randomUUID();

        tx.insert(beliefRecords).values({
          id: newBeliefId,
          statement: input.refreshStatement.trim(),
          topic: oldBelief.topic,
          confidence: clamp(newConfidence, 0, 1),
          sourceKind: "stale_refresh",
          sourceNoteId: null,
          sourceDocumentId: null,
          supersedesBeliefId: oldBelief.id,
          validFrom: candidateNow,
          validTo: null,
          metadata: JSON.stringify({
            resolution_id: resolutionId,
            refresh_reason: "stale_edge_resolution",
          }),
          createdAt: candidateNow,
        }).run();

        actionsTaken.push(`created_refreshed_belief:${newBeliefId}`);
      }
    }

    if (decision === "archive_belief" && (ref.type === "expired_belief" || ref.type === "unsuperseded_expired")) {
      // Ensure belief stays expired
      tx.update(beliefRecords)
        .set({
          validTo: candidateNow,
          metadata: JSON.stringify({
            archived_at: candidateNow,
            resolution_id: resolutionId,
            archive_reason: "stale_edge_archive",
          }),
        })
        .where(eq(beliefRecords.id, ref.primaryId))
        .run();

      actionsTaken.push("archived_expired_belief");
    }

    if (decision === "schedule_research" && ref.type === "research_contradiction") {
      // Create an observer note as a candidate task for research
      const artifactId = ref.secondaryId ?? undefined;
      tx.insert(observerNotes).values({
        id: randomUUID(),
        runId: "system", // System-generated
        stepId: null,
        artifactId: artifactId ?? null,
        kind: "candidate_task",
        status: "pending",
        summary: `Research refresh needed due to potential contradiction with artifact ${artifactId}`,
        confidence: 0.6,
        payload: JSON.stringify({
          resolution_id: resolutionId,
          stale_candidate_id: input.candidateId,
          trigger: "stale_edge_resolution",
          related_belief_id: ref.primaryId,
        }),
        createdAt: candidateNow,
      }).run();

      actionsTaken.push("created_research_task");
    }
  });

  return {
    resolution_id: resolutionId,
    candidate_id: input.candidateId,
    decision,
    created_at: candidateNow,
    actions_taken: actionsTaken,
  };
}

export async function autoDetectAndFlagStaleItems(input: {
  traceId: string;
  staleDays?: number;
  autoScheduleResearch?: boolean;
}): Promise<{
  checked_at: number;
  candidates_found: number;
  high_severity_count: number;
  actions_taken: string[];
}> {
  const checkedAt = now();
  const staleDays = clamp(input?.staleDays ?? DEFAULT_STALE_DAYS, 7, 365);
  const autoSchedule = input?.autoScheduleResearch ?? false;

  const { stale_candidates } = await listStaleEdgeCandidates({
    staleDays,
    includeTypes: ["research_contradiction", "unsuperseded_expired"],
  });

  const highSeverity = stale_candidates.filter((c) => c.severity === "high");
  const actionsTaken: string[] = [];

  // Auto-create observer notes for high-severity items
  for (const candidate of highSeverity) {
    await db.insert(episodicEvents).values({
      id: randomUUID(),
      eventType: "stale_edge_auto_flagged",
      traceId: input.traceId,
      payload: JSON.stringify({
        candidate_id: candidate.id,
        candidate_type: candidate.candidate_type,
        severity: candidate.severity,
        confidence: candidate.confidence,
        topic: candidate.topic,
      }),
      createdAt: checkedAt,
    });

    actionsTaken.push(`flagged:${candidate.id}`);

    if (autoSchedule && candidate.candidate_type === "research_contradiction") {
      await resolveStaleEdge({
        candidateId: candidate.id,
        decision: "schedule_research",
        traceId: input.traceId,
        rationale: "Auto-scheduled due to high-severity research contradiction",
      });
      actionsTaken.push(`auto_scheduled:${candidate.id}`);
    }
  }

  return {
    checked_at: checkedAt,
    candidates_found: stale_candidates.length,
    high_severity_count: highSeverity.length,
    actions_taken: actionsTaken,
  };
}
