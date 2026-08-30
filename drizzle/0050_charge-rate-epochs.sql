-- Effective-dated charge rates.
--
-- WHY: `charge_config_uq` was (broker, plan, segment, exchange) with no time
-- dimension, so exactly one rate row existed per key and EVERY trade — of every
-- vintage — was priced at whatever that row holds today. Statutory rates change
-- (STT has moved more than once), so a book spanning a change was being priced
-- wholly at the newer regime. `/reports/broker-compare` (Pro) re-prices the whole
-- book and is directly affected; `/reports/charges` accumulates the charges stored
-- at commit time, so it is affected only through what future imports write.
--
-- SAFETY: every existing row is stamped `effective_from = '1970-01-01'` and an
-- open `effective_to`, so after this migration each key still covers all dates
-- and NOTHING re-prices. Behaviour is byte-identical until a second, dated epoch
-- is deliberately added. That is the point: this migration only creates the
-- CAPACITY to be correct about time; it changes no number on its own.
--
-- Dates are inclusive-from / exclusive-to, so adjacent epochs abut without
-- overlapping and a boundary date belongs to exactly one epoch.

ALTER TABLE `charge_config` ADD `effective_from` text NOT NULL DEFAULT '1970-01-01';
--> statement-breakpoint
ALTER TABLE `charge_config` ADD `effective_to` text;
--> statement-breakpoint
DROP INDEX IF EXISTS `charge_config_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `charge_config_uq` ON `charge_config` (`broker`,`plan`,`segment`,`exchange`,`effective_from`);
--> statement-breakpoint
CREATE INDEX `charge_config_window_idx` ON `charge_config` (`broker`,`plan`,`segment`,`exchange`,`effective_from`,`effective_to`);
