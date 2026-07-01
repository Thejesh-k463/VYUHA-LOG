CREATE TABLE `symbol_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alias` text NOT NULL,
	`ticker` text NOT NULL,
	`isin` text,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbol_alias_uq` ON `symbol_aliases` (`alias`);