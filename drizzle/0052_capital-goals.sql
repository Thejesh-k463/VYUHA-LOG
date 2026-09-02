-- Expected Capital / goal tracking (v3.6, owner decision #4): absolute ₹ AND
-- %-profit targets, per bucket (equity | active | total), optional target
-- date, baseline frozen at creation.
--
-- One goal per (account_id, bucket) — a second target for the same bucket is
-- an EDIT, not a sibling, which is what the unique index enforces.
--
-- Honesty choices, stated here because the schema alone cannot say them:
--
--  * `target_paise` and `pct_target` are BOTH nullable, and the write path
--    REFUSES a goal whose own kind's target is missing rather than defaulting
--    it. A defaulted ₹0 / +0% target is a statement the user never made, and
--    every downstream "gap" and "required pace" figure would silently be
--    computed against fiction (AGENTS.md invariant 6).
--
--  * `baseline_capital_paise` NULL means capital was UNKNOWN when the goal
--    was created (a fresh install has none). It is never backfilled with 0 —
--    a %-profit goal REQUIRES a known baseline and is refused without one,
--    and progress on a goal without a measurable base renders "—" plus one
--    Settings nudge, never a confident 0%.
--
--  * Money boundary: the legacy capital columns (accounts.equity_capital /
--    active_capital, settings.equity_capital / active_capital,
--    capital_snapshots.*) are REAL rupees — they predate P0.1. This table's
--    money columns are INTEGER PAISE, converted to rupees at runtime by the
--    `moneyPaise` custom type in lib/db/schema.ts. Converting again in
--    application code is the 100× bug (invariant 1).
--
-- Seeds NOTHING: an invented target is worse than no target.
CREATE TABLE `capital_goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`bucket` text NOT NULL,
	`kind` text NOT NULL,
	`target_paise` integer,
	`pct_target` real,
	`baseline_capital_paise` integer,
	`baseline_date` text NOT NULL,
	`target_date` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capital_goals_account_bucket_uq` ON `capital_goals` (`account_id`,`bucket`);
