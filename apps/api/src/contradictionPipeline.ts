import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  beliefRecords,
  contradictionResolutions,
  episodicEvents,
  observerNotes,
  researchArtifacts,
} from "./db/schema.js";

type ContradictionCandidate = {
  id: string;
  candidate_type: "belief_conflict" | "observer_flag";
  topic: string | null;
  summary: string;
  confidence: number;
  status: string;
  detected_at: number;
  evidence: Record<string, unknown>;
};

type ContradictionCandidateRef =
  | {
      candidateType: "belief_conflict";
      candidateId: string;
      beliefIds: [string, string];
      observerNoteId: null;
    }
  | {
      candidateType: "observer_flag";
      candidateId: string;
      beliefIds: null;
      observerNoteId: string;
    };

type ContradictionDecision = "invalidate_belief" | "supersede_belief" | "keep_both";

const NEGATION_RE = /\b(no|not|never|none|without|can't|cannot|doesn't|does not|isn't|is not|insufficient|ineffective|unsafe|harmful|risk|risks|uncertain)\b/i;
const CANDIDATE_BELIEF_CONFLICT_PREFIX = "belief-conflict:";
const CANDIDATE_OBSERVER_FLAG_PREFIX = "observer-flag:";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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

function hasNegation(statement: string): boolean {
  return NEGATION_RE.test(statement);
}

function normalizeTopic(topic: string | undefined): string | undefined {
  const value = topic?.trim().toLowerCase();
  return value && value.length > 0 ? value : undefined;
}

function now(): number {
  return Date.now();
}

function parseCandidateRef(candidateId: string): ContradictionCandidateRef {
  const value = candidateId.trim();
  if (value.startsWith(CANDIDATE_BELIEF_CONFLICT_PREFIX)) {
    const idsRaw = value.slice(CANDIDATE_BELIEF_CONFLICT_PREFIX.length);
    const ids = idsRaw.split(":").filter(Boolean);
    if (ids.length !== 2) throw new Error("invalid candidate_id");
    const [left, right] = ids.sort();
    return {
      candidateType: "belief_conflict",
      candidateId: `${CANDIDATE_BELIEF_CONFLICT_PREFIX}${left}:${right}`,
      beliefIds: [left, right],
      observerNoteId: null,
    };
  }
  if (value.startsWith(CANDIDATE_OBSERVER_FLAG_PREFIX)) {
    const noteId = value.slice(CANDIDATE_OBSERVER_FLAG_PREFIX.length).trim();
    if (!noteId) throw new Error("invalid candidate_id");
    return {
      candidateType: "observer_flag",
      candidateId: `${CANDIDATE_OBSERVER_FLAG_PREFIX}${noteId}`,
      beliefIds: null,
      observerNoteId: noteId,
    };
  }
  throw new Error("invalid candidate_id");
}

function buildBeliefConflictCandidates(
  beliefs: Array<{
    id: string;
    topic: string;
    statement: string;
    confidence: number;
    validFrom: number;
    createdAt: number;
  }>,
): ContradictionCandidate[] {
  const byTopic = new Map<string, typeof beliefs>();
  for (const belief of beliefs) {
    const entries = byTopic.get(belief.topic) ?? [];
    entries.push(belief);
    byTopic.set(belief.topic, entries);
  }

  const out: ContradictionCandidate[] = [];
  for (const [topic, rows] of byTopic.entries()) {
    for (let i = 0; i < rows.length; i += 1) {
      const a = rows[i];
      const aNegated = hasNegation(a.statement);
      const tokensA = tokenize(a.statement);
      for (let j = i + 1; j < rows.length; j += 1) {
        const b = rows[j];
        const bNegated = hasNegation(b.statement);
        if (aNegated === bNegated) continue;

        const tokensB = tokenize(b.statement);
        const similarity = jaccardSimilarity(tokensA, tokensB);
        if (similarity < 0.35) continue;

        const [left, right] = [a.id, b.id].sort();
        const confidence = clamp(((a.confidence + b.confidence) / 2) * (0.7 + similarity / 2), 0, 1);
        out.push({
          id: `belief-conflict:${left}:${right}`,
          candidate_type: "belief_conflict",
          topic,
          summary: `Potential contradiction in topic "${topic}": "${a.statement}" vs "${b.statement}"`,
          confidence,
          status: "pending",
          detected_at: Math.max(a.createdAt, b.createdAt, a.validFrom, b.validFrom),
          evidence: {
            belief_ids: [a.id, b.id],
            statements: [a.statement, b.statement],
            lexical_overlap: Number(similarity.toFixed(3)),
          },
        });
      }
    }
  }
  return out;
}

export async function listContradictionCandidates(input: {
  topic?: string;
  confidenceMin?: number;
  limit?: number;
}): Promise<{ contradiction_candidates: ContradictionCandidate[] }> {
  const topic = normalizeTopic(input.topic);
  const confidenceMin = clamp(input.confidenceMin ?? 0, 0, 1);
  const limit = clamp(Math.trunc(input.limit ?? 25), 1, 100);

  const beliefClauses = [isNull(beliefRecords.validTo)];
  if (topic) beliefClauses.push(eq(beliefRecords.topic, topic));
  if (confidenceMin > 0) beliefClauses.push(gte(beliefRecords.confidence, confidenceMin));

  const [beliefRows, noteRows] = await Promise.all([
    db
      .select({
        id: beliefRecords.id,
        topic: beliefRecords.topic,
        statement: beliefRecords.statement,
        confidence: beliefRecords.confidence,
        validFrom: beliefRecords.validFrom,
        createdAt: beliefRecords.createdAt,
      })
      .from(beliefRecords)
      .where(and(...beliefClauses))
      .all(),
    db
      .select({
        id: observerNotes.id,
        runId: observerNotes.runId,
        artifactId: observerNotes.artifactId,
        status: observerNotes.status,
        summary: observerNotes.summary,
        confidence: observerNotes.confidence,
        payload: observerNotes.payload,
        createdAt: observerNotes.createdAt,
      })
      .from(observerNotes)
      .where(eq(observerNotes.kind, "contradiction_flag"))
      .all(),
  ]);

  const artifactIds = Array.from(
    new Set(
      noteRows
        .map((note) => note.artifactId)
        .filter((artifactId): artifactId is string => typeof artifactId === "string" && artifactId.length > 0),
    ),
  );
  const artifactRows =
    artifactIds.length > 0
      ? await db
          .select({
            id: researchArtifacts.id,
            url: researchArtifacts.url,
            title: researchArtifacts.title,
          })
          .from(researchArtifacts)
          .where(inArray(researchArtifacts.id, artifactIds))
          .all()
      : [];
  const artifactMap = new Map(artifactRows.map((artifact) => [artifact.id, artifact]));

  const noteCandidates: ContradictionCandidate[] = [];
  for (const note of noteRows) {
    const payload = parseJsonObject(note.payload);
    const payloadTopic = typeof payload?.topic === "string" ? payload.topic.trim().toLowerCase() : null;
    if (topic) {
      const summaryMatches = note.summary.toLowerCase().includes(topic);
      if (!summaryMatches && payloadTopic !== topic) {
        continue;
      }
    }

    const candidateConfidence = note.confidence ?? 0.5;
    if (candidateConfidence < confidenceMin) continue;

    const artifact = note.artifactId ? artifactMap.get(note.artifactId) : undefined;
    noteCandidates.push({
      id: `observer-flag:${note.id}`,
      candidate_type: "observer_flag",
      topic: payloadTopic,
      summary: note.summary,
      confidence: candidateConfidence,
      status: note.status,
      detected_at: note.createdAt,
      evidence: {
        note_id: note.id,
        run_id: note.runId,
        artifact_id: note.artifactId,
        artifact_url: artifact?.url ?? null,
        artifact_title: artifact?.title ?? null,
      },
    });
  }

  const beliefCandidates = buildBeliefConflictCandidates(
    beliefRows.filter((belief) => belief.confidence >= confidenceMin),
  ).filter((candidate) => candidate.confidence >= confidenceMin);

  const contradiction_candidates = [...beliefCandidates, ...noteCandidates]
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.detected_at - a.detected_at;
    })
    .slice(0, limit);

  return { contradiction_candidates };
}

export async function resolveContradiction(input: {
  candidateId: string;
  decision: ContradictionDecision;
  targetBeliefId?: string;
  statement?: string;
  topic?: string;
  confidence?: number;
  rationale?: string;
  metadata?: Record<string, unknown>;
  traceId: string;
}): Promise<{
  resolution_id: string;
  candidate_id: string;
  candidate_type: "belief_conflict" | "observer_flag";
  decision: ContradictionDecision;
  target_belief_id: string | null;
  resolution_belief_id: string | null;
  observer_note_id: string | null;
  created_at: number;
}> {
  const decision = input.decision;
  if (!["invalidate_belief", "supersede_belief", "keep_both"].includes(decision)) {
    throw new Error("invalid decision");
  }

  const ref = parseCandidateRef(input.candidateId);
  const candidateNow = now();
  const targetBeliefRequired = decision === "invalidate_belief" || decision === "supersede_belief";
  if (targetBeliefRequired && !input.targetBeliefId) {
    throw new Error("target_belief_id required");
  }
  if (decision === "supersede_belief" && !input.statement?.trim()) {
    throw new Error("statement required");
  }

  if (ref.candidateType === "belief_conflict" && input.targetBeliefId && !ref.beliefIds.includes(input.targetBeliefId)) {
    throw new Error("target belief must belong to belief conflict candidate");
  }

  const targetBeliefId = input.targetBeliefId ?? null;
  const confidence = clamp(input.confidence ?? 0.6, 0, 1);
  const topic = normalizeTopic(input.topic);
  const resolutionId = randomUUID();
  let resolutionBeliefId: string | null = null;
  let observerCandidateTopic: string | null = null;

  await db.transaction((tx) => {
    if (ref.candidateType === "belief_conflict") {
      const conflictBeliefs = tx
        .select({
          id: beliefRecords.id,
          topic: beliefRecords.topic,
          statement: beliefRecords.statement,
          confidence: beliefRecords.confidence,
          validTo: beliefRecords.validTo,
        })
        .from(beliefRecords)
        .where(inArray(beliefRecords.id, ref.beliefIds))
        .all();
      if (conflictBeliefs.length !== 2) {
        throw new Error("candidate beliefs not found");
      }
    } else {
      const note = tx
        .select({
          id: observerNotes.id,
          kind: observerNotes.kind,
          summary: observerNotes.summary,
          payload: observerNotes.payload,
        })
        .from(observerNotes)
        .where(eq(observerNotes.id, ref.observerNoteId))
        .get();
      if (!note || note.kind !== "contradiction_flag") {
        throw new Error("candidate observer note not found");
      }
      const payload = parseJsonObject(note.payload);
      observerCandidateTopic = typeof payload?.topic === "string" ? normalizeTopic(payload.topic) ?? null : null;
    }

    let targetBelief:
      | {
          id: string;
          topic: string;
          statement: string;
          confidence: number;
          validTo: number | null;
        }
      | undefined;

    if (targetBeliefId) {
      targetBelief = tx
        .select({
          id: beliefRecords.id,
          topic: beliefRecords.topic,
          statement: beliefRecords.statement,
          confidence: beliefRecords.confidence,
          validTo: beliefRecords.validTo,
        })
        .from(beliefRecords)
        .where(eq(beliefRecords.id, targetBeliefId))
        .get();
      if (!targetBelief) {
        throw new Error("target belief not found");
      }
      if (targetBelief.validTo !== null) {
        throw new Error("target belief already inactive");
      }
      if (ref.candidateType === "observer_flag") {
        const scopedTopic = observerCandidateTopic ?? topic;
        if (!scopedTopic) {
          throw new Error("topic required for observer_flag belief updates");
        }
        if (targetBelief.topic !== scopedTopic) {
          throw new Error("target belief topic does not match observer candidate topic");
        }
      }
    }

    if (decision === "invalidate_belief" || decision === "supersede_belief") {
      if (!targetBelief) {
        throw new Error("target belief not found");
      }
      tx
        .update(beliefRecords)
        .set({ validTo: candidateNow })
        .where(eq(beliefRecords.id, targetBelief.id))
        .run();
    }

    if (decision === "supersede_belief") {
      if (!targetBelief || !targetBeliefId) throw new Error("target belief not found");
      const nextBeliefId = randomUUID();
      tx.insert(beliefRecords).values({
        id: nextBeliefId,
        statement: input.statement!.trim(),
        topic: topic ?? targetBelief.topic,
        confidence,
        sourceKind: "contradiction_resolution",
        sourceNoteId: ref.observerNoteId,
        sourceDocumentId: null,
        supersedesBeliefId: targetBeliefId,
        validFrom: candidateNow,
        validTo: null,
        metadata: JSON.stringify({
          candidate_id: ref.candidateId,
          decision,
          rationale: input.rationale ?? null,
          ...(input.metadata ?? {}),
        }),
        createdAt: candidateNow,
      }).run();
      resolutionBeliefId = nextBeliefId;
    }

    tx.insert(contradictionResolutions).values({
      id: resolutionId,
      candidateId: ref.candidateId,
      candidateType: ref.candidateType,
      decision,
      targetBeliefId,
      resolutionBeliefId,
      observerNoteId: ref.observerNoteId,
      rationale: input.rationale?.trim() ? input.rationale.trim() : null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: candidateNow,
    }).run();

    tx.insert(episodicEvents).values({
      id: randomUUID(),
      eventType: "contradiction_resolved",
      traceId: input.traceId,
      payload: JSON.stringify({
        resolution_id: resolutionId,
        candidate_id: ref.candidateId,
        candidate_type: ref.candidateType,
        decision,
        target_belief_id: targetBeliefId,
        resolution_belief_id: resolutionBeliefId,
        observer_note_id: ref.observerNoteId,
      }),
      createdAt: candidateNow,
    }).run();
  });

  return {
    resolution_id: resolutionId,
    candidate_id: ref.candidateId,
    candidate_type: ref.candidateType,
    decision,
    target_belief_id: targetBeliefId,
    resolution_belief_id: resolutionBeliefId,
    observer_note_id: ref.observerNoteId,
    created_at: candidateNow,
  };
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function listContradictionResolutions(input?: {
  candidateId?: string;
  limit?: number;
}): Promise<{
  resolutions: Array<{
    id: string;
    candidate_id: string;
    candidate_type: string;
    decision: string;
    target_belief_id: string | null;
    resolution_belief_id: string | null;
    observer_note_id: string | null;
    rationale: string | null;
    metadata: Record<string, unknown> | null;
    created_at: number;
  }>;
}> {
  const limit = clamp(Math.trunc(input?.limit ?? 50), 1, 200);
  const query = db
    .select()
    .from(contradictionResolutions)
    .orderBy(desc(contradictionResolutions.createdAt))
    .limit(limit);
  const rows = input?.candidateId
    ? await query.where(eq(contradictionResolutions.candidateId, input.candidateId.trim())).all()
    : await query.all();

  return {
    resolutions: rows.map((row) => ({
      id: row.id,
      candidate_id: row.candidateId,
      candidate_type: row.candidateType,
      decision: row.decision,
      target_belief_id: row.targetBeliefId,
      resolution_belief_id: row.resolutionBeliefId,
      observer_note_id: row.observerNoteId,
      rationale: row.rationale,
      metadata: parseJson(row.metadata),
      created_at: row.createdAt,
    })),
  };
}
