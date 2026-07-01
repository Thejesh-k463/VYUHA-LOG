CREATE TABLE `ipos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`broker` text,
	`exchange` text DEFAULT 'NSE' NOT NULL,
	`applied_price` real DEFAULT 0 NOT NULL,
	`lot_size` integer DEFAULT 1 NOT NULL,
	`lots_applied` integer DEFAULT 1 NOT NULL,
	`allotted` integer DEFAULT false NOT NULL,
	`allotted_qty` real DEFAULT 0 NOT NULL,
	`listing_price` real,
	`exit_price` real,
	`applied_date` text,
	`listing_date` text,
	`exit_date` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `pnl_rolled_in` real DEFAULT 0 NOT NULL;