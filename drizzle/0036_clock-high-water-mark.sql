-- Licence hardening: make time effectively monotonic for entitlement checks.
--
-- The 14-day trial and any annual key were both evaluated against the system
-- clock. An offline app cannot ask anyone what day it is, so winding the clock
-- back renewed the trial and un-expired a lapsed key, silently and repeatedly.
--
-- This column records the latest date the install has ever observed. A clock
-- that jumps meaningfully backwards (see CLOCK_TOLERANCE_DAYS) is no longer
-- believed for entitlement purposes. It is a ratchet, not a lock: nothing is
-- ever expired EARLY, ordinary timezone/DST/NTP movement is absorbed, and a
-- genuinely wrong clock simply stops advancing the mark until real time catches
-- up.
--
-- Seeded from trial_started_at where present so existing installs do not begin
-- with an empty mark that a rollback could exploit once.
ALTER TABLE `settings` ADD `clock_high_water_mark` text;
--> statement-breakpoint
UPDATE `settings` SET `clock_high_water_mark` = `trial_started_at` WHERE `trial_started_at` IS NOT NULL;
