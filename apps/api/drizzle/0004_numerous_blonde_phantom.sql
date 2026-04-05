CREATE TABLE `belief_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`belief_id` text NOT NULL,
	`evidence_type` text NOT NULL,
	`ref_id` text,
	`excerpt` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`belief_id`) REFERENCES `belief_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `belief_evidence_belief_idx` ON `belief_evidence` (`belief_id`);--> statement-breakpoint
CREATE INDEX `belief_evidence_type_idx` ON `belief_evidence` (`evidence_type`);--> statement-breakpoint
CREATE INDEX `belief_evidence_ref_idx` ON `belief_evidence` (`ref_id`);--> statement-breakpoint
CREATE TABLE `belief_records` (
	`id` text PRIMARY KEY NOT NULL,
	`statement` text NOT NULL,
	`topic` text NOT NULL,
	`confidence` real NOT NULL,
	`source_kind` text NOT NULL,
	`source_note_id` text,
	`source_document_id` text,
	`supersedes_belief_id` text,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `belief_records_topic_idx` ON `belief_records` (`topic`);--> statement-breakpoint
CREATE INDEX `belief_records_confidence_idx` ON `belief_records` (`confidence`);--> statement-breakpoint
CREATE INDEX `belief_records_valid_to_idx` ON `belief_records` (`valid_to`);--> statement-breakpoint
CREATE INDEX `belief_records_supersedes_idx` ON `belief_records` (`supersedes_belief_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `belief_records_source_note_uidx` ON `belief_records` (`source_note_id`);--> statement-breakpoint
CREATE TABLE `open_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`topic` text NOT NULL,
	`status` text NOT NULL,
	`linked_task_id` text,
	`resolution_belief_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`linked_task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolution_belief_id`) REFERENCES `belief_records`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `open_questions_topic_idx` ON `open_questions` (`topic`);--> statement-breakpoint
CREATE INDEX `open_questions_status_idx` ON `open_questions` (`status`);--> statement-breakpoint
CREATE INDEX `open_questions_task_idx` ON `open_questions` (`linked_task_id`);--> statement-breakpoint
CREATE INDEX `open_questions_resolution_idx` ON `open_questions` (`resolution_belief_id`);