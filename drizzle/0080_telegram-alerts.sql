-- v4.7.0 wave C5 — Telegram stop/target alerts (ruling Q18; owner answers TG1–TG6,
-- DECISIONS 2026-10-04; design VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/C5-DESIGN-2026-10-04.md
-- D6/D7 as amended by the review's R6/R7, which win).
--
-- 1. `settings.telegram_alerts_enabled` — the Pro alerts toggle, OFF by default.
--    NOT NULL DEFAULT 0, so a dump blanks it to its SAFE value (off) through
--    SETTINGS_MACHINE_BLANKS, never to null.
-- 2. `settings.telegram_alert_from` / `telegram_alert_to` — the user's optional
--    window, IST "HH:MM". Both NULL = the market's own hours only. It NARROWS the
--    calendar's window (lib/domain/market-calendar.ts) and can never widen it.
-- 3. `settings.last_telegram_alert_summary_date` — the once-per-IST-day claim for
--    the "N more" summary line once the 20-a-day cap is spent (Q18-i): a
--    conditional UPDATE (`< today` → today), reverted on a failed send — the
--    digest's `last_telegram_sent_date` pattern exactly.
--    All four are MACHINE STATE (SETTINGS_MACHINE_COLUMNS in lib/backup-format.ts).
--
-- 4. `telegram_alerts_sent` — one row per alert sent; the row IS the claim
--    (`INSERT … ON CONFLICT DO NOTHING` before the send, DELETE on failure). The
--    unit is (trade_id, symbol, kind, ist_date): no same-day re-arm (Q18-d); the
--    symbol is in it so a restore that reuses an id for a DIFFERENT trade does
--    not silence that trade (R6). NO account_id, deliberately (D7/R7):
--    `trades.id` is unique across accounts, and the one reader
--    (lib/jobs/telegram-alerts.ts) reads every account on purpose (TG3) — a
--    scope that exists only to satisfy a test would be invariant-8 theatre.
--    `level` / `mark` are per-unit PRICES, REAL (invariant 1). NOT in the backup
--    envelope (BACKUP_TABLES, pinned in tests/backup-format.test.ts): a restored
--    file must not suppress today's alerts on this machine. Pruned past 7 days.
--
-- Hand-written, no drizzle-kit snapshot (AGENTS.md: 0027+), journal entry added.
ALTER TABLE `settings` ADD COLUMN `telegram_alerts_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `telegram_alert_from` text;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `telegram_alert_to` text;
--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `last_telegram_alert_summary_date` text;
--> statement-breakpoint
CREATE TABLE `telegram_alerts_sent` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `trade_id` integer NOT NULL,
  `symbol` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('sl', 'tsl', 'target')),
  `ist_date` text NOT NULL,
  `level` real NOT NULL,
  `mark` real NOT NULL,
  `sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_alerts_sent_uq` ON `telegram_alerts_sent` (`trade_id`, `symbol`, `kind`, `ist_date`);
