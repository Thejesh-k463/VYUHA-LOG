-- Data-fix ledger (v3.8, owner ruling 2026-09-04 on Paytm dedup).
--
-- Paytm Money's tradebook labels a scrip by ticker in one export and by BSE
-- scrip code in the next, and the import dedup hash was built from that
-- label — so the same position re-imported under the other label was NOT
-- recognised as a duplicate. The hash now keys Paytm rows on the ISIN instead
-- (lib/import/dedup.ts, `dedupSymbolKey`), which also means every stored
-- Paytm row must be re-keyed to the new hash or nothing would ever match it.
--
-- SQLite cannot SHA-1, so the re-key is application code:
-- lib/db/data-fixes.ts `runDataFixes` — fix `paytm-dedup-isin-v1`. This
-- migration only creates the ledger that makes such fixes run exactly once:
-- one row per fix name, written in the same transaction as the fix. A fix
-- whose row is here never runs again; a fix that crashed mid-way left no row
-- and runs again on the next open. `runDataFixes` is called wherever the
-- database is opened (lib/db/index.ts) and after every migration run
-- (lib/db/migrate.ts, tests/helpers/temp-db.ts), and is a silent no-op
-- until this table exists.
--
-- NOT a backup table (lib/backup-format.ts BACKUP_TABLES): whether THIS file
-- has been through a fix is a fact about the file, not about the journal, and
-- a restored journal is re-keyed on its next open if it needs to be.
CREATE TABLE `data_fixes` (
	`name` text PRIMARY KEY NOT NULL,
	`applied_at` text NOT NULL
);
