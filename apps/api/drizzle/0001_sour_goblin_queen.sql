CREATE TABLE `execution_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_kind` text NOT NULL,
	`status` text NOT NULL,
	`trigger_mode` text NOT NULL,
	`trace_id` text NOT NULL,
	`input` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`error` text,
	FOREIGN KEY (`task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `execution_runs_task_idx` ON `execution_runs` (`task_id`);--> statement-breakpoint
CREATE INDEX `execution_runs_status_idx` ON `execution_runs` (`status`);--> statement-breakpoint
CREATE TABLE `research_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`goal` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`trigger_mode` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_tasks_status_idx` ON `research_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `research_tasks_source_idx` ON `research_tasks` (`source`);