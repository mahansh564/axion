import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
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

  it("conversation log ingestion pipeline and qa", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/experiences/conversation",
      payload: {
        text: "During the chat we agreed Berlin is a great base for research.",
        channel: "conversation",
        title: "Planning chat",
      },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { experienceId: string; documentId: string };
    expect(body.experienceId).toBeTruthy();
    expect(body.documentId).toBeTruthy();

    const qa = await app.inject({
      method: "POST",
      url: "/qa",
      payload: { question: "What did we say about Berlin?" },
      headers: { "content-type": "application/json" },
    });
    expect(qa.statusCode).toBe(200);
    const qaBody = JSON.parse(qa.body) as {
      citations: Array<{ document_id: string; source_type: string }>;
    };
    expect(qaBody.citations.some((c) => c.document_id === body.documentId)).toBe(true);
  });

  it("rejects invalid conversation channel", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/experiences/conversation",
      payload: { text: "hello", channel: "voice" },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
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

  it("supports stage 4 subgraph, timeline markers, and visualization views", async () => {
    const form = new FormData();
    form.append("file", Buffer.from("stage4-audio"), {
      filename: "stage4.wav",
      contentType: "audio/wav",
    });
    const ingest = await app.inject({
      method: "POST",
      url: "/experiences/voice",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(ingest.statusCode).toBe(200);

    const create = await app.inject({
      method: "POST",
      url: "/research/runs",
      payload: { goal: "Rapamycin longevity marker timeline stage 4" },
      headers: { "content-type": "application/json" },
    });
    expect(create.statusCode).toBe(201);
    const created = JSON.parse(create.body) as { run_id: string };

    const execute = await app.inject({
      method: "POST",
      url: `/research/runs/${created.run_id}/execute`,
    });
    expect(execute.statusCode).toBe(200);

    const { db } = await import("./db/client.js");
    const { observerNotes, researchArtifacts } = await import("./db/schema.js");
    const seedArtifact = await db
      .select()
      .from(researchArtifacts)
      .where(eq(researchArtifacts.runId, created.run_id))
      .get();
    expect(seedArtifact?.id).toBeTruthy();
    await db.insert(observerNotes).values({
      id: randomUUID(),
      runId: created.run_id,
      stepId: null,
      artifactId: seedArtifact?.id ?? null,
      kind: "candidate_belief",
      status: "approved",
      summary: "Rapamycin longevity evidence remains mixed but promising in selective cohorts.",
      confidence: 0.72,
      payload: JSON.stringify({ topic: "rapamycin longevity" }),
      createdAt: Date.now(),
    });

    const synthesis = await app.inject({
      method: "POST",
      url: "/synthesis/runs",
      payload: { confidence_threshold: 0.6, confirm_required: true },
      headers: { "content-type": "application/json" },
    });
    expect(synthesis.statusCode).toBe(201);

    const subgraph = await app.inject({
      method: "GET",
      url: "/beliefs/subgraph?topic=berlin&confidence_min=0.4",
    });
    expect(subgraph.statusCode).toBe(200);
    const subgraphBody = JSON.parse(subgraph.body) as {
      nodes: Array<{ label: string }>;
      edges: Array<{ confidence: number | null }>;
      stats: { node_count: number; edge_count: number };
    };
    expect(subgraphBody.stats.node_count).toBeGreaterThan(0);
    expect(subgraphBody.stats.edge_count).toBeGreaterThan(0);
    expect(subgraphBody.nodes.some((node) => node.label.toLowerCase().includes("berlin"))).toBe(true);
    expect(
      subgraphBody.edges.every((edge) => edge.confidence === null || edge.confidence >= 0.4),
    ).toBe(true);

    const subgraphAll = await app.inject({
      method: "GET",
      url: "/beliefs/subgraph?confidence_min=0.4",
    });
    expect(subgraphAll.statusCode).toBe(200);
    const subgraphAllBody = JSON.parse(subgraphAll.body) as {
      nodes: Array<{ node_type: string }>;
      edges: Array<{ edge_type: string }>;
    };
    expect(subgraphAllBody.nodes.some((node) => node.node_type === "experience")).toBe(true);
    expect(subgraphAllBody.nodes.some((node) => node.node_type === "research")).toBe(true);
    expect(subgraphAllBody.nodes.some((node) => node.node_type === "belief")).toBe(true);
    expect(subgraphAllBody.edges.some((edge) => edge.edge_type === "experience_relation")).toBe(true);
    expect(subgraphAllBody.edges.some((edge) => edge.edge_type === "belief_evidence")).toBe(true);

    const timeline = await app.inject({
      method: "GET",
      url: "/timeline/events?topic=rapamycin%20longevity",
    });
    expect(timeline.statusCode).toBe(200);
    const timelineBody = JSON.parse(timeline.body) as {
      events: Array<{ kind: string; event_type: string }>;
    };
    expect(timelineBody.events.some((event) => event.kind === "belief_record")).toBe(true);
    expect(
      timelineBody.events.some((event) =>
        ["research_run_requested", "research_run_started", "research_run_completed"].includes(event.event_type),
      ),
    ).toBe(true);

    const graphViewRedirect = await app.inject({ method: "GET", url: "/beliefs/graph" });
    expect(graphViewRedirect.statusCode).toBe(302);
    expect(graphViewRedirect.headers.location).toContain("http://127.0.0.1:5173/beliefs/graph");

    const timelineViewRedirect = await app.inject({ method: "GET", url: "/beliefs/timeline/view" });
    expect(timelineViewRedirect.statusCode).toBe(302);
    expect(timelineViewRedirect.headers.location).toContain("http://127.0.0.1:5173/beliefs/timeline");

    const replayViewRedirect = await app.inject({
      method: "GET",
      url: `/runs/${created.run_id}/replay/view`,
    });
    expect(replayViewRedirect.statusCode).toBe(302);
    expect(replayViewRedirect.headers.location).toContain(
      `http://127.0.0.1:5173/runs/${created.run_id}/replay`,
    );
  });

  it("supports stage 5 contradiction candidates across beliefs and observer flags", async () => {
    const now = Date.now();
    const topic = "stage5 contradiction topic";
    const taskId = randomUUID();
    const runId = randomUUID();
    const contradictionNoteId = randomUUID();
    const approvedContradictionNoteId = randomUUID();
    const positiveBeliefId = randomUUID();
    const negativeBeliefId = randomUUID();

    const { db } = await import("./db/client.js");
    const { beliefRecords, executionRuns, observerNotes, researchTasks } = await import("./db/schema.js");

    await db.insert(researchTasks).values({
      id: taskId,
      goal: "Seed contradiction candidate inputs",
      source: "user",
      status: "completed",
      triggerMode: "manual",
      metadata: null,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(executionRuns).values({
      id: runId,
      taskId,
      runKind: "research",
      status: "completed",
      triggerMode: "manual",
      traceId: `trace-${runId}`,
      input: JSON.stringify({ goal: "Seed contradiction candidate inputs" }),
      createdAt: now,
      startedAt: now,
      completedAt: now,
      error: null,
    });

    await db.insert(observerNotes).values({
      id: contradictionNoteId,
      runId,
      stepId: null,
      artifactId: null,
      kind: "contradiction_flag",
      status: "pending",
      summary: "Studies disagree on whether rapamycin improves healthy human lifespan.",
      confidence: 0.74,
      payload: JSON.stringify({ topic }),
      createdAt: now,
    });
    await db.insert(observerNotes).values({
      id: approvedContradictionNoteId,
      runId,
      stepId: null,
      artifactId: null,
      kind: "contradiction_flag",
      status: "approved",
      summary: "A separate reviewer-approved contradiction signal remains visible for audit.",
      confidence: 0.78,
      payload: JSON.stringify({ topic }),
      createdAt: now + 1,
    });

    await db.insert(beliefRecords).values([
      {
        id: positiveBeliefId,
        statement: "Rapamycin improves healthy human lifespan.",
        topic,
        confidence: 0.82,
        sourceKind: "synthesis",
        sourceNoteId: null,
        sourceDocumentId: null,
        supersedesBeliefId: null,
        validFrom: now - 10,
        validTo: null,
        metadata: JSON.stringify({ stage: "stage5" }),
        createdAt: now - 10,
      },
      {
        id: negativeBeliefId,
        statement: "Rapamycin does not improve healthy human lifespan.",
        topic,
        confidence: 0.79,
        sourceKind: "synthesis",
        sourceNoteId: null,
        sourceDocumentId: null,
        supersedesBeliefId: null,
        validFrom: now - 5,
        validTo: null,
        metadata: JSON.stringify({ stage: "stage5" }),
        createdAt: now - 5,
      },
    ]);

    const contradictions = await app.inject({
      method: "GET",
      url: `/contradiction-candidates?topic=${encodeURIComponent(topic)}&confidence_min=0.5&limit=10`,
    });
    expect(contradictions.statusCode).toBe(200);
    const contradictionBody = JSON.parse(contradictions.body) as {
      contradiction_candidates: Array<{
        id: string;
        candidate_type: string;
        confidence: number;
        status: string;
        evidence: {
          belief_ids?: string[];
          note_id?: string;
        };
      }>;
    };

    expect(
      contradictionBody.contradiction_candidates.some(
        (candidate) =>
          candidate.candidate_type === "belief_conflict" &&
          candidate.evidence.belief_ids?.includes(positiveBeliefId) &&
          candidate.evidence.belief_ids?.includes(negativeBeliefId),
      ),
    ).toBe(true);
    expect(
      contradictionBody.contradiction_candidates.some(
        (candidate) => candidate.candidate_type === "observer_flag" && candidate.evidence.note_id === contradictionNoteId,
      ),
    ).toBe(true);
    expect(
      contradictionBody.contradiction_candidates.some(
        (candidate) =>
          candidate.candidate_type === "observer_flag" &&
          candidate.evidence.note_id === approvedContradictionNoteId &&
          candidate.status === "approved",
      ),
    ).toBe(true);
    expect(contradictionBody.contradiction_candidates.every((candidate) => candidate.confidence >= 0.5)).toBe(true);
  });

  it("supports stage 5 contradiction resolution flow with validity updates and no silent deletes", async () => {
    const now = Date.now();
    const topic = "stage5 resolution topic";
    const taskId = randomUUID();
    const runId = randomUUID();
    const observerNoteId = randomUUID();
    const beliefAId = randomUUID();
    const beliefBId = randomUUID();
    const unrelatedBeliefId = randomUUID();

    const { db } = await import("./db/client.js");
    const { beliefRecords, contradictionResolutions, episodicEvents, executionRuns, observerNotes, researchTasks } =
      await import("./db/schema.js");

    await db.insert(researchTasks).values({
      id: taskId,
      goal: "Seed contradiction resolution test data",
      source: "user",
      status: "completed",
      triggerMode: "manual",
      metadata: null,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(executionRuns).values({
      id: runId,
      taskId,
      runKind: "research",
      status: "completed",
      triggerMode: "manual",
      traceId: `trace-${runId}`,
      input: JSON.stringify({ goal: "Seed contradiction resolution test data" }),
      createdAt: now,
      startedAt: now,
      completedAt: now,
      error: null,
    });

    await db.insert(observerNotes).values({
      id: observerNoteId,
      runId,
      stepId: null,
      artifactId: null,
      kind: "contradiction_flag",
      status: "pending",
      summary: "Conflicting analyses detected for rapamycin in healthy aging populations.",
      confidence: 0.69,
      payload: JSON.stringify({ topic }),
      createdAt: now,
    });

    await db.insert(beliefRecords).values([
      {
        id: beliefAId,
        statement: "Rapamycin improves healthy lifespan outcomes in humans.",
        topic,
        confidence: 0.8,
        sourceKind: "synthesis",
        sourceNoteId: null,
        sourceDocumentId: null,
        supersedesBeliefId: null,
        validFrom: now - 20,
        validTo: null,
        metadata: null,
        createdAt: now - 20,
      },
      {
        id: beliefBId,
        statement: "Rapamycin does not improve healthy lifespan outcomes in humans.",
        topic,
        confidence: 0.77,
        sourceKind: "synthesis",
        sourceNoteId: null,
        sourceDocumentId: null,
        supersedesBeliefId: null,
        validFrom: now - 10,
        validTo: null,
        metadata: null,
        createdAt: now - 10,
      },
      {
        id: unrelatedBeliefId,
        statement: "Creatine improves sprint performance in trained athletes.",
        topic: "creatine",
        confidence: 0.73,
        sourceKind: "synthesis",
        sourceNoteId: null,
        sourceDocumentId: null,
        supersedesBeliefId: null,
        validFrom: now - 15,
        validTo: null,
        metadata: null,
        createdAt: now - 15,
      },
    ]);

    const conflictCandidateId = `belief-conflict:${[beliefAId, beliefBId].sort().join(":")}`;

    const invalidate = await app.inject({
      method: "POST",
      url: "/contradictions/resolve",
      payload: {
        candidate_id: conflictCandidateId,
        decision: "invalidate_belief",
        target_belief_id: beliefBId,
        rationale: "Reject the weaker contradictory claim while preserving history.",
      },
      headers: { "content-type": "application/json" },
    });
    expect(invalidate.statusCode).toBe(201);
    const invalidateBody = JSON.parse(invalidate.body) as {
      resolution_id: string;
      target_belief_id: string | null;
      resolution_belief_id: string | null;
    };
    expect(invalidateBody.target_belief_id).toBe(beliefBId);
    expect(invalidateBody.resolution_belief_id).toBeNull();

    const beliefBRow = await db.select().from(beliefRecords).where(eq(beliefRecords.id, beliefBId)).get();
    expect(beliefBRow?.validTo).not.toBeNull();

    const supersede = await app.inject({
      method: "POST",
      url: "/contradictions/resolve",
      payload: {
        candidate_id: conflictCandidateId,
        decision: "supersede_belief",
        target_belief_id: beliefAId,
        statement: "Human longevity evidence remains uncertain and insufficient for a net-benefit conclusion.",
        confidence: 0.66,
        rationale: "Use a more conservative synthesis until stronger trials arrive.",
      },
      headers: { "content-type": "application/json" },
    });
    expect(supersede.statusCode).toBe(201);
    const supersedeBody = JSON.parse(supersede.body) as {
      resolution_id: string;
      resolution_belief_id: string | null;
    };
    expect(supersedeBody.resolution_belief_id).toBeTruthy();

    const beliefARow = await db.select().from(beliefRecords).where(eq(beliefRecords.id, beliefAId)).get();
    expect(beliefARow?.validTo).not.toBeNull();
    const supersedingBelief = await db
      .select()
      .from(beliefRecords)
      .where(eq(beliefRecords.id, supersedeBody.resolution_belief_id as string))
      .get();
    expect(supersedingBelief?.supersedesBeliefId).toBe(beliefAId);
    expect(supersedingBelief?.sourceKind).toBe("contradiction_resolution");

    const invalidCrossTopic = await app.inject({
      method: "POST",
      url: "/contradictions/resolve",
      payload: {
        candidate_id: `observer-flag:${observerNoteId}`,
        decision: "invalidate_belief",
        target_belief_id: unrelatedBeliefId,
      },
      headers: { "content-type": "application/json" },
    });
    expect(invalidCrossTopic.statusCode).toBe(400);
    expect(JSON.parse(invalidCrossTopic.body).error).toContain("target belief topic");

    const keepBoth = await app.inject({
      method: "POST",
      url: "/contradictions/resolve",
      payload: {
        candidate_id: `observer-flag:${observerNoteId}`,
        decision: "keep_both",
        rationale: "Retain both claims as unresolved pending additional evidence.",
      },
      headers: { "content-type": "application/json" },
    });
    expect(keepBoth.statusCode).toBe(201);
    const keepBothBody = JSON.parse(keepBoth.body) as { observer_note_id: string | null };
    expect(keepBothBody.observer_note_id).toBe(observerNoteId);

    const byCandidate = await app.inject({
      method: "GET",
      url: `/contradictions/resolutions?candidate_id=${encodeURIComponent(conflictCandidateId)}`,
    });
    expect(byCandidate.statusCode).toBe(200);
    const byCandidateBody = JSON.parse(byCandidate.body) as {
      resolutions: Array<{ decision: string; candidate_id: string }>;
    };
    expect(byCandidateBody.resolutions.length).toBeGreaterThanOrEqual(2);
    expect(byCandidateBody.resolutions.every((resolution) => resolution.candidate_id === conflictCandidateId)).toBe(
      true,
    );

    const noSilentDeletes = await db
      .select({ id: beliefRecords.id })
      .from(beliefRecords)
      .where(eq(beliefRecords.topic, topic))
      .all();
    expect(noSilentDeletes.length).toBeGreaterThanOrEqual(3);

    const resolutionRows = await db.select().from(contradictionResolutions).all();
    expect(resolutionRows.length).toBeGreaterThanOrEqual(3);

    const contradictionEvents = await db
      .select()
      .from(episodicEvents)
      .where(eq(episodicEvents.eventType, "contradiction_resolved"))
      .all();
    expect(contradictionEvents.length).toBeGreaterThanOrEqual(3);
  });

  it("supports stage 5 curiosity signals with ranked research/reflection suggestions", async () => {
    const now = Date.now();
    const topic = "rapamycin longevity";
    const taskId = randomUUID();
    const runId = randomUUID();
    const experienceId = randomUUID();
    const dormantQuestionId = randomUUID();
    const activeQuestionId = randomUUID();

    const { db } = await import("./db/client.js");
    const {
      beliefRecords,
      documents,
      executionRuns,
      experienceRecords,
      observerNotes,
      openQuestions,
      researchTasks,
    } = await import("./db/schema.js");

    await db.insert(researchTasks).values({
      id: taskId,
      goal: "Seed curiosity signals",
      source: "user",
      status: "completed",
      triggerMode: "manual",
      metadata: null,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(executionRuns).values({
      id: runId,
      taskId,
      runKind: "research",
      status: "completed",
      triggerMode: "manual",
      traceId: `trace-${runId}`,
      input: JSON.stringify({ goal: "Seed curiosity signals" }),
      createdAt: now,
      startedAt: now,
      completedAt: now,
      error: null,
    });

    await db.insert(openQuestions).values([
      {
        id: dormantQuestionId,
        question: "How durable are healthy-lifespan benefits from rapamycin in humans?",
        topic,
        status: "open",
        linkedTaskId: null,
        resolutionBeliefId: null,
        metadata: null,
        createdAt: now - 35 * 24 * 60 * 60 * 1000,
        updatedAt: now - 28 * 24 * 60 * 60 * 1000,
      },
      {
        id: activeQuestionId,
        question: "Which biomarkers should we track for rapamycin safety?",
        topic,
        status: "researching",
        linkedTaskId: null,
        resolutionBeliefId: null,
        metadata: null,
        createdAt: now - 3 * 24 * 60 * 60 * 1000,
        updatedAt: now - 2 * 24 * 60 * 60 * 1000,
      },
    ]);

    await db.insert(beliefRecords).values([
      {
        id: randomUUID(),
        statement: "Rapamycin likely improves select aging biomarkers in adults.",
        topic,
        confidence: 0.56,
        sourceKind: "synthesis",
        sourceNoteId: null,
        sourceDocumentId: null,
        supersedesBeliefId: null,
        validFrom: now - 5 * 24 * 60 * 60 * 1000,
        validTo: null,
        metadata: null,
        createdAt: now - 5 * 24 * 60 * 60 * 1000,
      },
      {
        id: randomUUID(),
        statement: "Human longevity impact from rapamycin remains uncertain.",
        topic,
        confidence: 0.44,
        sourceKind: "synthesis",
        sourceNoteId: null,
        sourceDocumentId: null,
        supersedesBeliefId: null,
        validFrom: now - 4 * 24 * 60 * 60 * 1000,
        validTo: null,
        metadata: null,
        createdAt: now - 4 * 24 * 60 * 60 * 1000,
      },
    ]);

    await db.insert(observerNotes).values([
      {
        id: randomUUID(),
        runId,
        stepId: null,
        artifactId: null,
        kind: "uncertainty_flag",
        status: "pending",
        summary: "Long-term immune effects from rapamycin remain uncertain.",
        confidence: 0.71,
        payload: JSON.stringify({ topic }),
        createdAt: now - 24 * 60 * 60 * 1000,
      },
      {
        id: randomUUID(),
        runId,
        stepId: null,
        artifactId: null,
        kind: "coverage_gap",
        status: "pending",
        summary: "Evidence lacks large controlled human studies for rapamycin longevity outcomes.",
        confidence: 0.69,
        payload: JSON.stringify({ topic }),
        createdAt: now - 12 * 60 * 60 * 1000,
      },
    ]);

    await db.insert(experienceRecords).values({
      id: experienceId,
      createdAt: now - 2 * 24 * 60 * 60 * 1000,
      channel: "voice",
      audioRelpath: "voice/curiosity.wav",
      mimeType: "audio/wav",
    });

    await db.insert(documents).values([
      {
        id: randomUUID(),
        experienceId,
        kind: "transcript",
        body: "Creatine supplementation daily dosage leaves me unsure; I am not sure what to do.",
        sourceModel: "stub",
        createdAt: now - 90 * 60 * 1000,
        metadata: null,
      },
      {
        id: randomUUID(),
        experienceId,
        kind: "transcript",
        body: "Creatine supplementation daily dosage still confuses me and I don't know the right plan.",
        sourceModel: "stub",
        createdAt: now - 30 * 60 * 1000,
        metadata: null,
      },
    ]);

    const suggestionsResponse = await app.inject({
      method: "GET",
      url: "/curiosity/suggestions?limit=10",
    });
    expect(suggestionsResponse.statusCode).toBe(200);
    const suggestionsBody = JSON.parse(suggestionsResponse.body) as {
      generated_at: number;
      suggestions: Array<{
        id: string;
        suggestion_type: string;
        signal_type: string;
        topic: string;
        score: number;
        evidence: {
          open_question_id?: string;
        };
      }>;
    };

    expect(suggestionsBody.generated_at).toBeGreaterThan(0);
    expect(suggestionsBody.suggestions.length).toBeGreaterThan(0);
    expect(
      suggestionsBody.suggestions.some(
        (suggestion) =>
          suggestion.signal_type === "dormant_open_question" &&
          suggestion.suggestion_type === "research_task" &&
          suggestion.evidence.open_question_id === dormantQuestionId,
      ),
    ).toBe(true);
    expect(
      suggestionsBody.suggestions.some(
        (suggestion) => suggestion.evidence.open_question_id === activeQuestionId,
      ),
    ).toBe(false);
    expect(
      suggestionsBody.suggestions.some(
        (suggestion) =>
          suggestion.signal_type === "recurring_topic" &&
          suggestion.topic === topic &&
          suggestion.suggestion_type === "research_task",
      ),
    ).toBe(true);
    expect(
      suggestionsBody.suggestions.some(
        (suggestion) =>
          suggestion.signal_type === "repeated_confusion_phrase" &&
          suggestion.topic === "creatine supplementation daily dosage" &&
          suggestion.suggestion_type === "reflection_prompt",
      ),
    ).toBe(true);
    for (let i = 1; i < suggestionsBody.suggestions.length; i += 1) {
      expect(suggestionsBody.suggestions[i - 1].score).toBeGreaterThanOrEqual(suggestionsBody.suggestions[i].score);
    }

    const topicFiltered = await app.inject({
      method: "GET",
      url: `/curiosity/suggestions?topic=${encodeURIComponent(topic)}&min_score=0.4`,
    });
    expect(topicFiltered.statusCode).toBe(200);
    const topicFilteredBody = JSON.parse(topicFiltered.body) as {
      suggestions: Array<{ topic: string; score: number }>;
    };
    expect(topicFilteredBody.suggestions.length).toBeGreaterThan(0);
    expect(topicFilteredBody.suggestions.every((suggestion) => suggestion.topic === topic)).toBe(true);
    expect(topicFilteredBody.suggestions.every((suggestion) => suggestion.score >= 0.4)).toBe(true);

    const regressionTopic = "topic filter regression";
    const regressionNotes = Array.from({ length: 3 }, (_, index) => ({
      id: randomUUID(),
      runId,
      stepId: null,
      artifactId: null,
      kind: index % 2 === 0 ? "uncertainty_flag" : "coverage_gap",
      status: "pending",
      summary: `Regression topic note ${index + 1}`,
      confidence: 0.63,
      payload: JSON.stringify({ topic: regressionTopic }),
      createdAt: now - (3 - index) * 1000,
    }));
    const unrelatedNewerNotes = Array.from({ length: 320 }, (_, index) => ({
      id: randomUUID(),
      runId,
      stepId: null,
      artifactId: null,
      kind: "uncertainty_flag" as const,
      status: "pending",
      summary: `Unrelated high-volume uncertainty signal ${index + 1}`,
      confidence: 0.6,
      payload: JSON.stringify({ topic: `noise-topic-${index}` }),
      createdAt: now + index + 1,
    }));
    await db.insert(observerNotes).values([...regressionNotes, ...unrelatedNewerNotes]);

    const regressionFiltered = await app.inject({
      method: "GET",
      url: `/curiosity/suggestions?topic=${encodeURIComponent(regressionTopic)}&min_score=0.3&limit=5`,
    });
    expect(regressionFiltered.statusCode).toBe(200);
    const regressionFilteredBody = JSON.parse(regressionFiltered.body) as {
      suggestions: Array<{ signal_type: string; topic: string }>;
    };
    expect(
      regressionFilteredBody.suggestions.some(
        (suggestion) => suggestion.signal_type === "recurring_topic" && suggestion.topic === regressionTopic,
      ),
    ).toBe(true);
  });

  it("supports stage 5 overnight scheduler budgets, allowlists, and observability", async () => {
    const createSchedule = await app.inject({
      method: "POST",
      url: "/overnight/schedules",
      payload: {
        name: "Nightly longevity scan",
        goal: "Compare rapamycin longevity evidence in humans",
        notes: "Prefer literature reviews and unresolved caveats",
        hour_utc: 2,
        minute_utc: 15,
        budget: {
          max_runs_per_night: 1,
          max_subquestions: 3,
          max_search_results: 1,
          max_fetches: 1,
          max_artifacts: 8,
          max_runtime_minutes: 5,
        },
        allowlist_domains: ["example.com", "example.com", "invalid domain"],
      },
      headers: { "content-type": "application/json" },
    });
    expect(createSchedule.statusCode).toBe(201);
    const scheduleBody = JSON.parse(createSchedule.body) as {
      id: string;
      budget: { max_runs_per_night: number; max_search_results: number };
      allowlist_domains: string[];
      status: string;
    };
    expect(scheduleBody.id).toBeTruthy();
    expect(scheduleBody.status).toBe("active");
    expect(scheduleBody.budget.max_runs_per_night).toBe(1);
    expect(scheduleBody.budget.max_search_results).toBe(1);
    expect(scheduleBody.allowlist_domains).toEqual(["example.com"]);

    const listSchedules = await app.inject({
      method: "GET",
      url: "/overnight/schedules?status=active",
    });
    expect(listSchedules.statusCode).toBe(200);
    const listBody = JSON.parse(listSchedules.body) as { schedules: Array<{ id: string }> };
    expect(listBody.schedules.some((schedule) => schedule.id === scheduleBody.id)).toBe(true);

    const dispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: {
        force: true,
      },
      headers: { "content-type": "application/json" },
    });
    expect(dispatch.statusCode).toBe(200);
    const dispatchBody = JSON.parse(dispatch.body) as {
      force: boolean;
      schedule_count: number;
      results: Array<{
        schedule_id: string;
        status: string;
        run_id: string | null;
        reason: string | null;
      }>;
    };
    expect(dispatchBody.force).toBe(true);
    expect(dispatchBody.schedule_count).toBeGreaterThan(0);
    const ownResult = dispatchBody.results.find((result) => result.schedule_id === scheduleBody.id);
    expect(ownResult).toBeTruthy();
    expect(ownResult?.status).toBe("completed");
    expect(ownResult?.run_id).toBeTruthy();
    expect(ownResult?.reason).toBeNull();

    const runId = ownResult?.run_id as string;
    const replay = await app.inject({
      method: "GET",
      url: `/runs/${runId}/replay`,
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = JSON.parse(replay.body) as {
      run: { task_id: string; trigger_mode: string; input: { execution_policy?: { allowlist_domains?: string[] } } };
    };
    expect(replayBody.run.trigger_mode).toBe("overnight");
    expect(replayBody.run.input.execution_policy?.allowlist_domains).toEqual(["example.com"]);

    const { db } = await import("./db/client.js");
    const { episodicEvents, executionRuns, overnightSchedules, researchArtifacts, researchTasks } =
      await import("./db/schema.js");

    const taskRow = await db.select().from(researchTasks).where(eq(researchTasks.id, replayBody.run.task_id)).get();
    expect(taskRow?.triggerMode).toBe("overnight");
    expect(taskRow?.metadata).toContain(scheduleBody.id);

    const runRow = await db.select().from(executionRuns).where(eq(executionRuns.id, runId)).get();
    expect(runRow?.triggerMode).toBe("overnight");
    expect(runRow?.input).toContain("\"execution_policy\"");

    const scheduleRow = await db.select().from(overnightSchedules).where(eq(overnightSchedules.id, scheduleBody.id)).get();
    expect(scheduleRow?.runsTodayCount).toBe(1);
    expect(scheduleRow?.lastRunId).toBe(runId);
    expect(scheduleRow?.lastRunStatus).toBe("completed");

    const artifactRows = await db.select().from(researchArtifacts).where(eq(researchArtifacts.runId, runId)).all();
    const urlHosts = artifactRows
      .map((artifact) => artifact.url)
      .filter((url): url is string => typeof url === "string")
      .map((url) => new URL(url).hostname);
    expect(urlHosts.every((host) => host === "example.com")).toBe(true);

    const allEvents = await db.select().from(episodicEvents).all();
    expect(allEvents.some((event) => event.eventType === "overnight_scheduler_run_started")).toBe(true);
    expect(allEvents.some((event) => event.eventType === "overnight_run_scheduled")).toBe(true);
    expect(allEvents.some((event) => event.eventType === "overnight_run_completed")).toBe(true);
    expect(allEvents.some((event) => event.eventType === "research_budget_guardrail_triggered")).toBe(true);

    const secondDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: {
        force: true,
        schedule_id: scheduleBody.id,
      },
      headers: { "content-type": "application/json" },
    });
    expect(secondDispatch.statusCode).toBe(200);
    const secondBody = JSON.parse(secondDispatch.body) as {
      results: Array<{ status: string; reason: string | null }>;
    };
    expect(secondBody.results[0]?.status).toBe("skipped");
    expect(secondBody.results[0]?.reason).toBe("max_runs_per_night_reached");
  });

  it("requires promotion gate approval before overnight candidate beliefs can be synthesized", async () => {
    const createSchedule = await app.inject({
      method: "POST",
      url: "/overnight/schedules",
      payload: {
        name: "Nightly synthesis gate check",
        goal: "Collect candidate beliefs for overnight promotion gating",
        hour_utc: 3,
        minute_utc: 30,
        budget: {
          max_runs_per_night: 1,
          max_subquestions: 2,
          max_search_results: 2,
          max_fetches: 1,
          max_artifacts: 6,
          max_runtime_minutes: 5,
        },
        allowlist_domains: ["example.com"],
      },
      headers: { "content-type": "application/json" },
    });
    expect(createSchedule.statusCode).toBe(201);
    const createdSchedule = JSON.parse(createSchedule.body) as { id: string };

    const dispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: createdSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(dispatch.statusCode).toBe(200);
    const dispatchBody = JSON.parse(dispatch.body) as {
      results: Array<{ run_id: string | null; status: string }>;
    };
    expect(dispatchBody.results[0]?.status).toBe("completed");
    const runId = dispatchBody.results[0]?.run_id;
    expect(runId).toBeTruthy();
    if (!runId) {
      throw new Error("expected overnight dispatch to return run_id");
    }

    const { db } = await import("./db/client.js");
    const { beliefRecords, observerNotes, promotionReviews } = await import("./db/schema.js");

    const overnightNotes = await db.select().from(observerNotes).where(eq(observerNotes.runId, runId)).all();
    const overnightCandidate = overnightNotes.find((row) => row.kind === "candidate_belief");
    expect(overnightCandidate?.id).toBeTruthy();
    expect(overnightCandidate?.kind).toBe("candidate_belief");
    expect(overnightCandidate?.status).toBe("pending");
    if (!overnightCandidate) {
      throw new Error("expected overnight run to emit candidate_belief note");
    }

    await db.update(observerNotes).set({ status: "approved" }).where(eq(observerNotes.id, overnightCandidate.id));

    const synthesisWithoutReview = await app.inject({
      method: "POST",
      url: "/synthesis/runs",
      payload: { confirm_required: false, confidence_threshold: 0 },
      headers: { "content-type": "application/json" },
    });
    expect(synthesisWithoutReview.statusCode).toBe(201);

    const beliefWithoutReview = await db
      .select()
      .from(beliefRecords)
      .where(eq(beliefRecords.sourceNoteId, overnightCandidate.id))
      .get();
    expect(beliefWithoutReview).toBeUndefined();

    const approve = await app.inject({
      method: "POST",
      url: `/promotion/${overnightCandidate.id}/approve`,
      payload: { approved: true, rationale: "Manual overnight promotion review approval" },
      headers: { "content-type": "application/json" },
    });
    expect(approve.statusCode).toBe(200);

    const synthesisAfterReview = await app.inject({
      method: "POST",
      url: "/synthesis/runs",
      payload: { confirm_required: false, confidence_threshold: 0 },
      headers: { "content-type": "application/json" },
    });
    expect(synthesisAfterReview.statusCode).toBe(201);

    const promotedBelief = await db
      .select()
      .from(beliefRecords)
      .where(eq(beliefRecords.sourceNoteId, overnightCandidate.id))
      .get();
    expect(promotedBelief?.id).toBeTruthy();
    expect(promotedBelief?.sourceKind).toBe("synthesis");

    const promotionReview = await db
      .select()
      .from(promotionReviews)
      .where(eq(promotionReviews.noteId, overnightCandidate.id))
      .get();
    expect(promotionReview?.decision).toBe("approved");
  });

  it("applies the evaluation gate to unattended overnight dispatches only, with golden-set revision checks", async () => {
    const nowUtc = new Date();
    const createManualSchedule = await app.inject({
      method: "POST",
      url: "/overnight/schedules",
      payload: {
        name: "Manual overnight override check",
        goal: "Allow attended manual runs while unattended gate is red",
        hour_utc: nowUtc.getUTCHours(),
        minute_utc: nowUtc.getUTCMinutes(),
        budget: {
          max_runs_per_night: 1,
          max_subquestions: 2,
          max_search_results: 2,
          max_fetches: 1,
          max_artifacts: 6,
          max_runtime_minutes: 5,
        },
        allowlist_domains: ["example.com"],
      },
      headers: { "content-type": "application/json" },
    });
    expect(createManualSchedule.statusCode).toBe(201);
    const manualSchedule = JSON.parse(createManualSchedule.body) as { id: string };

    const createUnattendedSchedule = await app.inject({
      method: "POST",
      url: "/overnight/schedules",
      payload: {
        name: "Unattended evaluation gate check",
        goal: "Run unattended research only when quality gates are green",
        hour_utc: nowUtc.getUTCHours(),
        minute_utc: nowUtc.getUTCMinutes(),
        budget: {
          max_runs_per_night: 1,
          max_subquestions: 2,
          max_search_results: 2,
          max_fetches: 1,
          max_artifacts: 6,
          max_runtime_minutes: 5,
        },
        allowlist_domains: ["example.com"],
      },
      headers: { "content-type": "application/json" },
    });
    expect(createUnattendedSchedule.statusCode).toBe(201);
    const unattendedSchedule = JSON.parse(createUnattendedSchedule.body) as { id: string };

    const { db } = await import("./db/client.js");
    const { episodicEvents, evaluationGoldenCases, evaluationRuns } = await import("./db/schema.js");

    const createdAt = Date.now();
    const secondGoldenCaseUpdatedAt = createdAt + 1;
    const goldenSetVersion = secondGoldenCaseUpdatedAt;
    await db.insert(evaluationGoldenCases).values({
      id: randomUUID(),
      question: "What does current human evidence say about rapamycin and longevity?",
      expectedAnswer: "Evidence is promising but preliminary in humans.",
      status: "active",
      metadata: JSON.stringify({ topic: "rapamycin longevity" }),
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(evaluationGoldenCases).values({
      id: randomUUID(),
      question: "What cautions should be included when discussing rapamycin longevity evidence?",
      expectedAnswer: "Human endpoints, dosing, and long-term safety remain uncertain.",
      status: "active",
      metadata: JSON.stringify({ topic: "rapamycin longevity caveats" }),
      createdAt: secondGoldenCaseUpdatedAt,
      updatedAt: secondGoldenCaseUpdatedAt,
    });

    const manualRun = await app.inject({
      method: "POST",
      url: `/overnight/schedules/${manualSchedule.id}/run`,
      payload: { force: true },
      headers: { "content-type": "application/json" },
    });
    expect(manualRun.statusCode).toBe(200);
    const manualRunBody = JSON.parse(manualRun.body) as {
      results: Array<{ schedule_id: string; status: string; run_id: string | null; reason: string | null }>;
    };
    const manualRunResult = manualRunBody.results.find((row) => row.schedule_id === manualSchedule.id);
    expect(manualRunResult?.status).toBe("completed");
    expect(manualRunResult?.run_id).toBeTruthy();
    expect(manualRunResult?.reason).toBeNull();

    const readLatestGateReason = async (scheduleId: string): Promise<string | null> => {
      const gateEvents = await db
        .select()
        .from(episodicEvents)
        .where(eq(episodicEvents.eventType, "overnight_schedule_skipped"))
        .orderBy(asc(episodicEvents.createdAt))
        .all();
      const matched = gateEvents
        .map((event) => JSON.parse(event.payload) as { schedule_id?: string; gate_reason?: string; reason?: string })
        .filter((payload) => payload.schedule_id === scheduleId && payload.reason === "evaluation_gate_blocked");
      const latest = matched[matched.length - 1];
      return latest?.gate_reason ?? null;
    };

    const noEvalDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: unattendedSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(noEvalDispatch.statusCode).toBe(200);
    const noEvalBody = JSON.parse(noEvalDispatch.body) as {
      results: Array<{ schedule_id: string; status: string; run_id: string | null; reason: string | null }>;
    };
    const noEvalResult = noEvalBody.results.find((row) => row.schedule_id === unattendedSchedule.id);
    expect(noEvalResult?.status).toBe("skipped");
    expect(noEvalResult?.run_id).toBeNull();
    expect(noEvalResult?.reason).toBe("evaluation_gate_blocked");
    expect(await readLatestGateReason(unattendedSchedule.id)).toBe("missing_evaluation_run");

    await db.insert(evaluationRuns).values({
      id: randomUUID(),
      status: "passed",
      goldenSetVersion: goldenSetVersion - 1,
      goldenCaseCount: 2,
      passThreshold: 0.8,
      caseCount: 2,
      passedCaseCount: 2,
      failedCaseCount: 0,
      notes: "Old golden-set revision should not pass gate.",
      metadata: JSON.stringify({ source: "integration-test" }),
      createdAt: createdAt + 1,
    });

    const staleRevisionDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: unattendedSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(staleRevisionDispatch.statusCode).toBe(200);
    expect(await readLatestGateReason(unattendedSchedule.id)).toBe("evaluation_run_missing_golden_set_revision");

    await db.insert(evaluationRuns).values({
      id: randomUUID(),
      status: "passed",
      goldenSetVersion,
      goldenCaseCount: 1,
      passThreshold: 0.8,
      caseCount: 2,
      passedCaseCount: 2,
      failedCaseCount: 0,
      notes: "Missing golden-case coverage should block unattended writes.",
      metadata: JSON.stringify({ source: "integration-test" }),
      createdAt: createdAt + 2,
    });

    const missingCoverageDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: unattendedSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(missingCoverageDispatch.statusCode).toBe(200);
    expect(await readLatestGateReason(unattendedSchedule.id)).toBe("evaluation_run_missing_golden_cases");

    await db.insert(evaluationRuns).values({
      id: randomUUID(),
      status: "passed",
      goldenSetVersion,
      goldenCaseCount: 2,
      passThreshold: 0.8,
      caseCount: 0,
      passedCaseCount: 0,
      failedCaseCount: 0,
      notes: "Zero-case run should fail the gate.",
      metadata: JSON.stringify({ source: "integration-test" }),
      createdAt: createdAt + 3,
    });

    const zeroCaseDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: unattendedSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(zeroCaseDispatch.statusCode).toBe(200);
    expect(await readLatestGateReason(unattendedSchedule.id)).toBe("evaluation_run_has_no_cases");

    await db.insert(evaluationRuns).values({
      id: randomUUID(),
      status: "passed",
      goldenSetVersion,
      goldenCaseCount: 2,
      passThreshold: 0.8,
      caseCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      notes: "Incomplete case results should fail the gate.",
      metadata: JSON.stringify({ source: "integration-test" }),
      createdAt: createdAt + 4,
    });

    const incompleteDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: unattendedSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(incompleteDispatch.statusCode).toBe(200);
    expect(await readLatestGateReason(unattendedSchedule.id)).toBe("evaluation_run_has_incomplete_results");

    await db.insert(evaluationRuns).values({
      id: randomUUID(),
      status: "passed",
      goldenSetVersion,
      goldenCaseCount: 2,
      passThreshold: 0.8,
      caseCount: 2,
      passedCaseCount: 1,
      failedCaseCount: 1,
      notes: "Pass-rate threshold should block sub-threshold runs.",
      metadata: JSON.stringify({ source: "integration-test" }),
      createdAt: createdAt + 5,
    });

    const belowThresholdDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: unattendedSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(belowThresholdDispatch.statusCode).toBe(200);
    expect(await readLatestGateReason(unattendedSchedule.id)).toBe("latest_evaluation_below_threshold");

    await db.insert(evaluationRuns).values({
      id: randomUUID(),
      status: "failed",
      goldenSetVersion,
      goldenCaseCount: 2,
      passThreshold: 0.8,
      caseCount: 2,
      passedCaseCount: 0,
      failedCaseCount: 2,
      notes: "Regression introduced citation mismatch.",
      metadata: JSON.stringify({ source: "integration-test" }),
      createdAt: createdAt + 6,
    });

    const blockedDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: unattendedSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(blockedDispatch.statusCode).toBe(200);
    const blockedBody = JSON.parse(blockedDispatch.body) as {
      results: Array<{ schedule_id: string; status: string; run_id: string | null; reason: string | null }>;
    };
    const blockedResult = blockedBody.results.find((row) => row.schedule_id === unattendedSchedule.id);
    expect(blockedResult?.status).toBe("skipped");
    expect(blockedResult?.run_id).toBeNull();
    expect(blockedResult?.reason).toBe("evaluation_gate_blocked");
    expect(await readLatestGateReason(unattendedSchedule.id)).toBe("latest_evaluation_failed");

    await db.insert(evaluationRuns).values({
      id: randomUUID(),
      status: "passed",
      goldenSetVersion,
      goldenCaseCount: 2,
      passThreshold: 0.8,
      caseCount: 2,
      passedCaseCount: 2,
      failedCaseCount: 0,
      notes: "Quality gate recovered.",
      metadata: JSON.stringify({ source: "integration-test" }),
      createdAt: createdAt + 7,
    });

    const allowedDispatch = await app.inject({
      method: "POST",
      url: "/overnight/dispatch",
      payload: { force: true, schedule_id: unattendedSchedule.id },
      headers: { "content-type": "application/json" },
    });
    expect(allowedDispatch.statusCode).toBe(200);
    const allowedBody = JSON.parse(allowedDispatch.body) as {
      results: Array<{ schedule_id: string; status: string; run_id: string | null; reason: string | null }>;
    };
    const allowedResult = allowedBody.results.find((row) => row.schedule_id === unattendedSchedule.id);
    expect(allowedResult?.status).toBe("completed");
    expect(allowedResult?.run_id).toBeTruthy();
    expect(allowedResult?.reason).toBeNull();

    await db.update(evaluationGoldenCases).set({ status: "inactive", updatedAt: Date.now() }).run();
  });

  it("requires auth on data routes when API_KEY is enabled", async () => {
    const authRoot = mkdtempSync(join(tmpdir(), "axion-api-auth-"));
    const oldDataDir = process.env.DATA_DIR;
    const oldDbUrl = process.env.DATABASE_URL;
    const oldApiKey = process.env.API_KEY;
    const oldWorkerUrl = process.env.PYTHON_WORKER_URL;

    process.env.DATA_DIR = authRoot;
    process.env.DATABASE_URL = join(authRoot, "auth.db");
    process.env.PYTHON_WORKER_URL = "http://worker.test";
    process.env.API_KEY = "stage4-secret";

    vi.resetModules();
    const { runMigrations } = await import("./db/client.js");
    runMigrations();
    const { buildApp } = await import("./app.js");
    const authApp = await buildApp();
    await authApp.ready();

    const unauthorized = await authApp.inject({ method: "GET", url: "/timeline/events" });
    expect(unauthorized.statusCode).toBe(401);

    const unauthorizedViewRedirect = await authApp.inject({ method: "GET", url: "/beliefs/graph" });
    expect(unauthorizedViewRedirect.statusCode).toBe(401);

    const timelineWithHeader = await authApp.inject({
      method: "GET",
      url: "/timeline/events",
      headers: { authorization: "Bearer stage4-secret" },
    });
    expect(timelineWithHeader.statusCode).toBe(200);

    const viewRedirectWithHeader = await authApp.inject({
      method: "GET",
      url: "/beliefs/graph",
      headers: { authorization: "Bearer stage4-secret" },
    });
    expect(viewRedirectWithHeader.statusCode).toBe(302);
    expect(viewRedirectWithHeader.headers.location).toContain("http://127.0.0.1:5173/beliefs/graph");

    await authApp.close();
    rmSync(authRoot, { recursive: true, force: true });

    process.env.DATA_DIR = oldDataDir;
    process.env.DATABASE_URL = oldDbUrl;
    process.env.API_KEY = oldApiKey;
    process.env.PYTHON_WORKER_URL = oldWorkerUrl;
  });
});
