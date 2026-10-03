-- v4.7.0 wave C2 — the Edge Clinic's data (owner answers 2026-10-03, DECISIONS;
-- design VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/C2-DESIGN-2026-10-03.md D1 + the
-- REVISED section, which wins).
--
-- 1. `trades.setup_grade` — the trader's own A+ / A / B grade of the setup,
--    OPTIONAL and typed at entry. NULL = ungraded, and an ungraded row is never a
--    grade cell (the engine builds `all|grade:<g>` only for grades present).
--
-- 2. `trades.intra_high` / `trades.intra_low` — the highest and lowest price the
--    instrument traded at while the position was open, typed by the user. These
--    are per-unit PRICE LEVELS, so they are REAL, never paise (invariant 1), and a
--    split / bonus scales them exactly as it scales SL / TSL / target
--    (lib/corporate-actions-apply.ts). Both-or-neither and their order against the
--    fills are refused at the WRITE (app/trades/actions.ts) with a message, never
--    coerced; MAE/MFE re-checks them at READ time and falls back to EOD bars when
--    they no longer bracket entry and exit (lib/analytics/mae-mfe.ts).
--
-- 3. `clinic_experiments` — USER DATA: one pre-registered comparison the user
--    started on a Clinic cell. Only `started_at` is stored; the baseline and the
--    result are computed at read time from ONE ClinicTrade[] so a risk-cap
--    reprice moves both sides together. Account-owned, so it travels in backups,
--    is snapshotted by an account purge, moves on a merge, and every read is
--    `accountId > 0 ? filter : all` (tests/account-isolation.test.ts).
--    NO FOREIGN KEY on account_id, deliberately (design review change 1): no table
--    in this schema declares one and `foreign_keys = ON` (lib/db/index.ts), so a
--    REFERENCES here would make a pre-4.7 backup restore fail — that envelope
--    does not carry this table, the restore leaves it alone, and then deletes the
--    `accounts` rows it points at.
--    One OPEN experiment per (account, cell): a partial unique index.
--
-- 4. `clinic_cache` — DERIVED: the last engine report per scope (`acct:<id>`,
--    0 = the All-accounts view) and the sha256 digest of the exact engine INPUT
--    it was computed from. No account_id column (it is keyed by scope, and the
--    All view is not a place). Not in the backup envelope; a backup restore and an
--    account delete drop the row(s) — and a stale row could never be served as
--    fresh anyway, because its digest cannot match a changed input.
--
-- Hand-written, no drizzle-kit snapshot (AGENTS.md: 0027+), journal entry added.
ALTER TABLE `trades` ADD COLUMN `setup_grade` text CHECK (`setup_grade` IN ('A+', 'A', 'B'));
--> statement-breakpoint
ALTER TABLE `trades` ADD COLUMN `intra_high` real;
--> statement-breakpoint
ALTER TABLE `trades` ADD COLUMN `intra_low` real;
--> statement-breakpoint
CREATE TABLE `clinic_experiments` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer NOT NULL,
  `cell_key` text NOT NULL,
  `cell_label` text NOT NULL,
  `hypothesis` text NOT NULL,
  `started_at` text NOT NULL,
  `target_n` integer NOT NULL,
  `status` text DEFAULT 'open' NOT NULL CHECK (`status` IN ('open', 'checked', 'abandoned')),
  `checked_at` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clinic_experiments_open_uq` ON `clinic_experiments` (`account_id`, `cell_key`) WHERE `status` = 'open';
--> statement-breakpoint
CREATE INDEX `clinic_experiments_account_idx` ON `clinic_experiments` (`account_id`);
--> statement-breakpoint
CREATE TABLE `clinic_cache` (
  `scope_key` text PRIMARY KEY NOT NULL,
  `digest` text NOT NULL,
  `engine_version` text NOT NULL,
  `report_json` text NOT NULL,
  `computed_at` text NOT NULL
);
