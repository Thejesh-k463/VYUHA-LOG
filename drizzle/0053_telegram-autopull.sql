-- Telegram EOD alerts + auto-pull on launch (v3.6, owner decisions #6 and the
-- WS3 auto-pull toggle). Every column here is OFF/empty for every existing
-- install and every new one — both features are strictly opt-in.
--
-- ALL EIGHT COLUMNS ARE MACHINE STATE (SETTINGS_MACHINE_COLUMNS in
-- lib/backup-format.ts, and deliberately absent from BASELINE_SETTINGS_FIELDS
-- in lib/domain/settings-baseline.ts). Consent is a statement a PERSON made on
-- a MACHINE: restoring anyone's backup, or "back to my defaults", must never
-- switch Telegram or auto-pull on, never inherit a disclosure acknowledgement,
-- and never replay a "last sent/pulled" stamp that would suppress or duplicate
-- a day's run — the OpenAlgo precedent (migration 0049 got this wrong at first
-- and was corrected by the forged-envelope test in backup-roundtrip.test.ts).
--
-- telegram_ack_version stores WHICH disclosure version was accepted
-- (lib/domain/telegram-disclosure.ts, an INTEGER version this time), so a
-- materially changed risk statement re-prompts instead of inheriting an old
-- consent. telegram_send_time is the user's chosen IST send time ("HH:MM",
-- default 15:35 — just after cash close); last_telegram_sent_date /
-- last_auto_pull_date are the once-per-day guards, same pattern as
-- last_auto_mtm_date.
--
-- CREDENTIALS HOME (decided here, recorded here): the bot token lives in
-- telegram_token_enc as a vault ciphertext envelope (lib/vault.ts encryptSecret,
-- the same encrypted-at-rest shape broker_connections uses), and the numeric
-- chat id in telegram_chat_id as plain text. broker_connections was the wrong
-- fit — that table is per-account BROKER connections with an
-- (account, broker) identity, and a Telegram bot is neither a broker nor
-- per-account. Both columns are REDACTED from every backup dump
-- (SETTINGS_MACHINE_COLUMNS): a backup is a journal, and a bot token that can
-- read the user's alert channel must never travel in one.
ALTER TABLE `settings` ADD COLUMN `telegram_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `telegram_ack_version` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `telegram_send_time` text DEFAULT '15:35' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `last_telegram_sent_date` text;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `telegram_token_enc` text;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `telegram_chat_id` text;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `auto_pull_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `last_auto_pull_date` text;
