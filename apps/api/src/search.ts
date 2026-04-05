import { and, inArray, or, sql } from "drizzle-orm";

import { db } from "./db/client.js";
import { documents, graphEdges, graphNodes, researchArtifacts } from "./db/schema.js";

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

export async function findDocumentsForQuestion(question: string): Promise<
  Array<{ id: string; body: string; score: number }>
> {
  const tokens = questionKeywords(question);
  if (tokens.length === 0) {
    const rows = await db.select({ id: documents.id, body: documents.body }).from(documents).limit(20);
    return rows.map((r) => ({ ...r, score: 0 }));
  }

  const conditions = tokens.map((t) => sql`lower(${documents.body}) like ${"%" + t + "%"}`);
  const rows = await db
    .select({ id: documents.id, body: documents.body })
    .from(documents)
    .where(or(...conditions))
    .limit(100);

  return rows
    .map((r) => ({ ...r, score: scoreBody(r.body, tokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.body.length - a.body.length)
    .slice(0, 20);
}

export async function findResearchArtifactsForQuestion(question: string): Promise<
  Array<{ id: string; content: string; url: string | null; title: string | null; kind: string; score: number }>
> {
  const tokens = questionKeywords(question);
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
    .sort((a, b) => b.score - a.score || b.content.length - a.content.length)
    .slice(0, 20);
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
