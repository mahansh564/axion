import { and, inArray, or, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import {
  documents,
  EXPERIENCE_RETRIEVAL_DOCUMENT_KINDS,
  graphEdges,
  graphNodes,
  researchArtifacts,
} from "./db/schema.js";

const STOP = new Set([
  "what",
  "did",
  "was",
  "were",
  "the",
  "and",
  "about",
  "that",
  "this",
  "have",
  "has",
  "say",
  "said",
  "tell",
  "with",
  "from",
  "your",
  "you",
  "for",
  "how",
  "why",
  "when",
  "who",
  "which",
]);

const FTS_FALLBACK_ERROR_PATTERNS = [
  "no such table: documents_fts",
  "no such table: research_artifacts_fts",
  "no such module: fts5",
  "unable to use function match",
  "malformed match expression",
] as const;

export function questionKeywords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function scoreBody(body: string, tokens: string[]): number {
  const lower = body.toLowerCase();
  return tokens.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
}

function sanitizeFtsToken(token: string): string | null {
  const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  return normalized.length > 1 ? normalized : null;
}

function buildFtsQuery(tokens: string[]): string | null {
  const normalized = [...new Set(tokens.map(sanitizeFtsToken).filter((token): token is string => Boolean(token)))];
  if (normalized.length === 0) return null;
  return normalized.map((token) => `${token}*`).join(" OR ");
}

function looksLikeFtsUnavailableError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return FTS_FALLBACK_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function scoreFromFtsRank(rank: unknown, tokenCount: number): number {
  if (typeof rank !== "number" || !Number.isFinite(rank)) return 0;
  const nonNegativeRank = Math.max(0, rank);
  return Number((tokenCount / (1 + nonNegativeRank)).toFixed(6));
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clampUnit(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function experienceBoost(kind: string, metadataJson: string | null): number {
  const metadata = parseMetadata(metadataJson);
  const matteredScore = clampUnit(metadata.mattered_score, 0);
  const credibility = clampUnit(metadata.credibility, 0);
  const matteredBoost = matteredScore * 1.5;
  const credibilityBoost = credibility * 1.25;
  if (kind === "highlight_annotation") return matteredBoost + credibilityBoost + 0.25;
  if (kind === "reflection_log") return matteredBoost + credibilityBoost + 0.1;
  return matteredBoost + credibilityBoost;
}

async function findDocumentsForQuestionLike(tokens: string[]): Promise<
  Array<{ id: string; body: string; score: number }>
> {
  if (tokens.length === 0) {
    const rows = await db
      .select({ id: documents.id, body: documents.body, kind: documents.kind, metadata: documents.metadata })
      .from(documents)
      .where(inArray(documents.kind, [...EXPERIENCE_RETRIEVAL_DOCUMENT_KINDS]))
      .limit(20);
    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      score: experienceBoost(r.kind, r.metadata),
    }));
  }

  const conditions = tokens.map((t) => sql`lower(${documents.body}) like ${"%" + t + "%"}`);
  const rows = await db
    .select({ id: documents.id, body: documents.body, kind: documents.kind, metadata: documents.metadata })
    .from(documents)
    .where(and(inArray(documents.kind, [...EXPERIENCE_RETRIEVAL_DOCUMENT_KINDS]), or(...conditions)))
    .limit(100);

  return rows
    .map((r) => {
      const lexicalScore = scoreBody(r.body, tokens);
      if (lexicalScore <= 0) {
        return null;
      }
      return {
        id: r.id,
        body: r.body,
        score: lexicalScore + experienceBoost(r.kind, r.metadata),
      };
    })
    .filter((r): r is { id: string; body: string; score: number } => r !== null)
    .sort((a, b) => b.score - a.score || b.body.length - a.body.length || a.id.localeCompare(b.id))
    .slice(0, 20);
}

async function findDocumentsForQuestionFts(
  tokens: string[],
  ftsQuery: string,
): Promise<Array<{ id: string; body: string; score: number }>> {
  const kinds = sql.join(EXPERIENCE_RETRIEVAL_DOCUMENT_KINDS.map((kind) => sql`${kind}`), sql`, `);
  const rows = await db.all<{
    id: string;
    body: string;
    kind: string;
    metadata: string | null;
    rank: number;
  }>(sql`
    SELECT
      d.id AS id,
      d.body AS body,
      d.kind AS kind,
      d.metadata AS metadata,
      bm25(documents_fts, 1.0) AS rank
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.document_id
    WHERE documents_fts MATCH ${ftsQuery}
      AND d.kind IN (${kinds})
    ORDER BY rank ASC, d.id ASC
    LIMIT 120
  `);

  return rows
    .map((row) => ({
      id: row.id,
      body: row.body,
      score: scoreFromFtsRank(row.rank, tokens.length) + experienceBoost(row.kind, row.metadata),
    }))
    .sort((a, b) => b.score - a.score || b.body.length - a.body.length || a.id.localeCompare(b.id))
    .slice(0, 20);
}

export async function findDocumentsForQuestion(question: string): Promise<
  Array<{ id: string; body: string; score: number }>
> {
  const tokens = questionKeywords(question);
  if (tokens.length === 0) {
    return findDocumentsForQuestionLike(tokens);
  }

  const ftsQuery = buildFtsQuery(tokens);
  if (!ftsQuery) {
    return findDocumentsForQuestionLike(tokens);
  }

  try {
    return await findDocumentsForQuestionFts(tokens, ftsQuery);
  } catch (error) {
    if (looksLikeFtsUnavailableError(error)) {
      return findDocumentsForQuestionLike(tokens);
    }
    throw error;
  }
}

async function findResearchArtifactsForQuestionLike(tokens: string[]): Promise<
  Array<{ id: string; content: string; url: string | null; title: string | null; kind: string; score: number }>
> {
  if (tokens.length === 0) {
    const rows = await db
      .select({
        id: researchArtifacts.id,
        content: researchArtifacts.content,
        url: researchArtifacts.url,
        title: researchArtifacts.title,
        kind: researchArtifacts.kind,
      })
      .from(researchArtifacts)
      .where(or(sql`${researchArtifacts.kind} = ${"claim"}`, sql`${researchArtifacts.kind} = ${"excerpt"}`))
      .limit(20);
    return rows.map((row) => ({ ...row, score: 0 }));
  }

  const conditions = tokens.map(
    (token) =>
      or(
        sql`lower(${researchArtifacts.content}) like ${"%" + token + "%"}`,
        sql`lower(${researchArtifacts.title}) like ${"%" + token + "%"}`,
      ),
  );

  const rows = await db
    .select({
      id: researchArtifacts.id,
      content: researchArtifacts.content,
      url: researchArtifacts.url,
      title: researchArtifacts.title,
      kind: researchArtifacts.kind,
    })
    .from(researchArtifacts)
    .where(
      and(
        or(sql`${researchArtifacts.kind} = ${"claim"}`, sql`${researchArtifacts.kind} = ${"excerpt"}`),
        or(...conditions),
      ),
    )
    .limit(200);

  return rows
    .map((row) => ({
      ...row,
      score: scoreBody(`${row.title ?? ""} ${row.content}`, tokens),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.content.length - a.content.length || a.id.localeCompare(b.id))
    .slice(0, 20);
}

async function findResearchArtifactsForQuestionFts(
  tokens: string[],
  ftsQuery: string,
): Promise<Array<{ id: string; content: string; url: string | null; title: string | null; kind: string; score: number }>> {
  const artifactKinds = sql.join(["claim", "excerpt"].map((kind) => sql`${kind}`), sql`, `);
  const rows = await db.all<{
    id: string;
    content: string;
    url: string | null;
    title: string | null;
    kind: string;
    rank: number;
  }>(sql`
    SELECT
      ra.id AS id,
      ra.content AS content,
      ra.url AS url,
      ra.title AS title,
      ra.kind AS kind,
      bm25(research_artifacts_fts, 1.8, 1.0) AS rank
    FROM research_artifacts_fts
    JOIN research_artifacts ra ON ra.id = research_artifacts_fts.artifact_id
    WHERE research_artifacts_fts MATCH ${ftsQuery}
      AND ra.kind IN (${artifactKinds})
    ORDER BY rank ASC, ra.id ASC
    LIMIT 240
  `);

  return rows
    .map((row) => ({
      id: row.id,
      content: row.content,
      url: row.url,
      title: row.title,
      kind: row.kind,
      score: scoreFromFtsRank(row.rank, tokens.length),
    }))
    .sort((a, b) => b.score - a.score || b.content.length - a.content.length || a.id.localeCompare(b.id))
    .slice(0, 20);
}

export async function findResearchArtifactsForQuestion(question: string): Promise<
  Array<{ id: string; content: string; url: string | null; title: string | null; kind: string; score: number }>
> {
  const tokens = questionKeywords(question);
  if (tokens.length === 0) {
    return findResearchArtifactsForQuestionLike(tokens);
  }

  const ftsQuery = buildFtsQuery(tokens);
  if (!ftsQuery) {
    return findResearchArtifactsForQuestionLike(tokens);
  }

  try {
    return await findResearchArtifactsForQuestionFts(tokens, ftsQuery);
  } catch (error) {
    if (looksLikeFtsUnavailableError(error)) {
      return findResearchArtifactsForQuestionLike(tokens);
    }
    throw error;
  }
}

export async function oneHopNeighbors(documentIds: string[]): Promise<{
  nodes: Array<{ id: string; kind: string; label: string; documentId: string }>;
  edges: Array<{ srcId: string; dstId: string; predicate: string; confidence: number | null }>;
}> {
  if (documentIds.length === 0) return { nodes: [], edges: [] };

  const seedNodes = await db
    .select({
      id: graphNodes.id,
      kind: graphNodes.kind,
      label: graphNodes.label,
      documentId: graphNodes.documentId,
    })
    .from(graphNodes)
    .where(inArray(graphNodes.documentId, documentIds));

  if (seedNodes.length === 0) return { nodes: seedNodes, edges: [] };

  const ids = seedNodes.map((n) => n.id);
  const edgeRows = await db
    .select({
      srcId: graphEdges.srcId,
      dstId: graphEdges.dstId,
      predicate: graphEdges.predicate,
      confidence: graphEdges.confidence,
    })
    .from(graphEdges)
    .where(or(inArray(graphEdges.srcId, ids), inArray(graphEdges.dstId, ids)))
    .limit(200);

  const neighborIds = new Set<string>();
  for (const e of edgeRows) {
    neighborIds.add(e.srcId);
    neighborIds.add(e.dstId);
  }

  const neighborNodes =
    neighborIds.size > 0
      ? await db
          .select({
            id: graphNodes.id,
            kind: graphNodes.kind,
            label: graphNodes.label,
            documentId: graphNodes.documentId,
          })
          .from(graphNodes)
          .where(inArray(graphNodes.id, [...neighborIds]))
      : [];

  return { nodes: neighborNodes, edges: edgeRows };
}

export function excerptAround(body: string, tokens: string[], maxLen = 280): string {
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return body.slice(0, maxLen);
  const start = Math.max(0, idx - 60);
  return body.slice(start, start + maxLen);
}
