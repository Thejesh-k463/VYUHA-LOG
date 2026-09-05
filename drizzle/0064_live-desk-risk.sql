-- v4.0 "Live Desk" — risk_config gains the input every sizing method needs.
--
-- Until now the only risk setting Vyuha stored was `per_trade_max_loss`, a ₹
-- amount. Every position-sizing method in the literature — fixed fractional,
-- volatility, Kelly, fixed ratio — is a FRACTION of capital, so with a ₹ figure
-- alone there was literally nothing to feed them. `risk_pct_ppm` is that input.
--
-- Units, deliberately, and never changed later without a migration:
--
--   * `risk_pct_ppm`, `stop_default_pct_ppm`, `deploy_cap_ppm`,
--     `heat_ceiling_ppm` are ppm INTEGERS — 2% is 20000, 25% is 250000. A
--     percentage stored as REAL is the same float drift that INTEGER paise
--     exists to avoid (AGENTS.md invariant 1); ppm also lets the pure
--     computations in lib/live multiply first and divide once, at the end.
--   * `stop_atr_mult_permille` is ×1000 — 2.0 ATR is 2000 — so a 2.5× or 3.25×
--     multiplier is exact rather than 2.5000000000000004.
--   * `stop_atr_len` is a plain session count (21 is the usual default).
--
-- NULLABILITY IS THE POINT. Everything here except the deploy cap ships NULL,
-- and NULL means "the user has not chosen". It is never coalesced to 0 or to a
-- house default at read time: invariant 6 forbids fabricating an input, and the
-- Live Desk's "risk not set" call to action exists precisely so the number the
-- desk shows is one the user set. A defaulted 2% would silently put a figure
-- the user never chose on every risk column in the product.
--
-- `deploy_cap_ppm` is the single exception and carries NOT NULL DEFAULT 250000
-- (25%). A cap that is off until switched on is not a cap; raw Kelly routinely
-- returns a size larger than the whole account, and the clip has to be live on
-- the first render or the first number the user ever sees is the wrong one.
-- The cap is a CLIP, not a sizing method — it only ever reduces a quantity.
--
-- `heat_ceiling_ppm` stays NULL forever unless the user sets it. The "6%
-- portfolio heat" figure is trading lore, not regulation, and Vyuha does not
-- assert risk limits it cannot justify — the desk draws the ceiling tick only
-- when there is a user value to draw.
--
-- `stop_method` is TEXT, one of manual | structure | atr | percent, matching
-- the decision tree in lib/live/stop.ts. No CHECK constraint: SQLite would
-- require a table rebuild to add one later, and the same four values are
-- already validated at the write edge where a bad value can produce an error
-- message instead of a constraint failure.
--
-- ADDITIVE AND REVERSIBLE. Seven nullable/defaulted columns on an existing
-- table; nothing in v3.9.1 reads them, so the down path loses no user data:
--   ALTER TABLE `risk_config` DROP COLUMN `risk_pct_ppm`;            (×7)
-- lib/db/schema.ts must revert in the SAME commit — a schema describing
-- columns the database no longer has passes typecheck and dies at runtime.
ALTER TABLE `risk_config` ADD `risk_pct_ppm` integer;--> statement-breakpoint
ALTER TABLE `risk_config` ADD `stop_method` text;--> statement-breakpoint
ALTER TABLE `risk_config` ADD `stop_atr_len` integer;--> statement-breakpoint
ALTER TABLE `risk_config` ADD `stop_atr_mult_permille` integer;--> statement-breakpoint
ALTER TABLE `risk_config` ADD `stop_default_pct_ppm` integer;--> statement-breakpoint
ALTER TABLE `risk_config` ADD `deploy_cap_ppm` integer DEFAULT 250000 NOT NULL;--> statement-breakpoint
ALTER TABLE `risk_config` ADD `heat_ceiling_ppm` integer;
