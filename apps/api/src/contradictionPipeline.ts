import { and, eq, gte, inArray, isNull } from "drizzle-orm";

import { db } from "./db/client.js";
import { beliefRecords, observerNotes, researchArtifacts } from "./db/schema.js";

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

const NEGATION_RE = /\b(no|not|never|none|without|can't|cannot|doesn't|does not|isn't|is not|insufficient|ineffective|unsafe|harmful|risk|risks|uncertain)\b/i;

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
