ALTER TABLE `charge_config` ADD `plan` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `charge_config` ADD `plan_label` text;--> statement-breakpoint
ALTER TABLE `charge_config` ADD `subscription_monthly` real DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `charge_config_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `charge_config_uq` ON `charge_config` (`broker`,`plan`,`segment`,`exchange`);
