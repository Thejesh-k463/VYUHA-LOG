-- v4.2 — `angelone_instrument_tokens`: symbol → Angel One's own exchange token.
--
-- WHY A TABLE AT ALL
--
-- Angel One's quote endpoint is keyed by `symboltoken` ("3045"), not by a
-- ticker and not by an ISIN, and the ONLY way this release is allowed to learn
-- one is `/rest/secure/angelbroking/order/v1/searchScrip` — one symbol per
-- request, on the same host the prices come from. There is no scrip-master
-- download in this release (that would be a second host and a second thing to
-- disclose), so the mapping is discovered a symbol at a time, at one request a
-- second, and it must survive a restart or the desk would spend its first
-- minute of every session re-asking questions it already had answers to.
--
-- WHAT A ROW IS, AND WHAT IT IS NOT
--
--   exchange       "NSE" | "BSE" — Angel One's token space is per exchange, so
--                  the same digits mean different companies on the two of them.
--                  This is half the key for that reason.
--   symbol         The CANONICAL ticker Vyuha keys everything else on
--                  ("SBIN"), with no series suffix — that is what a QuoteKey
--                  carries and what the journal stores.
--   tradingsymbol  Angel One's own decorated name for the row that was chosen
--                  ("SBIN-EQ"). Stored so a wrong series is VISIBLE later
--                  rather than inferred from a bare number; searchScrip returns
--                  sixteen rows for SBIN across AF/BE/BL/EQ/IQ and picking the
--                  wrong one prices a different instrument under a right name.
--   token          The `symboltoken` string, kept as TEXT. It is an identifier,
--                  not a quantity: leading zeros and future non-numeric ids
--                  both survive, and nothing ever does arithmetic on it.
--   resolved_at    When the lookup happened. A cache with no age is a cache
--                  nobody can ever decide to refresh.
--
-- It is a CACHE OF A FACT ABOUT THE MARKET, not about a book — the same
-- reasoning as the bhavcopy and Atlas caches (0065, 0066). So:
--
--   • NOT ACCOUNT-SCOPED. There is no `account_id` and there must never be one:
--     SBIN's NSE token is the same number in every account, and inventing an
--     owner for it would put invariants 8/9 in charge of a public constant.
--     `tests/account-isolation.test.ts` introspects the schema for exactly this
--     column, so adding one later fails loudly rather than quietly.
--   • NO MONEY. Nothing here is paise, rupees or a price (invariant 1 has
--     nothing to own), and nothing here is a denominator (invariant 6).
--   • DERIVABLE, THEREFORE DISPOSABLE. Every row can be re-fetched from
--     searchScrip. Deleting the table costs one minute of lookups and nothing
--     else, which is why it is not in the backup envelope.
--
-- UNIQUE (exchange, symbol) is the whole point: one answer per symbol per
-- exchange, upserted, so a re-resolution corrects a row instead of appending a
-- second one that a later read would pick between at random.
--
-- Hand-written, no drizzle-kit snapshot (AGENTS.md: 0027+), journal entry added.

CREATE TABLE `angelone_instrument_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`exchange` text NOT NULL,
	`symbol` text NOT NULL,
	`tradingsymbol` text NOT NULL,
	`token` text NOT NULL,
	`resolved_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `angelone_instrument_tokens_exchange_symbol_uq` ON `angelone_instrument_tokens` (`exchange`,`symbol`);
