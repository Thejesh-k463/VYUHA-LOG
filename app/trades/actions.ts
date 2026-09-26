"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades, ipos as iposTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { commitManualTrade, applyOverride, closePosition, updateManualTrade, type UpdateTradeFields } from "@/lib/import/commit";
import { deleteTradesByIds, deleteImportBatch } from "@/lib/queries/delete";
import { SEGMENTS, EXCHANGES, SEGMENT_BUCKET, BROKERS, type Segment } from "@/lib/domain/constants";
import { classify } from "@/lib/engine/classify";
import { evaluateLimits } from "@/lib/risk/limits";
import { resolveRules, getPortfolioState } from "@/lib/queries/limits";
import type { NormalizedTrade } from "@/lib/engine/types";
import { ipoSeedFromTrade } from "@/lib/analytics/ipo-link";
import { normalizeDate, unreadableDateMessage } from "@/lib/domain/trading-day";
import { sideOf } from "@/lib/domain/side";
import { signalFromForm, parseFormNumber } from "@/lib/domain/signal";
import { recordAudit } from "@/lib/audit";
import { AccountRequiredError, getSelectedAccountId, getWriteAccountId } from "@/lib/queries/accounts";
import {
  addLeg,
  updateLeg,
  deleteLeg,
  applyStopToOpenTranches,
  convertToStaged,
  hasLadder,
} from "@/lib/queries/staged";

export type ActionState = {
  ok: boolean;
  message: string;
  tradeId?: number | null;
  /** Stable refusal code — `ACCOUNT_REQUIRED` when the write has no account
   *  to land on (All accounts selected, no accountId in the form); `STAGED`
   *  when the row holds `trade_legs` and the write would leave the parent
   *  aggregate unsummed (the same code `closePosition` returns). The
   *  server-action analogue of the routes' 400 `{code}`. */
  code?: "ACCOUNT_REQUIRED" | "STAGED";
};

/**
 * A typed number, read by THE form-number rule (`parseFormNumber`, lib/domain/signal.ts —
 * SIG-1) rather than by stripping every comma (v4.4.0 fix list): Indian "1,23,456.50" reads
 * 123456.5, and a decimal-comma "14,48" is REFUSED instead of stored as 1448. Blank → 0, the
 * forms' blank-means-0/null convention, unchanged. A refused value reads NaN here, and every
 * action that calls this asks `numberProblem` first, so NaN never reaches a writer. Rupees and
 * units at runtime (invariant 1) — nothing here converts to paise.
 */
const num = (v: FormDataEntryValue | null) => {
  const s = typedNumber(v);
  if (s === "") return 0;
  return parseFormNumber(s) ?? NaN;
};
/**
 * The raw field, trimmed, with the HTML number input's leading-dot spelling (".5", "-.5" is a
 * valid floating-point number there and is submitted as typed) given its zero. Not a second
 * rule: commas, exponents and everything else stay `parseFormNumber`'s to accept or refuse.
 */
const typedNumber = (v: FormDataEntryValue | null) =>
  String(v ?? "").trim().replace(/^([-+]?)\.(?=\d)/, (_m, sign: string) => `${sign}0.`);

/** Every numeric field the trade forms post, with the label its refusal names. */
const NUMBER_FIELDS: Record<string, string> = {
  buyQty: "Buy qty",
  avgBuyPrice: "Avg buy price",
  sellQty: "Sell qty",
  avgSellPrice: "Avg sell price",
  exitPrice: "Exit price",
  qty: "Quantity",
  price: "Price",
  closingPrice: "Closing price",
  currentPrice: "Current price",
  slPlanned: "SL",
  trailingSl: "Trailing SL",
  targetPlanned: "Target",
  riskAmount: "Risk amount",
  ownCapitalUsed: "Own capital used",
  daysHeld: "Days held",
  lotSize: "Lot size",
};

/**
 * The refusal for the first numeric field the form-number rule cannot read, or null. Asked at
 * the top of every action that reads `num()` / `ownCapital()`, before anything is written, so a
 * refused value is a sentence naming its field — never 1448, and never a silent blank.
 */
function numberProblem(formData: FormData): string | null {
  for (const [name, label] of Object.entries(NUMBER_FIELDS)) {
    const s = typedNumber(formData.get(name));
    if (s !== "" && parseFormNumber(s) == null) {
      return `${label} “${String(formData.get(name)).trim()}” is not a number — a comma is read only as a thousands separator (1,448 or 1,23,456.50). Nothing was saved.`;
    }
  }
  return null;
}
const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};
/** The edit dialog posts `riskAmountOpened` (the value it was prefilled with);
 *  true when the posted risk is that same figure. A form without the field (a
 *  stale tab, another client) keeps the old "always posted" reading. */
const riskFieldUnchanged = (fd: FormData): boolean =>
  fd.has("riskAmountOpened") && (num(fd.get("riskAmount")) || null) === (num(fd.get("riskAmountOpened")) || null);
/**
 * "Own capital used" (MTF): blank or missing → null (keep / estimate); a typed 0
 * is a STATED figure — the whole position broker-funded — as both forms' previews
 * price it. `num(...) || null` read that 0 as blank (X2, 4.3.0).
 */
const ownCapital = (v: FormDataEntryValue | null) => {
  const s = typedNumber(v);
  if (s === "") return null;
  // The form-number rule too (a refused value was already answered by `numberProblem`).
  return parseFormNumber(s);
};

/**
 * THE SIGNAL BOOK's form door (v4.3.0).
 *
 * The section posts the user's RAW strings as `signal.<field>` plus a hidden
 * `signalPresent=1`, and `signalFromForm` (lib/domain/signal.ts, pure) is what
 * turns them into the stored envelope — SERVER-SIDE, so a typed "14,48" or
 * "abc" is REFUSED here rather than quietly becoming null in the browser and
 * arriving as a gap the client never mentioned.
 *
 * `signalPresent` absent means the section was never opened (Add) or nothing in
 * it was touched (Edit): `undefined`, which the writers read as "not mentioned"
 * and keep. Present with every field blank IS a statement — an explicit clear.
 */
function signalFromFormData(formData: FormData) {
  if (!formData.has("signalPresent")) return undefined;
  return signalFromForm((k) => str(formData.get(`signal.${k}`)));
}

const ManualSchema = z.object({
  broker: z.enum(BROKERS),
  tradingsymbol: z.string().min(1, "Symbol is required"),
  productHint: z.enum(["intraday", "delivery", "mtf"]).nullable(),
  segment: z.string().nullable(),
  exchange: z.string().nullable(),
});

export async function createManualTrade(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const badNumber = numberProblem(formData);
  if (badNumber) return { ok: false, message: badNumber };
  const base = ManualSchema.safeParse({
    broker: formData.get("broker"),
    tradingsymbol: formData.get("tradingsymbol"),
    productHint: str(formData.get("productHint")) as never,
    segment: str(formData.get("segment")),
    exchange: str(formData.get("exchange")),
  });
  if (!base.success) return { ok: false, message: base.error.issues[0]?.message ?? "Invalid input" };

  const isOpenTrade = String(formData.get("open") ?? "") === "true";
  // Direction: "buy" (long, the default — preserves prior behavior for equity) or
  // "sell" (short / sell-to-open, e.g. a written CE/PE). The form's primary
  // qty/price/date fields always carry the ENTRY leg; the secondary set (only
  // present for a closed round-trip) carries the EXIT leg. Direction decides
  // which DB column pair (buy* vs sell*) each leg lands in.
  const direction = String(formData.get("direction") ?? "buy") === "sell" ? "sell" : "buy";
  const entryQty = num(formData.get("buyQty"));
  const entryPrice = num(formData.get("avgBuyPrice"));
  const entryDate = str(formData.get("buyDate"));
  // Exit leg only exists for a closed round-trip; open trades have no exit yet.
  const exitQty = isOpenTrade ? 0 : num(formData.get("sellQty"));
  const exitPrice = isOpenTrade ? 0 : num(formData.get("avgSellPrice"));
  const exitDate = isOpenTrade ? null : str(formData.get("sellDate"));

  let buyQty: number, avgBuyPrice: number, buyDateVal: string | null;
  let sellQty: number, avgSellPrice: number, sellDateVal: string | null;
  if (direction === "sell") {
    sellQty = entryQty; avgSellPrice = entryPrice; sellDateVal = entryDate;
    buyQty = exitQty; avgBuyPrice = exitPrice; buyDateVal = exitDate;
  } else {
    buyQty = entryQty; avgBuyPrice = entryPrice; buyDateVal = entryDate;
    sellQty = exitQty; avgSellPrice = exitPrice; sellDateVal = exitDate;
  }
  const buyValue = Math.round(buyQty * avgBuyPrice * 100) / 100;
  const sellValue = Math.round(sellQty * avgSellPrice * 100) / 100;

  if (isOpenTrade && entryQty <= 0) return { ok: false, message: "Enter quantity and entry price." };
  if (entryQty <= 0 && exitQty <= 0) return { ok: false, message: "Enter buy and/or sell quantity." };

  const grossPnl =
    sellQty > 0 && buyQty > 0
      ? Math.round((sellValue - buyValue) * 100) / 100
      : 0;

  const segment = base.data.segment && SEGMENTS.includes(base.data.segment as never) ? base.data.segment : null;
  const exchange = base.data.exchange && EXCHANGES.includes(base.data.exchange as never) ? base.data.exchange : null;

  const t: NormalizedTrade = {
    broker: base.data.broker,
    tradingsymbol: base.data.tradingsymbol.trim(),
    isin: str(formData.get("isin")),
    buyQty,
    avgBuyPrice,
    buyValue,
    sellQty,
    avgSellPrice,
    sellValue,
    closingPrice: num(formData.get("closingPrice")) || null,
    grossPnl,
    unrealisedPnl: 0,
    buyDate: buyDateVal,
    sellDate: sellDateVal,
    productHint: base.data.productHint,
    exchangeHint: (exchange as never) ?? null,
    sourceFile: "manual",
  };

  // Pre-trade limit breaches at entry (P1.4) — recorded on open trades for the
  // journal/audit history. Evaluated against state BEFORE this trade is inserted.
  const slPlanned = num(formData.get("slPlanned")) || null;
  let ruleViolations: string[] | null = null;
  if (isOpenTrade) {
    try {
      const cls = classify({
        tradingsymbol: t.tradingsymbol,
        broker: base.data.broker,
        isin: t.isin,
        productHint: base.data.productHint,
        exchangeHint: (exchange as never) ?? null,
      });
      const seg = (segment as Segment) ?? cls.segment;
      const bkt = segment ? SEGMENT_BUCKET[seg] : cls.bucket;
      const verdict = evaluateLimits(
        { bucket: bkt, segment: seg, symbol: cls.symbol, entry: entryPrice, stop: slPlanned, qty: entryQty },
        resolveRules(bkt, seg),
        getPortfolioState(bkt, cls.symbol),
      );
      if (verdict.status !== "pass") {
        // Only real breaches belong in the journal's violation history — a
        // "skipped" check (rule configured but not evaluable, e.g. no capital
        // set) is neither a pass nor a violation.
        ruleViolations = verdict.checks
          .filter((c) => c.status === "warn" || c.status === "block")
          .map((c) => `${c.label}: ${c.message}`);
      }
    } catch { /* never block a save on the limits check */ }
  }

  // Refused BEFORE anything is written — nothing is half-saved (AGENTS.md: a
  // row it cannot read is refused, never coerced).
  const signal = signalFromFormData(formData);
  if (signal && !signal.ok) return { ok: false, message: signal.message };

  try {
    const res = commitManualTrade(t, {
      forcedSegment: (segment as never) ?? null,
      forcedExchange: (exchange as never) ?? null,
      setupTag: str(formData.get("setupTag")),
      notes: str(formData.get("notes")),
      ruleViolations,
      slPlanned,
      trailingSl: num(formData.get("trailingSl")) || null,
      targetPlanned: num(formData.get("targetPlanned")) || null,
      riskAmount: num(formData.get("riskAmount")) || null,
      ownCapitalUsed: ownCapital(formData.get("ownCapitalUsed")),
      daysHeld: num(formData.get("daysHeld")) || null,
      currentPrice: num(formData.get("currentPrice")) || null,
      lotSize: num(formData.get("lotSize")) || null,
      signalJson: signal?.ok ? signal.json : undefined,
    },
    // Present only when the form was submitted from the "All accounts" view.
    num(formData.get("accountId")) || null);
    if (res.duplicate) return { ok: false, message: "A matching trade already exists (duplicate)." };
    revalidatePath("/trades");
    revalidatePath("/risk");
    revalidatePath("/equity");
    revalidatePath("/active");
    revalidatePath("/");
    return { ok: true, message: isOpenTrade ? "Open trade added — see Portfolio Risk." : "Trade added.", tradeId: res.id };
  } catch (e) {
    if (e instanceof AccountRequiredError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, message: (e as Error).message };
  }
}

export async function overrideTrade(formData: FormData): Promise<void> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return;
  const segment = str(formData.get("segment"));
  const exchange = str(formData.get("exchange"));
  const isMtfRaw = str(formData.get("isMtf"));
  applyOverride(id, {
    segment: (segment as never) ?? null,
    exchange: (exchange as never) ?? null,
    isMtf: isMtfRaw == null ? null : isMtfRaw === "true",
    setupTag: str(formData.get("setupTag")),
  });
  revalidatePath("/trades");
  revalidatePath("/");
}

export async function deleteTrade(formData: FormData): Promise<void> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return;
  // Routed through the delete engine rather than deleting the row directly.
  // The old implementation removed `trades` and nothing else, orphaning
  // trade_legs and trade_attachments and leaving the attachment bytes on disk
  // forever, with no audit entry to say the trade had existed.
  deleteTradesByIds([id], "deleted from the trades table");
  revalidateAfterTradeChange();
}

/** Delete a resolved set of ids — the exact list the confirmation showed. */
export async function deleteTradesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const raw = String(formData.get("ids") ?? "");
  const reason = String(formData.get("reason") ?? "bulk delete");
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { ok: false, message: "Nothing was selected." };
  const res = deleteTradesByIds(ids, reason);
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/** Delete an import batch, optionally cascading to the trades it created. */
export async function deleteImportBatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const batchId = Number(formData.get("batchId"));
  const cascade = String(formData.get("cascade") ?? "") === "true";
  if (!Number.isFinite(batchId)) return { ok: false, message: "Invalid import." };
  const res = deleteImportBatch(batchId, cascade);
  if (res.ok) {
    revalidateAfterTradeChange();
    revalidatePath("/import");
  }
  return { ok: res.ok, message: res.message };
}

function revalidateAfterTradeChange() {
  for (const p of ["/trades", "/risk", "/equity", "/active", "/", "/reports/costs"]) revalidatePath(p);
}

/** Close an open position at an exit price/date — any segment (equity/MTF/options/futures). */
export async function closeTradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  const badNumber = numberProblem(formData);
  if (badNumber) return { ok: false, message: badNumber };
  const exitPrice = num(formData.get("exitPrice"));
  const exitDate = str(formData.get("exitDate"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  if (!(exitPrice > 0)) return { ok: false, message: "Enter a valid exit price." };
  const res = closePosition(id, exitPrice, exitDate);
  if (res.ok) revalidateAfterTradeChange();
  // R2-DQ N11 — a staged position's refusal (code STAGED) reaches the dialog
  // as its sentence; the table routes a staged row to its ladder before this.
  return { ok: res.ok, message: res.message };
}

/**
 * Edit any trade (open or closed), any time — qty/prices/dates/SL-TSL-target/
 * risk/MTF own-capital/notes. The form is always pre-filled with the trade's
 * current values, so every field round-trips its existing value unless the
 * user changes it — blank always means "clear this", matching the create
 * form's own blank-means-null convention (num() || null).
 */
export async function updateTradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  const badNumber = numberProblem(formData);
  if (badNumber) return { ok: false, message: badNumber };

  const signal = signalFromFormData(formData);
  if (signal && !signal.ok) return { ok: false, message: signal.message };

  // D9 (v4.3.0 wave 2P) — a date field ABSENT from the form (a stale tab, a
  // non-dialog client) is "not mentioned" (`undefined` in UpdateTradeFields), not
  // "clear this": the stored date is kept and a stored value that states no day
  // takes D17's refusal instead of being silently cleared and re-priced. A BLANK
  // field still clears, as every other field does. The rule is dates-only by
  // design: an absent `sellQty` still resolves to 0 through `num()` and re-opens
  // the row, so a stale tab is not otherwise safe.
  const fields: UpdateTradeFields = {
    buyQty: num(formData.get("buyQty")),
    avgBuyPrice: num(formData.get("avgBuyPrice")),
    buyDate: formData.has("buyDate") ? str(formData.get("buyDate")) : undefined,
    sellQty: num(formData.get("sellQty")),
    avgSellPrice: num(formData.get("avgSellPrice")),
    sellDate: formData.has("sellDate") ? str(formData.get("sellDate")) : undefined,
    slPlanned: num(formData.get("slPlanned")) || null,
    trailingSl: num(formData.get("trailingSl")) || null,
    targetPlanned: num(formData.get("targetPlanned")) || null,
    // D1 (v4.4.0, review S2) — a risk the dialog posts back EXACTLY as it opened
    // with is "not mentioned" (`undefined`): the row keeps its own rule, so a
    // cap-derived row re-reads today's cap. Without this, a dialog opened
    // before a cap edit and saved after it stored the old cap as the user's
    // choice. A changed field (typed, cleared, or re-derived from an SL edit)
    // is posted as before, and updateManualTrade decides whose it is.
    riskAmount: riskFieldUnchanged(formData) ? undefined : num(formData.get("riskAmount")) || null,
    ownCapitalUsed: ownCapital(formData.get("ownCapitalUsed")),
    setupTag: str(formData.get("setupTag")),
    exitTrigger: str(formData.get("exitTrigger")),
    notes: str(formData.get("notes")),
    currentPrice: num(formData.get("currentPrice")) || null,
    // The same "absent = not mentioned" rule the two dates take: only a form
    // that carried `signalPresent` says anything at all about the signal.
    signalJson: signal?.ok ? signal.json : undefined,
  };

  const res = updateManualTrade(id, fields);
  if (res.ok) revalidateAfterTradeChange();
  return res;
}

// ---------------------------------------------------------------------------
// Staged (scaled) positions — building a position in tranches and scaling out.
//
// Every mutation runs through lib/queries/staged.ts, which validates the
// PROSPECTIVE ladder before writing anything and then reprices the whole
// position. A rejected leg never leaves a half-applied trade behind.
// ---------------------------------------------------------------------------

function tradeDirection(id: number): "long" | "short" {
  const t = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!t) return "long";
  // Not buyQty === 0 — a partially covered short has buyQty > 0 and must stay
  // short, or the rebuilt P&L sign-inverts (fix A6). v4.6.0 W6: `sideOf`, so a
  // FLAT (closed) short also stays short.
  return sideOf(t);
}

/** Turn a plain trade into a staged one by seeding the ladder from its own
 *  numbers. Lossless — a one-entry ladder aggregates back to itself. */
export async function enableStagedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  const res = convertToStaged(id);
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/**
 * Add another entry to an open position.
 *
 * The pre-trade limits check runs on the ADD, not just on the original entry —
 * scaling in is exactly where position size quietly outgrows the plan, so the
 * same advisory guardrails apply. Advisory only: it never blocks, matching the
 * rest of the app.
 */
export async function addEntryLegAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  const badNumber = numberProblem(formData);
  if (badNumber) return { ok: false, message: badNumber };
  const qty = num(formData.get("qty"));
  const price = num(formData.get("price"));
  const tradeDate = str(formData.get("tradeDate"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  if (!(qty > 0)) return { ok: false, message: "Enter a quantity greater than zero." };
  if (!(price > 0)) return { ok: false, message: "Enter a valid price." };
  if (!tradeDate) return { ok: false, message: "Pick the date of this entry." };

  const t = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!t) return { ok: false, message: "Trade not found." };

  if (!t.staged) {
    const conv = convertToStaged(id);
    if (!conv.ok) return { ok: false, message: conv.message };
  }

  const res = addLeg({
    tradeId: id,
    kind: "entry",
    tradeDate,
    tradeTime: str(formData.get("tradeTime")),
    qty,
    price,
    slPlanned: num(formData.get("slPlanned")) || null,
    trailingSl: num(formData.get("trailingSl")) || null,
    targetPlanned: num(formData.get("targetPlanned")) || null,
    note: str(formData.get("note")),
    direction: tradeDirection(id),
  });
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/**
 * Book a partial (or full) exit. Available on ANY trade — a plain single-entry
 * trade is converted to a staged one on the fly, which is lossless, so
 * "book half at target and trail the rest" needs no mode switch.
 */
export async function addExitLegAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  const badNumber = numberProblem(formData);
  if (badNumber) return { ok: false, message: badNumber };
  const qty = num(formData.get("qty"));
  const price = num(formData.get("price"));
  const tradeDate = str(formData.get("tradeDate"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  if (!(qty > 0)) return { ok: false, message: "Enter a quantity greater than zero." };
  if (!(price > 0)) return { ok: false, message: "Enter a valid exit price." };
  if (!tradeDate) return { ok: false, message: "Pick the date of this exit." };

  const t = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!t) return { ok: false, message: "Trade not found." };
  if (!t.isOpen) return { ok: false, message: "This position is already closed." };

  if (!t.staged) {
    const conv = convertToStaged(id);
    if (!conv.ok) return { ok: false, message: conv.message };
  }

  const res = addLeg({
    tradeId: id,
    kind: "exit",
    tradeDate,
    tradeTime: str(formData.get("tradeTime")),
    qty,
    price,
    note: str(formData.get("note")),
    direction: tradeDirection(id),
  });
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/** Edit one fill — quantity, price, date, or its own stop. */
export async function updateLegAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const legId = Number(formData.get("legId"));
  const tradeId = Number(formData.get("tradeId"));
  if (!Number.isFinite(legId)) return { ok: false, message: "Invalid leg." };
  const badNumber = numberProblem(formData);
  if (badNumber) return { ok: false, message: badNumber };

  const res = updateLeg(
    legId,
    {
      qty: num(formData.get("qty")) || undefined,
      price: num(formData.get("price")) || undefined,
      tradeDate: str(formData.get("tradeDate")) ?? undefined,
      slPlanned: formData.has("slPlanned") ? num(formData.get("slPlanned")) || null : undefined,
      trailingSl: formData.has("trailingSl") ? num(formData.get("trailingSl")) || null : undefined,
      targetPlanned: formData.has("targetPlanned") ? num(formData.get("targetPlanned")) || null : undefined,
      note: formData.has("note") ? str(formData.get("note")) : undefined,
    },
    Number.isFinite(tradeId) ? tradeDirection(tradeId) : undefined,
  );
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/** Remove a fill. Refused when it would leave the ladder inconsistent. */
export async function deleteLegAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const legId = Number(formData.get("legId"));
  const tradeId = Number(formData.get("tradeId"));
  if (!Number.isFinite(legId)) return { ok: false, message: "Invalid leg." };
  const res = deleteLeg(legId, Number.isFinite(tradeId) ? tradeDirection(tradeId) : undefined);
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/** Write one stop across every OPEN tranche — the "apply to all" button. */
export async function applyStopAllAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };

  const hasSl = formData.has("slPlanned");
  const hasTsl = formData.has("trailingSl");
  if (!hasSl && !hasTsl) return { ok: false, message: "Nothing to apply." };
  const badNumber = numberProblem(formData);
  if (badNumber) return { ok: false, message: badNumber };

  const res = applyStopToOpenTranches(
    id,
    {
      ...(hasSl ? { slPlanned: num(formData.get("slPlanned")) || null } : {}),
      ...(hasTsl ? { trailingSl: num(formData.get("trailingSl")) || null } : {}),
    },
    tradeDirection(id),
  );
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/**
 * Set how a holding was acquired, and what it cost.
 *
 * This is the resolution step for a trade the importer could not price: sold
 * inside the window, bought before it. Until a basis is supplied the trade is
 * counted in cash but held out of win rate, expectancy, profit factor and ROM,
 * because `buyValue = 0` would otherwise read as a 100% win — the single most
 * flattering lie the journal could tell.
 *
 * Supplying the price recomputes gross and net P&L from the sale that already
 * happened. Charges are left untouched: they were always real and were never
 * the thing in doubt.
 */
export async function setAcquisitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };

  const kind = str(formData.get("acquisition")) ?? "";
  if (!["unknown", "ipo", "bonus", "gift"].includes(kind)) {
    return { ok: false, message: "Pick how these shares were acquired." };
  }

  // Invariant 8 (fix wave, design review A5(b)) — the row is read in the
  // VIEWING scope, as the IPO push below reads its holding: a stale tab cannot
  // write a basis into a book the user is not in.
  const viewing = getSelectedAccountId();
  const row = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!row || (viewing > 0 && row.accountId !== viewing)) return { ok: false, message: "Trade not found." };

  // Invariant 5 (fix wave, SEAM-V46-3; LEDGER D-14 "recorded, not built") — a
  // basis write rewrites the parent's buyQty / buyValue / buyDate / side with no
  // knowledge of legs, so on a STAGED row the parent would stop being the sum of
  // its ladder: the AIS purchase side stated the typed basis while the realised
  // rows stated the ladder's. Refused exactly as the IPO push refuses it
  // (`hasLadder`, the ONE leg-count predicate), before anything is written.
  if (hasLadder(row, id)) {
    return {
      ok: false,
      code: "STAGED",
      message:
        "This is a staged position built from more than one fill, so its cost basis is not set here: a basis would rewrite the parent row and leave the ladder unsummed. Add the purchase as an entry leg on the ladder in Trades instead. Nothing was changed.",
    };
  }

  const rawPrice = formData.get("acquisitionPrice");
  const hasPrice = rawPrice != null && String(rawPrice).trim() !== "";
  const price = hasPrice ? Number(rawPrice) : null;
  if (hasPrice && (!Number.isFinite(price!) || price! < 0)) {
    return { ok: false, message: "Cost per share must be zero or more." };
  }

  // D3 (v4.3.0 wave 2M, finding G-G3-1) — the typed acquisition day.
  //
  // It was written RAW into `trades.acquisition_date` and, with a cost, into
  // `trades.buy_date`: the field the IPO pairing reads FIRST
  // (`acquisitionDate ?? buyDate`) and the day the tax pack's financial year,
  // the MTF day count and every holding period are computed from. A date input
  // reaches this with a half-typed year ('0002-06-15'), which is not a day that
  // exists; it is refused here, in the same words every other typed-date writer
  // refuses one, BEFORE anything is written.
  const acquisitionDateRaw = str(formData.get("acquisitionDate"));
  const acquisitionDate = acquisitionDateRaw == null ? null : normalizeDate(acquisitionDateRaw);
  if (acquisitionDateRaw != null && acquisitionDate == null) {
    return { ok: false, message: unreadableDateMessage("acquisition date", acquisitionDateRaw) };
  }

  // Leaving the price blank is a legitimate "I do not know yet" — the trade
  // stays flagged and out of the statistics rather than being forced to a
  // number the user does not actually have.
  const patch: Record<string, unknown> = {
    acquisition: kind,
    acquisitionPrice: hasPrice ? price : null,
    acquisitionDate: acquisitionDate ?? null,
    updatedAt: new Date().toISOString(),
  };

  if (hasPrice) {
    const buyValue = Math.round(row.sellQty * price! * 100) / 100;
    const grossPnl = Math.round((row.sellValue - buyValue) * 100) / 100;
    patch.buyQty = row.sellQty;
    // v4.6.0 W6 (contract D3): a basis is a LONG's entry — the row is flat now
    // and states the side its quantities can no longer say.
    patch.side = "long";
    patch.avgBuyPrice = price;
    patch.buyValue = buyValue;
    patch.grossPnl = grossPnl;
    patch.netPnl = Math.round((grossPnl - row.chargesTotal) * 100) / 100;
    patch.realisedPct = buyValue > 0 ? Math.round((grossPnl / buyValue) * 10000) / 100 : null;
    if (acquisitionDate) patch.buyDate = acquisitionDate;
  }

  db.update(trades).set(patch).where(eq(trades.id, id)).run();
  revalidateAfterTradeChange();
  for (const p of ["/ipos", "/arjuns-eye", "/reports/performance"]) revalidatePath(p);

  return {
    ok: true,
    message: hasPrice
      ? "Cost basis set — this trade now counts toward your edge."
      : "Marked. Add a cost per share to include it in win rate and expectancy.",
  };
}

/**
 * "This holding came from an IPO allotment."
 *
 * IPO shares are credited without ever appearing as a buy, so the position
 * lands in the journal with no cost basis and no mark — unable to be scored as
 * a gain or a loss, and unable to join the edge statistics. The IPO section is
 * where the user actually knows those numbers, so this creates the record,
 * links the two, and hands the user somewhere to fill them in.
 *
 * Nothing is guessed here. The issue price is left blank unless the holding
 * genuinely has a purchase price, because that price is precisely the fact the
 * journal is missing.
 *
 * IPO-ACCOUNT (v4.3.0 wave 2I): the record is filed in the HOLDING's account.
 * The insert named no accountId, so the column took its schema default of 1
 * whatever book the holding was in — after which the holding's own account
 * could not see the record, account 1's /ipos showed it joined to the other
 * book's holding, and an exit saved there closed that holding across the
 * boundary (invariant 8). The holding itself is read in the viewing scope, so a
 * stale tab cannot reach into a book the user is not in, and 0 never reaches
 * the column (invariant 9).
 */
export async function pushTradeToIpoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };

  const viewing = getSelectedAccountId();
  const row = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!row || (viewing > 0 && row.accountId !== viewing)) {
    return { ok: false, message: "That holding is not in the account you are viewing." };
  }

  // Invariant 5: the parent row always holds the aggregate, and legs are additive
  // detail. An IPO rewrites the parent's quantity, basis and dates from the
  // allotment with no knowledge of legs and no leg write, so a staged holding
  // would stop being the sum of its ladder. Refused at both doors (the other is
  // POST /api/ipos), in the shape closePosition's own STAGED refusal uses.
  // D5 (wave 2P): the ONE leg-count predicate (`hasLadder`, lib/queries/staged).
  if (hasLadder(row, id)) {
    return {
      ok: false,
      code: "STAGED",
      message:
        "This is a staged position built from more than one fill, so it is not pushed to IPOs: an IPO record would rewrite the parent row from its allotment and leave the ladder unsummed. Its entries and exits are booked on its own ladder in Trades. Nothing was changed.",
    };
  }

  // Invariant 9: 0 is a view, not a place. The holding's own account is the one
  // real account this record can belong to; a holding whose account no longer
  // exists has nowhere to file it.
  let accountId: number;
  try {
    accountId = getWriteAccountId(row.accountId);
  } catch (e) {
    if (e instanceof AccountRequiredError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, message: (e as Error).message };
  }
  if (accountId !== row.accountId) {
    return { ok: false, message: "This holding's account no longer exists, so there is nowhere to file the IPO record. Nothing was changed." };
  }

  const existing = db.select().from(iposTable).where(eq(iposTable.tradeId, id)).get();
  if (existing) {
    return { ok: true, message: `Already linked to an IPO record — open IPOs to edit it.` };
  }

  const seed = ipoSeedFromTrade({
    symbol: row.symbol,
    exchange: row.exchange,
    buyQty: row.buyQty,
    avgBuyPrice: row.avgBuyPrice,
    buyValue: row.buyValue,
    buyDate: row.buyDate,
    closingPrice: row.closingPrice,
  });

  const created = db
    .insert(iposTable)
    .values({
      accountId,
      name: seed.name,
      exchange: seed.exchange,
      board: "mainboard",
      allotted: true,
      allottedQty: seed.allottedQty,
      appliedPrice: seed.appliedPrice,
      lotSize: seed.lotSize,
      lotsApplied: seed.lotsApplied,
      allotmentDate: seed.allotmentDate,
      listingPrice: seed.listingPrice,
      notes: seed.notes,
      tradeId: id,
    })
    .returning({ id: iposTable.id })
    .get();

  // Mark provenance immediately. The BASIS stays absent until the user enters
  // an issue price — flagging it as an IPO does not by itself make it priced,
  // and pretending otherwise would put it back into statistics it cannot join.
  db.update(trades)
    .set({ acquisition: "ipo", updatedAt: new Date().toISOString() })
    .where(eq(trades.id, id))
    .run();

  // ONE key list on both sides (lib/audit.ts, the single-binding convention):
  // `before: { acquisition }` against `after: { acquisition, ipoId }` rendered
  // ipoId as a change on a key the before-snapshot never had, and — because
  // AuditShapeError THROWS outside production — rejected this action in dev and
  // test AFTER the insert and the trade UPDATE had run, which is why nothing
  // covered it.
  recordAudit({
    entity: "trade",
    entityId: id,
    action: "update",
    summary: `${row.symbol}: pushed to IPOs as an allotment (IPO #${created!.id})`,
    before: { acquisition: row.acquisition, ipoId: null },
    after: { acquisition: "ipo", ipoId: created!.id },
  });

  revalidateAfterTradeChange();
  for (const p of ["/ipos", "/arjuns-eye", "/reports/performance"]) revalidatePath(p);

  return {
    ok: true,
    message: `Created an IPO record for ${row.symbol}. Open IPOs and enter the issue price — that supplies the cost basis, and a listing price gives the holding its mark.`,
  };
}
