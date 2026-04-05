CREATE TABLE `overnight_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`goal` text NOT NULL,
	`notes` text,
	`hour_utc` integer NOT NULL,
	`minute_utc` integer NOT NULL,
	`budget` text NOT NULL,
	`allowlist_domains` text NOT NULL,
	`status` text NOT NULL,
	`runs_today_date_utc` text,
	`runs_today_count` integer NOT NULL,
	`last_dispatched_at` integer,
	`last_completed_at` integer,
	`last_run_id` text,
	`last_run_status` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`last_run_id`) REFERENCES `execution_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `overnight_schedules_status_idx` ON `overnight_schedules` (`status`);--> statement-breakpoint
CREATE INDEX `overnight_schedules_hour_minute_idx` ON `overnight_schedules` (`hour_utc`,`minute_utc`);--> statement-breakpoint
CREATE INDEX `overnight_schedules_last_run_idx` ON `overnight_schedules` (`last_run_id`);