CREATE TABLE `restricted_securities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`category` text NOT NULL,
	`stage` text,
	`note` text,
	`as_of_date` text NOT NULL,
	`source` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `restricted_symbol_idx` ON `restricted_securities` (`symbol`);--> statement-breakpoint
CREATE INDEX `restricted_category_idx` ON `restricted_securities` (`category`);