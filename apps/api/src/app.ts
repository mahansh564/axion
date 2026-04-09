import { randomUUID } from "node:crypto";

import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import { documents, experienceRecords } from "./db/schema.js";
import {
  listContradictionCandidates,
  listContradictionResolutions,
  resolveContradiction,
} from "./contradictionPipeline.js";
import { listCuriositySuggestions } from "./curiosityPipeline.js";
import { env } from "./env.js";
import {
  ingestDailyReflection,
  ingestHighlightAnnotation,
  ingestSocialExperience,
  ingestTextExperience,
  ingestVoiceNote,
  listDailyReflectionPrompts,
} from "./experiencePipeline.js";
import { withTrace } from "./log.js";
import { getObserverNotesForRun, reviewPromotion } from "./observerPipeline.js";
import {
  createOvernightSchedule,
  dispatchOvernightSchedules,
  listOvernightSchedules,
} from "./overnightPipeline.js";
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
import { getBeliefSubgraph, listTimelineEvents } from "./visualization.js";

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

  function apiKeyFromUrl(url: string): string | null {
    const query = url.split("?")[1];
    if (!query) return null;
    const params = new URLSearchParams(query);
    const value = params.get("api_key");
    return value && value.length > 0 ? value : null;
  }

  function parseOptionalNumber(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  function parseOptionalUnitNumber(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
    return value;
  }

  function redirectToWeb(reqUrl: string, targetPath: string): string {
    const target = new URL(targetPath, env.WEB_APP_URL);
    const rawQuery = reqUrl.split("?")[1];
    if (rawQuery && rawQuery.length > 0) {
      target.search = rawQuery;
    }
    return target.toString();
  }

  app.addHook("onRequest", async (req, reply) => {
    const traceId = getTraceId(req);
    (req as FastifyRequest & { traceId: string }).traceId = traceId;
    reply.header("x-trace-id", traceId);
    const path = pathOnly(req.url);
    if (env.API_KEY && path !== "/health" && path !== "/ready") {
      const auth = req.headers.authorization;
      const bearer =
        typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;
      const queryApiKey = apiKeyFromUrl(req.url);
      const ok = bearer === env.API_KEY || queryApiKey === env.API_KEY;
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

  app.post("/experiences/conversation", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const log = withTrace(traceId);
    const body = (req.body ?? {}) as {
      text?: unknown;
      channel?: unknown;
      title?: unknown;
    };
    const text = typeof body.text === "string" ? body.text : "";
    const title = typeof body.title === "string" ? body.title : undefined;
    const rawChannel = body.channel === undefined ? "conversation" : body.channel;
    if (rawChannel !== "conversation" && rawChannel !== "manual_log") {
      await reply.status(400).send({ error: "channel must be conversation or manual_log" });
      return;
    }
    if (!text.trim()) {
      await reply.status(400).send({ error: "text required" });
      return;
    }
    try {
      const out = await ingestTextExperience({
        text,
        channel: rawChannel,
        title: title ?? null,
        traceId,
      });
      log.info({ event: "text_experience_ingest_ok", ...out });
      await reply.status(201).send(out);
    } catch (e) {
      log.error({ event: "text_experience_ingest_err", err: String(e) });
      await reply.status(502).send({ error: "ingest_failed", detail: String(e) });
    }
  });

  app.post("/experiences/highlights", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const log = withTrace(traceId);
    const body = (req.body ?? {}) as {
      highlight?: unknown;
      annotation?: unknown;
      title?: unknown;
      source_kind?: unknown;
      source_ref?: unknown;
      mattered_score?: unknown;
    };
    const highlight = typeof body.highlight === "string" ? body.highlight : "";
    const annotation = typeof body.annotation === "string" ? body.annotation : undefined;
    const title = typeof body.title === "string" ? body.title : undefined;
    const sourceRef = typeof body.source_ref === "string" ? body.source_ref : undefined;
    const rawSourceKind = body.source_kind === undefined ? "other" : body.source_kind;
    const matteredScore = parseOptionalUnitNumber(body.mattered_score);

    if (!highlight.trim()) {
      await reply.status(400).send({ error: "highlight required" });
      return;
    }
    if (
      rawSourceKind !== "book" &&
      rawSourceKind !== "pdf" &&
      rawSourceKind !== "article" &&
      rawSourceKind !== "web" &&
      rawSourceKind !== "note" &&
      rawSourceKind !== "other"
    ) {
      await reply.status(400).send({ error: "source_kind must be book|pdf|article|web|note|other" });
      return;
    }
    if (body.mattered_score !== undefined && matteredScore === undefined) {
      await reply.status(400).send({ error: "mattered_score must be a number between 0 and 1" });
      return;
    }

    try {
      const out = await ingestHighlightAnnotation({
        highlight,
        annotation,
        title: title ?? null,
        sourceKind: rawSourceKind,
        sourceRef,
        traceId,
        matteredScore,
      });
      log.info({ event: "highlight_annotation_ingest_ok", ...out });
      await reply.status(201).send({
        ...out,
        mattered_score: matteredScore ?? 0.7,
      });
    } catch (e) {
      log.error({ event: "highlight_annotation_ingest_err", err: String(e) });
      await reply.status(502).send({ error: "ingest_failed", detail: String(e) });
    }
  });

  app.post("/experiences/social", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const log = withTrace(traceId);
    const body = (req.body ?? {}) as {
      text?: unknown;
      person?: unknown;
      title?: unknown;
      relationship?: unknown;
      credibility?: unknown;
    };
    const text = typeof body.text === "string" ? body.text : "";
    const person = typeof body.person === "string" ? body.person.trim() : "";
    const title = typeof body.title === "string" ? body.title : undefined;
    const relationship = typeof body.relationship === "string" ? body.relationship : undefined;
    const credibility = parseOptionalUnitNumber(body.credibility);

    if (!text.trim()) {
      await reply.status(400).send({ error: "text required" });
      return;
    }
    if (!person.trim()) {
      await reply.status(400).send({ error: "person required" });
      return;
    }
    if (body.credibility !== undefined && credibility === undefined) {
      await reply.status(400).send({ error: "credibility must be a number between 0 and 1" });
      return;
    }

    try {
      const out = await ingestSocialExperience({
        text,
        person,
        title: title ?? null,
        relationship,
        traceId,
        credibility,
      });
      log.info({ event: "social_experience_ingest_ok", ...out });
      await reply.status(201).send({
        ...out,
      });
    } catch (e) {
      log.error({ event: "social_experience_ingest_err", err: String(e) });
      await reply.status(502).send({ error: "ingest_failed", detail: String(e) });
    }
  });

  app.get("/reflections/prompts", async () => {
    return {
      generated_at: Date.now(),
      prompts: listDailyReflectionPrompts(),
    };
  });

  app.post("/experiences/reflections", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const log = withTrace(traceId);
    const body = (req.body ?? {}) as {
      prompt?: unknown;
      response?: unknown;
      mood?: unknown;
      title?: unknown;
      mattered_score?: unknown;
    };
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const responseText = typeof body.response === "string" ? body.response : "";
    const mood = typeof body.mood === "string" ? body.mood : undefined;
    const title = typeof body.title === "string" ? body.title : undefined;
    const matteredScore = parseOptionalUnitNumber(body.mattered_score);

    if (!prompt.trim()) {
      await reply.status(400).send({ error: "prompt required" });
      return;
    }
    if (!responseText.trim()) {
      await reply.status(400).send({ error: "response required" });
      return;
    }
    if (body.mattered_score !== undefined && matteredScore === undefined) {
      await reply.status(400).send({ error: "mattered_score must be a number between 0 and 1" });
      return;
    }

    try {
      const out = await ingestDailyReflection({
        prompt,
        response: responseText,
        mood,
        title: title ?? null,
        traceId,
        matteredScore,
      });
      log.info({ event: "reflection_ingest_ok", ...out, mattered_score: matteredScore ?? 0.65 });
      await reply.status(201).send({
        ...out,
        mattered_score: matteredScore ?? 0.65,
      });
    } catch (e) {
      log.error({ event: "reflection_ingest_err", err: String(e) });
      await reply.status(502).send({ error: "ingest_failed", detail: String(e) });
    }
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

  app.post("/overnight/schedules", async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      goal?: unknown;
      notes?: unknown;
      hour_utc?: unknown;
      minute_utc?: unknown;
      budget?: unknown;
      allowlist_domains?: unknown;
      status?: unknown;
    };

    try {
      const created = await createOvernightSchedule({
        name: typeof body.name === "string" ? body.name : "",
        goal: typeof body.goal === "string" ? body.goal : "",
        notes: typeof body.notes === "string" ? body.notes : undefined,
        hourUtc: typeof body.hour_utc === "number" ? body.hour_utc : Number.NaN,
        minuteUtc: typeof body.minute_utc === "number" ? body.minute_utc : Number.NaN,
        budget: body.budget,
        allowlistDomains: body.allowlist_domains,
        status: typeof body.status === "string" ? body.status : undefined,
      });
      await reply.status(201).send(created);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reply.status(400).send({ error: message });
    }
  });

  app.get("/overnight/schedules", async (req, reply) => {
    const query = req.query as { status?: string };
    const payload = await listOvernightSchedules({ status: query.status });
    await reply.send(payload);
  });

  app.post("/overnight/schedules/:id/run", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const scheduleId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { force?: unknown };
    const force = typeof body.force === "boolean" ? body.force : true;

    const payload = await dispatchOvernightSchedules({
      traceId,
      force,
      scheduleId,
      attended: true,
    });

    if (payload.schedule_count === 0) {
      await reply.status(404).send({ error: "schedule not found or inactive" });
      return;
    }
    await reply.send(payload);
  });

  app.post("/overnight/dispatch", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const body = (req.body ?? {}) as {
      force?: unknown;
      schedule_id?: unknown;
    };
    const payload = await dispatchOvernightSchedules({
      traceId,
      force: typeof body.force === "boolean" ? body.force : false,
      scheduleId: typeof body.schedule_id === "string" ? body.schedule_id : undefined,
      attended: false,
    });
    await reply.send(payload);
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

  app.get("/beliefs/subgraph", async (req, reply) => {
    const query = req.query as {
      topic?: string;
      time_from?: string;
      time_to?: string;
      confidence_min?: string;
      max_nodes?: string;
      max_edges?: string;
    };

    const payload = await getBeliefSubgraph({
      topic: query.topic,
      timeFrom: parseOptionalNumber(query.time_from),
      timeTo: parseOptionalNumber(query.time_to),
      confidenceMin: parseOptionalNumber(query.confidence_min),
      maxNodes: parseOptionalNumber(query.max_nodes),
      maxEdges: parseOptionalNumber(query.max_edges),
    });
    await reply.send(payload);
  });

  app.get("/timeline/events", async (req, reply) => {
    const query = req.query as {
      topic?: string;
      time_from?: string;
      time_to?: string;
      limit?: string;
    };
    const payload = await listTimelineEvents({
      topic: query.topic,
      timeFrom: parseOptionalNumber(query.time_from),
      timeTo: parseOptionalNumber(query.time_to),
      limit: parseOptionalNumber(query.limit),
    });
    await reply.send(payload);
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

  app.get("/contradiction-candidates", async (req, reply) => {
    const query = req.query as {
      topic?: string;
      confidence_min?: string;
      limit?: string;
    };
    const confidenceMin = parseOptionalNumber(query.confidence_min);
    const limit = parseOptionalNumber(query.limit);
    const payload = await listContradictionCandidates({
      topic: query.topic,
      confidenceMin,
      limit,
    });
    await reply.send(payload);
  });

  app.post("/contradictions/resolve", async (req, reply) => {
    const traceId = (req as FastifyRequest & { traceId: string }).traceId;
    const body = (req.body ?? {}) as {
      candidate_id?: unknown;
      decision?: unknown;
      target_belief_id?: unknown;
      statement?: unknown;
      topic?: unknown;
      confidence?: unknown;
      rationale?: unknown;
      metadata?: unknown;
    };
    if (typeof body.candidate_id !== "string" || !body.candidate_id.trim()) {
      await reply.status(400).send({ error: "candidate_id required" });
      return;
    }
    if (typeof body.decision !== "string" || !body.decision.trim()) {
      await reply.status(400).send({ error: "decision required" });
      return;
    }
    try {
      const payload = await resolveContradiction({
        traceId,
        candidateId: body.candidate_id,
        decision: body.decision as "invalidate_belief" | "supersede_belief" | "keep_both",
        targetBeliefId: typeof body.target_belief_id === "string" ? body.target_belief_id : undefined,
        statement: typeof body.statement === "string" ? body.statement : undefined,
        topic: typeof body.topic === "string" ? body.topic : undefined,
        confidence: typeof body.confidence === "number" ? body.confidence : undefined,
        rationale: typeof body.rationale === "string" ? body.rationale : undefined,
        metadata:
          typeof body.metadata === "object" && body.metadata !== null
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      });
      await reply.status(201).send(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("required") ||
        message.startsWith("invalid") ||
        message.includes("must belong") ||
        message.includes("topic does not match")
          ? 400
          : message.includes("not found")
            ? 404
            : message.includes("inactive")
              ? 409
              : 409;
      await reply.status(statusCode).send({ error: message });
    }
  });

  app.get("/contradictions/resolutions", async (req, reply) => {
    const query = req.query as {
      candidate_id?: string;
      limit?: string;
    };
    const payload = await listContradictionResolutions({
      candidateId: query.candidate_id,
      limit: parseOptionalNumber(query.limit),
    });
    await reply.send(payload);
  });

  app.get("/curiosity/suggestions", async (req, reply) => {
    const query = req.query as {
      topic?: string;
      limit?: string;
      min_score?: string;
      dormant_days?: string;
    };
    const payload = await listCuriositySuggestions({
      topic: query.topic,
      limit: parseOptionalNumber(query.limit),
      minScore: parseOptionalNumber(query.min_score),
      dormantDays: parseOptionalNumber(query.dormant_days),
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

  app.get("/beliefs/graph", async (req, reply) => {
    await reply.redirect(redirectToWeb(req.url, "/beliefs/graph"));
  });

  app.get("/beliefs/timeline/view", async (req, reply) => {
    await reply.redirect(redirectToWeb(req.url, "/beliefs/timeline"));
  });

  app.get("/runs/:id/replay/view", async (req, reply) => {
    const runId = (req.params as { id: string }).id;
    await reply.redirect(redirectToWeb(req.url, `/runs/${encodeURIComponent(runId)}/replay`));
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
      hits.length > 0 ? "Based on your experience records:" : "",
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
