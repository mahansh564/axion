CREATE VIRTUAL TABLE `documents_fts` USING fts5(
	`document_id` UNINDEXED,
	`kind` UNINDEXED,
	`body`,
	tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE VIRTUAL TABLE `research_artifacts_fts` USING fts5(
	`artifact_id` UNINDEXED,
	`kind` UNINDEXED,
	`title`,
	`content`,
	tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
INSERT INTO `documents_fts`(`document_id`, `kind`, `body`)
SELECT `id`, `kind`, `body` FROM `documents`;--> statement-breakpoint
INSERT INTO `research_artifacts_fts`(`artifact_id`, `kind`, `title`, `content`)
SELECT `id`, `kind`, COALESCE(`title`, ''), `content` FROM `research_artifacts`;--> statement-breakpoint
CREATE TRIGGER `documents_fts_ai` AFTER INSERT ON `documents` BEGIN
	INSERT INTO `documents_fts`(`document_id`, `kind`, `body`)
	VALUES (new.`id`, new.`kind`, new.`body`);
END;--> statement-breakpoint
CREATE TRIGGER `documents_fts_au` AFTER UPDATE ON `documents` BEGIN
	DELETE FROM `documents_fts` WHERE `document_id` = old.`id`;
	INSERT INTO `documents_fts`(`document_id`, `kind`, `body`)
	VALUES (new.`id`, new.`kind`, new.`body`);
END;--> statement-breakpoint
CREATE TRIGGER `documents_fts_ad` AFTER DELETE ON `documents` BEGIN
	DELETE FROM `documents_fts` WHERE `document_id` = old.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `research_artifacts_fts_ai` AFTER INSERT ON `research_artifacts` BEGIN
	INSERT INTO `research_artifacts_fts`(`artifact_id`, `kind`, `title`, `content`)
	VALUES (new.`id`, new.`kind`, COALESCE(new.`title`, ''), new.`content`);
END;--> statement-breakpoint
CREATE TRIGGER `research_artifacts_fts_au` AFTER UPDATE ON `research_artifacts` BEGIN
	DELETE FROM `research_artifacts_fts` WHERE `artifact_id` = old.`id`;
	INSERT INTO `research_artifacts_fts`(`artifact_id`, `kind`, `title`, `content`)
	VALUES (new.`id`, new.`kind`, COALESCE(new.`title`, ''), new.`content`);
END;--> statement-breakpoint
CREATE TRIGGER `research_artifacts_fts_ad` AFTER DELETE ON `research_artifacts` BEGIN
	DELETE FROM `research_artifacts_fts` WHERE `artifact_id` = old.`id`;
END;
