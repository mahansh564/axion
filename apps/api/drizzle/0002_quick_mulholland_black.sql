CREATE TABLE `execution_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_step_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `execution_steps_run_idx` ON `execution_steps` (`run_id`);--> statement-breakpoint
CREATE INDEX `execution_steps_parent_idx` ON `execution_steps` (`parent_step_id`);--> statement-breakpoint
CREATE INDEX `execution_steps_status_idx` ON `execution_steps` (`status`);--> statement-breakpoint
CREATE TABLE `research_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text,
	`title` text,
	`content` text NOT NULL,
	`retrieved_at` integer NOT NULL,
	`dedup_key` text NOT NULL,
	`metadata` text,
	FOREIGN KEY (`run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `execution_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_artifacts_run_idx` ON `research_artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `research_artifacts_step_idx` ON `research_artifacts` (`step_id`);--> statement-breakpoint
CREATE INDEX `research_artifacts_dedup_idx` ON `research_artifacts` (`dedup_key`);