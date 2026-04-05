import { AnySQLiteColumn, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const researchTasks = sqliteTable(
  "research_tasks",
  {
    id: text("id").primaryKey(),
    goal: text("goal").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    triggerMode: text("trigger_mode").notNull(),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("research_tasks_status_idx").on(t.status), index("research_tasks_source_idx").on(t.source)],
);

export const executionRuns = sqliteTable(
  "execution_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    runKind: text("run_kind").notNull(),
    status: text("status").notNull(),
    triggerMode: text("trigger_mode").notNull(),
    traceId: text("trace_id").notNull(),
    input: text("input"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    startedAt: integer("started_at", { mode: "number" }),
    completedAt: integer("completed_at", { mode: "number" }),
    error: text("error"),
  },
  (t) => [index("execution_runs_task_idx").on(t.taskId), index("execution_runs_status_idx").on(t.status)],
);

export const executionSteps = sqliteTable(
  "execution_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "cascade" }),
    parentStepId: text("parent_step_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    input: text("input"),
    output: text("output"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    startedAt: integer("started_at", { mode: "number" }),
    completedAt: integer("completed_at", { mode: "number" }),
    error: text("error"),
  },
  (t) => [
    index("execution_steps_run_idx").on(t.runId),
    index("execution_steps_parent_idx").on(t.parentStepId),
    index("execution_steps_status_idx").on(t.status),
  ],
);

export const researchArtifacts = sqliteTable(
  "research_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "cascade" }),
    stepId: text("step_id")
      .notNull()
      .references(() => executionSteps.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    url: text("url"),
    title: text("title"),
    content: text("content").notNull(),
    retrievedAt: integer("retrieved_at", { mode: "number" }).notNull(),
    dedupKey: text("dedup_key").notNull(),
    metadata: text("metadata"),
  },
  (t) => [
    index("research_artifacts_run_idx").on(t.runId),
    index("research_artifacts_step_idx").on(t.stepId),
    index("research_artifacts_dedup_idx").on(t.dedupKey),
  ],
);

export const observerNotes = sqliteTable(
  "observer_notes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => executionRuns.id, { onDelete: "cascade" }),
    stepId: text("step_id"),
    artifactId: text("artifact_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    confidence: real("confidence"),
    payload: text("payload"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("observer_notes_run_idx").on(t.runId),
    index("observer_notes_kind_idx").on(t.kind),
    index("observer_notes_status_idx").on(t.status),
  ],
);

export const promotionReviews = sqliteTable(
  "promotion_reviews",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id")
      .notNull()
      .references(() => observerNotes.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    rationale: text("rationale"),
    reviewer: text("reviewer").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("promotion_reviews_note_idx").on(t.noteId), index("promotion_reviews_decision_idx").on(t.decision)],
);

export const beliefRecords = sqliteTable(
  "belief_records",
  {
    id: text("id").primaryKey(),
    statement: text("statement").notNull(),
    topic: text("topic").notNull(),
    confidence: real("confidence").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceNoteId: text("source_note_id").references(() => observerNotes.id, { onDelete: "set null" }),
    sourceDocumentId: text("source_document_id").references(() => documents.id, { onDelete: "set null" }),
    supersedesBeliefId: text("supersedes_belief_id").references((): AnySQLiteColumn => beliefRecords.id, {
      onDelete: "set null",
    }),
    validFrom: integer("valid_from", { mode: "number" }).notNull(),
    validTo: integer("valid_to", { mode: "number" }),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("belief_records_topic_idx").on(t.topic),
    index("belief_records_confidence_idx").on(t.confidence),
    index("belief_records_valid_to_idx").on(t.validTo),
    index("belief_records_supersedes_idx").on(t.supersedesBeliefId),
    uniqueIndex("belief_records_source_note_uidx").on(t.sourceNoteId),
  ],
);

export const beliefEvidence = sqliteTable(
  "belief_evidence",
  {
    id: text("id").primaryKey(),
    beliefId: text("belief_id")
      .notNull()
      .references(() => beliefRecords.id, { onDelete: "cascade" }),
    evidenceType: text("evidence_type").notNull(),
    refId: text("ref_id"),
    excerpt: text("excerpt"),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("belief_evidence_belief_idx").on(t.beliefId),
    index("belief_evidence_type_idx").on(t.evidenceType),
    index("belief_evidence_ref_idx").on(t.refId),
  ],
);

export const contradictionResolutions = sqliteTable(
  "contradiction_resolutions",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id").notNull(),
    candidateType: text("candidate_type").notNull(),
    decision: text("decision").notNull(),
    targetBeliefId: text("target_belief_id").references(() => beliefRecords.id, { onDelete: "set null" }),
    resolutionBeliefId: text("resolution_belief_id").references(() => beliefRecords.id, { onDelete: "set null" }),
    observerNoteId: text("observer_note_id").references(() => observerNotes.id, { onDelete: "set null" }),
    rationale: text("rationale"),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("contradiction_resolutions_candidate_idx").on(t.candidateId),
    index("contradiction_resolutions_decision_idx").on(t.decision),
    index("contradiction_resolutions_created_idx").on(t.createdAt),
    index("contradiction_resolutions_target_belief_idx").on(t.targetBeliefId),
    index("contradiction_resolutions_resolution_belief_idx").on(t.resolutionBeliefId),
    index("contradiction_resolutions_observer_note_idx").on(t.observerNoteId),
  ],
);

export const openQuestions = sqliteTable(
  "open_questions",
  {
    id: text("id").primaryKey(),
    question: text("question").notNull(),
    topic: text("topic").notNull(),
    status: text("status").notNull(),
    linkedTaskId: text("linked_task_id").references(() => researchTasks.id, { onDelete: "set null" }),
    resolutionBeliefId: text("resolution_belief_id").references(() => beliefRecords.id, { onDelete: "set null" }),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("open_questions_topic_idx").on(t.topic),
    index("open_questions_status_idx").on(t.status),
    index("open_questions_task_idx").on(t.linkedTaskId),
    index("open_questions_resolution_idx").on(t.resolutionBeliefId),
  ],
);

export const overnightSchedules = sqliteTable(
  "overnight_schedules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    goal: text("goal").notNull(),
    notes: text("notes"),
    hourUtc: integer("hour_utc", { mode: "number" }).notNull(),
    minuteUtc: integer("minute_utc", { mode: "number" }).notNull(),
    budget: text("budget").notNull(),
    allowlistDomains: text("allowlist_domains").notNull(),
    status: text("status").notNull(),
    runsTodayDateUtc: text("runs_today_date_utc"),
    runsTodayCount: integer("runs_today_count", { mode: "number" }).notNull(),
    lastDispatchedAt: integer("last_dispatched_at", { mode: "number" }),
    lastCompletedAt: integer("last_completed_at", { mode: "number" }),
    lastRunId: text("last_run_id").references(() => executionRuns.id, { onDelete: "set null" }),
    lastRunStatus: text("last_run_status"),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("overnight_schedules_status_idx").on(t.status),
    index("overnight_schedules_hour_minute_idx").on(t.hourUtc, t.minuteUtc),
    index("overnight_schedules_last_run_idx").on(t.lastRunId),
  ],
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
