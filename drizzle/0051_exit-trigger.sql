-- Why a trade was CLOSED.
--
-- The journal records why a trade was ENTERED (setup_tag, playbook_id) and what
-- went wrong (mistake_tags, rule_violations), but nothing about why it was
-- exited. That is the half of the decision most retail traders get wrong, and
-- it is the half nobody records.
--
-- It matters because Vyuha ALREADY computes `capturedPct` in
-- lib/analytics/mae-mfe.ts — how much of a trade's favourable excursion the
-- exit actually captured. Crossing that with the reason turns two existing
-- numbers into the sentence a trader can act on: "target exits capture 78% of
-- the move available, panic exits capture 31%".
--
-- Nullable and free-text-backed on purpose: an unanswered exit reason is
-- honest, and every analytic over this column excludes blanks rather than
-- bucketing them as "other" (invariant 6 — never fabricate).

ALTER TABLE `trades` ADD `exit_trigger` text;
--> statement-breakpoint
CREATE INDEX `trades_exit_trigger_idx` ON `trades` (`exit_trigger`);
