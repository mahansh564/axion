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
import { getObserverNotesForRun, reviewPromotion } from "./observerPipeline.js";
import { pythonHealth } from "./pythonClient.js";
import { createResearchRun, executeResearchRun, getResearchRunReplay } from "./researchPipeline.js";
import {
  aggregateStanceBeliefs,
  createOpenQuestion,
  getBeliefEvidence,
  getUncertaintyView,
  listBeliefTimeline,
  listOpenQuestions,
  runSynthesis,
  updateOpenQuestion,
} from "./synthesisPipeline.js";
import {
  excerptAround,
  findDocumentsForQuestion,
  findResearchArtifactsForQuestion,
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

  app.post("/research/runs", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const body = (req.body ?? {}) as {
      goal?: unknown;
      notes?: unknown;
      source?: unknown;
    };

    const goal = typeof body.goal === "string" ? body.goal : "";
    const notes = typeof body.notes === "string" ? body.notes : undefined;
    const source = body.source === undefined ? undefined : body.source;

    if (!goal.trim()) {
      await reply.status(400).send({ error: "goal required" });
      return;
    }

    if (source !== undefined && source !== "user" && source !== "open_question") {
      await reply.status(400).send({ error: "invalid source" });
      return;
    }

    const out = createResearchRun({
      goal,
      notes,
      source,
      traceId,
    });

    await reply.status(201).send({
      task_id: out.taskId,
      run_id: out.runId,
      status: out.status,
      trigger_mode: out.triggerMode,
      created_at: out.createdAt,
    });
  });

  app.post("/research/runs/:id/execute", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const runId = (req.params as { id: string }).id;

    try {
      const out = await executeResearchRun(runId, traceId);
      await reply.send({
        run_id: out.runId,
        status: out.status,
        step_count: out.stepCount,
        artifact_count: out.artifactCount,
        completed_at: out.completedAt,
        error: out.error,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message === "run not found" ? 404 : 409;
      await reply.status(statusCode).send({ error: message });
    }
  });

  app.get("/runs/:id/replay", async (req, reply) => {
    const runId = (req.params as { id: string }).id;
    const replay = await getResearchRunReplay(runId);
    if (!replay) {
      await reply.status(404).send({ error: "not_found" });
      return;
    }
    await reply.send(replay);
  });

  app.get("/runs/:id/observations", async (req, reply) => {
    const runId = (req.params as { id: string }).id;
    const replay = await getResearchRunReplay(runId);
    if (!replay) {
      await reply.status(404).send({ error: "not_found" });
      return;
    }

    const observations = await getObserverNotesForRun(runId);
    await reply.send({
      run_id: runId,
      observations,
    });
  });

  app.post("/promotion/:id/approve", async (req, reply) => {
    const noteId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { approved?: unknown; rationale?: unknown };

    try {
      const review = await reviewPromotion({
        noteId,
        approved: typeof body.approved === "boolean" ? body.approved : undefined,
        rationale: typeof body.rationale === "string" ? body.rationale : undefined,
      });
      await reply.send(review);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message === "note not found" ? 404 : 409;
      await reply.status(statusCode).send({ error: message });
    }
  });

  app.post("/synthesis/runs", async (req, reply) => {
    const body = (req.body ?? {}) as {
      confirm_required?: unknown;
      confidence_threshold?: unknown;
      max_candidates?: unknown;
    };

    const result = await runSynthesis({
      confirmRequired: typeof body.confirm_required === "boolean" ? body.confirm_required : undefined,
      confidenceThreshold: typeof body.confidence_threshold === "number" ? body.confidence_threshold : undefined,
      maxCandidates: typeof body.max_candidates === "number" ? body.max_candidates : undefined,
    });
    await reply.status(201).send(result);
  });

  app.get("/beliefs/timeline", async (req, reply) => {
    const query = req.query as { topic?: string };
    const timeline = await listBeliefTimeline(query.topic);
    await reply.send({ beliefs: timeline });
  });

  app.get("/beliefs/:id/evidence", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const payload = await getBeliefEvidence(id);
    if (!payload.belief) {
      await reply.status(404).send({ error: "not_found" });
      return;
    }
    await reply.send(payload);
  });

  app.get("/beliefs/uncertainty", async (req, reply) => {
    const query = req.query as { confidence_threshold?: string };
    const threshold = query.confidence_threshold ? Number(query.confidence_threshold) : undefined;
    const payload = await getUncertaintyView({
      confidenceThreshold: Number.isFinite(threshold as number) ? threshold : undefined,
    });
    await reply.send(payload);
  });

  app.post("/beliefs/aggregate-stances", async (req, reply) => {
    const body = (req.body ?? {}) as {
      topic?: unknown;
      max_documents?: unknown;
      max_beliefs?: unknown;
    };
    const result = await aggregateStanceBeliefs({
      topic: typeof body.topic === "string" ? body.topic : undefined,
      maxDocuments: typeof body.max_documents === "number" ? body.max_documents : undefined,
      maxBeliefs: typeof body.max_beliefs === "number" ? body.max_beliefs : undefined,
    });
    await reply.status(201).send(result);
  });

  app.post("/open-questions", async (req, reply) => {
    const body = (req.body ?? {}) as {
      question?: unknown;
      topic?: unknown;
      status?: unknown;
      linked_task_id?: unknown;
      resolution_belief_id?: unknown;
      metadata?: unknown;
    };
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (!question || !topic) {
      await reply.status(400).send({ error: "question and topic required" });
      return;
    }

    try {
      const created = await createOpenQuestion({
        question,
        topic,
        status: typeof body.status === "string" ? body.status : undefined,
        linkedTaskId: typeof body.linked_task_id === "string" ? body.linked_task_id : undefined,
        resolutionBeliefId:
          typeof body.resolution_belief_id === "string" ? body.resolution_belief_id : undefined,
        metadata:
          typeof body.metadata === "object" && body.metadata !== null
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      });
      await reply.status(201).send(created);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reply.status(message === "invalid open question status" ? 400 : 409).send({ error: message });
    }
  });

  app.get("/open-questions", async (req, reply) => {
    const query = req.query as { status?: string; topic?: string };
    const questions = await listOpenQuestions({
      status: query.status,
      topic: query.topic,
    });
    await reply.send({ open_questions: questions });
  });

  app.patch("/open-questions/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      status?: unknown;
      linked_task_id?: unknown;
      resolution_belief_id?: unknown;
      metadata?: unknown;
    };
    try {
      const updated = await updateOpenQuestion(id, {
        status: typeof body.status === "string" ? body.status : undefined,
        linkedTaskId:
          body.linked_task_id === null
            ? null
            : typeof body.linked_task_id === "string"
              ? body.linked_task_id
              : undefined,
        resolutionBeliefId:
          body.resolution_belief_id === null
            ? null
            : typeof body.resolution_belief_id === "string"
              ? body.resolution_belief_id
              : undefined,
        metadata:
          body.metadata === null
            ? null
            : typeof body.metadata === "object" && body.metadata !== null
              ? (body.metadata as Record<string, unknown>)
              : undefined,
      });
      await reply.send(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message === "open question not found" ? 404 : message === "invalid open question status" ? 400 : 409;
      await reply.status(statusCode).send({ error: message });
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
    const researchHits = await findResearchArtifactsForQuestion(q);
    const tokens = questionKeywords(q);

    if (hits.length === 0 && researchHits.length === 0) {
      await reply.send({
        answer: "No matching experience or research evidence was found for that question.",
        citations: [] as Array<Record<string, string | null>>,
        confidence: 0,
        gaps: ["no_experience_matches", "no_research_matches"],
        graph: { nodes: [], edges: [] },
      });
      return;
    }

    const docIds = hits.map((h) => h.id);
    const graph = docIds.length > 0 ? await oneHopNeighbors(docIds) : { nodes: [], edges: [] };

    const citations = [
      ...hits.slice(0, 5).map((h) => ({
        source_type: "experience",
        document_id: h.id,
        artifact_id: null,
        url: null,
        excerpt: excerptAround(h.body, tokens),
      })),
      ...researchHits.slice(0, 5).map((h) => ({
        source_type: "research",
        document_id: null,
        artifact_id: h.id,
        url: h.url,
        excerpt: excerptAround(h.content, tokens),
      })),
    ];

    const experienceParts = hits.slice(0, 3).map((h) => excerptAround(h.body, tokens));
    const researchParts = researchHits
      .slice(0, 3)
      .map((h) => `${h.title ? `${h.title}: ` : ""}${excerptAround(h.content, tokens)}`);
    const answerSections = [
      hits.length > 0 ? "Based on your transcripts:" : "",
      ...experienceParts.map((s, i) => `${i + 1}. ${s}`),
      researchHits.length > 0 ? "Research evidence:" : "",
      ...researchParts.map((s, i) => `${i + 1}. ${s}`),
      graph.edges.length ? `(Graph context: ${graph.edges.length} related links.)` : "",
    ].filter(Boolean);

    await reply.send({
      answer: answerSections.join("\n"),
      citations,
      confidence: Math.min(0.95, 0.3 + 0.08 * hits.length + 0.08 * researchHits.length),
      gaps: [
        ...(hits.length === 0 ? ["no_experience_matches"] : []),
        ...(researchHits.length === 0 ? ["no_research_matches"] : []),
      ] as string[],
      graph: {
        nodes: graph.nodes.slice(0, 50),
        edges: graph.edges.slice(0, 50),
      },
    });
  });

  return app;
}
