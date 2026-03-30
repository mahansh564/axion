CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`experience_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`source_model` text,
	`created_at` integer NOT NULL,
	`metadata` text,
	FOREIGN KEY (`experience_id`) REFERENCES `experience_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_experience_idx` ON `documents` (`experience_id`);--> statement-breakpoint
CREATE TABLE `episodic_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`trace_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `experience_records` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`audio_relpath` text NOT NULL,
	`mime_type` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`src_id` text NOT NULL,
	`dst_id` text NOT NULL,
	`predicate` text NOT NULL,
	`confidence` real,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`document_id` text NOT NULL,
	FOREIGN KEY (`src_id`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dst_id`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_edges_src_idx` ON `graph_edges` (`src_id`);--> statement-breakpoint
CREATE INDEX `graph_edges_dst_idx` ON `graph_edges` (`dst_id`);--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`properties` text,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`document_id` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_nodes_document_idx` ON `graph_nodes` (`document_id`);