-- B/f (brought-forward) loss lots — pre-journal carry-forward losses (v3.6, WS5).
--
-- A trader who filed ITRs BEFORE starting this journal may hold unabsorbed
-- losses the set-off engine can never see: the trades that produced them were
-- never imported, so computeTaxTimeline starts from zero and quietly
-- under-reports how much loss is available against this journal's gains. Each
-- row here is ONE such loss vintage — "my 2022-23 return carried out ₹X of
-- short-term capital loss" — entered by hand from the filed return, and seeded
-- into the engine as a CarryForwardLot. Seeded lots enter set-off and expiry
-- math exactly like journal-tracked ones: pruneExpired drops a vintage whose
-- window (8y capital/non-speculative, 4y speculative) closed before the first
-- journalled FY, and absorption runs oldest-first under the usual rules.
--
-- Honesty rules, stated here because the schema alone cannot say them:
--
--  * NOTHING is seeded. Every row is the user's own transcription of a FILED
--    return. The app never invents a pre-journal loss, and the UI says these
--    figures come from "losses from ITRs filed before you started this
--    journal" — a statement of record, not a computation.
--
--  * `head` uses the set-off engine's OWN loss-head taxonomy verbatim
--    (LossBucket in lib/analytics/capital-gains.ts): 'stcl' | 'ltcl' |
--    'speculative' | 'nonSpeculative'. Not a parallel vocabulary — a rename
--    there must break the typed LOSS_HEADS list in lib/queries/bf-losses.ts,
--    not silently strand rows under a head the engine no longer knows.
--
--  * `amount_paise` is the loss still UNABSORBED when the journal begins (what
--    the last filed return carried out). `original_amount_paise` is what the
--    loss was in the FY it was INCURRED — nullable, because a user may only
--    know the remaining figure. It exists purely so the loss ledger can show a
--    real "Original" column for seeded vintages (the pure ledger reports null
--    for a vintage whose incurring FY is outside the timeline, and that null
--    contract is untouched — the display enrichment happens at the page layer).
--
--  * Money boundary (invariant 1): both money columns are INTEGER PAISE at
--    rest, converted to rupees at runtime by the `moneyPaise` custom type in
--    lib/db/schema.ts. Converting again in application code is the 100× bug.
--
--  * One row per (account, FY incurred, head) — the unique index. A second
--    entry for the same vintage is an EDIT of the first, never a sibling: the
--    Act gives one return per FY, so one carry-out figure per head.
CREATE TABLE `bf_loss_lots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`incurred_fy` text NOT NULL,
	`head` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`original_amount_paise` integer,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bf_loss_lots_account_fy_head_uq` ON `bf_loss_lots` (`account_id`,`incurred_fy`,`head`);
