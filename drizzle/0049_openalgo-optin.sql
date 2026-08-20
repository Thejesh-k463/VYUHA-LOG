-- OpenAlgo integration opt-in (v2.99.99): OFF for every existing install and
-- every new one. Same posture as auto_mtm_enabled — the user decides when the
-- app is allowed to talk to a second piece of software on their machine.
--
-- TWO columns, not one, because "never asked" and "asked, then turned off"
-- are different states: the first must show the disclosure, the second must
-- not nag. openalgo_ack_version stores the DISCLOSURE version the user
-- accepted (lib/domain/openalgo-disclosure.ts), so a materially changed risk
-- statement re-prompts instead of inheriting an old consent.
--
-- Preference, not machine state: it travels with a backup like theme does.
-- The OpenAlgo API key and host live in broker_connections (vault-encrypted),
-- not here — this column only says whether the feature is available at all.
ALTER TABLE `settings` ADD COLUMN `openalgo_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `openalgo_ack_version` text;
