import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import { todayIstIso, unreadableDateMessage } from "@/lib/domain/trading-day";

/**
 * v4.3.0 FIX WAVES 2I + 2J + 2K + 2L — THE SEAMS OF DISJOINT-FILE WAVES.
 *
 * Wave 2I (I1 MTF readers + the close preview; I2 trash restore / merge / the
 * unstated-price guard / the DQ reader; I3 the M1 copy; I4 the IPO lifecycle;
 * I5 the merge carry; I6 the ISIN compare) and wave 2J (J1 the named Clear; J2
 * the account-delete ipoRefs; J3 the IPO re-home data fix; J4 the sync's
 * charges; J5 a pin) owned DISJOINT files. This file runs the two real halves
 * of every value that crosses from one builder's files into another's.
 *
 * WAVE 2L added seven more disjoint sets (L1 one canonical ISIN; L2 the MTF
 * readers; L3 the IPO route, the charge provenance and the calendar; L4 the M1
 * priority; L5 the counted-once rule's one home; L6 the legacy Trash envelope;
 * L7 the merge's identity and IPO plan) — F14..F26 below. They also cover the
 * six boundaries the wave-2I re-check found with NO seam case at all
 * (new_defects[2..7]: the merge-side `ipoRefs`, the legged/staged doors, the
 * reverse/forward merge refusal and its preview, J1's no-`fact` Clear, the
 * 3-decimal gross, and F10's over-claiming title, corrected in place).
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The stubs are framework and
 * transport only: `next/cache`, `next/navigation` and `globalThis.fetch` for
 * api.dhan.co. A client form's request is built from its OWN server render.
 *
 * ── THE SEAM TABLE ───────────────────────────────────────────────────────────
 *
 *  #  | crossing value                          | producer (file:line, builder)                       | consumer (file:line, builder)                            | unit / shape                     | test
 * ----|-----------------------------------------|-----------------------------------------------------|----------------------------------------------------------|----------------------------------|-----
 *  F1 | a STORED mtf funded amount of 0         | lib/import/commit.ts:1710 updateManualTrade (2H) ←  | lib/analytics/positions.ts:128 deriveOpenPositions (I1)   | ₹ (rupees at runtime); 0 ≠ null  | F1 a/b
 *     |   (100% own capital)                    |   app/trades/actions.ts:49 ownCapital (FormData "0")  |   → app/equity/page.tsx:41 → TrackerClient props;         |                                  |
 *     |                                         |                                                      |   app/reports/broker-compare/page.tsx:59 (I1) MTF int.;   |                                  |
 *     |                                         |                                                      |   lib/analytics/data-quality.ts:892 mtf_funding (I2)      |                                  |
 *  F2 | the close dialog's preview body with    | components/trades/close-trade-dialog.tsx:33          | app/api/charges/preview/route.ts:24 ≡ lib/import/commit   | ₹ JSON numbers; daysHeld an      | F2
 *     |   the exit-date field CLEARED           |   resolveExitIso + :80 daysHeld (I1)                 |   .ts:1927 closePosition (closeTradeAction)               |   integer, never NaN → null      |
 *  F3 | a Trash envelope holding a joined lot   | lib/queries/delete.ts:152 deleteTradesByIds (I4) ←  | lib/trash.ts:518/:530 restore (I2) ← app/api/trash/route  | {ok, restored, skipped}; the DQ  | F3
 *     |   AND the sale its alias names          |   app/trades/actions.ts deleteTradesAction          |   .ts:36 JSON → lib/queries/data-quality.ts:45 section    |   section, deep-equal            |
 *  F4 | a source row whose hash a TARGET lot    | lib/import/commit.ts:2218 withStaleCloseNote ←      | lib/queries/account-delete.ts:295 identityCollisions (I2) | 64-hex hash, case-folded; the    | F4
 *     |   holds (`dedup-alias:`)                |   the close-stale route (the Data Quality join)      |   ≡ lib/trash.ts restore skip (I2) ≡ commit.ts:1313 dedup |   ONE predicate, three readers   |
 *  F5 | a sale that states NO price (0)         | lib/analytics/data-quality.ts:536 statedPrice (I2)   | app/api/data-quality/close-stale/route.ts:22 → commit.ts  | REAL price; 0 = unstated; 409    | F5
 *     |                                         |   → staleOpenPairs `ambiguous`                       |   :2129 closeStaleLot AMBIGUOUS                           |                                  |
 *  F6 | the M1 ask's sentence, counted on the   | lib/import/commit.ts:512 snapshotIds → lib/import/   | app/api/import/broker/route.ts:1105 409 JSON `message`    | text; plural on the STORED rows, | F6
 *     |   STORED rows                           |   cross-source.ts:352 (I3)                           |   (J1) → components/import/broker-connect.tsx:233 (J1)    |   not the incoming ones          |
 *  F7 | a merge-carried record's identity       | lib/import/dhan-unfetched.ts:88 recordKeyOf (I5)     | app/api/import/broker/route.ts:623 named clear (J1) ←    | (null connection, span, fact);   | F7
 *     |   (no connection, span, sentences)      |   → GET `unfetched` + `unfetchedConnection`          |   broker-connect.tsx:149 clearUnfetchedBody (J1)          |   200 / 404                      |
 *  F8 | the account an IPO record is filed in   | app/trades/actions.ts:585 pushTradeToIpoAction (I4)  | lib/queries/ipos.ts:113 getIposComputed join (I4);        | account id; never the schema     | F8
 *     |                                         |                                                      |   app/api/ipos/route.ts:96 inAccount (I4/J4)             |   default 1, never 0             |
 *  F9 | `ipoRefs` in the Trash envelope         | lib/queries/delete.ts:154 (I4) and lib/queries/     | lib/trash.ts:691 the re-link loop → lib/queries/capital   | {ipoId, tradeId}[]; undefined    | F9 a/b
 *     |                                         |   account-delete.ts:562 (J2)                        |   .ts:48, tax-itr.ts:64, app/api/ais/route.ts:64         |   when empty                     |
 * F10 | a legacy IPO row's account              | lib/db/data-fixes.ts:150 applyIpoAccountRehome (J3) | lib/queries/ipos.ts:113 getIposComputed (I4) + the        | account id; the fix is a LEDGER  | F10
 *     |                                         |   ← lib/db/index.ts:58 startup / restore            |   route's scoped write                                    |   row, re-run after a restore    |
 * F11 | whose close a linked holding carries    | lib/analytics/ipo-link.ts:294 syncOwnsClose (J4)     | app/api/ipos/route.ts:236 syncWroteCharges → :277         | boolean; ₹ heads, mtfInterest /  | F11
 *     |                                         |                                                      |   syncLinkedTrade (J4) ← charge_config via computeIpo     |   pledgeCharges never written    |
 * F12 | a stored ISIN, canonicalised            | lib/queries/trades.ts:326 upper(trim(isin)) (I6)     | app/strategies/page.tsx:106 admittingOf (I6) →           | 12-char ISIN, upper + trimmed    | F12
 *     |                                         |                                                      |   StrategiesClient groups → StrategyCard                  |   on BOTH sides                  |
 * F13 | an IPO linked to a trade a merge DROPS  | lib/queries/account-delete.ts:783 merge (K1)        | lib/queries/ipos.ts:161 getIpoRealisedNet → capital.ts    | trade id; re-pointed, never      | F13
 *     |   as a duplicate                        |                                                      |   :48, tax-itr.ts:64, /api/ais                            |   nulled                         |
 *
 * -- WAVE 2L, AND THE WAVE-2I BOUNDARIES ITS RE-CHECK FOUND UNPINNED --------
 * (wave2l.json L1..L7; wave2i-recheck.json, unit "seams", new_defects[2..7])
 *
 *  #  | crossing value                          | producer (file:line, builder)                        | consumer (file:line, builder)                             | unit / shape                     | test
 * ----|-----------------------------------------|------------------------------------------------------|-----------------------------------------------------------|----------------------------------|-----
 * F14 | an IPO record's account, once the       | lib/db/data-fixes.ts:169 `a.archived = 0` (L3)       | lib/queries/ipos.ts:175 ipoIdsCountedThroughTrades (L5)   | account id; the LINK is read     | F14
 *     |   re-home has DECLINED to move it       |                                                      |   -> capital.ts:48, tax-itr.ts, /api/ais, the ITR export   |   UNSCOPED by account            |
 * F15 | a stored ISIN carrying a tab, a         | lib/domain/isin.ts canonicalIsin (L1) <-             | app/strategies/page.tsx:119 admittingOf (L1) ->            | 12 chars, every whitespace       | F15
 *     |   newline or an NBSP                    |   lib/queries/trades.ts:352 the JS pass (L1)         |   StrategiesClient groups -> StrategyCard                  |   removed, upper - ONE function  |
 * F16 | a PARTLY SOLD MTF leg's own capital,    | lib/analytics/positions.ts:154 (L2) <-               | components/trackers/tracker-client.tsx:108 the cell +      | rupees or NULL; the total says   | F16
 *     |   and a funded amount never resolved    |   lib/import/commit.ts:2392 updateManualTrade        |   :229 the KPI (L2); lib/risk/mtf-drift.ts:55 ->           |   how many rows it left out      |
 *     |                                         |                                                      |   components/risk/mtf-drift-card.tsx:49 `unpriced` (L2)    |                                  |
 * F17 | whether a save would WRITE to a legged  | lib/analytics/ipo-link.ts:299 syncWouldWrite (L3)    | app/api/ipos/route.ts:492 the STAGED refusal (L3);        | boolean; a notes-only save is    | F17
 *     |   holding                               |                                                      |   app/trades/actions.ts:568 pushTradeToIpoAction (I4)      |   200, never 409                 |
 * F18 | WHOSE the exit charges on a holding are | lib/analytics/ipo-link.ts:340 IPO_SYNC_CHARGES_NOTE  | app/api/ipos/route.ts:262 syncWroteCharges (L3);          | a marker in import_notes - never | F18
 *     |                                         |   (L3) <- syncLinkedTrade's own write                |   lib/import/commit.ts:2452 the editor drops it (L3)       |   a re-pricing at live rates     |
 * F19 | a save that would RE-OPEN a close       | app/api/ipos/route.ts:279 reopensAForeignClose (L3)  | the eight heads it would zero <- the holding's own sale    | 409 CLOSE_IN_TRADES; the two     | F19
 *     |                                         |                                                      |                                                           |   kept heads are never written   |
 * F20 | an exit date that is not a CALENDAR day | lib/import/commit.ts:64 isRealDay (L3)               | app/api/positions/close/route.ts:16 -> {ok:false};         | null, never a stored 2026-02-31  | F20
 *     |                                         |                                                      |   components/trades/close-trade-dialog.tsx:36 (L3)         |   - the dialog previews nothing  |
 * F21 | WHICH collision an incoming pull row    | lib/import/cross-source.ts:301 the priority (L4)     | app/api/import/broker/route.ts 409 `message` ->            | today's snapshot beats an older  | F21
 *     |   reports                               |                                                      |   components/import/broker-connect.tsx collisionDialogCopy |   cross-FILE row, not rowid order|
 * F22 | an envelope with NO `ipoRefs` at all    | lib/queries/delete.ts (4.2.x: the field did not      | lib/trash.ts:781 the fallback (L6) <- lib/analytics/       | {tradeId, ipoId}[]; EMPTY when   | F22
 *     |                                         |   exist) -> trash.ts writeTrashSnapshot              |   data-quality.ts:930 uniqueIpoRelinks (L6);               |   ambiguous - never a guess      |
 *     |                                         |                                                      |   lib/queries/data-quality.ts:90 -> the DQ issue (L6)      |                                  |
 * F23 | a source row the target holds only as   | lib/import/close-open-lots.ts heldIdentityHashes <-  | lib/queries/account-delete.ts:409 the forward refusal      | the SAME `identityClash` string  | F23
 *     |   an ALIAS, carrying its own other leg  |   the close-stale join                               |   (L7) == :583 previewAccountDelete's warning (L7)         |   on both sides                  |
 *     |   …and the REVERSE: a source LOT whose  |   the same predicate, read the other way             |   the same two readers, the other half of the sentence     |                                  | F23 b
 *     |   held alias names a target row (I2)    |                                                      |                                                           |                                  |
 * F24 | an `ipos` row naming a DROPPED          | lib/queries/account-delete.ts:380 planIpoLinks (L7)  | the same file's `ipoRefs` envelope (J2) -> lib/trash.ts    | one trade takes ONE record; the  | F24
 *     |   duplicate - in this book and another  |                                                      |   :691 the re-link loop (I2) -> capital.ts:48              |   rest are skipped, not nulled   |
 * F25 | a Clear body that names NO sentence     | components/import/broker-connect.tsx (an OLDER       | app/api/import/broker/route.ts:633 `named` (J1) ->         | {} - the span's FIRST record of  | F25
 *     |                                         |   client's body, `fact` absent)                      |   lib/import/dhan-unfetched.ts:250 latestVia (I5)          |   that connection, as before     |
 * F26 | the gross of a 3-decimal exit over a    | lib/analytics/ipo.ts:367 computeIpo (I4)             | lib/analytics/ipo-link.ts tradePatchFromIpo -> the trade   | rupees at the paisa; ONE         | F26
 *     |   3-decimal issue price                 |                                                      |   row -> capital / the tax pack / the ITR export           |   arithmetic, value-based        |
 *
 * -- WAVE 2M: B-IPO (G-G2-1, the IPO pairing) x B-DATE (G-G3-1/2, one calendar) -
 * The two builders owned disjoint files and never ran together. B-IPO's tier B
 * compares four DATES as ISO day strings; B-DATE is the wave that decided what
 * those columns hold. Each crossing value below is built where its producer
 * builds it and asserted at the consumer's OUTPUT.
 *
 *  #  | crossing value                          | producer (file:line, builder)                        | consumer (file:line, builder)                             | unit / shape                     | test
 * ----|-----------------------------------------|------------------------------------------------------|-----------------------------------------------------------|----------------------------------|-----
 * F27 | the holding's three days + the record's | lib/trash.ts:800-802 the ENVELOPE row (B-IPO) AND     | lib/analytics/data-quality.ts:956 matchesByExit (B-IPO)    | ISO day strings; `isoDay` (:446) | F27
 *     |   four tier-B columns, from TWO         |   lib/queries/data-quality.ts:103-106 the LIVE row    |   -> uniqueIpoRelinks -> the ipos.trade_id UPDATE, and     |   is a SHAPE test, not the       |
 *     |   producers into ONE pairing            |   (B-IPO) - one book, read two ways                   |   -> the `ipo_record_link` note                            |   calendar                       |
 * F28 | WHICH unlinked records the pairing is   | lib/trash.ts:817 isNull(tradeId) - EVERY one - vs     | the same uniqueIpoRelinks / ipoAskPairs (B-IPO): two       | a SET, not a value. DEFECT - the | F28
 *     |   handed                                |   lib/queries/data-quality.ts:91 allotted AND exited  |   candidates vs one -> "ambiguous" vs "it matches"         |   two halves disagree            |  (it.fails)
 * F29 | ipos.allotment_date, as the user typed  | app/api/ipos/route.ts:431 strOrNull - no calendar,    | lib/analytics/data-quality.ts:960 isoDay(allotmentDate)    | ISO day. DEFECT - the one typed- | F29
 *     |   it                                    |   beside an exitDate that IS refused at :408          |   (B-IPO); lib/analytics/ipo.ts:378 the ST/LT split        |   date writer B-DATE's rule left |  (it.fails)
 * F30 | the editor's daysHeld and both dates on | components/trades/edit-trade-dialog.tsx:79-105        | app/api/charges/preview/route.ts:68 pricingDate ==         | integer days, never NaN->null;   | F30
 *     |   the wire, typed DAY-FIRST             |   editPreviewBody (B-DATE)                            |   lib/import/commit.ts:2386 updateManualTrade              |   the same rupees on both sides  |
 * F31 | a staged ladder's STORED leg day        | lib/queries/staged.ts:494 addLeg / :553 updateLeg     | lib/domain/staged.ts:684 parentAggregate -> trades         | one convention in the column;    | F31
 *     |                                         |   normalise before the write (B-DATE)                 |   .sell_date -> matchesByExit (B-IPO) -> the DQ note       |   the PARENT is what is read     |
 * F32 | a BLANK date field, at 19:00 UTC        | components/trades/close-trade-dialog.tsx:40           | closeTradeAction -> commit.ts closePosition; and           | IST day vs null - two rules on   | F32
 *     |                                         |   resolveExitIso (today) vs edit-trade-dialog.tsx:99  |   updateTradeAction -> updateManualTrade                   |   purpose, each == its OWN save  |
 *     |                                         |   (blank CLEARS, 0 days) - both B-DATE                |                                                           |                                  |
 * F33 | NO preview body at all                  | components/trades/edit-trade-dialog.tsx:69 null       | the dialog's own render (:300-304) and lib/import/commit   | null, never a body; ONE          | F33
 *     |                                         |   (B-DATE) <- a legacy stored '2026-02-31'            |   .ts:64 unreadableDate == trading-day.ts:194              |   sentence, character for char   |
 *
 * -- WAVE 2M, THE SEAM ROUND (D1..D4 fixed; these are the cases they needed) ----
 * The three boundaries round 1 named with NO case at all. F28 and F29 are the
 * same two seams, their `it.fails` pins flipped and their companions re-pinned.
 *
 *  #  | crossing value                          | producer (file:line, builder)                        | consumer (file:line, builder)                             | unit / shape                     | test
 * ----|-----------------------------------------|------------------------------------------------------|-----------------------------------------------------------|----------------------------------|-----
 * F34 | the acquisition day typed on /trades     | app/trades/actions.ts:505-509 setAcquisitionAction    | trades.acquisition_date AND trades.buy_date ->             | ISO day, or a refusal before ANY | F34
 *     |                                         |   (S-IPO, D3) <- acquisition-panel.tsx:102 type=date  |   matchesByExit's `acquisitionDate ?? buyDate` (:985)      |   write; one convention          |
 * F35 | a LEGACY parent date copied onto a leg   | lib/queries/staged.ts:690-729 convertToStaged         | trade_legs.trade_date -> priceLegs (:182) -> the parent    | ISO day or a refusal; NULL still | F35
 *     |                                         |   (S-DATE, D4)                                       |   row's charges (invariant 5)                              |   seeds today                    |
 * F36 | ipos.allotment_date as a LEGACY 4.2.x    | a raw pre-2M /ipos save (the route refuses it now)    | lib/analytics/ipo.ts:378 ipoTaxEstimate -> capital-gains   | the ST/LT term and its rate      | F36
 *     |   row still holds it                     |                                                      |   .ts:64 classifyTerm (orchestrator) -> /ipos              |   (20% vs 12.5%)                 |
 *
 * RED ON REVERT (2026-09-15) — 16 probes. Each side's HEAD (4fd527d, the
 * wave-2H tree) copy was aliased over the working module with `vi.mock` inside
 * a deleted tests/zzprobe-fixF-* copy of THIS file, the copy itself a deleted
 * tests/zzseam-head-*.ts (`git show HEAD:<path>`, relative imports rewritten to
 * the @/ alias). No product file was touched. Every probe reddened its own
 * seam's `it` and nothing else:
 *
 *   lib/analytics/positions.ts   → F1 (b) "the /equity tracker reads the stated 0:
 *     expected [ true, 8000, 2000, 10000 ] to deeply equal [ true, +0, 10000, 10000 ]"
 *   lib/analytics/data-quality.ts → F1 (a) "a stated 0 is not a missing figure:
 *     expected [ 1, [ 1 ] ] to deeply equal [ +0, [] ]"; and F5 "a price of 0 never
 *     proves the sale differs: expected [ false, true ] to deeply equal [ true, false ]"
 *   app/reports/broker-compare/page.tsx → F1 (a) "the re-pricing bills no interest on
 *     a stated 0: expected Set{ '₹54', '₹85', '₹99', '₹102', …(3) } to deeply equal Set{ '₹0' }"
 *   components/trades/close-trade-dialog.tsx → F2 "the cleared-date preview is the save:
 *     expected [ 1000, 121.72, 878.28 ] to deeply equal [ 1000, 220.92, 779.08 ]"
 *   lib/trash.ts                 → F3 "Restored 1 trade. 1 could not be restored —
 *     SEAMF3: an identical trade is already in the journal (recorded in the position it
 *     closed). …: expected [ true, 1, [ { id: 5, …(2) } ] ] to deeply equal [ true, 2, [] ]"
 *   lib/queries/account-delete.ts → F4 "Merged “fixF 1706” into “fixF 1705” — 1 trade
 *     moved, 1 duplicate skipped …: expected [ true, 1 ] to deeply equal [ true, 2 ]";
 *     and F13 "the IPO follows its trade to the row that survived: expected [ 1719, null ]
 *     to deeply equal [ 1719, 26 ]"
 *   lib/import/cross-source.ts   → F6 "the remedy counts the STORED rows, not the
 *     incoming ones: expected '1 row in this pull (SEAMF6) restates …' to contain
 *     'the 2 earlier rows can be deleted fro…'"
 *   lib/import/dhan-unfetched.ts → F7 "each book's own outstanding notice is carried:
 *     expected +0 to be 1" (the second carry was never written)
 *   components/import/broker-connect.tsx → F7 "expected [ null, undefined, undefined ]
 *     to deeply equal [ null, …(2) ]" (the Clear body named no sentence)
 *   app/api/import/broker/route.ts → F7 "expected [ [ null, '10:30' ] ] to deeply equal
 *     [ [ null, '14:30' ] ]" — the line the user clicked stayed listed and the OTHER
 *     book's gap was dismissed in its place
 *   app/trades/actions.ts        → F8 "AuditShapeError: recordAudit(trade/update):
 *     before/after key sets differ — only in before: [] only in after: [ipoId]" (the
 *     throw came AFTER the insert and the trade UPDATE, which is why nothing covered it)
 *   lib/queries/delete.ts        → F9 (a) "the restored link: expected null to be 18"
 *   lib/db/data-fixes.ts         → F10 "expected [ 'paytm-dedup-isin-v1' ] to include
 *     'ipo-account-rehome-v1'"
 *   lib/analytics/ipo-link.ts    → F8, F9 (a/b), F11: the route imports `syncOwnsClose`,
 *     so a whole-module revert is a wiring error ("No \"syncOwnsClose\" export is defined
 *     on the … mock") rather than a number. The clean one is the CONSUMER half:
 *   app/api/ipos/route.ts, hand-reverted on a copy to the pre-J4 rule
 *     (`writesCharges = patch.chargesTotal != null && (!heldOwnSale || statesNoCharges)`)
 *     → F11 "the old exit's bill is not left behind: expected 17.06 not to be 17.06"
 *   lib/queries/trades.ts        → F12 "the holding is found where it is held: expected
 *     [ { strikes: '300', …(3) } ] to deeply equal [ { strikes: '300', …(3) } ]" (its own
 *     account read short-call/Unlimited where the card is a covered call)
 *
 * NOT proven red by a revert: F9 (b), the account PURGE. J2's own report says so
 * — the purge's `ipos` rows ride back inside `accountRows.ipos` with `trade_id`
 * intact, so its `ipoRefs` are inert; the case is a standing guard on that
 * branch (and on the merge re-point K1 landed in the same file), not a
 * regression pin. Its consumer half (trash.ts' re-link loop) is proven by F9 (a).
 *
 *
 * RED ON REVERT, WAVE 2L (2026-09-15) - 11 more probes, same method, this time
 * against HEAD = cd1ab70 (the wave 2I+2J+2K tree). Each product module was
 * aliased onto a `git show HEAD:<path>` copy inside a deleted
 * tests/zzprobe-fixL-*.test.ts / tests/zzseam-head-*.ts pair; no product file
 * was touched. Every probe reddened its own seam's `it` and nothing else:
 *
 *   lib/db/data-fixes.ts         -> F14 "an archived book is not a destination:
 *     expected [ 1721, 30 ] to deeply equal [ 1722, 30 ]" - the record was moved INTO
 *     the archived book, which the account switcher never lists
 *   lib/queries/trades.ts        -> F15 "the holding is found where it is held:
 *     expected [ { strikes: '2800', ...(2) } ] to deeply equal [ { strikes: '2800',
 *     ...(2) } ]" (short-call / Unlimited in the account that HOLDS the shares)
 *   app/strategies/page.tsx      -> F15, the same assertion: the page's own
 *     `isin.trim().toUpperCase()` reaches neither end of an Alt+Enter mid-cell
 *   lib/analytics/positions.ts   -> F16 "a partly sold leg states no own capital and no
 *     ROI on it: expected [ true, -3000, null ] to deeply equal [ true, null, null ]"
 *   components/risk/mtf-drift-card.tsx -> F16 "the card names what it is not showing:
 *     expected ' MTF margin check list as of 2026-09-...' to contain '1 open MTF
 *     position is not priced'" (HEAD's card has no `unpriced` prop at all)
 *   app/api/ipos/route.ts        -> F17 (the notes-only save answered 409 with "That
 *     holding is a staged position built from more than one fill. ... Unlink the
 *     holding here to edit this IPO."), F18 "the provenance the next edit will ask
 *     about: expected '' to contain 'Exit charges computed from the linked...'", and
 *     F19 "expected [ 200, undefined ] to deeply equal [ 409, 'CLOSE_IN_TRADES' ]"
 *   lib/import/commit.ts         -> F18 "whoever changes the charges owns them: expected
 *     'Exit charges computed from the linked...' not to contain 'Exit charges computed
 *     from the linked...'"; and F20 "SqliteError: NOT NULL constraint failed:
 *     trades.charges_total_paise" - the very throw the fix exists for, unhandled
 *   lib/import/cross-source.ts   -> F21 "today's snapshot IS the blocker, so it is what
 *     is reported: expected '1 row in this file (SEAML4) look like...' to contain
 *     'restates an instrument today's earli...'"
 *   lib/trash.ts                 -> F22 (a) "re-linked by the holding's own record:
 *     expected null to be 44"
 *   lib/queries/data-quality.ts  -> F22 (b) "the pair is named, not guessed: expected
 *     undefined to be 'IPO record not linked to its holding'"
 *   lib/queries/account-delete.ts -> F23 "Merged “fixF 1734” into “fixF 1733” - 0 trades
 *     moved, 1 duplicate skipped (saved to Deleted items).: expected true to be false"
 *     (the source round trip, with its purchase leg, deleted whole); and F24, whose
 *     preview read "2 IPO records are linked to those trades" and whose merge put BOTH
 *     records on the surviving copy
 *
 * NOT proven red by a revert, and why:
 *   F25 - J1's no-`fact` Clear is the COMPATIBILITY branch: it pins the behaviour a
 *     revert restores, so no revert can redden it. The named path is F7.
 *   F26 - the one-gross-arithmetic fix is I4's and is already at HEAD; what was missing
 *     was the case ACROSS the computeIpo <-> trade-row seam at 3+ decimals, which is
 *     what this is. Red only against the pre-2I build.
 *   F14's L5 half (`ipoIdsCountedThroughTrades` given one home) could not be probed by a
 *     whole-module revert: app/api/ais/route.ts now imports that symbol FROM
 *     lib/queries/ipos.ts, so HEAD's copy of that file is a wiring error rather than a
 *     number. Its L3 half (the archived guard) is the probe quoted above, and the
 *     counted-once numbers are asserted in all three views in the same `it`.
 *   F23 (b) - the REVERSE merge refusal is I2's and is already at HEAD, so the same
 *     probe that reddens F23 (a) leaves (b) green. It is here because the re-check named
 *     it a boundary with no seam case (new_defects[4]): what it pins is that
 *     previewAccountDelete's warning and deleteAccount's refusal state the SAME fact,
 *     in BOTH directions of `identityClash` - the drift a shared helper exists to stop.
 *   F10's two added controls (a same-account link, a link naming a trade that is gone)
 *     are a coverage fix for an over-claiming title - HEAD's SQL skips both already.
 *
 *
 * RED ON REVERT, WAVE 2M (2026-09-16) - 5 probes, same method, HEAD = b6e2353
 * (the tree the two builders started from). Each product module was aliased onto
 * a `git show HEAD:<path>` copy inside a deleted tests/zzprobe-SEAM-red.test.ts
 * / tests/zzseam-head-*.ts pair; no product file was touched. Verbatim:
 *
 *   lib/trash.ts                 -> F27 "re-linked from facts both rows already
 *     state: expected null to be 1" - HEAD hands the pairing no dates at all, so the
 *     ISSUE-named record matches nothing and the holding comes back UNLINKED
 *   lib/analytics/data-quality.ts -> F27, the same null (no tier B exists); and F31
 *     "the day the ladder stored is the day the pairing reads: the given combination
 *     of arguments (undefined and string) is invalid" - HEAD raises no issue for that
 *     holding at all, because ipoOrphanPairs finds no MATCH to ask about
 *   lib/queries/data-quality.ts  -> F27 "the live rows reach the same verdict the
 *     envelope's did: expected 'Trade #1 (P27TECH) is recorded as an ...' to contain
 *     '#1 P27 Technologies Limited (matches ...'"; and F31 the same, for P31LOG -
 *     HEAD selects none of the four tier-B columns, so the note has no verdict in it
 *   lib/queries/staged.ts        -> F31 "expected '02-03-2026' to be '2026-03-02'" -
 *     the day-first exit leg is stored as typed, the PARENT's sell date becomes
 *     '02-03-2026', and `isoDay` answers null for it
 *   components/trades/edit-trade-dialog.tsx -> F30 "the day-first preview is the
 *     save: expected [ 5500, 168.71, 5331.29 ] to deeply equal [ 5500, 405.42,
 *     5094.58 ]" (the raw date is an Invalid Date, daysHeld NaN, JSON null, the
 *     route's `?? 0` bills ZERO of the real 30 days); and F33 "no figure, and
 *     nothing sent: expected { broker: 'zerodha', ...(15) } to be null"
 *
 * NOT proven red by a revert, and why:
 *   F32 - a STANDING PIN on a boundary the wave created, not a regression pin. Both
 *     blank rules are unchanged BEHAVIOUR (HEAD's close dialog restates the same
 *     calendar in a private `realDay`; the editor's blank has always billed 0 days),
 *     so no revert of either half moves a figure. What had no case at all is that the
 *     two dialogs answer a blank field DIFFERENTLY, deliberately, and that each
 *     answer equals its OWN save across the IST day boundary.
 *
 * RED ON REVERT, THE SEAM ROUND (2026-09-16) - 8 more probes, same method. For
 * app/trades/actions.ts, app/api/ipos/route.ts and lib/analytics/capital-gains.ts
 * a `git show HEAD:<path>` copy IS the pre-fix state (B-IPO/B-DATE never touched
 * them). For the four files wave 2M had already changed, the probe hand-reverted
 * ONLY the seam-round hunk on a COPY, so the pre-state is "wave 2M as the two
 * builders left it"; where a HEAD copy was used instead it is named.
 *
 *   app/trades/actions.ts (HEAD = pre-D3) -> F34 "refused in the same words:
 *     expected [ true, …(1) ] to deeply equal [ false, …(1) ]  -   'The acquisition
 *     date “0002-06-15” is not a real calendar day - …'  +   'Cost basis set - this
 *     trade now counts toward your edge.'" - the half-typed year was SAVED, into
 *     acquisition_date and buy_date both
 *   app/api/ipos/route.ts (HEAD = pre-D2) -> F29 "the day it states, not the
 *     keystrokes: expected '20-02-2026' to be '2026-02-20'"
 *   lib/analytics/capital-gains.ts (HEAD = pre-fix) -> F36 "the day it names, and
 *     the rate that day earns: expected [ 'ST', 20 ] to deeply equal [ 'LT', 12.5 ]"
 *     - 741 days read as SHORT term through a NaN comparison, at 20% not 12.5%
 *   lib/analytics/data-quality.ts (hand-reverted to wave 2M: `ipoDay` back to the
 *     shape test, the `allotted === false` guard and `ipoAskPairs`' filter removed)
 *     -> F28 "the application row claims nothing: expected true to be false", and
 *     F29 "20-02-2026 is 2026-02-20: expected false to be true"
 *   lib/trash.ts AND lib/analytics/data-quality.ts, BOTH hand-reverted -> F28
 *     "re-linked by the record the report names: expected null to be 1" - the money
 *     failure of round 1's D1, reproduced through the real delete -> legacy envelope
 *     -> restore
 *   lib/queries/staged.ts (hand-reverted to wave 2M: `normalizeDate(...) ?? today`,
 *     guards removed) -> F35 (a) "the column the leg would have copied is what is
 *     named: expected [ true, 'Staged mode enabled.' ] to deeply equal [ false,
 *     …(1) ]" - the silent re-dating of round 1's D4
 *   lib/queries/staged.ts (HEAD copy, pre-2M entirely) -> F35 (a) the same `it`,
 *     "-  'The buy date “2026-02-31” is not …'  +  'The entry date “2026-02-31” is
 *     not …'" (the leg is INSERTED first and the REBUILD refuses - the orphan leg
 *     invariant 5 forbids); and F35 (b) "SqliteError: NOT NULL constraint failed:
 *     trade_legs.charges_total_paise" - the day-first row could not be written at all
 *
 * ONE HALF EACH, measured and stated rather than hidden: reverting ONLY
 * lib/trash.ts:827's WHERE, or ONLY lib/queries/data-quality.ts:104's, leaves all
 * 7 probe cases GREEN. D1's rule is stated three times (both SQL reads and the
 * pure matcher), so each half alone is redundant by design - S-IPO's own report
 * says so. The RULE is red on the pure statement, and the WRITE is red on both
 * halves together (quoted above).
 *
 * F28, F29 - round 1's SEAM DEFECTS, now FIXED: the two `it.fails` are plain `it`s
 * and their companion cases carry the measured before/after in a one-line comment.
 *
 * SEAM DEFECTS found by a pass are reported to the orchestrator, not fixed here.
 *
 * ONE temp database for this file (AGENTS.md Testing). Each seam owns its accounts.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
  redirect: () => {},
}));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let importer: typeof import("@/lib/import/commit");
let actions: typeof import("@/app/trades/actions");
let tradeQueries: typeof import("@/lib/queries/trades");
let slim: typeof import("@/lib/domain/slim-trade");
let trash: typeof import("@/lib/trash");
let deleteQ: typeof import("@/lib/queries/delete");
let dqQueries: typeof import("@/lib/queries/data-quality");
let closeStaleRoute: typeof import("@/app/api/data-quality/close-stale/route");
let trashRoute: typeof import("@/app/api/trash/route");
let chargesPreview: typeof import("@/app/api/charges/preview/route");
let accountDelete: typeof import("@/lib/queries/account-delete");
let ipoQueries: typeof import("@/lib/queries/ipos");
let ipoRoute: typeof import("@/app/api/ipos/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let unfetched: typeof import("@/lib/import/dhan-unfetched");
let dhanApi: typeof import("@/lib/import/api/dhan");
let dataFixes: typeof import("@/lib/db/data-fixes");
let crossSource: typeof import("@/lib/import/cross-source");
/** Records, so a builder's export that a revert removes fails ITS assertion, not the file. */
let bc: Record<string, unknown> & typeof import("@/components/import/broker-connect");
let ipoUi: Record<string, unknown> & typeof import("@/components/ipo/ipo-client");
let closeDialog: Record<string, unknown> & typeof import("@/components/trades/close-trade-dialog");
/** Wave 2M: the trade editor, read the same way — `editPreviewBody` may be absent on a revert. */
let editDialog: Record<string, unknown> & typeof import("@/components/trades/edit-trade-dialog");
let dq: typeof import("@/lib/analytics/data-quality");
let Dialog: typeof import("@/components/ui/dialog").Dialog;
let EditTradeDialog: typeof import("@/components/trades/edit-trade-dialog").EditTradeDialog;
let CloseTradeDialog: typeof import("@/components/trades/close-trade-dialog").CloseTradeDialog;
let TrackerClient: typeof import("@/components/trackers/tracker-client").TrackerClient;
let StrategiesClient: typeof import("@/components/strategies/strategies-client").StrategiesClient;
let StrategyCard: typeof import("@/components/strategies/strategy-card").StrategyCard;
let ReportTr: typeof import("@/components/ui/report-table").ReportTr;
let ReportTd: typeof import("@/components/ui/report-table").ReportTd;
let equityPage: () => unknown;
let brokerComparePage: () => unknown;
let strategiesPage: () => unknown;

const F1_ZERO = 1701; //  F1: an MTF row whose own capital paid for all of it
const F1_UNSET = 1702; // F1: an MTF row that states nothing
const F2_ACC = 1703; //   F2: the close dialog with its exit date cleared
const F3_ACC = 1704; //   F3: a joined lot and its sale, deleted together
const F4_TGT = 1705; //   F4: the merge target, holding the joined lot
const F4_SRC = 1706; //   F4: the merge source, holding the sale
const F5_ACC = 1707; //   F5: a sale that states no price beside a joined lot
const F6_ACC = 1708; //   F6: two stored rows on two keys, one incoming row
const F7_SA = 1709; //    F7: merge source A (its own last-pull time of day)
const F7_SB = 1710; //    F7: merge source B
const F7_TGT = 1711; //   F7: the merge target, listing both carries
const F8_ACC = 1712; //   F8: the holding whose IPO must not land in account 1
const F9_ACC = 1713; //   F9 (a): a linked holding deleted from /trades
const F9_PURGE = 1714; // F9 (b): a linked holding inside an account purge
const F10_ACC = 1715; //  F10: the holding whose legacy IPO sits in account 1
const F11_ACC = 1716; //  F11: the sync's own close, re-priced
const F12_A = 1717; //    F12: a call with no units of its own
const F12_B = 1718; //    F12: the units, under a lower-case padded ISIN
const F13_TGT = 1719; //  F13: the merge target, holding the surviving copy
const F13_SRC = 1720; //  F13: the merge source, its IPO linked to the duplicate
// ── wave 2L, and the wave-2I boundaries its re-check found unpinned ─────────
const F14_ARCH = 1721; //  F14: the holding's book, ARCHIVED (the re-home skips it)
const F14_REC = 1722; //   F14: the book the IPO record is filed in
const F15_A = 1723; //     F15: a call with no units of its own
const F15_B = 1724; //     F15: the units, under an ISIN carrying a tab and an NBSP
const F16_ACC = 1725; //   F16: a partly sold MTF leg beside an unpriced one
const F17_ACC = 1726; //   F17: an IPO linked to a holding booked on a ladder
const F18_ACC = 1727; //   F18: the sync's charges, across a rate correction
const F19_ACC = 1728; //   F19: a close the USER recorded, and one the sync wrote
const F20_ACC = 1729; //   F20: an exit date that is not a calendar day
const F21_ACC = 1730; //   F21: an older cross-FILE row before today's snapshot
const F22_ACC = 1731; //   F22: a pre-4.3.0 Trash envelope (no ipoRefs)
const F22_TWO = 1732; //   F22: two records that could be the one holding's
const F23_TGT = 1733; //   F23: the merge target, holding the alias
const F23_SRC = 1734; //   F23: the merge source, a CLOSED round trip on that hash
const F24_TGT = 1735; //   F24: the target, whose surviving copy has its own IPO
const F24_SRC = 1736; //   F24: the merge source, its own IPO on the duplicate
const F24_OTHER = 1737; // F24: a THIRD book whose IPO names that duplicate
const F25_SA = 1738; //    F25: merge source A (the span's FIRST record)
const F25_SB = 1739; //    F25: merge source B
const F25_TGT = 1740; //   F25: the target carrying both
const F26_ACC = 1741; //   F26: a 3-decimal exit over a 3-decimal issue price
const F23R_SRC = 1742; //  F23 (b): the REVERSE direction — the SOURCE holds the alias
const F23R_TGT = 1743; //  F23 (b): the target storing the row that alias names
// ── wave 2M (G-G2-1 the IPO pairing; G-G3-1 / G-G3-2 the one calendar) ────────
const F27_ACC = 1744; //   F27: an ISSUE-named record and its holding, one book
const F28_ACC = 1745; //   F28: the same, plus the application row the report never sees
const F29_ACC = 1746; //   F29: an allotment date the route stores day-first
const F30_ACC = 1747; //   F30: the editor's day-first buy date on an MTF row
const F31_ACC = 1748; //   F31: a staged IPO holding whose exit leg is posted day-first
const F32_ACC = 1749; //   F32: the two dialogs' blank dates across the IST boundary
const F33_ACC = 1750; //   F33: a legacy row whose stored sell date is not a day
// ── wave 2M, the SEAM ROUND (D1..D4 fixed; F34..F36 are the cases they needed) ─
const F34_ACC = 1751; //   F34: a sale whose basis is typed on the acquisition panel
const F35_ACC = 1752; //   F35: legacy rows converted to a ladder
const F36_ACC = 1753; //   F36: an IPO record whose stored allotment day is legacy
const ACCOUNTS = [F1_ZERO, F1_UNSET, F2_ACC, F3_ACC, F4_TGT, F4_SRC, F5_ACC, F6_ACC, F7_SA, F7_SB, F7_TGT, F8_ACC, F9_ACC, F9_PURGE, F10_ACC, F11_ACC, F12_A, F12_B, F13_TGT, F13_SRC,
  F14_ARCH, F14_REC, F15_A, F15_B, F16_ACC, F17_ACC, F18_ACC, F19_ACC, F20_ACC, F21_ACC, F22_ACC, F22_TWO, F23_TGT, F23_SRC, F24_TGT, F24_SRC, F24_OTHER, F25_SA, F25_SB, F25_TGT, F26_ACC,
  F23R_SRC, F23R_TGT, F27_ACC, F28_ACC, F29_ACC, F30_ACC, F31_ACC, F32_ACC, F33_ACC, F34_ACC, F35_ACC, F36_ACC];

// ONE temp database for this file. Re-measured locally 2026-09-15 with F14..F26
// added (vitest's own per-test times, 29 `it`s): the slowest `it` is 102 ms
// (F1 a), then 97 (F18), 83 (F14); the 29 sum to ~1.0 s and the file's wall
// clock is 2.4 s, the rest of it hooks — this one (migrate + seed + the core
// modules) 1.1-1.3 s, F7's (the broker route's first GET, a vault sweep)
// ~1.6 s, the rest 0.2-0.6 s. All inside the local budget of <= 300 ms per `it`
// and <= 3 s per hook; the raised timeouts are for the Windows runner, measured
// > 15x slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("seams-v43-fixF", { seed: true });
  importer = await import("@/lib/import/commit");
  actions = await import("@/app/trades/actions");
  tradeQueries = await import("@/lib/queries/trades");
  slim = await import("@/lib/domain/slim-trade");
  t.db
    .insert(t.schema.accounts)
    .values(ACCOUNTS.map((id) => ({ id, name: `fixF ${id}`, isDefault: false })))
    .run();
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── shared harness ───────────────────────────────────────────────────────────

const freezeAt = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};
const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const json = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** A module's export, or undefined — never a throw on a build that lacks it. */
const exported = (m: Record<string, unknown>, k: string): unknown => (Object.keys(m).includes(k) ? m[k] : undefined);
const NO_STATE = { ok: false, message: "" };

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan",
    isin: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    grossPnl: 0,
    unrealisedPnl: 0,
    buyDate: null,
    sellDate: null,
    productHint: "delivery",
    exchangeHint: "NSE",
    sourceFile: null,
    ...over,
  } as NormalizedTrade;
}
const parsed = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings: [] });
/** The importer's own commit of one Dhan delivery fill aggregate. */
function commitFill(accountId: number, sym: string, side: "BUY" | "SELL", qty: number, price: number, day: string) {
  const tr =
    side === "BUY"
      ? trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: day })
      : trade({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: day });
  const res = importer.commitParsedFile(parsed([tr]), `fixF-${accountId}-${sym}-${side}-${day}-${qty}-${price}`, null, accountId);
  expect(res.added, `${sym} ${side} ${qty} @${price} ${day}`).toBe(1);
  return rowsOf(accountId).at(-1)!;
}

/** Every `<input name=… value=…>` a server render prints, as the browser would post it. */
function formOf(html: string): FormData {
  const fd = new FormData();
  for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    if (!name) continue;
    fd.append(name, unescape(/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? ""));
  }
  return fd;
}
/** The trade as /trades ships it to the client (the RSC payload is JSON). */
function wireTrade(accountId: number, id: number) {
  selectAccount(accountId);
  const r = tradeQueries.getJournalTrades().find((x) => x.id === id);
  if (!r) throw new Error(`/trades does not list trade ${id} in account ${accountId}`);
  return JSON.parse(JSON.stringify(slim.toSlimTrade(r))) as ReturnType<typeof slim.toSlimTrade>;
}
type WireTrade = ReturnType<typeof wireTrade>;
/** The trade editor's form as it opens on this trade, with the user's changes typed in. */
function editorForm(accountId: number, id: number, typed: Record<string, string>) {
  const html = renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(EditTradeDialog, { trade: wireTrade(accountId, id), onDone: () => {} })));
  const fd = formOf(html);
  for (const [k, v] of Object.entries(typed)) fd.set(k, v);
  return fd;
}

// The React element tree a server page returns, walked for the props it hands a
// client component (the RSC payload's own shape) — never the rendered string.
type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
function walk(node: unknown, visit: (e: Elem) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!isElem(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
function findElem(node: unknown, pick: (e: Elem) => boolean): Elem | null {
  let hit: Elem | null = null;
  walk(node, (e) => {
    if (!hit && pick(e)) hit = e;
  });
  return hit;
}
/** Every string a subtree prints, in order — a rendered cell without a DOM. */
function textLeaves(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textLeaves(n, out);
    return out;
  }
  if (isElem(node)) textLeaves(node.props.children, out);
  return out;
}

// ============================================================================
// F1 — a STORED MTF funded 0 (commit.ts, wave 2H) ↔ its three READERS
//      (positions.ts + broker-compare, I1; data-quality.ts, I2)
// ============================================================================

describe("F1 · an MTF position paid for in full out of own capital (the editor's save) read by /equity, the broker comparison and Data Quality", () => {
  const mtfRow = (accountId: number, sym: string) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: sym, tradingsymbol: sym,
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

  /** The MTF-interest cell of every priced broker row, as the report prints it. */
  function mtfInterestCells(accountId: number): string[] {
    selectAccount(accountId);
    const tree = brokerComparePage();
    const cells: string[] = [];
    walk(tree, (e) => {
      if (e.type !== ReportTr) return;
      const tds: string[] = [];
      walk(e.props.children, (c) => {
        if (c.type === ReportTd) tds.push(textLeaves(c.props.children).join(""));
      });
      // A broker with no rate card prints ONE cell across the row ("no rates
      // configured"); it prices nothing, so it states no interest either.
      if (tds.length >= 6) cells.push(tds[5]!);
    });
    return cells;
  }

  beforeAll(async () => {
    trash = await import("@/lib/trash");
    dqQueries = await import("@/lib/queries/data-quality");
    Dialog = (await import("@/components/ui/dialog")).Dialog;
    EditTradeDialog = (await import("@/components/trades/edit-trade-dialog")).EditTradeDialog;
    TrackerClient = (await import("@/components/trackers/tracker-client")).TrackerClient;
    ({ ReportTr, ReportTd } = await import("@/components/ui/report-table"));
    brokerComparePage = (await import("@/app/reports/broker-compare/page")).default as () => unknown;
    equityPage = (await import("@/app/equity/page")).default as () => unknown;
  }, 60_000);

  let zeroId = 0;
  let unsetId = 0;

  it("(a) the editor's own-capital save, then Data Quality and the broker comparison: a stated 0 is a figure, and a row that states NOTHING is the one that is listed", async () => {
    freezeAt("2026-08-31T19:00:00.000Z"); // 2026-09-01 00:30 IST — the IST day boundary
    zeroId = mtfRow(F1_ZERO, "SEAMF1Z");
    unsetId = mtfRow(F1_UNSET, "SEAMF1N");
    // The PRODUCER: own capital typed as the whole buy value, through the real
    // editor render and the real server action → a stored funded amount of 0.
    const saved = await actions.updateTradeAction(NO_STATE, editorForm(F1_ZERO, zeroId, { ownCapitalUsed: "10000" }));
    expect([saved.ok, saved.message]).toEqual([true, "Trade updated."]);
    expect(row(zeroId)!.mtfFundedAmount, "the writers' null-vs-0 rule (V3/X2)").toBe(0);
    expect(row(unsetId)!.mtfFundedAmount, "and the other row states nothing").toBeNull();

    // CONSUMER 1 — Data Quality (I2). THE assertion: on revert of
    // data-quality.ts, [1, [zeroId]] — a warning telling the user to set what
    // they just set.
    selectAccount(F1_ZERO);
    const zeroIssue = dqQueries.getDataQualityReport().issues.find((i) => i.code === "mtf_funding");
    expect([zeroIssue?.count ?? 0, zeroIssue?.ids ?? []], "a stated 0 is not a missing figure").toEqual([0, []]);
    selectAccount(F1_UNSET);
    const unsetIssue = dqQueries.getDataQualityReport().issues.find((i) => i.code === "mtf_funding");
    expect([unsetIssue?.count, unsetIssue?.ids], "a row that states nothing still is").toEqual([1, [unsetId]]);

    // CONSUMER 2 — the broker comparison (I1). Every broker re-prices the SAME
    // position: a stated 0 finances nothing, so no broker bills interest on it.
    const zeroCells = mtfInterestCells(F1_ZERO);
    expect(zeroCells.length, "the report prices at least one broker").toBeGreaterThan(0);
    expect(new Set(zeroCells), "the re-pricing bills no interest on a stated 0").toEqual(new Set(["₹0"]));
    // The same row with the amount unstated IS estimated — so the column is
    // live, and the 0 above is an answer rather than an empty implementation.
    const unsetCells = mtfInterestCells(F1_UNSET);
    expect(unsetCells.some((c) => c !== "₹0"), "an unstated funded amount is still estimated").toBe(true);
  });

  it("(b) /equity's own render: the tracker's position carries own capital 10,000 against a funded 0 — never a denominator the journal never recorded", () => {
    freezeAt("2026-08-31T19:00:00.000Z");
    selectAccount(F1_ZERO);
    const el = findElem(equityPage(), (e) => e.type === TrackerClient);
    if (!el) throw new Error("the equity page no longer renders <TrackerClient>");
    const positions = el.props.positions as { id: number; isMtf: boolean; fundedAmount: number; ownCapital: number; invested: number; roiOnCapitalPct: number | null }[];
    const p = positions.find((x) => x.id === zeroId)!;
    // THE assertion (on revert of lib/analytics/positions.ts: fundedAmount 8000
    // — Zerodha's bundled own margin — and ownCapital 2000, a fabricated
    // denominator behind the "Own capital in MTF" KPI and "ROI on capital").
    expect([p.isMtf, p.fundedAmount, p.ownCapital, p.invested], "the /equity tracker reads the stated 0").toEqual([true, 0, 10000, 10000]);
  });
});

// ============================================================================
// F2 — the close dialog's preview body with the exit date CLEARED (I1)
//      ↔ the real preview route ≡ closePosition's stored charges
// ============================================================================

describe("F2 · a 30-day MTF holding closed from the Trades dialog with the exit-date field cleared (close-trade-dialog.tsx → /api/charges/preview ≡ closeTradeAction → commit.ts closePosition)", () => {
  beforeAll(async () => {
    closeDialog = (await import("@/components/trades/close-trade-dialog")) as typeof closeDialog;
    CloseTradeDialog = closeDialog.CloseTradeDialog;
    chargesPreview = await import("@/app/api/charges/preview/route");
  }, 60_000);

  /**
   * The dialog's live preview: the body its effect sends (close-trade-dialog.tsx
   * :108-131 — the dates are decided from the RESOLVED exit date), handed to the
   * real route over JSON, and the [gross, charges, net] the dialog prints. A
   * build without I1's `resolveExitIso` / `closePreviewBody` sends the body its
   * own effect built (3feb22f, verbatim) — the preview THAT build shows.
   */
  async function dialogPreview(trade: WireTrade, exitPrice: number, exitDate: string): Promise<number[]> {
    const isShort = trade.sellQty > trade.buyQty;
    // Read through the export LIST: a module without the export must not throw
    // here (vitest's mock proxy throws on an unknown key, which would redden the
    // `it` before the pre-wave body below could answer for that build).
    const resolveFn = exported(closeDialog, "resolveExitIso") as ((d: string) => string) | undefined;
    const previewFn = exported(closeDialog, "closePreviewBody") as typeof closeDialog.closePreviewBody | undefined;
    const exitIso = typeof resolveFn === "function" ? resolveFn(exitDate) : exitDate || todayIstIso();
    const dates = { buyDate: isShort ? exitIso : trade.buyDate, sellDate: isShort ? trade.sellDate : exitIso };
    let body: unknown;
    if (typeof previewFn === "function") {
      body = previewFn(trade, exitPrice, exitDate, dates);
    } else {
      const qty = Math.abs(trade.buyQty - trade.sellQty) || Math.max(trade.buyQty, trade.sellQty);
      const buyQty = isShort ? qty : trade.buyQty;
      const avgBuyPrice = isShort ? exitPrice : trade.avgBuyPrice;
      const sellQty = isShort ? trade.sellQty : qty;
      const avgSellPrice = isShort ? trade.avgSellPrice : exitPrice;
      body = {
        broker: trade.broker, tradingsymbol: trade.tradingsymbol, segment: trade.segment, exchange: trade.exchange,
        buyValue: buyQty * avgBuyPrice, sellValue: sellQty * avgSellPrice, buyQty, sellQty, grossPnl: (avgSellPrice - avgBuyPrice) * qty,
        ownCapitalUsed: trade.mtfFundedAmount != null ? Math.max(0, buyQty * avgBuyPrice - trade.mtfFundedAmount) : null,
        daysHeld: trade.buyDate ? Math.max(0, Math.floor((new Date(exitDate).getTime() - new Date(trade.buyDate).getTime()) / 86400000)) : 0,
        isOpen: false, ...dates,
      };
    }
    const res = await chargesPreview.POST(json("/api/charges/preview", JSON.parse(JSON.stringify(body))));
    const p = (await res.json()) as { grossPnl: number; netPnl: number; breakdown: { total: number } };
    expect(res.status, JSON.stringify(p)).toBe(200);
    return [p.grossPnl, p.breakdown.total, p.netPnl];
  }

  it("the user clears the date and confirms: the preview bills the real holding period, and it is the bill the save stores", async () => {
    // 18:30-24:00 UTC: the IST day is already tomorrow, which is the date the
    // cleared field resolves to on BOTH sides.
    freezeAt("2026-08-31T19:00:00.000Z");
    expect(todayIstIso()).toBe("2026-09-01");
    const id = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F2_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "SEAMF2", tradingsymbol: "SEAMF2",
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1, mtfFundedAmount: 8000, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    const html = renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(CloseTradeDialog, { trade: wireTrade(F2_ACC, id), onDone: () => {} })));
    const fd = formOf(html);
    fd.set("exitPrice", "110");
    fd.set("exitDate", ""); // the user clears the pre-filled date
    const shown = await dialogPreview(wireTrade(F2_ACC, id), 110, "");
    const closed = await actions.closeTradeAction(NO_STATE, fd);
    expect(closed.ok, closed.message).toBe(true);

    const r = row(id)!;
    // The save's own rule: a blank date is the IST day, and the funded principal
    // accrues for the whole holding period.
    expect([r.isOpen, r.sellDate, r.mtfFundedAmount], "closePosition's stored close").toEqual([false, "2026-09-01", 8000]);
    expect(r.mtfInterest, "31 days of interest on ₹8,000").toBeGreaterThan(0);
    // THE assertion (on revert of close-trade-dialog.tsx: daysHeld is NaN from
    // `new Date("")`, JSON sends null and the route bills 0 days — a preview of
    // ₹86.32 charges beside a stored ₹152.85).
    expect(shown, "the cleared-date preview is the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
  });
});

// ============================================================================
// F3 — deleteTradesByIds' envelope (I4) ↔ trash.ts' restore (I2) ↔ the Data
//      Quality section (I2)
// ============================================================================

describe("F3 · a Data Quality-joined lot and the sale its alias names, deleted together from /trades and restored from Deleted items", () => {
  const SYM = "SEAMF3";
  beforeAll(async () => {
    closeStaleRoute = await import("@/app/api/data-quality/close-stale/route");
    trashRoute = await import("@/app/api/trash/route");
    deleteQ = await import("@/lib/queries/delete");
  }, 60_000);

  const join = (lotId: number, saleId: number) =>
    closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId, saleId, exitDate: "2026-08-25" }));
  const restore = async (id: string) =>
    (await (await trashRoute.POST(json("/api/trash", { action: "restore", id }))).json()) as {
      ok: boolean; restored: number; skipped: { id: number; reason: string }[]; message: string;
    };

  it("both rows come back and Data Quality reads exactly what it read before; a lot restored beside the STORED sale is still refused", async () => {
    selectAccount(F3_ACC);
    const lot = commitFill(F3_ACC, SYM, "BUY", 100, 200, "2026-08-20");
    const sale = commitFill(F3_ACC, SYM, "SELL", 100, 250, "2026-08-25");
    expect((await join(lot.id, sale.id)).status).toBe(200);
    // How the book holds the pair side by side with no user mistake: the join's
    // own snapshot restores the sale once the lot has been re-opened (V1: an
    // alias is held only while the closing leg holds quantity), then the lot is
    // closed again in the editor.
    const joinSnapshot = trash.listTrashSnapshots().find((s) => s.reason.startsWith(`joined to trade #${lot.id} (`))!.id;
    expect(importer.updateManualTrade(lot.id, { sellQty: 0, avgSellPrice: 0, sellDate: null }).ok).toBe(true);
    expect((await restore(joinSnapshot)).restored, "the sale returns").toBe(1);
    expect(importer.updateManualTrade(lot.id, { sellQty: 100, avgSellPrice: 250, sellDate: "2026-08-25" }).ok).toBe(true);
    expect(row(lot.id)!.importNotes ?? "").toContain(`dedup-alias:${sale.dedupHash}`);

    const before = rowsOf(F3_ACC);
    const listingBefore = dqQueries.getStaleOpenSection();
    // The PRODUCER: the /trades delete of both rows, through the real action.
    const fd = new FormData();
    fd.set("ids", [lot.id, sale.id].join(","));
    const deleted = await actions.deleteTradesAction(NO_STATE, fd);
    expect(deleted.ok, deleted.message).toBe(true);
    expect(rowsOf(F3_ACC)).toEqual([]);
    const snapshotId = trash.listTrashSnapshots()[0]!.id;

    const res = await restore(snapshotId);
    // THE assertion (on revert of lib/trash.ts: {ok:false, restored:0} and
    // "…was closed with a sale this snapshot also holds…" — the whole snapshot
    // refused, and for an account-deletion envelope the whole book with it).
    expect([res.ok, res.restored, res.skipped], res.message).toEqual([true, 2, []]);
    expect(rowsOf(F3_ACC), "the book is the one the snapshot was taken from").toEqual(before);
    expect(dqQueries.getStaleOpenSection(), "and Data Quality says what it said before the delete").toEqual(listingBefore);

    // Unchanged against a row ALREADY STORED: the lot alone, restored beside the
    // sale that is back in the journal, is still refused and names the remedy.
    const lotAlone = deleteQ.deleteTradesByIds([lot.id], "F3: the lot alone", "test").snapshotId!;
    const refused = await restore(lotAlone);
    expect([refused.ok, refused.restored], refused.message).toEqual([false, 0]);
    expect(refused.message).toContain("is back in the journal");
    expect(rowsOf(F3_ACC).map((r) => r.id)).toEqual([sale.id]);
    expect((await restore(lotAlone)).restored, "the refusal stands while that sale is stored").toBe(0);
  });
});

// ============================================================================
// F4 — ONE identity predicate: the merge (I2/J2) ≡ the restore skip (I2)
//      ≡ the import dedup (commit.ts)
// ============================================================================

describe("F4 · a source sale the target's joined lot already records (account-delete.ts merge ↔ close-open-lots heldIdentityHashes ↔ trash.ts ↔ commit.ts dedup)", () => {
  const SYM = "SEAMF4";
  beforeAll(async () => {
    accountDelete = await import("@/lib/queries/account-delete");
  }, 60_000);

  it("the merge skips it like a hash duplicate, the import skips it, and a snapshot of it into the target is skipped — one predicate, three readers", async () => {
    for (const acc of [F4_TGT, F4_SRC]) {
      commitFill(acc, SYM, "BUY", 100, 200, "2026-08-20");
      commitFill(acc, SYM, "SELL", 100, 250, "2026-08-25");
    }
    const [lotT, saleT] = rowsOf(F4_TGT);
    const [, saleS] = rowsOf(F4_SRC);
    selectAccount(F4_TGT);
    expect((await closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId: lotT.id, saleId: saleT.id, exitDate: "2026-08-25" }))).status).toBe(200);
    expect(rowsOf(F4_TGT).map((r) => [r.id, r.isOpen])).toEqual([[lotT.id, false]]);
    expect(saleS.dedupHash, "the same fill from the same file kind is the same identity in both books").toBe(saleT.dedupHash);

    // READER 1 — the import dedup (commit.ts, unchanged): re-pulling that fill
    // into the target is a duplicate, because the lot records it.
    const again = importer.commitParsedFile(
      parsed([trade({ tradingsymbol: SYM, sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-25" })]),
      `fixF-${F4_TGT}-${SYM}-SELL-2026-08-25-100-250`,
      null,
      F4_TGT,
    );
    expect([again.added, again.skipped], "the import reads the alias").toEqual([0, 1]);

    // READER 2 — a Deleted-items snapshot of that same sale INTO the target book.
    const snapshotId = trash.writeTrashSnapshot({
      trades: [{ ...(saleS as unknown as Record<string, unknown>), id: 940_001, accountId: F4_TGT }],
      legs: [], attachments: [], reason: "F4: the sale into the book that records it", accountId: F4_TGT,
    });
    const restored = trash.restoreTrashSnapshot(snapshotId);
    expect([restored.restored, restored.skipped.map((s) => s.id)], "the restore reads the same alias").toEqual([0, [940_001]]);
    expect(restored.skipped[0]!.reason).toMatch(/recorded in the position it closed/);

    // READER 3 — the MERGE. THE assertion (on revert of account-delete.ts, whose
    // `dedupCollisionIds` compared dedup_hash only: the sale is MOVED and the
    // merged book holds it twice — realised in the closed round trip and back as
    // an open phantom short).
    const res = accountDelete.deleteAccount({ accountId: F4_SRC, mode: "merge", targetId: F4_TGT, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 2]);
    expect(rowsOf(F4_TGT).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty]), "no phantom short beside the lot that realised that sale").toEqual([
      [lotT.id, false, 100, 100],
    ]);
  });
});

// ============================================================================
// F5 — a sale that states no price (data-quality.ts, I2) ↔ the close-stale
//      route ↔ closeStaleLot's AMBIGUOUS refusal
// ============================================================================

describe("F5 · a sale stating no price beside a joined lot (staleJoinExempts → getStaleOpenSection → /api/data-quality/close-stale)", () => {
  const SYM = "SEAMF5";
  it("the pair is ambiguous on screen and the one-click refuses 409 AMBIGUOUS, changing nothing", async () => {
    selectAccount(F5_ACC);
    const l1 = commitFill(F5_ACC, SYM, "BUY", 100, 200, "2026-08-20");
    const s1 = commitFill(F5_ACC, SYM, "SELL", 100, 250, "2026-08-25");
    expect((await closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId: l1.id, saleId: s1.id, exitDate: "2026-08-25" }))).status).toBe(200);
    const l2 = commitFill(F5_ACC, SYM, "BUY", 100, 210, "2026-08-21");
    // A sale the broker stated with no price at all (the column is NOT NULL
    // DEFAULT 0, so "unstated" arrives as 0).
    const s0 = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F5_ACC, broker: "dhan", segment: "eq_delivery", symbol: SYM, tradingsymbol: SYM,
          sellQty: 100, avgSellPrice: 0, sellValue: 0, sellDate: "2026-08-28", isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    const section = dqQueries.getStaleOpenSection();
    const pair = section.pairs.find((p) => p.lotId === l2.id && p.saleId === s0)!;
    // THE assertions (on revert of lib/analytics/data-quality.ts: the 0 reads as
    // "a different price", the joined lot is exempted, and the pair is offered a
    // CRITICAL one-click onto a sale L1 may already count).
    expect([pair.ambiguous, pair.oneClick], "a price of 0 never proves the sale differs").toEqual([true, false]);
    const before = rowsOf(F5_ACC);
    const res = await closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId: l2.id, saleId: s0, exitDate: "2026-08-28" }));
    const body = (await res.json()) as { ok: boolean; code?: string; message: string };
    expect([res.status, body.code], body.message).toEqual([409, "AMBIGUOUS"]);
    expect(rowsOf(F5_ACC), "nothing was changed").toEqual(before);
  });
});

// ============================================================================
// F6 — the M1 ask counted on the STORED rows (cross-source.ts, I3) ↔ the pull
//      route's 409 (J1) ↔ the dialog's copy (J1)
// ============================================================================

describe("F6 · one incoming row against TWO stored rows of today's earlier pull, on two different keys (commit.ts planSnapshot → cross-source → route 409 → collisionDialogCopy)", () => {
  const clientOf = (accountId: number) => `40000${accountId}`;
  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  beforeAll(async () => {
    brokerRoute = await import("@/app/api/import/broker/route");
    bc = (await import("@/components/import/broker-connect")) as typeof bc;
    crossSource = await import("@/lib/import/cross-source");
  }, 60_000);

  const addDhan = (accountId: number) =>
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
      .run(accountId, clientOf(accountId), alive());
  const position = (accountId: number, symbol: string, productType: string, exchangeSegment: string, buyQty: number, buyAvg: number) => ({
    dhanClientId: clientOf(accountId),
    tradingSymbol: symbol,
    positionType: "LONG",
    exchangeSegment,
    productType,
    buyAvg,
    buyQty,
    sellAvg: 0,
    sellQty: 0,
    netQty: buyQty,
  });
  const stub = (positions: unknown[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      const body = u.host === "auth.dhan.co" ? { accessToken: alive() } : u.pathname === "/v2/positions" ? positions : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  const pull = async (accountId: number) => {
    const res = await brokerRoute.POST(json("/api/import/broker", { action: "pull", broker: "dhan", accountId, mode: "commit" }));
    return { status: res.status, body: (await res.json()) as { needsForce?: boolean; message: string; collisions?: { symbol: string; kind: string; sameSnapshot?: boolean }[] } };
  };

  it("the 409's sentence counts the two EARLIER rows, warns they may carry the user's record and names Deleted items — and the dialog shows it whole", async () => {
    freezeAt("2026-09-08T06:30:00.000Z"); // 12:00 IST
    addDhan(F6_ACC);
    // Today's earlier pull: one instrument, two keys (intraday NSE, delivery BSE).
    stub([position(F6_ACC, "SEAMF6", "INTRADAY", "NSE_EQ", 10, 100), position(F6_ACC, "SEAMF6", "CNC", "BSE_EQ", 5, 101)]);
    expect((await pull(F6_ACC)).status).toBe(200);
    const stored = rowsOf(F6_ACC);
    expect(stored.map((r) => [r.segment, r.exchange, r.buyQty]).sort(), "two stored rows on two keys").toEqual(
      [["eq_delivery", "BSE", 5], ["eq_intraday", "NSE", 10]].sort(),
    );

    freezeAt("2026-09-08T10:30:00.000Z"); // 16:00 IST, the same IST day
    stub([position(F6_ACC, "SEAMF6", "MTF", "NSE_EQ", 15, 100.5)]);
    const blocked = await pull(F6_ACC);
    expect([blocked.status, blocked.body.needsForce]).toEqual([409, true]);
    const shown = bc.collisionDialogCopy({ collisions: blocked.body.collisions ?? [], message: blocked.body.message });
    const msg = shown.serverMessage ?? "";

    // THE assertions (on revert of lib/import/cross-source.ts: "…is not written
    // over that row. … the earlier row can be deleted …; committing anyway keeps
    // both rows." — singular, reporting one of the two rows the ask stands
    // against, so following it once left the same pull refused; and no warning
    // that the row may carry what the user wrote).
    expect(msg, "the remedy counts the STORED rows, not the incoming ones").toContain("the 2 earlier rows can be deleted from Trades and the pull run again");
    expect(msg).toContain("is not written over those rows.");
    expect(msg).toContain("committing anyway adds this pull's row beside the earlier ones.");
    expect(msg).toContain("Those rows may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.");
    expect([shown.description, shown.otherSourceFooter]).toEqual(["Nothing has been committed.", false]);

    // The producer is the real pure module: the same plan, built by hand, states
    // the same sentence — so the count on the wire is planSnapshot's own.
    const direct = crossSource.detectCrossSourceDuplicates(
      [{
        broker: "dhan", symbol: "SEAMF6", tradingsymbol: "SEAMF6", buyQty: 15, sellQty: 0, buyValue: 1507.5, sellValue: 0,
        buyDate: "2026-09-08", sellDate: null, dedupHash: "f6-incoming",
        snapshotIds: stored.map((r) => r.id), snapshotOffKey: true,
      }],
      stored.map((r) => ({
        id: r.id, broker: "dhan", symbol: "SEAMF6", tradingsymbol: "SEAMF6", buyQty: r.buyQty, sellQty: r.sellQty,
        buyValue: r.buyValue, sellValue: r.sellValue, buyDate: r.buyDate, sellDate: r.sellDate, sourceFile: "f6", dedupHash: r.dedupHash,
      })),
      "f6",
    );
    expect(msg, "the route's sentence is the module's own").toBe(direct.message);

    // Every OTHER ask is byte-identical to the one HEAD (wave 2H) states: I3
    // rewrote the M1 sentence alone.
    const onKey = crossSource.detectCrossSourceDuplicates(
      [{
        broker: "dhan", symbol: "SEAMF6K", tradingsymbol: "SEAMF6K", buyQty: 20, sellQty: 0, buyValue: 2000, sellValue: 0,
        buyDate: "2026-09-08", sellDate: null, dedupHash: "f6-onkey-in", snapshotIds: [77], snapshotOffKey: false,
      }],
      [{ id: 77, broker: "dhan", symbol: "SEAMF6K", tradingsymbol: "SEAMF6K", buyQty: 10, sellQty: 0, buyValue: 1000, sellValue: 0, buyDate: "2026-09-08", sellDate: null, sourceFile: "f6k", dedupHash: "f6-onkey-stored" }],
      "f6k",
    );
    expect(onKey.message).toBe(
      "1 row in this pull (SEAMF6K) restates a position today's earlier pull already recorded, and is not written over it: " +
        "the recorded row carries detail a replacement would lose (a ladder of fills, a Data Quality join, a segment or exchange you set, or a cost basis or journal entry you recorded), or more than one position shares its instrument. " +
        "Nothing is merged or overwritten automatically; committing anyway adds this pull's row beside the earlier one.",
    );
  });
});

// ============================================================================
// F7 — a merge-carried record's identity (dhan-unfetched.ts, I5) ↔ the card's
//      named Clear body and the route's forwarding (broker-connect + route, J1)
// ============================================================================

describe("F7 · two books merged into one target with an outstanding notice on the IDENTICAL span (keepUnfetched → carryUnfetchedOnMerge → GET → card lines → Clear body → POST)", () => {
  beforeAll(async () => {
    unfetched = await import("@/lib/import/dhan-unfetched");
    dhanApi = await import("@/lib/import/api/dhan");
    // The route's first GET does the vault sweep and compiles its queries
    // (1.6 s locally, measured 2026-09-15). That belongs in the HOOK: the
    // Windows budget is <= 300 ms per `it` and <= 3 s per hook (AGENTS.md).
    await brokerRoute.GET();
  }, 60_000);

  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  const addDhan = (accountId: number) =>
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
      .run(accountId, "1000000077", alive());
  const rangeCapAt = (stamp: string) =>
    dhanApi.toParsedFile([], dhanApi.catchUpRange(stamp, "2026-09-11"), { pages: 1, truncated: false, oldest: null, newest: null }, stamp).unfetched;
  const hhmm = (s: { fact: string }) => /after (\d\d:\d\d) IST/.exec(s.fact)?.[1] ?? s.fact;
  type CardRow = { broker: string; accountId: number; unfetched?: import("@/components/import/broker-connect").UnfetchedSpan[]; unfetchedConnection?: (number | null)[] };
  async function cardRow(accountId: number): Promise<CardRow> {
    const body = (await (await brokerRoute.GET()).json()) as { connections?: CardRow[] };
    const r = (body.connections ?? []).find((c) => c.broker === "dhan" && c.accountId === accountId);
    if (!r) throw new Error(`GET lists no Dhan connection for account ${accountId}`);
    return r;
  }

  it("GET lists both lines, the Clear body of the one clicked carries ITS sentence, and the route clears exactly that record", async () => {
    selectAccount(0); // All accounts, so GET lists the target's row (invariant 8)
    unfetched.keepUnfetched(rangeCapAt("2026-05-13T09:00:00.000Z"), { connId: 91, accountId: F7_SA, source: "import" }); // 14:30 IST
    unfetched.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: 92, accountId: F7_SB, source: "import" }); // 10:30 IST
    for (const [from, name] of [[F7_SA, "book A"], [F7_SB, "book B"]] as const) {
      expect(
        t.db.transaction((tx) => unfetched.carryUnfetchedOnMerge(tx, { fromAccountId: from, toAccountId: F7_TGT, fromName: name, toName: "fixF target", source: "ui" })),
        "each book's own outstanding notice is carried",
      ).toBe(1);
    }
    addDhan(F7_TGT);

    const card = await cardRow(F7_TGT);
    const lines = bc.unfetchedLines(card);
    // THE assertion (on revert of lib/import/dhan-unfetched.ts, where every carry
    // keyed on (null, span): the second carry returned 0 and that book's sentence
    // was never stored — one line, and the other book's gap invisible).
    expect(lines.map((s) => [s.connection, hhmm(s)]), "the second book's carry is its own record").toEqual([
      [null, "14:30"],
      [null, "10:30"],
    ]);

    // The card's Clear body for a carried line names the sentence it SHOWS.
    const body = JSON.parse(JSON.stringify(bc.clearUnfetchedBody(card, lines[1]!))) as Record<string, unknown>;
    expect([body.connection, body.fact, body.remedy]).toEqual([null, lines[1]!.fact, lines[1]!.remedy]);
    const res = await brokerRoute.POST(json("/api/import/broker", body));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    // THE assertion (on revert of the card's body or the route's forwarding:
    // [[null, "10:30"]] — the line the user clicked stays listed and the OTHER
    // book's gap is dismissed in its place).
    expect(unfetched.outstandingUnfetchedRecords(F7_TGT).map((r) => [r.connection, hhmm(r)])).toEqual([[null, "14:30"]]);
    expect(bc.unfetchedLines(await cardRow(F7_TGT)).map((s) => hhmm(s))).toEqual(["14:30"]);
  });
});

// ============================================================================
// F8 — the account an IPO record is filed in (actions.ts, I4) ↔ the scoped
//      listing and the scoped write (queries/ipos.ts, route)
// ============================================================================

type Ipo = import("@/lib/analytics/ipo").IpoComputed;

describe("F8 · \"This holding came from an IPO\" pressed on a holding outside account 1 (pushTradeToIpoAction → getIposComputed → POST /api/ipos)", () => {
  beforeAll(async () => {
    ipoQueries = await import("@/lib/queries/ipos");
    ipoRoute = await import("@/app/api/ipos/route");
    ipoUi = (await import("@/components/ipo/ipo-client")) as typeof ipoUi;
  }, 60_000);

  it("the record is filed in the holding's own account: account 1 never lists it, the exit closes only that holding, and a cross-account link is refused", async () => {
    const holding = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F8_ACC, broker: "zerodha", symbol: "F8-IPO", tradingsymbol: "F8-IPO", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const inAccountOne = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: 1, broker: "zerodha", symbol: "F8-OTHER", tradingsymbol: "F8-OTHER", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    selectAccount(F8_ACC);
    const fd = new FormData();
    fd.set("tradeId", String(holding));
    const pushed = await actions.pushTradeToIpoAction(NO_STATE, fd);
    expect(pushed.ok, pushed.message).toBe(true);
    const stored = t.db.select().from(t.schema.ipos).all().find((r) => r.name === "F8-IPO")!;
    // THE assertion (on revert of app/trades/actions.ts: the insert named no
    // accountId, so the column took its schema default of 1 — and the action
    // threw AuditShapeError after the write, so `pushed.ok` was false too).
    expect([stored.accountId, stored.tradeId], "the record is filed in the holding's account").toEqual([F8_ACC, holding]);

    // The listing, both ways (on revert of lib/queries/ipos.ts' scoped join:
    // account 1 shows it, linked to the other book's holding).
    selectAccount(1);
    expect(ipoQueries.getIposComputed().rows.map((r) => r.name)).not.toContain("F8-IPO");
    selectAccount(F8_ACC);
    const mine = ipoQueries.getIposComputed().rows.find((r) => r.name === "F8-IPO")!;
    expect([mine.linked, mine.id]).toEqual([true, stored.id]);

    // The exit saved from this account closes THIS holding and nothing else.
    const otherBefore = row(inAccountOne);
    const sold = await ipoRoute.POST(json("/api/ipos", saveBody(mine, formHtml(mine), { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(sold.status, JSON.stringify(await sold.clone().json())).toBe(200);
    const h = row(holding)!;
    expect([h.isOpen, h.sellQty, h.avgSellPrice, h.sellDate]).toEqual([false, 10, 150, "2026-03-02"]);
    expect(row(inAccountOne)).toEqual(otherBefore);

    // A link this request MAKES across the boundary is refused, naming both books.
    const refused = await ipoRoute.POST(json("/api/ipos", { ...saveBody(mine, formHtml(mine)), id: undefined, name: "F8-XACCT", tradeId: inAccountOne }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toContain("belong to one account's book");
    expect(t.db.select().from(t.schema.ipos).all().filter((r) => r.name === "F8-XACCT")).toHaveLength(0);
  });
});

/** /ipos' row for `name` in the account given — the RSC payload, as JSON. */
function ipoPage(name: string, accountId: number): Ipo {
  selectAccount(accountId);
  const r = ipoQueries.getIposComputed().rows.find((x) => x.name === name);
  if (!r) throw new Error(`/ipos lists no ${name} in account ${accountId}`);
  return JSON.parse(JSON.stringify(r)) as Ipo;
}
const formHtml = (existing: Ipo) => renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(ipoUi.IpoForm, { existing, onDone: () => {} })));
const renderedExitDate = (html: string) => /Exit date<\/label><input type="date"[^>]*value="([^"]*)"/.exec(html)?.[1];
/** IpoForm.save()'s body: the form's state as it opened, the user's typing on top. */
function saveBody(e: Ipo, html: string, typed: { notes?: string; exitPrice?: string; exitDate?: string } = {}) {
  // Every helper is read through the export LIST, so a build without one answers
  // as that build's own form would rather than throwing.
  const unreadableFn = exported(ipoUi, "unreadableStoredExitDate") as ((d: string | null) => boolean) | undefined;
  const keepsFn = (exported(ipoUi, "keepsStoredExitDate") ?? exported(ipoUi, "storedAsSold")) as ((e: Ipo) => boolean) | undefined;
  const toSendFn = exported(ipoUi, "exitDateToSend") as ((stored: string | null, field: string, allotted: boolean, sold: boolean, edited: boolean) => string) | undefined;
  const storedExit = e.exitDate ?? null;
  const unreadable = typeof unreadableFn === "function" && unreadableFn(storedExit);
  const field = typed.exitDate ?? renderedExitDate(html) ?? (unreadable ? "" : (storedExit ?? ""));
  const sold = typeof keepsFn === "function" ? keepsFn(e) : false;
  const toSend = typeof toSendFn === "function" ? toSendFn(storedExit, field, e.allotted, sold, typed.exitDate !== undefined) : field;
  const linked = (e as Ipo & { tradeId?: number | null }).tradeId ?? null;
  return {
    id: e.id, name: e.name, broker: e.broker ?? "", exchange: e.exchange ?? "NSE", board: e.board ?? "mainboard", category: e.category ?? "",
    discountPerShare: e.discountPerShare > 0 ? String(e.discountPerShare) : "", appliedPrice: String(e.appliedPrice), lotSize: String(e.lotSize),
    lotsApplied: String(e.lotsApplied), allotted: e.allotted, allottedQty: e.allotted ? Math.round(e.allottedQty / e.lotSize) * e.lotSize : 0,
    listingPrice: e.listingPrice == null ? "" : String(e.listingPrice), exitPrice: typed.exitPrice ?? (e.exitPrice == null ? "" : String(e.exitPrice)),
    appliedDate: e.appliedDate ?? "", allotmentDate: e.allotmentDate ?? "", listingDate: e.listingDate ?? "",
    exitDate: toSend, notes: typed.notes ?? e.notes ?? "",
    ...(linked != null ? { tradeId: linked } : {}),
  } as Record<string, unknown>;
}

// ============================================================================
// F9 — `ipoRefs` in the Trash envelope (delete.ts, I4; account-delete.ts, J2)
//      ↔ trash.ts' re-link loop (I2) ↔ capital / the tax base / AIS
// ============================================================================

describe("F9 · a linked, exited IPO whose holding is deleted and restored (deleteTradesAction / deleteAccount → the envelope → restoreTrashSnapshot → the counted-once consumers)", () => {
  let capital: typeof import("@/lib/queries/capital");
  let taxItr: typeof import("@/lib/queries/tax-itr");
  let aisRoute: typeof import("@/app/api/ais/route");
  beforeAll(async () => {
    capital = await import("@/lib/queries/capital");
    taxItr = await import("@/lib/queries/tax-itr");
    aisRoute = await import("@/app/api/ais/route");
  }, 60_000);

  /** The three consumers that must count a linked, exited IPO's sale ONCE. */
  async function countedOnce(accountId: number) {
    selectAccount(accountId);
    const cap = capital.getCapitalSummary();
    const base = taxItr.getTaxBase();
    const res = await aisRoute.POST(json("/api/ais", { text: "nothing to parse" }));
    const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
    return {
      capital: [cap.equityRealised, cap.ipoRealised, cap.totalRealised],
      tax: [base.exitedIpos.length, base.ipoTaxRows.length, base.cgTrades.map((c) => c.netPnl)],
      ais: recon.fyTotals.map((f) => [f.fy, f.kind, f.journal]),
    };
  }

  const linkedAndSold = async (accountId: number, name: string) => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId, broker: "zerodha", symbol: name, tradingsymbol: name, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId, name, appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, allotmentDate: "2019-01-10", tradeId })
      .run();
    const e = ipoPage(name, accountId);
    const sold = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(sold.status, JSON.stringify(await sold.clone().json())).toBe(200);
    expect(row(tradeId)!.isOpen).toBe(false);
    return tradeId;
  };
  const ipoRowOf = (name: string) => t.db.select().from(t.schema.ipos).all().find((r) => r.name === name)!;

  it("(a) a /trades delete and a Deleted-items restore: the link comes back, and capital, the tax base and AIS still count that sale once", async () => {
    const tradeId = await linkedAndSold(F9_ACC, "F9-IPO");
    const before = await countedOnce(F9_ACC);
    expect(before.capital[1], "the IPO's own net is not counted beside the trade's").toBe(0);

    selectAccount(F9_ACC);
    const fd = new FormData();
    fd.set("ids", String(tradeId));
    const deleted = await actions.deleteTradesAction(NO_STATE, fd);
    expect(deleted.ok, deleted.message).toBe(true);
    expect(ipoRowOf("F9-IPO").tradeId, "the delete unlinks, never deletes").toBeNull();

    const snapshotId = trash.listTrashSnapshots()[0]!.id;
    const res = await (await trashRoute.POST(json("/api/trash", { action: "restore", id: snapshotId }))).json();
    expect((res as { ok: boolean; restored: number }).restored).toBe(1);
    // THE assertion (on revert of lib/queries/delete.ts, which wrote no
    // `ipoRefs`: the trade comes back with `ipos.trade_id` still null, and the
    // same sale is counted twice — in capital, the tax pack, the ITR export and
    // both AIS sides, with nothing on screen saying the link had gone).
    expect(ipoRowOf("F9-IPO").tradeId, "the restored link").toBe(tradeId);
    expect(await countedOnce(F9_ACC), "the restored link is counted once").toEqual(before);
  });

  it("(b) an account PURGE and its restore: the account, the holding, the IPO and the link all come back, still counted once", async () => {
    const tradeId = await linkedAndSold(F9_PURGE, "F9-PURGE");
    const before = await countedOnce(F9_PURGE);
    expect(before.capital[1], "the baseline is counted-once, not merely stable").toBe(0);

    const del = accountDelete.deleteAccount({ accountId: F9_PURGE, mode: "purge", connections: "delete" });
    expect([del.ok, del.snapshotId != null], del.message).toEqual([true, true]);
    expect(rowsOf(F9_PURGE)).toEqual([]);

    const restored = trash.restoreTrashSnapshot(del.snapshotId!);
    expect(restored.ok, restored.message).toBe(true);
    // The envelope states the whole picture (J2): the purge's own IPO rides back
    // inside `accountRows.ipos` with `trade_id` intact, and `ipoRefs` names it
    // too — inert here, load-bearing for a row in another book.
    expect(ipoRowOf("F9-PURGE").tradeId).toBe(tradeId);
    expect(await countedOnce(F9_PURGE)).toEqual(before);
  });
});

// ============================================================================
// F10 — the startup data fix (data-fixes.ts, J3) ↔ the scoped listing
//       (queries/ipos.ts, I4)
// ============================================================================

describe("F10 · a legacy IPO row filed in account 1 whose holding is in another book (runDataFixes → getIposComputed)", () => {
  beforeAll(async () => {
    dataFixes = await import("@/lib/db/data-fixes");
  }, 60_000);

  it("the fix re-homes it to its holding's account and the listing follows; a null link, a same-account link and a link naming a trade that is gone are left alone", () => {
    const holding = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F10_ACC, broker: "zerodha", symbol: "F10-IPO", tradingsymbol: "F10-IPO", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    // Written as the pre-2I button wrote it: no accountId, so the column took
    // its schema default of 1 whatever book the holding was in.
    t.db
      .insert(t.schema.ipos)
      .values({ name: "F10-IPO", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, allotmentDate: "2026-02-20", tradeId: holding })
      .run();
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: 1, name: "F10-UNLINKED", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, allotmentDate: "2026-02-20" })
      .run();
    // The other two shapes the fix must leave alone, constructed rather than
    // asserted from the SQL (the wave-2I re-check's seams[7]: this case's title
    // claimed all three and its body built only the null link).
    const sameAccount = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: 1, broker: "zerodha", symbol: "F10-SAME", tradingsymbol: "F10-SAME", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const goneId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F10_ACC, broker: "zerodha", symbol: "F10-GONE", tradingsymbol: "F10-GONE", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values([
        { accountId: 1, name: "F10-SAME", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, allotmentDate: "2026-02-20", tradeId: sameAccount },
        { accountId: 1, name: "F10-GONE", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, allotmentDate: "2026-02-20", tradeId: goneId },
      ])
      .run();
    // The link is history, not a destination: the trade it names is deleted.
    t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, goneId)).run();
    const stored = (name: string) => t.db.select().from(t.schema.ipos).all().find((r) => r.name === name)!;
    expect([stored("F10-IPO").accountId, stored("F10-IPO").tradeId]).toEqual([1, holding]);
    // Its own account cannot see it, and account 1 shows it unlinked (the join
    // is account-scoped): the state the fix exists for.
    expect(ipoQueries.getIposComputed().rows.map((r) => r.name)).not.toContain("F10-IPO");
    selectAccount(1);
    expect(ipoQueries.getIposComputed().rows.find((r) => r.name === "F10-IPO")!.linked).toBe(false);

    // The real entry point a restored backup takes (lib/db/index.ts runs the
    // same list at startup; a restore forgets the markers).
    const results = dataFixes.rerunDataFixesAfterRestore(t.sqlite);
    expect(results.map((r) => r.name)).toContain("ipo-account-rehome-v1");

    // THE assertions (on revert of lib/db/data-fixes.ts: the row stays in
    // account 1, invisible to its holding's /ipos, unreachable for a sync and
    // read as unlinked by the counted-once consumers).
    expect([stored("F10-IPO").accountId, stored("F10-IPO").tradeId], "the holding is the fact the user cannot have got wrong").toEqual([F10_ACC, holding]);
    expect(stored("F10-UNLINKED").accountId, "an ordinary application is left where it is").toBe(1);
    expect([stored("F10-SAME").accountId, stored("F10-SAME").tradeId], "a link inside its own book is nothing to move").toEqual([1, sameAccount]);
    expect([stored("F10-GONE").accountId, stored("F10-GONE").tradeId], "a link naming a trade that is gone is history, not a destination").toEqual([1, goneId]);
    expect(row(holding)!.accountId, "trades is never written").toBe(F10_ACC);
    // The listing follows: its holding's own /ipos now shows it, LINKED (the
    // join is account-scoped, so the re-home is what makes the link readable).
    const listed = ipoPage("F10-IPO", F10_ACC);
    expect([listed.linked, listed.linkedSellDate ?? null], "the holding's own /ipos reads the link").toEqual([true, null]);
    selectAccount(1);
    expect(ipoQueries.getIposComputed().rows.map((r) => r.name)).not.toContain("F10-IPO");
  });
});

// ============================================================================
// F11 — whose close the holding carries (ipo-link.ts syncOwnsClose, J4)
//       ↔ the route's charge write (J4) ↔ computeIpo's rates (I4)
// ============================================================================

describe("F11 · the exit of a linked IPO re-priced on /ipos (syncOwnsClose → syncWroteCharges → syncLinkedTrade, against charge_config)", () => {
  it("a close the sync itself wrote is re-priced whole; a sale recorded in Trades keeps its own charges; mtfInterest and pledgeCharges are never written", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F11_ACC, broker: "zerodha", symbol: "F11-IPO", tradingsymbol: "F11-IPO", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F11_ACC, name: "F11-IPO", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, allotmentDate: "2019-01-10", tradeId })
      .run();

    // The sync writes the close itself.
    const first = ipoPage("F11-IPO", F11_ACC);
    expect((await ipoRoute.POST(json("/api/ipos", saveBody(first, formHtml(first), { exitPrice: "150", exitDate: "2026-03-02" })))).status).toBe(200);
    const afterFirst = row(tradeId)!;
    const shown = ipoPage("F11-IPO", F11_ACC);
    expect([afterFirst.grossPnl, afterFirst.chargesTotal, afterFirst.netPnl]).toEqual([shown.grossPnl, shown.charges, shown.netPnl]);
    // Money it really carries, which the IPO model prices NEITHER of.
    t.db.update(t.schema.trades).set({ mtfInterest: 12, pledgeCharges: 3, chargesTotal: Math.round((afterFirst.chargesTotal + 15) * 100) / 100, netPnl: Math.round((afterFirst.grossPnl - afterFirst.chargesTotal - 15) * 100) / 100 }).where(eq(t.schema.trades.id, tradeId)).run();
    const kept = row(tradeId)!;

    // The exit is re-priced: the sync owns this close, so the eight heads it
    // prices move with it — and the row is self-consistent again.
    const second = ipoPage("F11-IPO", F11_ACC);
    expect((await ipoRoute.POST(json("/api/ipos", saveBody(second, formHtml(second), { exitPrice: "200", exitDate: "2026-03-02" })))).status).toBe(200);
    const reprice = row(tradeId)!;
    const shown2 = ipoPage("F11-IPO", F11_ACC);
    // THE assertions (on revert of lib/analytics/ipo-link.ts' syncOwnsClose: the
    // holding's price and gross move onto the new exit while its charges stay
    // computed for the OLD one — /ipos reads one net, the Trades row another).
    expect([reprice.sellQty, reprice.avgSellPrice, reprice.grossPnl], "the new exit").toEqual([10, 200, 1000]);
    expect([reprice.mtfInterest, reprice.pledgeCharges], "the two heads the IPO never prices are kept verbatim").toEqual([12, 3]);
    expect(reprice.chargesTotal, "the heads still sum to the total the row states").toBe(
      Math.round(([reprice.brokerage, reprice.sttCtt, reprice.exchangeTxn, reprice.sebi, reprice.stampDuty, reprice.ipft, reprice.gst, reprice.dpCharges, reprice.mtfInterest, reprice.pledgeCharges].reduce((s, x) => s + x, 0)) * 100) / 100,
    );
    expect(reprice.netPnl).toBe(Math.round((reprice.grossPnl - reprice.chargesTotal) * 100) / 100);
    expect(reprice.chargesTotal, "the old exit's bill is not left behind").not.toBe(kept.chargesTotal);
    // /ipos states the IPO's own net; the row states that net less the ₹15 of
    // interest and pledge fee it carries and the IPO never prices.
    expect([shown2.grossPnl, Math.round((shown2.netPnl - 15) * 100) / 100], "/ipos and the Trades row state one figure").toEqual([reprice.grossPnl, reprice.netPnl]);

    // A sale the USER recorded in Trades keeps every head (owner ruling F1).
    const userTrade = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F11_ACC, broker: "zerodha", symbol: "F11-USER", tradingsymbol: "F11-USER", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10",
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500, brokerage: 20, chargesTotal: 20, netPnl: 480, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F11_ACC, name: "F11-USER", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2019-01-10", tradeId: userTrade })
      .run();
    const userBefore = row(userTrade)!;
    const u = ipoPage("F11-USER", F11_ACC);
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(u, formHtml(u), { notes: "the contract note's own charges" })));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect([row(userTrade)!.brokerage, row(userTrade)!.chargesTotal, row(userTrade)!.netPnl], "stored charges are never rewritten").toEqual([
      userBefore.brokerage, userBefore.chargesTotal, userBefore.netPnl,
    ]);
  });
});

// ============================================================================
// F12 — a stored ISIN canonicalised on BOTH sides (queries/trades.ts ↔ the
//       strategies page, I6) ↔ the card the client renders
// ============================================================================

describe("F12 · a holding whose stored ISIN is lower-case and padded (getOpenUnderlyingPositions → page groups → StrategiesClient → StrategyCard)", () => {
  beforeAll(async () => {
    StrategiesClient = (await import("@/components/strategies/strategies-client")).StrategiesClient;
    StrategyCard = (await import("@/components/strategies/strategy-card")).StrategyCard;
    strategiesPage = (await import("@/app/strategies/page")).default as () => unknown;
  }, 60_000);

  type Group = { key: string; symbol: string; nearestExpiry: string | null } & Record<string, unknown>;
  function cardsOf(accountId: number) {
    selectAccount(accountId);
    const el = findElem(strategiesPage(), (e) => e.type === StrategiesClient);
    if (!el) throw new Error("the strategies page no longer renders <StrategiesClient>");
    return (el.props.groups as Group[])
      .filter((g) => g.symbol === "NIFTYBEES")
      .map((g) => {
        const html = renderToStaticMarkup(React.createElement(StrategyCard, { group: g as never, chart: null }));
        const text = unescape(html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|"));
        const strikes = (g.legs as { kind: string; strike: number }[]).filter((l) => l.kind !== "UL").map((l) => l.strike).sort((a, b) => a - b).join("/");
        return { strikes, strategy: String(g.strategyId ?? ""), maxLoss: String((g.capLabel as { maxLoss?: string } | undefined)?.maxLoss ?? ""), unlimited: text.includes("Unlimited") };
      })
      // Both cards carry the same expiry and symbol, so the page's own order
      // between two accounts is the account order; the STRIKE names the card.
      .sort((a, b) => a.strikes.localeCompare(b.strikes));
  }

  it("its OWN account's view bounds the call it covers, and All accounts is the union of the single-account cards", () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    const isin = bundledIsinBySymbol("NIFTYBEES")!;
    const padded = ` ${isin.toLowerCase()} `;
    expect(padded, "the fixture stores the canonical form and tests nothing").not.toBe(isin);
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({
          accountId: F12_B, broker: "angelone", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NFO",
          symbol: "NIFTYBEES", tradingsymbol: "NIFTYBEES300CESEP26", optionType: "CE", strike: 300, expiry: "2026-09-24", isOpen: true, sellQty: 100, avgSellPrice: 5,
        }),
        tradeRow({
          accountId: F12_B, broker: "angelone", symbol: "Nippon India ETF Nifty BeES", tradingsymbol: "Nippon India ETF Nifty BeES",
          isin: padded, isOpen: true, buyQty: 100, avgBuyPrice: 280, buyDate: "2026-09-01",
        }),
        tradeRow({
          accountId: F12_A, broker: "angelone", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NFO",
          symbol: "NIFTYBEES", tradingsymbol: "NIFTYBEES320CESEP26", optionType: "CE", strike: 320, expiry: "2026-09-24", isOpen: true, sellQty: 100, avgSellPrice: 4,
        }),
      ])
      .run();

    // THE assertion (on revert of lib/queries/trades.ts, whose ISIN branch
    // compared the column RAW: [{strategy:"short-call", unlimited:true}] — the
    // units the same account holds never reached the card, while on 0 another
    // account's ticker could still carry them in).
    const own = cardsOf(F12_B);
    expect(own, "the holding is found where it is held").toEqual([{ strikes: "300", strategy: "covered-call", maxLoss: "Computed at underlying = 0", unlimited: false }]);
    const other = cardsOf(F12_A);
    expect(other, "a call with no units of its own stays unbounded").toEqual([{ strikes: "320", strategy: "short-call", maxLoss: "Unlimited", unlimited: true }]);
    expect(cardsOf(0), "All accounts is each account's own card").toEqual([...own, ...other]);
  });
});

// ============================================================================
// F13 — an IPO linked to the source trade a merge DROPS as a duplicate
//       (K1, IN FLIGHT — the contract, not the build)
// ============================================================================

describe("F13 · a merge that drops a source trade as a duplicate, its IPO linked to it (account-delete.ts merge ↔ ipos.trade_id ↔ capital / tax / AIS)", () => {
  /**
   * WRITTEN AGAINST THE CONTRACT K1 WAS BUILDING WHILE THIS PASS RAN, so it was
   * expected RED. K1 landed its half of lib/queries/account-delete.ts during the
   * pass (the re-point at :783) and the case is GREEN as written — re-proved red
   * against that file at HEAD, which still nulls the link: "the IPO follows its
   * trade to the row that survived: expected [ 1719, null ] to deeply equal
   * [ 1719, 26 ]".
   *
   * J2's blocked[0] (a finding it did not fix, ruled into the K wave): a MERGE
   * double-counts a sale at merge time, before any restore. A source IPO linked
   * to a source trade the target already records has its holding deleted as a
   * duplicate; the IPO row then MOVES to the target unlinked while the target's
   * own copy of that trade stays, so the merged book counts one sale twice —
   * once as the trade's realised net, once as the IPO's own.
   *
   * The contract: a doomed DUPLICATE's `ipos.trade_id` is re-pointed at the
   * surviving TARGET row with the same (broker, dedup identity) — they are the
   * same trade, which is why the merge drops one — never nulled. Measured on
   * this fixture before K1: {eq: 497.94, ipo: 482.6, total: 980.54}.
   */
  it("the IPO follows its trade to the target's surviving copy, and the merged book counts that sale once", async () => {
    const capital = await import("@/lib/queries/capital");
    const sold = (accountId: number, name: string) =>
      t.db
        .insert(t.schema.trades)
        .values(
          tradeRow({
            accountId, broker: "zerodha", symbol: name, tradingsymbol: name, dedupHash: "f13-shared-identity",
            buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1,
            sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", sellOrderCount: 1,
            grossPnl: 500, chargesTotal: 2.06, netPnl: 497.94, isOpen: false,
          }),
        )
        .returning({ id: t.schema.trades.id })
        .get()!.id;
    const targetTrade = sold(F13_TGT, "F13-IPO");
    const sourceTrade = sold(F13_SRC, "F13-IPO");
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F13_SRC, name: "F13-IPO", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2019-01-10", tradeId: sourceTrade })
      .run();

    const res = accountDelete.deleteAccount({ accountId: F13_SRC, mode: "merge", targetId: F13_TGT, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    const ipo = t.db.select().from(t.schema.ipos).all().find((r) => r.name === "F13-IPO")!;
    expect([ipo.accountId, ipo.tradeId], "the IPO follows its trade to the row that survived").toEqual([F13_TGT, targetTrade]);
    selectAccount(F13_TGT);
    const cap = capital.getCapitalSummary();
    expect([cap.equityRealised, cap.ipoRealised, cap.totalRealised], "the merged book counts that sale once").toEqual([497.94, 0, 497.94]);
  });
});

// ############################################################################
// #  v4.3.0 FIX WAVE 2L, and the wave-2I boundaries its re-check found with
// #  no seam case at all (wave2i-recheck.json, unit "seams", new_defects[2..7])
// ############################################################################

// ============================================================================
// F14 — an ARCHIVED holding's book (data-fixes.ts, L3) ↔ the cross-account link
//       it therefore LEAVES ↔ the counted-once rule's ONE home (ipos.ts, L5)
//       ↔ capital / getTaxBase / the ITR export / both AIS sides
// ============================================================================

describe("F14 · an IPO record whose holding lives in an ARCHIVED account (runDataFixes → the link that stays → ipoIdsCountedThroughTrades → capital, tax, ITR, AIS)", () => {
  let capital: typeof import("@/lib/queries/capital");
  let taxItr: typeof import("@/lib/queries/tax-itr");
  let aisRoute: typeof import("@/app/api/ais/route");
  beforeAll(async () => {
    capital = await import("@/lib/queries/capital");
    taxItr = await import("@/lib/queries/tax-itr");
    aisRoute = await import("@/app/api/ais/route");
    dataFixes = await import("@/lib/db/data-fixes");
  }, 60_000);

  const TRADE_NET = 470.5;
  /** Every consumer that must state this ONE sale exactly once, in one view. */
  async function counted(accountId: number) {
    selectAccount(accountId);
    const cap = capital.getCapitalSummary();
    const base = taxItr.getTaxBase();
    const res = await aisRoute.POST(json("/api/ais", { text: "nothing to parse" }));
    const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
    // Both AIS sides of the one financial year this sale falls in (allotment
    // 2026-02-20, exit 2026-03-02): the purchase value and the sale consideration.
    const side = (kind: string) => recon.fyTotals.find((f) => f.fy === "2025-26" && f.kind === kind)?.journal ?? null;
    return {
      capital: [cap.equityRealised, cap.ipoRealised, cap.totalRealised],
      ipoNames: base.exitedIpos.map((r) => r.name),
      cgNets: base.cgTrades.map((r) => r.netPnl),
      itrScrips: taxItr.getItrExportRows().map((r) => r.scrip),
      itrCount: taxItr.countItrRows(),
      aisSale: side("sale"),
      aisPurchase: side("purchase"),
    };
  }

  it("the re-home leaves it where it is (an archived book cannot be selected), and the link it leaves counts that sale ONCE in this book, the other book and All accounts", async () => {
    // The All-accounts view carries every other seam's rows too, so that view is
    // read as a DELTA around this one sale; the two empty books are read whole.
    const allBefore = await counted(0);
    t.db.update(t.schema.accounts).set({ archived: true }).where(eq(t.schema.accounts.id, F14_ARCH)).run();
    const holding = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F14_ARCH, broker: "zerodha", symbol: "F14-IPO", tradingsymbol: "F14-IPO", acquisition: "ipo",
          buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", buyOrderCount: 1,
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", sellOrderCount: 1,
          grossPnl: 500, chargesTotal: Math.round((500 - TRADE_NET) * 100) / 100, netPnl: TRADE_NET, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    // The pre-2I shape: the record filed in another book, naming that holding.
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F14_REC, name: "F14-IPO", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20", tradeId: holding })
      .run();
    const stored = () => t.db.select().from(t.schema.ipos).all().find((r) => r.name === "F14-IPO")!;

    const results = dataFixes.rerunDataFixesAfterRestore(t.sqlite);
    expect(results.map((r) => r.name), "the startup fix really ran").toContain("ipo-account-rehome-v1");
    // THE assertion (on revert of lib/db/data-fixes.ts, whose SELECT did not ask
    // whether the destination is archived: the record MOVES into F14_ARCH, which
    // the account switcher never lists, so it leaves every selectable view —
    // [1722, …] → [1721, …]).
    expect([stored().accountId, stored().tradeId], "an archived book is not a destination").toEqual([F14_REC, holding]);

    // So the cross-account link STANDS, and the counted-once rule must hold in
    // all three views (L5 — one home, and the LINK read unscoped by account).
    const ipoNet = ipoPage("F14-IPO", F14_REC).netPnl;
    expect(ipoNet, "the IPO prices its own sale").toBeGreaterThan(0);

    const recordBook = await counted(F14_REC);
    expect([recordBook.ipoNames, recordBook.cgNets], "the record's own book counts the IPO: its holding is not in view").toEqual([["F14-IPO"], [ipoNet]]);
    expect(recordBook.capital, "…once, as /ipos prices it").toEqual([0, ipoNet, ipoNet]);
    expect([recordBook.itrScrips, recordBook.itrCount], "one ITR row for one sale").toEqual([["F14-IPO (IPO)"], 1]);

    const holdingBook = await counted(F14_ARCH);
    expect(holdingBook.capital, "the holding's book counts the trade, and the IPO is not in view").toEqual([TRADE_NET, 0, TRADE_NET]);
    expect([holdingBook.ipoNames, holdingBook.cgNets]).toEqual([[], [TRADE_NET]]);
    expect([holdingBook.itrScrips, holdingBook.itrCount]).toEqual([["F14-IPO"], 1]);

    // THE assertion (on revert of lib/queries/ipos.ts' getIpoRealisedNet to the
    // account-scoped LEFT JOIN: All accounts counted the trade AND the IPO — the
    // IPO's own net added on top of the holding's — while the tax pack, the ITR
    // export and both AIS sides, reading the raw link, counted it once).
    const all = await counted(0);
    expect(all.ipoNames, "All accounts: the holding is counted, so the IPO is left out").not.toContain("F14-IPO");
    expect(all.cgNets.filter((n) => n === TRADE_NET), "…once, as the trades book states it").toHaveLength(1);
    expect(all.itrScrips.filter((s) => s === "F14-IPO"), "one ITR row for one sale").toEqual(["F14-IPO"]);
    expect([
      Math.round((all.capital[0] - allBefore.capital[0]) * 100) / 100,
      Math.round((all.capital[1] - allBefore.capital[1]) * 100) / 100,
      Math.round((all.capital[2] - allBefore.capital[2]) * 100) / 100,
    ], "one sale, once, in the All-accounts totals").toEqual([TRADE_NET, 0, TRADE_NET]);
    // BOTH AIS sides, in all three views. Each book states the one allotment
    // (₹1,000 of purchase value) and the one exit (₹1,500 of sale
    // consideration) exactly once, and All accounts gains exactly one copy.
    expect([recordBook.aisPurchase, recordBook.aisSale], "the record's book states it through the IPO").toEqual([1000, 1500]);
    expect([holdingBook.aisPurchase, holdingBook.aisSale], "the holding's book states it through the trade").toEqual([1000, 1500]);
    expect([
      Math.round(((all.aisPurchase ?? 0) - (allBefore.aisPurchase ?? 0)) * 100) / 100,
      Math.round(((all.aisSale ?? 0) - (allBefore.aisSale ?? 0)) * 100) / 100,
    ], "All accounts gains ONE copy of each side, not two").toEqual([1000, 1500]);
  });
});

// ============================================================================
// F15 — a stored ISIN carrying NON-SPACE whitespace: ONE canonicalIsin on both
//       sides (lib/domain/isin.ts, L1) ↔ queries/trades.ts ↔ the page's map
// ============================================================================

describe("F15 · a holding whose stored ISIN carries a tab and a non-breaking space (canonicalIsin → getOpenUnderlyingPositions → page groups → StrategyCard)", () => {
  type Group = { key: string; symbol: string } & Record<string, unknown>;
  function cardsOf(accountId: number) {
    selectAccount(accountId);
    const el = findElem(strategiesPage(), (e) => e.type === StrategiesClient);
    if (!el) throw new Error("the strategies page no longer renders <StrategiesClient>");
    return (el.props.groups as Group[])
      .filter((g) => g.symbol === "RELIANCE")
      .map((g) => {
        const html = renderToStaticMarkup(React.createElement(StrategyCard, { group: g as never, chart: null }));
        const text = unescape(html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|"));
        const strikes = (g.legs as { kind: string; strike: number }[]).filter((l) => l.kind !== "UL").map((l) => l.strike).sort((a, b) => a - b).join("/");
        return { strikes, strategy: String(g.strategyId ?? ""), unlimited: text.includes("Unlimited") };
      })
      .sort((a, b) => a.strikes.localeCompare(b.strikes));
  }

  it("its OWN account bounds the call its shares cover, and All accounts is the union — a tab and an NBSP are not a different ISIN", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    const isin = bundledIsinBySymbol("RELIANCE")!;
    // An .xlsx cell as the Groww / Angel One / Upstox parsers store it (raw) and
    // commit.ts writes it (unchanged): a tab, an Alt+Enter mid-cell, an NBSP.
    const dirty = `\t${isin.slice(0, 6)}\n ${isin.slice(6).toLowerCase()} `;
    expect([dirty === isin, dirty.trim() === isin.toUpperCase()], "the fixture is not space padding, which F12 already pins").toEqual([false, false]);
    const { canonicalIsin } = await import("@/lib/domain/isin");
    expect(canonicalIsin(dirty), "the ONE rule both sides now ask").toBe(isin);
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({
          accountId: F15_B, broker: "groww", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NFO",
          symbol: "RELIANCE", tradingsymbol: "RELIANCE2800CESEP26", optionType: "CE", strike: 2800, expiry: "2026-09-24", isOpen: true, sellQty: 100, avgSellPrice: 40,
        }),
        tradeRow({
          accountId: F15_B, broker: "groww", symbol: "Reliance Industries Ltd", tradingsymbol: "Reliance Industries Ltd",
          isin: dirty, isOpen: true, buyQty: 100, avgBuyPrice: 2700, buyDate: "2026-09-01",
        }),
        tradeRow({
          accountId: F15_A, broker: "groww", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NFO",
          symbol: "RELIANCE", tradingsymbol: "RELIANCE3000CESEP26", optionType: "CE", strike: 3000, expiry: "2026-09-24", isOpen: true, sellQty: 100, avgSellPrice: 20,
        }),
      ])
      .run();

    // THE assertion (on revert of EITHER half — lib/queries/trades.ts, whose
    // `upper(trim(isin))` strips U+0020 and nothing else, or app/strategies/
    // page.tsx, whose `isin.trim().toUpperCase()` reaches neither end of an
    // Alt+Enter mid-cell): [{strategy:"short-call", unlimited:true}] in the
    // account that HOLDS the shares, while All accounts still bounded it.
    const own = cardsOf(F15_B);
    expect(own, "the holding is found where it is held").toEqual([{ strikes: "2800", strategy: "covered-call", unlimited: false }]);
    const other = cardsOf(F15_A);
    expect(other, "a call with no units of its own stays unbounded").toEqual([{ strikes: "3000", strategy: "short-call", unlimited: true }]);
    expect(cardsOf(0), "All accounts is each account's own card — never more").toEqual([...own, ...other]);
  });
});

// ============================================================================
// F16 — a PARTLY SOLD MTF leg states no own capital (positions.ts, L2) ↔ the
//       /equity column predicate and the KPI total ↔ an UNPRICED MTF row
//       (mtf-drift.ts, L2) ↔ the drift card's count
// ============================================================================

describe("F16 · a partly sold MTF holding written by closePosition, beside one the journal never priced (deriveOpenPositions → statesOwnCapital / ownCapitalTotal → /equity; mtfDrift → unpricedMtfPositions → MtfDriftCard)", () => {
  let positionsLib: typeof import("@/lib/analytics/positions");
  let drift: typeof import("@/lib/risk/mtf-drift");
  let MtfDriftCard: typeof import("@/components/risk/mtf-drift-card").MtfDriftCard;
  beforeAll(async () => {
    positionsLib = await import("@/lib/analytics/positions");
    drift = await import("@/lib/risk/mtf-drift");
    MtfDriftCard = (await import("@/components/risk/mtf-drift-card")).MtfDriftCard;
  }, 60_000);

  it("the row states no own capital, no ROI, and the KPI total leaves it out and says so; the unpriced row is left out of the drift table and named", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    // A funded MTF buy of 100 @200, ₹15,000 of it the broker's.
    const partly = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F16_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "F16-PART", tradingsymbol: "F16-PART",
          buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-01", buyOrderCount: 1, mtfFundedAmount: 15000, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    // A row whose funding the journal NEVER resolved (null, not 0).
    const unpriced = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F16_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "F16-UNPRICED", tradingsymbol: "F16-UNPRICED",
          buyQty: 50, avgBuyPrice: 100, buyValue: 5000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    expect(row(unpriced)!.mtfFundedAmount, "unstated, not 0").toBeNull();

    // THE PRODUCER for the partly sold state: the real editor render and the
    // real server action, selling 40 of the 100 (`isOpen = buyQty !== sellQty`,
    // commit.ts:2392 — never a hand UPDATE).
    const sold = await actions.updateTradeAction(NO_STATE, editorForm(F16_ACC, partly, { sellQty: "40", avgSellPrice: "260", sellDate: "2026-09-05" }));
    expect([sold.ok, sold.message]).toEqual([true, "Trade updated."]);
    const after = row(partly)!;
    expect([after.isOpen, after.buyQty, after.sellQty, after.mtfFundedAmount], "still open, and the stored funding is still the WHOLE buy leg's").toEqual([true, 100, 40, 15000]);

    // CONSUMER 1 — the drift check and its card, wired as app/risk/page.tsx
    // wires them (that file is in another builder's hands this wave, so the
    // contract is asserted here: mtfDrift and unpricedMtfPositions over the
    // SAME rows, the count handed to the card).
    //
    // Read BEFORE /equity: that page runs `accrueMtfInterest`, which fills a
    // null funded amount with the broker default on the first visit — so an
    // unpriced row is only unpriced until someone opens the Equity Tracker.
    selectAccount(F16_ACC);
    const openMtf = tradeQueries.getTrades()
      .filter((x) => x.isOpen && x.segment === "eq_mtf")
      .map((x) => ({ id: x.id, symbol: x.symbol, broker: x.broker, buyValue: x.buyValue, mtfFundedAmount: x.mtfFundedAmount }));
    expect(openMtf.map((x) => x.mtfFundedAmount), "one row priced, one never priced").toEqual([15000, null]);
    const rows = drift.mtfDrift(openMtf, () => ({ pct: 40, source: "stock-list" as const, asOf: "2026-09-01", coverage: null, note: null }));
    const left = drift.unpricedMtfPositions(openMtf);
    // THE assertion (on revert of lib/risk/mtf-drift.ts: `p.mtfFundedAmount ?? 0`
    // states the unpriced row at 100% own margin — storedOwnPct 100, deltaPct
    // −60 — and the card tells the trader the requirement FELL).
    expect(rows.map((r) => r.symbol), "a row the journal never priced has no entry margin to compare").toEqual(["F16-PART"]);
    expect(left.map((r) => r.id)).toEqual([unpriced]);
    const html = renderToStaticMarkup(React.createElement(MtfDriftCard, { drift: rows, unpriced: left.length, bundleAsOf: "2026-09-01", stale: false }));
    const text = unescape(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
    // THE assertion (on revert of components/risk/mtf-drift-card.tsx, which had
    // no `unpriced` prop at all: the count crosses the seam and is not shown).
    expect(text, "the card names what it is not showing").toContain("1 open MTF position is not priced");
    expect(text).not.toContain("F16-UNPRICED");

    // CONSUMER 2 — /equity's own render.
    const el = findElem(equityPage(), (e) => e.type === TrackerClient);
    if (!el) throw new Error("the equity page no longer renders <TrackerClient>");
    const positions = el.props.positions as import("@/lib/analytics/positions").OpenPosition[];
    const p = positions.find((x) => x.id === partly)!;
    // THE assertion (on revert of lib/analytics/positions.ts: ownCapital −3,000
    // — `invested` is the REMAINING 60 × 200 against the whole leg's 15,000 —
    // subtracted from "Own capital in MTF" on the same screen whose own cell
    // printed "—").
    expect([p.isMtf, p.ownCapital, p.roiOnCapitalPct], "a partly sold leg states no own capital and no ROI on it").toEqual([true, null, null]);
    // The per-row cell predicate and the KPI total, the SAME two functions the
    // tracker reads (tracker-client.tsx) — they cannot disagree again.
    expect(positionsLib.statesOwnCapital(p), "the cell refuses it").toBe(false);
    const other = positions.find((x) => x.id === unpriced)!;
    expect([other.isMtf, positionsLib.statesOwnCapital(other), (other.ownCapital ?? 0) > 0], "the row beside it still states one").toEqual([true, true, true]);
    const totals = positionsLib.ownCapitalTotal(positions);
    // THE assertion: the total is the OTHER row's own capital exactly — the
    // partly sold leg is left out, not added as its negative (pre-fix:
    // 1,000 + (60 × 200 − 15,000) = −2,000, with `unstated` 0).
    expect([totals.total, totals.unstated, totals.funded], "the KPI leaves it out and counts it").toEqual([other.ownCapital, 1, other.fundedAmount]);
    expect(positionsLib.ownCapitalNote(totals.unstated)).toBe("own capital not stated for 1 partly sold MTF row");
    expect(Math.round((totals.total + (p.invested - 15000)) * 100) / 100, "the negative it used to subtract is a real one").not.toBe(totals.total);
  });
});

// ============================================================================
// F17 — the LEGGED / STAGED doors (actions.ts pushTradeToIpoAction, I4 ↔ POST
//       /api/ipos, I4+L3) ↔ syncWouldWrite (ipo-link.ts, L3)
// ============================================================================

describe("F17 · an IPO linked to a holding that has become a ladder (pushTradeToIpoAction → tradeLegs → POST /api/ipos: a link, a sync AND a notes-only save)", () => {
  const legged = (name: string) => {
    const id = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F17_ACC, broker: "zerodha", symbol: name, tradingsymbol: name, acquisition: "ipo", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    return id;
  };
  const addLeg = (tradeId: number) =>
    t.db.insert(t.schema.tradeLegs).values({ tradeId, kind: "entry", seq: 1, tradeDate: "2026-02-20", qty: 10, price: 100 }).run();

  it("the notes-only save is SAVED and the ladder is left alone; an exit edit, a new link and the Trades button are all refused, and no remedy names unlinking", async () => {
    selectAccount(F17_ACC);
    const holding = legged("F17-IPO");
    // Linked while the holding is still plain — exactly how the state is
    // reached (lib/queries/staged.ts addLeg has no IPO-link guard).
    const pushed = await actions.pushTradeToIpoAction(NO_STATE, (() => { const fd = new FormData(); fd.set("tradeId", String(holding)); return fd; })());
    expect(pushed.ok, pushed.message).toBe(true);
    addLeg(holding);
    const before = row(holding)!;

    // (a) THE assertion (on revert of app/api/ipos/route.ts to HEAD, whose
    // STAGED guard sat before the sync decision: 409 for a save that writes
    // NOTHING to the holding, and the refusal told the user to unlink — which
    // counts the sale twice, 497.94 → 995.88).
    const e = ipoPage("F17-IPO", F17_ACC);
    const notesOnly = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { notes: "applied through the ASBA block" })));
    const notesBody = (await notesOnly.clone().json()) as { ok: boolean; message: string };
    expect([notesOnly.status, notesBody.ok], notesBody.message).toEqual([200, true]);
    expect(notesBody.message, "and it says what it did NOT do").toContain("booked on its own ladder in Trades and was left as it is");
    expect(notesBody.message, "no remedy that re-creates the double count").not.toContain("Unlink");
    expect(row(holding), "the ladder's parent is untouched").toEqual(before);
    expect(t.db.select().from(t.schema.ipos).all().find((r) => r.name === "F17-IPO")!.notes).toBe("applied through the ASBA block");

    // (b) a save that WOULD rewrite the parent from the allotment is refused,
    // and the sentence names the ladder as the place to record it.
    const e2 = ipoPage("F17-IPO", F17_ACC);
    const exitEdit = await ipoRoute.POST(json("/api/ipos", saveBody(e2, formHtml(e2), { exitPrice: "150", exitDate: "2026-03-02" })));
    const refused = (await exitEdit.json()) as { code?: string; message: string };
    expect([exitEdit.status, refused.code]).toEqual([409, "STAGED"]);
    expect(refused.message).toContain("Record this change on that ladder. Nothing was saved.");
    expect(row(holding), "nothing was saved").toEqual(before);

    // (c) the OTHER door: the Trades button, on a staged holding with no record.
    const staged = legged("F17-STAGED");
    t.db.update(t.schema.trades).set({ staged: true }).where(eq(t.schema.trades.id, staged)).run();
    const fd = new FormData();
    fd.set("tradeId", String(staged));
    const pushRefused = (await actions.pushTradeToIpoAction(NO_STATE, fd)) as { ok: boolean; code?: string; message: string };
    expect([pushRefused.ok, pushRefused.code]).toEqual([false, "STAGED"]);
    expect(t.db.select().from(t.schema.ipos).all().filter((r) => r.name === "F17-STAGED")).toHaveLength(0);

    // (d) and a link this save MAKES is refused the same way (the create door).
    const created = await ipoRoute.POST(json("/api/ipos", { ...saveBody(e2, formHtml(e2)), id: undefined, name: "F17-NEW", tradeId: staged }));
    expect([created.status, ((await created.json()) as { code?: string }).code]).toEqual([409, "STAGED"]);
    expect(t.db.select().from(t.schema.ipos).all().filter((r) => r.name === "F17-NEW")).toHaveLength(0);
  });
});

// ============================================================================
// F18 — whose charges the holding carries, proved by the MARKER (ipo-link.ts
//       IPO_SYNC_CHARGES_NOTE, L3) ↔ /api/ipos ↔ the REAL charge_config,
//       edited through the REAL charge editor ↔ updateManualTrade (commit.ts)
// ============================================================================

describe("F18 · a rate correction between the sync's write and a later exit edit (syncLinkedTrade → import_notes → syncWroteCharges; the trade editor's own save drops it)", () => {
  it("the charges follow the new exit across a charge_config edit; after the user's own editor save they are the user's and are kept", async () => {
    const { IPO_SYNC_CHARGES_NOTE } = await import("@/lib/analytics/ipo-link");
    const settingsRoute = await import("@/app/api/settings/route");
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F18_ACC, broker: "zerodha", symbol: "F18-IPO", tradingsymbol: "F18-IPO", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F18_ACC, name: "F18-IPO", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, allotmentDate: "2019-01-10", tradeId })
      .run();

    // The sync writes the close AND says, on the row, that the charges are its own.
    const first = ipoPage("F18-IPO", F18_ACC);
    expect((await ipoRoute.POST(json("/api/ipos", saveBody(first, formHtml(first), { exitPrice: "150", exitDate: "2026-03-02" })))).status).toBe(200);
    const afterFirst = row(tradeId)!;
    expect(afterFirst.importNotes ?? "", "the provenance the next edit will ask about").toContain(IPO_SYNC_CHARGES_NOTE);
    expect(afterFirst.chargesTotal).toBeGreaterThan(0);

    // THE RATE CARD MOVES — through the real charge editor's own route, into
    // the real charge_config (invariant 3: the only rate source).
    const rate = t.db
      .select()
      .from(t.schema.chargeConfig)
      .all()
      .find((r) => r.broker === "zerodha" && r.segment === "eq_delivery" && r.exchange === "NSE")!;
    const saved = await settingsRoute.POST(json("/api/settings", {
      type: "charge", id: rate.id, brokerageFlat: rate.brokerageFlat, brokeragePct: 0.25, brokerageCap: rate.brokerageCap, brokerageFloor: rate.brokerageFloor,
      sttPct: rate.sttPct, exchangeTxnPct: rate.exchangeTxnPct, sebiPct: rate.sebiPct, stampPct: rate.stampPct, ipftPct: rate.ipftPct, gstPct: rate.gstPct,
      dpCharge: rate.dpCharge, mtfInterestAnnual: rate.mtfInterestAnnual,
    }));
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);

    // The exit is re-priced. THE assertion (on revert of app/api/ipos/route.ts
    // to HEAD, whose `syncWroteCharges` re-priced the STORED exit against the
    // LIVE rate card: the correction above made that comparison fail, ownership
    // was lost for good, and the ₹5,000 sale kept the ₹1,500 sale's bill while
    // price, gross and net moved with the new exit).
    const second = ipoPage("F18-IPO", F18_ACC);
    expect((await ipoRoute.POST(json("/api/ipos", saveBody(second, formHtml(second), { exitPrice: "500", exitDate: "2026-03-02" })))).status).toBe(200);
    const reprice = row(tradeId)!;
    const shown = ipoPage("F18-IPO", F18_ACC);
    expect([reprice.avgSellPrice, reprice.grossPnl], "the new exit").toEqual([500, 4000]);
    expect(reprice.chargesTotal, "priced at the rates now in charge_config, not frozen at the old bill").not.toBe(afterFirst.chargesTotal);
    expect([reprice.chargesTotal, reprice.netPnl], "/ipos and the Trades row state ONE figure").toEqual([shown.charges, shown.netPnl]);
    expect(reprice.brokerage, "the corrected rate is the one that was billed").toBe(Math.round(0.25 * 50 * 100) / 100 > (rate.brokerageCap ?? Infinity) ? rate.brokerageCap! : reprice.brokerage);

    // THE USER TAKES THE CHARGES OVER — a save of their own through the real
    // editor that moves a charge head (the buy leg re-prices stamp duty and
    // brokerage; the SALE is untouched, so the sync still owns the close).
    const edited = await actions.updateTradeAction(NO_STATE, editorForm(F18_ACC, tradeId, { avgBuyPrice: "101", buyQty: "10" }));
    expect([edited.ok, edited.message]).toEqual([true, "Trade updated."]);
    const userRow = row(tradeId)!;
    // THE assertion (on revert of lib/import/commit.ts: the marker survives the
    // user's save, so the next exit edit rewrites the figures they just set).
    expect(userRow.importNotes ?? "", "whoever changes the charges owns them").not.toContain(IPO_SYNC_CHARGES_NOTE);

    const third = ipoPage("F18-IPO", F18_ACC);
    expect((await ipoRoute.POST(json("/api/ipos", saveBody(third, formHtml(third), { exitPrice: "520", exitDate: "2026-03-02" })))).status).toBe(200);
    const kept = row(tradeId)!;
    expect(kept.avgSellPrice, "the exit still moves").toBe(520);
    expect([kept.chargesTotal, kept.brokerage, kept.sttCtt], "a figure the user states is never rewritten (owner ruling F1)").toEqual([
      userRow.chargesTotal, userRow.brokerage, userRow.sttCtt,
    ]);
  });
});

// ============================================================================
// F19 — clearing an IPO's exit ↔ whose close the holding carries
//       (reopensAForeignClose, L3) ↔ the eight heads the IPO prices
// ============================================================================

describe("F19 · the exit cleared on /ipos for a sale recorded in Trades, and for one the sync itself wrote (POST /api/ipos → linkPatch → syncLinkedTrade)", () => {
  it("a close the user recorded is refused 409 with its charges intact; a close the sync wrote re-opens and its priced heads go", async () => {
    const { IPO_SYNC_CHARGES_NOTE } = await import("@/lib/analytics/ipo-link");
    // (a) the user's own sale, charges from their contract note.
    const userTrade = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F19_ACC, broker: "zerodha", symbol: "F19-USER", tradingsymbol: "F19-USER", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10",
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500, brokerage: 20, dpCharges: 13.5, chargesTotal: 33.5, netPnl: 466.5, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F19_ACC, name: "F19-USER", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2019-01-10", tradeId: userTrade })
      .run();
    const userBefore = row(userTrade)!;
    const u = ipoPage("F19-USER", F19_ACC);
    const res = await ipoRoute.POST(json("/api/ipos", { ...saveBody(u, formHtml(u)), exitPrice: "", exitDate: "" }));
    const body = (await res.json()) as { code?: string; message: string };
    // THE assertion (on revert of app/api/ipos/route.ts to HEAD, which had no
    // such guard: 200, the holding re-opened and the contract note's ₹20 of
    // brokerage and ₹13.50 of DP charge deleted — the very heads the same route
    // refuses to REWRITE on a re-price).
    expect([res.status, body.code], body.message).toEqual([409, "CLOSE_IN_TRADES"]);
    expect(body.message).toContain("Re-open or change that sale in Trades, where it is recorded.");
    expect(row(userTrade), "nothing was saved").toEqual(userBefore);
    expect(t.db.select().from(t.schema.ipos).all().find((r) => r.name === "F19-USER")!.exitPrice, "and the IPO keeps its exit").toBe(150);

    // (b) a close the SYNC wrote: clearing it is what the sync is for.
    const syncTrade = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F19_ACC, broker: "zerodha", symbol: "F19-SYNC", tradingsymbol: "F19-SYNC", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F19_ACC, name: "F19-SYNC", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: syncTrade })
      .run();
    const s1 = ipoPage("F19-SYNC", F19_ACC);
    expect((await ipoRoute.POST(json("/api/ipos", saveBody(s1, formHtml(s1), { exitPrice: "150", exitDate: "2026-03-02" })))).status).toBe(200);
    const closed = row(syncTrade)!;
    expect([closed.isOpen, (closed.importNotes ?? "").includes(IPO_SYNC_CHARGES_NOTE)]).toEqual([false, true]);
    // Money the IPO never prices, recorded on the row by hand.
    t.db.update(t.schema.trades).set({ mtfInterest: 7, pledgeCharges: 2, chargesTotal: Math.round((closed.chargesTotal + 9) * 100) / 100 }).where(eq(t.schema.trades.id, syncTrade)).run();

    const s2 = ipoPage("F19-SYNC", F19_ACC);
    const cleared = await ipoRoute.POST(json("/api/ipos", { ...saveBody(s2, formHtml(s2)), exitPrice: "", exitDate: "" }));
    expect(cleared.status, JSON.stringify(await cleared.clone().json())).toBe(200);
    const reopened = row(syncTrade)!;
    expect([reopened.isOpen, reopened.sellQty, reopened.brokerage, reopened.sttCtt, reopened.dpCharges], "the eight heads the sync priced go with the exit").toEqual([true, 0, 0, 0, 0]);
    expect([reopened.mtfInterest, reopened.pledgeCharges, reopened.chargesTotal], "the two it never writes are kept, and are the total").toEqual([7, 2, 9]);
    expect((reopened.importNotes ?? "").includes(IPO_SYNC_CHARGES_NOTE), "the claim goes with the charges").toBe(false);
  });
});

// ============================================================================
// F20 — an exit date that is not a real calendar day (commit.ts normalizeDate /
//       closePosition, L3) ↔ the close route ↔ the dialog's resolveExitIso
// ============================================================================

describe("F20 · '99-99-9999' and '31-02-2026' typed into the close dialog (resolveExitIso ↔ POST /api/positions/close → closePosition)", () => {
  let closeRoute: typeof import("@/app/api/positions/close/route");
  beforeAll(async () => {
    closeRoute = await import("@/app/api/positions/close/route");
    closeDialog = (await import("@/components/trades/close-trade-dialog")) as typeof closeDialog;
  }, 60_000);

  it("the save ANSWERS rather than throwing, the row is untouched, and the dialog previews nothing for a date the save would refuse", async () => {
    const mtf = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F20_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "F20-MTF", tradingsymbol: "F20-MTF",
          buyQty: 100, avgBuyPrice: 160, buyValue: 16000, buyDate: "2026-08-01", buyOrderCount: 1, mtfFundedAmount: 12000, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const before = row(mtf)!;

    // THE assertion (on revert of lib/import/commit.ts: '99-99-9999' became
    // '9999-99-99', an Invalid Date, so the MTF day count went NaN and the
    // UPDATE threw `NOT NULL constraint failed: trades.charges_total_paise` —
    // the action 500d instead of answering).
    const res = await closeRoute.POST(json("/api/positions/close", { tradeId: mtf, exitPrice: 200, exitDate: "99-99-9999" }));
    const body = (await res.json()) as { ok: boolean; code?: string; message: string };
    expect([res.status, body.ok, body.code], body.message).toEqual([200, false, "BAD_DATE"]);
    expect(body.message).toContain("is not a real calendar day");
    expect(row(mtf), "nothing was written").toEqual(before);

    // The impossible day that was SILENTLY STORED before: 31 February.
    const fd = new FormData();
    fd.set("tradeId", String(mtf));
    fd.set("exitPrice", "200");
    fd.set("exitDate", "31-02-2026");
    const action = await actions.closeTradeAction(NO_STATE, fd);
    expect([action.ok, action.message.includes("is not a real calendar day")], action.message).toEqual([false, true]);
    expect(row(mtf)!.sellDate, "'2026-02-31' is not a day this journal stores").toBeNull();

    // The DIALOG's half of the same rule: it previews nothing for a date the
    // save refuses, and a blank field is still today (unanswered, not unreadable).
    expect([closeDialog.resolveExitIso("31-02-2026"), closeDialog.resolveExitIso("99-99-9999")], "the two halves agree").toEqual([null, null]);
    expect(closeDialog.resolveExitIso(""), "a blank field is today, as it always was").toBe(todayIstIso());
    expect(closeDialog.resolveExitIso("28-02-2026")).toBe("2026-02-28");

    // And a real day still closes the position, through the same route.
    const ok = await closeRoute.POST(json("/api/positions/close", { tradeId: mtf, exitPrice: 200, exitDate: "28-02-2026" }));
    expect([ok.status, ((await ok.json()) as { ok: boolean }).ok]).toEqual([200, true]);
    expect([row(mtf)!.isOpen, row(mtf)!.sellDate]).toEqual([false, "2026-02-28"]);
  });
});

// ============================================================================
// F21 — an OLDER cross-FILE row met before today's snapshot (cross-source.ts,
//       L4) ↔ the pull route's 409 ↔ the broker-connect dialog's copy
// ============================================================================

describe("F21 · one incoming pull row that matches BOTH an older import and today's own snapshot row (planSnapshot → detectCrossSourceDuplicates → route 409 → collisionDialogCopy)", () => {
  const clientOf = (accountId: number) => `40000${accountId}`;
  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  const addDhan = (accountId: number) =>
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
      .run(accountId, clientOf(accountId), alive());
  const position = (accountId: number, symbol: string, productType: string, exchangeSegment: string, buyQty: number, buyAvg: number) => ({
    dhanClientId: clientOf(accountId), tradingSymbol: symbol, positionType: "LONG", exchangeSegment, productType, buyAvg, buyQty, sellAvg: 0, sellQty: 0, netQty: buyQty,
  });
  const stub = (positions: unknown[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      const body = u.host === "auth.dhan.co" ? { accessToken: alive() } : u.pathname === "/v2/positions" ? positions : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  const pull = async (accountId: number) => {
    const res = await brokerRoute.POST(json("/api/import/broker", { action: "pull", broker: "dhan", accountId, mode: "commit" }));
    return { status: res.status, body: (await res.json()) as { needsForce?: boolean; message: string; collisions?: { symbol: string; kind: string; sameSnapshot?: boolean }[] } };
  };

  it("the ask reports TODAY'S SNAPSHOT, not the older import met first — so one round of the remedy ends it", async () => {
    freezeAt("2026-09-08T06:30:00.000Z"); // 12:00 IST
    addDhan(F21_ACC);
    // An OLDER import of the same scrip, on the SAME quantity this pull states:
    // a cross-FILE candidate that is "risky" and sits at a LOWER rowid than
    // anything today's pull will write, so it is met FIRST.
    const older = commitFill(F21_ACC, "SEAML4", "BUY", 15, 100, "2026-09-01");
    // Today's earlier pull: the same instrument, on another product.
    stub([position(F21_ACC, "SEAML4", "INTRADAY", "NSE_EQ", 10, 100)]);
    expect((await pull(F21_ACC)).status, "the older row is no ask on its own").toBe(200);
    const snapshotRow = rowsOf(F21_ACC).find((r) => r.segment === "eq_intraday")!;
    expect(snapshotRow.id, "the snapshot row is the LATER one, met second").toBeGreaterThan(older.id);

    freezeAt("2026-09-08T10:30:00.000Z"); // 16:00 IST, the same IST day
    stub([position(F21_ACC, "SEAML4", "MTF", "NSE_EQ", 15, 100.5)]);
    const blocked = await pull(F21_ACC);
    expect([blocked.status, blocked.body.needsForce]).toEqual([409, true]);
    const shown = bc.collisionDialogCopy({ collisions: blocked.body.collisions ?? [], message: blocked.body.message });
    const msg = shown.serverMessage ?? "";

    // THE assertion (on revert of lib/import/cross-source.ts, which broke on the
    // FIRST risky candidate in rowid order: the ask read "1 row in this file
    // (SEAML4) look like trades already recorded from a different file … Delete
    // the earlier import first", so the user deleted an import that was not the
    // blocker and met today's snapshot sentence on the next pull).
    expect(msg, "today's snapshot IS the blocker, so it is what is reported").toContain(
      "restates an instrument today's earlier pull already recorded under another product, segment or exchange",
    );
    expect(msg, "and the older import is not what the user is sent to delete").not.toContain("look like trades already recorded from a different file");
    expect(msg).toContain("the earlier row can be deleted from Trades and the pull run again");
    expect(blocked.body.collisions?.map((c) => [c.symbol, c.sameSnapshot ?? false]), "one report per incoming row — the snapshot one").toEqual([["SEAML4", true]]);
    expect(row(older.id), "and nothing was written").toEqual(older);
  });
});

// ============================================================================
// F22 — a pre-4.3.0 Trash envelope with NO `ipoRefs` (trash.ts, L6) ↔ the ONE
//       pairing (data-quality.ts uniqueIpoRelinks / ipoOrphanPairs, L6) ↔ the
//       counted-once consumers ↔ the Data Quality report (queries, L6)
// ============================================================================

describe("F22 · a holding deleted the 4.2.x way and restored on 4.3.0 (writeTrashSnapshot without ipoRefs → restoreTrashSnapshot → uniqueIpoRelinks → capital / tax / AIS, and getDataQualityReport)", () => {
  let capital: typeof import("@/lib/queries/capital");
  let taxItr: typeof import("@/lib/queries/tax-itr");
  let aisRoute: typeof import("@/app/api/ais/route");
  beforeAll(async () => {
    capital = await import("@/lib/queries/capital");
    taxItr = await import("@/lib/queries/tax-itr");
    aisRoute = await import("@/app/api/ais/route");
  }, 60_000);

  async function countedOnce(accountId: number) {
    selectAccount(accountId);
    const cap = capital.getCapitalSummary();
    const base = taxItr.getTaxBase();
    const res = await aisRoute.POST(json("/api/ais", { text: "nothing to parse" }));
    const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
    return {
      capital: [cap.equityRealised, cap.ipoRealised, cap.totalRealised],
      tax: [base.exitedIpos.map((r) => r.name), base.cgTrades.map((c) => c.netPnl)],
      ais: recon.fyTotals.map((f) => `${f.fy}|${f.kind}|${f.journal}`),
    };
  }

  /** A sold IPO allotment and the record it came from, linked, in one book. */
  function allotmentAndRecord(accountId: number, name: string, qty = 10) {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId, broker: "zerodha", symbol: name, tradingsymbol: name, acquisition: "ipo",
          buyQty: qty, avgBuyPrice: 100, buyValue: qty * 100, buyDate: "2026-02-20", buyOrderCount: 1,
          sellQty: qty, avgSellPrice: 150, sellValue: qty * 150, sellDate: "2026-03-02", sellOrderCount: 1,
          grossPnl: qty * 50, chargesTotal: 2.06, netPnl: qty * 50 - 2.06, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId, name, appliedPrice: 100, lotSize: qty, lotsApplied: 1, allotted: true, allottedQty: qty, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20", tradeId })
      .run();
    return tradeId;
  }
  const ipoRowsNamed = (name: string) => t.db.select().from(t.schema.ipos).all().filter((r) => r.name === name);

  it("(a) the link is recovered from the book's own records, and the sale is counted once again", async () => {
    const tradeId = allotmentAndRecord(F22_ACC, "F22-IPO");
    const before = await countedOnce(F22_ACC);
    expect(before.capital[1], "the baseline is counted-once, not merely stable").toBe(0);

    // A 4.2.x delete: the envelope carries the row and NOTHING about the link
    // (`ipoRefs` did not exist), the link is nulled, the row goes.
    const stored = row(tradeId)! as unknown as Record<string, unknown>;
    const snapshotId = trash.writeTrashSnapshot({
      trades: [stored], legs: [], attachments: [], reason: "F22: deleted by 4.2.x", accountId: F22_ACC,
    });
    expect(JSON.parse(JSON.stringify(trash.listTrashSnapshots().find((s) => s.id === snapshotId) ?? {})), "the snapshot exists").toBeTruthy();
    t.db.update(t.schema.ipos).set({ tradeId: null }).where(eq(t.schema.ipos.id, ipoRowsNamed("F22-IPO")[0]!.id)).run();
    t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, tradeId)).run();

    const restored = trash.restoreTrashSnapshot(snapshotId);
    expect([restored.ok, restored.restored], restored.message).toEqual([true, 1]);
    // THE assertion (on revert of lib/trash.ts: the holding comes back UNLINKED
    // and the one sale is counted twice — in capital, the tax pack, the ITR
    // export and both AIS sides, with nothing on screen saying so).
    expect(ipoRowsNamed("F22-IPO")[0]!.tradeId, "re-linked by the holding's own record").toBe(tradeId);
    expect(await countedOnce(F22_ACC), "and counted exactly once again").toEqual(before);
  });

  it("(b) two records could be the same allotment: the restore writes NOTHING and Data Quality names both", async () => {
    const tradeId = allotmentAndRecord(F22_TWO, "F22-TWIN");
    // A SECOND exited record of the same scrip and quantity, unlinked.
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F22_TWO, name: "F22-TWIN", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20" })
      .run();

    const stored = row(tradeId)! as unknown as Record<string, unknown>;
    const snapshotId = trash.writeTrashSnapshot({ trades: [stored], legs: [], attachments: [], reason: "F22: the ambiguous one", accountId: F22_TWO });
    t.db.update(t.schema.ipos).set({ tradeId: null }).where(eq(t.schema.ipos.id, ipoRowsNamed("F22-TWIN").find((r) => r.tradeId === tradeId)!.id)).run();
    t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, tradeId)).run();
    const restored = trash.restoreTrashSnapshot(snapshotId);
    expect([restored.ok, restored.restored], restored.message).toEqual([true, 1]);

    // THE assertion: "whichever the loop met first" is not an answer (invariant 6).
    expect(ipoRowsNamed("F22-TWIN").map((r) => r.tradeId), "neither record is guessed onto the holding").toEqual([null, null]);
    // …and the question is ASKED, through the real report reader.
    selectAccount(F22_TWO);
    const issues = dqQueries.getDataQualityReport().issues;
    const orphan = issues.find((i) => i.code === `ipo_record_link:${tradeId}`);
    // THE assertion (on revert of lib/queries/data-quality.ts, which passed no
    // `unlinkedIpoRecords`: the pair is unlinked, counted twice, and silent).
    expect(orphan?.title, "the pair is named, not guessed").toBe("IPO record not linked to its holding");
    const named = ipoRowsNamed("F22-TWIN").map((r) => `#${r.id} F22-TWIN`);
    expect(orphan?.detail).toContain(`2 exited IPO records`);
    for (const n of named) expect(orphan?.detail).toContain(n);
    expect(orphan?.detail).toContain("counted once in IPOs and again as the holding's own sale");
    expect([orphan?.href, orphan?.ids]).toEqual(["/ipos", [tradeId]]);
  });
});

// ============================================================================
// F23 — the FORWARD alias direction of the merge refusal (account-delete.ts
//       identityCollisions, L7) ↔ previewAccountDelete's warning (same fact)
// ============================================================================

describe("F23 · a source CLOSED ROUND TRIP whose hash the target's lot holds as an alias (close-stale join → heldIdentityHashes → identityClash → preview ≡ refusal)", () => {
  const SYM = "SEAML7";
  it("the merge REFUSES rather than dropping the row and losing its purchase leg, and the preview warned in the refusal's own words", async () => {
    for (const acc of [F23_TGT]) {
      commitFill(acc, SYM, "BUY", 100, 200, "2026-08-20");
      commitFill(acc, SYM, "SELL", 100, 250, "2026-08-25");
    }
    const [lotT, saleT] = rowsOf(F23_TGT);
    selectAccount(F23_TGT);
    expect((await closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId: lotT.id, saleId: saleT.id, exitDate: "2026-08-25" }))).status).toBe(200);
    expect(rowsOf(F23_TGT).map((r) => r.id), "the target holds one lot, carrying the sale's hash as an alias").toEqual([lotT.id]);

    // The source's row is that same identity — but it is the WHOLE round trip,
    // so it carries a purchase leg held on no other row.
    const src = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F23_SRC, broker: "dhan", segment: "eq_delivery", symbol: SYM, tradingsymbol: SYM, dedupHash: saleT.dedupHash,
          buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-20", sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-25",
          grossPnl: 5000, chargesTotal: 20, netPnl: 4980, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const srcBefore = row(src)!;
    const tgtBefore = row(lotT.id)!;

    const preview = accountDelete.previewAccountDelete({ accountId: F23_SRC, mode: "merge", targetId: F23_TGT });
    const res = accountDelete.deleteAccount({ accountId: F23_SRC, mode: "merge", targetId: F23_TGT, connections: "delete" });
    // THE assertion (on revert of lib/queries/account-delete.ts: ok true with
    // "1 duplicate skipped" — the source round trip DELETED whole, its purchase
    // leg and its ₹4,980 of realised P&L gone from the merged journal).
    expect(res.ok, res.message).toBe(false);
    const tail = ". Nothing was merged; both accounts are unchanged.";
    expect(res.message.endsWith(tail), res.message).toBe(true);
    const fact = res.message.slice(0, -tail.length);
    expect(fact, "the fact names both rows and the leg that would be counted twice").toBe(
      `Trade #${src} (${SYM}) records a sale that “fixF ${F23_TGT}” already holds (trade #${lotT.id}, ${SYM}, which was closed with it) — moving it would count that sale twice`,
    );
    // The preview said the SAME thing, before the user pressed anything (one
    // helper, two readers — they cannot drift).
    expect((preview.ok ? preview.warnings : undefined) ?? [], "the preview is the refusal, in advance").toContain(
      `${fact}, and skipping it would drop the other leg it records. The merge will not run until those two rows are resolved.`,
    );
    expect([row(src), row(lotT.id)], "both accounts are unchanged").toEqual([srcBefore, tgtBefore]);
  });

  it("(b) the REVERSE direction — a source LOT whose held alias names a row the target stores — refuses in the other half of the same sentence, and the preview says it first", async () => {
    const SYM2 = "SEAML7R";
    commitFill(F23R_SRC, SYM2, "BUY", 50, 300, "2026-08-20");
    commitFill(F23R_SRC, SYM2, "SELL", 50, 320, "2026-08-25");
    const [lotS, saleS] = rowsOf(F23R_SRC);
    selectAccount(F23R_SRC);
    expect((await closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId: lotS.id, saleId: saleS.id, exitDate: "2026-08-25" }))).status).toBe(200);
    expect(rowsOf(F23R_SRC).map((r) => r.id), "the SOURCE holds the alias now").toEqual([lotS.id]);
    // The target stores the very row that alias names.
    const tgt = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F23R_TGT, broker: "dhan", segment: "eq_delivery", symbol: SYM2, tradingsymbol: SYM2, dedupHash: saleS.dedupHash,
          sellQty: 50, avgSellPrice: 320, sellValue: 16000, sellDate: "2026-08-25", isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const before = [row(lotS.id), row(tgt)];

    const preview = accountDelete.previewAccountDelete({ accountId: F23R_SRC, mode: "merge", targetId: F23R_TGT });
    const res = accountDelete.deleteAccount({ accountId: F23R_SRC, mode: "merge", targetId: F23R_TGT, connections: "delete" });
    expect(res.ok, res.message).toBe(false);
    const tail = ". Nothing was merged; both accounts are unchanged.";
    const fact = res.message.slice(0, -tail.length);
    expect(fact, "the OTHER half of identityClash: the source row was closed with it").toBe(
      `Trade #${lotS.id} (${SYM2}) was closed with a sale that “fixF ${F23R_TGT}” already holds (trade #${tgt}, ${SYM2}) — moving it would count that sale twice`,
    );
    expect((preview.ok ? preview.warnings : undefined) ?? [], "one helper, two readers").toContain(
      `${fact}, and skipping it would drop the other leg it records. The merge will not run until those two rows are resolved.`,
    );
    expect([row(lotS.id), row(tgt)], "both accounts are unchanged").toEqual(before);
  });
});

// ============================================================================
// F24 — ONE trade takes ONE IPO record (planIpoLinks, L7) ↔ J2's MERGE-side
//       `ipoRefs` ↔ trash.ts' re-link loop ↔ the counted-once consumers
// ============================================================================

describe("F24 · a merge whose surviving copy ALREADY carries an IPO, with a second record in a THIRD book (previewAccountDelete ≡ deleteAccount → ipoRefs → restoreTrashSnapshot → capital)", () => {
  let capital: typeof import("@/lib/queries/capital");
  beforeAll(async () => {
    capital = await import("@/lib/queries/capital");
  }, 60_000);

  const sold = (accountId: number, name: string) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId, broker: "zerodha", symbol: name, tradingsymbol: name, dedupHash: "f24-shared-identity", acquisition: "ipo",
          buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1,
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", sellOrderCount: 1,
          grossPnl: 500, chargesTotal: 2.06, netPnl: 497.94, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
  const record = (accountId: number, name: string, tradeId: number | null) =>
    t.db
      .insert(t.schema.ipos)
      .values({ accountId, name, appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2019-01-10", tradeId })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;
  const ipoRow = (id: number) => t.db.select().from(t.schema.ipos).all().find((r) => r.id === id)!;
  const ipoRealisedAll = () => {
    selectAccount(0);
    return capital.getCapitalSummary().ipoRealised;
  };

  it("exactly one ipos row names the surviving copy; the skipped records ride back — this book's inside the snapshot, the other book's through ipoRefs", () => {
    const targetTrade = sold(F24_TGT, "F24-IPO");
    const sourceTrade = sold(F24_SRC, "F24-IPO");
    const tgtRecord = record(F24_TGT, "F24-IPO", targetTrade); // the survivor's own
    const srcRecord = record(F24_SRC, "F24-IPO", sourceTrade); // travels with the trade
    const otherRecord = record(F24_OTHER, "F24-XBOOK", sourceTrade); // a THIRD book's
    const allBefore = ipoRealisedAll();

    const preview = accountDelete.previewAccountDelete({ accountId: F24_SRC, mode: "merge", targetId: F24_TGT });
    const warnings = (preview.ok ? preview.warnings : undefined) ?? [];
    expect(warnings.some((w) => w.includes("1 dropped trade carries 2 IPO records")), JSON.stringify(preview)).toBe(true);
    expect(warnings.find((w) => w.includes("IPO record")), "the preview states the same split the execution takes").toContain(
      "2 will be skipped, because one trade takes one IPO record",
    );

    const res = accountDelete.deleteAccount({ accountId: F24_SRC, mode: "merge", targetId: F24_TGT, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    expect(res.message).toContain("2 duplicate IPO records skipped");
    // THE assertion (on revert of lib/queries/account-delete.ts to HEAD, whose
    // re-point had no such check: BOTH records land on the surviving copy — two
    // `ipos` rows naming one trade, the state pushTradeToIpoAction refuses to
    // create, with getIpoTradeLinks() keeping only the last).
    expect(t.db.select().from(t.schema.ipos).all().filter((r) => r.tradeId === targetTrade).map((r) => r.id), "one trade, one record").toEqual([tgtRecord]);
    expect(t.db.select().from(t.schema.ipos).all().some((r) => r.id === srcRecord), "this book's own copy goes to Deleted items with its trade").toBe(false);
    expect([ipoRow(otherRecord).accountId, ipoRow(otherRecord).tradeId], "the other book's record stays where it is, unlinked").toEqual([F24_OTHER, null]);
    const afterMerge = ipoRealisedAll();
    expect(afterMerge, "…and while unlinked it states its own sale beside the target's copy").toBeGreaterThan(allBefore);

    // THE assertion for J2's MERGE-side `ipoRefs` (the boundary F9 (b) could not
    // reach, since a purge's own rows ride back with `trade_id` intact): the
    // envelope names the OTHER book's row, so the restore re-links it.
    const restored = trash.restoreTrashSnapshot(res.snapshotId!);
    expect(restored.ok, restored.message).toBe(true);
    expect(ipoRow(otherRecord).tradeId, "the other book's link comes back from ipoRefs").toBe(sourceTrade);
    expect(ipoRow(srcRecord).tradeId, "and this book's record rides back inside the snapshot, still linked").toBe(sourceTrade);
    expect(ipoRealisedAll(), "the restored book counts its sale once again").toBe(allBefore);
  });
});

// ============================================================================
// F25 — J1's backward-compatible Clear: a body with NO `fact`
//       (route → clearUnfetchedLine, I5/J1)
// ============================================================================

describe("F25 · a Clear posted by an older client, naming no sentence (GET → two carried lines → POST without `fact` → the span's FIRST record)", () => {
  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  const rangeCapAt = (stamp: string) =>
    dhanApi.toParsedFile([], dhanApi.catchUpRange(stamp, "2026-09-11"), { pages: 1, truncated: false, oldest: null, newest: null }, stamp).unfetched;
  const hhmm = (s: { fact: string }) => /after (\d\d:\d\d) IST/.exec(s.fact)?.[1] ?? s.fact;
  type CardRow = { broker: string; accountId: number; unfetched?: import("@/components/import/broker-connect").UnfetchedSpan[]; unfetchedConnection?: (number | null)[] };
  async function cardRow(accountId: number): Promise<CardRow> {
    const body = (await (await brokerRoute.GET()).json()) as { connections?: CardRow[] };
    const r = (body.connections ?? []).find((c) => c.broker === "dhan" && c.accountId === accountId);
    if (!r) throw new Error(`GET lists no Dhan connection for account ${accountId}`);
    return r;
  }

  it("the span's FIRST record of that connection is taken, as before — a stored notice from an older build still clears", async () => {
    selectAccount(0);
    unfetched.keepUnfetched(rangeCapAt("2026-05-13T09:00:00.000Z"), { connId: 95, accountId: F25_SA, source: "import" }); // 14:30 IST
    unfetched.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: 96, accountId: F25_SB, source: "import" }); // 10:30 IST
    for (const [from, name] of [[F25_SA, "book A"], [F25_SB, "book B"]] as const) {
      expect(
        t.db.transaction((tx) => unfetched.carryUnfetchedOnMerge(tx, { fromAccountId: from, toAccountId: F25_TGT, fromName: name, toName: "fixF J1 target", source: "ui" })),
      ).toBe(1);
    }
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
      .run(F25_TGT, "1000000078", alive());

    const card = await cardRow(F25_TGT);
    const lines = bc.unfetchedLines(card);
    expect(lines.map((s) => [s.connection, hhmm(s)]), "two carried records on the IDENTICAL span").toEqual([[null, "14:30"], [null, "10:30"]]);

    // The card's own body for the SECOND line, with the sentence removed — the
    // shape any older client or other caller posts (the route passes it on
    // unchanged, so `clearUnfetchedLine` takes onSpan[0]).
    const named = JSON.parse(JSON.stringify(bc.clearUnfetchedBody(card, lines[1]!))) as Record<string, unknown>;
    delete named.fact;
    delete named.remedy;
    const res = await brokerRoute.POST(json("/api/import/broker", named));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    // The compatibility branch, stated: the FIRST record of the span goes,
    // whichever line the body was built from. (Not red on a revert of either
    // half — it pins the behaviour a revert RESTORES; the named path is F7.)
    expect(unfetched.outstandingUnfetchedRecords(F25_TGT).map((r) => [r.connection, hhmm(r)]), "the span's first record, as before").toEqual([[null, "10:30"]]);
  });
});

// ============================================================================
// F26 — ONE gross arithmetic at 3+ decimals (computeIpo, I4) ↔ the trade row
//       the sync writes (tradePatchFromIpo) ↔ capital / the tax pack
// ============================================================================

describe("F26 · an exit of 150.005 over an issue price of 99.995 on 3 shares (POST /api/ipos → syncLinkedTrade → the Trades row ≡ /ipos)", () => {
  it("both sides state 150.02 — the per-share form's 150.01 never reaches either", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F26_ACC, broker: "zerodha", symbol: "F26-IPO", tradingsymbol: "F26-IPO", buyQty: 3, avgBuyPrice: 100, buyValue: 300, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F26_ACC, name: "F26-IPO", appliedPrice: 99.995, lotSize: 3, lotsApplied: 1, allotted: true, allottedQty: 3, listingPrice: 130, allotmentDate: "2019-01-10", tradeId })
      .run();

    const e = ipoPage("F26-IPO", F26_ACC);
    const saved = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { exitPrice: "150.005", exitDate: "2026-03-02" })));
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(200);
    const stored = row(tradeId)!;
    const shown = ipoPage("F26-IPO", F26_ACC);
    // The VALUE-based form on both sides: r2(r2(150.005 × 3)) − 300 = 150.02.
    // A per-share form over the same fixture answers differently (r2((150.005 −
    // 99.995) × 3) = 150.03), which is the whole point of the rule — at whole
    // rupees the two agree and nothing is being tested. A STANDING PIN: I4's
    // fix is at HEAD, so no revert of this wave reddens it; what was missing is
    // the case ACROSS the seam (the unit file pins the halves separately).
    expect([stored.sellQty, stored.avgSellPrice, stored.sellValue, stored.buyValue], "the sale the sync wrote").toEqual([3, 150.005, 450.02, 300]);
    expect([shown.grossPnl, stored.grossPnl], "/ipos and the Trades row state ONE gross").toEqual([150.02, 150.02]);
    expect(Math.round((150.005 - 99.995) * 3 * 100) / 100, "the per-share arithmetic they both refuse").toBe(150.03);
    expect(shown.netPnl, "and one net").toBe(Math.round((stored.grossPnl - stored.chargesTotal) * 100) / 100);
  });
});

// ============================================================================
// WAVE 2M — B-IPO (the IPO pairing, G-G2-1) ↔ B-DATE (the one calendar,
//           G-G3-1 / G-G3-2). F27..F33.
//
// Each 2M describe loads the modules it reads itself, so a single case can be
// run under `-t` on its own during a red-on-revert probe.
async function wave2mModules() {
  trash = await import("@/lib/trash");
  dqQueries = await import("@/lib/queries/data-quality");
  ipoRoute = await import("@/app/api/ipos/route");
  actions = await import("@/app/trades/actions");
  tradeQueries = await import("@/lib/queries/trades");
  slim = await import("@/lib/domain/slim-trade");
  dq = await import("@/lib/analytics/data-quality");
}

// The two builders never ran together: B-IPO's tier B compares `allotmentDate`,
// `exitDate`, `acquisitionDate ?? buyDate` and `sellDate` AS ISO DAY STRINGS,
// and B-DATE is the wave that decided what those columns hold. Every case below
// builds the value where its producer builds it and asserts the consumer's
// OUTPUT — the link a restore writes, the sentence the report states, the money
// a save stores.
// ============================================================================

describe("F27 · an ISSUE-named IPO record and its holding, deleted the 4.2.x way (the ENVELOPE's dates ↔ the LIVE query's columns → ipoRecordMatchesHolding)", () => {
  let capital2: typeof import("@/lib/queries/capital");
  let taxItr2: typeof import("@/lib/queries/tax-itr");
  let ais2: typeof import("@/app/api/ais/route");
  beforeAll(async () => {
    capital2 = await import("@/lib/queries/capital");
    taxItr2 = await import("@/lib/queries/tax-itr");
    ais2 = await import("@/app/api/ais/route");
    await wave2mModules();
  }, 60_000);

  async function countedOnce(accountId: number) {
    selectAccount(accountId);
    const cap = capital2.getCapitalSummary();
    const base = taxItr2.getTaxBase();
    const res = await ais2.POST(json("/api/ais", { text: "nothing to parse" }));
    const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
    return {
      capital: [cap.equityRealised, cap.ipoRealised, cap.totalRealised],
      tax: [base.exitedIpos.map((r) => r.name), base.cgTrades.map((c) => c.netPnl)],
      ais: recon.fyTotals.map((f) => `${f.fy}|${f.kind}|${f.journal}`),
    };
  }

  const ISSUE = "F27 Technologies Limited"; // what /ipos is typed with…
  const SCRIP = "F27TECH"; //                  …beside this holding

  it("the envelope's own days re-link it, and the LIVE query states the SAME verdict about the same book", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F27_ACC, broker: "zerodha", symbol: SCRIP, tradingsymbol: SCRIP, acquisition: "ipo",
          buyQty: 12, avgBuyPrice: 100, buyValue: 1200, buyDate: "2026-02-20", acquisitionDate: "2026-02-20", buyOrderCount: 1,
          sellQty: 12, avgSellPrice: 150, sellValue: 1800, sellDate: "2026-03-02", sellOrderCount: 1,
          grossPnl: 600, chargesTotal: 2.06, netPnl: 597.94, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const ipoId = t.db
      .insert(t.schema.ipos)
      .values({ accountId: F27_ACC, name: ISSUE, appliedPrice: 100, lotSize: 12, lotsApplied: 1, allotted: true, allottedQty: 12, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20", tradeId })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;
    const before = await countedOnce(F27_ACC);
    expect(before.capital[1], "the baseline is counted-once, not merely stable").toBe(0);

    // A 4.2.x delete: the envelope carries the trades ROW as stored (its three
    // days included) and nothing about the link, which is nulled.
    const stored = row(tradeId)! as unknown as Record<string, unknown>;
    const snapshotId = trash.writeTrashSnapshot({ trades: [stored], legs: [], attachments: [], reason: "F27: deleted by 4.2.x", accountId: F27_ACC });
    t.db.update(t.schema.ipos).set({ tradeId: null }).where(eq(t.schema.ipos.id, ipoId)).run();
    t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, tradeId)).run();

    const restored = trash.restoreTrashSnapshot(snapshotId);
    expect([restored.ok, restored.restored], restored.message).toEqual([true, 1]);
    // THE assertion (on revert of lib/trash.ts, which hands the pairing no dates
    // at all, or of lib/analytics/data-quality.ts, which has no tier B: the
    // record is named after the ISSUE, tier A sees nothing, the holding comes
    // back UNLINKED and its one sale is counted twice).
    const linkOf = () => t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.id, ipoId)).get()!.tradeId;
    expect(linkOf(), "re-linked from facts both rows already state").toBe(tradeId);
    expect(await countedOnce(F27_ACC), "and counted exactly once again").toEqual(before);

    // THE SEAM: the OTHER producer of the same facts. Unlink by hand (what a
    // user does on /ipos) and read the real report: the live query's columns
    // must state the same verdict the envelope's did, or the restore writes a
    // pairing the report will not name.
    t.db.update(t.schema.ipos).set({ tradeId: null }).where(eq(t.schema.ipos.id, ipoId)).run();
    selectAccount(F27_ACC);
    const fromQuery = dqQueries.getUnlinkedExitedIpoRecords().filter((r) => r.id === ipoId);
    expect(fromQuery.map((r) => [r.allotted, r.exitPrice, r.exitDate, r.allotmentDate]), "the query states tier B's four facts").toEqual([[true, 150, "2026-03-02", "2026-02-20"]]);
    const issue = dqQueries.getDataQualityReport().issues.find((i) => i.code === `ipo_record_link:${tradeId}`);
    // THE assertion (on revert of lib/queries/data-quality.ts, which selects
    // none of the four columns: the same record is listed as a candidate with
    // no verdict at all, so the note cannot say which one is the user's).
    expect(issue?.detail, "the live rows reach the same verdict the envelope's did").toContain(`#${ipoId} ${ISSUE} (matches this holding)`);
    t.db.update(t.schema.ipos).set({ tradeId }).where(eq(t.schema.ipos.id, ipoId)).run();
  });
});

// ============================================================================
// F28 — SEAM DEFECT. The two producers' CANDIDATE SETS are not the same set.
// ============================================================================

describe("F28 · the application row /ipos keeps beside the allotment (lib/trash.ts:817 every unlinked record ↔ lib/queries/data-quality.ts:91 allotted AND exited)", () => {
  const ISSUE = "F28 Industries Limited";
  const SCRIP = "F28IND";
  let tradeId = 0;
  let allotmentIpoId = 0;
  let applicationIpoId = 0;
  let snapshotId = "";

  beforeAll(async () => {
    await wave2mModules();
    tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F28_ACC, broker: "zerodha", symbol: SCRIP, tradingsymbol: SCRIP, acquisition: "ipo",
          buyQty: 12, avgBuyPrice: 100, buyValue: 1200, buyDate: "2026-02-20", acquisitionDate: "2026-02-20", buyOrderCount: 1,
          sellQty: 12, avgSellPrice: 150, sellValue: 1800, sellDate: "2026-03-02", sellOrderCount: 1,
          grossPnl: 600, chargesTotal: 2.06, netPnl: 597.94, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    // The allotment, typed on /ipos under the ISSUE's name — the G-G2-1 row.
    allotmentIpoId = t.db
      .insert(t.schema.ipos)
      .values({ accountId: F28_ACC, name: ISSUE, appliedPrice: 100, lotSize: 12, lotsApplied: 1, allotted: true, allottedQty: 12, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20", tradeId })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;
    // The APPLICATION the same user recorded when they applied, under the
    // ticker, never allotted and never edited away. It states no exit, so it
    // can never double-count anything — but it is unlinked, and its NAME is the
    // scrip, which is tier A's whole rule.
    applicationIpoId = t.db
      .insert(t.schema.ipos)
      .values({ accountId: F28_ACC, name: SCRIP, appliedPrice: 100, lotSize: 12, lotsApplied: 1, allotted: false, allottedQty: 0 })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;

    const stored = row(tradeId)! as unknown as Record<string, unknown>;
    snapshotId = trash.writeTrashSnapshot({ trades: [stored], legs: [], attachments: [], reason: "F28: deleted by 4.2.x", accountId: F28_ACC });
    t.db.update(t.schema.ipos).set({ tradeId: null }).where(eq(t.schema.ipos.id, allotmentIpoId)).run();
    t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, tradeId)).run();
    const restored = trash.restoreTrashSnapshot(snapshotId);
    expect([restored.ok, restored.restored], restored.message).toEqual([true, 1]);
  });

  const linkOf = (id: number) => t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.id, id)).get()!.tradeId;

  /** The two rows as the pairing reads them, from what is actually STORED. */
  const factsOf = (ipoId: number) => {
    const r = t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.id, ipoId)).get()!;
    return { id: r.id, accountId: r.accountId, name: r.name, allottedQty: r.allottedQty, allotted: r.allotted, exitPrice: r.exitPrice, exitDate: r.exitDate, allotmentDate: r.allotmentDate };
  };
  const holdingFacts = () => {
    const r = row(tradeId)!;
    return { id: r.id, accountId: r.accountId, symbol: r.symbol, tradingsymbol: r.tradingsymbol, buyQty: r.buyQty, acquisitionDate: r.acquisitionDate, buyDate: r.buyDate, sellDate: r.sellDate };
  };

  // RE-PINNED (seam round). Measured BEFORE D1: `[24]` — the report's set held
  // only the exited record, so it named it a match while the restore, which read
  // the application row too, called the holding ambiguous and wrote nothing.
  // AFTER: `[]` — the restore linked the record, so nothing is unlinked and there
  // is no question left to ask.
  it("the application row is a candidate NOWHERE, and after the restore there is nothing left to ask", () => {
    selectAccount(F28_ACC);
    expect(dqQueries.getUnlinkedExitedIpoRecords().map((r) => r.id), "the link is written, so the report's set is empty").toEqual([]);
    expect(dqQueries.getDataQualityReport().issues.find((i) => i.code === `ipo_record_link:${tradeId}`), "and no question is raised").toBeUndefined();
    // The rule itself, over the WIDER set the restore reads (every unlinked row
    // of the book): a record that states no allotment is no allotment's record,
    // so the pairing answers the same whichever set it is handed.
    expect(dq.ipoRecordMatchesHolding(factsOf(applicationIpoId), holdingFacts()), "the application row claims nothing").toBe(false);
    expect(dq.ipoRecordMatchesHolding(factsOf(allotmentIpoId), holdingFacts()), "the allotment does").toBe(true);
    expect(dq.uniqueIpoRelinks([holdingFacts()], [factsOf(allotmentIpoId), factsOf(applicationIpoId)]), "one candidate, both sets").toEqual([{ tradeId, ipoId: allotmentIpoId }]);
  });

  // FIXED (v4.3.0 fix wave 2M, seam round — D1): this was an `it.fails`.
  // lib/trash.ts:827 and lib/queries/data-quality.ts:104 now read ONE set (the
  // book's unlinked rows that state an ALLOTMENT), and the rule is stated in
  // `ipoRecordMatchesHolding` (lib/analytics/data-quality.ts:1012) as well, so a
  // caller handing the pairing a wider set cannot get a wider answer. Measured
  // before: `expected null to be <tradeId>` — the restore wrote nothing and the
  // one sale stayed counted twice in capital, the tax pack, the ITR export and
  // both AIS sides, after a restore whose own report called the pair unambiguous.
  it("the restore writes the link its own report says is unambiguous", () => {
    expect(linkOf(allotmentIpoId), "re-linked by the record the report names").toBe(tradeId);
  });

  it("the report's own verdict, with the link taken away again: the allotment matches and the application is never named", () => {
    t.db.update(t.schema.ipos).set({ tradeId: null }).where(eq(t.schema.ipos.id, allotmentIpoId)).run();
    selectAccount(F28_ACC);
    const issue = dqQueries.getDataQualityReport().issues.find((i) => i.code === `ipo_record_link:${tradeId}`);
    expect(issue?.detail, "one record, and the two rows' own facts agree about it").toContain(`#${allotmentIpoId} ${ISSUE} (matches this holding)`);
    expect(issue?.detail, "the report never mentions the application row").not.toContain(`#${applicationIpoId}`);
    expect(issue?.detail).toContain("an exited IPO record");
    t.db.update(t.schema.ipos).set({ tradeId }).where(eq(t.schema.ipos.id, allotmentIpoId)).run();
  });

  it("nothing is written onto the application row either way (what IS still true)", () => {
    expect(linkOf(applicationIpoId), "a record that states no allotment is never given a holding").toBeNull();
  });
});

// ============================================================================
// F29 — SEAM DEFECT. `ipos.allotment_date` is the one date on the 2M pairing
//       that NO writer normalises and NO writer refuses.
// ============================================================================

describe("F29 · a day-first allotment date accepted by POST /api/ipos (app/api/ipos/route.ts:431 strOrNull) ↔ isoDay in the pairing (lib/analytics/data-quality.ts:960)", () => {
  const ISSUE = "F29 Chemicals Limited";
  const SCRIP = "F29CHEM";
  let tradeId = 0;
  let ipoId = 0;

  beforeAll(async () => {
    tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F29_ACC, broker: "zerodha", symbol: SCRIP, tradingsymbol: SCRIP, acquisition: "ipo",
          buyQty: 12, avgBuyPrice: 100, buyValue: 1200, buyDate: "2026-02-20", acquisitionDate: "2026-02-20", buyOrderCount: 1,
          sellQty: 12, avgSellPrice: 150, sellValue: 1800, sellDate: "2026-03-02", sellOrderCount: 1,
          grossPnl: 600, chargesTotal: 2.06, netPnl: 597.94, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    await wave2mModules();
    selectAccount(F29_ACC);
    const body = {
      name: ISSUE, exchange: "NSE", appliedPrice: 100, lotSize: 12, lotsApplied: 1,
      allotted: true, allottedQty: 12, listingPrice: 130, exitPrice: 150,
      exitDate: "2026-03-02", allotmentDate: "20-02-2026", // the user's own keyboard, day first
    };
    const res = await ipoRoute.POST(json("/api/ipos", body));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    ipoId = ((await res.json()) as { id: number }).id;
  }, 60_000);

  const recordOf = () => t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.id, ipoId)).get()!;

  // RE-PINNED (seam round). Measured BEFORE D2: the allotment date was stored
  // '20-02-2026' — exactly as typed, beside an exit date three lines away that
  // WAS refused. AFTER: '2026-02-20', and a value that states no day is refused
  // in the exit date's own words, naming the field.
  it("the route stores the allotment date as the ISO day it states, and refuses one that states none", async () => {
    selectAccount(F29_ACC);
    // The exit date's guard, unchanged (IPO-EXITDATE, wave 2G/L3).
    const badExit = await ipoRoute.POST(json("/api/ipos", { name: "F29 refused", appliedPrice: 100, lotSize: 1, lotsApplied: 1, allotted: true, allottedQty: 1, exitPrice: 150, exitDate: "20-02-2026" }));
    expect([badExit.status, ((await badExit.json()) as { message: string }).message.includes("real calendar day")], "the exit date is refused").toEqual([400, true]);
    // THE assertion (on a revert of app/api/ipos/route.ts to HEAD: '20-02-2026',
    // stored as typed, which no reader in the tree writes).
    expect(recordOf().allotmentDate, "the day it states, not the keystrokes").toBe("2026-02-20");
    // …and the allotment date now has the exit date's own guard, in its own name.
    const badAllot = await ipoRoute.POST(json("/api/ipos", { name: "F29 refused too", appliedPrice: 100, lotSize: 1, lotsApplied: 1, allotted: true, allottedQty: 1, allotmentDate: "2026-02-31" }));
    const msg = ((await badAllot.json()) as { message: string }).message;
    expect([badAllot.status, msg], "a day that does not exist is refused, and nothing is saved").toEqual([400, "The allotment date must be a real calendar day written year-month-day, such as 2026-06-15. Nothing was saved."]);
    expect(t.db.select().from(t.schema.ipos).all().some((r) => r.name === "F29 refused too"), "nothing was saved").toBe(false);
  });

  // FIXED (v4.3.0 fix wave 2M, seam round — D2): this was an `it.fails`.
  // The writer (app/api/ipos/route.ts:433-462) now stores the ISO day, and the
  // consumer reads its four dates through `normalizeDate` rather than the old
  // shape test `isoDay` (lib/analytics/data-quality.ts:942, 981) — so a LEGACY
  // day-first value stored before this wave is recognised as the day it names
  // too. Measured before: `20-02-2026 is 2026-02-20: expected false to be true`,
  // and with it no re-link on a 4.2.x restore and no verdict in the note.
  it("a day-first allotment date is still the same allotment day", () => {
    const holding = { id: tradeId, accountId: F29_ACC, symbol: SCRIP, tradingsymbol: SCRIP, buyQty: 12, acquisitionDate: "2026-02-20", buyDate: "2026-02-20", sellDate: "2026-03-02" };
    // The row as it is STORED (ISO, since D2), and the LEGACY form of the same
    // day, which only the consumer's calendar can rescue.
    expect(dq.ipoRecordMatchesHolding({ ...recordOf(), name: ISSUE } as never, holding), "the stored ISO day").toBe(true);
    expect(dq.ipoRecordMatchesHolding({ ...recordOf(), name: ISSUE, allotmentDate: "20-02-2026" } as never, holding), "20-02-2026 is 2026-02-20").toBe(true);
    // …and a day that does not exist is still a day neither side states, however
    // both of them spell it (before D2 the shape test compared these EQUAL).
    expect(dq.ipoRecordMatchesHolding({ ...recordOf(), name: ISSUE, allotmentDate: "2026-02-31" } as never, { ...holding, acquisitionDate: "2026-02-31", buyDate: "2026-02-31" }), "an impossible day is not a match").toBe(false);
  });

  // RE-PINNED (seam round). Measured BEFORE D2: the note listed the record with
  // no verdict at all, because the days did not compare. AFTER: it is marked.
  it("and the report says which record is this holding's own", () => {
    selectAccount(F29_ACC);
    const issue = dqQueries.getDataQualityReport().issues.find((i) => i.code === `ipo_record_link:${tradeId}`);
    expect(issue?.title, "the question is raised whatever the dates say (G-G2-1)").toBe("IPO record not linked to its holding");
    expect(issue?.detail, "…and now with a verdict the user can act on").toContain(`#${ipoId} ${ISSUE} (matches this holding)`);
  });
});

// ============================================================================
// F30 — the trade editor's preview body (B-DATE) ↔ /api/charges/preview ≡
//       updateManualTrade, with a DAY-FIRST buy date on the wire
// ============================================================================

describe("F30 · a day-first buy date typed into the trade editor on an MTF row (edit-trade-dialog.tsx:79-105 → POST /api/charges/preview ≡ updateTradeAction → commit.ts updateManualTrade)", () => {
  beforeAll(async () => {
    editDialog = (await import("@/components/trades/edit-trade-dialog")) as typeof editDialog;
    chargesPreview = await import("@/app/api/charges/preview/route");
    Dialog = (await import("@/components/ui/dialog")).Dialog;
    EditTradeDialog = editDialog.EditTradeDialog;
    await wave2mModules();
  }, 60_000);

  /** The dialog's own effect: the body it builds, over the real route, as [gross, charges, net]. */
  async function editorPreview(w: WireTrade, f: Record<string, unknown>): Promise<number[] | null> {
    const build = exported(editDialog, "editPreviewBody") as ((t: WireTrade, f: unknown) => unknown) | undefined;
    const body = typeof build === "function" ? build(w, f) : null;
    if (body == null) return null;
    const res = await chargesPreview.POST(json("/api/charges/preview", JSON.parse(JSON.stringify(body))));
    const p = (await res.json()) as { grossPnl: number; netPnl: number; breakdown: { total: number } };
    expect(res.status, JSON.stringify(p)).toBe(200);
    return [p.grossPnl, p.breakdown.total, p.netPnl];
  }

  it("the preview bills the 30 days the resolved dates really are, and it is the bill the save stores — long MTF and a short alike", async () => {
    const mtf = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F30_ACC, broker: "angelone", bucket: "equity", segment: "eq_mtf", symbol: "F30-MTF", tradingsymbol: "F30-MTF",
          buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-07-15", buyOrderCount: 1, mtfFundedAmount: 16000, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    const typed = { buyDate: "15-07-2026", sellQty: "100", avgSellPrice: "255", sellDate: "2026-08-14" };
    const w = wireTrade(F30_ACC, mtf);
    const shown = await editorPreview(w, {
      buyQty: 100, avgBuyPrice: 200, sellQty: 100, avgSellPrice: 255, ownCapitalUsed: 4000,
      buyDate: typed.buyDate, sellDate: typed.sellDate,
    });
    const saved = await actions.updateTradeAction(NO_STATE, editorForm(F30_ACC, mtf, typed));
    expect(saved.ok, saved.message).toBe(true);

    const r = row(mtf)!;
    expect([r.isOpen, r.buyDate, r.sellDate], "the save stores the RESOLVED days").toEqual([false, "2026-07-15", "2026-08-14"]);
    expect(r.mtfInterest, "30 days of interest on ₹16,000 — not 0, and not seven months").toBeGreaterThan(0);
    // THE assertion (on revert of components/trades/edit-trade-dialog.tsx: the
    // raw '15-07-2026' is an Invalid Date, daysHeld is NaN, JSON sends null and
    // the route's `?? 0` bills ZERO days against a save that charges the real 30).
    expect(shown, "the day-first preview is the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);

    // The other sign, through the same two halves: a SHORT intraday round trip
    // whose entry day is typed day-first (no MTF interest here — what is tested
    // is that one wire carries both legs' resolved days to the same bill).
    const shortId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F30_ACC, broker: "angelone", bucket: "equity", segment: "eq_intraday", symbol: "F30-SHORT", tradingsymbol: "F30-SHORT",
          sellQty: 100, avgSellPrice: 255, sellValue: 25500, sellDate: "2026-07-15", sellOrderCount: 1, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const sTyped = { sellDate: "15-07-2026", buyQty: "100", avgBuyPrice: "250", buyDate: "15-07-2026" };
    const sShown = await editorPreview(wireTrade(F30_ACC, shortId), {
      buyQty: 100, avgBuyPrice: 250, sellQty: 100, avgSellPrice: 255, ownCapitalUsed: null,
      buyDate: sTyped.buyDate, sellDate: sTyped.sellDate,
    });
    const sSaved = await actions.updateTradeAction(NO_STATE, editorForm(F30_ACC, shortId, sTyped));
    expect(sSaved.ok, sSaved.message).toBe(true);
    const sr = row(shortId)!;
    expect([sr.buyDate, sr.sellDate], "both ends resolved on a short too").toEqual(["2026-07-15", "2026-07-15"]);
    expect(sShown, "the short's preview is its save").toEqual([sr.grossPnl, sr.chargesTotal, sr.netPnl]);
  });
});

// ============================================================================
// F31 — the staged ladder's stored leg day (B-DATE) ↔ the parent's sell date
//       ↔ the IPO pairing's tier B (B-IPO). One value, two builders.
// ============================================================================

describe("F31 · a staged IPO holding closed by a leg posted DAY-FIRST (queries/staged.ts:553 the stored day → parentAggregate → the parent's sellDate → matchesByExit)", () => {
  let stagedQ: typeof import("@/lib/queries/staged");
  beforeAll(async () => {
    stagedQ = await import("@/lib/queries/staged");
    await wave2mModules();
  }, 60_000);

  const ISSUE = "F31 Logistics Limited";
  const SCRIP = "F31LOG";

  it("the ladder stores the ISO day, the parent states it, and the ISSUE-named record is recognised as this holding's own", () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F31_ACC, broker: "angelone", bucket: "equity", segment: "eq_mtf", instrumentType: "equity", exchange: "NSE",
          symbol: SCRIP, tradingsymbol: SCRIP, acquisition: "ipo", acquisitionDate: "2026-02-20",
          buyQty: 12, avgBuyPrice: 100, buyValue: 1200, buyDate: "2026-02-20", buyOrderCount: 1, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    selectAccount(F31_ACC);
    expect(stagedQ.convertToStaged(tradeId).ok, "the allotment becomes a ladder").toBe(true);

    // The user books the exit from the staged panel, typing the day FIRST.
    const booked = stagedQ.addLeg({ tradeId, kind: "exit", tradeDate: "02-03-2026", qty: 12, price: 150, direction: "long" });
    expect([booked.ok, booked.message]).toEqual([true, "Exit booked."]);
    const legs = t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, tradeId)).all().sort((a, b) => a.seq - b.seq);
    expect(legs.map((l) => l.tradeDate), "one convention in the column").toEqual(["2026-02-20", "2026-03-02"]);
    const parent = row(tradeId)!;
    expect([parent.isOpen, parent.sellDate], "the parent holds the aggregate (invariant 5)").toEqual([false, "2026-03-02"]);

    // …and the record typed under the ISSUE's name, which no name tier can see.
    const ipoId = t.db
      .insert(t.schema.ipos)
      .values({ accountId: F31_ACC, name: ISSUE, appliedPrice: 100, lotSize: 12, lotsApplied: 1, allotted: true, allottedQty: 12, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20" })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;

    selectAccount(F31_ACC);
    const issue = dqQueries.getDataQualityReport().issues.find((i) => i.code === `ipo_record_link:${tradeId}`);
    // THE assertion. On revert of lib/queries/staged.ts the exit leg is stored
    // as '02-03-2026', the parent's sellDate becomes '02-03-2026', `isoDay`
    // answers null for it and tier B refuses — the pairing never sees its own
    // holding. On revert of lib/analytics/data-quality.ts there is no tier B at
    // all and the ISSUE-named record matches nothing.
    expect(issue?.detail, "the day the ladder stored is the day the pairing reads").toContain(`#${ipoId} ${ISSUE} (matches this holding)`);
    expect(dqQueries.getUnlinkedExitedIpoRecords().map((r) => r.id)).toContain(ipoId);
  });
});

// ============================================================================
// F32 — the two dialogs' BLANK date, across the IST day boundary. Two rules on
//       purpose; each must equal its OWN save.
// ============================================================================

describe("F32 · a blank date at 19:00 UTC — the close dialog's blank is today (close-trade-dialog.tsx:40) and the editor's is 'cleared' (edit-trade-dialog.tsx:99)", () => {
  beforeAll(async () => {
    editDialog = (await import("@/components/trades/edit-trade-dialog")) as typeof editDialog;
    closeDialog = (await import("@/components/trades/close-trade-dialog")) as typeof closeDialog;
    chargesPreview = await import("@/app/api/charges/preview/route");
    Dialog = (await import("@/components/ui/dialog")).Dialog;
    EditTradeDialog = editDialog.EditTradeDialog;
    await wave2mModules();
  }, 60_000);

  it("the editor's blank sell date bills 0 days and clears the date, while the close dialog's blank is the IST day — and each is its own save", async () => {
    // 18:30–24:00 UTC: India is already on the NEXT day.
    freezeAt("2026-08-31T19:00:00.000Z");
    expect(todayIstIso(), "the IST day has turned").toBe("2026-09-01");

    const seed = (sym: string) =>
      t.db
        .insert(t.schema.trades)
        .values(
          tradeRow({
            accountId: F32_ACC, broker: "angelone", bucket: "equity", segment: "eq_mtf", symbol: sym, tradingsymbol: sym,
            buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-01", buyOrderCount: 1, mtfFundedAmount: 16000, isOpen: true,
          }),
        )
        .returning({ id: t.schema.trades.id })
        .get()!.id;

    // (i) THE EDITOR. A blank sell date means "clear this", as every other field
    // in that form does, so the row stays open and bills no holding period here.
    const edited = seed("F32-EDIT");
    const build = exported(editDialog, "editPreviewBody") as ((t: WireTrade, f: unknown) => unknown) | undefined;
    const body = typeof build === "function"
      ? build(wireTrade(F32_ACC, edited), { buyQty: 100, avgBuyPrice: 200, sellQty: 0, avgSellPrice: 0, ownCapitalUsed: 4000, buyDate: "2026-08-01", sellDate: null })
      : null;
    expect((body as { daysHeld: number; sellDate: string | null }).daysHeld, "blank clears; it never becomes today").toBe(0);
    expect((body as { sellDate: string | null }).sellDate, "and nothing is invented on the wire").toBeNull();
    const pres = await chargesPreview.POST(json("/api/charges/preview", JSON.parse(JSON.stringify(body))));
    const shown = (await pres.json()) as { grossPnl: number; netPnl: number; breakdown: { total: number } };
    const savedEdit = await actions.updateTradeAction(NO_STATE, editorForm(F32_ACC, edited, { sellDate: "", sellQty: "0", avgSellPrice: "0" }));
    expect(savedEdit.ok, savedEdit.message).toBe(true);
    const er = row(edited)!;
    expect([er.isOpen, er.sellDate], "the save's own semantics: blank CLEARS").toEqual([true, null]);
    expect([shown.grossPnl, shown.breakdown.total, shown.netPnl], "the editor's blank preview is the editor's save").toEqual([er.grossPnl, er.chargesTotal, er.netPnl]);

    // (ii) THE CLOSE DIALOG, the same blank field, the deliberately other rule.
    const closed = seed("F32-CLOSE");
    const resolveFn = exported(closeDialog, "resolveExitIso") as ((d: string) => string | null) | undefined;
    expect(typeof resolveFn === "function" ? resolveFn("") : null, "unanswered, not unreadable").toBe("2026-09-01");
    const fd = new FormData();
    fd.set("tradeId", String(closed));
    fd.set("exitPrice", "255");
    fd.set("exitDate", "");
    const savedClose = await actions.closeTradeAction(NO_STATE, fd);
    expect(savedClose.ok, savedClose.message).toBe(true);
    const cr = row(closed)!;
    expect([cr.isOpen, cr.sellDate], "the close's own rule: blank is the IST day").toEqual([false, "2026-09-01"]);
    expect(cr.mtfInterest, "31 days of interest, billed across the boundary").toBeGreaterThan(0);
    // THE assertion the seam is about: the two dialogs answer a blank field
    // DIFFERENTLY on purpose, and neither answer leaks into the other's save.
    expect([er.sellDate, cr.sellDate], "one calendar, two deliberate rules").toEqual([null, "2026-09-01"]);
  });
});

// ============================================================================
// F33 — the editor's NULL preview body (B-DATE) ↔ the dialog's own render ↔
//       updateManualTrade's refusal. ONE sentence.
// ============================================================================

describe("F33 · a legacy row whose stored sell date is not a calendar day, opened in the trade editor (editDateProblem → null body → the render ≡ the save's refusal)", () => {
  beforeAll(async () => {
    editDialog = (await import("@/components/trades/edit-trade-dialog")) as typeof editDialog;
    Dialog = (await import("@/components/ui/dialog")).Dialog;
    EditTradeDialog = editDialog.EditTradeDialog;
    await wave2mModules();
  }, 60_000);

  it("the dialog states the refusal where the figure would be, builds no request, and the save refuses the same value in the same words", async () => {
    // Stored before L3 refused it: '2026-02-31' is a day the calendar does not have.
    const legacy = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F33_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "F33-LEG", tradingsymbol: "F33-LEG",
          buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-02-01", buyOrderCount: 1,
          sellQty: 100, avgSellPrice: 255, sellValue: 25500, sellDate: "2026-02-31", sellOrderCount: 1,
          grossPnl: 5500, chargesTotal: 20, netPnl: 5480, mtfFundedAmount: 16000, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const before = row(legacy)!;
    const w = wireTrade(F33_ACC, legacy);

    // 1. The body. NULL — there is no figure to preview for a value the save refuses.
    const build = exported(editDialog, "editPreviewBody") as ((t: WireTrade, f: unknown) => unknown) | undefined;
    const body = typeof build === "function"
      ? build(w, { buyQty: 100, avgBuyPrice: 200, sellQty: 100, avgSellPrice: 255, ownCapitalUsed: 4000, buyDate: "2026-02-01", sellDate: "2026-02-31" })
      : undefined;
    // THE assertion (on revert of components/trades/edit-trade-dialog.tsx: a
    // body IS built, `new Date('2026-02-31')` rolls to 3 March, and the dialog
    // shows a bill for a trade the Save button will not store).
    expect(body, "no figure, and nothing sent").toBeNull();

    // 2. The dialog's own server render: the sentence stands where the preview
    //    block would be, and no charge figure is printed beside it.
    const html = renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(EditTradeDialog, { trade: w, onDone: () => {} })));
    const sentence = unescape(html).includes("is not a real calendar day");
    expect(sentence, "the refusal is rendered, derived — no state, no effect").toBe(true);
    expect(unescape(html)).toContain("The sell date “2026-02-31” is not a real calendar day");
    expect(unescape(html), "…and no live figure beside it").not.toContain("Brokerage");

    // 3. The SAVE, through the real action, on the same value the form holds.
    const saved = await actions.updateTradeAction(NO_STATE, editorForm(F33_ACC, legacy, {}));
    expect(saved.ok, "the save refuses it too").toBe(false);
    // ONE sentence: commit.ts's own refusal and the sentence the client module
    // renders are the same string, character for character (they live in two
    // modules — lib/import/commit.ts:64 and lib/domain/trading-day.ts:194).
    expect(saved.message).toBe(unreadableDateMessage("sell date", "2026-02-31"));
    expect(row(legacy), "and nothing was changed").toEqual(before);
  });
});

// ============================================================================
// WAVE 2M, THE SEAM ROUND — the three boundaries round 1 named with NO case
// (report §0 items 1 and 2, and the tax reader S-IPO left as `blocked[]`).
// D1..D4 are fixed; these are the cases their seams still had none of.
// ============================================================================

describe("F34 · a basis typed on the /trades acquisition panel (app/trades/actions.ts:505-509 setAcquisitionAction → trades.acquisition_date + buy_date → matchesByExit's `acquisitionDate ?? buyDate`)", () => {
  const ISSUE = "F34 Speciality Limited";
  const SCRIP = "F34SPEC";

  beforeAll(async () => {
    await wave2mModules();
  }, 60_000);

  it("a day-first acquisition day lands as the ISO day on BOTH columns and the ISSUE-named record is recognised; a half-typed year is refused and nothing is written", async () => {
    // A sale whose basis the journal never had — the row the panel exists for.
    const saleId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F34_ACC, broker: "zerodha", symbol: SCRIP, tradingsymbol: SCRIP,
          buyQty: 0, avgBuyPrice: 0, buyValue: 0, buyDate: null, buyOrderCount: 0,
          sellQty: 12, avgSellPrice: 150, sellValue: 1800, sellDate: "2026-03-02", sellOrderCount: 1,
          grossPnl: 0, chargesTotal: 2.06, netPnl: -2.06, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const untouched = row(saleId)!;

    const post = async (acquisitionDate: string) => {
      const fd = new FormData();
      fd.set("tradeId", String(saleId));
      fd.set("acquisition", "ipo");
      fd.set("acquisitionPrice", "100");
      fd.set("acquisitionDate", acquisitionDate);
      return actions.setAcquisitionAction(NO_STATE, fd);
    };

    // 1. The half-typed year a real `<input type="date">` reaches
    //    (components/trades/acquisition-panel.tsx:102). THE assertion (on a
    //    revert of app/trades/actions.ts to HEAD: ok true, and '0002-06-15' sits
    //    in acquisition_date AND buy_date, dating the tax pack's financial year
    //    and every holding period from it).
    const refused = await post("0002-06-15");
    expect([refused.ok, refused.message], "refused in the same words every other typed-date writer uses").toEqual([false, unreadableDateMessage("acquisition date", "0002-06-15")]);
    expect(row(saleId), "and nothing was written — not even the acquisition kind").toEqual(untouched);

    // 2. The day-first form of a real day.
    const saved = await post("20-02-2026");
    expect(saved.ok, saved.message).toBe(true);
    const r = row(saleId)!;
    // THE assertion (on the same revert: ['20-02-2026', '20-02-2026']).
    expect([r.acquisitionDate, r.buyDate], "one convention in both columns").toEqual(["2026-02-20", "2026-02-20"]);
    expect([r.acquisition, r.buyQty, r.buyValue], "the basis itself still lands").toEqual(["ipo", 12, 1200]);

    // 3. The consumer: the ISSUE-named record the panel's own day now matches.
    const ipoId = t.db
      .insert(t.schema.ipos)
      .values({ accountId: F34_ACC, name: ISSUE, appliedPrice: 100, lotSize: 12, lotsApplied: 1, allotted: true, allottedQty: 12, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20" })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;
    selectAccount(F34_ACC);
    const issue = dqQueries.getDataQualityReport().issues.find((i) => i.code === `ipo_record_link:${saleId}`);
    expect(issue?.detail, "the day the panel stored is the day the pairing reads").toContain(`#${ipoId} ${ISSUE} (matches this holding)`);
  });
});

describe("F35 · a LEGACY row converted to a ladder (lib/queries/staged.ts:690-729 convertToStaged → trade_legs.trade_date → priceLegs ≡ the parent row)", () => {
  let stagedQ2: typeof import("@/lib/queries/staged");
  beforeAll(async () => {
    stagedQ2 = await import("@/lib/queries/staged");
    await wave2mModules();
  }, 60_000);

  const legsOf = (id: number) => t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, id)).all().sort((a, b) => a.seq - b.seq);
  let n = 0;
  const legacyMtf = (buyDate: string | null) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F35_ACC, broker: "angelone", bucket: "equity", segment: "eq_mtf", instrumentType: "equity", exchange: "NSE",
          symbol: `F35L${++n}`, tradingsymbol: `F35L${n}`,
          buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate, buyOrderCount: 1, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

  it("a stored '2026-02-31' is refused BY THE COLUMN'S NAME, the parent is byte-identical and no leg is left behind", () => {
    const id = legacyMtf("2026-02-31");
    selectAccount(F35_ACC);
    const before = row(id)!;
    const res = stagedQ2.convertToStaged(id);
    // THE assertion (D4). Against the wave-2M tree: {ok:true, "Staged mode
    // enabled."} with the leg AND the parent's buy_date silently moved to today
    // — the tax pack's financial year, the MTF day count, the holding period and
    // tier B's `acquisitionDate ?? buyDate` all moving with it. Against HEAD's
    // own form: the message names the LEG ("The entry date …") and the leg row is
    // already INSERTED when the rebuild refuses (invariant 5).
    expect([res.ok, res.message], "the column the leg would have copied is what is named").toEqual([false, unreadableDateMessage("buy date", "2026-02-31")]);
    expect(legsOf(id), "nothing inserted — the refusal is before the first write").toEqual([]);
    expect(row(id), "and the parent is exactly as it was, staged still off").toEqual(before);
  });

  it("a stored day-first day converts, lands its first leg as the ISO day, and is priced off the day it resolves to — to the paisa", () => {
    const iso = legacyMtf("2026-08-31");
    const dmy = legacyMtf("31-08-2026");
    selectAccount(F35_ACC);
    expect([stagedQ2.convertToStaged(iso).ok, stagedQ2.convertToStaged(dmy).ok], "both convert").toEqual([true, true]);
    expect(legsOf(dmy).map((l) => l.tradeDate), "one convention in the column").toEqual(["2026-08-31"]);
    // THE assertion: the SAME money. `priceLegs` resolves the leg day, and the
    // parent carries what it billed (invariant 5). Against a pre-2M staged.ts
    // the day-first row could not be written at all (`new Date('31-08-2026')` is
    // an Invalid Date, so the charges went NaN into a NOT NULL column).
    const figures = (id: number) => [row(id)!.chargesTotal, row(id)!.mtfInterest, row(id)!.netPnl];
    expect(figures(dmy), "the same ladder, the same bill").toEqual(figures(iso));
    expect(row(dmy)!.mtfInterest, "and it really does bill interest (not a vacuous 0 = 0)").toBeGreaterThan(0);
  });

  it("an UNDATED row still seeds today — the behaviour the refusal must not have taken away", () => {
    const id = legacyMtf(null);
    selectAccount(F35_ACC);
    expect(stagedQ2.convertToStaged(id).ok, "a row that states no day is not a row that states a bad one").toBe(true);
    expect(legsOf(id).map((l) => l.tradeDate)).toEqual([todayIstIso()]);
  });
});

describe("F36 · an IPO record whose stored allotment day is a LEGACY day-first value (ipos.allotment_date → lib/analytics/ipo.ts:378 ipoTaxEstimate → capital-gains.ts:64 classifyTerm → /ipos)", () => {
  let ipoQ: typeof import("@/lib/queries/ipos");
  beforeAll(async () => {
    ipoQ = await import("@/lib/queries/ipos");
    await wave2mModules();
  }, 60_000);

  it("the term is the real holding period, not the ST a NaN comparison produced", () => {
    // Written by a 4.2.x /ipos save, before the route normalised the field —
    // INSERTED RAW here because the route now refuses to write it.
    const legacy = t.db
      .insert(t.schema.ipos)
      .values({ accountId: F36_ACC, name: "F36 Cements Limited", exchange: "NSE", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "20-02-2024" })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;
    selectAccount(F36_ACC);
    const shown = ipoQ.getIposComputed().rows.find((r) => r.id === legacy)!;
    // 2024-02-20 → 2026-03-02 is 741 days. THE assertion (on a revert of
    // lib/analytics/capital-gains.ts to HEAD: `new Date('20-02-2024T00:00:00')`
    // is an Invalid Date, the day count is NaN, `NaN >= 365` is false and every
    // such lot was labelled SHORT term — at 20% rather than 12.5%).
    expect([shown.tax?.term, shown.tax?.ratePct], "the day it names, and the rate that day earns").toEqual(["LT", 12.5]);
    expect(shown.realised, "and it really is a realised, priced exit").toBe(true);
  });
});
