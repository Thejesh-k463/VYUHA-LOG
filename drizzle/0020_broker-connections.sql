CREATE TABLE `broker_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker` text NOT NULL,
	`api_key` text NOT NULL,
	`access_token` text NOT NULL,
	`last_pull_at` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `broker_connections_broker_uq` ON `broker_connections` (`broker`);