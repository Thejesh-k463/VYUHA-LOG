CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text DEFAULT (datetime('now')) NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer,
	`action` text NOT NULL,
	`summary` text,
	`before_json` text,
	`after_json` text,
	`source` text DEFAULT 'ui' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity`);