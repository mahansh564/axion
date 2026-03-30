import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const experienceRecords = sqliteTable("experience_records", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  audioRelpath: text("audio_relpath").notNull(),
  mimeType: text("mime_type").notNull(),
});

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    experienceId: text("experience_id")
      .notNull()
      .references(() => experienceRecords.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    sourceModel: text("source_model"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    metadata: text("metadata"),
  },
  (t) => [index("documents_experience_idx").on(t.experienceId)],
);

export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    properties: text("properties"),
    validFrom: integer("valid_from", { mode: "number" }).notNull(),
    validTo: integer("valid_to", { mode: "number" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
  },
  (t) => [index("graph_nodes_document_idx").on(t.documentId)],
);

export const graphEdges = sqliteTable(
  "graph_edges",
  {
    id: text("id").primaryKey(),
    srcId: text("src_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    dstId: text("dst_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    predicate: text("predicate").notNull(),
    confidence: real("confidence"),
    validFrom: integer("valid_from", { mode: "number" }).notNull(),
    validTo: integer("valid_to", { mode: "number" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
  },
  (t) => [index("graph_edges_src_idx").on(t.srcId), index("graph_edges_dst_idx").on(t.dstId)],
);

export const episodicEvents = sqliteTable("episodic_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  traceId: text("trace_id").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});
