CREATE TABLE `evaluation_golden_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`expected_answer` text NOT NULL,
	`status` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evaluation_golden_cases_status_idx` ON `evaluation_golden_cases` (`status`);--> statement-breakpoint
CREATE INDEX `evaluation_golden_cases_updated_idx` ON `evaluation_golden_cases` (`updated_at`);--> statement-breakpoint
CREATE TABLE `evaluation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`golden_set_version` integer NOT NULL,
	`golden_case_count` integer NOT NULL,
	`pass_threshold` real NOT NULL,
	`case_count` integer NOT NULL,
	`passed_case_count` integer NOT NULL,
	`failed_case_count` integer NOT NULL,
	`notes` text,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evaluation_runs_created_idx` ON `evaluation_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `evaluation_runs_status_idx` ON `evaluation_runs` (`status`);