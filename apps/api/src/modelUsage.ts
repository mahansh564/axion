import { randomUUID } from "node:crypto";

import { and, eq, gte, lte } from "drizzle-orm";

import { db } from "./db/client.js";
import { episodicEvents } from "./db/schema.js";
import { env } from "./env.js";

type PricePer1k = {
  prompt_per_1k_usd: number;
  completion_per_1k_usd: number;
};

const DEFAULT_MODEL_PRICES: Record<string, PricePer1k> = {
  "openai:gpt-4o-mini": {
    prompt_per_1k_usd: 0.00015,
    completion_per_1k_usd: 0.0006,
  },
  "openai:gpt-4o": {
    prompt_per_1k_usd: 0.005,
    completion_per_1k_usd: 0.015,
  },
};

type PriceOverrideMap = Map<string, PricePer1k>;

let cachedPriceOverrides: PriceOverrideMap | null = null;

function now(): number {
  return Date.now();
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored >= 0 ? floored : null;
}

function parsePriceOverrides(raw: string | undefined): PriceOverrideMap {
  if (!raw?.trim()) return new Map();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const overrides = new Map<string, PricePer1k>();
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
      const key = normalizeString(rawKey);
      if (!key) continue;
      if (typeof rawValue !== "object" || rawValue === null) continue;
      const value = rawValue as Record<string, unknown>;
      const prompt = value.prompt_per_1k_usd;
      const completion = value.completion_per_1k_usd;
      if (
        typeof prompt === "number" &&
        Number.isFinite(prompt) &&
        prompt >= 0 &&
        typeof completion === "number" &&
        Number.isFinite(completion) &&
        completion >= 0
      ) {
        overrides.set(key, {
          prompt_per_1k_usd: prompt,
          completion_per_1k_usd: completion,
        });
      }
    }
    return overrides;
  } catch {
    return new Map();
  }
}

function getPriceOverrides(): PriceOverrideMap {
  if (cachedPriceOverrides) return cachedPriceOverrides;
  cachedPriceOverrides = parsePriceOverrides(env.MODEL_PRICE_OVERRIDES_JSON);
  return cachedPriceOverrides;
}

function pricingKey(provider: string | null, modelId: string | null): string | null {
  if (!provider || !modelId) return null;
  return `${provider}:${modelId}`;
}

function resolveModelPricing(provider: string | null, modelId: string | null): PricePer1k | null {
  const key = pricingKey(provider, modelId);
  if (!key) return null;
  const overrides = getPriceOverrides();
  if (overrides.has(key)) return overrides.get(key) ?? null;
  return DEFAULT_MODEL_PRICES[key] ?? null;
}

function estimateCostUsd(input: {
  provider: string | null;
  modelId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}): number | null {
  const pricing = resolveModelPricing(input.provider, input.modelId);
  if (!pricing) return null;

  let promptTokens = input.promptTokens;
  let completionTokens = input.completionTokens;

  if (promptTokens === null && completionTokens === null) return null;

  if (promptTokens === null && completionTokens !== null && input.totalTokens !== null) {
    promptTokens = Math.max(input.totalTokens - completionTokens, 0);
  }
  if (completionTokens === null && promptTokens !== null && input.totalTokens !== null) {
    completionTokens = Math.max(input.totalTokens - promptTokens, 0);
  }
  if (promptTokens === null || completionTokens === null) return null;

  const cost =
    (promptTokens / 1000) * pricing.prompt_per_1k_usd + (completionTokens / 1000) * pricing.completion_per_1k_usd;
  return Number(cost.toFixed(8));
}

export type ModelUsageSnapshot = {
  operation: string;
  provider: string | null;
  model_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
};

function buildUsageSnapshot(input: {
  operation: string;
  provider?: string | null;
  modelId?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}): ModelUsageSnapshot {
  const operation = input.operation.trim().toLowerCase() || "unknown";
  const provider = normalizeString(input.provider ?? null);
  const modelId = normalizeString(input.modelId ?? null);
  const promptTokens = normalizeCount(input.promptTokens ?? null);
  const completionTokens = normalizeCount(input.completionTokens ?? null);
  const totalTokens = normalizeCount(input.totalTokens ?? null);
  const effectiveTotal =
    totalTokens ??
    (promptTokens !== null || completionTokens !== null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : null);

  return {
    operation,
    provider,
    model_id: modelId,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: effectiveTotal,
    estimated_cost_usd: estimateCostUsd({
      provider,
      modelId,
      promptTokens,
      completionTokens,
      totalTokens: effectiveTotal,
    }),
  };
}

export async function recordModelUsageEvent(input: {
  traceId: string;
  operation: string;
  provider?: string | null;
  modelId?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<ModelUsageSnapshot> {
  const usage = buildUsageSnapshot(input);
  const payload: Record<string, unknown> = {
    ...usage,
    ...(input.metadata ?? {}),
  };
  await db.insert(episodicEvents).values({
    id: randomUUID(),
    eventType: "model_usage_recorded",
    traceId: input.traceId,
    payload: JSON.stringify(payload),
    createdAt: now(),
  });
  return usage;
}

type UsageTotals = {
  call_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  costed_call_count: number;
  uncosted_call_count: number;
};

function emptyTotals(): UsageTotals {
  return {
    call_count: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
    costed_call_count: 0,
    uncosted_call_count: 0,
  };
}

function addUsage(totals: UsageTotals, usage: ModelUsageSnapshot): void {
  totals.call_count += 1;
  totals.prompt_tokens += usage.prompt_tokens ?? 0;
  totals.completion_tokens += usage.completion_tokens ?? 0;
  totals.total_tokens += usage.total_tokens ?? 0;
  if (typeof usage.estimated_cost_usd === "number") {
    totals.estimated_cost_usd = Number((totals.estimated_cost_usd + usage.estimated_cost_usd).toFixed(8));
    totals.costed_call_count += 1;
  } else {
    totals.uncosted_call_count += 1;
  }
}

function snapshotFromEventPayload(payload: Record<string, unknown>): ModelUsageSnapshot | null {
  const operation = typeof payload.operation === "string" ? payload.operation : null;
  if (!operation?.trim()) return null;
  return buildUsageSnapshot({
    operation,
    provider: typeof payload.provider === "string" ? payload.provider : null,
    modelId: typeof payload.model_id === "string" ? payload.model_id : null,
    promptTokens: typeof payload.prompt_tokens === "number" ? payload.prompt_tokens : null,
    completionTokens: typeof payload.completion_tokens === "number" ? payload.completion_tokens : null,
    totalTokens: typeof payload.total_tokens === "number" ? payload.total_tokens : null,
  });
}

export async function listModelUsageMetrics(input: {
  sinceMs?: number;
  untilMs?: number;
  traceId?: string;
  operation?: string;
  provider?: string;
  modelId?: string;
}): Promise<{
  filters: {
    since_ms: number | null;
    until_ms: number | null;
    trace_id: string | null;
    operation: string | null;
    provider: string | null;
    model_id: string | null;
  };
  totals: UsageTotals;
  by_provider: Array<{ provider: string | null } & UsageTotals>;
  by_model: Array<{ provider: string | null; model_id: string | null } & UsageTotals>;
  by_operation: Array<{ operation: string } & UsageTotals>;
}> {
  const clauses = [eq(episodicEvents.eventType, "model_usage_recorded")];
  if (typeof input.sinceMs === "number" && Number.isFinite(input.sinceMs)) {
    clauses.push(gte(episodicEvents.createdAt, Math.floor(input.sinceMs)));
  }
  if (typeof input.untilMs === "number" && Number.isFinite(input.untilMs)) {
    clauses.push(lte(episodicEvents.createdAt, Math.floor(input.untilMs)));
  }
  if (input.traceId?.trim()) {
    clauses.push(eq(episodicEvents.traceId, input.traceId.trim()));
  }
  const whereClause = clauses.length === 1 ? clauses[0] : and(...clauses);
  const rows = await db.select().from(episodicEvents).where(whereClause).all();

  const operationFilter = normalizeString(input.operation ?? null);
  const providerFilter = normalizeString(input.provider ?? null);
  const modelFilter = normalizeString(input.modelId ?? null);

  const totals = emptyTotals();
  const byProvider = new Map<string, UsageTotals>();
  const byModel = new Map<string, UsageTotals>();
  const byOperation = new Map<string, UsageTotals>();

  for (const row of rows) {
    const payload = parseJsonObject(row.payload);
    const usage = snapshotFromEventPayload(payload);
    if (!usage) continue;
    if (operationFilter && usage.operation !== operationFilter) continue;
    if (providerFilter && usage.provider !== providerFilter) continue;
    if (modelFilter && usage.model_id !== modelFilter) continue;

    addUsage(totals, usage);

    const providerKey = usage.provider ?? "__null__";
    const providerTotals = byProvider.get(providerKey) ?? emptyTotals();
    addUsage(providerTotals, usage);
    byProvider.set(providerKey, providerTotals);

    const modelKey = `${usage.provider ?? "__null__"}|${usage.model_id ?? "__null__"}`;
    const modelTotals = byModel.get(modelKey) ?? emptyTotals();
    addUsage(modelTotals, usage);
    byModel.set(modelKey, modelTotals);

    const opTotals = byOperation.get(usage.operation) ?? emptyTotals();
    addUsage(opTotals, usage);
    byOperation.set(usage.operation, opTotals);
  }

  const byProviderRows = [...byProvider.entries()]
    .map(([key, value]) => ({
      provider: key === "__null__" ? null : key,
      ...value,
    }))
    .sort((a, b) => b.call_count - a.call_count || (a.provider ?? "").localeCompare(b.provider ?? ""));

  const byModelRows = [...byModel.entries()]
    .map(([key, value]) => {
      const [provider, modelId] = key.split("|");
      return {
        provider: provider === "__null__" ? null : provider,
        model_id: modelId === "__null__" ? null : modelId,
        ...value,
      };
    })
    .sort(
      (a, b) =>
        b.call_count - a.call_count ||
        (a.provider ?? "").localeCompare(b.provider ?? "") ||
        (a.model_id ?? "").localeCompare(b.model_id ?? ""),
    );

  const byOperationRows = [...byOperation.entries()]
    .map(([operation, value]) => ({ operation, ...value }))
    .sort((a, b) => b.call_count - a.call_count || a.operation.localeCompare(b.operation));

  return {
    filters: {
      since_ms: typeof input.sinceMs === "number" ? Math.floor(input.sinceMs) : null,
      until_ms: typeof input.untilMs === "number" ? Math.floor(input.untilMs) : null,
      trace_id: input.traceId?.trim() ? input.traceId.trim() : null,
      operation: operationFilter,
      provider: providerFilter,
      model_id: modelFilter,
    },
    totals,
    by_provider: byProviderRows,
    by_model: byModelRows,
    by_operation: byOperationRows,
  };
}
