PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_biometric_research_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`purpose` text NOT NULL,
	`requested_by` text NOT NULL,
	`notes` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "biometric_research_proposals_status_chk" CHECK("__new_biometric_research_proposals"."status" in ('draft', 'submitted', 'approved', 'rejected'))
);
--> statement-breakpoint
INSERT INTO `__new_biometric_research_proposals`("id", "title", "purpose", "requested_by", "notes", "status", "created_at", "updated_at") SELECT "id", "title", "purpose", "requested_by", "notes", "status", "created_at", "updated_at" FROM `biometric_research_proposals`;--> statement-breakpoint
DROP TABLE `biometric_research_proposals`;--> statement-breakpoint
ALTER TABLE `__new_biometric_research_proposals` RENAME TO `biometric_research_proposals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `biometric_research_proposals_status_idx` ON `biometric_research_proposals` (`status`);--> statement-breakpoint
CREATE INDEX `biometric_research_proposals_updated_idx` ON `biometric_research_proposals` (`updated_at`);--> statement-breakpoint
CREATE TABLE `__new_biometric_review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`review_type` text NOT NULL,
	`decision` text NOT NULL,
	`reviewer` text NOT NULL,
	`rationale` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `biometric_research_proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "biometric_review_decisions_review_type_chk" CHECK("__new_biometric_review_decisions"."review_type" in ('ethics', 'legal')),
	CONSTRAINT "biometric_review_decisions_decision_chk" CHECK("__new_biometric_review_decisions"."decision" in ('approved', 'rejected'))
);
--> statement-breakpoint
INSERT INTO `__new_biometric_review_decisions`("id", "proposal_id", "review_type", "decision", "reviewer", "rationale", "created_at") SELECT "id", "proposal_id", "review_type", "decision", "reviewer", "rationale", "created_at" FROM `biometric_review_decisions`;--> statement-breakpoint
DROP TABLE `biometric_review_decisions`;--> statement-breakpoint
ALTER TABLE `__new_biometric_review_decisions` RENAME TO `biometric_review_decisions`;--> statement-breakpoint
CREATE INDEX `biometric_review_decisions_proposal_idx` ON `biometric_review_decisions` (`proposal_id`);--> statement-breakpoint
CREATE INDEX `biometric_review_decisions_review_type_idx` ON `biometric_review_decisions` (`review_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `biometric_review_decisions_proposal_review_type_uidx` ON `biometric_review_decisions` (`proposal_id`,`review_type`);