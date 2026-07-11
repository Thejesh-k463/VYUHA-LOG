ALTER TABLE `trades` ADD `buy_value_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `sell_value_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `gross_pnl_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `charges_total_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `net_pnl_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `unrealised_pnl_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `risk_amount_paise` integer;--> statement-breakpoint
ALTER TABLE `trades` ADD `brokerage_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `stt_ctt_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `exchange_txn_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `sebi_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `stamp_duty_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `ipft_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `gst_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `dp_charges_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `mtf_interest_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `pledge_charges_paise` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `trades` SET
  `buy_value_paise` = CAST(ROUND(`buy_value` * 100) AS INTEGER),
  `sell_value_paise` = CAST(ROUND(`sell_value` * 100) AS INTEGER),
  `gross_pnl_paise` = CAST(ROUND(`gross_pnl` * 100) AS INTEGER),
  `charges_total_paise` = CAST(ROUND(`charges_total` * 100) AS INTEGER),
  `net_pnl_paise` = CAST(ROUND(`net_pnl` * 100) AS INTEGER),
  `unrealised_pnl_paise` = CAST(ROUND(`unrealised_pnl` * 100) AS INTEGER),
  `risk_amount_paise` = CASE WHEN `risk_amount` IS NULL THEN NULL ELSE CAST(ROUND(`risk_amount` * 100) AS INTEGER) END,
  `brokerage_paise` = CAST(ROUND(`brokerage` * 100) AS INTEGER),
  `stt_ctt_paise` = CAST(ROUND(`stt_ctt` * 100) AS INTEGER),
  `exchange_txn_paise` = CAST(ROUND(`exchange_txn` * 100) AS INTEGER),
  `sebi_paise` = CAST(ROUND(`sebi` * 100) AS INTEGER),
  `stamp_duty_paise` = CAST(ROUND(`stamp_duty` * 100) AS INTEGER),
  `ipft_paise` = CAST(ROUND(`ipft` * 100) AS INTEGER),
  `gst_paise` = CAST(ROUND(`gst` * 100) AS INTEGER),
  `dp_charges_paise` = CAST(ROUND(`dp_charges` * 100) AS INTEGER),
  `mtf_interest_paise` = CAST(ROUND(`mtf_interest` * 100) AS INTEGER),
  `pledge_charges_paise` = CAST(ROUND(`pledge_charges` * 100) AS INTEGER);