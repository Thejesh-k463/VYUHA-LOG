-- Weekly review ritual — one row per (account, ISO week) (v3.7, WS1).
--
-- The Sunday ritual is a guided pass over the week that just ended: what was
-- closed, the Process Score, the largest expectancy-gap tags, best and worst by
-- R, then the user's own written note and "Complete this week's review". This
-- table is where that note and that completion live. It is IN-APP only — no
-- Telegram, no notification: a ritual the user chooses to sit down for is not
-- something the app nags about.
--
-- Honesty rules, stated here because the schema alone cannot say them:
--
--  * `week_start` is the ISO MONDAY of the week, 'YYYY-MM-DD', produced by the
--    ONE bucketer the product uses (lib/analytics/week.ts, shared with
--    disciplineByWeek). Two week bucketers that disagree would put a user's
--    note on a week their score never covered.
--
--  * `score_at_completion` is a HISTORICAL FACT: the Process Score the user was
--    LOOKING AT when they completed the review. It is NEVER a cache to read
--    back as the current figure — the live score is always recomputed and
--    labelled separately ("score then" vs "score now" in the history strip), so
--    a late-arriving import or an edited trade moves the live number without
--    rewriting what the user actually saw. NULLABLE, because the score legally
--    refuses to exist under the floor (fewer than 10 closed trades in the
--    window): storing 0 there would be a fabricated score for a week that
--    honestly had none (invariant 6).
--
--  * `completed_at` NULL means the week is OPEN — a row can exist with only a
--    note typed mid-week. "Not completed" is not "not started".
--
--  * UNIQUE(account_id, week_start): one review per book per week. A second
--    write for the same week is an EDIT of the first, never a sibling — the
--    week does not happen twice. Account-scoped like every journal table
--    (invariant 8); the note is the USER'S OWN PROSE, so account deletion
--    snapshots it to trash and a merge appends a colliding source note onto the
--    target's row rather than dropping a sentence the user wrote.
CREATE TABLE `weekly_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`week_start` text NOT NULL,
	`note` text,
	`completed_at` text,
	`score_at_completion` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_reviews_account_week_uq` ON `weekly_reviews` (`account_id`,`week_start`);
