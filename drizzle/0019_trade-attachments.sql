CREATE TABLE `trade_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trade_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`stored_name` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trade_attachments_trade_idx` ON `trade_attachments` (`trade_id`);