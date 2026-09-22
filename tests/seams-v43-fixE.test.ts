import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { STALE_CLOSE_NOTE } from "@/lib/import/close-open-lots";
import * as crossSource from "@/lib/import/cross-source";
import { todayIstIso } from "@/lib/domain/trading-day";
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import { taxByFy, type TaxTrade } from "@/lib/analytics/tax";
import { assetClassFor } from "@/lib/analytics/cg-heads";

/**
 * v4.5.0 — `TaxTrade.assetClass` is REQUIRED and never defaulted, so a journal
 * row has to be resolved through `assetClassFor()` before it reaches a head,
 * exactly as `getTaxBase` does it (lib/queries/tax-itr.ts). A literal "share"
 * here would re-create the bug the wave removed: a gold/debt ETF taxed at
 * S.111A/S.112A. Every fixture below trades ordinary shares, and this resolves
 * to `"share"` for them from the row's own ISIN and symbol.
 */
const taxRowsOf = (rows: readonly { segment: string; isin?: string | null; symbol?: string | null }[]): TaxTrade[] =>
  rows.map((r) => ({ ...(r as unknown as TaxTrade), assetClass: assetClassFor(r) }));

/**
 * v4.3.0 FIX WAVE 2H — THE SEAMS OF A SIX-BUILDER WAVE.
 *
 * H1 (lib/import/commit.ts closePosition + updateManualTrade), H2 (commit.ts
 * planSnapshot + lib/import/cross-source.ts), H3 (lib/analytics/data-quality.ts
 * + lib/trash.ts), H4 (lib/import/dhan-unfetched.ts, the broker route's kept-
 * notice GET / Clear, components/import/broker-connect.tsx), H5 (the IPO route
 * + components/ipo/ipo-client.tsx), H6 (app/strategies/page.tsx) owned disjoint
 * files. This file runs the two real halves of every value that crosses from one
 * builder's files into another's, or from a 2H change into the unchanged code
 * that feeds or reads it (the trade editor and the close dialog, the Positions
 * close route, the Data Quality card and route, the Deleted-items route, the
 * /trades KPI strip and the tax-by-FY report, the pull route's 409, /ipos'
 * query, the strategy card).
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The stubs are framework and
 * transport only: `next/cache`, `next/navigation` and `globalThis.fetch` for
 * api.dhan.co. A client form's request is built from its OWN server render
 * (the inputs it prints) and handed to the real server action or route.
 *
 * ── THE SEAM TABLE ───────────────────────────────────────────────────────────
 *
 *  # | crossing value                          | producer (file:line, builder)                        | consumer (file:line)                                         | unit / shape                        | test
 * ---|-----------------------------------------|------------------------------------------------------|--------------------------------------------------------------|-------------------------------------|-----
 *  a | import_notes WITHOUT STALE_CLOSE_NOTE,  | components/trades/edit-trade-dialog.tsx:181-216 form | lib/analytics/data-quality.ts:547 staleJoinExempts (H3) ←    | '|'-joined text; alias kept         | E-a
 *    |   alias kept, once the joined close is  |   → app/trades/actions.ts:262 updateTradeAction →    |   lib/queries/data-quality.ts:45 getStaleOpenSection →       |                                     |
 *    |   re-made                               |   commit.ts:2387/:2415 (H1); app/api/positions/      |   components/quality/stale-lot-fix.tsx button; close-stale   |                                     |
 *    |                                         |   close/route.ts:15 → commit.ts:1972 (H1)            |   route → commit.ts:2074 closeStaleLot 409 AMBIGUOUS         |                                     |
 *  b | a sale's dedup_hash vs a lot's          | app/api/data-quality/close-stale → commit.ts:2074    | lib/trash.ts:499 restore skip (H3) ← app/api/trash/route.ts  | 64-hex hash, case-folded            | E-b
 *    |   `dedup-alias:` (the join's record)    |   withStaleCloseNote; lib/queries/delete.ts snapshot |   :36 → data-quality.ts:632 per-link exemption (H3) → card,  |                                     |
 *    |                                         |                                                      |   close-stale route                                          |                                     |
 *  c | the parent row's aggregate after a      | commit.ts:1888 closePosition (H1) ← close-trade-     | lib/queries/trades.ts:114 getJournalTrades + :467            | ₹ at runtime (paise in the column), | E-c
 *    |   partial close: qty, value, avg, date, |   dialog.tsx form → actions.ts:242; positions/close  |   tradeStatsOf (/trades KPI); lib/analytics/tax.ts:69        |   avg REAL; IST day for the exit    |
 *    |   gross / net                           |   route (JSON, exitPrice a string)                   |   taxByFy (FY by sellDate)                                   |                                     |
 *  d | the M1 ask's sentence                   | commit.ts:517 offKey → :792 snapshotOffKey (H2) →    | app/api/import/broker/route.ts:1105 409 JSON `message` →     | text, singular / plural, + route    | E-d
 *    |                                         |   cross-source.ts:292/:326 (H2)                      |   broker-connect.tsx:233 collisionDialogCopy (unchanged)     |   tail the dialog strips            |
 *  e | a kept notice's record connection       | dhan-unfetched.ts:150 lines (H4) → route.ts:354 GET  | broker-connect.tsx:120 unfetchedLines, :442 unfetchedNotice, | number | null by index; a body      | E-e
 *    |                                         |   `unfetched` + `unfetchedConnection`                |   :131 clearUnfetchedBody → route.ts:615 → dhan-unfetched    |   with no field = legacy clear      |
 *    |                                         |                                                      |   :185 clearUnfetchedLine (H4)                               |                                     |
 *  f | the exit date an IPO edit sends over an | lib/queries/ipos.ts:105 getIposComputed → ipo-client | app/api/ipos/route.ts:181 refusal / pass-through (H5) → the  | YYYY-MM-DD string, "" = clear       | E-f
 *    |   unreadable stored one                 |   .tsx:428 state + :401 exitDateToSend (H5)          |   next page render                                           |                                     |
 *  g | the cards of All accounts               | app/strategies/page.tsx:145/:213 (H6) per-account    | components/strategies/strategies-client.tsx:330 → strategy-  | ScreenGroup[]; key accountId|key    | E-g
 *    |                                         |   join + engine call ← lib/queries/trades.ts options |   card.tsx StrategyCard                                      |   only on 2+ accounts               |
 *
 * THE 2H SEAM FIXES (S1-S4), re-run 2026-09-15:
 *
 *  c′| the close dialog's preview body         | lib/domain/close-aggregate.ts:60 closingAggregate →  | app/api/charges/preview/route.ts:37 → [gross, charges, net]  | ₹ (JSON numbers), dates ISO; order  | E-c ×2
 *    |   (legs, gross, dates)                  |   close-trade-dialog.tsx:29 closePreviewBody (S1)    |   the dialog prints ≡ commit.ts:1885 closePosition's write   |   counts on the wire since T2 (c″)  |
 *  b′| a joined lot's restore refusal          | lib/trash.ts:427-471 (S2) → app/api/trash/route.ts   | components/system/deleted-items-panel.tsx:69 toast.error;    | {ok false, restored 0, message}     | E-b (2)
 *    |                                         |   :36 JSON                                           |   the Trades delete it names → the same restore              |                                     |
 *  e′| a stale card's named Clear after the    | broker-connect.tsx:131 clearUnfetchedBody (H4) ←     | route.ts:606 → dhan-unfetched.ts:199 clearUnfetchedLine (S3) | number | null; 200 / 404            | E-e S3 ×2
 *    |   pull cleared its record               |   GET before dhan-unfetched.ts:338 clearCoveredPageCaps |                                                            |                                     |
 *  f′| the blank exit date + a typed exit price| ipo-client.tsx:401 exitDateToSend (H5) → JSON        | app/api/ipos/route.ts:80/:208 syncClosesUndated (S4) → 400 → | "" string; message text             | E-f S4
 *    |                                         |                                                      |   ipo-client.tsx:461 toast                                   |                                     |
 *
 * RED ON REVERT (2026-09-15): each side's HEAD 3feb22f copy aliased over the
 * working module with vi.mock in a deleted tests/zzprobe-seamE-* copy of this
 * file (no product file touched): commit.ts → E-a, E-c ×2, E-d ×2;
 * cross-source.ts → E-d ×2; lib/trash.ts → E-b (1); data-quality.ts → E-b (2);
 * dhan-unfetched.ts + the broker route → E-e ×2; broker-connect.tsx → E-e (1);
 * ipo-client.tsx → E-f (1); app/strategies/page.tsx → E-g (2). The IPO route's
 * HEAD copy leaves E-f green: the shipped form never sends the unreadable
 * value for an allotted IPO, so the route's H5 refusal is not on this path.
 *
 * RED ON REVERT, the S1-S4 re-run (2026-09-15, deleted tests/zzprobe-seamE2-*
 * copies, one side aliased per copy): close-trade-dialog.tsx HEAD → E-c ×2
 * ("the preview is the save: expected [ 2200, 48.88, 2151.12 ] to deeply equal
 * [ 5200, 64.45, 5135.55 ]"); commit.ts HEAD → E-c ×2 (the stored legs, before
 * the preview line); lib/trash.ts with S2's refusal neutralised → E-b (2)
 * ("expected { ok: true, restored: 1, …(4) } to match object"); lib/trash.ts with
 * H3's in-loop skip neutralised → E-b ×2; dhan-unfetched.ts with S3's lookup put
 * back to open records only → E-e S3 one line ("expected 404 to be 200");
 * broker-connect.tsx HEAD → E-e ×3 (softened: the S3 two-line Clear answers 200
 * and clears the 14:30 fact); app/api/ipos/route.ts with S4's check neutralised
 * → E-f S4 ("expected [ 200, { ok: true, id: 2, …(1) } ] to deeply equal
 * [ 400, …"); ipo-client.tsx HEAD → E-f ×2 (S4: H5's other sentence). The
 * data-quality.ts HEAD copy is now green: the lot-beside-its-sale state its
 * per-link exemption reads is no longer reachable through a restore (S2).
 *
 * THE SECOND SEAM FIXES (T1-T3), re-run 2 2026-09-15:
 *
 *  b″| a lot's restore after its sale was    | commit.ts:2218 withStaleCloseNote (the card's join)  | lib/trash.ts:442-517 T1 identity index (own + alias, | {ok false, restored 0, message}     | E-b T1
 *    |   joined onto ANOTHER lot             |   → the other lot's `dedup-alias:`                   |   planned) → app/api/trash/route.ts:36 → panel toast |   naming the holder                 |
 *  c″| the stored order counts on the wire   | lib/domain/slim-trade.ts:88-89 SLIM_TRADE_FIELDS →   | close-trade-dialog.tsx:52-53 closePreviewBody →      | integers (orders), ₹ figures        | E-c T2 ×2
 *    |                                       |   getJournalTrades / getTradesPage / GET             |   /api/charges/preview ≡ commit.ts:1885-1898         |                                     |
 *    |                                       |   /api/trades/page (JSON)                            |   closePosition (closeTradeAction, positions/close)  |                                     |
 *  f″| the exit date a SOLD linked IPO sends | ipo-client.tsx:397 storedAsSold + :410 exitDateToSend| app/api/ipos/route.ts:197-208 H5/S4 pass-through     | YYYY-MM-DD / stored string; notice  | E-f T3
 *    |   with its field untouched            |   (T3) + the notice                                  |   → syncLinkedTrade                                  |   text                              |
 *
 * RED ON REVERT, the T1-T3 re-run (deleted tests/zzprobe-seamE3-* copies, one
 * side aliased per copy with vi.mock): lib/trash.ts with T1's stored-alias index
 * line removed → E-b T1 ("expected { ok: true, restored: 1, …(4) } to match
 * object"); commit.ts's join writing no alias of the consumed sale → E-b T1 (the
 * same line; E-a, E-b ×2 too); slim-trade.ts without the two fields → E-c T2 ×2
 * ("the preview is the save: expected [ 240, 72.12, 167.88 ] to deeply equal
 * [ 240, 142.92, 97.08 ]", long "[ 240, 72.32, 167.68 ]"); close-trade-dialog.tsx
 * without its two order-count lines → E-c T2 ×2 ("[ 240, 48.52, 191.48 ]");
 * ipo-client.tsx with T3's sold branch and notice reverted → E-f T3 ('Received:
 * "The stored exit date (2026-02-30) could not be read — enter the date. Saved
 * blank, the exit date is cleared."'); app/api/ipos/route.ts with the "already
 * closed on that same date writes nothing new" clause dropped from
 * syncWritesSellDate / syncClosesUndated → E-f T3 ("expected [ 400, { ok: false,
 * …(1) } ] to deeply equal [ 200, …"); the HEAD 3feb22f route → E-f T3 at the
 * cleared field ("expected [ 200, …(1) ] to deeply equal [ 400, …(1) ]" — the
 * holding closed undated) and E-f S4.
 *
 * THE THIRD SEAM FIXES (U1-U3), re-run 3 2026-09-15:
 *
 *  b‴| a restore refusal's remedy, and an    | commit.ts:2381-2407 updateManualTrade (the editor's  | lib/trash.ts:513 holdsClose (U1 b) + :538-539 the    | {ok, restored, message}; importNotes| E-b T1, E-b U1
 *    |   alias held by a re-opened lot       |   re-open: sell 0, sentence dropped, alias kept)     |   no-delete sentence (U1 a) → trash route → panel    |   '|'-joined, sellQty               |
 *  c‴| the order counts in the EDITOR's      | lib/domain/slim-trade.ts:88-89 → edit-trade-dialog   | app/api/charges/preview/route.ts:24-25 ≡ commit.ts   | integers (orders), ₹ figures        | E-c U2
 *    |   preview body                        |   .tsx:48-73 editPreviewBody (U2)                    |   :2330-2331 updateManualTrade (updateTradeAction)   |                                     |
 *  f‴| the linked holding's sell date on     | lib/queries/ipos.ts:111-139 getIposComputed          | ipo-client.tsx:426-515 the input, notice and         | YYYY-MM-DD / null; boolean; text    | E-f U3
 *    |   /ipos' row (linked, linkedSellDate) |   (LEFT JOIN trades) → the RSC payload (JSON)        |   exitDateSent → app/api/ipos/route.ts:203-218       |                                     |
 *
 * RED ON REVERT, the U1-U3 re-run (deleted tests/zzprobe-seamE4-* copies, one side
 * aliased per copy with vi.mock): lib/trash.ts with U1 (a)'s sentence put back to T1's
 * → E-b T1 only ("expected 'Trade #11 (SEAMB) was closed with a t…' to be 'Trade #11
 * (SEAMB) was closed with a s…'"); lib/trash.ts with U1 (b)'s held check dropped → E-b
 * U1 only ("expected [ false, +0, [] ] to deeply equal [ true, 1, [] ]"); commit.ts with
 * H1's sentence drop removed → E-b U1 at the importNotes assertion only (the restore
 * outcome is decided by trash.ts alone: a re-open that kept or dropped the sentence or
 * the alias lands the lot either way); the HEAD 3feb22f commit.ts → E-a, E-b U1, E-c ×4,
 * E-d ×2; edit-trade-dialog.tsx HEAD → E-c U2 only ("the editor's preview is the save:
 * expected [ 240, 48.52, 191.48 ] to deeply equal [ 240, 119.32, 120.68 ]"); slim-trade.ts
 * HEAD → E-c T2 ×2 and U2 (the same line); ipo-client.tsx with U3's helpers put back to
 * T3 → E-f U3 only ("expected '' to be '2026-03-02'"); lib/queries/ipos.ts with the two
 * link fields undefined → E-f U3 only (the same line). The IPO route is unchanged by U3.
 * An E-c option row left open by a failing `it` also reddens E-g's All-accounts union.
 *
 * THE FOURTH SEAM FIXES (V1-V4), re-run 4 2026-09-15:
 *
 *  b⁗| an alias held by a lot re-opened in  | commit.ts updateManualTrade (the editor's re-open,   | lib/trash.ts restore skip + in-transaction alias set;| {ok, restored, skipped}; dupCount;  | E-b V1 ×2
 *    |   the editor (sell 0)                 |   alias kept) → close-open-lots.ts:164 aliasHeld /   |   commit.ts:701 previewParsedFile + :1313 commit     |   added / skipped; the card's pairs |
 *    |                                       |   :175 heldIdentityHashes (the ONE predicate)        |   dedup → trash route → card → close-stale route     |                                     |
 *  c⁗| an omitted closing order count        | settings.defaultSellOrders → close-aggregate.ts      | app/api/charges/preview/route.ts:50-52 ≡ commit.ts   | integers (orders), ₹ figures        | E-c V4
 *    |                                       |   closingCountIsDefault → close-trade-dialog.tsx     |   :1891-1892 closePosition (closeTradeAction,        |                                     |
 *    |                                       |   closePreviewBody; edit-trade-dialog.tsx:64-65      |   positions/close) and :2339 updateManualTrade       |                                     |
 *  c⁵| a stored MTF funded amount of 0       | commit.ts:2351 updateManualTrade (own capital typed) | edit-trade-dialog.tsx:138-139 preview (placeholder) ≡| ₹ (funded, interest, net); 0 ≠ null | E-c V3
 *    |   (all own capital)                   |   → slim-trade wire row (JSON)                       |   commit.ts:2351 save; close-trade-dialog preview ≡  |                                     |
 *    |                                       |                                                      |   commit.ts:1922 closePosition                       |                                     |
 *  f⁗| an UNSOLD IPO's link to a holding     | lib/queries/ipos.ts getIposComputed (linked,         | ipo-client.tsx:429-435 linkedHoldingExitDate (sold   | YYYY-MM-DD / null; the holding's    | E-f V2
 *    |   sold in Trades                      |   linkedSellDate) → RSC JSON; the Trades editor's    |   only) → the save body → app/api/ipos/route.ts:103  |   sell leg; ₹ gross / net           |
 *    |                                       |   sale (commit.ts updateManualTrade)                 |   → ipo-link.ts:193 keepLinkedSellLeg → taxByFy      |                                     |
 *
 * RED ON REVERT, the V1-V4 re-run (deleted tests/zzprobe-seamE5-* copies, one side
 * hand-reverted per copy and aliased with vi.mock; 12 copies, 16 reds, every one on the
 * reverted side's own `it`): lib/trash.ts reading every alias (lotIdentityHashes) → E-b
 * V1 restore ("Restored 0 trades. 1 could not be restored — SEAMBV: an identical trade is
 * already in the journal (recorded in the position it closed). …: expected [ true, +0,
 * [ { id: 15, …(2) } ] ] to deeply equal [ true, 1, [] ]") and E-b U1; commit.ts's two
 * dedup reads → E-b V1 ×2 ("the import preview of the consumed fill: expected 1 to be
 * +0"; "expected [ +0, 1 ] to deeply equal [ 1, +0 ]"); close-open-lots.ts aliasHeld →
 * true → E-b U1 + V1 ×2; the preview route's default back to 1 → E-c V4 ("the editor's
 * preview is its save: expected [ 300, 72.34, 227.66 ] to deeply equal [ 300, 95.94,
 * 204.06 ]"); closePosition without `defaults` → E-c V4 ("the close dialog's save is the
 * editor's: expected [ 300, 72.34, 227.66, 2, 1 ] …"); close-trade-dialog.tsx sending the
 * aggregate's count → E-c V4 ("the close dialog's preview is its save: expected [ 300,
 * 72.34, 227.66 ] …"); updateManualTrade's `> 0` funded read → E-c V3 ("expected [ 8000,
 * 99.2, 1000, 220.92, 779.08 ] to deeply equal [ +0, +0, 1000, 86.32, 913.68 ]");
 * closePosition's → E-c V3 (the same line, the dialog close); edit-trade-dialog.tsx
 * reading a funded 0 as unset → E-c V3 ("the editor's preview is the save: expected
 * [ 1000, 214.72, 785.28 ] to deeply equal [ 1000, 86.32, 913.68 ]"); ipo-client.tsx
 * filling an unsold IPO → E-f V2 ("expected '2026-03-02' to be ''"); the route writing
 * the IPO's patch as it stands, or keepLinkedSellLeg returning it → E-f V2 ("the holding's
 * own sale, as the Trades editor stored it: expected [ true, null, +0, +0, +0, -18.43 ] to
 * deeply equal [ false, '2026-03-02', 10, 1500, …(2) ]").
 *
 * THE FIFTH SEAM FIXES (X1-X2), re-run 5 2026-09-15 — the re-run 4 SEAM DEFECT comments
 * are now these pins (X1 deleted keepLinkedSellLeg, so nothing asserts a recomputed holding):
 *
 *  c⁶| a stored MTF funded 0 across the     | commit.ts:2346 updateManualTrade (own capital typed) | lib/jobs/mtf-accrual.ts:49/:76 (X2) → commit.ts:1922 | ₹ (funded, interest, net); 0 ≠ null | E-c X2 (1)
 *    |   daily accrual job                   |   → trades row                                       |   closePosition ≡ close-trade-dialog.tsx:58 preview  |                                     |
 *  c⁷| own capital typed 0 in the editor     | edit-trade-dialog.tsx:67 editPreviewBody → preview   | app/trades/actions.ts:49/:288 ownCapital (X2) →      | FormData string "0" → number 0      | E-c X2 (2)
 *    |                                       |   route.ts:76 (the preview)                          |   commit.ts:2346 updateManualTrade (the save)        |                                     |
 *  f⁵| a save's effect on a linked holding   | app/api/ipos/route.ts:223 linkedSync → ipo-link.ts   | route.ts:234 409 / :245 sync / :251 message →        | sync | leave | refuse; 409 JSON     | E-f V2, X1 ×3
 *    |   with a sale recorded in Trades      |   :220 linkedSyncFor (X1) ← commit.ts updateManualTrade|   ipo-client.tsx:551 toast; lib/queries/ipos.ts:111/  |   message; ₹ gross / net            |
 *    |                                       |   (the Trades sale)                                  |   :143; trades.ts:467 tradeStatsOf; tax.ts taxByFy   |                                     |
 *
 * RED ON REVERT, the X1-X2 re-run (deleted tests/zzprobe-seamE6-* copies, one side hand-
 * reverted per copy and aliased with vi.mock; 12 copies, every one red on its own `it`):
 * the job's `&& > 0` / `<= 0` read → E-c X2 (1) ("the daily job leaves a stated funded 0":
 * mtfFundedAmount 0 → 8000, mtfInterest 0 → 60.8, netPnl −35.98 → −96.78); closePosition's
 * → V3 + X2 (1) ("expected [ 8000, 99.2, 1000, 220.92, 779.08 ] to deeply equal [ +0, +0,
 * 1000, 86.32, 913.68 ]"); close-trade-dialog.tsx reading a funded 0 as unset → V3 + X2 (1)
 * ("the close dialog's preview is the close: expected [ 1000, 220.92, 779.08 ] …"); the
 * action's `num(...) || null` → X2 (2) ("expected [ 8000, 99.2, 1000, 220.92, 779.08 ] to
 * deeply equal [ 10000, 124, 1000, 245.72, 754.28 ]"); updateManualTrade's `> 0` → X2 (2)
 * (the same line); editPreviewBody's `|| null` and the preview route's `> 0` → X2 (2) ("the
 * editor's preview is the save: expected [ 1000, 220.92, 779.08 ] …"); the route syncing
 * whatever linkedSyncFor answers → V2 ("expected [ true, null, +0, +0, +0, -18.43 ] …") and
 * X1 partial; the route's 409 line removed → X1 partial + X1 quantity ("expected [ 200, …
 * ] to deeply equal [ 409, …"); linkedSyncFor's stored-exit clause removed → X1 cleared
 * ("expected [ 409, …(1) ] to deeply equal [ 200, …(1) ]") and T3; its "leave" → "sync" →
 * V2 + X1 partial; the X1 builder's V2 copies of both files → X1 partial ("the KPI strip
 * …: gross 0 → −400, net −17.4 → −417.4"), X1 quantity ("fy 481.57 → −518.43, gross 500 →
 * −500"), X1 cleared ("expected [ false, '2026-03-02', 10, 1500, …(3) ] to deeply equal
 * [ true, null, +0, +0, +0, 130, 300 ]") and V2's message. The consumers (getIposComputed,
 * getIpoRealisedNet, tradeStatsOf, taxByFy, updateManualTrade's sale) are unchanged by X1.
 *
 * THE WAVE 2I/2J SEAM PASS (2026-09-15) made three edits here and no others —
 * the wave's own file is tests/seams-v43-fixF.test.ts:
 *   1. `M1` (E-d) no longer pastes the sentence: it is BUILT by the real
 *      producer (`detectCrossSourceDuplicates`), so I3's rewrite needs no
 *      re-paste, with I3's three clauses byte-pinned beside it — a revert of
 *      cross-source.ts moves both sides of the equality together, and only the
 *      literals catch that.
 *   2. `dialogPreview`'s fallback is now the 3feb22f body VERBATIM on
 *      `ownCapitalUsed` and `daysHeld` (the 2H re-check's finding: it hard-coded
 *      null / 0, so a whole-module revert reddened the MTF `it`s for the wrong
 *      reason), and the dates come from the same RESOLVED exit date the dialog's
 *      own call site uses — I1 changed that resolution this wave. `editorPreview`'s
 *      fallback was checked expression by expression against 3feb22f and is faithful.
 *   3. Both helpers read their module's exports through the export LIST, so a
 *      whole-module revert reaches the fallback instead of throwing on vitest's
 *      mock proxy ("No \"resolveExitIso\" export is defined on the … mock").
 *
 * SEAM DEFECTS found by a pass are reported to the orchestrator, not fixed here
 * (earlier passes left comments marked SEAM DEFECT; none is open in this file).
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
let positionsClose: typeof import("@/app/api/positions/close/route");
let closeStaleRoute: typeof import("@/app/api/data-quality/close-stale/route");
let trashRoute: typeof import("@/app/api/trash/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let ipoRoute: typeof import("@/app/api/ipos/route");
let accountDelete: typeof import("@/lib/queries/account-delete");
let dqQueries: typeof import("@/lib/queries/data-quality");
let tradeQueries: typeof import("@/lib/queries/trades");
let ipoQueries: typeof import("@/lib/queries/ipos");
let unfetched: typeof import("@/lib/import/dhan-unfetched");
let slim: typeof import("@/lib/domain/slim-trade");
/** Records, so a builder's export that a revert removes fails ITS assertion, not the file. */
let bc: Record<string, unknown> & typeof import("@/components/import/broker-connect");
let ipoUi: Record<string, unknown> & typeof import("@/components/ipo/ipo-client");
let Dialog: typeof import("@/components/ui/dialog").Dialog;
let EditTradeDialog: typeof import("@/components/trades/edit-trade-dialog").EditTradeDialog;
let editDialog: typeof import("@/components/trades/edit-trade-dialog");
let closeDialog: Record<string, unknown> & typeof import("@/components/trades/close-trade-dialog");
let CloseTradeDialog: typeof import("@/components/trades/close-trade-dialog").CloseTradeDialog;
let chargesPreview: typeof import("@/app/api/charges/preview/route");
let tradesPageRoute: typeof import("@/app/api/trades/page/route");
let tradesPage: typeof import("@/lib/queries/trades-page");
let accrueMtfInterest: typeof import("@/lib/jobs/mtf-accrual").accrueMtfInterest;
let StaleLotFix: typeof import("@/components/quality/stale-lot-fix").StaleLotFix;
let StrategiesClient: typeof import("@/components/strategies/strategies-client").StrategiesClient;
let StrategyCard: typeof import("@/components/strategies/strategy-card").StrategyCard;
let strategiesPage: () => unknown;

const A_ACC = 1401; //  E-a
const B_ACC = 1411; //  E-b, the join's snapshot restored
const B2_ACC = 1412; // E-b, the lot restored after its sale
const B3_ACC = 1413; // E-b T1, the lot restored after its sale was joined onto the other lot
const B4_ACC = 1414; // E-b V1, a joined lot re-opened: the join's snapshot restored
const B5_ACC = 1415; // E-b V1, a joined lot re-opened: the sale's fill re-imported
const C_LONG = 1421; // E-c
const C_SHORT = 1422; // E-c
const C_OPT_S = 1423; // E-c T2, a short option closed from several orders
const C_OPT_L = 1424; // E-c T2, a long option closed from several orders
const C_OPT_E = 1425; // E-c U2, a short option covered in the trade editor
const C_OPT_D = 1426; // E-c V4, options exited under a settings order-count default
const C_MTF = 1427; //  E-c V3, MTF rows paid in full from own capital
const C_MTF2 = 1428; // E-c X2, MTF rows through the daily accrual job; own capital typed 0
const D_ONE = 1431; //  E-d
const D_MIX = 1432; //  E-d
const E_S = 1441; //    E-e, merge source (another fact)
const E_T = 1442; //    E-e, merge target
const E_S2 = 1443; //   E-e, merge source (the same fact)
const E_T2 = 1444; //   E-e, merge target
const E_S3 = 1445; //   E-e S3, merge source (the same fact), then the target's own full read
const E_T3 = 1446; //   E-e S3, merge target
const E_S4 = 1447; //   E-e S3, merge source (another fact), then the target's own full read
const E_T4 = 1448; //   E-e S3, merge target
const F_ACC = 1451; //  E-f
const F2_ACC = 1452; // E-f V2, an unsold IPO linked to a holding sold in Trades
const F3_ACC = 1453; // E-f X1, an unsold IPO linked to a holding PARTLY sold in Trades
const F4_ACC = 1454; // E-f X1, the IPO's quantity corrected over a holding sold in Trades
const F5_ACC = 1455; // E-f X1, an IPO sold on /ipos, then its exit cleared
const G_FA = 1461; //   E-g: a company-name holding, no option
const G_FB = 1462; //   E-g: a naked SAMMAANCAP call
const G_RA = 1463; //   E-g: RELIANCE shares, no option
const G_RB = 1464; //   E-g: a naked RELIANCE call
const G_RC = 1465; //   E-g: a RELIANCE covered call
const G_ACCOUNTS = [G_FA, G_FB, G_RA, G_RB, G_RC];

// ONE temp database for this file. Measured locally 2026-09-15 (performance.now()
// around each top-level hook, three runs): migrate + seed + the trade routes
// 1.12-1.25 s; the broker / IPO routes 0.25-0.28 s; the client components
// 0.65-0.71 s; the strategies page import 1.08-1.24 s; its first render
// 0.35-0.46 s. Every `it` 14-153 ms (the S1-S4 re-run, 17 its: 10-87 ms). The raised timeouts are for the Windows
// runner, measured > 15x slower (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("seams-v43-fixE", { seed: true });
  importer = await import("@/lib/import/commit");
  actions = await import("@/app/trades/actions");
  positionsClose = await import("@/app/api/positions/close/route");
  closeStaleRoute = await import("@/app/api/data-quality/close-stale/route");
  trashRoute = await import("@/app/api/trash/route");
  dqQueries = await import("@/lib/queries/data-quality");
  tradeQueries = await import("@/lib/queries/trades");
  slim = await import("@/lib/domain/slim-trade");
  t.db
    .insert(t.schema.accounts)
    .values(
      [A_ACC, B_ACC, B2_ACC, B3_ACC, B4_ACC, B5_ACC, C_LONG, C_SHORT, C_OPT_S, C_OPT_L, C_OPT_E, C_OPT_D, C_MTF, C_MTF2, D_ONE, D_MIX, E_S, E_T, E_S2, E_T2, E_S3, E_T3, E_S4, E_T4, F_ACC, F2_ACC, F3_ACC, F4_ACC, F5_ACC, ...G_ACCOUNTS].map((id) => ({
        id,
        name: `fixE ${id}`,
        isDefault: false,
      })),
    )
    .run();
}, 120_000);
beforeAll(async () => {
  brokerRoute = await import("@/app/api/import/broker/route");
  ipoRoute = await import("@/app/api/ipos/route");
  accountDelete = await import("@/lib/queries/account-delete");
  ipoQueries = await import("@/lib/queries/ipos");
  unfetched = await import("@/lib/import/dhan-unfetched");
  chargesPreview = await import("@/app/api/charges/preview/route");
  tradesPageRoute = await import("@/app/api/trades/page/route");
  tradesPage = await import("@/lib/queries/trades-page");
  ({ accrueMtfInterest } = await import("@/lib/jobs/mtf-accrual"));
}, 120_000);
// The client components, in a hook of their own: a first import + render is a
// one-off cost that belongs in a hook, not in an `it`.
beforeAll(async () => {
  bc = (await import("@/components/import/broker-connect")) as typeof bc;
  ipoUi = (await import("@/components/ipo/ipo-client")) as typeof ipoUi;
  ({ Dialog } = await import("@/components/ui/dialog"));
  editDialog = await import("@/components/trades/edit-trade-dialog");
  ({ EditTradeDialog } = editDialog);
  closeDialog = (await import("@/components/trades/close-trade-dialog")) as typeof closeDialog;
  CloseTradeDialog = closeDialog.CloseTradeDialog;
  ({ StaleLotFix } = await import("@/components/quality/stale-lot-fix"));
}, 120_000);
beforeAll(async () => {
  strategiesPage = (await import("@/app/strategies/page")).default as () => unknown;
  ({ StrategiesClient } = await import("@/components/strategies/strategies-client"));
  ({ StrategyCard } = await import("@/components/strategies/strategy-card"));
}, 120_000);
beforeAll(() => {
  selectAccount(G_FA);
  renderToStaticMarkup(strategiesPage() as React.ReactElement);
  selectAccount(0);
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
const notesOf = (id: number) => (row(id)?.importNotes ?? "").split("|").map((s) => s.trim()).filter(Boolean);
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const textOf = (html: string): string => unescape(html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|"));

const json = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** A module's export, or undefined — never a throw on a build that lacks it. */
const exported = (m: Record<string, unknown>, k: string): unknown => (Object.keys(m).includes(k) ? m[k] : undefined);

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
  const res = importer.commitParsedFile(parsed([tr]), `fixE-${accountId}-${sym}-${side}-${day}-${qty}`, null, accountId);
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
/** The trade editor's form as it opens on this trade, with the user's changes typed in. */
function editorForm(accountId: number, id: number, typed: Record<string, string>) {
  const html = renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(EditTradeDialog, { trade: wireTrade(accountId, id), onDone: () => {} })));
  const fd = formOf(html);
  for (const [k, v] of Object.entries(typed)) fd.set(k, v);
  return fd;
}
/** The Trades close dialog's form as it opens on this trade (exit date defaults to today, IST), price typed in. */
function closeDialogForm(accountId: number, id: number, exitPrice: string) {
  const html = renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(CloseTradeDialog, { trade: wireTrade(accountId, id), onDone: () => {} })));
  const fd = formOf(html);
  fd.set("exitPrice", exitPrice);
  return { fd, html };
}
const NO_STATE = { ok: false, message: "" };

type WireTrade = ReturnType<typeof wireTrade>;
/**
 * The Trades close dialog's live preview: the /api/charges/preview request its
 * effect sends (close-trade-dialog.tsx:91-103 — the dates are decided at that call
 * site, R56: the exit on the covering side), handed to the real route over JSON,
 * and the [gross, charges, net] the dialog prints from the answer. A build without
 * S1's `closePreviewBody` sends the body its effect built inline — the preview
 * that build shows, not a tolerance.
 */
async function dialogPreview(trade: WireTrade, exitPrice: number, exitDate: string): Promise<number[]> {
  const isShort = trade.sellQty > trade.buyQty;
  // The dialog's OWN call site decides the dates from the RESOLVED exit date
  // (close-trade-dialog.tsx:117 `resolveExitIso`, I1 [1]). A build without that
  // export resolves as 3feb22f did — `exitDate || todayIstIso()`.
  // Read through the export LIST: a module without the export must not throw
  // here (vitest's mock proxy throws on an unknown key, which would redden the
  // `it` before the pre-2H body below could answer for that build).
  const resolveFn = exported(closeDialog, "resolveExitIso") as ((d: string) => string) | undefined;
  const previewFn = exported(closeDialog, "closePreviewBody") as typeof closeDialog.closePreviewBody | undefined;
  const exitIso = typeof resolveFn === "function" ? resolveFn(exitDate) : exitDate || todayIstIso();
  const dates = { buyDate: isShort ? exitIso : trade.buyDate, sellDate: isShort ? trade.sellDate : exitIso };
  let body: unknown;
  if (typeof previewFn === "function") {
    body = previewFn(trade, exitPrice, exitDate, dates);
  } else {
    // THE PRE-2H BODY, VERBATIM (git show 3feb22f:components/trades/close-trade-dialog.tsx
    // :47-83 — the effect built it inline, so a whole-module revert has no export to
    // call and this stands in for it). It must be FAITHFUL, not merely different:
    // the 2H re-check found `ownCapitalUsed: null, daysHeld: 0` here, which reddened
    // the MTF `it`s for the wrong reason (the real pre-2H dialog sent own capital
    // 10,000 on a funded-0 row and MATCHED its save). `daysHeld` reads the RAW field,
    // which is exactly the I1 [1] defect: a cleared date gives NaN → JSON null → the
    // route bills 0 days.
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
  const res = await chargesPreview.POST(json("/api/charges/preview", body));
  const p = (await res.json()) as { grossPnl: number; netPnl: number; breakdown: { total: number } };
  expect(res.status, JSON.stringify(p)).toBe(200);
  return [p.grossPnl, p.breakdown.total, p.netPnl];
}

/**
 * The trade editor's live preview (edit-trade-dialog.tsx:176-207): the typed legs
 * as its effect reads them out of the form it prints, the body U2's
 * `editPreviewBody` builds, handed to the real route over JSON, and the [gross,
 * charges, net] the dialog prints. A build without U2's helper sends the body its
 * effect built inline (no order counts) — the preview that build shows. A non-MTF
 * row sends null own capital. An MTF row sends the typed figure, else the dialog's
 * own "currently ≈" guess (edit-trade-dialog.tsx:139, read off the placeholder it
 * prints — whole rupees, so MTF fixtures here use round figures).
 */
async function editorPreview(trade: WireTrade, fd: FormData): Promise<number[]> {
  const n = (k: string) => Number(String(fd.get(k) ?? "")) || 0;
  let ownCapitalUsed: number | null = null;
  if (trade.segment === "eq_mtf") {
    const typed = String(fd.get("ownCapitalUsed") ?? "");
    if (typed !== "") ownCapitalUsed = Number(typed);
    else {
      const html = renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(EditTradeDialog, { trade, onDone: () => {} })));
      const tag = (html.match(/<input\b[^>]*name="ownCapitalUsed"[^>]*>/) ?? [""])[0];
      const placeholder = unescape(/\bplaceholder="([^"]*)"/.exec(tag)?.[1] ?? "");
      if (!placeholder) throw new Error("the editor renders no own-capital input for an MTF row");
      const guess = /currently ≈ ([\d,]+)/.exec(placeholder)?.[1];
      ownCapitalUsed = guess ? Number(guess.replace(/,/g, "")) : 0;
    }
  }
  const f = {
    buyQty: n("buyQty"), avgBuyPrice: n("avgBuyPrice"), sellQty: n("sellQty"), avgSellPrice: n("avgSellPrice"),
    ownCapitalUsed, buyDate: String(fd.get("buyDate") ?? "") || null, sellDate: String(fd.get("sellDate") ?? "") || null,
  };
  // Read through the export list: a module without the export must not throw here.
  const helper = Object.keys(editDialog).includes("editPreviewBody") ? (editDialog as unknown as Record<string, unknown>).editPreviewBody : undefined;
  let body: unknown;
  if (typeof helper === "function") {
    body = (helper as (t: WireTrade, fields: typeof f) => unknown)(trade, f);
  } else {
    // THE PRE-2H BODY, VERBATIM (git show 3feb22f:components/trades/edit-trade-dialog.tsx
    // :147-164). Checked expression by expression against that text on 2026-09-15 for the
    // two fields the 2H re-check flagged on the dialog's fallback: `ownCapitalUsed` is
    // pre-2H's `ownCapitalUsed !== "" ? Number(...) : isMtf ? currentOwnCapitalGuess : null`
    // — `f.ownCapitalUsed` above is the typed value, else the guess READ OFF THE MODULE'S
    // OWN rendered placeholder (so a reverted module supplies its own guess), else null;
    // `daysHeld` is pre-2H's sellDate−buyDate on a closed row, 0 otherwise. No order counts
    // (U2 added them), gross unrounded.
    const isOpen = f.buyQty !== f.sellQty;
    body = {
      broker: trade.broker, tradingsymbol: trade.tradingsymbol, segment: trade.segment, exchange: trade.exchange,
      buyValue: f.buyQty * f.avgBuyPrice, sellValue: f.sellQty * f.avgSellPrice, buyQty: f.buyQty, sellQty: f.sellQty,
      grossPnl: !isOpen ? f.sellQty * f.avgSellPrice - f.buyQty * f.avgBuyPrice : 0, ownCapitalUsed: f.ownCapitalUsed,
      daysHeld: !isOpen && f.buyDate && f.sellDate ? Math.max(0, Math.floor((new Date(f.sellDate).getTime() - new Date(f.buyDate).getTime()) / 86400000)) : 0,
      isOpen, buyDate: f.buyDate, sellDate: f.sellDate,
    };
  }
  const res = await chargesPreview.POST(json("/api/charges/preview", JSON.parse(JSON.stringify(body))));
  const p = (await res.json()) as { grossPnl: number; netPnl: number; breakdown: { total: number } };
  expect(res.status, JSON.stringify(p)).toBe(200);
  return [p.grossPnl, p.breakdown.total, p.netPnl];
}

const closeStale = async (body: { lotId: number; saleId: number; exitDate: string }) => {
  const res = await closeStaleRoute.POST(json("/api/data-quality/close-stale", body));
  return { status: res.status, json: (await res.json()) as { ok: boolean; code?: string; message: string } };
};
/** The Data Quality card as the page reads it, and whether it offers the one-click button. */
function dqCard(accountId: number) {
  selectAccount(accountId);
  const s = dqQueries.getStaleOpenSection();
  const html = renderToStaticMarkup(React.createElement(StaleLotFix, s));
  return {
    pairs: s.pairs.map((p) => [p.lotId, p.saleId, p.oneClick, p.ambiguous, p.closedLotIds]),
    sales: s.sales.length,
    buttons: textOf(html).split("Close with the recorded sale").length - 1,
  };
}

// ============================================================================
// E-a — H1's join-sentence drop ↔ H3's exemption ↔ the card ↔ the route
// ============================================================================

describe("E-a · a Data Quality join re-made through the trade editor and the Positions close (edit dialog → action → H1 → H3 listing → card → close-stale route)", () => {
  const SYM = "SEAMA";
  let L1: ReturnType<typeof row> & object;
  let S1: ReturnType<typeof row> & object;
  let L2: ReturnType<typeof row> & object;
  let S2: ReturnType<typeof row> & object;

  it("the card's join of [L1 100 @200, S1 100 @250]; a sibling [L2 30 @210, S2 30 @258] stays one-click, and a notes-only save from the editor keeps it so", async () => {
    L1 = commitFill(A_ACC, SYM, "BUY", 100, 200, "2026-08-20");
    S1 = commitFill(A_ACC, SYM, "SELL", 100, 250, "2026-08-25");
    selectAccount(A_ACC);
    const join = await closeStale({ lotId: L1.id, saleId: S1.id, exitDate: "2026-08-25" });
    expect([join.status, join.json.ok], join.json.message).toEqual([200, true]);
    L2 = commitFill(A_ACC, SYM, "BUY", 30, 210, "2026-08-22");
    S2 = commitFill(A_ACC, SYM, "SELL", 30, 258, "2026-08-27");
    expect(dqCard(A_ACC)).toMatchObject({ pairs: [[L2.id, S2.id, true, false, []]], buttons: 1 });

    // The editor opened on the joined lot, only the notes typed: the form posts
    // every field back, and none of the exit leg's values moved.
    const saved = await actions.updateTradeAction(NO_STATE, editorForm(A_ACC, L1.id, { notes: "journal only" }));
    expect(saved.ok, saved.message).toBe(true);
    expect(row(L1.id)?.notes).toBe("journal only");
    // THE assertion: the listing still offers the sibling one-click (a false
    // drop of the sentence would turn it into review-only).
    expect(dqCard(A_ACC)).toMatchObject({ pairs: [[L2.id, S2.id, true, false, []]], buttons: 1 });
    expect(notesOf(L1.id)).toEqual(expect.arrayContaining([STALE_CLOSE_NOTE, `dedup-alias:${S1.dedupHash}`]));
  });

  it("the editor re-opens L1 (sell 60) and the Positions close route closes it @255: the card offers no button and the route answers 409 AMBIGUOUS", async () => {
    const reopened = await actions.updateTradeAction(NO_STATE, editorForm(A_ACC, L1.id, { sellQty: "60" }));
    expect(reopened.ok, reopened.message).toBe(true);
    // The risk cockpit's CloseDialog posts its input state: exitPrice is a string.
    const res = await positionsClose.POST(json("/api/positions/close", { tradeId: L1.id, exitPrice: "255", exitDate: "2026-08-26" }));
    expect(res.status).toBe(200);

    // THE assertions (on revert of commit.ts: the sentence stays on L1, H3
    // exempts it, and the card lists [L2, S2] one-click again — a sibling sale
    // offered for a join beside a close nobody can vouch for).
    expect(dqCard(A_ACC)).toMatchObject({ pairs: [[L2.id, S2.id, false, true, [L1.id]]], buttons: 0 });
    const refused = await closeStale({ lotId: L2.id, saleId: S2.id, exitDate: "2026-08-27" });
    expect([refused.status, refused.json.code], refused.json.message).toEqual([409, "AMBIGUOUS"]);
    expect(notesOf(L1.id)).not.toContain(STALE_CLOSE_NOTE);
    expect(notesOf(L1.id), "the alias is identity and survives").toContain(`dedup-alias:${S1.dedupHash}`);
    expect(rowsOf(A_ACC).map((r) => [r.id, r.isOpen])).toEqual([
      [L1.id, false],
      [L2.id, true],
      [S2.id, true],
    ]);
  });
});

// ============================================================================
// E-b — the join's Trash snapshot ↔ H3's restore skip ↔ H3's listing ↔ the route
// ============================================================================

describe("E-b · the sale a Data Quality join consumed, back from Deleted items (close-stale → trash route → H3 restore → H3 listing → card → route)", () => {
  const SYM = "SEAMB";
  const trashList = async () => ((await (await trashRoute.GET()).json()) as { snapshots: { id: string; reason: string }[] }).snapshots;
  const restore = async (id: string) =>
    (await (await trashRoute.POST(json("/api/trash", { action: "restore", id }))).json()) as {
      ok: boolean;
      restored: number;
      skipped: { id: number; symbol: string; reason: string }[];
      message: string;
    };
  /** T1's book, for the U1 re-open that follows it. */
  let b3: { L1: number; L2: number; saleHash: string; lotSnap: string } | undefined;

  it("restoring the join's snapshot skips the sale: the card lists nothing, raises no stale sale, and the route finds no sale to join", async () => {
    const L1 = commitFill(B_ACC, SYM, "BUY", 100, 200, "2026-08-20");
    const L2 = commitFill(B_ACC, SYM, "BUY", 100, 210, "2026-08-21");
    const S1 = commitFill(B_ACC, SYM, "SELL", 100, 250, "2026-08-25");
    selectAccount(B_ACC);
    const join = await closeStale({ lotId: L1.id, saleId: S1.id, exitDate: "2026-08-25" });
    expect([join.status, join.json.ok], join.json.message).toEqual([200, true]);
    const snap = (await trashList()).find((s) => s.reason.includes(`#${L1.id}`));
    if (!snap) throw new Error("the join left no Deleted-items snapshot naming its lot");

    const res = await restore(snap.id);
    // THE assertions (on revert of lib/trash.ts: restored 1, and the card lists
    // [L2, S1] — the sale L1's close already holds, offered again).
    expect([res.restored, res.skipped.map((s) => [s.id, s.symbol])]).toEqual([0, [[S1.id, SYM]]]);
    expect(res.message).toContain(`${SYM}: an identical trade is already in the journal (recorded in the position it closed)`);
    expect(dqCard(B_ACC)).toEqual({ pairs: [], sales: 0, buttons: 0 });
    expect(dqQueries.getDataQualityReport().issues.filter((i) => i.code.startsWith("stale_")).map((i) => i.code)).toEqual([]);
    const refused = await closeStale({ lotId: L2.id, saleId: S1.id, exitDate: "2026-08-25" });
    expect([refused.status, refused.json.code]).toEqual([404, "NOT_FOUND"]);
    expect(rowsOf(B_ACC).map((r) => [r.id, r.isOpen, r.sellQty])).toEqual([
      [L1.id, false, 100],
      [L2.id, true, 0],
    ]);
  });

  it("the joined lot deleted, its sale restored, then the lot restored: the restore REFUSES and names the sale (S2); the path it names — delete that row, restore again — puts the lot back and never the sale", async () => {
    const L1 = commitFill(B2_ACC, SYM, "BUY", 100, 200, "2026-08-20");
    const L2 = commitFill(B2_ACC, SYM, "BUY", 100, 210, "2026-08-21");
    const S1 = commitFill(B2_ACC, SYM, "SELL", 100, 250, "2026-08-25");
    selectAccount(B2_ACC);
    expect((await closeStale({ lotId: L1.id, saleId: S1.id, exitDate: "2026-08-25" })).status).toBe(200);
    const joinSnap = (await trashList()).find((s) => s.reason.includes(`#${L1.id}`))!;

    const del = new FormData();
    del.set("ids", String(L1.id));
    del.set("reason", "fixE b2: the joined lot deleted");
    expect((await actions.deleteTradesAction(NO_STATE, del)).ok).toBe(true);
    const lotSnap = (await trashList()).find((s) => s.reason.includes("fixE b2"))!;

    // With the lot gone nothing records the sale: it comes back, and the held lot may take it.
    expect((await restore(joinSnap.id)).restored).toBe(1);
    expect(dqCard(B2_ACC)).toMatchObject({ pairs: [[L2.id, S1.id, true, false, []]], buttons: 1 });

    // THE assertions (on revert of S2 in lib/trash.ts: ok, restored 1 — the lot
    // whose close IS S1 lands beside S1, one sale on two rows). The body is what
    // the Deleted-items panel toasts (deleted-items-panel.tsx:69 data.message).
    const refusedRestore = await restore(lotSnap.id);
    expect(refusedRestore).toMatchObject({ ok: false, restored: 0, skipped: [] });
    expect(refusedRestore.message).toBe(
      `Trade #${L1.id} (${SYM}) was closed with a sale that is back in the journal (trade #${S1.id}, ${SYM}) — ` +
        "restoring it would count that sale twice. Delete that row, then restore. Nothing was changed.",
    );
    expect((await trashList()).some((s) => s.id === lotSnap.id), "the refused snapshot stays listed").toBe(true);
    expect(rowsOf(B2_ACC).map((r) => [r.id, r.isOpen, r.sellQty])).toEqual([
      [L2.id, true, 0],
      [S1.id, true, 100],
    ]);
    expect(dqCard(B2_ACC)).toMatchObject({ pairs: [[L2.id, S1.id, true, false, []]], buttons: 1 });

    // The path the sentence names, through the same Trades delete and the same route.
    const delSale = new FormData();
    delSale.set("ids", String(S1.id));
    delSale.set("reason", "fixE b2: the sale the refusal named");
    expect((await actions.deleteTradesAction(NO_STATE, delSale)).ok).toBe(true);
    const saleSnap = (await trashList()).find((s) => s.reason.includes("the sale the refusal named"))!;
    expect(await restore(lotSnap.id)).toMatchObject({ ok: true, restored: 1, skipped: [] });
    expect(rowsOf(B2_ACC).map((r) => [r.id, r.isOpen, r.sellQty, r.sellValue, r.grossPnl])).toEqual([
      [L1.id, false, 100, 25000, 5000],
      [L2.id, true, 0, 0, 0],
    ]);
    // And the sale's own snapshot, restored after: H3's skip (on revert of H3's
    // in-loop skip: restored 1, S1 open beside the lot that holds it).
    const back = await restore(saleSnap.id);
    expect([back.restored, back.skipped.map((s) => [s.id, s.symbol])]).toEqual([0, [[S1.id, SYM]]]);
    expect(dqCard(B2_ACC)).toEqual({ pairs: [], sales: 0, buttons: 0 });
  });

  it("T1 · the joined lot deleted, its sale restored and JOINED onto the other lot from the card's one click: the lot's restore REFUSES naming the lot that now records that sale — one ₹25,000 sale realised once", async () => {
    const L1 = commitFill(B3_ACC, SYM, "BUY", 100, 200, "2026-08-20");
    const L2 = commitFill(B3_ACC, SYM, "BUY", 100, 210, "2026-08-21");
    const S1 = commitFill(B3_ACC, SYM, "SELL", 100, 250, "2026-08-25");
    selectAccount(B3_ACC);
    expect((await closeStale({ lotId: L1.id, saleId: S1.id, exitDate: "2026-08-25" })).status).toBe(200);
    const joinSnap = (await trashList()).find((s) => s.reason.includes(`#${L1.id}`))!;
    const del = new FormData();
    del.set("ids", String(L1.id));
    del.set("reason", "fixE b3: the joined lot deleted");
    expect((await actions.deleteTradesAction(NO_STATE, del)).ok).toBe(true);
    const lotSnap = (await trashList()).find((s) => s.reason.includes("fixE b3"))!;
    expect((await restore(joinSnap.id)).restored).toBe(1);

    // The one click the card offers beside the restored sale, through the same route.
    expect(dqCard(B3_ACC)).toMatchObject({ pairs: [[L2.id, S1.id, true, false, []]], buttons: 1 });
    const joined = await closeStale({ lotId: L2.id, saleId: S1.id, exitDate: "2026-08-25" });
    expect([joined.status, joined.json.ok], joined.json.message).toEqual([200, true]);
    b3 = { L1: L1.id, L2: L2.id, saleHash: S1.dedupHash, lotSnap: lotSnap.id };

    // THE assertions (on revert of T1 in lib/trash.ts — the stored index over own
    // hashes only: {ok: true, restored: 1}, L1 closed 100/100 for ₹25,000 beside
    // L2 closed on the same sale, and FY 2026-27 realises it over 2 trades; on a
    // join that keeps no alias of the sale it consumed: the same double count).
    // The body is what the Deleted-items panel toasts (deleted-items-panel.tsx:69).
    const refused = await restore(lotSnap.id);
    expect(refused).toMatchObject({ ok: false, restored: 0, skipped: [] });
    // U1 (a): the holder is a LOT carrying its own purchase, so the sentence names
    // no delete (on revert of U1: "… Delete that row, then restore." — the remedy
    // that, followed, lost L2's 100 @210 through both restores).
    expect(refused.message).toBe(
      `Trade #${L1.id} (${SYM}) was closed with a sale that trade #${L2.id} (${SYM}) already records, ` +
        "so restoring it would count that sale twice. Nothing was changed; this entry stays in Deleted items.",
    );
    expect(refused.message).not.toMatch(/\bdelete\b/i);
    expect((await trashList()).some((s) => s.id === lotSnap.id), "the refused snapshot stays listed").toBe(true);
    expect(rowsOf(B3_ACC).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty, r.sellValue, r.grossPnl])).toEqual([[L2.id, false, 100, 100, 25000, 4000]]);
    selectAccount(B3_ACC);
    expect(taxByFy(taxRowsOf(tradeQueries.getJournalTrades())).map((s) => [s.fy, s.trades, s.totalRealised])).toEqual([["2026-27", 1, row(L2.id)!.netPnl]]);
    expect(dqCard(B3_ACC)).toEqual({ pairs: [], sales: 0, buttons: 0 });
  });

  it("U1 · the lot that took the sale re-opened in the trade editor (sell 0, the alias kept): the lot's restore the T1 refusal kept now lands — the ₹25,000 sale realised once, on the restored lot, and L2's purchase of 100 @210 open", async () => {
    if (!b3) throw new Error("T1 did not leave its book");
    const { L1, L2, saleHash, lotSnap } = b3;
    // The editor opened on #L2 as /trades ships it, the exit leg cleared.
    const reopened = await actions.updateTradeAction(NO_STATE, editorForm(B3_ACC, L2, { sellQty: "0", avgSellPrice: "0", sellDate: "" }));
    expect([reopened.ok, reopened.message]).toEqual([true, "Trade updated."]);
    // H1's write the restore reads: the sentence gone, the alias kept (identity for re-import).
    expect(notesOf(L2)).toContain(`dedup-alias:${saleHash}`);
    expect(notesOf(L2)).not.toContain(STALE_CLOSE_NOTE);

    // THE assertions (on revert of U1 (b) in lib/trash.ts — an alias held whatever
    // its holder closes: {ok: false, restored: 0}, "… trade #L2 already records"
    // the sale #L2 no longer records, and L1's purchase stays in Deleted items).
    const back = await restore(lotSnap);
    expect([back.ok, back.restored, back.skipped], back.message).toEqual([true, 1, []]);
    expect(rowsOf(B3_ACC).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty, r.sellValue, r.grossPnl])).toEqual([
      [L1, false, 100, 100, 25000, 5000],
      [L2, true, 100, 0, 0, 0],
    ]);
    selectAccount(B3_ACC);
    expect(taxByFy(taxRowsOf(tradeQueries.getJournalTrades())).map((s) => [s.fy, s.trades, s.totalRealised])).toEqual([["2026-27", 1, row(L1)!.netPnl]]);
    expect(dqCard(B3_ACC)).toEqual({ pairs: [], sales: 0, buttons: 0 });
    // The SALE direction of the same rule (the re-run 3 seam defect) is V1's, below.
  });

  /** The Dhan sale fill the join consumed, as the importer parses it again. */
  const saleFile = (sym: string) => parsed([trade({ tradingsymbol: sym, sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-25" })]);
  /** A lot joined with its sale from the card's one click, then re-opened in the trade editor (sell 0, the alias kept). */
  async function joinedThenReopened(accountId: number, sym: string) {
    const L = commitFill(accountId, sym, "BUY", 100, 200, "2026-08-20");
    const S = commitFill(accountId, sym, "SELL", 100, 250, "2026-08-25");
    selectAccount(accountId);
    expect(dqCard(accountId)).toMatchObject({ pairs: [[L.id, S.id, true, false, []]], buttons: 1 });
    const join = await closeStale({ lotId: L.id, saleId: S.id, exitDate: "2026-08-25" });
    expect([join.status, join.json.ok], join.json.message).toEqual([200, true]);
    const joinSnap = (await trashList()).find((s) => s.reason.includes(`#${L.id}`));
    if (!joinSnap) throw new Error("the join left no Deleted-items snapshot naming its lot");
    const reopened = await actions.updateTradeAction(NO_STATE, editorForm(accountId, L.id, { sellQty: "0", avgSellPrice: "0", sellDate: "" }));
    expect([reopened.ok, reopened.message]).toEqual([true, "Trade updated."]);
    expect(notesOf(L.id)).toContain(`dedup-alias:${S.dedupHash}`);
    expect(rowsOf(accountId).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty])).toEqual([[L.id, true, 100, 0]]);
    return { L: L.id, S: S.id, saleHash: S.dedupHash, joinSnap: joinSnap.id };
  }

  it("V1 · a lot joined with its sale from the card, then re-opened in the trade editor (sell 0, the alias kept): the import preview no longer calls the sale a duplicate, restoring the join's snapshot brings the ₹25,000 sale back, the card offers the join again, and the re-join realises it once", async () => {
    const SYM = "SEAMBV";
    const { L, S, joinSnap } = await joinedThenReopened(B4_ACC, SYM);

    // THE assertions (on revert of lib/trash.ts's alias reads to every alias the lot
    // carries: {ok: true, restored: 0, skipped: [S, "… recorded in the position it
    // closed"]} — the sale on no row; on revert of commit.ts's dedup reads: the
    // preview counts the fill a duplicate).
    expect(importer.previewParsedFile(saleFile(SYM), null, B4_ACC).summary.dupCount, "the import preview of the consumed fill").toBe(0);
    const back = await restore(joinSnap);
    expect([back.ok, back.restored, back.skipped], back.message).toEqual([true, 1, []]);
    expect(rowsOf(B4_ACC).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty, r.sellValue])).toEqual([
      [L, true, 100, 0, 0],
      [S, true, 0, 100, 25000],
    ]);
    expect(dqCard(B4_ACC)).toMatchObject({ pairs: [[L, S, true, false, []]], buttons: 1 });

    const rejoined = await closeStale({ lotId: L, saleId: S, exitDate: "2026-08-25" });
    expect([rejoined.status, rejoined.json.ok], rejoined.json.message).toEqual([200, true]);
    expect(rowsOf(B4_ACC).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty, r.sellValue, r.grossPnl])).toEqual([[L, false, 100, 100, 25000, 5000]]);
    selectAccount(B4_ACC);
    expect(taxByFy(taxRowsOf(tradeQueries.getJournalTrades())).map((s) => [s.fy, s.trades, s.totalRealised])).toEqual([["2026-27", 1, row(L)!.netPnl]]);
    // Closed on the sale again, the lot records it again: the preview dedupes the fill.
    expect(importer.previewParsedFile(saleFile(SYM), null, B4_ACC).summary.dupCount).toBe(1);
  });

  it("V1 · the other recovery path: the same re-opened lot, the consumed fill re-imported — it is added, the card offers the join, and the join realises it once", async () => {
    const SYM = "SEAMBW";
    const { L } = await joinedThenReopened(B5_ACC, SYM);

    // THE assertions (on revert of commit.ts's dedup reads, or of the one predicate
    // in close-open-lots.ts: added 0 / skipped 1 — the sale unrecoverable).
    const again = importer.commitParsedFile(saleFile(SYM), `fixE-${B5_ACC}-${SYM}-again`, null, B5_ACC);
    expect([again.added, again.skipped]).toEqual([1, 0]);
    const S2 = rowsOf(B5_ACC).at(-1)!;
    expect([S2.sellQty, S2.sellValue, S2.isOpen]).toEqual([100, 25000, true]);
    expect(dqCard(B5_ACC)).toMatchObject({ pairs: [[L, S2.id, true, false, []]], buttons: 1 });
    const joined = await closeStale({ lotId: L, saleId: S2.id, exitDate: "2026-08-25" });
    expect([joined.status, joined.json.ok], joined.json.message).toEqual([200, true]);
    expect(rowsOf(B5_ACC).map((r) => [r.id, r.isOpen, r.sellQty, r.sellValue, r.grossPnl])).toEqual([[L, false, 100, 25000, 5000]]);
  });
});

// ============================================================================
// E-c — H1's partial-close aggregate ↔ the /trades KPI strip and tax-by-FY
// ============================================================================

describe("E-c · a partly closed position closed from the Trades dialog and from the Positions route (H1 closePosition → getJournalTrades → tradeStatsOf / taxByFy)", () => {
  it("long: bought 100 @200, the editor sells 60 @250, the Trades close dialog opened at 00:30 IST on 1 Apr sells the rest @255 — one row, gross +5,200, in FY 2026-27 only", async () => {
    const L = commitFill(C_LONG, "SEAMC", "BUY", 100, 200, "2026-03-02");
    const part = await actions.updateTradeAction(NO_STATE, editorForm(C_LONG, L.id, { sellQty: "60", avgSellPrice: "250", sellDate: "2026-03-20" }));
    expect(part.ok, part.message).toBe(true);
    expect(taxByFy(taxRowsOf(tradeQueries.getJournalTrades())), "an open row realises nothing in the tax report").toEqual([]);

    freezeAt("2026-03-31T19:00:00.000Z"); // 2026-04-01 00:30 IST
    const { fd, html } = closeDialogForm(C_LONG, L.id, "255");
    expect(textOf(html)).toContain("Long 40 @ 200");
    expect(fd.get("exitDate"), "the dialog's default exit day is the IST day").toBe("2026-04-01");
    // The live preview the same dialog shows before the click (S1), from the same wire row.
    const shown = await dialogPreview(wireTrade(C_LONG, L.id), 255, String(fd.get("exitDate")));
    const closed = await actions.closeTradeAction(NO_STATE, fd);
    expect(closed.ok, closed.message).toBe(true);

    selectAccount(C_LONG);
    const journal = tradeQueries.getJournalTrades();
    const stats = tradeQueries.tradeStatsOf(journal);
    const r = row(L.id)!;
    // THE assertions (on revert of commit.ts: 100 / 40, sellValue 10,200, and
    // the KPI strip and the tax report both print gross −9,800).
    expect([r.buyQty, r.sellQty, r.sellValue, r.avgSellPrice, r.sellDate]).toEqual([100, 100, 25200, 252, "2026-04-01"]);
    // THE preview assertion (on revert of close-trade-dialog.tsx: the pre-H1
    // body, sell 40 for ₹10,200 — gross 2,200 / charges 48.88 / net 2,151.12).
    expect(shown, "the preview is the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
    expect(shown).toEqual([5200, 64.45, 5135.55]);
    expect([stats.count, stats.open, stats.gross, stats.net, stats.charges]).toEqual([1, 0, 5200, r.netPnl, r.chargesTotal]);
    expect(stats.net).toBe(Math.round((5200 - r.chargesTotal) * 100) / 100);
    const fy = taxByFy(taxRowsOf(journal));
    // v4.5.0: `stcg` is gone from FySummary. This row is an equity SHARE bought
    // and sold inside one month, so it is s.111A short-term, and it carries no
    // STT/MTF field in this fixture — the figure is unchanged at r.netPnl.
    expect(fy.map((s) => [s.fy, s.stcg111A, s.totalRealised, s.trades])).toEqual([["2026-27", r.netPnl, r.netPnl, 1]]);
  });

  it("short mirror: sold 100 @250, the editor covers 60 @200, the risk cockpit's close route covers the rest @195 — buy 100 for 19,800, gross +5,200, no second row", async () => {
    const S = commitFill(C_SHORT, "SEAMCS", "SELL", 100, 250, "2026-08-20");
    const part = await actions.updateTradeAction(NO_STATE, editorForm(C_SHORT, S.id, { buyQty: "60", avgBuyPrice: "200", buyDate: "2026-08-25" }));
    expect(part.ok, part.message).toBe(true);
    // The Trades dialog's preview of the same cover, then the risk cockpit's close of it.
    const shown = await dialogPreview(wireTrade(C_SHORT, S.id), 195, "2026-08-26");
    const res = await positionsClose.POST(json("/api/positions/close", { tradeId: S.id, exitPrice: "195", exitDate: "2026-08-26" }));
    expect(res.status).toBe(200);

    selectAccount(C_SHORT);
    const stats = tradeQueries.tradeStatsOf(tradeQueries.getJournalTrades());
    const r = row(S.id)!;
    expect([r.buyQty, r.buyValue, r.avgBuyPrice, r.buyDate, r.sellQty, r.sellValue]).toEqual([100, 19800, 198, "2026-08-26", 100, 25000]);
    expect([stats.count, stats.open, stats.gross, stats.net]).toEqual([1, 0, 5200, r.netPnl]);
    // On revert of the dialog: buy 40 for ₹7,800, gross 2,200.
    expect(shown, "the preview is the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
    expect(shown[0]).toBe(5200);
  });

  /** A Dhan stock option row as its fills stored it, order counts included. */
  const optionRow = (accountId: number, sym: string, legs: Record<string, unknown>) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId, broker: "dhan", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NSE",
          symbol: sym, tradingsymbol: `${sym}100CESEP26`, optionType: "CE", strike: 100, expiry: "2026-09-24", isOpen: true, ...legs,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
  /** The row as the /trades table holds it after a filter change or a scroll: GET /api/trades/page over JSON. */
  async function pageRouteWire(accountId: number, id: number): Promise<WireTrade> {
    selectAccount(accountId);
    const res = await tradesPageRoute.GET(new Request("http://localhost/api/trades/page?view=all"));
    const j = (await res.json()) as { rows: WireTrade[] };
    const r = j.rows.find((x) => x.id === id);
    if (!r) throw new Error(`/api/trades/page lists no trade ${id} in account ${accountId}`);
    return r;
  }
  /** The row as /trades' first render ships it (app/trades/page.tsx: getTradesPage(filters).rows.map(toSlimTrade)), over the RSC payload's JSON. */
  function firstPageWire(accountId: number, id: number): WireTrade {
    selectAccount(accountId);
    const filters = { q: "", broker: "", segment: "", bucket: "", view: "all", realised: false, basisUnknown: false, from: "", to: "" } as Parameters<typeof tradesPage.getTradesPage>[0];
    const r = tradesPage.getTradesPage(filters).rows.map(slim.toSlimTrade).find((x) => x.id === id);
    if (!r) throw new Error(`/trades' first page lists no trade ${id} in account ${accountId}`);
    return JSON.parse(JSON.stringify(r)) as WireTrade;
  }

  it("T2 · short: a Dhan stock option sold 100 @5 in 2 orders, 60 covered @3 in 3 orders; the Trades close dialog opened on 8 Sep covers the rest @2 — its preview bills the stored 4 buy / 2 sell orders, the save's figures", async () => {
    const id = optionRow(C_OPT_S, "SEAMCO", {
      sellQty: 100, avgSellPrice: 5, sellValue: 500, sellDate: "2026-09-01", sellOrderCount: 2,
      buyQty: 60, avgBuyPrice: 3, buyValue: 180, buyDate: "2026-09-03", buyOrderCount: 3,
    });
    freezeAt("2026-09-08T06:30:00.000Z"); // 12:00 IST
    const { fd } = closeDialogForm(C_OPT_S, id, "2");
    expect(fd.get("exitDate")).toBe("2026-09-08");
    const shown = await dialogPreview(wireTrade(C_OPT_S, id), 2, String(fd.get("exitDate")));
    const closed = await actions.closeTradeAction(NO_STATE, fd);
    expect(closed.ok, closed.message).toBe(true);

    const r = row(id)!;
    expect([r.buyQty, r.buyValue, r.buyOrderCount, r.sellQty, r.sellValue, r.sellOrderCount]).toEqual([100, 260, 4, 100, 500, 2]);
    // THE assertions (on revert of slim-trade.ts's two fields: [240, 72.12, 167.88];
    // on revert of the dialog's two order-count lines: [240, 48.52, 191.48]).
    expect(shown, "the preview is the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
    expect(shown).toEqual([240, 142.92, 97.08]);
  });

  it("T2 · long mirror: bought 100 @5 in 2 orders, 60 sold @7 in 3 orders; the table's row from the page route AND from the first render previews the exit @8, and the risk cockpit's close route stores the same bill", async () => {
    const id = optionRow(C_OPT_L, "SEAMCOL", {
      buyQty: 100, avgBuyPrice: 5, buyValue: 500, buyDate: "2026-09-01", buyOrderCount: 2,
      sellQty: 60, avgSellPrice: 7, sellValue: 420, sellDate: "2026-09-03", sellOrderCount: 3,
    });
    const viaRoute = await dialogPreview(await pageRouteWire(C_OPT_L, id), 8, "2026-09-08");
    const viaFirstRender = await dialogPreview(firstPageWire(C_OPT_L, id), 8, "2026-09-08");
    const res = await positionsClose.POST(json("/api/positions/close", { tradeId: id, exitPrice: "8", exitDate: "2026-09-08" }));
    expect(res.status).toBe(200);

    const r = row(id)!;
    expect([r.buyQty, r.buyValue, r.buyOrderCount, r.sellQty, r.sellValue, r.sellOrderCount]).toEqual([100, 500, 2, 100, 740, 4]);
    // THE assertions (on revert of either side: the bill of 1 + 2 orders or of 1 + 4).
    expect(viaRoute, "the page route's row previews the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
    expect(viaFirstRender, "the first render's row previews the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
    expect(viaRoute).toEqual([240, 143.12, 96.88]);
  });

  it("U2 · the T2 short (sold 100 @5 in 2 orders, 60 covered @3 in 3) covered in the TRADE EDITOR as buy 100 @2.6 on 8 Sep: the editor's preview bills the stored 3 buy / 2 sell orders — the save's ₹119.32 / ₹120.68", async () => {
    const id = optionRow(C_OPT_E, "SEAMCOE", {
      sellQty: 100, avgSellPrice: 5, sellValue: 500, sellDate: "2026-09-01", sellOrderCount: 2,
      buyQty: 60, avgBuyPrice: 3, buyValue: 180, buyDate: "2026-09-03", buyOrderCount: 3,
    });
    // The editor's form as it opens on the /trades row, the cover typed in; the
    // preview reads the same form the Save posts.
    const wire = wireTrade(C_OPT_E, id);
    const fd = editorForm(C_OPT_E, id, { buyQty: "100", avgBuyPrice: "2.6", buyDate: "2026-09-08" });
    const shown = await editorPreview(wire, fd);
    const saved = await actions.updateTradeAction(NO_STATE, fd);
    expect([saved.ok, saved.message]).toEqual([true, "Trade updated."]);

    const r = row(id)!;
    expect([r.buyQty, r.buyValue, r.buyOrderCount, r.sellQty, r.sellValue, r.sellOrderCount, r.isOpen]).toEqual([100, 260, 3, 100, 500, 2, false]);
    // THE assertions (on revert of edit-trade-dialog.tsx: the body with no counts,
    // one order a side — [240, 48.52, 191.48]; on revert of slim-trade.ts's two
    // fields: the wire row carries none, the same [240, 48.52, 191.48]).
    expect(shown, "the editor's preview is the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
    expect(shown).toEqual([240, 119.32, 120.68]);
    // The re-run 3 seam defects on this boundary (the settings order-count default, a
    // stored MTF funded 0) are V4's and V3's, below.
  });

  it("V4 · Settings → default sell orders 2: a Dhan option bought 100 @5 in 2 orders, open (no sell count), exited @8 on 8 Sep from the trade editor, the Trades close dialog and the risk cockpit's close route — every preview bills the default its save bills: [300, 95.94, 204.06], sell orders 2", async () => {
    const setting = t.db.select().from(t.schema.settings).get()!;
    t.db.update(t.schema.settings).set({ defaultSellOrders: 2 }).run();
    try {
      const legs = { buyQty: 100, avgBuyPrice: 5, buyValue: 500, buyDate: "2026-09-01", buyOrderCount: 2, sellOrderCount: 0 };
      const viaEditor = optionRow(C_OPT_D, "SEAMCOD", legs);
      const viaDialog = optionRow(C_OPT_D, "SEAMCOD", legs);
      const viaRoute = optionRow(C_OPT_D, "SEAMCOD", legs);
      freezeAt("2026-09-08T06:30:00.000Z"); // 12:00 IST
      const bill = (id: number) => {
        const r = row(id)!;
        return [r.grossPnl, r.chargesTotal, r.netPnl, r.buyOrderCount, r.sellOrderCount];
      };

      // The trade editor: the exit typed into the form it opens with; its preview, then its Save.
      const fdE = editorForm(C_OPT_D, viaEditor, { sellQty: "100", avgSellPrice: "8", sellDate: "2026-09-08" });
      const shownE = await editorPreview(wireTrade(C_OPT_D, viaEditor), fdE);
      const savedE = await actions.updateTradeAction(NO_STATE, fdE);
      expect([savedE.ok, savedE.message]).toEqual([true, "Trade updated."]);

      // The Trades close dialog: its preview from the /trades row, then its form's submit.
      const { fd } = closeDialogForm(C_OPT_D, viaDialog, "8");
      expect(fd.get("exitDate")).toBe("2026-09-08");
      const shownD = await dialogPreview(wireTrade(C_OPT_D, viaDialog), 8, String(fd.get("exitDate")));
      const closedD = await actions.closeTradeAction(NO_STATE, fd);
      expect(closedD.ok, closedD.message).toBe(true);

      // The table's row from the page route previews; the risk cockpit's close route saves.
      const shownR = await dialogPreview(await pageRouteWire(C_OPT_D, viaRoute), 8, "2026-09-08");
      const res = await positionsClose.POST(json("/api/positions/close", { tradeId: viaRoute, exitPrice: "8", exitDate: "2026-09-08" }));
      expect(res.status).toBe(200);

      // THE assertions (on revert of the preview route's settings default: both
      // previews [300, 72.34, 227.66]; on revert of closePosition's defaults: the two
      // closes store [300, 72.34, 227.66] with sell orders 1; on revert of the close
      // dialog's omitted count: its preview bills 1 order, [300, 72.34, 227.66]).
      expect(bill(viaEditor)).toEqual([300, 95.94, 204.06, 2, 2]);
      expect(bill(viaDialog), "the close dialog's save is the editor's").toEqual(bill(viaEditor));
      expect(bill(viaRoute), "the close route's save is the editor's").toEqual(bill(viaEditor));
      expect(shownE, "the editor's preview is its save").toEqual(bill(viaEditor).slice(0, 3));
      expect(shownD, "the close dialog's preview is its save").toEqual(bill(viaDialog).slice(0, 3));
      expect(shownR, "the page row's preview is the route's save").toEqual(bill(viaRoute).slice(0, 3));
    } finally {
      t.db.update(t.schema.settings).set({ defaultSellOrders: setting.defaultSellOrders }).run();
    }
  });

  it("V3 · a Zerodha MTF trade 100 @100 → @110 (1 Aug → 1 Sep) given own capital 10,000 in the editor (funded 0): the next notes-only save keeps interest 0 as the editor previews it; an open twin paid in full, closed from the Trades dialog on 1 Sep, closes with no interest as the dialog previews it", async () => {
    const mtfRow = (legs: Record<string, unknown>) =>
      t.db
        .insert(t.schema.trades)
        .values(tradeRow({ accountId: C_MTF, broker: "zerodha", segment: "eq_mtf", symbol: "SEAMMTF", tradingsymbol: "SEAMMTF", buyOrderCount: 1, mtfFundedAmount: null, ...legs }))
        .returning({ id: t.schema.trades.id })
        .get()!.id;
    const funding = (id: number) => {
      const r = row(id)!;
      return [r.mtfFundedAmount, r.mtfInterest, r.grossPnl, r.chargesTotal, r.netPnl];
    };
    const closed = mtfRow({ buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", sellQty: 100, avgSellPrice: 110, sellValue: 11000, sellDate: "2026-09-01", sellOrderCount: 1, isOpen: false });

    // The whole position stated as own capital, in the editor.
    const stated = await actions.updateTradeAction(NO_STATE, editorForm(C_MTF, closed, { ownCapitalUsed: "10000" }));
    expect([stated.ok, stated.message]).toEqual([true, "Trade updated."]);
    expect(funding(closed)).toEqual([0, 0, 1000, 86.32, 913.68]);

    // The next save, notes only: the editor's preview from the row /trades ships, then the Save.
    const fd = editorForm(C_MTF, closed, { notes: "journal only" });
    const shownE = await editorPreview(wireTrade(C_MTF, closed), fd);
    const saved = await actions.updateTradeAction(NO_STATE, fd);
    expect([saved.ok, saved.message]).toEqual([true, "Trade updated."]);
    // THE assertions (on revert of updateManualTrade's read: funded 8,000, interest
    // ₹99.20, charges 220.92, net 779.08 beside a preview of [1000, 86.32, 913.68]).
    expect(funding(closed)).toEqual([0, 0, 1000, 86.32, 913.68]);
    expect(shownE, "the editor's preview is the save").toEqual(funding(closed).slice(2));

    // An open twin paid in full, closed from the Trades dialog.
    const open = mtfRow({ buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", sellOrderCount: 0, isOpen: true });
    const stated2 = await actions.updateTradeAction(NO_STATE, editorForm(C_MTF, open, { ownCapitalUsed: "10000" }));
    expect(stated2.ok, stated2.message).toBe(true);
    expect(row(open)!.mtfFundedAmount).toBe(0);
    freezeAt("2026-09-01T06:30:00.000Z"); // 12:00 IST
    const { fd: closeFd } = closeDialogForm(C_MTF, open, "110");
    expect(closeFd.get("exitDate")).toBe("2026-09-01");
    const shownD = await dialogPreview(wireTrade(C_MTF, open), 110, "2026-09-01");
    const closedOpen = await actions.closeTradeAction(NO_STATE, closeFd);
    expect(closedOpen.ok, closedOpen.message).toBe(true);
    // THE assertions (on revert of closePosition's read: funded 8,000 and interest
    // ₹99.20 stored beside the dialog's preview of interest 0, net 913.68).
    expect(funding(open)).toEqual([0, 0, 1000, 86.32, 913.68]);
    expect(shownD, "the close dialog's preview is the close").toEqual(funding(open).slice(2));
    // The re-run 4 seam defects on this row (the daily accrual job, a typed own capital
    // of 0) are X2's, pinned in the two `it`s below.
  });

  /** An MTF row in C_MTF2, as V3's fixture builds it. */
  const mtfRow2 = (symbol: string, legs: Record<string, unknown>) =>
    t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: C_MTF2, broker: "zerodha", segment: "eq_mtf", symbol, tradingsymbol: symbol, buyOrderCount: 1, mtfFundedAmount: null, ...legs }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
  const funding2 = (id: number) => {
    const r = row(id)!;
    return [r.mtfFundedAmount, r.mtfInterest, r.grossPnl, r.chargesTotal, r.netPnl];
  };

  it("X2 · an open Zerodha MTF position 100 @100 (1 Aug) given own capital 10,000 in the editor (funded 0), the daily accrual job run on 20 Aug, closed @110 from the Trades dialog on 1 Sep: the job leaves the row, and the dialog's preview is the close — [0, 0, 1000, 86.32, 913.68]; a twin never stated (funded null) accrues NOTHING (Q-A), stays null through the close, and the dialog previews that same bill", async () => {
    const open = mtfRow2("SEAMMTFJ", { buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", sellOrderCount: 0, isOpen: true });
    const stated = await actions.updateTradeAction(NO_STATE, editorForm(C_MTF2, open, { ownCapitalUsed: "10000" }));
    expect([stated.ok, stated.message]).toEqual([true, "Trade updated."]);
    const before = row(open);
    expect(before!.mtfFundedAmount).toBe(0);

    // The job /equity runs on open (app/equity/page.tsx), on 20 Aug.
    accrueMtfInterest("2026-08-20");
    // THE assertions (on revert of the job's read: funded 8,000, interest ₹60.80, net
    // −96.78 written onto the open row, then the close keeps 8,000 — 99.20 / 220.92 /
    // 779.08 beside a dialog preview of [1000, 86.32, 913.68]).
    expect(row(open), "the daily job leaves a stated funded 0").toEqual(before);
    freezeAt("2026-09-01T06:30:00.000Z"); // 12:00 IST
    const { fd } = closeDialogForm(C_MTF2, open, "110");
    expect(fd.get("exitDate")).toBe("2026-09-01");
    const shown = await dialogPreview(wireTrade(C_MTF2, open), 110, "2026-09-01");
    const closed = await actions.closeTradeAction(NO_STATE, fd);
    expect(closed.ok, closed.message).toBe(true);
    expect(funding2(open)).toEqual([0, 0, 1000, 86.32, 913.68]);
    expect(shown, "the close dialog's preview is the close").toEqual(funding2(open).slice(2));

    // PIN MOVED (Q-A, owner ruling, 06-ANSWERS "v4.3.0 fix-wave 2N rulings"):
    // a row with NO recorded funded amount accrues NOTHING. Measured before:
    // the job billed ₹60.80 of interest against an 8,000 estimate it never
    // wrote (`[null, 60.8, −60.8]`), and the close then PERSISTED that estimate
    // (`[8000, 99.2, 1000, 220.92, 779.08]`) — a margin-config edit restated
    // stored money with no audit row, and an unpriced row was billed for
    // financing the journal never recorded (invariant 6).
    const unset = mtfRow2("SEAMMTFN", { buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", sellOrderCount: 0, isOpen: true });
    accrueMtfInterest("2026-08-20");
    expect([row(unset)!.mtfFundedAmount, row(unset)!.mtfInterest, row(unset)!.netPnl], "nothing to accrue on, so nothing accrues").toEqual([null, 0, 0]);
    const { fd: fdUnset } = closeDialogForm(C_MTF2, unset, "110");
    const shownUnset = await dialogPreview(wireTrade(C_MTF2, unset), 110, "2026-09-01");
    const closedUnset = await actions.closeTradeAction(NO_STATE, fdUnset);
    expect(closedUnset.ok, closedUnset.message).toBe(true);
    // The close keeps the null (it no longer writes `mtfFundedAmount = funded`)
    // and bills no interest — the same bill the STATED 0 above carries, which is
    // the point: a stated 0 and an unstated amount both cost nothing, and only
    // the first of them is a figure.
    expect(funding2(unset), "the close keeps the null and bills nothing for it").toEqual([null, 0, 1000, 86.32, 913.68]);
    expect(shownUnset, "the close dialog's preview is the close").toEqual(funding2(unset).slice(2));
  });

  it("X2 · a closed Zerodha MTF trade 100 @100 → @110 (1 Aug → 1 Sep) given own capital 0 in the editor (fully broker-funded): the editor's preview is the save — funded 10,000, interest ₹124, [1000, 245.72, 754.28]; the next save with the field blank keeps it, as the editor previews it", async () => {
    const closed = mtfRow2("SEAMMTFZ", { buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", sellQty: 100, avgSellPrice: 110, sellValue: 11000, sellDate: "2026-09-01", sellOrderCount: 1, isOpen: false });
    const fd = editorForm(C_MTF2, closed, { ownCapitalUsed: "0" });
    const shown = await editorPreview(wireTrade(C_MTF2, closed), fd);
    const saved = await actions.updateTradeAction(NO_STATE, fd);
    expect([saved.ok, saved.message]).toEqual([true, "Trade updated."]);
    // THE assertions (on revert of the action's parse, `num(...) || null`: the 0 read as
    // blank — funded estimated 8,000, interest ₹99.20, [1000, 220.92, 779.08] beside a
    // preview of [1000, 245.72, 754.28]).
    expect(funding2(closed)).toEqual([10000, 124, 1000, 245.72, 754.28]);
    expect(shown, "the editor's preview is the save").toEqual(funding2(closed).slice(2));

    const fdBlank = editorForm(C_MTF2, closed, { notes: "own capital left blank" });
    expect(fdBlank.get("ownCapitalUsed")).toBe("");
    const shownBlank = await editorPreview(wireTrade(C_MTF2, closed), fdBlank);
    const savedBlank = await actions.updateTradeAction(NO_STATE, fdBlank);
    expect(savedBlank.ok, savedBlank.message).toBe(true);
    expect(funding2(closed)).toEqual([10000, 124, 1000, 245.72, 754.28]);
    expect(shownBlank, "the editor's preview is the save").toEqual(funding2(closed).slice(2));
  });
});

// ============================================================================
// E-d — H2's M1 sentence ↔ the pull route's 409 ↔ the dialog, and the path it names
// ============================================================================

describe("E-d · a Dhan position the broker converted between two same-day pulls (H2 planSnapshot + cross-source → route 409 JSON → collisionDialogCopy → the named path)", () => {
  const clientOf = (accountId: number) => `20000${accountId}`;
  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  const addDhan = (accountId: number) =>
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
      .run(accountId, clientOf(accountId), alive());
  const position = (accountId: number, symbol: string, productType: "INTRADAY" | "CNC", buyQty: number, buyAvg: number, sellQty = 0, sellAvg = 0) => ({
    dhanClientId: clientOf(accountId),
    tradingSymbol: symbol,
    positionType: buyQty === sellQty ? "CLOSED" : buyQty > sellQty ? "LONG" : "SHORT",
    exchangeSegment: "NSE_EQ",
    productType,
    buyAvg,
    buyQty,
    sellAvg,
    sellQty,
    netQty: buyQty - sellQty,
  });
  const stub = (positions: unknown[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      const body = u.host === "auth.dhan.co" ? { accessToken: alive() } : u.pathname === "/v2/positions" ? positions : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  const pull = async (accountId: number, force = false) => {
    const res = await brokerRoute.POST(json("/api/import/broker", { action: "pull", broker: "dhan", accountId, mode: "commit", ...(force ? { force: true } : {}) }));
    return { status: res.status, body: (await res.json()) as { needsForce?: boolean; message: string; collisions?: { symbol: string; kind: string; sameSnapshot?: boolean }[] } };
  };
  const NOON = "2026-09-08T06:30:00.000Z"; // 12:00 IST
  const EVENING = "2026-09-08T10:30:00.000Z"; // 16:00 IST, the same IST day
  /**
   * The M1 sentence, BUILT BY THE REAL PRODUCER (I3, wave 2I) rather than pasted:
   * `detectCrossSourceDuplicates` is pure, so the expectation is the module's own
   * output for one incoming row standing against `stored` rows of today's earlier
   * snapshot, off the supersede key. What the seam then proves is that the pull
   * route's 409 — commit.ts planSnapshot's `snapshotIds` / `snapshotOffKey` on the
   * wire, through the route's JSON, through broker-connect's collisionDialogCopy —
   * is byte-identical to it. The distinguishing I3 clauses are pinned literally
   * below, because a revert of cross-source.ts moves BOTH sides of this equality
   * together and only a literal can catch that.
   */
  const M1 = (sym: string, stored = 1) => {
    const existing = Array.from({ length: stored }, (_, i) => ({
      id: 90_000 + i, broker: "dhan", symbol: sym, tradingsymbol: sym,
      buyQty: 10, sellQty: 0, buyValue: 1000, sellValue: 0,
      buyDate: "2026-09-08", sellDate: null, sourceFile: "dhan-positions", dedupHash: `stored-${sym}-${i}`,
    }));
    const report = crossSource.detectCrossSourceDuplicates(
      [{
        broker: "dhan", symbol: sym, tradingsymbol: sym, buyQty: 20, sellQty: 0, buyValue: 2010, sellValue: 0,
        buyDate: "2026-09-08", sellDate: null, dedupHash: `incoming-${sym}`,
        snapshotIds: existing.map((e) => e.id), snapshotOffKey: true,
      }],
      existing,
      "dhan-positions",
    );
    return report.message ?? "";
  };
  /** I3's three clauses, byte-pinned: red on revert of cross-source.ts alone. */
  const M1_CLAUSES = [
    "committing anyway adds this pull's row beside the earlier one.",
    "That row may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.",
  ];

  it("the 409's sentence reaches the dialog whole; the path it names — delete the earlier row from Trades, pull again — records the broker's book", async () => {
    freezeAt(NOON);
    addDhan(D_ONE);
    stub([position(D_ONE, "SEAMD", "INTRADAY", 10, 100)]);
    expect((await pull(D_ONE)).status).toBe(200);
    const [noon] = rowsOf(D_ONE);

    freezeAt(EVENING);
    stub([position(D_ONE, "SEAMD", "CNC", 20, 100.5)]);
    const blocked = await pull(D_ONE);
    expect([blocked.status, blocked.body.needsForce]).toEqual([409, true]);
    const shown = bc.collisionDialogCopy({ collisions: blocked.body.collisions ?? [], message: blocked.body.message });
    // THE assertion (on revert of cross-source.ts or of commit.ts's offKey: the
    // key's reasons — "a ladder of fills, a Data Quality join, a segment or
    // exchange you set …" — none of which is true of a conversion).
    expect(shown).toEqual({ description: "Nothing has been committed.", serverMessage: M1("SEAMD"), otherSourceFooter: false });
    for (const clause of M1_CLAUSES) expect(shown.serverMessage ?? "", "I3's own clauses, byte-pinned").toContain(clause);

    // The path the sentence names, through the Trades delete and the same route.
    selectAccount(D_ONE);
    const del = new FormData();
    del.set("ids", String(noon.id));
    const deleted = await actions.deleteTradesAction(NO_STATE, del);
    expect(deleted.ok, deleted.message).toBe(true);
    stub([position(D_ONE, "SEAMD", "CNC", 20, 100.5)]);
    const again = await pull(D_ONE);
    expect(again.status, again.body.message).toBe(200);
    expect(rowsOf(D_ONE).map((r) => [r.tradingsymbol, r.segment, r.buyQty])).toEqual([["SEAMD", "eq_delivery", 20]]);
  });

  it("a pull mixing an ask ON the key (a noted row) and an M1-only ask: the dialog shows both sentences, the key's first, under today's earlier pull", async () => {
    freezeAt(NOON);
    addDhan(D_MIX);
    stub([position(D_MIX, "SEAMDK", "CNC", 10, 100), position(D_MIX, "SEAMDM", "INTRADAY", 10, 100)]);
    expect((await pull(D_MIX)).status).toBe(200);
    const noted = rowsOf(D_MIX).find((r) => r.tradingsymbol === "SEAMDK")!;
    t.db.update(t.schema.trades).set({ notes: "bought the retest" }).where(eq(t.schema.trades.id, noted.id)).run();

    freezeAt(EVENING);
    stub([position(D_MIX, "SEAMDK", "CNC", 10, 100, 10, 120), position(D_MIX, "SEAMDM", "CNC", 20, 100.5)]);
    const blocked = await pull(D_MIX);
    expect(blocked.status).toBe(409);
    expect(blocked.body.collisions?.map((c) => [c.symbol, c.sameSnapshot])).toEqual([
      ["SEAMDK", true],
      ["SEAMDM", true],
    ]);
    const shown = bc.collisionDialogCopy({ collisions: blocked.body.collisions ?? [], message: blocked.body.message });
    expect([shown.description, shown.otherSourceFooter]).toEqual(["Nothing has been committed.", false]);
    const msg = shown.serverMessage ?? "";
    const keyAt = msg.indexOf("1 row in this pull (SEAMDK) restates a position today's earlier pull already recorded, and is not written over it:");
    // THE assertions (on revert: one plural key sentence naming both rows).
    expect(keyAt).toBe(0);
    expect(msg.endsWith(M1("SEAMDM")), msg).toBe(true);
    for (const clause of M1_CLAUSES) expect(msg, "I3's own clauses, byte-pinned").toContain(clause);
    expect(msg).not.toContain(bc.PULL_FORCE_ROUTE_TAIL.trim());
  });
});

// ============================================================================
// E-e — H4's per-record lines ↔ GET JSON ↔ the card's lines and Clear body ↔ the route
// ============================================================================

describe("E-e · kept Dhan notices of two clients in one account after a merge (pull route → merge carry → H4 GET → card lines / Clear body over JSON → H4 named clear)", () => {
  const clientOf = (accountId: number) => `30000${accountId}`;
  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  const addDhan = (accountId: number, lastPullAt: string) =>
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, ?)")
      .run(accountId, clientOf(accountId), alive(), lastPullAt);
  const connOf = (accountId: number) =>
    (t.sqlite.prepare("SELECT id FROM broker_connections WHERE account_id = ? AND broker = 'dhan'").get(accountId) as { id: number }).id;
  /** api.dhan.co: "endless" answers a fill on every page (the walk stops at its page cap); "empty" ends at page 0. */
  const stub = (accountId: number, history: "empty" | "endless") =>
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      const body =
        u.host === "auth.dhan.co"
          ? { accessToken: alive() }
          : u.pathname === "/v2/positions"
            ? []
            : /^\/v2\/trades\//.test(u.pathname) && history === "endless"
              ? [
                  {
                    dhanClientId: clientOf(accountId),
                    exchangeTradeId: `PAGE-${accountId}`,
                    orderId: `O-${accountId}`,
                    transactionType: "BUY",
                    exchangeSegment: "NSE_EQ",
                    productType: "CNC",
                    tradingSymbol: "TCS",
                    tradedQuantity: 1,
                    tradedPrice: 100,
                    exchangeTime: "2026-06-20 10:00:00",
                  },
                ]
              : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  const pull = (accountId: number) => brokerRoute.POST(json("/api/import/broker", { action: "pull", broker: "dhan", accountId, mode: "commit" }));
  const post = async (body: Record<string, unknown>) => (await brokerRoute.POST(json("/api/import/broker", JSON.parse(JSON.stringify(body))))).status;
  type Line = import("@/components/import/broker-connect").UnfetchedSpan;
  /** GET's Dhan row for the account over the wire, as the card receives it. */
  async function cardRow(accountId: number) {
    selectAccount(0);
    const body = (await (await brokerRoute.GET()).json()) as { connections?: { broker: string; accountId: number }[] };
    const r = (body.connections ?? []).find((c) => c.broker === "dhan" && c.accountId === accountId);
    if (!r) throw new Error(`GET lists no Dhan connection for account ${accountId}`);
    return r as { broker: string; accountId: number; unfetched?: Line[]; unfetchedConnection?: (number | null)[] };
  }
  type CardRow = Awaited<ReturnType<typeof cardRow>>;
  /** The card's lines and Clear body. A build without H4's helpers lists GET's
   *  `unfetched` as it is and posts the body it posted before (no connection) —
   *  the card that build shows, not a tolerance. */
  const linesOf = (r: CardRow): Line[] => (typeof bc.unfetchedLines === "function" ? bc.unfetchedLines(r) : (r.unfetched ?? []));
  const bodyOf = (r: CardRow, s: Line): Record<string, unknown> =>
    typeof bc.clearUnfetchedBody === "function"
      ? bc.clearUnfetchedBody(r, s)
      : { action: "clear-unfetched", broker: r.broker, accountId: r.accountId, from: s.from, to: s.to, reason: s.reason };
  const hhmm = (s: Line) => /after (\d\d:\d\d) IST/.exec(s.fact)?.[1] ?? null;
  const records = (accountId: number) => unfetched.outstandingUnfetchedRecords(accountId).map((r) => [r.connection, hhmm(r as Line)]);

  /** Two truncated pulls, the source's last pull at `sourceStamp`, then the merge. */
  async function stage(source: number, target: number, sourceStamp: string) {
    freezeAt("2026-09-10T09:30:00.000Z");
    addDhan(target, "2026-09-05T05:00:00.000Z"); // 10:30 IST
    stub(target, "endless");
    expect((await pull(target)).status).toBe(200);
    addDhan(source, sourceStamp);
    stub(source, "endless");
    expect((await pull(source)).status).toBe(200);
    const merged = accountDelete.deleteAccount({ accountId: source, mode: "merge", targetId: target, connections: "delete" });
    expect(merged.ok, merged.message).toBe(true);
    vi.unstubAllGlobals();
  }

  it("two facts are two card lines; each line's Clear body, sent as JSON, clears its own record — a number, then null", async () => {
    await stage(E_S, E_T, "2026-09-05T09:00:00.000Z"); // 14:30 IST
    const row0 = await cardRow(E_T);
    const lines = linesOf(row0);
    // THE assertions (on revert of the H4 listing: one line, the target's fact,
    // and no connection to name — the 14:30 fact never shown).
    expect(lines.map((s) => [s.connection, hhmm(s)])).toEqual([
      [connOf(E_T), "10:30"],
      [null, "14:30"],
    ]);
    expect(new Set(lines.map((s) => bc.unfetchedNotice(s))).size).toBe(2);

    expect(await post(bodyOf(row0, lines[1]))).toBe(200);
    // THE assertion (on revert of the card's body or the route's named clear:
    // [] — the 10:30 fact the user did not clear is dismissed with it).
    expect(records(E_T)).toEqual([[connOf(E_T), "10:30"]]);
    expect(linesOf(await cardRow(E_T)).map((s) => [s.connection, hhmm(s)])).toEqual([[connOf(E_T), "10:30"]]);

    expect(await post(bodyOf(row0, lines[0]))).toBe(200);
    expect(records(E_T)).toEqual([]);
    expect((await cardRow(E_T)).unfetched).toEqual([]);
  });

  it("a body from a card that sends no connection (the legacy row) still clears every same-span record; a named record already gone answers 404", async () => {
    await stage(E_S2, E_T2, "2026-09-05T09:00:00.000Z");
    const row0 = await cardRow(E_T2);
    const [first] = linesOf(row0);
    const { connection: _named, ...legacy } = first;
    void _named;
    expect(await post(bodyOf(row0, legacy as Line))).toBe(200);
    expect(records(E_T2)).toEqual([]);
    // The card still holding the cleared line: its named Clear finds nothing open.
    expect(await post(bodyOf(row0, first))).toBe(404);
  });

  /** The target's own later pull reads the span in full (a clean history walk,
   *  the next day). Its truncated pull's commit is taken as the one that threw
   *  (N5: the stamp never moved), so the read starts at the span's first day —
   *  the only way a pull covers a page-cap span it kept. */
  async function targetReadsInFull(target: number) {
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ? AND broker = 'dhan'").run("2026-09-05T05:00:00.000Z", target);
    freezeAt("2026-09-11T09:30:00.000Z");
    stub(target, "empty");
    expect((await pull(target)).status).toBe(200);
    vi.unstubAllGlobals();
  }

  it("S3 · one shared line (the target's record and the carried one state one sentence); the target's own full read clears its record while the card is open: the card's Clear clears the line's carried record — 200, then 404", async () => {
    await stage(E_S3, E_T3, "2026-09-05T05:00:00.000Z"); // 10:30 IST, the target's own time
    const row0 = await cardRow(E_T3);
    const lines = linesOf(row0);
    expect(lines.map((s) => [s.connection, hhmm(s)])).toEqual([[connOf(E_T3), "10:30"]]);
    expect(records(E_T3)).toEqual([
      [connOf(E_T3), "10:30"],
      [null, "10:30"],
    ]);

    await targetReadsInFull(E_T3);
    expect(records(E_T3), "the pull clears its own connection's record only (N4)").toEqual([[null, "10:30"]]);
    expect(linesOf(await cardRow(E_T3)).map((s) => [s.connection, hhmm(s)])).toEqual([[null, "10:30"]]);

    // THE assertions (on revert of S3 in dhan-unfetched.ts: 404 "That notice is
    // not open" over the carried record stating the identical sentence).
    expect(await post(bodyOf(row0, lines[0]))).toBe(200);
    expect(records(E_T3)).toEqual([]);
    expect((await cardRow(E_T3)).unfetched).toEqual([]);
    expect(await post(bodyOf(row0, lines[0]))).toBe(404);
  });

  it("S3 · two lines (the target's 10:30 fact, a carried 14:30 fact); the target's own full read clears its record while the card is open: the card's Clear of the 10:30 line answers 404 and the 14:30 fact stays", async () => {
    await stage(E_S4, E_T4, "2026-09-05T09:00:00.000Z"); // 14:30 IST, another fact
    const row0 = await cardRow(E_T4);
    const lines = linesOf(row0);
    expect(lines.map((s) => [s.connection, hhmm(s)])).toEqual([
      [connOf(E_T4), "10:30"],
      [null, "14:30"],
    ]);
    await targetReadsInFull(E_T4);
    expect(records(E_T4)).toEqual([[null, "14:30"]]);

    // THE assertions (on revert of the card's body to the pre-H4 one with no
    // connection: 200 and [] — the legacy same-span clear dismisses the 14:30
    // fact the user did not clear).
    expect(await post(bodyOf(row0, lines[0]))).toBe(404);
    expect(records(E_T4)).toEqual([[null, "14:30"]]);
    expect(linesOf(await cardRow(E_T4)).map((s) => [s.connection, hhmm(s)])).toEqual([[null, "14:30"]]);
  });
});

// ============================================================================
// E-f — /ipos' row ↔ H5's form (what the date input holds) ↔ H5's route
// ============================================================================

describe("E-f · an IPO whose stored exit date cannot be read, edited from /ipos (getIposComputed → IpoForm render → exitDateToSend → POST /api/ipos → the next render)", () => {
  type Ipo = import("@/lib/analytics/ipo").IpoComputed;
  const page = (name: string, accountId = F_ACC): Ipo => {
    selectAccount(accountId);
    const r = ipoQueries.getIposComputed().rows.find((x) => x.name === name);
    if (!r) throw new Error(`/ipos lists no ${name}`);
    return JSON.parse(JSON.stringify(r)) as Ipo;
  };
  const formHtml = (existing: Ipo) => renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(ipoUi.IpoForm, { existing, onDone: () => {} })));
  const renderedExitDate = (html: string) => /Exit date<\/label><input type="date"[^>]*value="([^"]*)"/.exec(html)?.[1];
  /** IpoForm.save()'s body: the form's state as it opened on `e`, the date as its input holds it, the user's typing on top. */
  function saveBody(e: Ipo, html: string, typed: { notes?: string; exitPrice?: string; exitDate?: string } = {}) {
    // An unallotted form renders no date input: its state is what the form initialised it to.
    const unreadable = typeof ipoUi.unreadableStoredExitDate === "function" && ipoUi.unreadableStoredExitDate(e.exitDate);
    const field = typed.exitDate ?? renderedExitDate(html) ?? (unreadable ? "" : (e.exitDate ?? ""));
    // IpoForm (ipo-client.tsx:513-514): the rendered input is `exitDateInputValue`,
    // the kept flag `keepsStoredExitDate(existing)` (U3; T3's build passed
    // `storedAsSold`), and the date input's onChange marks the field edited — here,
    // a typed exitDate. A build without T3 calls the three-argument form.
    const sold =
      typeof ipoUi.keepsStoredExitDate === "function"
        ? ipoUi.keepsStoredExitDate(e)
        : typeof ipoUi.storedAsSold === "function"
          ? ipoUi.storedAsSold(e)
          : false;
    const toSend = typeof ipoUi.exitDateToSend === "function" ? ipoUi.exitDateToSend(e.exitDate, field, e.allotted, sold, typed.exitDate !== undefined) : field;
    return {
      id: e.id, name: e.name, broker: e.broker ?? "", exchange: e.exchange ?? "NSE", board: e.board ?? "mainboard", category: e.category ?? "",
      discountPerShare: e.discountPerShare > 0 ? String(e.discountPerShare) : "", appliedPrice: String(e.appliedPrice), lotSize: String(e.lotSize),
      lotsApplied: String(e.lotsApplied), allotted: e.allotted, allottedQty: e.allotted ? Math.round(e.allottedQty / e.lotSize) * e.lotSize : 0,
      listingPrice: e.listingPrice == null ? "" : String(e.listingPrice), exitPrice: typed.exitPrice ?? (e.exitPrice == null ? "" : String(e.exitPrice)),
      appliedDate: e.appliedDate ?? "", allotmentDate: e.allotmentDate ?? "", listingDate: e.listingDate ?? "",
      exitDate: toSend, notes: typed.notes ?? e.notes ?? "",
    };
  }
  const stored = (name: string) => t.db.select().from(t.schema.ipos).all().find((r) => r.name === name)!;

  it("allotted and linked to an open holding: the form opens blank beside the notice, a notes save clears the stored date as the notice says, and the holding stays open", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F_ACC, broker: "zerodha", symbol: "SEAMIPO", tradingsymbol: "SEAMIPO", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F_ACC, name: "SEAMIPO", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: "2026-02-30", allotmentDate: "2019-01-10", tradeId })
      .run();

    const e = page("SEAMIPO");
    const html = formHtml(e);
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { notes: "noted" })));
    expect(res.status).toBe(200);
    // THE assertions (on revert of ipo-client.tsx: the '2026-02-30' the date
    // input cannot show is sent back unseen and passes through, with no line
    // beside the blank input to say so).
    expect([stored("SEAMIPO").notes, stored("SEAMIPO").exitDate]).toEqual(["noted", null]);
    expect(renderedExitDate(html)).toBe("");
    expect(textOf(html)).toContain("The stored exit date (2026-02-30) could not be read — enter the date. Saved blank, the exit date is cleared.");
    const after = formHtml(page("SEAMIPO"));
    expect(textOf(after)).not.toContain("could not be read");
    const tr = row(tradeId)!;
    expect([tr.isOpen, tr.sellDate, tr.sellQty]).toEqual([true, null, 0]);
  });

  it("S4 · allotted and linked to an open holding, an exit price typed and the date left blank as the form opens: the route refuses with the sentence the form toasts and nothing moves; the date typed, the holding closes on it", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F_ACC, broker: "zerodha", symbol: "SEAMIPOX", tradingsymbol: "SEAMIPOX", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F_ACC, name: "SEAMIPOX", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: "2026-02-30", allotmentDate: "2019-01-10", tradeId })
      .run();

    const e = page("SEAMIPOX");
    const html = formHtml(e);
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { exitPrice: "150" })));
    // THE assertions (on revert of S4 in the route: 200, and the holding closes
    // with sell_date NULL and gross ₹500 — FY 2026-27 by the current-FY fallback,
    // for shares allotted in 2019; on revert of ipo-client.tsx: the unseen
    // '2026-02-30' goes back and meets H5's other sentence instead). IpoForm.save()
    // toasts `json.message` (ipo-client.tsx:461).
    expect([res.status, await res.json()]).toEqual([400, { ok: false, message: "An exit needs a readable exit date — enter the date the shares were sold." }]);
    expect([stored("SEAMIPOX").exitPrice, stored("SEAMIPOX").exitDate]).toEqual([null, "2026-02-30"]);
    const held = row(tradeId)!;
    expect([held.isOpen, held.sellDate, held.sellQty, held.grossPnl]).toEqual([true, null, 0, 0]);

    // The date the input asks for, typed: the same form, the same route.
    const dated = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(dated.status).toBe(200);
    const sold = row(tradeId)!;
    expect([sold.isOpen, sold.sellDate, sold.sellQty, sold.sellValue, sold.grossPnl]).toEqual([false, "2026-03-02", 10, 1500, 500]);
    selectAccount(F_ACC);
    expect(taxByFy(taxRowsOf(tradeQueries.getJournalTrades())).map((s) => [s.fy, s.trades])).toEqual([["2025-26", 1]]);
  });

  it("T3 · allotted, SOLD and linked — a pre-4.3.0 sync closed the holding on the unreadable '2026-02-30': the notice says the date is kept, a notes-only save answers 200 and moves nothing; the field typed then cleared is refused, a typed date sells on it", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F_ACC, broker: "zerodha", symbol: "SEAMIPOS", tradingsymbol: "SEAMIPOS", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10",
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-02-30", grossPnl: 500, netPnl: 500, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F_ACC, name: "SEAMIPOS", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-02-30", allotmentDate: "2019-01-10", tradeId })
      .run();
    const holding = () => {
      const r = row(tradeId)!;
      return [r.isOpen, r.sellDate, r.sellQty, r.sellValue, r.grossPnl];
    };
    const e = page("SEAMIPOS");
    const html = formHtml(e);
    const notice = unescape(/data-testid="ipo-exit-date-unreadable">([^<]*)</.exec(html)?.[1] ?? "");

    // THE assertions (on revert of ipo-client.tsx to H5 + S4: the blank goes out,
    // the route refuses 400 "An exit needs a readable exit date — enter the date
    // the shares were sold." beside a notice promising "Saved blank, the exit date
    // is cleared." — the notes are lost; on a route that refuses a close written
    // back on the date the holding already carries: 400, the same notes lost).
    expect(renderedExitDate(html)).toBe("");
    expect(notice).toBe("The stored exit date (2026-02-30) could not be read. It is kept as stored; to change it, enter the date the shares were sold.");
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { notes: "sold, noted" })));
    expect([res.status, await res.json()]).toEqual([200, { ok: true, id: stored("SEAMIPOS").id, message: "IPO updated — the linked holding's cost basis and mark were updated with it." }]);
    expect([stored("SEAMIPOS").notes, stored("SEAMIPOS").exitPrice, stored("SEAMIPOS").exitDate]).toEqual(["sold, noted", 150, "2026-02-30"]);
    expect(holding()).toEqual([false, "2026-02-30", 10, 1500, 500]);

    // The field typed then cleared: what the input holds (blank) goes out, and the
    // route's S4 sentence is what save() toasts. Nothing moves.
    const cleared = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { notes: "cleared", exitDate: "" })));
    expect([cleared.status, ((await cleared.json()) as { message: string }).message]).toEqual([400, "An exit needs a readable exit date — enter the date the shares were sold."]);
    expect([stored("SEAMIPOS").notes, stored("SEAMIPOS").exitDate]).toEqual(["sold, noted", "2026-02-30"]);

    // The path the notice names: the date the shares were sold, typed.
    const dated = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { exitDate: "2026-03-03" })));
    expect(dated.status).toBe(200);
    expect(holding()).toEqual([false, "2026-03-03", 10, 1500, 500]);
    expect(stored("SEAMIPOS").exitDate).toBe("2026-03-03");
  });

  it("U3 · SOLD and linked on the unreadable '2026-02-30', the holding's sell date then corrected in the Trades editor to 2026-03-02: /ipos' row carries the link, the form fills that date in and says so, and a notes-only save answers 200 — notes kept, the exit date readable, the holding unchanged", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F_ACC, broker: "zerodha", symbol: "SEAMIPOU", tradingsymbol: "SEAMIPOU", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10",
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-02-30", grossPnl: 500, netPnl: 500, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F_ACC, name: "SEAMIPOU", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-02-30", allotmentDate: "2019-01-10", tradeId })
      .run();
    // The holding's date corrected where the user sees it: the Trades editor, as /trades ships the row.
    const fixed = await actions.updateTradeAction(NO_STATE, editorForm(F_ACC, tradeId, { sellDate: "2026-03-02" }));
    expect([fixed.ok, fixed.message]).toEqual([true, "Trade updated."]);
    const holding = () => {
      const r = row(tradeId)!;
      return [r.isOpen, r.sellDate, r.sellQty, r.sellValue, r.grossPnl];
    };
    expect(holding()).toEqual([false, "2026-03-02", 10, 1500, 500]);

    const e = page("SEAMIPOU");
    const html = formHtml(e);
    const notice = unescape(/data-testid="ipo-exit-date-unreadable">([^<]*)</.exec(html)?.[1] ?? "");
    // THE assertions (on revert of ipo-client.tsx to T3: the input blank, "It is
    // kept as stored", '2026-02-30' sent back and refused 400 "The exit date must be
    // a real calendar day …" — the notes lost; on revert of lib/queries/ipos.ts's
    // link fields: the form cannot see the link, the same 400).
    expect(renderedExitDate(html)).toBe("2026-03-02");
    expect(notice).toBe("The stored exit date (2026-02-30) could not be read. The linked holding's sell date, 2026-03-02, is filled in and will be saved as the exit date; to use another day, enter it.");
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { notes: "fixed in trades, noted" })));
    expect([res.status, await res.json()]).toEqual([200, { ok: true, id: stored("SEAMIPOU").id, message: "IPO updated — the linked holding's cost basis and mark were updated with it." }]);
    expect([stored("SEAMIPOU").notes, stored("SEAMIPOU").exitPrice, stored("SEAMIPOU").exitDate]).toEqual(["fixed in trades, noted", 150, "2026-03-02"]);
    expect(holding()).toEqual([false, "2026-03-02", 10, 1500, 500]);
    const after = page("SEAMIPOU");
    expect([after.exitDate, after.realised, after.unpriced, after.grossPnl]).toEqual(["2026-03-02", true, false, 500]);
    expect(textOf(formHtml(after))).not.toContain("could not be read");
    // The UNSOLD mirror (the re-run 3 seam defect) is V2's, below.
  });

  it("V2 · allotted with NO exit price, the stored '2026-02-30' unreadable, linked to a holding the user SOLD in the Trades editor (10 @150 on 2026-03-02): the form fills nothing in and says a blank clears the date, a notes-only save answers 200 — the IPO's date cleared, the ₹1,500 sale still on the holding and realised in FY 2025-26", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F2_ACC, broker: "zerodha", symbol: "SEAMIPOV", tradingsymbol: "SEAMIPOV", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    // The sale, made where the user sees the holding: the Trades editor, as /trades ships the row.
    const sold = await actions.updateTradeAction(NO_STATE, editorForm(F2_ACC, tradeId, { sellQty: "10", avgSellPrice: "150", sellDate: "2026-03-02" }));
    expect([sold.ok, sold.message]).toEqual([true, "Trade updated."]);
    const holding = () => {
      const r = row(tradeId)!;
      return [r.isOpen, r.sellDate, r.sellQty, r.sellValue, r.grossPnl, r.netPnl];
    };
    const soldBook = holding();
    expect(soldBook.slice(0, 5)).toEqual([false, "2026-03-02", 10, 1500, 500]);
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F2_ACC, name: "SEAMIPOV", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: "2026-02-30", allotmentDate: "2019-01-10", tradeId })
      .run();

    const e = page("SEAMIPOV", F2_ACC);
    expect([e.linked, e.linkedSellDate, e.exitPrice]).toEqual([true, "2026-03-02", null]);
    const html = formHtml(e);
    const notice = unescape(/data-testid="ipo-exit-date-unreadable">([^<]*)</.exec(html)?.[1] ?? "");
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { notes: "unsold, noted" })));
    // THE assertions (on revert of ipo-client.tsx's sold-only fill: the input holds
    // 2026-03-02 beside "… is filled in and will be saved as the exit date", and the
    // IPO stores that date with no exit price; on revert of X1's route (the sync run
    // whatever linkedSyncFor answers): the holding re-opened — [true, null, 0, 0, 0],
    // the sale on no row and FY 2025-26 realising nothing). X1: the save changes nothing
    // the sync writes, so the holding is left and the message says so.
    expect(renderedExitDate(html)).toBe("");
    expect(notice).toBe("The stored exit date (2026-02-30) could not be read — enter the date. Saved blank, the exit date is cleared.");
    expect([res.status, await res.json()]).toEqual([200, { ok: true, id: stored("SEAMIPOV").id, message: "IPO updated. The linked holding has a sale recorded in Trades and was left as it is." }]);
    expect([stored("SEAMIPOV").notes, stored("SEAMIPOV").exitPrice, stored("SEAMIPOV").exitDate]).toEqual(["unsold, noted", null, null]);
    expect(holding(), "the holding's own sale, as the Trades editor stored it").toEqual(soldBook);
    selectAccount(F2_ACC);
    expect(taxByFy(taxRowsOf(tradeQueries.getJournalTrades())).map((s) => [s.fy, s.trades, s.totalRealised])).toEqual([["2025-26", 1, soldBook[5]]]);
    expect(textOf(formHtml(page("SEAMIPOV", F2_ACC)))).not.toContain("could not be read");
    // The re-run 4 seam defects (V2's kept sell leg over a partial sale and over a
    // corrected quantity; an /ipos exit cleared over the holding it closed) are X1's,
    // pinned in the three `it`s below. X1 deleted keepLinkedSellLeg, so no pin here
    // asserts a recomputed holding.
  });

  /** The holding as /trades' KPI strip and the tax-by-FY report read the account. */
  const books = (accountId: number) => {
    selectAccount(accountId);
    const all = tradeQueries.getJournalTrades();
    const k = tradeQueries.tradeStatsOf(all);
    return { kpi: [k.count, k.open, k.gross, k.charges, k.net], fy: taxByFy(taxRowsOf(all)).map((s) => [s.fy, s.trades, s.totalRealised]) };
  };
  const refusedSold = { ok: false, message: "The linked holding has a sale recorded in Trades. Change its quantity or prices there, or remove the sale first. Nothing was saved." };

  it("X1 · allotted, unsold (listing 130) and linked to a holding bought 10 @100 and PARTLY sold 4 @150 in the Trades editor: a notes-only save from /ipos answers 200 and says the holding was left — the row, the /trades KPI strip and the tax-by-FY report exactly as the editor left them; the listing price changed is refused 409 with the sentence the form toasts, and nothing moves", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F3_ACC, broker: "zerodha", symbol: "SEAMIPOP", tradingsymbol: "SEAMIPOP", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const part = await actions.updateTradeAction(NO_STATE, editorForm(F3_ACC, tradeId, { sellQty: "4", avgSellPrice: "150", sellDate: "2026-03-02" }));
    expect([part.ok, part.message]).toEqual([true, "Trade updated."]);
    const editorBook = row(tradeId)!;
    expect([editorBook.isOpen, editorBook.sellQty, editorBook.sellValue, editorBook.grossPnl, editorBook.unrealisedPnl]).toEqual([true, 4, 600, 0, 0]);
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F3_ACC, name: "SEAMIPOP", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: null, allotmentDate: "2019-01-10", tradeId })
      .run();
    const booksBefore = books(F3_ACC);
    expect(booksBefore.kpi.slice(0, 3)).toEqual([1, 1, 0]);

    const e = page("SEAMIPOP", F3_ACC);
    const html = formHtml(e);
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { notes: "partly sold, noted" })));
    // THE assertions (on revert of X1's route or of linkedSyncFor to V2's kept leg: the
    // row open at gross −400, net −417.40, unrealised 300 on all 10 shares — the KPI
    // strip's gross 0 becomes −400; to the pre-V2 sync: the ₹600 sale erased).
    expect(books(F3_ACC), "the KPI strip and tax-by-FY as the Trades editor left them").toEqual(booksBefore);
    expect(row(tradeId), "the holding as the Trades editor left it").toEqual(editorBook);
    expect([res.status, await res.json()]).toEqual([200, { ok: true, id: stored("SEAMIPOP").id, message: "IPO updated. The linked holding has a sale recorded in Trades and was left as it is." }]);
    expect(stored("SEAMIPOP").notes).toBe("partly sold, noted");

    // A field the sync writes (the mark): refused whole. IpoForm.save() toasts json.message.
    const e2 = page("SEAMIPOP", F3_ACC);
    const marked = await ipoRoute.POST(json("/api/ipos", { ...saveBody(e2, formHtml(e2), { notes: "marked" }), listingPrice: "140" }));
    expect([marked.status, await marked.json()]).toEqual([409, refusedSold]);
    expect([stored("SEAMIPOP").notes, stored("SEAMIPOP").listingPrice]).toEqual(["partly sold, noted", 130]);
    expect(row(tradeId)).toEqual(editorBook);
    expect(books(F3_ACC)).toEqual(booksBefore);
  });

  it("X1 · allotted, unsold and linked to a holding SOLD 10 @150 in the Trades editor: the allotted quantity corrected to 20 on /ipos is refused 409 — the ₹500 gain still realised once in FY 2025-26; the path the sentence names (the sale removed in the Trades editor) lets the same save through, and the holding takes the IPO's 20 @100 marked at 130", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F4_ACC, broker: "zerodha", symbol: "SEAMIPOQ", tradingsymbol: "SEAMIPOQ", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const sold = await actions.updateTradeAction(NO_STATE, editorForm(F4_ACC, tradeId, { sellQty: "10", avgSellPrice: "150", sellDate: "2026-03-02" }));
    expect([sold.ok, sold.message]).toEqual([true, "Trade updated."]);
    const soldBook = row(tradeId)!;
    expect([soldBook.isOpen, soldBook.sellDate, soldBook.sellQty, soldBook.sellValue, soldBook.grossPnl]).toEqual([false, "2026-03-02", 10, 1500, 500]);
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F4_ACC, name: "SEAMIPOQ", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: null, allotmentDate: "2019-01-10", tradeId })
      .run();
    const booksBefore = books(F4_ACC);
    expect(booksBefore.fy).toEqual([["2025-26", 1, soldBook.netPnl]]);

    const e = page("SEAMIPOQ", F4_ACC);
    const body = { ...saveBody(e, formHtml(e), { notes: "twenty" }), lotsApplied: "2", allottedQty: 20 };
    const res = await ipoRoute.POST(json("/api/ipos", body));
    // THE assertions (on revert of X1's route or of linkedSyncFor to V2's kept leg: 200,
    // the row kept CLOSED at buy 20 / sell 10, gross −500, and FY 2025-26 realising a
    // ₹518.43 loss for a ₹500 gain with ten shares still held).
    expect(books(F4_ACC), "the KPI strip and tax-by-FY as the Trades editor left them").toEqual(booksBefore);
    expect(row(tradeId), "the holding's own sale, as the Trades editor stored it").toEqual(soldBook);
    expect([res.status, await res.json()]).toEqual([409, refusedSold]);
    expect([stored("SEAMIPOQ").allottedQty, stored("SEAMIPOQ").notes]).toEqual([10, null]);

    // The sentence's path: the sale removed in the Trades editor, then the same save.
    const reopened = await actions.updateTradeAction(NO_STATE, editorForm(F4_ACC, tradeId, { sellQty: "0", avgSellPrice: "0", sellDate: "" }));
    expect([reopened.ok, reopened.message]).toEqual([true, "Trade updated."]);
    const again = await ipoRoute.POST(json("/api/ipos", body));
    expect([again.status, ((await again.json()) as { message: string }).message]).toEqual([200, "IPO updated — the linked holding's cost basis and mark were updated with it."]);
    const r = row(tradeId)!;
    expect([r.isOpen, r.buyQty, r.buyValue, r.sellQty, r.sellDate, r.grossPnl, r.closingPrice, r.unrealisedPnl]).toEqual([true, 20, 2000, 0, null, 0, 130, 600]);
    expect(books(F4_ACC).fy).toEqual([]);
  });

  it("X1 · allotted and linked to an open holding 10 @100: the exit 150 on 2026-03-02 saved on /ipos closes the holding, and clearing it on /ipos re-opens it — /ipos' row, getIpoRealisedNet, the KPI strip and the tax-by-FY report agree at each step (sold, then not)", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F5_ACC, broker: "zerodha", symbol: "SEAMIPOR", tradingsymbol: "SEAMIPOR", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F5_ACC, name: "SEAMIPOR", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: null, allotmentDate: "2019-01-10", tradeId })
      .run();
    const holding = () => {
      const r = row(tradeId)!;
      return [r.isOpen, r.sellDate, r.sellQty, r.sellValue, r.grossPnl, r.closingPrice, r.unrealisedPnl];
    };
    const ipoRealised = () => {
      selectAccount(F5_ACC);
      return ipoQueries.getIpoRealisedNet();
    };

    const e = page("SEAMIPOR", F5_ACC);
    const sold = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(sold.status).toBe(200);
    expect(holding()).toEqual([false, "2026-03-02", 10, 1500, 500, null, 0]);
    const s = page("SEAMIPOR", F5_ACC);
    expect([s.realised, s.grossPnl]).toEqual([true, 500]);
    expect(books(F5_ACC).fy.map((f) => f.slice(0, 2))).toEqual([["2025-26", 1]]);

    const cleared = await ipoRoute.POST(json("/api/ipos", saveBody(s, formHtml(s), { exitPrice: "", exitDate: "" })));
    // THE assertions (on revert of linkedSyncFor's stored-exit clause: 409, the exit kept on
    // both pages; on revert of X1 to V2's kept leg: 200, the holding kept CLOSED and
    // realised +₹500 in FY 2025-26 while /ipos reads not realised and getIpoRealisedNet 0).
    expect([cleared.status, ((await cleared.json()) as { message: string }).message]).toEqual([200, "IPO updated — the linked holding's cost basis and mark were updated with it."]);
    expect([stored("SEAMIPOR").exitPrice, stored("SEAMIPOR").exitDate]).toEqual([null, null]);
    expect(holding()).toEqual([true, null, 0, 0, 0, 130, 300]);
    const c = page("SEAMIPOR", F5_ACC);
    expect([c.realised, ipoRealised()]).toEqual([false, 0]);
    const after = books(F5_ACC);
    expect([after.kpi.slice(0, 3), after.fy]).toEqual([[1, 1, 0], []]);
  });

  it("Y2 · SOLD 150 and linked on the unreadable '2026-02-30', the holding's sale then corrected in the Trades editor to 152 on 2026-03-02: a notes-only save from /ipos answers 200 and the holding stays exactly as the editor left it, the date cleared too; the exit price changed is refused 409", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F_ACC, broker: "zerodha", symbol: "SEAMIPOY", tradingsymbol: "SEAMIPOY", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10",
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-02-30", grossPnl: 500, netPnl: 500, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F_ACC, name: "SEAMIPOY", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-02-30", allotmentDate: "2019-01-10", tradeId })
      .run();
    const fixed = await actions.updateTradeAction(NO_STATE, editorForm(F_ACC, tradeId, { avgSellPrice: "152", sellDate: "2026-03-02" }));
    expect([fixed.ok, fixed.message]).toEqual([true, "Trade updated."]);
    const editorBook = row(tradeId)!;
    expect([editorBook.isOpen, editorBook.sellDate, editorBook.sellQty, editorBook.avgSellPrice]).toEqual([false, "2026-03-02", 10, 152]);

    const e = page("SEAMIPOY");
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { notes: "corrected in trades, noted" })));
    // THE assertions (on revert of linkedSyncFor's unreadable-date clause: 409 "The linked holding
    // has a sale recorded in Trades…" on a notes-only save, and on the cleared date below).
    expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([200, "IPO updated. The linked holding has a sale recorded in Trades and was left as it is."]);
    expect(stored("SEAMIPOY").notes).toBe("corrected in trades, noted");
    expect(row(tradeId), "the holding as the Trades editor left it").toEqual(editorBook);

    t.db.update(t.schema.ipos).set({ exitDate: "2026-02-30" }).where(eq(t.schema.ipos.id, e.id)).run();
    const e2 = page("SEAMIPOY");
    const cleared = await ipoRoute.POST(json("/api/ipos", saveBody(e2, formHtml(e2), { exitDate: "", notes: "date cleared" })));
    expect(cleared.status).toBe(200);
    expect([stored("SEAMIPOY").exitPrice, stored("SEAMIPOY").exitDate]).toEqual([150, null]);
    expect(row(tradeId)).toEqual(editorBook);

    const repriced = await ipoRoute.POST(json("/api/ipos", saveBody(page("SEAMIPOY"), formHtml(page("SEAMIPOY")), { exitPrice: "160" })));
    expect([repriced.status, await repriced.json()]).toEqual([409, refusedSold]);
    expect(row(tradeId)).toEqual(editorBook);
  });

  it("CAP-IPO-LINK · an exit saved on /ipos closes the linked holding: the capital summary counts that sale once (the holding's net), while /ipos' own book still reads the IPO realised", async () => {
    const acc = 1456; // this it's own account
    t.db.insert(t.schema.accounts).values({ id: acc, name: `fixE ${acc}`, isDefault: false }).run();
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: acc, broker: "zerodha", symbol: "SEAMIPOC", tradingsymbol: "SEAMIPOC", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: acc, name: "SEAMIPOC", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: null, allotmentDate: "2019-01-10", tradeId })
      .run();
    const e = page("SEAMIPOC", acc);
    const sold = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(sold.status).toBe(200);
    const holdingNet = row(tradeId)!.netPnl;
    const ipoNet = page("SEAMIPOC", acc).netPnl;
    expect([row(tradeId)!.isOpen, holdingNet > 0, ipoNet > 0]).toEqual([false, true, true]);
    selectAccount(acc);
    expect(ipoQueries.getIpoRealisedNet()).toBe(ipoNet);
    const s = (await import("@/lib/queries/capital")).getCapitalSummary();
    expect([s.equityRealised, s.ipoRealised, s.totalRealised]).toEqual([holdingNet, 0, holdingNet]);
  });

  it("Z2 (A) · SOLD 150 and linked on the unreadable '2026-02-30', the holding's sale corrected in the Trades editor to 152 on 2026-03-02: the form fills nothing in, says the sale differs and is recorded in Trades, and a notes-only save sends the stored date — 200, the IPO's exit date unchanged, the holding as the editor left it", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F_ACC, broker: "zerodha", symbol: "SEAMIPOZ", tradingsymbol: "SEAMIPOZ", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10",
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-02-30", grossPnl: 500, netPnl: 500, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F_ACC, name: "SEAMIPOZ", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-02-30", allotmentDate: "2019-01-10", tradeId })
      .run();
    const fixed = await actions.updateTradeAction(NO_STATE, editorForm(F_ACC, tradeId, { avgSellPrice: "152", sellDate: "2026-03-02" }));
    expect([fixed.ok, fixed.message]).toEqual([true, "Trade updated."]);
    const editorBook = row(tradeId)!;

    const e = page("SEAMIPOZ");
    expect([e.linkedSellQty, e.linkedSellPrice]).toEqual([10, 152]);
    const html = formHtml(e);
    const notice = unescape(/data-testid="ipo-exit-date-unreadable">([^<]*)</.exec(html)?.[1] ?? "");
    expect(renderedExitDate(html)).toBe("");
    expect(notice).not.toContain("will be saved");
    expect(notice).toContain("differs from this IPO's exit (10 at 150) and is recorded in Trades");
    const body = saveBody(e, html, { notes: "differs, noted" });
    expect(body.exitDate).toBe("2026-02-30");
    const res = await ipoRoute.POST(json("/api/ipos", body));
    expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([200, "IPO updated. The linked holding has a sale recorded in Trades and was left as it is."]);
    expect([stored("SEAMIPOZ").notes, stored("SEAMIPOZ").exitPrice, stored("SEAMIPOZ").exitDate]).toEqual(["differs, noted", 150, "2026-02-30"]);
    expect(row(tradeId)).toEqual(editorBook);
  });

  it("Z2 (B) · an exit 150 on 2026-03-02 saved on /ipos over a linked open holding: the holding's charges and net are /ipos' own figures to the paisa, and the capital summary counts that net", async () => {
    const acc = 1459; // this it's own account (Z2; 1457 is TAX-IPO-LINK's)
    t.db.insert(t.schema.accounts).values({ id: acc, name: `fixE ${acc}`, isDefault: false }).run();
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: acc, broker: "zerodha", symbol: "SEAMIPON", tradingsymbol: "SEAMIPON", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: acc, name: "SEAMIPON", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: null, allotmentDate: "2019-01-10", tradeId })
      .run();
    const e = page("SEAMIPON", acc);
    const sold = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(sold.status).toBe(200);
    const s = page("SEAMIPON", acc);
    const r = row(tradeId)!;
    expect([r.grossPnl, r.chargesTotal, r.netPnl]).toEqual([s.grossPnl, s.charges, s.netPnl]);
    expect(s.netPnl).toBe(497.94);
    selectAccount(acc);
    const cap = (await import("@/lib/queries/capital")).getCapitalSummary();
    expect([cap.equityRealised, cap.totalRealised]).toEqual([497.94, 497.94]);
  });

  it("TAX-IPO-LINK · an exit saved on /ipos closes the linked holding: the tax base, the ITR export and POST /api/ais count that sale once (the holding's), while /ipos' own book still reads the IPO realised", async () => {
    const acc = 1457; // this it's own account
    t.db.insert(t.schema.accounts).values({ id: acc, name: `fixE ${acc}`, isDefault: false }).run();
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: acc, broker: "zerodha", segment: "eq_delivery", symbol: "SEAMIPOT", tradingsymbol: "SEAMIPOT", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: acc, name: "SEAMIPOT", appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: null, exitDate: null, allotmentDate: "2019-01-10", tradeId })
      .run();
    const e = page("SEAMIPOT", acc);
    const sold = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(sold.status).toBe(200);
    const h = row(tradeId)!;
    expect([h.isOpen, h.sellDate, h.buyValue, h.sellValue]).toEqual([false, "2026-03-02", 1000, 1500]);
    expect(page("SEAMIPOT", acc).realised).toBe(true);

    selectAccount(acc);
    const taxItr = await import("@/lib/queries/tax-itr");
    const base = taxItr.getTaxBase();
    expect([base.exitedIpos.length, base.ipoTaxRows.length, base.cgTrades.map((c) => c.netPnl)]).toEqual([0, 0, [h.netPnl]]);
    expect(taxItr.getItrExportRows().map((r) => r.scrip)).toEqual(["SEAMIPOT"]);
    expect(taxByFy([...base.taxRows, ...base.ipoTaxRows]).map((f) => [f.fy, f.trades, f.totalRealised])).toEqual([["2025-26", 1, h.netPnl]]);

    const aisRoute = await import("@/app/api/ais/route");
    const res = await aisRoute.POST(json("/api/ais", { text: "nothing to parse" }));
    const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
    expect(recon.fyTotals.map((f) => [f.fy, f.kind, f.journal])).toEqual([["2018-19", "purchase", 1000], ["2025-26", "sale", 1500]]);
  });

  it("not allotted: no date input is rendered, the untouched stored value goes back and is kept (nothing the user cannot see is cleared)", async () => {
    t.db.insert(t.schema.ipos).values({ accountId: F_ACC, name: "SEAMIPO-NA", appliedPrice: 100, lotSize: 10, allotted: false, allottedQty: 0, exitDate: "15-03-2011" }).run();
    const e = page("SEAMIPO-NA");
    const html = formHtml(e);
    expect(renderedExitDate(html)).toBeUndefined();
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(e, html, { notes: "not allotted" })));
    expect(res.status).toBe(200);
    expect([stored("SEAMIPO-NA").notes, stored("SEAMIPO-NA").exitDate]).toEqual(["not allotted", "15-03-2011"]);
  });
});

// ============================================================================
// E-g — H6's per-account grouping ↔ StrategiesClient ↔ StrategyCard
// ============================================================================

describe("E-g · /strategies on All accounts for the re-check's FA / FB / RA / RB book, plus a covered call in RC (lib/queries/trades.ts → H6 page → StrategiesClient groups → StrategyCard)", () => {
  type Group = { key: string; symbol: string; nearestExpiry: string | null } & Record<string, unknown>;
  const optionRow = (accountId: number, symbol: string, strike: number, premium: number) =>
    tradeRow({
      accountId, broker: "angelone", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NFO", symbol,
      tradingsymbol: `${symbol}${strike}CESEP26`, optionType: "CE", strike, expiry: "2026-09-24", isOpen: true, sellQty: 100, avgSellPrice: premium,
    });
  const shares = (accountId: number, symbol: string, price: number, isin: string | null = null) =>
    tradeRow({ accountId, broker: "angelone", symbol, tradingsymbol: symbol, isin, isOpen: true, buyQty: 100, avgBuyPrice: price, buyDate: "2026-09-01" });
  type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
  const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
  function findElem(node: unknown, pick: (e: Elem) => boolean): Elem | null {
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = findElem(n, pick);
        if (hit) return hit;
      }
      return null;
    }
    if (!isElem(node)) return null;
    if (pick(node)) return node;
    return findElem(node.props.children, pick);
  }
  /** The groups the page hands the client, and each one's card as StrategyCard renders it. */
  function cardsOf(accountId: number) {
    selectAccount(accountId);
    const el = findElem(strategiesPage(), (e) => e.type === StrategiesClient);
    if (!el) throw new Error("the strategies page no longer renders <StrategiesClient>");
    const groups = el.props.groups as Group[];
    return groups.map((g) => {
      const { key, ...rest } = g;
      const card = textOf(renderToStaticMarkup(React.createElement(StrategyCard, { group: g as never, chart: null })));
      return { key, symbol: g.symbol, expiry: g.nearestExpiry, body: JSON.stringify(rest), card };
    });
  }

  it("each account alone: FA and RA show no card, FB and RB a naked call, RC a covered call", () => {
    const isin = bundledIsinBySymbol("IBULHSGFIN");
    expect(isin === bundledIsinBySymbol("SAMMAANCAP")).toBe(true);
    t.db
      .insert(t.schema.trades)
      .values([
        shares(G_FA, "Indiabulls Housing Finance Ltd", 140, isin),
        optionRow(G_FB, "SAMMAANCAP", 150, 5),
        shares(G_RA, "RELIANCE", 1400),
        optionRow(G_RB, "RELIANCE", 1500, 5),
        shares(G_RC, "RELIANCE", 1380),
        optionRow(G_RC, "RELIANCE", 1500, 7),
      ])
      .run();
    freezeAt("2026-09-08T09:30:00.000Z");
    const alone = G_ACCOUNTS.map((id) => cardsOf(id).map((c) => [c.symbol, c.card.includes("Unlimited")]));
    expect(alone).toEqual([[], [["SAMMAANCAP", true]], [], [["RELIANCE", true]], [["RELIANCE", false]]]);
  });

  it("All accounts: the cards are exactly the union of the single-account cards, in the engine's order, each with its own key", () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    const union = G_ACCOUNTS.flatMap((id) => cardsOf(id));
    const all = cardsOf(0);
    // THE assertions (on revert of app/strategies/page.tsx: two cards — one
    // RELIANCE card holding RA's, RB's and RC's legs, and FB's call covered by
    // FA's shares — neither of which any single account shows).
    expect(all.map((c) => c.card)).toEqual(
      [...union].sort((a, b) => (a.expiry ?? "").localeCompare(b.expiry ?? "") || a.symbol.localeCompare(b.symbol)).map((c) => c.card),
    );
    expect(all.map((c) => c.body).sort()).toEqual(union.map((c) => c.body).sort());
    expect(new Set(all.map((c) => c.key)).size).toBe(all.length);
    expect(all.map((c) => [c.symbol, c.card.includes("Unlimited")])).toEqual([
      ["RELIANCE", true],
      ["RELIANCE", false],
      ["SAMMAANCAP", true],
    ]);
  });
});
