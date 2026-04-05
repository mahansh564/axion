CREATE TABLE `contradiction_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`candidate_type` text NOT NULL,
	`decision` text NOT NULL,
	`target_belief_id` text,
	`resolution_belief_id` text,
	`observer_note_id` text,
	`rationale` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`target_belief_id`) REFERENCES `belief_records`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolution_belief_id`) REFERENCES `belief_records`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`observer_note_id`) REFERENCES `observer_notes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `contradiction_resolutions_candidate_idx` ON `contradiction_resolutions` (`candidate_id`);--> statement-breakpoint
CREATE INDEX `contradiction_resolutions_decision_idx` ON `contradiction_resolutions` (`decision`);--> statement-breakpoint
CREATE INDEX `contradiction_resolutions_created_idx` ON `contradiction_resolutions` (`created_at`);--> statement-breakpoint
CREATE INDEX `contradiction_resolutions_target_belief_idx` ON `contradiction_resolutions` (`target_belief_id`);--> statement-breakpoint
CREATE INDEX `contradiction_resolutions_resolution_belief_idx` ON `contradiction_resolutions` (`resolution_belief_id`);--> statement-breakpoint
CREATE INDEX `contradiction_resolutions_observer_note_idx` ON `contradiction_resolutions` (`observer_note_id`);