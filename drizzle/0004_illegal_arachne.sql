CREATE TABLE `ledger_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`bucket` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`amount_paise` integer DEFAULT 0 NOT NULL,
	`ref_trade_id` integer,
	`note` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_bucket_idx` ON `ledger_entries` (`bucket`);--> statement-breakpoint
CREATE INDEX `ledger_date_idx` ON `ledger_entries` (`date`);