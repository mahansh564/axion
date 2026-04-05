import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import FormData from "form-data";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("axion api integration", () => {
  let testRoot: string;
  let app: Awaited<ReturnType<typeof import("./app.js").buildApp>>;

  beforeAll(async () => {
    testRoot = mkdtempSync(join(tmpdir(), "axion-api-"));
    process.env.DATA_DIR = testRoot;
    process.env.DATABASE_URL = join(testRoot, "test.db");
    process.env.PYTHON_WORKER_URL = "http://worker.test";
    process.env.API_KEY = "";

    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const u = String(input);
        if (u.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (u.includes("/transcribe")) {
          return new Response(
            JSON.stringify({
              text: "I think Berlin is interesting and Paris too.",
              model_id: "stub",
              language: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.includes("/extract")) {
          return new Response(
            JSON.stringify({
              model_id: "stub-extract",
              entities: [
                { label: "Berlin", kind: "place", span_start: null, span_end: null },
                { label: "Paris", kind: "place", span_start: null, span_end: null },
              ],
              relations: [
                {
                  subject: "Berlin",
                  predicate: "mentioned_with",
                  object: "Paris",
                  confidence: 0.5,
                },
              ],
              emotion: null,
              uncertainty: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.includes("duckduckgo.com/html")) {
          return new Response(
            `
              <html>
                <body>
                  <a class="result__a" href="https://example.com/research-one">Human longevity review</a>
                  <a class="result__a" href="https://example.com/research-two">Clinical caveats</a>
                </body>
              </html>
            `,
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (u === "https://example.com/research-one") {
          return new Response(
            `
              <html>
                <head><title>Human longevity review</title></head>
                <body>
                  Rapamycin has strong lifespan evidence in mice and other model organisms.
                  Human longevity evidence remains preliminary and is mostly observational.
                  Review articles emphasize uncertainty about dosing, endpoints, and long-term safety.
                </body>
              </html>
            `,
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (u === "https://example.com/research-two") {
          return new Response(
            `
              <html>
                <head><title>Clinical caveats</title></head>
                <body>
                  Clinical discussions highlight uncertainty about long-term immunosuppression risks.
                  Researchers disagree about how well animal results transfer to human longevity outcomes.
                </body>
              </html>
            `,
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );

    const { runMigrations } = await import("./db/client.js");
    runMigrations();
    const { buildApp } = await import("./app.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("voice upload pipeline and qa", async () => {
    const buf = Buffer.from("fake-audio-bytes");
    const form = new FormData();
    form.append("file", buf, { filename: "note.wav", contentType: "audio/wav" });

    const res = await app.inject({
      method: "POST",
      url: "/experiences/voice",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { experienceId: string; documentId: string };
    expect(body.experienceId).toBeTruthy();
    expect(body.documentId).toBeTruthy();

    const qa = await app.inject({
      method: "POST",
      url: "/qa",
      payload: { question: "What did I say about Berlin?" },
      headers: { "content-type": "application/json" },
    });
    expect(qa.statusCode).toBe(200);
    const qaBody = JSON.parse(qa.body) as {
      citations: Array<{ document_id: string; source_type: string }>;
      answer: string;
      gaps: string[];
    };
    expect(qaBody.citations.some((c) => c.document_id === body.documentId)).toBe(true);
    expect(qaBody.citations.some((c) => c.source_type === "experience")).toBe(true);
    expect(qaBody.answer.toLowerCase()).toContain("berlin");
    expect(qaBody.gaps).toContain("no_research_matches");
  });

  it("creates a queued research task and run", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/research/runs",
      payload: {
        goal: "Compare rapamycin longevity evidence in humans",
        notes: "Focus on review articles first",
        source: "user",
      },
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers["x-trace-id"]).toBeTruthy();
    const body = JSON.parse(res.body) as {
      task_id: string;
      run_id: string;
      status: string;
      trigger_mode: string;
      created_at: number;
    };
    expect(body.task_id).toBeTruthy();
    expect(body.run_id).toBeTruthy();
    expect(body.status).toBe("queued");
    expect(body.trigger_mode).toBe("manual");
    expect(typeof body.created_at).toBe("number");

    const { db } = await import("./db/client.js");
    const { episodicEvents, executionRuns, researchTasks } = await import("./db/schema.js");

    const taskRow = await db.select().from(researchTasks).where(eq(researchTasks.id, body.task_id)).get();
    expect(taskRow).toBeTruthy();
    expect(taskRow?.goal).toBe("Compare rapamycin longevity evidence in humans");
    expect(taskRow?.status).toBe("queued");
    expect(taskRow?.triggerMode).toBe("manual");
    expect(taskRow?.source).toBe("user");
    expect(taskRow?.metadata).toBe(JSON.stringify({ notes: "Focus on review articles first" }));

    const runRow = await db.select().from(executionRuns).where(eq(executionRuns.id, body.run_id)).get();
    expect(runRow).toBeTruthy();
    expect(runRow?.taskId).toBe(body.task_id);
    expect(runRow?.runKind).toBe("research");
    expect(runRow?.status).toBe("queued");
    expect(runRow?.triggerMode).toBe("manual");
    expect(runRow?.traceId).toBe(res.headers["x-trace-id"]);
    expect(runRow?.input).toBe(
      JSON.stringify({
        goal: "Compare rapamycin longevity evidence in humans",
        source: "user",
        notes: "Focus on review articles first",
      }),
    );

    const eventRow = await db
      .select()
      .from(episodicEvents)
      .where(eq(episodicEvents.traceId, res.headers["x-trace-id"] as string))
      .get();
    expect(eventRow?.eventType).toBe("research_run_requested");
    expect(eventRow?.payload).toContain(body.task_id);
    expect(eventRow?.payload).toContain(body.run_id);
  });

  it("rejects blank or missing research goals", async () => {
    const blank = await app.inject({
      method: "POST",
      url: "/research/runs",
      payload: { goal: "   " },
      headers: { "content-type": "application/json" },
    });
    expect(blank.statusCode).toBe(400);
    expect(JSON.parse(blank.body).error).toBe("goal required");

    const missing = await app.inject({
      method: "POST",
      url: "/research/runs",
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body).error).toBe("goal required");
  });

  it("executes a research run and returns replayable steps and artifacts", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/research/runs",
      payload: {
        goal: "Compare rapamycin longevity evidence in humans",
        notes: "Focus on review articles first",
      },
      headers: { "content-type": "application/json" },
    });
    expect(create.statusCode).toBe(201);
    const created = JSON.parse(create.body) as { run_id: string; task_id: string };

    const execute = await app.inject({
      method: "POST",
      url: `/research/runs/${created.run_id}/execute`,
    });
    expect(execute.statusCode).toBe(200);
    const executeBody = JSON.parse(execute.body) as {
      run_id: string;
      status: string;
      step_count: number;
      artifact_count: number;
      completed_at: number;
      error: string | null;
    };
    expect(executeBody.run_id).toBe(created.run_id);
    expect(executeBody.status).toBe("completed");
    expect(executeBody.step_count).toBeGreaterThan(0);
    expect(executeBody.artifact_count).toBeGreaterThan(0);
    expect(executeBody.error).toBeNull();

    const { db } = await import("./db/client.js");
    const {
      episodicEvents,
      executionRuns,
      executionSteps,
      observerNotes,
      promotionReviews,
      researchArtifacts,
    } = await import(
      "./db/schema.js"
    );

    const runRow = await db.select().from(executionRuns).where(eq(executionRuns.id, created.run_id)).get();
    expect(runRow?.status).toBe("completed");
    expect(runRow?.startedAt).toBeTruthy();
    expect(runRow?.completedAt).toBeTruthy();

    const stepRows = await db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.runId, created.run_id))
      .all();
    expect(stepRows.some((step) => step.kind === "plan")).toBe(true);
    expect(stepRows.some((step) => step.kind === "search")).toBe(true);
    expect(stepRows.some((step) => step.kind === "fetch")).toBe(true);

    const artifactRows = await db
      .select()
      .from(researchArtifacts)
      .where(eq(researchArtifacts.runId, created.run_id))
      .all();
    expect(artifactRows.some((artifact) => artifact.kind === "search_result")).toBe(true);
    expect(artifactRows.some((artifact) => artifact.kind === "excerpt")).toBe(true);
    expect(artifactRows.some((artifact) => artifact.kind === "claim")).toBe(true);
    expect(artifactRows.every((artifact) => artifact.dedupKey.length > 0)).toBe(true);

    const replay = await app.inject({
      method: "GET",
      url: `/runs/${created.run_id}/replay`,
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = JSON.parse(replay.body) as {
      run: { id: string; status: string };
      task: { id: string };
      steps: Array<{ kind: string }>;
      artifacts: Array<{ kind: string }>;
      events: Array<{ event_type: string }>;
    };
    expect(replayBody.run.id).toBe(created.run_id);
    expect(replayBody.run.status).toBe("completed");
    expect(replayBody.task.id).toBe(created.task_id);
    expect(replayBody.steps.length).toBe(stepRows.length);
    expect(replayBody.artifacts.length).toBe(artifactRows.length);
    expect(replayBody.events.some((event) => event.event_type === "research_run_started")).toBe(true);
    expect(replayBody.events.some((event) => event.event_type === "sub_question_resolved")).toBe(true);
    expect(replayBody.events.some((event) => event.event_type === "claim_committed")).toBe(true);
    expect(replayBody.events.some((event) => event.event_type === "research_run_completed")).toBe(true);

    const observations = await app.inject({
      method: "GET",
      url: `/runs/${created.run_id}/observations`,
    });
    expect(observations.statusCode).toBe(200);
    const observationsBody = JSON.parse(observations.body) as {
      run_id: string;
      observations: Array<{ id: string; kind: string; status: string }>;
    };
    expect(observationsBody.run_id).toBe(created.run_id);
    expect(observationsBody.observations.some((note) => note.kind === "observer_note")).toBe(true);
    expect(observationsBody.observations.some((note) => note.kind === "candidate_belief")).toBe(true);
    expect(observationsBody.observations.some((note) => note.kind === "uncertainty_flag")).toBe(true);

    const firstNoteId = observationsBody.observations[0]?.id;
    expect(firstNoteId).toBeTruthy();
    const approve = await app.inject({
      method: "POST",
      url: `/promotion/${firstNoteId}/approve`,
      payload: { approved: true, rationale: "Good enough evidence for manual review" },
      headers: { "content-type": "application/json" },
    });
    expect(approve.statusCode).toBe(200);
    const approveBody = JSON.parse(approve.body) as {
      note_id: string;
      decision: string;
      review_id: string;
      status: string;
    };
    expect(approveBody.note_id).toBe(firstNoteId);
    expect(approveBody.decision).toBe("approved");
    expect(approveBody.status).toBe("approved");
    expect(approveBody.review_id).toBeTruthy();

    const noteRow = await db.select().from(observerNotes).where(eq(observerNotes.id, firstNoteId as string)).get();
    expect(noteRow?.status).toBe("approved");
    const reviewRow = await db
      .select()
      .from(promotionReviews)
      .where(eq(promotionReviews.noteId, firstNoteId as string))
      .get();
    expect(reviewRow?.decision).toBe("approved");

    const qa = await app.inject({
      method: "POST",
      url: "/qa",
      payload: { question: "What does the literature say about rapamycin longevity?" },
      headers: { "content-type": "application/json" },
    });
    expect(qa.statusCode).toBe(200);
    const qaBody = JSON.parse(qa.body) as {
      answer: string;
      citations: Array<{ source_type: string; artifact_id: string | null }>;
      gaps: string[];
    };
    expect(qaBody.answer.toLowerCase()).toContain("research evidence");
    expect(qaBody.citations.some((citation) => citation.source_type === "research")).toBe(true);
    expect(qaBody.citations.some((citation) => citation.artifact_id)).toBe(true);
    expect(qaBody.gaps).toContain("no_experience_matches");

    const allEvents = await db.select().from(episodicEvents).all();
    expect(allEvents.some((event) => event.eventType === "research_run_completed")).toBe(true);
  });

  it("supports stage 3 synthesis, uncertainty retrieval, and stance aggregation", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/research/runs",
      payload: { goal: "Synthesize rapamycin beliefs for stage 3 checks" },
      headers: { "content-type": "application/json" },
    });
    expect(create.statusCode).toBe(201);
    const created = JSON.parse(create.body) as { run_id: string; task_id: string };

    const execute = await app.inject({
      method: "POST",
      url: `/research/runs/${created.run_id}/execute`,
    });
    expect(execute.statusCode).toBe(200);

    const { db } = await import("./db/client.js");
    const { observerNotes } = await import("./db/schema.js");

    const firstNoteId = randomUUID();
    const secondNoteId = randomUUID();
    await db.insert(observerNotes).values([
      {
        id: firstNoteId,
        runId: created.run_id,
        stepId: null,
        artifactId: null,
        kind: "candidate_belief",
        status: "approved",
        summary: "Rapamycin likely improves healthy-longevity markers in selective human cohorts.",
        confidence: 0.74,
        payload: JSON.stringify({ topic: "rapamycin longevity" }),
        createdAt: Date.now() - 10,
      },
      {
        id: secondNoteId,
        runId: created.run_id,
        stepId: null,
        artifactId: null,
        kind: "candidate_belief",
        status: "approved",
        summary: "Evidence remains mixed and rapamycin benefits appear context-dependent in humans.",
        confidence: 0.76,
        payload: JSON.stringify({ topic: "rapamycin longevity" }),
        createdAt: Date.now(),
      },
    ]);

    const synthesis = await app.inject({
      method: "POST",
      url: "/synthesis/runs",
      payload: {
        confirm_required: true,
        confidence_threshold: 0.6,
      },
      headers: { "content-type": "application/json" },
    });
    expect(synthesis.statusCode).toBe(201);
    const synthesisBody = JSON.parse(synthesis.body) as {
      created_count: number;
      created_ids: string[];
    };
    expect(synthesisBody.created_count).toBeGreaterThan(0);
    expect(synthesisBody.created_ids.length).toBeGreaterThan(0);

    const synthesisRepeat = await app.inject({
      method: "POST",
      url: "/synthesis/runs",
      payload: {
        confirm_required: true,
        confidence_threshold: 0.6,
      },
      headers: { "content-type": "application/json" },
    });
    expect(synthesisRepeat.statusCode).toBe(201);
    const repeatBody = JSON.parse(synthesisRepeat.body) as { created_count: number };
    expect(repeatBody.created_count).toBe(0);

    const timeline = await app.inject({
      method: "GET",
      url: "/beliefs/timeline?topic=rapamycin%20longevity",
    });
    expect(timeline.statusCode).toBe(200);
    const timelineBody = JSON.parse(timeline.body) as {
      beliefs: Array<{
        id: string;
        supersedes_belief_id: string | null;
        valid_to: number | null;
        source_kind: string;
      }>;
    };
    expect(timelineBody.beliefs.length).toBeGreaterThanOrEqual(2);
    expect(timelineBody.beliefs.some((belief) => belief.source_kind === "synthesis")).toBe(true);
    expect(timelineBody.beliefs.some((belief) => belief.supersedes_belief_id)).toBe(true);
    expect(timelineBody.beliefs.some((belief) => belief.valid_to !== null)).toBe(true);

    const latestBeliefId = timelineBody.beliefs[0]?.id;
    expect(latestBeliefId).toBeTruthy();
    const evidence = await app.inject({
      method: "GET",
      url: `/beliefs/${latestBeliefId}/evidence`,
    });
    expect(evidence.statusCode).toBe(200);
    const evidenceBody = JSON.parse(evidence.body) as {
      evidence: Array<{ evidence_type: string; ref_id: string | null }>;
    };
    expect(evidenceBody.evidence.some((entry) => entry.evidence_type === "observer_note")).toBe(true);

    const question = await app.inject({
      method: "POST",
      url: "/open-questions",
      payload: {
        question: "What is the long-term safety profile for rapamycin in healthy adults?",
        topic: "rapamycin longevity",
        status: "open",
        linked_task_id: created.task_id,
      },
      headers: { "content-type": "application/json" },
    });
    expect(question.statusCode).toBe(201);
    const questionBody = JSON.parse(question.body) as { id: string };

    const invalidStatusCreate = await app.inject({
      method: "POST",
      url: "/open-questions",
      payload: {
        question: "invalid status should fail",
        topic: "rapamycin longevity",
        status: "pending-review",
      },
      headers: { "content-type": "application/json" },
    });
    expect(invalidStatusCreate.statusCode).toBe(400);

    const invalidTaskLink = await app.inject({
      method: "POST",
      url: "/open-questions",
      payload: {
        question: "link to missing task should fail",
        topic: "rapamycin longevity",
        linked_task_id: "missing-task-id",
      },
      headers: { "content-type": "application/json" },
    });
    expect(invalidTaskLink.statusCode).toBe(409);

    const questionUpdate = await app.inject({
      method: "PATCH",
      url: `/open-questions/${questionBody.id}`,
      payload: { status: "researching" },
      headers: { "content-type": "application/json" },
    });
    expect(questionUpdate.statusCode).toBe(200);
    expect(JSON.parse(questionUpdate.body).status).toBe("researching");

    const uncertainty = await app.inject({
      method: "GET",
      url: "/beliefs/uncertainty",
    });
    expect(uncertainty.statusCode).toBe(200);
    const uncertaintyBody = JSON.parse(uncertainty.body) as {
      open_questions: Array<{ id: string; status: string }>;
      low_confidence_beliefs: Array<{ id: string; confidence: number }>;
    };
    expect(uncertaintyBody.open_questions.some((q) => q.id === questionBody.id && q.status === "researching")).toBe(
      true,
    );

    const stance = await app.inject({
      method: "POST",
      url: "/beliefs/aggregate-stances",
      payload: {
        topic: "berlin",
      },
      headers: { "content-type": "application/json" },
    });
    expect(stance.statusCode).toBe(201);
    const stanceBody = JSON.parse(stance.body) as { created_count: number };
    expect(stanceBody.created_count).toBeGreaterThan(0);

    const berlinTimeline = await app.inject({
      method: "GET",
      url: "/beliefs/timeline?topic=berlin",
    });
    expect(berlinTimeline.statusCode).toBe(200);
    const berlinBody = JSON.parse(berlinTimeline.body) as {
      beliefs: Array<{ source_kind: string }>;
    };
    expect(berlinBody.beliefs.some((belief) => belief.source_kind === "stance_aggregate")).toBe(true);
  });
});
