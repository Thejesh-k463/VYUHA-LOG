CREATE TABLE `capital_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bucket` text NOT NULL,
	`as_of_date` text NOT NULL,
	`opening_capital` real DEFAULT 0 NOT NULL,
	`deployed` real DEFAULT 0 NOT NULL,
	`available` real DEFAULT 0 NOT NULL,
	`realised_pnl_to_date` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `charge_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker` text NOT NULL,
	`segment` text NOT NULL,
	`exchange` text NOT NULL,
	`brokerage_flat` real,
	`brokerage_pct` real DEFAULT 0 NOT NULL,
	`brokerage_cap` real,
	`brokerage_floor` real DEFAULT 0 NOT NULL,
	`stt_pct` real DEFAULT 0 NOT NULL,
	`stt_side` text DEFAULT 'none' NOT NULL,
	`exchange_txn_pct` real DEFAULT 0 NOT NULL,
	`sebi_pct` real DEFAULT 0 NOT NULL,
	`stamp_pct` real DEFAULT 0 NOT NULL,
	`ipft_pct` real DEFAULT 0 NOT NULL,
	`gst_pct` real DEFAULT 0.18 NOT NULL,
	`dp_charge` real DEFAULT 0 NOT NULL,
	`dp_gst_applicable` integer DEFAULT false NOT NULL,
	`dp_min_value` real DEFAULT 0 NOT NULL,
	`mtf_interest_annual` real DEFAULT 0 NOT NULL,
	`mtf_tiers` text,
	`pledge_charge` real DEFAULT 0 NOT NULL,
	`unpledge_charge` real DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `charge_config_key_uq` ON `charge_config` (`broker`,`segment`,`exchange`);--> statement-breakpoint
CREATE TABLE `classification_overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker` text NOT NULL,
	`dedup_hash` text NOT NULL,
	`segment` text,
	`bucket` text,
	`exchange` text,
	`is_mtf` integer,
	`setup_tag` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `class_override_uq` ON `classification_overrides` (`broker`,`dedup_hash`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker` text NOT NULL,
	`file_name` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`added_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`imported_at` text DEFAULT (datetime('now')) NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `mtm_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker` text,
	`symbol` text NOT NULL,
	`tradingsymbol` text,
	`price` real NOT NULL,
	`as_of_date` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mtm_symbol_idx` ON `mtm_prices` (`symbol`);--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker` text NOT NULL,
	`bucket` text NOT NULL,
	`segment` text NOT NULL,
	`symbol` text NOT NULL,
	`tradingsymbol` text,
	`expiry` text,
	`strike` real,
	`option_type` text,
	`qty` real DEFAULT 0 NOT NULL,
	`avg_price` real DEFAULT 0 NOT NULL,
	`is_mtf` integer DEFAULT false NOT NULL,
	`funded_amount` real DEFAULT 0 NOT NULL,
	`pledge_date` text,
	`interest_rate` real DEFAULT 0 NOT NULL,
	`accrued_interest` real DEFAULT 0 NOT NULL,
	`last_mtm_price` real,
	`mtm_updated_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `positions_bucket_idx` ON `positions` (`bucket`);--> statement-breakpoint
CREATE TABLE `risk_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`key` text DEFAULT '' NOT NULL,
	`per_trade_max_loss` real,
	`max_open` integer,
	`max_trades_day` integer,
	`daily_loss_stop` real,
	`concentration_pct` real,
	`monthly_target_base` real,
	`monthly_target_stretch` real,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `risk_config_scope_key_uq` ON `risk_config` (`scope`,`key`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`go_live_date` text NOT NULL,
	`equity_capital` real NOT NULL,
	`active_capital` real NOT NULL,
	`theme` text DEFAULT 'dark' NOT NULL,
	`base_currency` text DEFAULT 'INR' NOT NULL,
	`fy_start_month` integer DEFAULT 4 NOT NULL,
	`colorblind_safe` integer DEFAULT false NOT NULL,
	`default_buy_orders` integer DEFAULT 1 NOT NULL,
	`default_sell_orders` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker` text NOT NULL,
	`bucket` text NOT NULL,
	`segment` text NOT NULL,
	`instrument_type` text NOT NULL,
	`exchange` text NOT NULL,
	`symbol` text NOT NULL,
	`tradingsymbol` text NOT NULL,
	`isin` text,
	`expiry` text,
	`strike` real,
	`option_type` text,
	`lot_size` integer,
	`buy_qty` real DEFAULT 0 NOT NULL,
	`avg_buy_price` real DEFAULT 0 NOT NULL,
	`buy_value` real DEFAULT 0 NOT NULL,
	`sell_qty` real DEFAULT 0 NOT NULL,
	`avg_sell_price` real DEFAULT 0 NOT NULL,
	`sell_value` real DEFAULT 0 NOT NULL,
	`closing_price` real,
	`buy_date` text,
	`sell_date` text,
	`entry_time` text,
	`exit_time` text,
	`gross_pnl` real DEFAULT 0 NOT NULL,
	`charges_total` real DEFAULT 0 NOT NULL,
	`net_pnl` real DEFAULT 0 NOT NULL,
	`unrealised_pnl` real DEFAULT 0 NOT NULL,
	`realised_pct` real,
	`is_open` integer DEFAULT false NOT NULL,
	`buy_order_count` integer DEFAULT 1 NOT NULL,
	`sell_order_count` integer DEFAULT 1 NOT NULL,
	`setup_tag` text,
	`notes` text,
	`sl_planned` real,
	`target_planned` real,
	`risk_amount` real,
	`r_multiple` real,
	`rule_violations` text,
	`mistake_tags` text,
	`brokerage` real DEFAULT 0 NOT NULL,
	`stt_ctt` real DEFAULT 0 NOT NULL,
	`exchange_txn` real DEFAULT 0 NOT NULL,
	`sebi` real DEFAULT 0 NOT NULL,
	`stamp_duty` real DEFAULT 0 NOT NULL,
	`ipft` real DEFAULT 0 NOT NULL,
	`gst` real DEFAULT 0 NOT NULL,
	`dp_charges` real DEFAULT 0 NOT NULL,
	`mtf_interest` real DEFAULT 0 NOT NULL,
	`pledge_charges` real DEFAULT 0 NOT NULL,
	`source_file` text,
	`import_batch_id` integer,
	`dedup_hash` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trades_broker_dedup_uq` ON `trades` (`broker`,`dedup_hash`);--> statement-breakpoint
CREATE INDEX `trades_segment_idx` ON `trades` (`segment`);--> statement-breakpoint
CREATE INDEX `trades_bucket_idx` ON `trades` (`bucket`);--> statement-breakpoint
CREATE INDEX `trades_sell_date_idx` ON `trades` (`sell_date`);