-- margin_config was one row PER SEGMENT (broker-agnostic); it's a small,
-- fully-reproducible config table (like charge_config's seed), so the
-- simplest safe migration is to clear the old rows and let the app's
-- idempotent seed step (lib/db/seed-core.ts) insert the new broker×segment
-- rows on next startup — no NOT NULL violation on the ADD COLUMN below.
DELETE FROM `margin_config`;--> statement-breakpoint
DROP INDEX `margin_config_segment_uq`;--> statement-breakpoint
ALTER TABLE `margin_config` ADD `broker` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `margin_config_broker_segment_uq` ON `margin_config` (`broker`,`segment`);