CREATE TABLE `instruments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`name` text,
	`isin` text,
	`sector` text,
	`lot_size` integer,
	`expiry` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instruments_symbol_uq` ON `instruments` (`symbol`);--> statement-breakpoint
CREATE INDEX `instruments_sector_idx` ON `instruments` (`sector`);--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`date` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real NOT NULL,
	`volume` real,
	`source` text DEFAULT 'bhavcopy' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_history_symbol_date_uq` ON `price_history` (`symbol`,`date`);--> statement-breakpoint
CREATE INDEX `price_history_symbol_idx` ON `price_history` (`symbol`);--> statement-breakpoint
CREATE INDEX `price_history_date_idx` ON `price_history` (`date`);