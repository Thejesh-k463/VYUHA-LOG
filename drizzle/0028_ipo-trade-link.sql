ALTER TABLE `ipos` ADD `trade_id` integer;--> statement-breakpoint
CREATE INDEX `ipos_trade_idx` ON `ipos` (`trade_id`);
