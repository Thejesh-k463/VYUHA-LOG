-- The hottest query in the app is getTrades(): WHERE account_id = ?
-- ORDER BY sell_date DESC, created_at DESC, run by ~25 force-dynamic pages on
-- every navigation. Two single-column indices (account, sell_date) cannot
-- serve filter+sort together, so SQLite filesorts the whole result — ~10-20ms
-- per request at a 10k-row book. This composite matches the exact ORDER BY,
-- turning it into an index scan.
CREATE INDEX `trades_account_sell_created_idx` ON `trades` (`account_id`, `sell_date` DESC, `created_at` DESC);
--> statement-breakpoint
-- price_history_symbol_idx duplicates the leading column of the
-- (symbol, date) unique index, which already serves every symbol lookup AND
-- sorts by date for free — the single-column copy only taxed writes.
DROP INDEX `price_history_symbol_idx`;
