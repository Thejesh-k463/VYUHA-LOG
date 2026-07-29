-- Marks a rate row the USER changed by hand.
--
-- Rate cards move (a broker revises MTF interest, a new plan appears), and an
-- installed copy of Vyuha had no way to receive those corrections: the seed ran
-- once, on first launch, and never again. Refreshing every row on upgrade would
-- fix that by silently overwriting the user's own corrections — so the two are
-- told apart, and only untouched rows are refreshed.
ALTER TABLE `charge_config` ADD `user_edited` integer DEFAULT false NOT NULL;
