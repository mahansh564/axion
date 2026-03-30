import { randomUUID } from "node:crypto";

import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import { documents, experienceRecords } from "./db/schema.js";
import { env } from "./env.js";
import { ingestVoiceNote } from "./experiencePipeline.js";
import { withTrace } from "./log.js";
import { pythonHealth } from "./pythonClient.js";
import {
  excerptAround,
  findDocumentsForQuestion,
  oneHopNeighbors,
  questionKeywords,
} from "./search.js";

export async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({
    logger: false,
    bodyLimit: env.MAX_UPLOAD_BYTES,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      files: 1,
    },
  });

  function getTraceId(req: FastifyRequest): string {
    const h = req.headers["x-trace-id"];
    if (typeof h === "string" && h.length > 0) return h;
    if (Array.isArray(h) && h[0]) return h[0];
    return randomUUID();
  }

  function pathOnly(url: string): string {
    return url.split("?")[0] ?? url;
  }

  app.addHook("onRequest", async (req, reply) => {
    const traceId = getTraceId(req);
    (req as FastifyRequest & { traceId: string }).traceId = traceId;
    reply.header("x-trace-id", traceId);
    const path = pathOnly(req.url);
    if (env.API_KEY && path !== "/health" && path !== "/ready") {
      const auth = req.headers.authorization;
      const ok = typeof auth === "string" && auth === `Bearer ${env.API_KEY}`;
      if (!ok) {
        return reply.status(401).send({ error: "unauthorized" });
      }
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId?: string }).traceId ?? "-";
    const log = withTrace(traceId);
    log.info({
      event: "http",
      method: req.method,
      url: req.url,
      status: reply.statusCode,
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (req) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    let dbOk = false;
    try {
      db.all(sql`SELECT 1`);
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const workerOk = await pythonHealth(traceId);
    return { ready: dbOk, db: dbOk, worker: workerOk };
  });

  app.post("/experiences/voice", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const log = withTrace(traceId);
    const mp = await req.file();
    if (!mp) {
      await reply.status(400).send({ error: "expected multipart file field" });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const ch of mp.file) {
      chunks.push(ch as Buffer);
    }
    const buffer = Buffer.concat(chunks);
    const mimeType = mp.mimetype || "application/octet-stream";
    try {
      const out = await ingestVoiceNote({ buffer, mimeType, traceId });
      log.info({ event: "voice_ingest_ok", ...out });
      await reply.send(out);
    } catch (e) {
      log.error({ event: "voice_ingest_err", err: String(e) });
      await reply.status(502).send({ error: "ingest_failed", detail: String(e) });
    }
  });

  app.get("/experiences/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = await db.select().from(experienceRecords).where(eq(experienceRecords.id, id)).get();
    if (!row) {
      await reply.status(404).send({ error: "not_found" });
      return;
    }
    await reply.send(row);
  });

  app.get("/documents/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = await db.select().from(documents).where(eq(documents.id, id)).get();
    if (!row) {
      await reply.status(404).send({ error: "not_found" });
      return;
    }
    await reply.send(row);
  });

  app.post("/qa", async (req, reply) => {
    const body = req.body as { question?: string };
    const q = typeof body?.question === "string" ? body.question : "";
    if (!q.trim()) {
      await reply.status(400).send({ error: "question required" });
      return;
    }

    const hits = await findDocumentsForQuestion(q);
    const tokens = questionKeywords(q);

    if (hits.length === 0) {
      await reply.send({
        answer: "No matching transcripts were found for that question.",
        citations: [] as { document_id: string; excerpt: string }[],
        confidence: 0,
        gaps: ["no_documents_matched"],
        graph: { nodes: [], edges: [] },
      });
      return;
    }

    const docIds = hits.map((h) => h.id);
    const graph = await oneHopNeighbors(docIds);

    const citations = hits.slice(0, 5).map((h) => ({
      document_id: h.id,
      excerpt: excerptAround(h.body, tokens),
    }));

    const summaryParts = hits.slice(0, 3).map((h) => excerptAround(h.body, tokens));
    const answer = [
      "Based on your transcripts:",
      ...summaryParts.map((s, i) => `${i + 1}. ${s}`),
      graph.edges.length ? `(Graph context: ${graph.edges.length} related links.)` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await reply.send({
      answer,
      citations,
      confidence: Math.min(0.9, 0.35 + 0.1 * hits.length),
      gaps: [] as string[],
      graph: {
        nodes: graph.nodes.slice(0, 50),
        edges: graph.edges.slice(0, 50),
      },
    });
  });

  return app;
}
