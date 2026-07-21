CREATE TABLE `trade_legs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trade_id` integer NOT NULL,
	`kind` text NOT NULL,
	`seq` integer DEFAULT 1 NOT NULL,
	`trade_date` text NOT NULL,
	`trade_time` text,
	`qty` real NOT NULL,
	`price` real NOT NULL,
	`sl_planned` real,
	`trailing_sl` real,
	`target_planned` real,
	`charges_total_paise` integer DEFAULT 0 NOT NULL,
	`net_pnl_paise` integer DEFAULT 0 NOT NULL,
	`avg_cost_at_exit` real,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trade_legs_trade_idx` ON `trade_legs` (`trade_id`);--> statement-breakpoint
CREATE INDEX `trade_legs_order_idx` ON `trade_legs` (`trade_id`,`seq`);--> statement-breakpoint
ALTER TABLE `trades` ADD `staged` integer DEFAULT false NOT NULL;