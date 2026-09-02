-- Trade review state — one nullable timestamp (v3.7, WS1 Trade Review Desk).
--
-- The journal already records why a trade was ENTERED (setup_tag, playbook_id),
-- what went wrong (mistake_tags, rule_violations) and why it was CLOSED
-- (exit_trigger, migration 0051). Nothing recorded whether the trader has
-- actually LOOKED at the trade since. That is what the review queue needs: a
-- closed trade with `reviewed_at IS NULL` is one the desk still owes the user.
--
-- Written by the journal route on any review save of a CLOSED trade, and by an
-- explicit "Mark reviewed" action on the queue (a record fact — free,
-- invariant 7). Nothing clears it automatically; a "Reopen" action nulls it
-- again.
--
-- Honesty rules, stated here because the schema alone cannot say them:
--
--  * BLANK MEANS UNREVIEWED. Exactly the rule exit_trigger's own header states
--    (migration 0051): no analytic may bucket a blank as "reviewed", and the
--    Process Score's `reviewed` component counts set values over closed trades
--    in the window rather than inventing a status for the rest (invariant 6).
--
--  * A REVIEW IS OF A FINISHED TRADE, so `is_open = 0` below is part of the
--    definition, not an optimisation. The whole point of the desk is to make
--    the trader look at a trade once its outcome is known; a thesis typed on a
--    position still held is journalling, not reviewing. And because nothing
--    clears the stamp when a trade closes (only "Reopen" does), stamping an
--    open row would delete that trade from the queue PERMANENTLY — it would
--    close already "reviewed", count in the Process Score's `reviewed`
--    component, and never once have been looked at as a closed trade. An open
--    trade therefore stays NULL here and joins the queue on the day it closes.
--
--  * THE BACKFILL BELOW IS NOT A CLAIM THAT THOSE TRADES WERE REVIEWED ON THE
--    DESK — the desk did not exist. It is the honest reading of evidence the
--    row already carries: a CLOSED trade with a note, an exit trigger, or
--    mistake tags was journalled BY HAND, which is the act the queue exists to
--    prompt. An upgrading user with a journalled book must not wake up to a
--    500-deep queue of work they already did; that would make the feature look
--    broken and would push them to clear it without reading, which is worse
--    than no queue.
--    Timestamp = COALESCE(updated_at, created_at): the last time the row was
--    touched is the closest true fact the database holds about when that
--    journalling happened. It is not invented, and it is never "now" — a
--    migration must not stamp today's date onto years-old work.
--
--  * A BARE ROW STAYS NULL. An imported trade nobody has annotated carries no
--    evidence of review and is left for the queue, which is the point.
--    mistake_tags is a JSON text column, so an EMPTY array counts as no
--    evidence — the same as null and ''.
--
--  * WHITESPACE IS NOT EVIDENCE, and SQLite's one-argument `trim()` does not
--    say so: it strips U+0020 and nothing else, so `trim(char(10))` is still
--    a newline and `trim('[]' || char(10))` is still '[]\n'. A restored or
--    hand-edited envelope carrying notes = "\n" or mistake_tags = '[ ]' would
--    otherwise read as hand-journalling. Hence the explicit character set
--    below (space, tab, LF, CR) and, for the JSON column, whitespace stripped
--    throughout so an empty array in any spelling is recognised. The limit
--    stated honestly: only those four characters count as blank — a note of a
--    single NO-BREAK SPACE (U+00A0) still reads as evidence, which is the
--    conservative direction (it leaves the row OUT of the queue rather than
--    inventing work).
--
-- EDITED IN PLACE after the v3.7.0 audit, before v3.7.0 shipped: the original
-- statement omitted `is_open = 0` and used the one-argument `trim()`. No user
-- has ever run either version. The repo's OWN dev / perf / e2e databases DID
-- apply the pre-fix statement, and drizzle orders by the journal's `when` and
-- will not re-run this file — so those local databases keep whatever the old
-- statement wrote, including review stamps on open trades. Re-seed them
-- (`npm run db:seed` / delete and re-migrate) if that matters for what you are
-- looking at; do NOT add a corrective 0059 for a migration that never shipped.
ALTER TABLE `trades` ADD `reviewed_at` text;
--> statement-breakpoint
UPDATE `trades`
SET `reviewed_at` = COALESCE(`updated_at`, `created_at`)
WHERE `reviewed_at` IS NULL
  AND `is_open` = 0
  AND (
    (`notes` IS NOT NULL AND trim(`notes`, char(32,9,10,13)) <> '')
    OR (`exit_trigger` IS NOT NULL AND trim(`exit_trigger`, char(32,9,10,13)) <> '')
    OR (`mistake_tags` IS NOT NULL
        AND replace(replace(replace(replace(`mistake_tags`, char(32), ''), char(9), ''), char(10), ''), char(13), '')
            NOT IN ('', '[]'))
  );
