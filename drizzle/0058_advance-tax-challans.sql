-- Dated advance-tax challan ledger (v3.7, WS4).
--
-- The advance-tax calculator has always taken "tax paid so far" as ONE scalar
-- the user retypes, which cannot answer the question s.234C actually asks: how
-- much was paid ON OR BEFORE each instalment due date. A June payment and a
-- March payment of the same amount produce different interest, and a single
-- number cannot tell them apart. Each row here is ONE challan the user really
-- paid — transcribed from the receipt — so the engine can compute paid-as-of
-- each rung instead of guessing.
--
-- Honesty rules, stated here because the schema alone cannot say them:
--
--  * NO UNIQUE KEY, ON PURPOSE. There is no natural key: a challan serial is
--    unique only PER BSR CODE, and both fields are OPTIONAL on a
--    self-assessment receipt — a user paying through their bank's portal may
--    hold nothing but a date and an amount. A unique index over (fy, paid_on,
--    amount_paise) would refuse two genuinely separate payments of the same
--    amount on the same day, which people do make. So the EDITOR warns on an
--    exact (fy, paid_on, amount) duplicate and the schema still allows it: a
--    question is better than a refusal, and a refusal that loses a real payment
--    is worse than a duplicate the user can see and delete.
--
--  * STATEMENTS OF FACT about money that really left the user's bank — the
--    same class as bf_loss_lots (migration 0054), not aspirations like
--    capital_goals. So they follow the book: on a merge the rows MOVE to the
--    target account, and on a purge they are deleted with it. Like the loss
--    lots they are NOT snapshotted to trash — a handful of rows the user
--    restates from the receipts they legally have to keep anyway.
--
--  * `fy` is 'YYYY-YY' (e.g. '2026-27') and `paid_on` an ISO date, matching the
--    FY vocabulary the tax pages already use. NOTHING is seeded and nothing is
--    inferred from the journal: the app never invents a payment, and a FY with
--    no rows renders blank rather than 0 (invariant 6) — the calculator's
--    v3.5 scalar behaviour is untouched for exactly that case.
--
--  * Money boundary (invariant 1): `amount_paise` is INTEGER PAISE at rest,
--    converted to rupees at runtime by the `moneyPaise` custom type in
--    lib/db/schema.ts. Converting again in application code is the 100× bug.
CREATE TABLE `advance_tax_challans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`fy` text NOT NULL,
	`paid_on` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`bsr_code` text,
	`challan_serial` text,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `advance_tax_challans_account_fy_idx` ON `advance_tax_challans` (`account_id`,`fy`);
