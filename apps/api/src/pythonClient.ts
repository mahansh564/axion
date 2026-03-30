import { env } from "./env.js";

export type TranscribeResult = {
  text: string;
  model_id: string;
  language?: string | null;
};

export type ExtractResult = {
  model_id: string;
  entities: Array<{
    label: string;
    kind: string;
    span_start?: number | null;
    span_end?: number | null;
  }>;
  relations: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence?: number | null;
  }>;
  emotion?: Record<string, unknown> | null;
  uncertainty?: Record<string, unknown> | null;
};

async function workerFetch(path: string, init: RequestInit, traceId: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-trace-id", traceId);
  return fetch(`${env.PYTHON_WORKER_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
  });
}

export async function pythonHealth(traceId: string): Promise<boolean> {
  try {
    const r = await workerFetch("/health", { method: "GET" }, traceId);
    return r.ok;
  } catch {
    return false;
  }
}

export async function transcribeAudio(input: {
  audioBase64: string;
  mimeType: string;
  traceId: string;
}): Promise<TranscribeResult> {
  const r = await workerFetch(
    "/transcribe",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audio_base64: input.audioBase64,
        mime_type: input.mimeType,
        trace_id: input.traceId,
      }),
    },
    input.traceId,
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`transcribe failed: ${r.status} ${t}`);
  }
  return (await r.json()) as TranscribeResult;
}

export async function extractStructured(input: {
  documentId: string;
  text: string;
  traceId: string;
}): Promise<ExtractResult> {
  const r = await workerFetch(
    "/extract",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document_id: input.documentId,
        text: input.text,
        trace_id: input.traceId,
      }),
    },
    input.traceId,
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`extract failed: ${r.status} ${t}`);
  }
  return (await r.json()) as ExtractResult;
}
