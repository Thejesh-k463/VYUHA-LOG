-- Per-account P&L compounding state.
--
-- `settings.pnl_rolled_in` was GLOBAL while capital is read PER-ACCOUNT
-- (lib/queries/capital.ts reads account.equity_capital ?? settings). So
-- compounding in account A silently marked account B's realised P&L as
-- already rolled in, and when the account carried its own capital the
-- write landed on a settings row nothing was reading — the user saw
-- "Compounded +₹X", the number never moved, and the P&L could never be
-- compounded again.
--
-- The rolled-in marker moves to the accounts table. The legacy global value
-- is credited to the DEFAULT account (falling back to the lowest id): on a
-- single-account install — the overwhelming case — that is exactly where
-- every historical compound landed; on a multi-account install the history
-- is genuinely ambiguous and the default account is the least-wrong owner
-- (recorded in docs/DECISIONS.md 2026-08-12). settings.pnl_rolled_in is
-- zeroed rather than dropped so an old backup restores without erroring.
ALTER TABLE `accounts` ADD COLUMN `pnl_rolled_in` real NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `accounts`
SET `pnl_rolled_in` = COALESCE((SELECT `pnl_rolled_in` FROM `settings` LIMIT 1), 0)
WHERE `id` = COALESCE(
  (SELECT `id` FROM `accounts` WHERE `is_default` = 1 ORDER BY `id` LIMIT 1),
  (SELECT MIN(`id`) FROM `accounts`)
);
--> statement-breakpoint
UPDATE `settings` SET `pnl_rolled_in` = 0;
