import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { db } from "./db/client.js";
import { documents, episodicEvents, experienceRecords, graphEdges, graphNodes } from "./db/schema.js";
import { env } from "./env.js";
import { withTrace } from "./log.js";
import type { ExtractResult } from "./pythonClient.js";
import { extractStructured, transcribeAudio } from "./pythonClient.js";

function now(): number {
  return Date.now();
}

function nodeKey(label: string, kind: string): string {
  return `${kind.toLowerCase()}::${label.toLowerCase()}`;
}

async function applyExtractionToGraph(input: { documentId: string; extraction: ExtractResult }): Promise<void> {
  const t = now();
  const nodes = new Map<string, { id: string; label: string; kind: string }>();

  function ensureNode(label: string, kind: string): string {
    const k = nodeKey(label, kind);
    let n = nodes.get(k);
    if (!n) {
      n = { id: randomUUID(), label, kind };
      nodes.set(k, n);
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
    const k = nodeKey(e.label, e.kind || "entity");
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
    }),
    createdAt: now(),
  });

  log.info({ event: "transcribe_stored", document_id: documentId });

  const extraction = await extractStructured({
    documentId,
    text: tr.text,
    traceId: input.traceId,
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
    }),
    createdAt: now(),
  });

  return { experienceId, documentId };
}

export type TextExperienceChannel = "conversation" | "manual_log";

export async function ingestTextExperience(input: {
  text: string;
  channel: TextExperienceChannel;
  traceId: string;
  title?: string | null;
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
    kind: "conversation_log",
    body,
    sourceModel: null,
    createdAt: now(),
    metadata: JSON.stringify({
      channel: input.channel,
      title: input.title ?? null,
    }),
  });

  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "conversation_log_stored",
    traceId: input.traceId,
    payload: JSON.stringify({
      experience_id: experienceId,
      document_id: documentId,
      channel: input.channel,
    }),
    createdAt: now(),
  });

  log.info({ event: "conversation_log_stored", document_id: documentId, channel: input.channel });

  const extraction = await extractStructured({
    documentId,
    text: body,
    traceId: input.traceId,
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
    }),
    createdAt: now(),
  });

  return { experienceId, documentId };
}
