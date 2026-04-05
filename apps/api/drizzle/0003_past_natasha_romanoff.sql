CREATE TABLE `observer_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text,
	`artifact_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`confidence` real,
	`payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `observer_notes_run_idx` ON `observer_notes` (`run_id`);--> statement-breakpoint
CREATE INDEX `observer_notes_kind_idx` ON `observer_notes` (`kind`);--> statement-breakpoint
CREATE INDEX `observer_notes_status_idx` ON `observer_notes` (`status`);--> statement-breakpoint
CREATE TABLE `promotion_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`decision` text NOT NULL,
	`rationale` text,
	`reviewer` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `observer_notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `promotion_reviews_note_idx` ON `promotion_reviews` (`note_id`);--> statement-breakpoint
CREATE INDEX `promotion_reviews_decision_idx` ON `promotion_reviews` (`decision`);