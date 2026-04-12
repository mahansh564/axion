CREATE TABLE `biometric_research_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`purpose` text NOT NULL,
	`requested_by` text NOT NULL,
	`notes` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `biometric_research_proposals_status_idx` ON `biometric_research_proposals` (`status`);--> statement-breakpoint
CREATE INDEX `biometric_research_proposals_updated_idx` ON `biometric_research_proposals` (`updated_at`);--> statement-breakpoint
CREATE TABLE `biometric_review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`review_type` text NOT NULL,
	`decision` text NOT NULL,
	`reviewer` text NOT NULL,
	`rationale` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `biometric_research_proposals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `biometric_review_decisions_proposal_idx` ON `biometric_review_decisions` (`proposal_id`);--> statement-breakpoint
CREATE INDEX `biometric_review_decisions_review_type_idx` ON `biometric_review_decisions` (`review_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `biometric_review_decisions_proposal_review_type_uidx` ON `biometric_review_decisions` (`proposal_id`,`review_type`);