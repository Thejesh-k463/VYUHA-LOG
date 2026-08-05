-- A6 — stop single-account installs sitting in the synthetic aggregate view.
--
-- Migration 0034 introduced accounts with `settings.selected_account_id`
-- defaulting to 0 ("All accounts"), while every existing trade defaulted to
-- account 1. The result: every install landed in an aggregate view of exactly
-- one account, and writes fell back to account 1 silently because there was
-- nowhere else for them to go.
--
-- With one account, the aggregate view and that account are the same set of
-- rows, so selecting it explicitly changes nothing a user can see — it just
-- means the "which account does this write belong to?" question stops being
-- ambiguous. Installs that have genuinely made a second account are left alone:
-- their aggregate view is a real choice, and the app now asks where writes go.
UPDATE `settings`
SET `selected_account_id` = (SELECT MIN(`id`) FROM `accounts`)
WHERE `selected_account_id` = 0
  AND (SELECT COUNT(*) FROM `accounts`) = 1;
