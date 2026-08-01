CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`broker` text,
	`account_ref` text,
	`tax_identity` text,
	`equity_capital` real,
	`active_capital` real,
	`is_default` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_uq` ON `accounts` (`name`);
--> statement-breakpoint
INSERT INTO `accounts` (`id`,`name`,`is_default`) VALUES (1,'Primary',true);
--> statement-breakpoint
ALTER TABLE `settings` ADD `selected_account_id` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `trades` ADD `account_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `trades` ADD `entry_iv` real;
--> statement-breakpoint
ALTER TABLE `trades` ADD `exit_iv` real;
--> statement-breakpoint
ALTER TABLE `trades` ADD `entry_dte` integer;
--> statement-breakpoint
ALTER TABLE `trades` ADD `hedge_status` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `expiry_outcome` text;
--> statement-breakpoint
ALTER TABLE `trades` ADD `adjustment_group` text;
--> statement-breakpoint
CREATE INDEX `trades_account_idx` ON `trades` (`account_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `trades_broker_dedup_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `trades_account_broker_dedup_uq` ON `trades` (`account_id`,`broker`,`dedup_hash`);
--> statement-breakpoint
ALTER TABLE `positions` ADD `account_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `capital_snapshots` ADD `account_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `import_batches` ADD `account_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `ledger_entries` ADD `account_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `ipos` ADD `account_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `broker_connections` ADD `account_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `broker_connections_broker_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `broker_connections_account_broker_uq` ON `broker_connections` (`account_id`,`broker`);
--> statement-breakpoint
CREATE TABLE `trading_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer DEFAULT 1 NOT NULL,
	`session_date` text NOT NULL,
	`market` text DEFAULT 'NSE' NOT NULL,
	`planned_symbols` text DEFAULT '[]' NOT NULL,
	`planned_playbook_ids` text DEFAULT '[]' NOT NULL,
	`max_trades` integer,
	`max_loss_paise` integer,
	`cutoff_time` text,
	`thesis` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`review_notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trading_sessions_account_date_uq` ON `trading_sessions` (`account_id`,`session_date`);
--> statement-breakpoint
CREATE INDEX `trading_sessions_date_idx` ON `trading_sessions` (`session_date`);
--> statement-breakpoint
CREATE TABLE `regulatory_rule_packs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`category` text NOT NULL,
	`version` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`title` text NOT NULL,
	`source_title` text NOT NULL,
	`source_url` text NOT NULL,
	`payload` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`reviewed_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `regulatory_rule_pack_code_version_uq` ON `regulatory_rule_packs` (`code`,`version`);
--> statement-breakpoint
CREATE INDEX `regulatory_rule_pack_effective_idx` ON `regulatory_rule_packs` (`effective_from`);
