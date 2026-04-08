import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  beliefRecords,
  documents,
  EXPERIENCE_TEXT_DOCUMENT_KINDS,
  observerNotes,
  openQuestions,
} from "./db/schema.js";
import { questionKeywords } from "./search.js";

type CuriositySuggestion = {
  id: string;
  suggestion_type: "research_task" | "reflection_prompt";
  signal_type: "dormant_open_question" | "recurring_topic" | "repeated_confusion_phrase";
  topic: string;
  prompt: string;
  score: number;
  detected_at: number;
  evidence: Record<string, unknown>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFUSION_RE =
  /\b(i(?:'m| am)?\s+(?:not sure|unsure|confused)|i don't know|i wonder|unclear|mixed feelings|need to think)\b/i;
const OBSERVER_SIGNAL_KINDS = ["uncertainty_flag", "coverage_gap", "candidate_task"] as string[];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeTopic(topic: string | undefined): string | undefined {
  const value = topic?.trim().toLowerCase();
  return value && value.length > 0 ? value : undefined;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]?/g) ?? []).map(collapseWhitespace).filter(Boolean);
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

function deriveTopicFromText(text: string): string {
  const tokens = questionKeywords(text).slice(0, 4);
  return tokens.length > 0 ? tokens.join(" ") : "general";
}

function sortSuggestions(a: CuriositySuggestion, b: CuriositySuggestion): number {
  if (b.score !== a.score) return b.score - a.score;
  return b.detected_at - a.detected_at;
}

export async function listCuriositySuggestions(input?: {
  topic?: string;
  limit?: number;
  minScore?: number;
  dormantDays?: number;
}): Promise<{
  generated_at: number;
  suggestions: CuriositySuggestion[];
}> {
  const generatedAt = Date.now();
  const topicFilter = normalizeTopic(input?.topic);
  const limit = clamp(Math.trunc(input?.limit ?? 12), 1, 50);
  const minScore = clamp(input?.minScore ?? 0, 0, 1);
  const dormantDays = clamp(Math.trunc(input?.dormantDays ?? 14), 1, 365);
  const dormantThresholdMs = dormantDays * DAY_MS;

  const noteQuery = db
    .select({
      id: observerNotes.id,
      kind: observerNotes.kind,
      summary: observerNotes.summary,
      confidence: observerNotes.confidence,
      payload: observerNotes.payload,
      createdAt: observerNotes.createdAt,
    })
    .from(observerNotes)
    .where(inArray(observerNotes.kind, OBSERVER_SIGNAL_KINDS))
    .orderBy(desc(observerNotes.createdAt));

  const [questionRows, beliefRows, noteRows, transcriptRows] = await Promise.all([
    db
      .select({
        id: openQuestions.id,
        question: openQuestions.question,
        topic: openQuestions.topic,
        status: openQuestions.status,
        linkedTaskId: openQuestions.linkedTaskId,
        createdAt: openQuestions.createdAt,
        updatedAt: openQuestions.updatedAt,
      })
      .from(openQuestions)
      .where(
        topicFilter
          ? and(ne(openQuestions.status, "resolved"), eq(openQuestions.topic, topicFilter))
          : ne(openQuestions.status, "resolved"),
      )
      .orderBy(desc(openQuestions.updatedAt))
      .all(),
    db
      .select({
        id: beliefRecords.id,
        topic: beliefRecords.topic,
        confidence: beliefRecords.confidence,
        validFrom: beliefRecords.validFrom,
        createdAt: beliefRecords.createdAt,
      })
      .from(beliefRecords)
      .where(
        topicFilter
          ? and(isNull(beliefRecords.validTo), eq(beliefRecords.topic, topicFilter))
          : isNull(beliefRecords.validTo),
      )
      .orderBy(desc(beliefRecords.validFrom))
      .all(),
    topicFilter ? noteQuery.all() : noteQuery.limit(300).all(),
    db
      .select({
        id: documents.id,
        body: documents.body,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(
        topicFilter
          ? and(
              inArray(documents.kind, [...EXPERIENCE_TEXT_DOCUMENT_KINDS]),
              sql`lower(${documents.body}) like ${"%" + topicFilter + "%"}`,
            )
          : inArray(documents.kind, [...EXPERIENCE_TEXT_DOCUMENT_KINDS]),
      )
      .orderBy(desc(documents.createdAt))
      .limit(160)
      .all(),
  ]);

  const suggestions: CuriositySuggestion[] = [];

  for (const question of questionRows) {
    const ageMs = Math.max(0, generatedAt - question.updatedAt);
    if (ageMs < dormantThresholdMs) continue;

    const dormancyWeight = clamp(ageMs / (45 * DAY_MS), 0, 1);
    const statusBoost = question.status === "open" ? 0.08 : 0.03;
    const unlinkedBoost = question.linkedTaskId ? 0 : 0.1;
    const score = clamp(0.45 + dormancyWeight * 0.3 + statusBoost + unlinkedBoost, 0, 0.99);
    if (score < minScore) continue;

    suggestions.push({
      id: `dormant-open-question:${question.id}`,
      suggestion_type: "research_task",
      signal_type: "dormant_open_question",
      topic: question.topic,
      prompt: `Investigate open question: "${question.question}"`,
      score: Number(score.toFixed(3)),
      detected_at: question.updatedAt,
      evidence: {
        open_question_id: question.id,
        status: question.status,
        linked_task_id: question.linkedTaskId,
        age_days: Number((ageMs / DAY_MS).toFixed(1)),
        dormant_days_threshold: dormantDays,
      },
    });
  }

  const topicRollup = new Map<
    string,
    {
      beliefCount: number;
      confidenceSum: number;
      questionCount: number;
      noteCount: number;
      noteIds: Set<string>;
      latestAt: number;
    }
  >();

  function ensureTopic(topic: string): {
    beliefCount: number;
    confidenceSum: number;
    questionCount: number;
    noteCount: number;
    noteIds: Set<string>;
    latestAt: number;
  } {
    const normalized = topic.toLowerCase();
    const current = topicRollup.get(normalized);
    if (current) return current;
    const next = {
      beliefCount: 0,
      confidenceSum: 0,
      questionCount: 0,
      noteCount: 0,
      noteIds: new Set<string>(),
      latestAt: 0,
    };
    topicRollup.set(normalized, next);
    return next;
  }

  for (const belief of beliefRows) {
    if (topicFilter && belief.topic !== topicFilter) continue;
    const stats = ensureTopic(belief.topic);
    stats.beliefCount += 1;
    stats.confidenceSum += belief.confidence;
    stats.latestAt = Math.max(stats.latestAt, belief.createdAt, belief.validFrom);
  }

  for (const question of questionRows) {
    if (topicFilter && question.topic !== topicFilter) continue;
    const stats = ensureTopic(question.topic);
    stats.questionCount += 1;
    stats.latestAt = Math.max(stats.latestAt, question.updatedAt, question.createdAt);
  }

  for (const note of noteRows) {
    const payload = parseJsonObject(note.payload);
    const payloadTopic = typeof payload?.topic === "string" ? normalizeTopic(payload.topic) : undefined;
    const topic = payloadTopic ?? deriveTopicFromText(note.summary);
    if (topicFilter && topic !== topicFilter) continue;
    const stats = ensureTopic(topic);
    stats.noteCount += 1;
    stats.noteIds.add(note.id);
    stats.latestAt = Math.max(stats.latestAt, note.createdAt);
  }

  for (const [topic, stats] of topicRollup.entries()) {
    const totalSignals = stats.beliefCount + stats.questionCount + stats.noteCount;
    if (totalSignals < 3) continue;
    if (stats.noteCount + stats.questionCount < 2) continue;

    const avgConfidence = stats.beliefCount > 0 ? stats.confidenceSum / stats.beliefCount : 0.5;
    const score = clamp(
      0.28 +
        Math.min(totalSignals, 8) * 0.065 +
        Math.min(stats.noteCount, 5) * 0.05 +
        Math.min(stats.questionCount, 4) * 0.04 +
        (1 - avgConfidence) * 0.12,
      0,
      0.96,
    );
    if (score < minScore) continue;

    suggestions.push({
      id: `recurring-topic:${topic}`,
      suggestion_type: "research_task",
      signal_type: "recurring_topic",
      topic,
      prompt: `Run focused research on "${topic}" to resolve repeated uncertainty and open threads.`,
      score: Number(score.toFixed(3)),
      detected_at: stats.latestAt,
      evidence: {
        total_signals: totalSignals,
        active_belief_count: stats.beliefCount,
        unresolved_open_question_count: stats.questionCount,
        uncertainty_note_count: stats.noteCount,
        observer_note_ids: [...stats.noteIds],
        average_active_belief_confidence: Number(avgConfidence.toFixed(3)),
      },
    });
  }

  const confusionByTopic = new Map<
    string,
    {
      count: number;
      latestAt: number;
      documentIds: Set<string>;
      samples: string[];
    }
  >();

  for (const transcript of transcriptRows) {
    const sentences = splitSentences(transcript.body);
    for (const sentence of sentences) {
      if (!CONFUSION_RE.test(sentence)) continue;
      const topic = deriveTopicFromText(sentence);
      if (topicFilter && topic !== topicFilter) continue;
      const current = confusionByTopic.get(topic) ?? {
        count: 0,
        latestAt: 0,
        documentIds: new Set<string>(),
        samples: [],
      };
      current.count += 1;
      current.latestAt = Math.max(current.latestAt, transcript.createdAt);
      current.documentIds.add(transcript.id);
      if (current.samples.length < 3) {
        current.samples.push(sentence);
      }
      confusionByTopic.set(topic, current);
    }
  }

  for (const [topic, group] of confusionByTopic.entries()) {
    if (group.count < 2) continue;
    const ageMs = Math.max(0, generatedAt - group.latestAt);
    const recencyBoost = ageMs <= 7 * DAY_MS ? 0.18 : ageMs <= 30 * DAY_MS ? 0.09 : 0.03;
    const score = clamp(0.32 + Math.min(group.count, 6) * 0.1 + recencyBoost, 0, 0.9);
    if (score < minScore) continue;

    suggestions.push({
      id: `reflection-confusion:${topic}`,
      suggestion_type: "reflection_prompt",
      signal_type: "repeated_confusion_phrase",
      topic,
      prompt:
        `Reflection prompt for "${topic}": what do you currently believe, what remains unclear, and what evidence would change your mind?`,
      score: Number(score.toFixed(3)),
      detected_at: group.latestAt,
      evidence: {
        confusion_phrase_hits: group.count,
        document_ids: [...group.documentIds],
        sample_sentences: group.samples,
      },
    });
  }

  return {
    generated_at: generatedAt,
    suggestions: suggestions.sort(sortSuggestions).slice(0, limit),
  };
}
