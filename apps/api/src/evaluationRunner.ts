import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq, like, sql } from "drizzle-orm";

import { buildApp } from "./app.js";
import { db, runMigrations } from "./db/client.js";
import {
  documents,
  evaluationGoldenCases,
  evaluationRuns,
  executionRuns,
  executionSteps,
  experienceRecords,
  researchArtifacts,
  researchTasks,
} from "./db/schema.js";
import { env } from "./env.js";

type SourceType = "experience" | "research";

type GoldenCaseMetadata = {
  must_contain?: string[];
  required_source_types?: SourceType[];
  required_gaps?: string[];
  forbidden_gaps?: string[];
  minimum_experience_citations?: number;
  minimum_research_citations?: number;
};

type GoldenTopic = {
  id: string;
  expected_answer: string;
  questions: string[];
  metadata?: GoldenCaseMetadata;
};

type GoldenDatasetFile = {
  version: number;
  topics: GoldenTopic[];
};

type GoldenCase = {
  id: string;
  question: string;
  expectedAnswer: string;
  metadata: GoldenCaseMetadata;
};

type EvaluationCaseResult = {
  id: string;
  question: string;
  passed: boolean;
  reasons: string[];
  observed: {
    answer: string;
    confidence: number;
    sourceTypes: string[];
    experienceCitationCount: number;
    researchCitationCount: number;
    gaps: string[];
  };
};

const EVAL_FIXTURE_PREFIX = "eval-fixture-";
const GOLDEN_ID_PREFIX = "stage6-golden-";
const EVAL_REPORT_DIR = resolve(env.DATA_DIR, "eval");
const DEFAULT_PASS_THRESHOLD = 0.9;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET_PATH = resolve(__dirname, "../evals/golden-qa.json");

function now(): number {
  return Date.now();
}

function normalizeQuestionId(topicId: string, index: number): string {
  return `${GOLDEN_ID_PREFIX}${topicId}-${index + 1}`;
}

function toGoldenCases(dataset: GoldenDatasetFile): GoldenCase[] {
  const out: GoldenCase[] = [];
  for (const topic of dataset.topics) {
    topic.questions.forEach((question, index) => {
      out.push({
        id: normalizeQuestionId(topic.id, index),
        question,
        expectedAnswer: topic.expected_answer,
        metadata: topic.metadata ?? {},
      });
    });
  }
  return out;
}

async function readDataset(filePath?: string): Promise<GoldenCase[]> {
  const resolved = filePath ? resolve(filePath) : DEFAULT_DATASET_PATH;
  const parsed = JSON.parse(await readFile(resolved, "utf8")) as GoldenDatasetFile;
  return toGoldenCases(parsed);
}

async function syncGoldenCases(cases: GoldenCase[]): Promise<{ active: number; deactivated: number }> {
  const startedAt = now();
  const existing = await db.select().from(evaluationGoldenCases).all();
  const byId = new Map(existing.map((row) => [row.id, row] as const));
  const activeIds = new Set<string>();

  for (const row of cases) {
    activeIds.add(row.id);
    const metadata = JSON.stringify(row.metadata ?? {});
    if (byId.has(row.id)) {
      await db
        .update(evaluationGoldenCases)
        .set({
          question: row.question,
          expectedAnswer: row.expectedAnswer,
          status: "active",
          metadata,
          updatedAt: startedAt,
        })
        .where(eq(evaluationGoldenCases.id, row.id));
      continue;
    }
    await db.insert(evaluationGoldenCases).values({
      id: row.id,
      question: row.question,
      expectedAnswer: row.expectedAnswer,
      status: "active",
      metadata,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
  }

  let deactivated = 0;
  for (const row of existing) {
    if (!row.id.startsWith(GOLDEN_ID_PREFIX)) continue;
    if (activeIds.has(row.id)) continue;
    await db
      .update(evaluationGoldenCases)
      .set({ status: "inactive", updatedAt: startedAt })
      .where(eq(evaluationGoldenCases.id, row.id));
    deactivated += 1;
  }

  return {
    active: cases.length,
    deactivated,
  };
}

async function seedEvalFixtures(): Promise<void> {
  await db.delete(researchArtifacts).where(like(researchArtifacts.id, `${EVAL_FIXTURE_PREFIX}%`));
  await db.delete(executionSteps).where(like(executionSteps.id, `${EVAL_FIXTURE_PREFIX}%`));
  await db.delete(executionRuns).where(like(executionRuns.id, `${EVAL_FIXTURE_PREFIX}%`));
  await db.delete(researchTasks).where(like(researchTasks.id, `${EVAL_FIXTURE_PREFIX}%`));
  await db.delete(documents).where(like(documents.id, `${EVAL_FIXTURE_PREFIX}%`));
  await db.delete(experienceRecords).where(like(experienceRecords.id, `${EVAL_FIXTURE_PREFIX}%`));

  const t = now();

  const fixtureExperiences = [
    {
      experienceId: `${EVAL_FIXTURE_PREFIX}exp-1`,
      documentId: `${EVAL_FIXTURE_PREFIX}doc-berlin`,
      channel: "conversation",
      kind: "conversation_log",
      body: "evalberlin notes: Berlin remains my preferred base for deep research work and long planning blocks.",
      metadata: { channel: "conversation", title: "Berlin planning" },
    },
    {
      experienceId: `${EVAL_FIXTURE_PREFIX}exp-2`,
      documentId: `${EVAL_FIXTURE_PREFIX}doc-sleep`,
      channel: "highlight",
      kind: "highlight_annotation",
      body: "Highlight: evalsleep routine. Annotation: morning sunlight improved sleep onset consistency.",
      metadata: { channel: "highlight", mattered_score: 0.9 },
    },
    {
      experienceId: `${EVAL_FIXTURE_PREFIX}exp-3`,
      documentId: `${EVAL_FIXTURE_PREFIX}doc-social`,
      channel: "social",
      kind: "social_log",
      body: "evalsocial update: Dr Rivera emphasized biomarkers and metabolic endpoints in recent discussion.",
      metadata: { channel: "social", person: "Dr Rivera", credibility: 0.9 },
    },
    {
      experienceId: `${EVAL_FIXTURE_PREFIX}exp-4`,
      documentId: `${EVAL_FIXTURE_PREFIX}doc-magnesium`,
      channel: "daily_reflection",
      kind: "reflection_log",
      body: "Prompt: Dosing uncertainty. Reflection: I remain unsure about evalmagnesium dose timing and total amount.",
      metadata: { channel: "daily_reflection", mood: "uncertain", mattered_score: 0.7 },
    },
    {
      experienceId: `${EVAL_FIXTURE_PREFIX}exp-5`,
      documentId: `${EVAL_FIXTURE_PREFIX}doc-morninglight`,
      channel: "highlight",
      kind: "highlight_annotation",
      body: "Highlight: evalmorninglight habit. Annotation: sunrise exposure helped stabilize mood and energy.",
      metadata: { channel: "highlight", mattered_score: 0.85 },
    },
    {
      experienceId: `${EVAL_FIXTURE_PREFIX}exp-6`,
      documentId: `${EVAL_FIXTURE_PREFIX}doc-paris`,
      channel: "conversation",
      kind: "conversation_log",
      body: "evalparis observation: Paris felt less focused than Berlin for deep solo work sessions.",
      metadata: { channel: "conversation", title: "City comparison" },
    },
    {
      experienceId: `${EVAL_FIXTURE_PREFIX}exp-7`,
      documentId: `${EVAL_FIXTURE_PREFIX}doc-rapa`,
      channel: "conversation",
      kind: "conversation_log",
      body: "evalrapa experience note: mild side effects so far, with open questions on long-term dosing.",
      metadata: { channel: "conversation", title: "Rapa note" },
    },
    {
      experienceId: `${EVAL_FIXTURE_PREFIX}exp-8`,
      documentId: `${EVAL_FIXTURE_PREFIX}doc-protein`,
      channel: "transcript",
      kind: "transcript",
      body: "evalprotein tracked intake around 120g daily and noted better consistency in training recovery.",
      metadata: { channel: "voice" },
    },
  ] as const;

  for (const row of fixtureExperiences) {
    await db.insert(experienceRecords).values({
      id: row.experienceId,
      createdAt: t,
      channel: row.channel,
      audioRelpath: null,
      mimeType: "text/plain",
    });
    await db.insert(documents).values({
      id: row.documentId,
      experienceId: row.experienceId,
      kind: row.kind,
      body: row.body,
      sourceModel: null,
      createdAt: t,
      metadata: JSON.stringify(row.metadata),
    });
  }

  const taskId = `${EVAL_FIXTURE_PREFIX}task-1`;
  const runId = `${EVAL_FIXTURE_PREFIX}run-1`;
  const stepId = `${EVAL_FIXTURE_PREFIX}step-1`;
  await db.insert(researchTasks).values({
    id: taskId,
    goal: "Seed deterministic golden eval research artifacts",
    source: "evaluation",
    status: "done",
    triggerMode: "manual",
    metadata: JSON.stringify({ fixture: true }),
    createdAt: t,
    updatedAt: t,
  });
  await db.insert(executionRuns).values({
    id: runId,
    taskId,
    runKind: "research",
    status: "completed",
    triggerMode: "manual",
    traceId: `${EVAL_FIXTURE_PREFIX}trace`,
    input: JSON.stringify({ fixture: true }),
    createdAt: t,
    startedAt: t,
    completedAt: t,
    error: null,
  });
  await db.insert(executionSteps).values({
    id: stepId,
    runId,
    parentStepId: null,
    kind: "synthesis",
    title: "Seed artifacts",
    status: "completed",
    input: null,
    output: null,
    createdAt: t,
    startedAt: t,
    completedAt: t,
    error: null,
  });

  await db.insert(researchArtifacts).values([
    {
      id: `${EVAL_FIXTURE_PREFIX}artifact-rapa-1`,
      runId,
      stepId,
      kind: "claim",
      url: "https://example.com/eval/rapa",
      title: "Rapa evidence overview",
      content:
        "evalrapa research suggests lifespan benefits in model organisms, while human evidence remains preliminary.",
      retrievedAt: t,
      dedupKey: `${EVAL_FIXTURE_PREFIX}dedup-rapa-1`,
      metadata: JSON.stringify({ fixture: true }),
    },
    {
      id: `${EVAL_FIXTURE_PREFIX}artifact-rapa-safety`,
      runId,
      stepId,
      kind: "excerpt",
      url: "https://example.com/eval/rapa-safety",
      title: "Rapa safety uncertainty",
      content:
        "evalrapasafety remains an open concern in literature, especially around long-term dosing and adverse events.",
      retrievedAt: t,
      dedupKey: `${EVAL_FIXTURE_PREFIX}dedup-rapa-safety`,
      metadata: JSON.stringify({ fixture: true }),
    },
    {
      id: `${EVAL_FIXTURE_PREFIX}artifact-metformin`,
      runId,
      stepId,
      kind: "claim",
      url: "https://example.com/eval/metformin",
      title: "Metformin healthy-aging review",
      content:
        "evalmetformin evidence is mixed for healthy adults, with stronger support in specific metabolic-risk cohorts.",
      retrievedAt: t,
      dedupKey: `${EVAL_FIXTURE_PREFIX}dedup-metformin`,
      metadata: JSON.stringify({ fixture: true }),
    },
    {
      id: `${EVAL_FIXTURE_PREFIX}artifact-protein`,
      runId,
      stepId,
      kind: "claim",
      url: "https://example.com/eval/protein",
      title: "Protein intake guidance",
      content:
        "evalprotein studies suggest higher intake can support muscle maintenance, with ranges around 1.2 to 1.6 g/kg.",
      retrievedAt: t,
      dedupKey: `${EVAL_FIXTURE_PREFIX}dedup-protein`,
      metadata: JSON.stringify({ fixture: true }),
    },
  ]);
}

function ensureContains(answer: string, mustContain: string[]): string[] {
  const lower = answer.toLowerCase();
  return mustContain.filter((needle) => !lower.includes(needle.toLowerCase())).map((needle) => `missing:${needle}`);
}

async function runEvaluation(cases: GoldenCase[]): Promise<{
  threshold: number;
  runStatus: "passed" | "failed";
  passRate: number;
  summary: { total: number; passed: number; failed: number };
  results: EvaluationCaseResult[];
}> {
  const app = await buildApp();
  await app.ready();
  try {
    const results: EvaluationCaseResult[] = [];
    for (const row of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/qa",
        payload: { question: row.question },
        headers: { "content-type": "application/json" },
      });

      if (res.statusCode !== 200) {
        results.push({
          id: row.id,
          question: row.question,
          passed: false,
          reasons: [`http_status:${res.statusCode}`],
          observed: {
            answer: "",
            confidence: 0,
            sourceTypes: [],
            experienceCitationCount: 0,
            researchCitationCount: 0,
            gaps: [],
          },
        });
        continue;
      }

      const body = JSON.parse(res.body) as {
        answer: string;
        confidence: number;
        gaps: string[];
        citations: Array<{ source_type: string }>;
      };
      const sourceTypes = [...new Set(body.citations.map((citation) => citation.source_type))];
      const experienceCitationCount = body.citations.filter((citation) => citation.source_type === "experience").length;
      const researchCitationCount = body.citations.filter((citation) => citation.source_type === "research").length;

      const meta = row.metadata ?? {};
      const reasons: string[] = [];
      reasons.push(...ensureContains(body.answer, meta.must_contain ?? []));
      for (const required of meta.required_source_types ?? []) {
        if (!sourceTypes.includes(required)) reasons.push(`missing_source_type:${required}`);
      }
      for (const requiredGap of meta.required_gaps ?? []) {
        if (!body.gaps.includes(requiredGap)) reasons.push(`missing_gap:${requiredGap}`);
      }
      for (const forbiddenGap of meta.forbidden_gaps ?? []) {
        if (body.gaps.includes(forbiddenGap)) reasons.push(`forbidden_gap:${forbiddenGap}`);
      }
      if ((meta.minimum_experience_citations ?? 0) > experienceCitationCount) {
        reasons.push(`experience_citations_below_min:${experienceCitationCount}`);
      }
      if ((meta.minimum_research_citations ?? 0) > researchCitationCount) {
        reasons.push(`research_citations_below_min:${researchCitationCount}`);
      }

      results.push({
        id: row.id,
        question: row.question,
        passed: reasons.length === 0,
        reasons,
        observed: {
          answer: body.answer,
          confidence: body.confidence,
          sourceTypes,
          experienceCitationCount,
          researchCitationCount,
          gaps: body.gaps,
        },
      });
    }

    const passed = results.filter((row) => row.passed).length;
    const failed = results.length - passed;
    const threshold = Number(process.env.EVAL_PASS_THRESHOLD ?? DEFAULT_PASS_THRESHOLD);
    const passRate = results.length === 0 ? 0 : passed / results.length;
    return {
      threshold,
      runStatus: passRate >= threshold ? "passed" : "failed",
      passRate,
      summary: { total: results.length, passed, failed },
      results,
    };
  } finally {
    await app.close();
  }
}

async function persistRunResult(input: {
  threshold: number;
  runStatus: "passed" | "failed";
  passRate: number;
  summary: { total: number; passed: number; failed: number };
  results: EvaluationCaseResult[];
}): Promise<{ runId: string; goldenSetVersion: number; trend: Array<Record<string, unknown>> }> {
  const runId = `${EVAL_FIXTURE_PREFIX}eval-run-${now()}`;
  const goldenSummary = await db
    .select({
      goldenSetVersion: sql<number>`coalesce(max(${evaluationGoldenCases.updatedAt}), 0)`,
      activeCaseCount: sql<number>`count(*)`,
    })
    .from(evaluationGoldenCases)
    .where(eq(evaluationGoldenCases.status, "active"))
    .get();
  const goldenSetVersion = Math.max(0, Number(goldenSummary?.goldenSetVersion ?? 0));
  const activeCaseCount = Math.max(0, Number(goldenSummary?.activeCaseCount ?? 0));

  await db.insert(evaluationRuns).values({
    id: runId,
    status: input.runStatus,
    goldenSetVersion,
    goldenCaseCount: activeCaseCount,
    passThreshold: input.threshold,
    caseCount: input.summary.total,
    passedCaseCount: input.summary.passed,
    failedCaseCount: input.summary.failed,
    notes: `automated eval runner (${input.summary.passed}/${input.summary.total} passing)`,
    metadata: JSON.stringify({
      failing_case_ids: input.results.filter((row) => !row.passed).map((row) => row.id),
      pass_rate: input.passRate,
    }),
    createdAt: now(),
  });

  const recent = await db.select().from(evaluationRuns).orderBy(desc(evaluationRuns.createdAt)).limit(20).all();
  const trend = recent.map((row) => ({
    id: row.id,
    status: row.status,
    created_at: row.createdAt,
    case_count: row.caseCount,
    passed_case_count: row.passedCaseCount,
    failed_case_count: row.failedCaseCount,
    pass_threshold: row.passThreshold,
    pass_rate: row.caseCount > 0 ? Number((row.passedCaseCount / row.caseCount).toFixed(4)) : 0,
    golden_set_version: row.goldenSetVersion,
    golden_case_count: row.goldenCaseCount,
  }));

  return { runId, goldenSetVersion, trend };
}

async function writeReports(input: {
  runId: string;
  goldenSetVersion: number;
  threshold: number;
  runStatus: "passed" | "failed";
  passRate: number;
  summary: { total: number; passed: number; failed: number };
  results: EvaluationCaseResult[];
  trend: Array<Record<string, unknown>>;
}): Promise<void> {
  await mkdir(EVAL_REPORT_DIR, { recursive: true });
  await writeFile(
    join(EVAL_REPORT_DIR, "latest-report.json"),
    JSON.stringify(
      {
        run_id: input.runId,
        created_at: now(),
        status: input.runStatus,
        pass_threshold: input.threshold,
        pass_rate: input.passRate,
        golden_set_version: input.goldenSetVersion,
        summary: input.summary,
        results: input.results,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(EVAL_REPORT_DIR, "trend.json"),
    JSON.stringify(
      {
        updated_at: now(),
        series: input.trend,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function commandSeed(datasetPath?: string): Promise<void> {
  runMigrations();
  const cases = await readDataset(datasetPath);
  const synced = await syncGoldenCases(cases);
  console.log(
    JSON.stringify(
      {
        event: "evaluation_seed_complete",
        active_cases: synced.active,
        deactivated_cases: synced.deactivated,
      },
      null,
      2,
    ),
  );
}

async function commandRun(datasetPath?: string): Promise<void> {
  runMigrations();
  const cases = await readDataset(datasetPath);
  await syncGoldenCases(cases);
  await seedEvalFixtures();
  const result = await runEvaluation(cases);
  const persisted = await persistRunResult(result);
  await writeReports({
    ...result,
    ...persisted,
  });

  console.log(
    JSON.stringify(
      {
        event: "evaluation_run_complete",
        run_id: persisted.runId,
        status: result.runStatus,
        pass_rate: result.passRate,
        pass_threshold: result.threshold,
        summary: result.summary,
        report_path: join(EVAL_REPORT_DIR, "latest-report.json"),
        trend_path: join(EVAL_REPORT_DIR, "trend.json"),
      },
      null,
      2,
    ),
  );

  if (result.runStatus !== "passed") {
    process.exitCode = 1;
  }
}

async function commandTrend(): Promise<void> {
  runMigrations();
  const trendRows = await db.select().from(evaluationRuns).orderBy(desc(evaluationRuns.createdAt)).limit(30).all();
  await mkdir(EVAL_REPORT_DIR, { recursive: true });
  await writeFile(
    join(EVAL_REPORT_DIR, "trend.json"),
    JSON.stringify(
      {
        updated_at: now(),
        series: trendRows.map((row) => ({
          id: row.id,
          status: row.status,
          created_at: row.createdAt,
          case_count: row.caseCount,
          passed_case_count: row.passedCaseCount,
          failed_case_count: row.failedCaseCount,
          pass_threshold: row.passThreshold,
          pass_rate: row.caseCount > 0 ? Number((row.passedCaseCount / row.caseCount).toFixed(4)) : 0,
          golden_set_version: row.goldenSetVersion,
          golden_case_count: row.goldenCaseCount,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        event: "evaluation_trend_written",
        trend_path: join(EVAL_REPORT_DIR, "trend.json"),
        series_count: trendRows.length,
      },
      null,
      2,
    ),
  );
}

const command = process.argv[2] ?? "run";
const datasetPathArg = process.argv[3];

if (command === "seed") {
  await commandSeed(datasetPathArg);
} else if (command === "run") {
  await commandRun(datasetPathArg);
} else if (command === "trend") {
  await commandTrend();
} else {
  console.error(`unknown command: ${command}`);
  process.exitCode = 1;
}
