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

const DAY_MS = 24 * 60 * 60 * 1000;

// Enhanced NLP patterns for confusion and uncertainty detection
const CONFUSION_PATTERNS = [
  // Basic uncertainty
  /\b(i(?:'m| am)?\s+(?:not sure|unsure|confused|unclear)|i don't know|i wonder|need to think)\b/i,
  // Question words indicating confusion
  /\b(how (?:do|does|can|should|would|will)|what if|why is|why does)\b/i,
  // Hedging language
  /\b(maybe|perhaps|possibly|probably|likely|i guess|i suppose|it seems)\b/i,
  // Contradiction signals
  /\b(but then|however|although|though|yet|still|on the other hand)\b/i,
  // Follow-up needed
  /\b(need to look into|should research|should check|should read up on|want to understand)\b/i,
  // Unresolved feelings
  /\b(mixed feelings|conflicted|torn between|not convinced|skeptical about|doubtful)\b/i,
  // Surprise/confusion signals
  /\b(surprised that|unexpected|didn't expect|strange that|weird that|odd that)\b/i,
];

// Question patterns that indicate curiosity gaps
const UNANSWERED_QUESTION_PATTERNS = [
  /\?\s*(?:[^.!?]*\?\s*)?[^.!?]*$/i, // Ends with question(s)
  /^(?:what|how|why|when|where|who|which|is|are|can|could|would|should|do|does|did)\b/i,
];

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

// Enhanced confusion detection using multiple patterns
function detectConfusionPhrases(text: string): Array<{ phrase: string; pattern: string; confidence: number }> {
  const results: Array<{ phrase: string; pattern: string; confidence: number }> = [];
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    for (let i = 0; i < CONFUSION_PATTERNS.length; i++) {
      const pattern = CONFUSION_PATTERNS[i];
      if (pattern.test(sentence)) {
        // Higher confidence for more specific patterns
        const confidence = i < 3 ? 0.8 : i < 6 ? 0.6 : 0.4;
        results.push({
          phrase: sentence,
          pattern: pattern.source.slice(0, 30) + "...",
          confidence,
        });
      }
    }
  }

  return results;
}

// Detect explicit or implicit questions in text
function detectUnansweredQuestions(text: string): Array<{ question: string; is_explicit: boolean; confidence: number }> {
  const results: Array<{ question: string; is_explicit: boolean; confidence: number }> = [];
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    const hasQuestionMark = sentence.includes("?");
    const matchesQuestionPattern = UNANSWERED_QUESTION_PATTERNS.some((p) => p.test(sentence));

    if (hasQuestionMark || matchesQuestionPattern) {
      results.push({
        question: sentence,
        is_explicit: hasQuestionMark,
        confidence: hasQuestionMark ? 0.9 : 0.5,
      });
    }
  }

  return results;
}

// Detect potential follow-up needed in conversation context
function detectFollowUpNeeded(currentText: string, previousTexts: string[]): Array<{ topic: string; reason: string; confidence: number }> {
  const results: Array<{ topic: string; reason: string; confidence: number }> = [];

  // Look for phrases indicating intent to follow up
  const followUpPatterns = [
    { pattern: /\b(need to|should|will|going to)\s+(?:look|check|research|read|investigate|explore)\b/i, reason: "explicit_follow_up_intent", confidence: 0.8 },
    { pattern: /\b(let's|we can)\s+(?:come back|return|revisit)\b/i, reason: "deferred_discussion", confidence: 0.7 },
    { pattern: /\b(talk about|discuss)\s+(?:this|that)\s+(?:later|next time|another time)\b/i, reason: "scheduled_follow_up", confidence: 0.75 },
    { pattern: /\b(save this|bookmark|note this)\b/i, reason: "save_for_later", confidence: 0.65 },
  ];

  for (const { pattern, reason, confidence } of followUpPatterns) {
    if (pattern.test(currentText)) {
      const topic = deriveTopicFromText(currentText);
      results.push({ topic, reason, confidence });
    }
  }

  // Check if previous texts had questions that weren't answered in current text
  for (const prevText of previousTexts.slice(-3)) {
    const unanswered = detectUnansweredQuestions(prevText);
    for (const q of unanswered) {
      const topic = deriveTopicFromText(q.question);
      // Check if current text addresses this question
      const topicWords = topic.split(" ");
      const addressed = topicWords.some((w) => currentText.toLowerCase().includes(w.toLowerCase()));
      if (!addressed && q.confidence > 0.6) {
        results.push({
          topic,
          reason: "unanswered_previous_question",
          confidence: q.confidence * 0.7,
        });
      }
    }
  }

  return results;
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

  // New: Detect conversation gaps and unanswered questions
  const conversationGapsByTopic = new Map<
    string,
    {
      confusionHits: number;
      questionHits: number;
      followUpHits: number;
      documentIds: Set<string>;
      confusionSamples: string[];
      questionSamples: string[];
      followUpSamples: string[];
      latestAt: number;
    }
  >();

  const previousTranscripts: string[] = [];
  for (const transcript of transcriptRows) {
    const topic = deriveTopicFromText(transcript.body);
    if (topicFilter && topic !== topicFilter) continue;

    const current = conversationGapsByTopic.get(topic) ?? {
      confusionHits: 0,
      questionHits: 0,
      followUpHits: 0,
      documentIds: new Set<string>(),
      confusionSamples: [],
      questionSamples: [],
      followUpSamples: [],
      latestAt: 0,
    };

    // Detect confusion patterns
    const confusionResults = detectConfusionPhrases(transcript.body);
    for (const result of confusionResults) {
      current.confusionHits += 1;
      if (current.confusionSamples.length < 3) {
        current.confusionSamples.push(result.phrase);
      }
    }

    // Detect unanswered questions
    const unansweredResults = detectUnansweredQuestions(transcript.body);
    for (const result of unansweredResults) {
      current.questionHits += 1;
      if (current.questionSamples.length < 3) {
        current.questionSamples.push(result.question);
      }
    }

    // Detect follow-up needed (using previous context)
    const followUpResults = detectFollowUpNeeded(transcript.body, previousTranscripts);
    for (const result of followUpResults) {
      current.followUpHits += 1;
      if (current.followUpSamples.length < 3) {
        current.followUpSamples.push(`${result.reason}: ${result.topic}`);
      }
    }

    current.documentIds.add(transcript.id);
    current.latestAt = Math.max(current.latestAt, transcript.createdAt);
    conversationGapsByTopic.set(topic, current);

    previousTranscripts.push(transcript.body);
  }

  // Generate conversation gap suggestions
  for (const [topic, group] of conversationGapsByTopic.entries()) {
    const totalSignals = group.confusionHits + group.questionHits + group.followUpHits;
    if (totalSignals < 2) continue;

    const ageMs = Math.max(0, generatedAt - group.latestAt);
    const recencyBoost = ageMs <= 7 * DAY_MS ? 0.2 : ageMs <= 30 * DAY_MS ? 0.1 : 0.04;

    // Higher score for unanswered questions + follow-up intent
    const questionBonus = group.questionHits > 0 ? 0.12 : 0;
    const followUpBonus = group.followUpHits > 0 ? 0.15 : 0;
    const confusionPenalty = group.confusionHits > group.questionHits ? -0.05 : 0;

    const score = clamp(
      0.35 +
        Math.min(totalSignals, 8) * 0.08 +
        recencyBoost +
        questionBonus +
        followUpBonus +
        confusionPenalty,
      0,
      0.92,
    );
    if (score < minScore) continue;

    // Determine primary signal type
    let signalType: CuriositySuggestion["signal_type"] = "conversation_gap";
    let prompt = `Review your recent thoughts on "${topic}"`;

    if (group.questionHits > 0 && group.followUpHits > 0) {
      signalType = "unanswered_question";
      prompt = `You asked questions about "${topic}" and noted intent to follow up. Consider scheduling research or capturing what you learned.`;
    } else if (group.followUpHits > 0) {
      signalType = "follow_up_needed";
      prompt = `You mentioned wanting to follow up on "${topic}". Is this still relevant?`;
    } else if (group.questionHits > 0) {
      signalType = "unanswered_question";
      prompt = `You raised questions about "${topic}" that may still be open. Consider what answers you've found or still need.`;
    } else {
      prompt = `Reflection prompt for "${topic}": you expressed uncertainty or mixed signals. What has changed?`;
    }

    suggestions.push({
      id: `conversation-gap:${topic}:${group.latestAt}`,
      suggestion_type: group.followUpHits > 0 ? "research_task" : "reflection_prompt",
      signal_type: signalType,
      topic,
      prompt,
      score: Number(score.toFixed(3)),
      detected_at: group.latestAt,
      evidence: {
        confusion_phrase_hits: group.confusionHits,
        unanswered_question_hits: group.questionHits,
        follow_up_intent_hits: group.followUpHits,
        document_ids: [...group.documentIds],
        confusion_samples: group.confusionSamples,
        question_samples: group.questionSamples,
        follow_up_samples: group.followUpSamples,
        days_since_last_signal: Math.floor(ageMs / DAY_MS),
      },
    });
  }

  // Legacy confusion detection (keep for backward compatibility)
  const confusionByTopic = new Map<
    string,
    {
      count: number;
      latestAt: number;
      documentIds: Set<string>;
      samples: string[];
    }
  >();

  // Use the first pattern from CONFUSION_PATTERNS for legacy detection
  const legacyConfusionRe = CONFUSION_PATTERNS[0];
  for (const transcript of transcriptRows) {
    const sentences = splitSentences(transcript.body);
    for (const sentence of sentences) {
      if (!legacyConfusionRe.test(sentence)) continue;
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
    // Skip if already covered by conversation gap
    if (conversationGapsByTopic.has(topic)) continue;

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
