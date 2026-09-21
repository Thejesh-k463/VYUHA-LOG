import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { hasLadder } from "@/lib/queries/staged";
import { chargeInputsChanged, chargeInputsOf, patchMovesChargeInput, statesNoCharges, storedCharges } from "@/lib/domain/trade-edit";
import type { ChargeBreakdown } from "@/lib/engine/types";
import { classify } from "@/lib/engine/classify";
import { computeCharges } from "@/lib/engine/charges";
import { findRates, pricingDate } from "@/lib/engine/rates";
import { todayIstIso } from "@/lib/domain/trading-day";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { SEGMENT_BUCKET, BROKERS, type Segment } from "@/lib/domain/constants";
import { getMarginPct } from "@/lib/queries/margin";
import { getSettings } from "@/lib/queries/settings";
import { getPerTradeCap } from "@/lib/queries/limits";
import { defaultMtfFundedAmount } from "@/lib/risk/margin";
import { ipoEditCharges } from "@/lib/analytics/ipo";
import { sellChargerFor } from "@/lib/queries/ipos";

export const runtime = "nodejs";

/** Rupees at the paisa, the unit the columns store (invariant 1). */
const r2 = (n: number) => Math.round(n * 100) / 100;

const Body = z.object({
  broker: z.enum(BROKERS),
  tradingsymbol: z.string().min(1),
  productHint: z.enum(["intraday", "delivery", "mtf"]).nullish(),
  segment: z.string().nullish(),
  exchange: z.enum(["NSE", "BSE", "MCX"]).nullish(),
  buyValue: z.number().nonnegative(),
  sellValue: z.number().nonnegative(),
  buyQty: z.number().nonnegative(),
  sellQty: z.number().nonnegative(),
  // A SENT count wins; an omitted one is filled from settings below (V4).
  buyOrders: z.number().int().min(0).optional(),
  sellOrders: z.number().int().min(0).optional(),
  ownCapitalUsed: z.number().nonnegative().nullish(),
  /** Q-A (v4.3.0 wave 2N) — "this row's funded amount is NOT recorded", sent by
   *  the two dialogs that price an EXISTING row (the close dialog and the trade
   *  editor). Their saves keep the null and bill no interest for it, so the
   *  preview must too. The manual Add form never sets it: a NEW trade with the
   *  own-capital field left blank is still estimated by `commitManualTrade`,
   *  which is the one writer the ruling leaves alone. */
  mtfFundingUnstated: z.boolean().nullish(),
  daysHeld: z.number().nonnegative().nullish(),
  grossPnl: z.number().nullish(),
  isOpen: z.boolean().nullish(),
  // D4 (v4.3.0 wave 2N) — the row being EDITED, sent by the trade editor alone
  // (`editPreviewBody`). With it this route can answer the question its save
  // answers: does this edit change anything the engine is fed? If not, the row's
  // stored charges stand, and the preview shows exactly what the save will keep.
  // The other two callers (the close dialog, the manual Add form) send none and
  // are priced as before.
  tradeId: z.number().int().positive().nullish(),
  avgBuyPrice: z.number().nullish(),
  avgSellPrice: z.number().nullish(),
  // The trade's own dates (R56). Every SAVE prices at pricingDate — the sell
  // date, else the buy date — so a preview priced at today's epoch showed a
  // figure the save would not store. Today (IST) is only the fallback.
  buyDate: z.string().nullish(),
  sellDate: z.string().nullish(),
});

/**
 * D20 (v4.3.0 wave 2O) — the two sentences a STAGED parent's preview states, and
 * why there are two copies of the first one.
 *
 * `updateManualTrade` (lib/import/commit.ts, the D20 block) answers the REFUSAL
 * verbatim for a patch that moves a fill on a ladder. It is a literal there, in a
 * module this route may not edit, so the matrix pins the two copies EQUAL instead
 * (`tests/preview-equals-save-matrix.test.ts`, "the preview carries the save's own
 * refusal" — `shown.keptReason === res.message`): a drifted copy is a red, not a
 * silent divergence.
 */
const LADDER_REFUSAL =
  "This is a staged position built from more than one fill, so its quantities, prices and dates are not edited here: they are the fills on its own ladder in Trades, which prices each tranche and rolls them up into this row. Edit the fill there. Nothing was changed.";
const LADDER_PRICES_IT =
  "This position is priced by its own ladder in Trades: each tranche is priced and rolled up into this row, so these are the charges it states.";

/**
 * D4 (v4.3.0 wave 2N) — the charges the trade editor's save would KEEP for this
 * body, or null when the save would re-price (and the engine below prices it).
 *
 * The stored row is read in the account being viewed (invariant 8: a trade id from
 * another book reads as "not found", and the preview is then priced fresh, exactly
 * as it was before this route could see a row at all).
 *
 * D14 (wave 2O): it returns the LOADED ROW beside that answer, so the IPO branch
 * below prices from the same facts with no second query — and only ever for a row
 * this account's book actually holds.
 */
function keptCharges(
  tradeId: number,
  v: z.infer<typeof Body>,
): {
  row: Record<string, unknown>;
  kept: { breakdown: ChargeBreakdown; netPnl: number } | null;
  /** D20: set only for a STAGED parent — the sentence to state, and the gross the
   *  save leaves standing (the parent's own roll-up, never the body's). */
  ladder?: { reason: string; grossPnl: number };
} | null {
  const accountId = getSelectedAccountId();
  const where = accountId > 0 ? and(eq(trades.id, tradeId), eq(trades.accountId, accountId)) : eq(trades.id, tradeId);
  const t = db.select().from(trades).where(where).get();
  if (!t) return null;

  // D20 (v4.3.0 wave 2O, the seam round's readers-left #1) — A STAGED PARENT IS
  // PRICED ONLY BY ITS LADDER, AND THIS PREVIEW SHOWS THE LADDER'S OWN BILL.
  //
  // `rebuildStagedTrade` is the single writer of such a row's priced heads
  // (invariant 5: parent = Σ legs), so `updateManualTrade` never prices one: a
  // patch that moves no fill keeps every stored head and hands the pricing back
  // to the ladder, and a patch that MOVES one is refused with nothing written.
  // Either way the row keeps the bill it states — which is what this route must
  // therefore show.
  //
  // It used to know nothing of legs, so it priced the FLAT round trip
  // `computeCharges` bills on the aggregate: measured on a 100 @100 + 50 @110
  // delivery ladder (parent `[150, 103.33, 15500]`), the dialog answered
  // `{"total":17.59,"kept":false,"netPnl":-17.59}` beside a row storing the
  // ladder's 19.59 — two entry tranches pay two lots of every per-order head.
  // `editPreviewBody` sends `buyValue = buyQty × avgBuyPrice` (15,499.4999…), so
  // the flat predicate below could never answer "kept" for a ladder either.
  //
  // THE SAME PREDICATE AS THE SAVE (`hasLadder`, lib/queries/staged — D5, wave 2P:
  // one leg-count question for every door) and the same question asked of the
  // PATCH (`patchMovesChargeInput`, lib/domain/trade-edit), so the two doors
  // cannot drift.
  if (hasLadder(t, tradeId)) {
    const stagedRow = t as unknown as Record<string, unknown>;
    // Own capital is NOT asked here, though the save asks it: the body carries a
    // figure the dialog DERIVED from the stored one when the field was left
    // untouched (`currentOwnCapital`), and on a ladder that derivation does not
    // round-trip — `buyQty × avgBuyPrice` is half a rupee off Σ the leg values,
    // so an untouched field would read as a moved principal and a notes-only edit
    // would be told it was refused. Nothing shown moves either way (the row's own
    // bill is the answer on both branches); only the sentence would be wrong.
    const moved = patchMovesChargeInput(
      {
        buyQty: v.buyQty,
        sellQty: v.sellQty,
        ...(v.avgBuyPrice != null ? { avgBuyPrice: v.avgBuyPrice } : {}),
        ...(v.avgSellPrice != null ? { avgSellPrice: v.avgSellPrice } : {}),
        ...(v.buyDate !== undefined ? { buyDate: v.buyDate ?? null } : {}),
        ...(v.sellDate !== undefined ? { sellDate: v.sellDate ?? null } : {}),
      },
      t,
    );
    return {
      row: stagedRow,
      kept: { breakdown: storedCharges(stagedRow), netPnl: t.netPnl },
      ladder: { reason: moved ? LADDER_REFUSAL : LADDER_PRICES_IT, grossPnl: Number(t.grossPnl) || 0 },
    };
  }

  const s = getSettings();
  const defaults = { buyOrders: s?.defaultBuyOrders ?? 1, sellOrders: s?.defaultSellOrders ?? 1 };
  const buyQty = v.buyQty;
  const sellQty = v.sellQty;
  const next = chargeInputsOf(
    {
      buyQty,
      avgBuyPrice: v.avgBuyPrice ?? (buyQty > 0 ? v.buyValue / buyQty : 0),
      buyValue: v.buyValue,
      buyDate: v.buyDate ?? null,
      sellQty,
      avgSellPrice: v.avgSellPrice ?? (sellQty > 0 ? v.sellValue / sellQty : 0),
      sellValue: v.sellValue,
      sellDate: v.sellDate ?? null,
      isOpen: v.isOpen ?? buyQty !== sellQty,
      buyOrderCount: v.buyOrders ?? defaults.buyOrders,
      sellOrderCount: v.sellOrders ?? defaults.sellOrders,
      // The funded amount the SAVE would store: an explicit own-capital entry wins,
      // otherwise the row keeps what it has — a stated 0 (V3) and a NULL alike
      // (Q-A, wave 2N: `updateManualTrade` no longer estimates one, so a preview
      // that did would call a notes-only save on an unpriced row a re-price).
      mtfFundedAmount:
        t.segment === "eq_mtf"
          ? v.ownCapitalUsed != null && v.ownCapitalUsed >= 0
            ? Math.max(0, Math.round((v.buyValue - v.ownCapitalUsed) * 100) / 100)
            : t.mtfFundedAmount
          : null,
    },
    defaults,
  );
  const row = t as unknown as Record<string, unknown>;
  if (statesNoCharges(row) || chargeInputsChanged(chargeInputsOf(t, defaults), next)) return { row, kept: null };
  return { row, kept: { breakdown: storedCharges(row), netPnl: t.netPnl } };
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const v = parsed.data;
  // V4 — ONE default for a side's order count: settings.defaultBuyOrders /
  // defaultSellOrders, the count the saves bill for a side that gains its first
  // quantity (commitManualTrade, updateManualTrade, closePosition). No settings
  // row: 1, as lib/import/commit.ts loadRatesContext.
  const s = v.buyOrders === undefined || v.sellOrders === undefined ? getSettings() : null;
  const buyOrders = v.buyOrders ?? s?.defaultBuyOrders ?? 1;
  const sellOrders = v.sellOrders ?? s?.defaultSellOrders ?? 1;

  let cls = classify({
    tradingsymbol: v.tradingsymbol,
    broker: v.broker,
    productHint: v.productHint ?? null,
    exchangeHint: v.exchange ?? null,
  });
  if (v.segment) {
    const segment = v.segment as Segment;
    cls = { ...cls, segment, bucket: SEGMENT_BUCKET[segment], exchange: v.exchange ?? cls.exchange };
  }

  // D4 — the editor's save keeps every stored head when no charge input moved
  // (lib/import/commit.ts#updateManualTrade, one pure predicate in
  // lib/domain/trade-edit.ts). The preview must say the same, or the dialog shows
  // ₹52.72 beside a row that keeps ₹37.97 — the divergence
  // tests/preview-equals-save-matrix.test.ts exists to catch.
  const edited = v.tradeId == null ? null : keptCharges(v.tradeId, v);
  if (edited?.kept) {
    // D20: a STAGED parent's gross is its own roll-up (Σ its leg values), not the
    // body's `sellValue − buyValue` — the save writes the roll-up back verbatim,
    // and on a refusal it writes nothing at all. A flat row keeps the body's gross,
    // exactly as before.
    const grossKept = edited.ladder ? edited.ladder.grossPnl : v.grossPnl ?? v.sellValue - v.buyValue;
    return NextResponse.json({
      classification: cls,
      breakdown: edited.kept.breakdown,
      grossPnl: grossKept,
      netPnl: edited.kept.netPnl,
      // Said out loud, so a caller that renders the figure can say whose it is.
      keptCharges: true,
      // …and WHY, when the answer is the ladder's: the save's own refusal for a
      // patch that moves a fill, else "this position is priced by its ladder".
      // An extra field, so the dialog renders the figures unchanged.
      ...(edited.ladder ? { keptReason: edited.ladder.reason } : {}),
    });
  }

  // D14 / D15 (v4.3.0 wave 2O) — AN ALLOTMENT-DERIVED ROW IS PRICED THE WAY THE
  // SAVE PRICES IT.
  //
  // D4(b) taught `updateManualTrade` an IPO mode; this route learned only the KEEP
  // branch above, so on any edit that MOVES a charge input on an
  // `acquisition:'ipo'` row the `computeCharges` fall-through below priced a
  // delivery ROUND TRIP — purchase STT on an allotment, which ruling row (1) says
  // is not due (measured: 18.43 / net 581.57 shown beside a row storing 17.40 /
  // 582.60). ONE pure helper (`ipoEditCharges`, lib/analytics/ipo.ts) with the
  // charger injected here (invariants 2 and 3), read by both doors.
  //
  // Identity is not editable in that dialog, so `broker`, `exchange` and
  // `acquisitionDate` — and the two heads the IPO model prices NEITHER of — come
  // from the STORED row, never from the body. The values are rounded to the paisa
  // exactly as the save rounds them, so the two agree by construction.
  const rates = loadRatesMap();
  if (edited) {
    const stored = edited.row;
    const gross = v.grossPnl ?? v.sellValue - v.buyValue;
    const priced = ipoEditCharges(
      stored,
      {
        buyValue: r2(v.buyValue),
        sellValue: r2(v.sellValue),
        sellQty: v.sellQty,
        buyDate: v.buyDate ?? null,
        sellDate: v.sellDate ?? null,
      },
      sellChargerFor((stored.broker as string | null) ?? null, (stored.exchange as string | null) ?? "NSE", v.sellDate ?? null, rates),
    );
    if (priced) {
      return NextResponse.json({
        classification: cls,
        breakdown: priced.charges,
        grossPnl: gross,
        // D15: an un-exited allotment is priced at NOTHING, so the save keeps the
        // net the row states — and the dialog says whose figure it is showing.
        netPnl: priced.repriced ? r2(gross - priced.charges.total) : Number(stored.netPnl) || 0,
        ...(priced.repriced ? {} : { keptCharges: true }),
      });
    }
  }

  let breakdown;
  try {
    const r = findRates(rates, v.broker, cls.segment, cls.exchange, pricingDate({ buyDate: v.buyDate, sellDate: v.sellDate }, todayIstIso()));
    // Mirror commitManualTrade's MTF defaulting exactly, so the preview never
    // understates what actually gets saved: ownCapitalUsed (what YOU put in) is
    // the primary input, funded = buyValue − ownCapitalUsed; no explicit entry →
    // auto-estimate from margin_config's eq_mtf %. daysHeld forced to 0 for an
    // open position (interest hasn't accrued yet — see lib/jobs/mtf-accrual.ts).
    const isMtf = cls.segment === "eq_mtf";
    const fundedAmount = isMtf
      ? v.ownCapitalUsed != null && v.ownCapitalUsed >= 0
        ? Math.max(0, Math.round((v.buyValue - v.ownCapitalUsed) * 100) / 100)
        : // Q-A — a row whose funding the journal never recorded bills no
          // interest, exactly as closePosition / updateManualTrade now store it.
          // AND NO PLEDGE FEE (D12, wave 2O): this comment used to claim the row
          // kept one, which `lib/engine/charges.ts:106` does not
          // do — it gates interest AND pledge on the same `fundedAmount > 0`, so a
          // 0 bills neither and an unpriced row is previewed and saved identically
          // to a stated 0. The recorded deviation (DECISIONS 2026-09-16, wave 2N);
          // billing pledge alone would need an engine change, which was not made.
          v.mtfFundingUnstated
          ? 0
          : defaultMtfFundedAmount(v.buyValue, getMarginPct(v.broker, "eq_mtf"))
      : null;
    const daysHeld = v.isOpen ? 0 : v.daysHeld ?? 0;
    breakdown = computeCharges(
      {
        segment: cls.segment,
        buyValue: v.buyValue,
        sellValue: v.sellValue,
        buyQty: v.buyQty,
        sellQty: v.sellQty,
        buyOrderCount: buyOrders,
        sellOrderCount: sellOrders,
        mtf: isMtf ? { fundedAmount: fundedAmount!, daysHeld, pledgeScrips: 1 } : null,
      },
      r,
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const gross = v.grossPnl ?? v.sellValue - v.buyValue;
  return NextResponse.json({
    classification: cls,
    breakdown,
    grossPnl: gross,
    netPnl: Math.round((gross - breakdown.total) * 100) / 100,
    // D1 (v4.4.0) — the per-trade cap this classification resolves to, through
    // THE resolver: what a save with no stop and no typed risk stores as the
    // row's risk (commitManualTrade), so the Add form can state it ("from SL,
    // else your ₹X cap") instead of a literal. Null = no cap configured, and
    // then the save stores no risk and no R (invariant 6).
    perTradeCap: getPerTradeCap(cls.bucket, cls.segment),
  });
}
