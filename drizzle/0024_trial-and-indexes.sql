ALTER TABLE `settings` ADD `trial_started_at` text;--> statement-breakpoint
CREATE INDEX `trades_is_open_idx` ON `trades` (`is_open`);--> statement-breakpoint
CREATE INDEX `trades_playbook_idx` ON `trades` (`playbook_id`);--> statement-breakpoint
UPDATE `settings` SET `trial_started_at` = datetime('now') WHERE `trial_started_at` IS NULL;
