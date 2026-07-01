CREATE TABLE `corporate_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`type` text NOT NULL,
	`ex_date` text NOT NULL,
	`from_units` real,
	`to_units` real,
	`dividend_per_share` real,
	`note` text,
	`applied_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `corporate_actions_symbol_idx` ON `corporate_actions` (`symbol`);--> statement-breakpoint
CREATE INDEX `corporate_actions_ex_date_idx` ON `corporate_actions` (`ex_date`);