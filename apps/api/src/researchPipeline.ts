import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { asc, eq } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  episodicEvents,
  executionRuns,
  executionSteps,
  researchArtifacts,
  researchTasks,
} from "./db/schema.js";
import { emitObserverNotes } from "./observerPipeline.js";
import { questionKeywords } from "./search.js";

function now(): number {
  return Date.now();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return collapseWhitespace(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/gi, '"'),
  );
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? stripHtml(match[1]) : null;
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]?/g) ?? []).map(collapseWhitespace).filter(Boolean);
}

function dedupKey(parts: Array<string | null | undefined>): string {
  return createHash("sha256")
    .update(parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("|"))
    .digest("hex");
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  if (rawUrl.startsWith("//")) {
    rawUrl = `https:${rawUrl}`;
  } else if (rawUrl.startsWith("/")) {
    rawUrl = `https://duckduckgo.com${rawUrl}`;
  }

  try {
    const parsed = new URL(rawUrl);
    const redirect = parsed.searchParams.get("uddg");
    return redirect ? decodeURIComponent(redirect) : rawUrl;
  } catch {
    return rawUrl;
  }
}

function deriveSubquestions(goal: string, notes?: string): string[] {
  const normalizedGoal = collapseWhitespace(goal);
  const base = [
    `What evidence directly addresses ${normalizedGoal}?`,
    `What limitations, uncertainties, or disagreements exist around ${normalizedGoal}?`,
    `What recent summaries or reviews help contextualize ${normalizedGoal}?`,
  ];

  if (notes) {
    base[2] = `How should this research scope account for: ${collapseWhitespace(notes)}?`;
  }

  return [...new Set(base.map(collapseWhitespace))];
}

function pickRelevantSentences(sentences: string[], focus: string): string[] {
  const keywords = questionKeywords(focus);
  if (sentences.length === 0) return [];

  const scored = sentences
    .map((sentence) => {
      const lower = sentence.toLowerCase();
      const score = keywords.reduce((total, keyword) => total + (lower.includes(keyword) ? 1 : 0), 0);
      return { sentence, score };
    })
    .sort((a, b) => b.score - a.score || b.sentence.length - a.sentence.length);

  const winners = scored.filter((item) => item.score > 0).slice(0, 2).map((item) => item.sentence);
  if (winners.length > 0) return winners;
  return sentences.slice(0, 1);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }
  return false;
}

function validateResearchFetchUrl(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme" };
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (!host) return { ok: false, reason: "missing_host" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return { ok: false, reason: "local_hostname" };
  }

  const ipType = isIP(host);
  if (ipType === 4 && isPrivateIpv4(host)) return { ok: false, reason: "private_ipv4" };
  if (ipType === 6 && isPrivateIpv6(host)) return { ok: false, reason: "private_ipv6" };
  return { ok: true };
}

const PROMPT_INJECTION_PATTERNS: Array<{ reason: string; re: RegExp }> = [
  { reason: "instruction_override", re: /\b(ignore|disregard)\b[\s\S]{0,80}\b(previous|prior)\b[\s\S]{0,80}\binstructions?\b/i },
  { reason: "prompt_exfiltration", re: /\b(reveal|leak|show|print|expose)\b[\s\S]{0,80}\b(system|developer|prompt|secret|token|key)\b/i },
  { reason: "role_manipulation", re: /\b(you are|act as|pretend to be)\b[\s\S]{0,80}\b(system|developer|assistant|chatgpt)\b/i },
  { reason: "policy_bypass", re: /\b(bypass|override|disable)\b[\s\S]{0,80}\b(safety|guardrails?|polic(y|ies)|restrictions?)\b/i },
];

function promptInjectionReasons(sentence: string): string[] {
  return PROMPT_INJECTION_PATTERNS.filter((pattern) => pattern.re.test(sentence)).map((pattern) => pattern.reason);
}

type SearchResult = {
  url: string;
  title: string;
};

async function searchWeb(query: string, traceId: string): Promise<SearchResult[]> {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(searchUrl, {
    headers: {
      "user-agent": "AxionResearch/0.1",
      "x-trace-id": traceId,
    },
  });
  if (!response.ok) {
    throw new Error(`search failed: ${response.status}`);
  }

  const html = await response.text();
  const matches = [
    ...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi),
  ];

  return matches
    .map((match) => ({
      url: decodeDuckDuckGoUrl(match[1] ?? ""),
      title: stripHtml(match[2] ?? ""),
    }))
    .filter((result) => result.url.startsWith("http"))
    .slice(0, 3);
}

type FetchedDocument = {
  url: string;
  title: string;
  contentType: string;
  text: string;
  skippedPdf: boolean;
};

async function fetchDocument(url: string, traceId: string): Promise<FetchedDocument> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "AxionResearch/0.1",
      "x-trace-id": traceId,
    },
  });
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/pdf") || /\.pdf($|\?)/i.test(url)) {
    return {
      url,
      title: url,
      contentType,
      text: "",
      skippedPdf: true,
    };
  }

  const html = await response.text();
  return {
    url,
    title: extractTitle(html) ?? url,
    contentType,
    text: stripHtml(html),
    skippedPdf: false,
  };
}

type EventEnvelope = {
  run_id: string;
  step_id: string | null;
  parent_step_id: string | null;
  artifact_refs: string[];
  observer_verdict: null;
  promotion_status: "not_requested";
};

function createEnvelope(
  runId: string,
  stepId: string | null,
  parentStepId: string | null,
  artifactRefs: string[],
): EventEnvelope {
  return {
    run_id: runId,
    step_id: stepId,
    parent_step_id: parentStepId,
    artifact_refs: artifactRefs,
    observer_verdict: null,
    promotion_status: "not_requested",
  };
}

export type ResearchTaskSource = "user" | "open_question";
export type ResearchTriggerMode = "manual" | "overnight";

export type ResearchExecutionPolicy = {
  budget?: {
    max_subquestions?: number;
    max_search_results?: number;
    max_fetches?: number;
    max_artifacts?: number;
    max_runtime_ms?: number;
  };
  allowlist_domains?: string[];
};

export type CreateResearchRunInput = {
  goal: string;
  notes?: string;
  source?: ResearchTaskSource;
  triggerMode?: ResearchTriggerMode;
  metadata?: Record<string, unknown>;
  executionPolicy?: ResearchExecutionPolicy;
  traceId: string;
};

export type CreateResearchRunResult = {
  taskId: string;
  runId: string;
  status: "queued";
  triggerMode: ResearchTriggerMode;
  createdAt: number;
};

export type ExecuteResearchRunResult = {
  runId: string;
  status: "completed" | "failed";
  stepCount: number;
  artifactCount: number;
  completedAt: number;
  error: string | null;
};

type ReplayEvent = {
  id: string;
  event_type: string;
  trace_id: string;
  payload: Record<string, unknown>;
  created_at: number;
};

export type ResearchRunReplay = {
  task: {
    id: string;
    goal: string;
    source: string;
    status: string;
    trigger_mode: string;
    metadata: Record<string, unknown> | null;
    created_at: number;
    updated_at: number;
  };
  run: {
    id: string;
    task_id: string;
    run_kind: string;
    status: string;
    trigger_mode: string;
    trace_id: string;
    input: Record<string, unknown> | null;
    created_at: number;
    started_at: number | null;
    completed_at: number | null;
    error: string | null;
  };
  steps: Array<{
    id: string;
    run_id: string;
    parent_step_id: string | null;
    kind: string;
    title: string;
    status: string;
    input: Record<string, unknown> | null;
    output: Record<string, unknown> | null;
    created_at: number;
    started_at: number | null;
    completed_at: number | null;
    error: string | null;
  }>;
  artifacts: Array<{
    id: string;
    run_id: string;
    step_id: string;
    kind: string;
    url: string | null;
    title: string | null;
    content: string;
    retrieved_at: number;
    dedup_key: string;
    metadata: Record<string, unknown> | null;
  }>;
  events: ReplayEvent[];
};

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored > 0 ? floored : null;
}

function normalizeDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return null;
  if (!/^[a-z0-9.-]+$/.test(candidate)) return null;
  if (!candidate.includes(".")) return null;
  if (candidate.startsWith(".") || candidate.endsWith(".")) return null;
  return candidate;
}

function normalizeExecutionPolicy(policy: ResearchExecutionPolicy | undefined): ResearchExecutionPolicy | undefined {
  if (!policy) return undefined;

  const normalizedBudget = policy.budget
    ? {
        max_subquestions: toPositiveInteger(policy.budget.max_subquestions) ?? undefined,
        max_search_results: toPositiveInteger(policy.budget.max_search_results) ?? undefined,
        max_fetches: toPositiveInteger(policy.budget.max_fetches) ?? undefined,
        max_artifacts: toPositiveInteger(policy.budget.max_artifacts) ?? undefined,
        max_runtime_ms: toPositiveInteger(policy.budget.max_runtime_ms) ?? undefined,
      }
    : undefined;

  const normalizedAllowlist = Array.isArray(policy.allowlist_domains)
    ? [...new Set(policy.allowlist_domains.map((value) => normalizeDomain(value)).filter((value): value is string => !!value))]
    : [];

  const hasBudget = normalizedBudget
    ? Object.values(normalizedBudget).some((value) => typeof value === "number")
    : false;

  if (!hasBudget && normalizedAllowlist.length === 0) {
    return undefined;
  }

  return {
    budget: hasBudget ? normalizedBudget : undefined,
    allowlist_domains: normalizedAllowlist.length > 0 ? normalizedAllowlist : undefined,
  };
}

type ResolvedExecutionPolicy = {
  budget: {
    maxSubquestions: number | null;
    maxSearchResults: number | null;
    maxFetches: number | null;
    maxArtifacts: number | null;
    maxRuntimeMs: number | null;
  };
  allowlistDomains: string[];
};

function resolveExecutionPolicy(input: Record<string, unknown> | null): ResolvedExecutionPolicy {
  const policyRaw =
    typeof input?.execution_policy === "object" && input.execution_policy !== null
      ? (input.execution_policy as Record<string, unknown>)
      : null;

  const budgetRaw =
    policyRaw && typeof policyRaw.budget === "object" && policyRaw.budget !== null
      ? (policyRaw.budget as Record<string, unknown>)
      : null;

  const allowlist = policyRaw?.allowlist_domains;
  const allowlistDomains = Array.isArray(allowlist)
    ? [...new Set(allowlist.map((value) => (typeof value === "string" ? normalizeDomain(value) : null)).filter((value): value is string => !!value))]
    : [];

  return {
    budget: {
      maxSubquestions: toPositiveInteger(budgetRaw?.max_subquestions),
      maxSearchResults: toPositiveInteger(budgetRaw?.max_search_results),
      maxFetches: toPositiveInteger(budgetRaw?.max_fetches),
      maxArtifacts: toPositiveInteger(budgetRaw?.max_artifacts),
      maxRuntimeMs: toPositiveInteger(budgetRaw?.max_runtime_ms),
    },
    allowlistDomains,
  };
}

function hostAllowed(url: string, allowlistDomains: string[]): boolean {
  if (allowlistDomains.length === 0) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowlistDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
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

async function createExecutionStep(input: {
  runId: string;
  parentStepId?: string | null;
  kind: string;
  title: string;
  status: "running" | "completed" | "failed";
  payload?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const stepId = randomUUID();
  const createdAt = now();
  await db.insert(executionSteps).values({
    id: stepId,
    runId: input.runId,
    parentStepId: input.parentStepId ?? null,
    kind: input.kind,
    title: input.title,
    status: input.status,
    input: input.payload ? JSON.stringify(input.payload) : null,
    output: null,
    createdAt,
    startedAt: createdAt,
    completedAt: input.status === "running" ? null : createdAt,
    error: null,
  });
  return { id: stepId };
}

async function finishExecutionStep(input: {
  stepId: string;
  status: "completed" | "failed";
  output?: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  await db
    .update(executionSteps)
    .set({
      status: input.status,
      output: input.output ? JSON.stringify(input.output) : null,
      completedAt: now(),
      error: input.error ?? null,
    })
    .where(eq(executionSteps.id, input.stepId));
}

async function storeArtifact(
  seenKeys: Set<string>,
  input: {
    runId: string;
    stepId: string;
    kind: string;
    url?: string | null;
    title?: string | null;
    content: string;
    metadata?: Record<string, unknown>;
  },
): Promise<string | null> {
  const key = dedupKey([input.kind, input.url ?? "", input.content]);
  if (seenKeys.has(key)) return null;
  seenKeys.add(key);

  const artifactId = randomUUID();
  await db.insert(researchArtifacts).values({
    id: artifactId,
    runId: input.runId,
    stepId: input.stepId,
    kind: input.kind,
    url: input.url ?? null,
    title: input.title ?? null,
    content: input.content,
    retrievedAt: now(),
    dedupKey: key,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });
  return artifactId;
}

async function markRunStatus(input: {
  runId: string;
  status: "running" | "completed" | "failed";
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
}): Promise<void> {
  await db
    .update(executionRuns)
    .set({
      status: input.status,
      error: input.error ?? null,
      startedAt: input.startedAt ?? undefined,
      completedAt: input.completedAt ?? undefined,
    })
    .where(eq(executionRuns.id, input.runId));
}

export function createResearchRun(input: CreateResearchRunInput): CreateResearchRunResult {
  const goal = input.goal.trim();
  if (!goal) {
    throw new Error("goal required");
  }

  const source = input.source ?? "user";
  if (source !== "user" && source !== "open_question") {
    throw new Error("invalid source");
  }

  const notes = input.notes?.trim() ? input.notes.trim() : undefined;
  const triggerMode = input.triggerMode ?? "manual";
  if (triggerMode !== "manual" && triggerMode !== "overnight") {
    throw new Error("invalid trigger mode");
  }

  const normalizedPolicy = normalizeExecutionPolicy(input.executionPolicy);
  const createdAt = now();
  const taskId = randomUUID();
  const runId = randomUUID();
  const status = "queued" as const;
  const metadataPayload: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  };
  if (notes) {
    metadataPayload.notes = notes;
  }
  const metadata = Object.keys(metadataPayload).length > 0 ? JSON.stringify(metadataPayload) : null;
  const normalizedInput: Record<string, unknown> = {
    goal,
    source,
    notes: notes ?? null,
  };
  if (normalizedPolicy) {
    normalizedInput.execution_policy = normalizedPolicy;
  }
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    normalizedInput.metadata = input.metadata;
  }

  db.transaction((tx) => {
    tx.insert(researchTasks)
      .values({
        id: taskId,
        goal,
        source,
        status,
        triggerMode,
        metadata,
        createdAt,
        updatedAt: createdAt,
      })
      .run();

    tx.insert(executionRuns)
      .values({
        id: runId,
        taskId,
        runKind: "research",
        status,
        triggerMode,
        traceId: input.traceId,
        input: JSON.stringify(normalizedInput),
        createdAt,
        startedAt: null,
        completedAt: null,
        error: null,
      })
      .run();

    tx.insert(episodicEvents)
      .values({
        id: randomUUID(),
        eventType: "research_run_requested",
        traceId: input.traceId,
        payload: JSON.stringify({
          task_id: taskId,
          run_id: runId,
          trigger_mode: triggerMode,
          ...normalizedInput,
        }),
        createdAt,
      })
      .run();
  });

  return {
    taskId,
    runId,
    status,
    triggerMode,
    createdAt,
  };
}

export async function executeResearchRun(runId: string, traceId: string): Promise<ExecuteResearchRunResult> {
  const run = await db.select().from(executionRuns).where(eq(executionRuns.id, runId)).get();
  if (!run) {
    throw new Error("run not found");
  }
  if (run.status !== "queued") {
    throw new Error(`run not executable from status ${run.status}`);
  }

  const task = await db.select().from(researchTasks).where(eq(researchTasks.id, run.taskId)).get();
  if (!task) {
    throw new Error("task not found");
  }

  const startedAt = now();
  await markRunStatus({ runId, status: "running", startedAt });
  await db
    .update(researchTasks)
    .set({ status: "running", updatedAt: startedAt })
    .where(eq(researchTasks.id, task.id));

  await writeEvent({
    traceId,
    eventType: "research_run_started",
    payload: {
      ...createEnvelope(runId, null, null, []),
      task_id: task.id,
      goal: task.goal,
      source: task.source,
    },
  });

  const input = parseJsonObject(run.input);
  const executionPolicy = resolveExecutionPolicy(input);
  const notes = typeof input?.notes === "string" ? input.notes : undefined;
  const derivedSubquestions = deriveSubquestions(task.goal, notes);
  const subquestions = executionPolicy.budget.maxSubquestions
    ? derivedSubquestions.slice(0, executionPolicy.budget.maxSubquestions)
    : derivedSubquestions;
  const artifactIds: string[] = [];
  const seenArtifactKeys = new Set<string>();
  const runStartMs = startedAt;
  let remainingSearchBudget = executionPolicy.budget.maxSearchResults;
  let remainingFetchBudget = executionPolicy.budget.maxFetches;
  let remainingArtifactBudget = executionPolicy.budget.maxArtifacts;
  let budgetStopReason: string | null = null;

  const runtimeLimitMs = executionPolicy.budget.maxRuntimeMs;
  const runtimeExceeded = (): boolean =>
    typeof runtimeLimitMs === "number" && runtimeLimitMs > 0 && now() - runStartMs >= runtimeLimitMs;

  const maybeMarkBudgetStop = async (reason: string, detail: Record<string, unknown>): Promise<void> => {
    if (budgetStopReason) return;
    budgetStopReason = reason;
    await writeEvent({
      traceId,
      eventType: "research_budget_guardrail_triggered",
      payload: {
        ...createEnvelope(runId, null, null, artifactIds),
        task_id: task.id,
        trigger_mode: run.triggerMode,
        reason,
        detail,
      },
    });
  };

  const storeArtifactWithBudget = async (entry: Parameters<typeof storeArtifact>[1]): Promise<string | null> => {
    if (typeof remainingArtifactBudget === "number" && remainingArtifactBudget <= 0) {
      await maybeMarkBudgetStop("max_artifacts", { max_artifacts: executionPolicy.budget.maxArtifacts });
      return null;
    }
    const artifactId = await storeArtifact(seenArtifactKeys, entry);
    if (artifactId && typeof remainingArtifactBudget === "number") {
      remainingArtifactBudget -= 1;
    }
    return artifactId;
  };

  try {
    const planStep = await createExecutionStep({
      runId,
      kind: "plan",
      title: "Decompose research goal",
      status: "running",
      payload: {
        goal: task.goal,
        notes: notes ?? null,
      },
    });

    await finishExecutionStep({
      stepId: planStep.id,
      status: "completed",
      output: { subquestions },
    });

    if (derivedSubquestions.length > subquestions.length) {
      await writeEvent({
        traceId,
        eventType: "research_budget_applied",
        payload: {
          ...createEnvelope(runId, planStep.id, null, []),
          task_id: task.id,
          trigger_mode: run.triggerMode,
          reason: "max_subquestions",
          requested_subquestions: derivedSubquestions.length,
          scheduled_subquestions: subquestions.length,
        },
      });
    }

    for (const question of subquestions) {
      if (runtimeExceeded()) {
        await maybeMarkBudgetStop("max_runtime_ms", { max_runtime_ms: runtimeLimitMs });
        break;
      }
      if (typeof remainingSearchBudget === "number" && remainingSearchBudget <= 0) {
        await maybeMarkBudgetStop("max_search_results", {
          max_search_results: executionPolicy.budget.maxSearchResults,
        });
        break;
      }
      if (typeof remainingFetchBudget === "number" && remainingFetchBudget <= 0) {
        await maybeMarkBudgetStop("max_fetches", { max_fetches: executionPolicy.budget.maxFetches });
        break;
      }
      if (typeof remainingArtifactBudget === "number" && remainingArtifactBudget <= 0) {
        await maybeMarkBudgetStop("max_artifacts", { max_artifacts: executionPolicy.budget.maxArtifacts });
        break;
      }

      const searchStep = await createExecutionStep({
        runId,
        parentStepId: planStep.id,
        kind: "search",
        title: question,
        status: "running",
        payload: { query: question },
      });

      const searchResults = await searchWeb(question, traceId);
      let results = searchResults;

      if (executionPolicy.allowlistDomains.length > 0) {
        results = searchResults.filter((result) => hostAllowed(result.url, executionPolicy.allowlistDomains));
        const filteredCount = searchResults.length - results.length;
        if (filteredCount > 0) {
          await writeEvent({
            traceId,
            eventType: "overnight_allowlist_filtered",
            payload: {
              ...createEnvelope(runId, searchStep.id, planStep.id, []),
              task_id: task.id,
              trigger_mode: run.triggerMode,
              question,
              filtered_count: filteredCount,
              allowlist_domains: executionPolicy.allowlistDomains,
            },
          });
        }
      }

      results = results.slice(0, 3);
      if (typeof remainingSearchBudget === "number") {
        const allowed = Math.min(remainingSearchBudget, results.length);
        results = results.slice(0, allowed);
        remainingSearchBudget -= allowed;
      }

      const searchArtifactRefs: string[] = [];

      for (const result of results) {
        const artifactId = await storeArtifactWithBudget({
          runId,
          stepId: searchStep.id,
          kind: "search_result",
          url: result.url,
          title: result.title,
          content: result.title,
          metadata: { query: question },
        });
        if (artifactId) {
          artifactIds.push(artifactId);
          searchArtifactRefs.push(artifactId);
        }
      }

      let fetchTargets = results.slice(0, 2);
      if (typeof remainingFetchBudget === "number") {
        const allowedFetches = Math.min(remainingFetchBudget, fetchTargets.length);
        fetchTargets = fetchTargets.slice(0, allowedFetches);
        remainingFetchBudget -= allowedFetches;
      }
      const blockedUrls: Array<{ url: string; reason: string }> = [];
      const safeFetchTargets: SearchResult[] = [];
      for (const result of fetchTargets) {
        const safeUrl = validateResearchFetchUrl(result.url);
        if (safeUrl.ok) {
          safeFetchTargets.push(result);
          continue;
        }
        blockedUrls.push({ url: result.url, reason: safeUrl.reason });
        await writeEvent({
          traceId,
          eventType: "research_untrusted_url_blocked",
          payload: {
            ...createEnvelope(runId, searchStep.id, planStep.id, searchArtifactRefs),
            task_id: task.id,
            trigger_mode: run.triggerMode,
            question,
            url: result.url,
            reason: safeUrl.reason,
          },
        });
      }

      await finishExecutionStep({
        stepId: searchStep.id,
        status: "completed",
        output: {
          query: question,
          result_count: results.length,
          urls: results.map((result) => result.url),
          fetch_target_count: safeFetchTargets.length,
          blocked_untrusted_count: blockedUrls.length,
          blocked_untrusted_urls: blockedUrls,
        },
      });

      for (const result of safeFetchTargets) {
        if (runtimeExceeded()) {
          await maybeMarkBudgetStop("max_runtime_ms", { max_runtime_ms: runtimeLimitMs });
          break;
        }
        if (typeof remainingArtifactBudget === "number" && remainingArtifactBudget <= 0) {
          await maybeMarkBudgetStop("max_artifacts", { max_artifacts: executionPolicy.budget.maxArtifacts });
          break;
        }

        const fetchStep = await createExecutionStep({
          runId,
          parentStepId: searchStep.id,
          kind: "fetch",
          title: result.title,
          status: "running",
          payload: {
            url: result.url,
            query: question,
          },
        });

        const fetched = await fetchDocument(result.url, traceId);
        if (fetched.skippedPdf) {
          await finishExecutionStep({
            stepId: fetchStep.id,
            status: "completed",
            output: {
              url: fetched.url,
              skipped_pdf: true,
            },
          });
          continue;
        }

        const sentenceCandidates = splitSentences(fetched.text);
        const classifiedSentences = sentenceCandidates.map((sentence) => ({
          sentence,
          reasons: promptInjectionReasons(sentence),
        }));
        const flaggedSentences = classifiedSentences.filter((entry) => entry.reasons.length > 0);
        const flaggedReasons = [...new Set(flaggedSentences.flatMap((entry) => entry.reasons))];
        const safeSentences = classifiedSentences
          .filter((entry) => entry.reasons.length === 0)
          .map((entry) => entry.sentence);
        if (flaggedSentences.length > 0) {
          await writeEvent({
            traceId,
            eventType: "research_prompt_injection_filtered",
            payload: {
              ...createEnvelope(runId, fetchStep.id, searchStep.id, []),
              task_id: task.id,
              question,
              url: fetched.url,
              total_sentence_count: sentenceCandidates.length,
              filtered_sentence_count: flaggedSentences.length,
              reasons: flaggedReasons,
              fully_flagged: safeSentences.length === 0,
            },
          });
        }
        if (safeSentences.length === 0) {
          await finishExecutionStep({
            stepId: fetchStep.id,
            status: "completed",
            output: {
              url: fetched.url,
              title: fetched.title,
              excerpt_count: 0,
              artifact_refs: [],
              prompt_injection: {
                filtered_sentence_count: flaggedSentences.length,
                total_sentence_count: sentenceCandidates.length,
                reasons: flaggedReasons,
                fully_flagged: true,
                skipped_claims: true,
              },
            },
          });
          continue;
        }

        const excerpts = pickRelevantSentences(safeSentences, question);
        const localArtifactRefs: string[] = [];
        for (const excerpt of excerpts) {
          if (runtimeExceeded()) {
            await maybeMarkBudgetStop("max_runtime_ms", { max_runtime_ms: runtimeLimitMs });
            break;
          }

          const excerptArtifactId = await storeArtifactWithBudget({
            runId,
            stepId: fetchStep.id,
            kind: "excerpt",
            url: fetched.url,
            title: fetched.title,
            content: excerpt,
            metadata: { question, content_type: fetched.contentType },
          });
          if (excerptArtifactId) {
            artifactIds.push(excerptArtifactId);
            localArtifactRefs.push(excerptArtifactId);
          }

          const claimArtifactId = await storeArtifactWithBudget({
            runId,
            stepId: fetchStep.id,
            kind: "claim",
            url: fetched.url,
            title: fetched.title,
            content: excerpt,
            metadata: { question },
          });
          if (claimArtifactId) {
            artifactIds.push(claimArtifactId);
            localArtifactRefs.push(claimArtifactId);
            await writeEvent({
              traceId,
              eventType: "claim_committed",
              payload: {
                ...createEnvelope(runId, fetchStep.id, searchStep.id, [claimArtifactId]),
                task_id: task.id,
                statement: excerpt,
                url: fetched.url,
                dedup_key: dedupKey(["claim", fetched.url, excerpt]),
              },
            });
          }
        }

        await finishExecutionStep({
          stepId: fetchStep.id,
          status: "completed",
          output: {
            url: fetched.url,
            title: fetched.title,
            excerpt_count: excerpts.length,
            artifact_refs: localArtifactRefs,
            prompt_injection:
              flaggedSentences.length > 0
                ? {
                    filtered_sentence_count: flaggedSentences.length,
                    total_sentence_count: sentenceCandidates.length,
                    reasons: flaggedReasons,
                    fully_flagged: false,
                  }
                : null,
          },
        });

        if (budgetStopReason) {
          break;
        }
      }

      await writeEvent({
        traceId,
        eventType: "sub_question_resolved",
        payload: {
          ...createEnvelope(runId, searchStep.id, planStep.id, searchArtifactRefs),
          task_id: task.id,
          question,
          urls: results.map((result) => result.url),
        },
      });

      if (budgetStopReason) {
        break;
      }
    }

    const completedAt = now();
    await markRunStatus({ runId, status: "completed", completedAt });
    await db
      .update(researchTasks)
      .set({ status: "completed", updatedAt: completedAt })
      .where(eq(researchTasks.id, task.id));

    const observerNoteCount = await emitObserverNotes(runId);
    const runSteps = await db.select().from(executionSteps).where(eq(executionSteps.runId, runId)).all();
    await writeEvent({
      traceId,
      eventType: "research_run_completed",
      payload: {
        ...createEnvelope(runId, null, null, artifactIds),
        task_id: task.id,
        step_count: runSteps.length,
        artifact_count: artifactIds.length,
        observer_note_count: observerNoteCount,
      },
    });

    return {
      runId,
      status: "completed",
      stepCount: runSteps.length,
      artifactCount: artifactIds.length,
      completedAt,
      error: null,
    };
  } catch (error) {
    const completedAt = now();
    const message = error instanceof Error ? error.message : String(error);
    await markRunStatus({ runId, status: "failed", completedAt, error: message });
    await db
      .update(researchTasks)
      .set({ status: "failed", updatedAt: completedAt })
      .where(eq(researchTasks.id, task.id));
    await writeEvent({
      traceId,
      eventType: "research_run_failed",
      payload: {
        ...createEnvelope(runId, null, null, artifactIds),
        task_id: task.id,
        error: message,
      },
    });
    return {
      runId,
      status: "failed",
      stepCount: 0,
      artifactCount: artifactIds.length,
      completedAt,
      error: message,
    };
  }
}

export async function getResearchRunReplay(runId: string): Promise<ResearchRunReplay | null> {
  const run = await db.select().from(executionRuns).where(eq(executionRuns.id, runId)).get();
  if (!run) return null;

  const task = await db.select().from(researchTasks).where(eq(researchTasks.id, run.taskId)).get();
  if (!task) return null;

  const steps = await db
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.runId, runId))
    .orderBy(asc(executionSteps.createdAt))
    .all();
  const artifacts = await db
    .select()
    .from(researchArtifacts)
    .where(eq(researchArtifacts.runId, runId))
    .orderBy(asc(researchArtifacts.retrievedAt))
    .all();
  const events = (await db.select().from(episodicEvents).orderBy(asc(episodicEvents.createdAt)).all())
    .map((event) => ({
      id: event.id,
      event_type: event.eventType,
      trace_id: event.traceId,
      payload: parseJsonObject(event.payload) ?? {},
      created_at: event.createdAt,
    }))
    .filter((event) => event.payload.run_id === runId);

  return {
    task: {
      id: task.id,
      goal: task.goal,
      source: task.source,
      status: task.status,
      trigger_mode: task.triggerMode,
      metadata: parseJsonObject(task.metadata),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    },
    run: {
      id: run.id,
      task_id: run.taskId,
      run_kind: run.runKind,
      status: run.status,
      trigger_mode: run.triggerMode,
      trace_id: run.traceId,
      input: parseJsonObject(run.input),
      created_at: run.createdAt,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      error: run.error,
    },
    steps: steps.map((step) => ({
      id: step.id,
      run_id: step.runId,
      parent_step_id: step.parentStepId,
      kind: step.kind,
      title: step.title,
      status: step.status,
      input: parseJsonObject(step.input),
      output: parseJsonObject(step.output),
      created_at: step.createdAt,
      started_at: step.startedAt,
      completed_at: step.completedAt,
      error: step.error,
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      run_id: artifact.runId,
      step_id: artifact.stepId,
      kind: artifact.kind,
      url: artifact.url,
      title: artifact.title,
      content: artifact.content,
      retrieved_at: artifact.retrievedAt,
      dedup_key: artifact.dedupKey,
      metadata: parseJsonObject(artifact.metadata),
    })),
    events,
  };
}
