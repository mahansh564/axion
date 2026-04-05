import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import { episodicEvents, evaluationGoldenCases, evaluationRuns, overnightSchedules } from "./db/schema.js";
import { createResearchRun, executeResearchRun } from "./researchPipeline.js";

function now(): number {
  return Date.now();
}

type BudgetShape = {
  max_runs_per_night: number;
  max_subquestions: number;
  max_search_results: number;
  max_fetches: number;
  max_artifacts: number;
  max_runtime_minutes: number;
};

const DEFAULT_BUDGET: BudgetShape = {
  max_runs_per_night: 1,
  max_subquestions: 3,
  max_search_results: 6,
  max_fetches: 3,
  max_artifacts: 20,
  max_runtime_minutes: 15,
};

const MAX_BUDGET: BudgetShape = {
  max_runs_per_night: 5,
  max_subquestions: 8,
  max_search_results: 24,
  max_fetches: 12,
  max_artifacts: 80,
  max_runtime_minutes: 120,
};

function asFinitePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded <= 0) return null;
  return rounded;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeBudget(raw: unknown): BudgetShape {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const maxRuns = asFinitePositiveInt(source.max_runs_per_night);
  const maxSubquestions = asFinitePositiveInt(source.max_subquestions);
  const maxSearchResults = asFinitePositiveInt(source.max_search_results);
  const maxFetches = asFinitePositiveInt(source.max_fetches);
  const maxArtifacts = asFinitePositiveInt(source.max_artifacts);
  const maxRuntimeMinutes = asFinitePositiveInt(source.max_runtime_minutes);

  return {
    max_runs_per_night: clamp(maxRuns ?? DEFAULT_BUDGET.max_runs_per_night, 1, MAX_BUDGET.max_runs_per_night),
    max_subquestions: clamp(maxSubquestions ?? DEFAULT_BUDGET.max_subquestions, 1, MAX_BUDGET.max_subquestions),
    max_search_results: clamp(
      maxSearchResults ?? DEFAULT_BUDGET.max_search_results,
      1,
      MAX_BUDGET.max_search_results,
    ),
    max_fetches: clamp(maxFetches ?? DEFAULT_BUDGET.max_fetches, 1, MAX_BUDGET.max_fetches),
    max_artifacts: clamp(maxArtifacts ?? DEFAULT_BUDGET.max_artifacts, 1, MAX_BUDGET.max_artifacts),
    max_runtime_minutes: clamp(
      maxRuntimeMinutes ?? DEFAULT_BUDGET.max_runtime_minutes,
      1,
      MAX_BUDGET.max_runtime_minutes,
    ),
  };
}

function normalizeDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  if (!value.includes(".")) return null;
  if (value.startsWith(".") || value.endsWith(".")) return null;
  return value;
}

function normalizeAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const deduped = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const normalized = normalizeDomain(value);
    if (normalized) deduped.add(normalized);
  }
  return [...deduped].sort();
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  return {};
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fallthrough
  }
  return [];
}

function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

async function writeEvent(input: {
  traceId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: input.eventType,
    traceId: input.traceId,
    payload: JSON.stringify(input.payload),
    createdAt: now(),
  });
}

function serializeSchedule(row: typeof overnightSchedules.$inferSelect): OvernightSchedule {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    notes: row.notes,
    hour_utc: row.hourUtc,
    minute_utc: row.minuteUtc,
    status: row.status,
    budget: normalizeBudget(parseJsonObject(row.budget)),
    allowlist_domains: normalizeAllowlist(parseJsonArray(row.allowlistDomains)),
    runs_today_date_utc: row.runsTodayDateUtc,
    runs_today_count: row.runsTodayCount,
    last_dispatched_at: row.lastDispatchedAt,
    last_completed_at: row.lastCompletedAt,
    last_run_id: row.lastRunId,
    last_run_status: row.lastRunStatus,
    last_error: row.lastError,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function isDueNow(input: {
  hourUtc: number;
  minuteUtc: number;
  nowMs: number;
}): boolean {
  const nowDate = new Date(input.nowMs);
  const hour = nowDate.getUTCHours();
  const minute = nowDate.getUTCMinutes();
  return hour === input.hourUtc && minute === input.minuteUtc;
}

export type OvernightSchedule = {
  id: string;
  name: string;
  goal: string;
  notes: string | null;
  hour_utc: number;
  minute_utc: number;
  status: string;
  budget: BudgetShape;
  allowlist_domains: string[];
  runs_today_date_utc: string | null;
  runs_today_count: number;
  last_dispatched_at: number | null;
  last_completed_at: number | null;
  last_run_id: string | null;
  last_run_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type CreateOvernightScheduleInput = {
  name: string;
  goal: string;
  notes?: string;
  hourUtc: number;
  minuteUtc: number;
  budget?: unknown;
  allowlistDomains?: unknown;
  status?: string;
};

export async function createOvernightSchedule(input: CreateOvernightScheduleInput): Promise<OvernightSchedule> {
  const name = input.name.trim();
  const goal = input.goal.trim();
  const notes = input.notes?.trim() ? input.notes.trim() : null;
  const hourUtc = Math.floor(input.hourUtc);
  const minuteUtc = Math.floor(input.minuteUtc);

  if (!name) throw new Error("name required");
  if (!goal) throw new Error("goal required");
  if (!Number.isFinite(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new Error("hour_utc must be between 0 and 23");
  }
  if (!Number.isFinite(minuteUtc) || minuteUtc < 0 || minuteUtc > 59) {
    throw new Error("minute_utc must be between 0 and 59");
  }

  const status = input.status === "paused" ? "paused" : "active";
  const budget = normalizeBudget(input.budget);
  const allowlistDomains = normalizeAllowlist(input.allowlistDomains);

  const createdAt = now();
  const id = randomUUID();
  await db.insert(overnightSchedules).values({
    id,
    name,
    goal,
    notes,
    hourUtc,
    minuteUtc,
    budget: JSON.stringify(budget),
    allowlistDomains: JSON.stringify(allowlistDomains),
    status,
    runsTodayDateUtc: null,
    runsTodayCount: 0,
    lastDispatchedAt: null,
    lastCompletedAt: null,
    lastRunId: null,
    lastRunStatus: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  });

  return {
    id,
    name,
    goal,
    notes,
    hour_utc: hourUtc,
    minute_utc: minuteUtc,
    status,
    budget,
    allowlist_domains: allowlistDomains,
    runs_today_date_utc: null,
    runs_today_count: 0,
    last_dispatched_at: null,
    last_completed_at: null,
    last_run_id: null,
    last_run_status: null,
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export async function listOvernightSchedules(input?: { status?: string }): Promise<{ schedules: OvernightSchedule[] }> {
  const status = input?.status?.trim().toLowerCase();
  const query = db.select().from(overnightSchedules).orderBy(asc(overnightSchedules.createdAt));

  const rows =
    status === "active" || status === "paused"
      ? await query.where(eq(overnightSchedules.status, status)).all()
      : await query.all();

  return {
    schedules: rows.map(serializeSchedule),
  };
}

type DispatchScheduleResult = {
  schedule_id: string;
  status: "completed" | "failed" | "skipped";
  run_id: string | null;
  reason: string | null;
};

type EvaluationGateSnapshot = {
  golden_set_version: number;
  active_golden_case_count: number;
  latest_evaluation: {
    id: string;
    status: string;
    golden_set_version: number;
    golden_case_count: number;
    pass_threshold: number;
    case_count: number;
    passed_case_count: number;
    failed_case_count: number;
    created_at: number;
  } | null;
};

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function getEvaluationGateSnapshot(): Promise<EvaluationGateSnapshot> {
  const summaryRow = await db
    .select({
      count: sql<number>`count(*)`,
      goldenSetVersion: sql<number>`coalesce(max(${evaluationGoldenCases.updatedAt}), 0)`,
    })
    .from(evaluationGoldenCases)
    .where(eq(evaluationGoldenCases.status, "active"))
    .get();
  const activeGoldenCaseCount = Math.max(0, Math.floor(asNumber(summaryRow?.count)));
  const goldenSetVersion = Math.max(0, Math.floor(asNumber(summaryRow?.goldenSetVersion)));
  const latestEvaluation = await db.select().from(evaluationRuns).orderBy(desc(evaluationRuns.createdAt)).get();
  return {
    golden_set_version: goldenSetVersion,
    active_golden_case_count: activeGoldenCaseCount,
    latest_evaluation: latestEvaluation
      ? {
          id: latestEvaluation.id,
          status: latestEvaluation.status,
          golden_set_version: latestEvaluation.goldenSetVersion,
          golden_case_count: latestEvaluation.goldenCaseCount,
          pass_threshold: latestEvaluation.passThreshold,
          case_count: latestEvaluation.caseCount,
          passed_case_count: latestEvaluation.passedCaseCount,
          failed_case_count: latestEvaluation.failedCaseCount,
          created_at: latestEvaluation.createdAt,
        }
      : null,
  };
}

function getEvaluationGateBlockReason(snapshot: EvaluationGateSnapshot): string | null {
  if (snapshot.active_golden_case_count === 0) return null;
  if (!snapshot.latest_evaluation) return "missing_evaluation_run";
  if (snapshot.latest_evaluation.golden_set_version !== snapshot.golden_set_version) {
    return "evaluation_run_missing_golden_set_revision";
  }
  if (snapshot.latest_evaluation.golden_case_count !== snapshot.active_golden_case_count) {
    return "evaluation_run_missing_golden_cases";
  }
  if (snapshot.latest_evaluation.case_count <= 0) return "evaluation_run_has_no_cases";
  if (snapshot.latest_evaluation.case_count < snapshot.active_golden_case_count) {
    return "evaluation_run_has_incomplete_results";
  }
  if (snapshot.latest_evaluation.status !== "passed") return "latest_evaluation_failed";
  const passRate = snapshot.latest_evaluation.passed_case_count / snapshot.latest_evaluation.case_count;
  if (passRate < snapshot.latest_evaluation.pass_threshold) return "latest_evaluation_below_threshold";
  return null;
}

function budgetExecutionPolicy(budget: BudgetShape): {
  max_subquestions: number;
  max_search_results: number;
  max_fetches: number;
  max_artifacts: number;
  max_runtime_ms: number;
} {
  return {
    max_subquestions: budget.max_subquestions,
    max_search_results: budget.max_search_results,
    max_fetches: budget.max_fetches,
    max_artifacts: budget.max_artifacts,
    max_runtime_ms: budget.max_runtime_minutes * 60_000,
  };
}

async function dispatchSchedule(input: {
  schedule: typeof overnightSchedules.$inferSelect;
  traceId: string;
  force: boolean;
  attended: boolean;
  nowMs: number;
}): Promise<DispatchScheduleResult> {
  const schedule = input.schedule;
  const budget = normalizeBudget(parseJsonObject(schedule.budget));
  const allowlistDomains = normalizeAllowlist(parseJsonArray(schedule.allowlistDomains));
  const todayKey = utcDateKey(input.nowMs);
  const runsTodayCount = schedule.runsTodayDateUtc === todayKey ? schedule.runsTodayCount : 0;

  if (!input.force && !isDueNow({ hourUtc: schedule.hourUtc, minuteUtc: schedule.minuteUtc, nowMs: input.nowMs })) {
    await writeEvent({
      traceId: input.traceId,
      eventType: "overnight_schedule_skipped",
      payload: {
        schedule_id: schedule.id,
        reason: "not_due",
        due_at_utc: `${String(schedule.hourUtc).padStart(2, "0")}:${String(schedule.minuteUtc).padStart(2, "0")}`,
      },
    });
    return {
      schedule_id: schedule.id,
      status: "skipped",
      run_id: null,
      reason: "not_due",
    };
  }

  if (runsTodayCount >= budget.max_runs_per_night) {
    await writeEvent({
      traceId: input.traceId,
      eventType: "overnight_schedule_skipped",
      payload: {
        schedule_id: schedule.id,
        reason: "max_runs_per_night_reached",
        max_runs_per_night: budget.max_runs_per_night,
        runs_today_count: runsTodayCount,
      },
    });
    return {
      schedule_id: schedule.id,
      status: "skipped",
      run_id: null,
      reason: "max_runs_per_night_reached",
    };
  }

  if (!input.attended) {
    const gateSnapshot = await getEvaluationGateSnapshot();
    const gateBlockReason = getEvaluationGateBlockReason(gateSnapshot);
    if (gateBlockReason) {
      await writeEvent({
        traceId: input.traceId,
        eventType: "overnight_schedule_skipped",
        payload: {
          schedule_id: schedule.id,
          reason: "evaluation_gate_blocked",
          gate_reason: gateBlockReason,
          evaluation_gate: gateSnapshot,
        },
      });
      return {
        schedule_id: schedule.id,
        status: "skipped",
        run_id: null,
        reason: "evaluation_gate_blocked",
      };
    }
  }

  const requestedAt = now();
  const claimCondition = and(
    eq(overnightSchedules.id, schedule.id),
    eq(overnightSchedules.status, "active"),
    eq(overnightSchedules.updatedAt, schedule.updatedAt),
    schedule.runsTodayDateUtc === null
      ? isNull(overnightSchedules.runsTodayDateUtc)
      : eq(overnightSchedules.runsTodayDateUtc, schedule.runsTodayDateUtc),
    eq(overnightSchedules.runsTodayCount, schedule.runsTodayCount),
  );
  const claim = await db
    .update(overnightSchedules)
    .set({
      runsTodayDateUtc: todayKey,
      runsTodayCount: runsTodayCount + 1,
      lastDispatchedAt: requestedAt,
      lastCompletedAt: null,
      lastRunId: null,
      lastRunStatus: "running",
      lastError: null,
      updatedAt: requestedAt,
    })
    .where(claimCondition)
    .run();

  if (claim.changes === 0) {
    await writeEvent({
      traceId: input.traceId,
      eventType: "overnight_schedule_skipped",
      payload: {
        schedule_id: schedule.id,
        reason: "claim_conflict",
      },
    });
    return {
      schedule_id: schedule.id,
      status: "skipped",
      run_id: null,
      reason: "claim_conflict",
    };
  }

  let created: ReturnType<typeof createResearchRun> | null = null;
  try {
    created = createResearchRun({
      goal: schedule.goal,
      notes: schedule.notes ?? undefined,
      source: "user",
      traceId: input.traceId,
      triggerMode: "overnight",
      metadata: {
        overnight_schedule_id: schedule.id,
        overnight_schedule_name: schedule.name,
      },
      executionPolicy: {
        budget: budgetExecutionPolicy(budget),
        allowlist_domains: allowlistDomains,
      },
    });

    await db
      .update(overnightSchedules)
      .set({
        lastRunId: created.runId,
        lastRunStatus: "running",
        updatedAt: now(),
      })
      .where(eq(overnightSchedules.id, schedule.id));

    await writeEvent({
      traceId: input.traceId,
      eventType: "overnight_run_scheduled",
      payload: {
        schedule_id: schedule.id,
        run_id: created.runId,
        task_id: created.taskId,
        budget,
        allowlist_domains: allowlistDomains,
        requested_at: requestedAt,
      },
    });

    const result = await executeResearchRun(created.runId, input.traceId);
    const updatedAt = now();
    await db
      .update(overnightSchedules)
      .set({
        lastCompletedAt: result.completedAt,
        lastRunId: created.runId,
        lastRunStatus: result.status,
        lastError: result.error,
        updatedAt,
      })
      .where(eq(overnightSchedules.id, schedule.id));

    await writeEvent({
      traceId: input.traceId,
      eventType: "overnight_run_completed",
      payload: {
        schedule_id: schedule.id,
        run_id: created.runId,
        task_id: created.taskId,
        status: result.status,
        step_count: result.stepCount,
        artifact_count: result.artifactCount,
        error: result.error,
      },
    });

    return {
      schedule_id: schedule.id,
      status: result.status,
      run_id: created.runId,
      reason: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = now();
    await db
      .update(overnightSchedules)
      .set({
        lastCompletedAt: completedAt,
        lastRunId: created?.runId ?? null,
        lastRunStatus: "failed",
        lastError: message,
        updatedAt: completedAt,
      })
      .where(eq(overnightSchedules.id, schedule.id));

    await writeEvent({
      traceId: input.traceId,
      eventType: "overnight_run_completed",
      payload: {
        schedule_id: schedule.id,
        run_id: created?.runId ?? null,
        task_id: created?.taskId ?? null,
        status: "failed",
        step_count: 0,
        artifact_count: 0,
        error: message,
      },
    });

    return {
      schedule_id: schedule.id,
      status: "failed",
      run_id: created?.runId ?? null,
      reason: message,
    };
  }
}

export async function dispatchOvernightSchedules(input: {
  traceId: string;
  force?: boolean;
  scheduleId?: string;
  attended?: boolean;
}): Promise<{
  started_at: number;
  completed_at: number;
  force: boolean;
  schedule_count: number;
  results: DispatchScheduleResult[];
}> {
  const startedAt = now();
  const force = input.force ?? false;
  const attended = input.attended ?? false;

  const rows = await db
    .select()
    .from(overnightSchedules)
    .where(eq(overnightSchedules.status, "active"))
    .orderBy(asc(overnightSchedules.createdAt))
    .all();

  const filteredRows = input.scheduleId ? rows.filter((row) => row.id === input.scheduleId) : rows;

  await writeEvent({
    traceId: input.traceId,
    eventType: "overnight_scheduler_run_started",
    payload: {
      force,
      selected_schedule_count: filteredRows.length,
      schedule_id: input.scheduleId ?? null,
    },
  });

  const results: DispatchScheduleResult[] = [];
  for (const schedule of filteredRows) {
    results.push(
      await dispatchSchedule({
        schedule,
        traceId: input.traceId,
        force,
        attended,
        nowMs: startedAt,
      }),
    );
  }

  const completedAt = now();
  await writeEvent({
    traceId: input.traceId,
    eventType: "overnight_scheduler_run_completed",
    payload: {
      force,
      schedule_count: filteredRows.length,
      completed_count: results.filter((result) => result.status === "completed").length,
      failed_count: results.filter((result) => result.status === "failed").length,
      skipped_count: results.filter((result) => result.status === "skipped").length,
      run_ids: results.map((result) => result.run_id).filter((value): value is string => typeof value === "string"),
    },
  });

  return {
    started_at: startedAt,
    completed_at: completedAt,
    force,
    schedule_count: filteredRows.length,
    results,
  };
}
