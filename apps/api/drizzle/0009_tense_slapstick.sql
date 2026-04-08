PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_experience_records` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`channel` text DEFAULT 'voice' NOT NULL,
	`audio_relpath` text,
	`mime_type` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_experience_records`("id", "created_at", "channel", "audio_relpath", "mime_type") SELECT "id", "created_at", 'voice', "audio_relpath", "mime_type" FROM `experience_records`;--> statement-breakpoint
DROP TABLE `experience_records`;--> statement-breakpoint
ALTER TABLE `__new_experience_records` RENAME TO `experience_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;