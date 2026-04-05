PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_belief_records` (
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
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_note_id`) REFERENCES `observer_notes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`supersedes_belief_id`) REFERENCES `belief_records`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_belief_records`("id", "statement", "topic", "confidence", "source_kind", "source_note_id", "source_document_id", "supersedes_belief_id", "valid_from", "valid_to", "metadata", "created_at") SELECT "id", "statement", "topic", "confidence", "source_kind", "source_note_id", "source_document_id", "supersedes_belief_id", "valid_from", "valid_to", "metadata", "created_at" FROM `belief_records`;--> statement-breakpoint
DROP TABLE `belief_records`;--> statement-breakpoint
ALTER TABLE `__new_belief_records` RENAME TO `belief_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `belief_records_topic_idx` ON `belief_records` (`topic`);--> statement-breakpoint
CREATE INDEX `belief_records_confidence_idx` ON `belief_records` (`confidence`);--> statement-breakpoint
CREATE INDEX `belief_records_valid_to_idx` ON `belief_records` (`valid_to`);--> statement-breakpoint
CREATE INDEX `belief_records_supersedes_idx` ON `belief_records` (`supersedes_belief_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `belief_records_source_note_uidx` ON `belief_records` (`source_note_id`);