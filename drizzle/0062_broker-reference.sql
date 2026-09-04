-- broker_reference (v3.9 "Trust the numbers") — the figures the BROKER states,
-- kept beside the figures Vyuha derives, never mixed into them.
--
-- Vyuha's book is the tradebook: executions in, classification, the charges
-- engine, dedup. A broker's Realised P&L / Tax P&L / holdings statement states
-- ANOTHER set of numbers for the same window, computed by their rules on their
-- data. Those numbers are evidence, not input — invariant 6 forbids dressing a
-- derived figure as a reported one, and the reverse is just as wrong. So they
-- land HERE, in their own table, and the reconciliation screen shows the two
-- side by side with the reasons they differ.
--
-- `figures_json` is a JSON object of the canonical names `ParsedFile.reported`
-- already uses (buyValue, sellValue, grossPnl, netPnl, totalCharges, qty,
-- closingPrice, valuation, …), so every source lands in one table without a
-- column per broker. It is TEXT, not a money column: these are the broker's
-- numbers exactly as stated, and the paise-integer convention (invariant 1)
-- applies to money Vyuha OWNS.
--
-- REPLACE ON CONFLICT. Re-importing the same statement — the same window
-- exported twice, a re-download after a correction — must OVERWRITE the figure
-- it restates, not stack a second copy beside it: a reconciliation that reads
-- two rows for one scrip silently doubles the broker's side. The identity of a
-- figure is (account, broker, source, scope, key, as_of), and `as_of` is
-- NULL for a whole-FY total — so the unique index coalesces it to '', because
-- SQLite treats NULLs as DISTINCT in a unique index and two FY totals would
-- both be admitted.
--
-- account_id is NOT NULL with no default: every read of this table goes
-- through lib/queries/reference.ts, which resolves the account (invariant 8),
-- and every write through lib/import/commit.ts, which resolves the WRITE
-- account (invariant 9 — the "All accounts" view can never receive one).
CREATE TABLE `broker_reference` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`broker` text NOT NULL,
	`source_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`isin` text,
	`symbol` text,
	`fy` text,
	`as_of` text,
	`figures_json` text NOT NULL DEFAULT '{}',
	`note` text,
	`import_batch_id` integer,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `broker_reference_uq` ON `broker_reference` (`account_id`, `broker`, `source_id`, `scope`, `key`, coalesce(`as_of`, ''));
--> statement-breakpoint
CREATE INDEX `broker_reference_fy_idx` ON `broker_reference` (`account_id`, `fy`);
--> statement-breakpoint
CREATE INDEX `broker_reference_isin_idx` ON `broker_reference` (`account_id`, `isin`);
