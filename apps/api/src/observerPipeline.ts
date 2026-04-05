import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  executionRuns,
  executionSteps,
  observerNotes,
  promotionReviews,
  researchArtifacts,
} from "./db/schema.js";

function now(): number {
  return Date.now();
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

const UNCERTAINTY_RE = /\b(uncertain|uncertainty|preliminary|limited|observational|risk|caveat|unclear)\b/i;
const CONTRADICTION_RE = /\b(disagree|conflict|contradict)\b/i;

type ObserverKind =
  | "observer_note"
  | "candidate_task"
  | "candidate_belief"
  | "uncertainty_flag"
  | "contradiction_flag"
  | "coverage_gap"
  | "novelty_signal";

async function insertObserverNote(input: {
  runId: string;
  stepId?: string | null;
  artifactId?: string | null;
  kind: ObserverKind;
  summary: string;
  confidence?: number | null;
  payload?: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(observerNotes).values({
    id,
    runId: input.runId,
    stepId: input.stepId ?? null,
    artifactId: input.artifactId ?? null,
    kind: input.kind,
    status: "pending",
    summary: input.summary,
    confidence: input.confidence ?? null,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    createdAt: now(),
  });
  return id;
}

export async function emitObserverNotes(runId: string): Promise<number> {
  const run = await db.select().from(executionRuns).where(eq(executionRuns.id, runId)).get();
  if (!run) {
    throw new Error("run not found");
  }

  const steps = await db
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.runId, runId))
    .orderBy(asc(executionSteps.createdAt))
    .all();
  const artifacts = await db
    .select()
    .from(researchArtifacts)
    .where(eq(researchArtifacts.runId, runId))
    .orderBy(asc(researchArtifacts.retrievedAt))
    .all();

  const created: string[] = [];
  const claimArtifacts = artifacts.filter((artifact) => artifact.kind === "claim");
  const excerptArtifacts = artifacts.filter((artifact) => artifact.kind === "excerpt");
  const searchArtifacts = artifacts.filter((artifact) => artifact.kind === "search_result");
  const sourceCount = new Set(artifacts.map((artifact) => artifact.url).filter(Boolean)).size;

  created.push(
    await insertObserverNote({
      runId,
      kind: "observer_note",
      summary: `Research run captured ${claimArtifacts.length} claims across ${sourceCount} sources.`,
      confidence: 0.65,
      payload: {
        step_count: steps.length,
        artifact_count: artifacts.length,
        status: run.status,
      },
    }),
  );

  for (const artifact of claimArtifacts.slice(0, 2)) {
    created.push(
      await insertObserverNote({
        runId,
        stepId: artifact.stepId,
        artifactId: artifact.id,
        kind: "candidate_belief",
        summary: artifact.content,
        confidence: 0.45,
        payload: {
          url: artifact.url,
          title: artifact.title,
        },
      }),
    );
  }

  const uncertainArtifact = [...claimArtifacts, ...excerptArtifacts].find((artifact) =>
    UNCERTAINTY_RE.test(artifact.content),
  );
  if (uncertainArtifact) {
    created.push(
      await insertObserverNote({
        runId,
        stepId: uncertainArtifact.stepId,
        artifactId: uncertainArtifact.id,
        kind: "uncertainty_flag",
        summary: `Source language indicates uncertainty: ${uncertainArtifact.content}`,
        confidence: 0.7,
        payload: {
          url: uncertainArtifact.url,
        },
      }),
    );
  }

  const contradictionArtifact = [...claimArtifacts, ...excerptArtifacts].find((artifact) =>
    CONTRADICTION_RE.test(artifact.content),
  );
  if (contradictionArtifact) {
    created.push(
      await insertObserverNote({
        runId,
        stepId: contradictionArtifact.stepId,
        artifactId: contradictionArtifact.id,
        kind: "contradiction_flag",
        summary: `Potential disagreement detected: ${contradictionArtifact.content}`,
        confidence: 0.6,
        payload: {
          url: contradictionArtifact.url,
        },
      }),
    );
  }

  const sparseSearchStep = steps.find((step) => {
    if (step.kind !== "search" && step.kind !== "fetch") return false;
    const output = parseJsonObject(step.output);
    const resultCount = typeof output?.result_count === "number" ? output.result_count : null;
    const excerptCount = typeof output?.excerpt_count === "number" ? output.excerpt_count : null;
    return resultCount === 0 || excerptCount === 0;
  });
  if (sparseSearchStep) {
    created.push(
      await insertObserverNote({
        runId,
        stepId: sparseSearchStep.id,
        kind: "coverage_gap",
        summary: `At least one research step returned limited coverage: ${sparseSearchStep.title}`,
        confidence: 0.55,
      }),
    );
  }

  if (searchArtifacts.length > 0) {
    created.push(
      await insertObserverNote({
        runId,
        artifactId: searchArtifacts[0].id,
        kind: "novelty_signal",
        summary: `Research run added ${sourceCount} external sources not present in experience ingestion.`,
        confidence: 0.5,
      }),
    );
  }

  if (uncertainArtifact || sparseSearchStep) {
    created.push(
      await insertObserverNote({
        runId,
        kind: "candidate_task",
        summary: "Follow up with higher-quality primary sources or a PDF/manual review before promotion.",
        confidence: 0.5,
        payload: {
          rationale: uncertainArtifact ? "uncertainty_detected" : "coverage_gap",
        },
      }),
    );
  }

  return created.length;
}

export async function getObserverNotesForRun(runId: string): Promise<
  Array<{
    id: string;
    run_id: string;
    step_id: string | null;
    artifact_id: string | null;
    kind: string;
    status: string;
    summary: string;
    confidence: number | null;
    payload: Record<string, unknown> | null;
    created_at: number;
    promotion_reviews: Array<{
      id: string;
      decision: string;
      rationale: string | null;
      reviewer: string;
      created_at: number;
    }>;
  }>
> {
  const notes = await db
    .select()
    .from(observerNotes)
    .where(eq(observerNotes.runId, runId))
    .orderBy(asc(observerNotes.createdAt))
    .all();

  const reviews = await db.select().from(promotionReviews).orderBy(asc(promotionReviews.createdAt)).all();

  return notes.map((note) => ({
    id: note.id,
    run_id: note.runId,
    step_id: note.stepId,
    artifact_id: note.artifactId,
    kind: note.kind,
    status: note.status,
    summary: note.summary,
    confidence: note.confidence,
    payload: parseJsonObject(note.payload),
    created_at: note.createdAt,
    promotion_reviews: reviews
      .filter((review) => review.noteId === note.id)
      .map((review) => ({
        id: review.id,
        decision: review.decision,
        rationale: review.rationale,
        reviewer: review.reviewer,
        created_at: review.createdAt,
      })),
  }));
}

export async function reviewPromotion(input: {
  noteId: string;
  approved?: boolean;
  rationale?: string;
}): Promise<{
  note_id: string;
  decision: "approved" | "rejected";
  review_id: string;
  status: string;
}> {
  const note = await db.select().from(observerNotes).where(eq(observerNotes.id, input.noteId)).get();
  if (!note) {
    throw new Error("note not found");
  }

  const decision = input.approved === false ? "rejected" : "approved";
  const reviewId = randomUUID();
  const createdAt = now();

  await db.insert(promotionReviews).values({
    id: reviewId,
    noteId: input.noteId,
    decision,
    rationale: input.rationale?.trim() ? input.rationale.trim() : null,
    reviewer: "user",
    createdAt,
  });
  await db
    .update(observerNotes)
    .set({ status: decision })
    .where(eq(observerNotes.id, input.noteId));

  return {
    note_id: input.noteId,
    decision,
    review_id: reviewId,
    status: decision,
  };
}
