import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { and, eq, isNotNull, lte } from "drizzle-orm";

import { db } from "./db/client.js";
import { documents, episodicEvents, experienceRecords, graphEdges, graphNodes } from "./db/schema.js";
import { env } from "./env.js";
import { withTrace } from "./log.js";
import { recordModelUsageEvent } from "./modelUsage.js";
import type { ExtractResult } from "./pythonClient.js";
import { extractStructured, transcribeAudio } from "./pythonClient.js";

function now(): number {
  return Date.now();
}

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

function nodeKey(label: string): string {
  return label.toLowerCase();
}

function pathIsWithinDataDir(absPath: string): boolean {
  const root = resolve(env.DATA_DIR);
  if (absPath === root) return true;
  return absPath.startsWith(`${root}${sep}`);
}

async function applyExtractionToGraph(input: { documentId: string; extraction: ExtractResult }): Promise<void> {
  const t = now();
  const nodes = new Map<string, { id: string; label: string; kind: string }>();

  function ensureNode(label: string, kind: string): string {
    const k = nodeKey(label);
    let n = nodes.get(k);
    if (!n) {
      n = { id: randomUUID(), label, kind };
      nodes.set(k, n);
    } else if (n.kind === "entity" && kind !== "entity") {
      // Preserve a more specific extracted kind when relation parsing first created a generic node.
      n.kind = kind;
    }
    return n.id;
  }

  for (const e of input.extraction.entities) {
    ensureNode(e.label, e.kind || "entity");
  }
  for (const r of input.extraction.relations) {
    ensureNode(r.subject, "entity");
    ensureNode(r.object, "entity");
  }

  const nodeRows = [...nodes.values()].map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    properties: null as string | null,
    validFrom: t,
    validTo: null as number | null,
    documentId: input.documentId,
  }));

  for (const e of input.extraction.entities) {
    const k = nodeKey(e.label);
    const meta = nodes.get(k);
    if (!meta) continue;
    const row = nodeRows.find((r) => r.id === meta.id);
    if (row) {
      row.properties = JSON.stringify({
        span_start: e.span_start ?? null,
        span_end: e.span_end ?? null,
      });
    }
  }

  const edgeRows = input.extraction.relations.map((r) => ({
    id: randomUUID(),
    srcId: ensureNode(r.subject, "entity"),
    dstId: ensureNode(r.object, "entity"),
    predicate: r.predicate,
    confidence: r.confidence ?? null,
    validFrom: t,
    validTo: null as number | null,
    documentId: input.documentId,
  }));

  if (nodeRows.length) await db.insert(graphNodes).values(nodeRows);
  if (edgeRows.length) await db.insert(graphEdges).values(edgeRows);
}

function clampUnit(value: number | null | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function samePersonLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function inferTranscribeProvider(modelId: string): string | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("faster-whisper")) return "faster-whisper";
  if (normalized.startsWith("stub")) return "stub";
  return null;
}

async function ingestStructuredTextExperience(input: {
  text: string;
  channel: string;
  traceId: string;
  title?: string | null;
  documentKind: string;
  storedEventType: string;
  logEventName: string;
  documentMetadata?: Record<string, unknown>;
  storedEventPayload?: Record<string, unknown>;
  extractionText?: string;
}): Promise<{ experienceId: string; documentId: string }> {
  const log = withTrace(input.traceId);
  const body = input.text.trim();
  if (!body) {
    throw new Error("text required");
  }

  const experienceId = randomUUID();
  const createdAt = now();

  await db.insert(experienceRecords).values({
    id: experienceId,
    createdAt,
    channel: input.channel,
    audioRelpath: null,
    mimeType: "text/plain",
  });

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "text_experience_ingested",
    traceId: input.traceId,
    payload: JSON.stringify({
      experience_id: experienceId,
      channel: input.channel,
      title: input.title ?? null,
      char_count: body.length,
    }),
    createdAt: now(),
  });

  const documentId = randomUUID();
  await db.insert(documents).values({
    id: documentId,
    experienceId,
    kind: input.documentKind,
    body,
    sourceModel: null,
    createdAt: now(),
    metadata: JSON.stringify({
      channel: input.channel,
      title: input.title ?? null,
      ...(input.documentMetadata ?? {}),
    }),
  });

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: input.storedEventType,
    traceId: input.traceId,
    payload: JSON.stringify({
      experience_id: experienceId,
      document_id: documentId,
      channel: input.channel,
      ...(input.storedEventPayload ?? {}),
    }),
    createdAt: now(),
  });

  log.info({ event: input.logEventName, document_id: documentId, channel: input.channel });

  const extraction = await extractStructured({
    documentId,
    text: input.extractionText ?? body,
    traceId: input.traceId,
  });

  const extractionUsage = await recordModelUsageEvent({
    traceId: input.traceId,
    operation: "extract",
    provider: extraction.usage?.provider ?? null,
    modelId: extraction.usage?.model_id ?? extraction.model_id,
    promptTokens: extraction.usage?.prompt_tokens ?? null,
    completionTokens: extraction.usage?.completion_tokens ?? null,
    totalTokens: extraction.usage?.total_tokens ?? null,
    metadata: {
      channel: input.channel,
      experience_id: experienceId,
      document_id: documentId,
    },
  });

  await applyExtractionToGraph({ documentId, extraction });

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "extract_completed",
    traceId: input.traceId,
    payload: JSON.stringify({
      document_id: documentId,
      model_id: extraction.model_id,
      entity_count: extraction.entities.length,
      usage: extractionUsage,
    }),
    createdAt: now(),
  });

  return { experienceId, documentId };
}

export async function ingestVoiceNote(input: {
  buffer: Buffer;
  mimeType: string;
  traceId: string;
}): Promise<{ experienceId: string; documentId: string }> {
  const log = withTrace(input.traceId);
  const experienceId = randomUUID();
  const createdAt = now();
  const blobName = `${experienceId}.audio`;
  const audioRelpath = join("blobs", blobName);
  const absBlob = join(env.DATA_DIR, audioRelpath);
  await writeFile(absBlob, input.buffer);

  await db.insert(experienceRecords).values({
    id: experienceId,
    createdAt,
    channel: "voice",
    audioRelpath,
    mimeType: input.mimeType,
  });

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "voice_ingested",
    traceId: input.traceId,
    payload: JSON.stringify({ experience_id: experienceId, mime_type: input.mimeType }),
    createdAt: now(),
  });

  const audioBase64 = input.buffer.toString("base64");
  const tr = await transcribeAudio({
    audioBase64,
    mimeType: input.mimeType,
    traceId: input.traceId,
  });

  const transcribeUsage = await recordModelUsageEvent({
    traceId: input.traceId,
    operation: "transcribe",
    provider: tr.usage?.provider ?? inferTranscribeProvider(tr.model_id),
    modelId: tr.usage?.model_id ?? tr.model_id,
    promptTokens: tr.usage?.prompt_tokens ?? null,
    completionTokens: tr.usage?.completion_tokens ?? null,
    totalTokens: tr.usage?.total_tokens ?? null,
    metadata: {
      channel: "voice",
      experience_id: experienceId,
    },
  });

  const documentId = randomUUID();
  await db.insert(documents).values({
    id: documentId,
    experienceId,
    kind: "transcript",
    body: tr.text,
    sourceModel: tr.model_id,
    createdAt: now(),
    metadata: JSON.stringify({ language: tr.language ?? null }),
  });

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "transcribe_completed",
    traceId: input.traceId,
    payload: JSON.stringify({
      experience_id: experienceId,
      document_id: documentId,
      model_id: tr.model_id,
      usage: transcribeUsage,
    }),
    createdAt: now(),
  });

  log.info({ event: "transcribe_stored", document_id: documentId });

  const extraction = await extractStructured({
    documentId,
    text: tr.text,
    traceId: input.traceId,
  });

  const extractionUsage = await recordModelUsageEvent({
    traceId: input.traceId,
    operation: "extract",
    provider: extraction.usage?.provider ?? null,
    modelId: extraction.usage?.model_id ?? extraction.model_id,
    promptTokens: extraction.usage?.prompt_tokens ?? null,
    completionTokens: extraction.usage?.completion_tokens ?? null,
    totalTokens: extraction.usage?.total_tokens ?? null,
    metadata: {
      channel: "voice",
      experience_id: experienceId,
      document_id: documentId,
    },
  });

  await applyExtractionToGraph({ documentId, extraction });

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "extract_completed",
    traceId: input.traceId,
    payload: JSON.stringify({
      document_id: documentId,
      model_id: extraction.model_id,
      entity_count: extraction.entities.length,
      usage: extractionUsage,
    }),
    createdAt: now(),
  });

  return { experienceId, documentId };
}

export type AudioRetentionRunResult = {
  dryRun: boolean;
  retentionDays: number;
  cutoffMs: number;
  candidateCount: number;
  deletedCount: number;
  missingCount: number;
  failedCount: number;
  updatedRecords: number;
};

export async function runAudioRetentionPolicy(input: {
  dryRun: boolean;
  retentionDays: number;
  traceId: string;
}): Promise<AudioRetentionRunResult> {
  const log = withTrace(input.traceId);
  const retentionDays = Math.max(0, Math.floor(input.retentionDays));
  const cutoffMs = now() - retentionDays * MILLIS_PER_DAY;

  const candidates = await db
    .select({
      id: experienceRecords.id,
      audioRelpath: experienceRecords.audioRelpath,
    })
    .from(experienceRecords)
    .where(
      and(
        eq(experienceRecords.channel, "voice"),
        isNotNull(experienceRecords.audioRelpath),
        lte(experienceRecords.createdAt, cutoffMs),
      ),
    )
    .all();

  let deletedCount = 0;
  let missingCount = 0;
  let failedCount = 0;
  const clearAudioPathsForExperienceIds: string[] = [];

  if (!input.dryRun) {
    for (const candidate of candidates) {
      if (!candidate.audioRelpath) {
        continue;
      }
      const absBlob = resolve(env.DATA_DIR, candidate.audioRelpath);
      if (!pathIsWithinDataDir(absBlob)) {
        failedCount += 1;
        log.warn({
          event: "audio_retention_invalid_relpath",
          experience_id: candidate.id,
          audio_relpath: candidate.audioRelpath,
        });
        continue;
      }

      try {
        await unlink(absBlob);
        deletedCount += 1;
        clearAudioPathsForExperienceIds.push(candidate.id);
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? String(error.code) : null;
        if (code === "ENOENT") {
          missingCount += 1;
          clearAudioPathsForExperienceIds.push(candidate.id);
          continue;
        }
        failedCount += 1;
        log.warn({
          event: "audio_retention_delete_failed",
          experience_id: candidate.id,
          audio_relpath: candidate.audioRelpath,
          error: String(error),
        });
      }
    }

    for (const experienceId of clearAudioPathsForExperienceIds) {
      await db
        .update(experienceRecords)
        .set({
          audioRelpath: null,
        })
        .where(eq(experienceRecords.id, experienceId));
    }
  }

  const result: AudioRetentionRunResult = {
    dryRun: input.dryRun,
    retentionDays,
    cutoffMs,
    candidateCount: candidates.length,
    deletedCount,
    missingCount,
    failedCount,
    updatedRecords: clearAudioPathsForExperienceIds.length,
  };

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "audio_retention_run",
    traceId: input.traceId,
    payload: JSON.stringify({
      dry_run: result.dryRun,
      retention_days: result.retentionDays,
      cutoff_ms: result.cutoffMs,
      candidate_count: result.candidateCount,
      deleted_count: result.deletedCount,
      missing_count: result.missingCount,
      failed_count: result.failedCount,
      updated_records: result.updatedRecords,
    }),
    createdAt: now(),
  });

  log.info({
    event: "audio_retention_run",
    dry_run: result.dryRun,
    retention_days: result.retentionDays,
    candidate_count: result.candidateCount,
    deleted_count: result.deletedCount,
    missing_count: result.missingCount,
    failed_count: result.failedCount,
    updated_records: result.updatedRecords,
  });

  return result;
}

export type TextExperienceChannel = "conversation" | "manual_log";

export async function ingestTextExperience(input: {
  text: string;
  channel: TextExperienceChannel;
  traceId: string;
  title?: string | null;
}): Promise<{ experienceId: string; documentId: string }> {
  return ingestStructuredTextExperience({
    text: input.text,
    channel: input.channel,
    traceId: input.traceId,
    title: input.title,
    documentKind: "conversation_log",
    storedEventType: "conversation_log_stored",
    logEventName: "conversation_log_stored",
  });
}

export type HighlightSourceKind = "book" | "pdf" | "article" | "web" | "note" | "other";

export async function ingestHighlightAnnotation(input: {
  highlight: string;
  annotation?: string | null;
  sourceKind: HighlightSourceKind;
  sourceRef?: string | null;
  traceId: string;
  title?: string | null;
  matteredScore?: number | null;
}): Promise<{ experienceId: string; documentId: string }> {
  const highlight = input.highlight.trim();
  if (!highlight) {
    throw new Error("highlight required");
  }
  const annotation = normalizeOptionalText(input.annotation);
  const matteredScore = clampUnit(input.matteredScore, 0.7);
  const body = annotation
    ? `Highlight: ${highlight}\nAnnotation: ${annotation}`
    : `Highlight: ${highlight}`;

  return ingestStructuredTextExperience({
    text: body,
    channel: "highlight",
    traceId: input.traceId,
    title: input.title,
    documentKind: "highlight_annotation",
    storedEventType: "highlight_annotation_stored",
    logEventName: "highlight_annotation_stored",
    documentMetadata: {
      source_kind: input.sourceKind,
      source_ref: normalizeOptionalText(input.sourceRef),
      mattered_score: matteredScore,
      annotation: annotation,
      highlight,
    },
    storedEventPayload: {
      source_kind: input.sourceKind,
      mattered_score: matteredScore,
    },
    extractionText: annotation ? `${highlight}\n${annotation}` : highlight,
  });
}

async function addTrustedSourceLinks(input: {
  documentId: string;
  traceId: string;
  person: string;
  credibility: number;
}): Promise<void> {
  const t = now();
  const rows = await db
    .select({
      id: graphNodes.id,
      kind: graphNodes.kind,
      label: graphNodes.label,
      properties: graphNodes.properties,
    })
    .from(graphNodes)
    .where(eq(graphNodes.documentId, input.documentId))
    .all();

  const existingPerson = rows.find((row) => samePersonLabel(row.label, input.person));
  let personNodeId: string;
  if (existingPerson) {
    personNodeId = existingPerson.id;
    await db
      .update(graphNodes)
      .set({
        kind: "person",
        label: input.person,
        properties: JSON.stringify({
          ...parseJsonObject(existingPerson.properties),
          role: "trusted_source",
          credibility: input.credibility,
        }),
      })
      .where(eq(graphNodes.id, personNodeId));
  } else {
    personNodeId = randomUUID();
    await db.insert(graphNodes).values({
      id: personNodeId,
      kind: "person",
      label: input.person,
      properties: JSON.stringify({
        role: "trusted_source",
        credibility: input.credibility,
      }),
      validFrom: t,
      validTo: null,
      documentId: input.documentId,
    });
  }

  const entityIds = rows.filter((row) => row.id !== personNodeId && row.kind !== "person").map((row) => row.id);

  if (entityIds.length > 0) {
    await db.insert(graphEdges).values(
      entityIds.map((dstId) => ({
        id: randomUUID(),
        srcId: personNodeId,
        dstId,
        predicate: "trusted_source_mentions",
        confidence: input.credibility,
        validFrom: t,
        validTo: null,
        documentId: input.documentId,
      })),
    );
  }

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "social_trust_links_stored",
    traceId: input.traceId,
    payload: JSON.stringify({
      document_id: input.documentId,
      person: input.person,
      credibility: input.credibility,
      link_count: entityIds.length,
      person_node_id: personNodeId,
      reused_person_node: Boolean(existingPerson),
    }),
    createdAt: now(),
  });
}

export async function ingestSocialExperience(input: {
  text: string;
  person: string;
  credibility?: number | null;
  relationship?: string | null;
  traceId: string;
  title?: string | null;
}): Promise<{ experienceId: string; documentId: string; person: string; credibility: number }> {
  const person = normalizeOptionalText(input.person);
  if (!person) {
    throw new Error("person required");
  }
  const credibility = clampUnit(input.credibility, 0.5);
  const out = await ingestStructuredTextExperience({
    text: input.text,
    channel: "social",
    traceId: input.traceId,
    title: input.title,
    documentKind: "social_log",
    storedEventType: "social_log_stored",
    logEventName: "social_log_stored",
    documentMetadata: {
      person,
      relationship: normalizeOptionalText(input.relationship),
      credibility,
    },
    storedEventPayload: {
      person,
      credibility,
    },
  });

  await addTrustedSourceLinks({
    documentId: out.documentId,
    traceId: input.traceId,
    person,
    credibility,
  });

  return {
    ...out,
    person,
    credibility,
  };
}

const DAILY_REFLECTION_PROMPTS = [
  { id: "surprised", prompt: "What surprised me today?" },
  { id: "confused", prompt: "What confused me today?" },
  { id: "explore", prompt: "What do I want to explore next?" },
] as const;

export function listDailyReflectionPrompts(): Array<{ id: string; prompt: string }> {
  return DAILY_REFLECTION_PROMPTS.map((item) => ({ ...item }));
}

export async function ingestDailyReflection(input: {
  prompt: string;
  response: string;
  mood?: string | null;
  traceId: string;
  title?: string | null;
  matteredScore?: number | null;
}): Promise<{ experienceId: string; documentId: string }> {
  const prompt = normalizeOptionalText(input.prompt);
  const response = normalizeOptionalText(input.response);
  if (!prompt) throw new Error("prompt required");
  if (!response) throw new Error("response required");
  const matteredScore = clampUnit(input.matteredScore, 0.65);

  return ingestStructuredTextExperience({
    text: `Prompt: ${prompt}\nReflection: ${response}`,
    channel: "daily_reflection",
    traceId: input.traceId,
    title: input.title,
    documentKind: "reflection_log",
    storedEventType: "reflection_stored",
    logEventName: "reflection_stored",
    documentMetadata: {
      prompt,
      mood: normalizeOptionalText(input.mood),
      mattered_score: matteredScore,
    },
    storedEventPayload: {
      prompt,
      mattered_score: matteredScore,
    },
    extractionText: `${prompt}\n${response}`,
  });
}
