-- v4.4.0 metrics wave B-ii — the per-segment per-trade cap (D1) and the ONE
-- dated risk-free setting (D5).
--
-- D1. `risk_config.cap_scheme` — which rule reads a row's per_trade_max_loss.
-- NULL on every existing row: v1–v4.3 seeded the literal 9500 on each bucket
-- and segment row, so on a bucket/segment row with NULL here exactly 9500 reads
-- as UNSET and inherits the broader cap. That is a RESOLVER rule
-- (`resolvePerTradeCap`, lib/risk/limits.ts), never a data rewrite: this
-- migration moves no cap, and an EDITED cap (any value but the seed literal)
-- keeps meaning what the user typed.
--
-- `trades.risk_source` — 'cap' | 'set' | 'frozen', NULL when no risk. Existing
-- rows stay NULL here; the `risk-source-v1` data fix (lib/db/data-fixes.ts)
-- classifies them in application code, because the classification needs
-- `hasPlanR` and the resolver, which SQL cannot express.
--
-- The three segments the v1 seed never had a row for (eq_delivery, eq_mtf,
-- future — `lib/domain/constants.ts` names all eight) get one, with a NULL cap
-- (inherit) and cap_scheme 1. INSERT OR IGNORE on the (scope, key) unique
-- index, so a row that somehow exists already is left exactly as it is, and a
-- re-run inserts nothing.
--
-- D5. `settings.risk_free_rate_ppm` — ppm, never REAL (the risk_config ppm
-- rule): 70000 = 7%, the rate every Sharpe/Sortino/alpha/Greeks figure used as
-- three hard-coded copies until now, so nothing moves. `risk_free_as_of` NULL =
-- "Vyuha default assumption, not a market quote".
--
-- Hand-written, no drizzle-kit snapshot (AGENTS.md: 0027+), journal entry added.
ALTER TABLE `risk_config` ADD COLUMN `cap_scheme` integer;
--> statement-breakpoint
ALTER TABLE `trades` ADD COLUMN `risk_source` text;
--> statement-breakpoint
INSERT OR IGNORE INTO `risk_config` (`scope`, `key`, `per_trade_max_loss`, `cap_scheme`) VALUES ('segment', 'eq_delivery', NULL, 1), ('segment', 'eq_mtf', NULL, 1), ('segment', 'future', NULL, 1);
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `risk_free_rate_ppm` integer DEFAULT 70000 NOT NULL;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `risk_free_as_of` text;
