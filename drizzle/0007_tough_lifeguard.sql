CREATE TABLE `benchmark_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text DEFAULT 'NIFTY' NOT NULL,
	`date` text NOT NULL,
	`close` real NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_symbol_date_uq` ON `benchmark_prices` (`symbol`,`date`);--> statement-breakpoint
CREATE INDEX `benchmark_symbol_idx` ON `benchmark_prices` (`symbol`);