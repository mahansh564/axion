import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  beliefEvidence,
  beliefRecords,
  documents,
  EXPERIENCE_TEXT_DOCUMENT_KINDS,
  executionRuns,
  observerNotes,
  openQuestions,
  promotionReviews,
  researchArtifacts,
} from "./db/schema.js";
import { questionKeywords } from "./search.js";

const OPEN_QUESTION_STATUSES = new Set(["open", "researching", "resolved"]);
const STANCE_RE = /\b(i think|i feel|i believe|seems|overhyped|underrated|prefer|love|hate)\b/i;

function now(): number {
  return Date.now();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

function deriveTopic(statement: string, payload: Record<string, unknown> | null): string {
  const payloadTopic = payload?.topic;
  if (typeof payloadTopic === "string" && payloadTopic.trim().length > 0) {
    return collapseWhitespace(payloadTopic).toLowerCase();
  }

  const payloadTitle = payload?.title;
  if (typeof payloadTitle === "string" && payloadTitle.trim().length > 0) {
    const titleTokens = questionKeywords(payloadTitle).slice(0, 4);
    if (titleTokens.length > 0) return titleTokens.join(" ");
  }

  const statementTokens = questionKeywords(statement).slice(0, 4);
  if (statementTokens.length > 0) return statementTokens.join(" ");
  return "general";
}

async function createBelief(input: {
  statement: string;
  topic: string;
  confidence: number;
  sourceKind: string;
  sourceNoteId?: string | null;
  sourceDocumentId?: string | null;
  metadata?: Record<string, unknown>;
  supersedeExisting?: boolean;
  evidence?: Array<{ evidenceType: string; refId?: string | null; excerpt?: string | null; metadata?: Record<string, unknown> }>;
}): Promise<{ id: string; supersedesBeliefId: string | null } | null> {
  try {
    return db.transaction((tx) => {
      const createdAt = now();
      if (input.sourceNoteId) {
        const existingByNote = tx
          .select({ id: beliefRecords.id })
          .from(beliefRecords)
          .where(eq(beliefRecords.sourceNoteId, input.sourceNoteId))
          .get();
        if (existingByNote) return null;
      }

      const duplicateCurrent = tx
        .select({ id: beliefRecords.id })
        .from(beliefRecords)
        .where(
          and(
            eq(beliefRecords.topic, input.topic),
            eq(beliefRecords.statement, input.statement),
            isNull(beliefRecords.validTo),
          ),
        )
        .get();
      if (duplicateCurrent) return null;

      let supersedesBeliefId: string | null = null;
      if (input.supersedeExisting !== false) {
        const currentBelief = tx
          .select({
            id: beliefRecords.id,
            statement: beliefRecords.statement,
          })
          .from(beliefRecords)
          .where(and(eq(beliefRecords.topic, input.topic), isNull(beliefRecords.validTo)))
          .orderBy(desc(beliefRecords.validFrom))
          .get();

        if (currentBelief && currentBelief.statement !== input.statement) {
          supersedesBeliefId = currentBelief.id;
          tx
            .update(beliefRecords)
            .set({ validTo: createdAt })
            .where(eq(beliefRecords.id, currentBelief.id))
            .run();
        }
      }

      const id = randomUUID();
      tx.insert(beliefRecords).values({
        id,
        statement: input.statement,
        topic: input.topic,
        confidence: input.confidence,
        sourceKind: input.sourceKind,
        sourceNoteId: input.sourceNoteId ?? null,
        sourceDocumentId: input.sourceDocumentId ?? null,
        supersedesBeliefId,
        validFrom: createdAt,
        validTo: null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      }).run();

      for (const ev of input.evidence ?? []) {
        tx.insert(beliefEvidence).values({
          id: randomUUID(),
          beliefId: id,
          evidenceType: ev.evidenceType,
          refId: ev.refId ?? null,
          excerpt: ev.excerpt ?? null,
          metadata: ev.metadata ? JSON.stringify(ev.metadata) : null,
          createdAt: now(),
        }).run();
      }

      return { id, supersedesBeliefId };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed: belief_records.source_note_id")) {
      return null;
    }
    throw error;
  }
}

export async function runSynthesis(input?: {
  confirmRequired?: boolean;
  confidenceThreshold?: number;
  maxCandidates?: number;
}): Promise<{
  created_count: number;
  deferred_count: number;
  skipped_count: number;
  created_ids: string[];
}> {
  const confirmRequired = input?.confirmRequired ?? false;
  const confidenceThreshold = input?.confidenceThreshold ?? 0.6;
  const maxCandidates = Math.max(1, Math.min(input?.maxCandidates ?? 20, 100));

  const candidates = await db
    .select({
      note: observerNotes,
      triggerMode: executionRuns.triggerMode,
    })
    .from(observerNotes)
    .innerJoin(executionRuns, eq(executionRuns.id, observerNotes.runId))
    .where(and(eq(observerNotes.kind, "candidate_belief"), eq(observerNotes.status, "approved")))
    .orderBy(asc(observerNotes.createdAt))
    .limit(maxCandidates);

  const overnightNoteIds = candidates
    .filter((candidate) => candidate.triggerMode === "overnight")
    .map((candidate) => candidate.note.id);

  const overnightApprovedViaGate = new Set<string>();
  if (overnightNoteIds.length > 0) {
    const reviews = await db
      .select({
        noteId: promotionReviews.noteId,
      })
      .from(promotionReviews)
      .where(
        and(
          inArray(promotionReviews.noteId, overnightNoteIds),
          eq(promotionReviews.decision, "approved"),
          eq(promotionReviews.reviewer, "user"),
        ),
      )
      .all();

    for (const review of reviews) {
      overnightApprovedViaGate.add(review.noteId);
    }
  }

  const createdIds: string[] = [];
  let deferred = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const note = candidate.note;
    if (candidate.triggerMode === "overnight" && !overnightApprovedViaGate.has(note.id)) {
      deferred += 1;
      continue;
    }

    const statement = collapseWhitespace(note.summary);
    if (!statement) {
      skipped += 1;
      continue;
    }
    const confidence = typeof note.confidence === "number" ? note.confidence : 0.5;
    if (confirmRequired && confidence < confidenceThreshold) {
      deferred += 1;
      continue;
    }

    const payload = parseJsonObject(note.payload);
    const topic = deriveTopic(statement, payload);
    const created = await createBelief({
      statement,
      topic,
      confidence,
      sourceKind: "synthesis",
      sourceNoteId: note.id,
      metadata: {
        run_id: note.runId,
        step_id: note.stepId,
      },
      evidence: [
        {
          evidenceType: "observer_note",
          refId: note.id,
          excerpt: note.summary,
          metadata: payload ?? undefined,
        },
        ...(note.artifactId
          ? [
              {
                evidenceType: "artifact",
                refId: note.artifactId,
                excerpt: note.summary,
              },
            ]
          : []),
      ],
    });

    if (!created) {
      skipped += 1;
      continue;
    }
    createdIds.push(created.id);
  }

  return {
    created_count: createdIds.length,
    deferred_count: deferred,
    skipped_count: skipped,
    created_ids: createdIds,
  };
}

export async function listBeliefTimeline(topic?: string): Promise<
  Array<{
    id: string;
    statement: string;
    topic: string;
    confidence: number;
    source_kind: string;
    source_note_id: string | null;
    source_document_id: string | null;
    supersedes_belief_id: string | null;
    valid_from: number;
    valid_to: number | null;
    created_at: number;
    metadata: Record<string, unknown> | null;
  }>
> {
  const rows = topic
    ? await db
        .select()
        .from(beliefRecords)
        .where(eq(beliefRecords.topic, topic.toLowerCase()))
        .orderBy(desc(beliefRecords.validFrom), desc(beliefRecords.createdAt))
        .all()
    : await db.select().from(beliefRecords).orderBy(desc(beliefRecords.validFrom), desc(beliefRecords.createdAt)).all();

  return rows.map((row) => ({
    id: row.id,
    statement: row.statement,
    topic: row.topic,
    confidence: row.confidence,
    source_kind: row.sourceKind,
    source_note_id: row.sourceNoteId,
    source_document_id: row.sourceDocumentId,
    supersedes_belief_id: row.supersedesBeliefId,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    created_at: row.createdAt,
    metadata: parseJsonObject(row.metadata),
  }));
}

export async function getBeliefEvidence(beliefId: string): Promise<{
  belief: {
    id: string;
    statement: string;
    topic: string;
    confidence: number;
    source_kind: string;
    valid_from: number;
    valid_to: number | null;
  } | null;
  evidence: Array<{
    id: string;
    evidence_type: string;
    ref_id: string | null;
    excerpt: string | null;
    metadata: Record<string, unknown> | null;
    details: Record<string, unknown> | null;
    created_at: number;
  }>;
}> {
  const belief = await db.select().from(beliefRecords).where(eq(beliefRecords.id, beliefId)).get();
  if (!belief) return { belief: null, evidence: [] };

  const rows = await db
    .select()
    .from(beliefEvidence)
    .where(eq(beliefEvidence.beliefId, beliefId))
    .orderBy(asc(beliefEvidence.createdAt))
    .all();

  const evidence = await Promise.all(
    rows.map(async (row) => {
      let details: Record<string, unknown> | null = null;
      if (row.evidenceType === "observer_note" && row.refId) {
        const note = await db.select().from(observerNotes).where(eq(observerNotes.id, row.refId)).get();
        details = note
          ? {
              kind: note.kind,
              status: note.status,
              summary: note.summary,
              confidence: note.confidence,
              run_id: note.runId,
              step_id: note.stepId,
              artifact_id: note.artifactId,
            }
          : null;
      } else if (row.evidenceType === "artifact" && row.refId) {
        const artifact = await db.select().from(researchArtifacts).where(eq(researchArtifacts.id, row.refId)).get();
        details = artifact
          ? {
              kind: artifact.kind,
              url: artifact.url,
              title: artifact.title,
              content: artifact.content,
              retrieved_at: artifact.retrievedAt,
            }
          : null;
      } else if (row.evidenceType === "document" && row.refId) {
        const doc = await db.select().from(documents).where(eq(documents.id, row.refId)).get();
        details = doc
          ? {
              kind: doc.kind,
              body: doc.body,
              metadata: parseJsonObject(doc.metadata),
              created_at: doc.createdAt,
            }
          : null;
      }

      return {
        id: row.id,
        evidence_type: row.evidenceType,
        ref_id: row.refId,
        excerpt: row.excerpt,
        metadata: parseJsonObject(row.metadata),
        details,
        created_at: row.createdAt,
      };
    }),
  );

  return {
    belief: {
      id: belief.id,
      statement: belief.statement,
      topic: belief.topic,
      confidence: belief.confidence,
      source_kind: belief.sourceKind,
      valid_from: belief.validFrom,
      valid_to: belief.validTo,
    },
    evidence,
  };
}

export async function createOpenQuestion(input: {
  question: string;
  topic: string;
  status?: string;
  linkedTaskId?: string | null;
  resolutionBeliefId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{
  id: string;
  question: string;
  topic: string;
  status: string;
  linked_task_id: string | null;
  resolution_belief_id: string | null;
  created_at: number;
  updated_at: number;
}> {
  const status = (input.status ?? "open").toLowerCase();
  if (!OPEN_QUESTION_STATUSES.has(status)) {
    throw new Error("invalid open question status");
  }
  const createdAt = now();
  const id = randomUUID();
  await db.insert(openQuestions).values({
    id,
    question: collapseWhitespace(input.question),
    topic: collapseWhitespace(input.topic).toLowerCase(),
    status,
    linkedTaskId: input.linkedTaskId ?? null,
    resolutionBeliefId: input.resolutionBeliefId ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt,
    updatedAt: createdAt,
  });
  return {
    id,
    question: collapseWhitespace(input.question),
    topic: collapseWhitespace(input.topic).toLowerCase(),
    status,
    linked_task_id: input.linkedTaskId ?? null,
    resolution_belief_id: input.resolutionBeliefId ?? null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export async function listOpenQuestions(input?: { status?: string; topic?: string }): Promise<
  Array<{
    id: string;
    question: string;
    topic: string;
    status: string;
    linked_task_id: string | null;
    resolution_belief_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: number;
    updated_at: number;
  }>
> {
  const clauses = [];
  if (input?.status) clauses.push(eq(openQuestions.status, input.status.toLowerCase()));
  if (input?.topic) clauses.push(eq(openQuestions.topic, input.topic.toLowerCase()));
  const rows =
    clauses.length > 0
      ? await db
          .select()
          .from(openQuestions)
          .where(and(...clauses))
          .orderBy(desc(openQuestions.updatedAt))
          .all()
      : await db.select().from(openQuestions).orderBy(desc(openQuestions.updatedAt)).all();
  return rows.map((row) => ({
    id: row.id,
    question: row.question,
    topic: row.topic,
    status: row.status,
    linked_task_id: row.linkedTaskId,
    resolution_belief_id: row.resolutionBeliefId,
    metadata: parseJsonObject(row.metadata),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }));
}

export async function updateOpenQuestion(
  id: string,
  patch: {
    status?: string;
    linkedTaskId?: string | null;
    resolutionBeliefId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<{
  id: string;
  status: string;
  linked_task_id: string | null;
  resolution_belief_id: string | null;
  updated_at: number;
}> {
  const existing = await db.select().from(openQuestions).where(eq(openQuestions.id, id)).get();
  if (!existing) {
    throw new Error("open question not found");
  }

  const nextStatus = patch.status ? patch.status.toLowerCase() : existing.status;
  if (!OPEN_QUESTION_STATUSES.has(nextStatus)) {
    throw new Error("invalid open question status");
  }

  const updatedAt = now();
  await db
    .update(openQuestions)
    .set({
      status: nextStatus,
      linkedTaskId: patch.linkedTaskId === undefined ? existing.linkedTaskId : patch.linkedTaskId,
      resolutionBeliefId: patch.resolutionBeliefId === undefined ? existing.resolutionBeliefId : patch.resolutionBeliefId,
      metadata:
        patch.metadata === undefined
          ? existing.metadata
          : patch.metadata === null
            ? null
            : JSON.stringify(patch.metadata),
      updatedAt,
    })
    .where(eq(openQuestions.id, id));

  return {
    id,
    status: nextStatus,
    linked_task_id: patch.linkedTaskId === undefined ? existing.linkedTaskId : patch.linkedTaskId,
    resolution_belief_id:
      patch.resolutionBeliefId === undefined ? existing.resolutionBeliefId : patch.resolutionBeliefId,
    updated_at: updatedAt,
  };
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]?/g) ?? []).map(collapseWhitespace).filter(Boolean);
}

function deriveTopicFromSentence(sentence: string, fallbackTopic?: string): string {
  if (fallbackTopic && fallbackTopic.trim().length > 0) return fallbackTopic.toLowerCase();
  const tokens = questionKeywords(sentence).slice(0, 4);
  return tokens.length > 0 ? tokens.join(" ") : "general";
}

export async function aggregateStanceBeliefs(input?: {
  topic?: string;
  maxDocuments?: number;
  maxBeliefs?: number;
}): Promise<{ created_count: number; skipped_count: number; created_ids: string[] }> {
  const maxDocuments = Math.max(1, Math.min(input?.maxDocuments ?? 50, 200));
  const maxBeliefs = Math.max(1, Math.min(input?.maxBeliefs ?? 25, 100));
  const topic = input?.topic ? input.topic.toLowerCase() : null;

  const rows = topic
    ? await db
        .select()
        .from(documents)
        .where(
          and(
            inArray(documents.kind, [...EXPERIENCE_TEXT_DOCUMENT_KINDS]),
            sql`lower(${documents.body}) like ${"%" + topic + "%"}`,
          ),
        )
        .orderBy(desc(documents.createdAt))
        .limit(maxDocuments)
    : await db
        .select()
        .from(documents)
        .where(inArray(documents.kind, [...EXPERIENCE_TEXT_DOCUMENT_KINDS]))
        .orderBy(desc(documents.createdAt))
        .limit(maxDocuments);

  let skipped = 0;
  const createdIds: string[] = [];
  for (const doc of rows) {
    if (createdIds.length >= maxBeliefs) break;
    const sentences = splitSentences(doc.body);
    for (const sentence of sentences) {
      if (createdIds.length >= maxBeliefs) break;
      if (!STANCE_RE.test(sentence)) continue;
      if (topic && !sentence.toLowerCase().includes(topic)) continue;

      const statement = collapseWhitespace(sentence);
      const beliefTopic = deriveTopicFromSentence(statement, topic ?? undefined);
      const created = await createBelief({
        statement,
        topic: beliefTopic,
        confidence: 0.35,
        sourceKind: "stance_aggregate",
        sourceDocumentId: doc.id,
        metadata: {
          document_kind: doc.kind,
        },
        evidence: [
          {
            evidenceType: "document",
            refId: doc.id,
            excerpt: statement,
          },
        ],
      });
      if (!created) {
        skipped += 1;
        continue;
      }
      createdIds.push(created.id);
    }
  }

  return {
    created_count: createdIds.length,
    skipped_count: skipped,
    created_ids: createdIds,
  };
}

export async function getUncertaintyView(input?: { confidenceThreshold?: number }): Promise<{
  threshold: number;
  open_questions: Array<{
    id: string;
    question: string;
    topic: string;
    status: string;
    linked_task_id: string | null;
    resolution_belief_id: string | null;
    created_at: number;
    updated_at: number;
  }>;
  low_confidence_beliefs: Array<{
    id: string;
    statement: string;
    topic: string;
    confidence: number;
    source_kind: string;
    valid_from: number;
    valid_to: number | null;
  }>;
}> {
  const threshold = input?.confidenceThreshold ?? 0.6;
  const [questions, lowBeliefs] = await Promise.all([
    db
      .select()
      .from(openQuestions)
      .where(sql`${openQuestions.status} != ${"resolved"}`)
      .orderBy(desc(openQuestions.updatedAt))
      .all(),
    db
      .select()
      .from(beliefRecords)
      .where(and(lte(beliefRecords.confidence, threshold), isNull(beliefRecords.validTo)))
      .orderBy(asc(beliefRecords.confidence), desc(beliefRecords.validFrom))
      .all(),
  ]);

  return {
    threshold,
    open_questions: questions.map((row) => ({
      id: row.id,
      question: row.question,
      topic: row.topic,
      status: row.status,
      linked_task_id: row.linkedTaskId,
      resolution_belief_id: row.resolutionBeliefId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
    low_confidence_beliefs: lowBeliefs.map((row) => ({
      id: row.id,
      statement: row.statement,
      topic: row.topic,
      confidence: row.confidence,
      source_kind: row.sourceKind,
      valid_from: row.validFrom,
      valid_to: row.validTo,
    })),
  };
}
