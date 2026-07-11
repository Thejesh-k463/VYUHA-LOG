CREATE TABLE `margin_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`segment` text NOT NULL,
	`margin_pct` real NOT NULL,
	`note` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `margin_config_segment_uq` ON `margin_config` (`segment`);