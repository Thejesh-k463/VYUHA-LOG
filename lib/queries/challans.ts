import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { advanceTaxChallans } from "@/lib/db/schema";
import type { AdvanceTaxInput } from "@/lib/analytics/advance-tax";
import { getSelectedAccountId, getWriteAccountId } from "./accounts";
import { todayIstIso } from "@/lib/domain/trading-day";
import { isValidFy } from "./bf-losses";
import { recordAudit } from "@/lib/audit";

/**
 * advance_tax_challans CRUD — the dated advance-tax payment ledger (v3.7, WS4).
 *
 * This is the sibling of lib/queries/bf-losses.ts, deliberately: both tables
 * hold STATEMENTS OF FACT transcribed from paper (a filed return there, a
 * challan receipt here), so they get the same scoping, the same refusals and
 * the same money boundary.
 *
 * Scoping (invariants 8/9): reads go through getSelectedAccountId() — the
 * aggregate view (id 0) reads EVERY account's challans, because the tax pages
 * already blend every account's trades in that view — and REFUSES writes
 * outright, as a typed `forbidden` result (route → 403). `getWriteAccountId()`
 * then resolves the concrete id; since v3.8 it THROWS on a 0 selection rather
 * than picking the first account (silently attributing a bank payment to
 * whichever account sorts first was exactly the invariant-9 bug, "0 is a view,
 * not a place"), so the pre-check and the helper can no longer disagree.
 *
 * Refusals over defaults (invariant 6): a malformed FY, an unreal date, a date
 * outside the FY it claims, a future date, or a non-positive amount are all
 * refused with a reason naming the problem — never coerced. A challan for zero
 * rupees is worse than no challan, and a future-dated one is an aspiration:
 * both would silently satisfy a s.425 instalment that was never actually paid,
 * understating the interest the user owes.
 *
 * s.408(3) is the sharp edge: money paid BY 31 March is advance tax for that
 * FY, money paid AFTER it is self-assessment tax. Filing a March-31+1 payment
 * under the FY it was computed for would credit an instalment ladder that had
 * already closed, so the window check refuses it and names why. That window is
 * the STATUTORY April-to-March year and takes no `fyStartMonth` — the engine's
 * ladder and cut do not either, and a window that disagreed with them let money
 * into the table that the planner then silently ignored (advanceTaxFyWindow).
 *
 * Money (invariant 1): `moneyPaise` converts at the COLUMN boundary, so rows
 * arrive here in rupees and leave for the engine in rupees, unchanged. There is
 * no ×100 anywhere in this file except the two documented spots that are NOT
 * unit conversions: the float-drift round in challanTotalsByFy, and the
 * caller-declared paise parameter of findDuplicateChallan.
 *
 * No natural key, deliberately (see the schema comment): a serial is unique
 * only per BSR code and both are optional, so two identical-looking rows can
 * both be real. findDuplicateChallan WARNS; nothing here blocks.
 */

export type ChallanRow = typeof advanceTaxChallans.$inferSelect;

/**
 * One dated payment, in the shape `AdvanceTaxInput.payments` takes.
 *
 * DERIVED, not duplicated: once the WS4 engine change lands `payments` on
 * AdvanceTaxInput this resolves to its element type, so a divergence reddens
 * tsc here instead of drifting. Until it lands the inference yields `unknown`
 * and this falls back to the planned shape — `{ date, amount }`, amount in
 * RUPEES, the same unit every other engine figure uses.
 */
export type ChallanPayment = AdvanceTaxInput extends { payments?: readonly (infer P)[] }
  ? unknown extends P
    ? { date: string; amount: number }
    : P
  : { date: string; amount: number };

/** A real calendar date in ISO form — "2026-02-30" has the shape but not the day. */
export function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * First and last ISO date of the advance-tax year an FY label names: 1 April to
 * 31 March, ALWAYS — it takes no `fyStartMonth` on purpose.
 *
 * `settings.fyStartMonth` is the journal's own book year, and it is deliberately
 * NOT read here. Advance tax is a statutory obligation dated by the Act, not by
 * the journal: `lib/analytics/advance-tax.ts` builds its ladder on 15 Jun / Sep /
 * Dec / Mar of the April-start year and draws its s.408(3) cut at 31 March,
 * whatever the setting says. A window that honoured the setting therefore
 * DISAGREED with the engine at both edges — with `fyStartMonth = 6` this table
 * accepted a payment dated 15 Apr 2027 that the planner then classed as late and
 * dropped from `taxPaidToDate` and from every rung, so the ledger showed money
 * the planner did not count, and refused an April payment the planner WOULD have
 * counted towards 15 June. Honouring the setting properly would mean moving the
 * instalment ladder itself; until that happens the two must agree, and the
 * statutory year is the one both the Act and the engine actually use.
 */
export function advanceTaxFyWindow(fy: string): { start: string; end: string } {
  const startYear = Number(fy.slice(0, 4));
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}

/**
 * Today in INDIA. Defined in lib/domain/trading-day.ts (pure) since v3.8 and
 * re-exported here because every advance-tax surface — the planner page, the
 * editor's max date, `upsertChallan`'s future-date refusal — imports it from
 * this module, and they must all agree on the day.
 */
export { todayIstIso };

/**
 * The selected account's challans, oldest payment first (id breaks a same-day
 * tie so the order is total — two genuine payments on one day are legal).
 * Aggregate view reads every account's. Pass `fy` to scope to one year.
 */
export function getChallans(fy?: string): ChallanRow[] {
  const accountId = getSelectedAccountId();
  const conds = [
    ...(accountId > 0 ? [eq(advanceTaxChallans.accountId, accountId)] : []),
    ...(fy != null ? [eq(advanceTaxChallans.fy, fy)] : []),
  ];
  return db
    .select()
    .from(advanceTaxChallans)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(advanceTaxChallans.paidOn), asc(advanceTaxChallans.id))
    .all();
}

export interface ChallanFyTotals {
  fy: string;
  /** ₹ paid across the FY — RUPEES, the engine's `taxPaidToDate` unit. */
  total: number;
  /** How many challans that total is made of (0 = the ledger says nothing). */
  count: number;
  /** The dated list for `AdvanceTaxInput.payments`, oldest first. */
  payments: ChallanPayment[];
}

/**
 * What the advance-tax engine is fed for one FY. `total` is the sum the
 * calculator shows instead of its hand-typed "paid so far"; `payments` is what
 * lets s.425 ask "paid AS OF this due date" rather than applying one scalar to
 * every rung.
 *
 * Nothing is invented when the ledger is empty: total 0 with count 0 says "the
 * ledger holds nothing", which is what the caller must render as "—" rather
 * than as "₹0 paid" (invariant 6).
 */
export function challanTotalsByFy(fy: string): ChallanFyTotals {
  const rows = getChallans(fy);
  // The rows are ALREADY rupees (moneyPaise converted at the column boundary),
  // so this is a plain sum. The ×100/÷100 is float-drift cleanup to paise
  // precision — NOT a unit conversion: ₹0.1 + ₹0.2 must not reach a receipt
  // reconciliation as 0.30000000000000004.
  const total = Math.round(rows.reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
  return { fy, total, count: rows.length, payments: rows.map((r) => ({ date: r.paidOn, amount: r.amount })) };
}

/**
 * A near-duplicate WARNING, not a block: an exact (fy, paid_on, amount) match
 * on the same account. Two genuine payments of the same amount on the same day
 * are legal and the schema allows them — the editor asks "did you mean to
 * record this twice?" and takes yes for an answer.
 *
 * `amountPaise` is stated in PAISE by the caller on purpose: rupee floats are
 * not safe to compare for equality, and "exact duplicate" is an exact-amount
 * question. The ÷100 below is the inverse of the column type's own conversion,
 * applied once at THIS parameter boundary — drizzle's moneyPaise multiplies it
 * straight back, so the comparison SQLite runs is integer paise to integer
 * paise.
 *
 * Returns null in the aggregate view: that view cannot write, so it has
 * nothing to warn about.
 */
export function findDuplicateChallan(fy: string, paidOn: string, amountPaise: number, excludeId?: number | null): ChallanRow | null {
  const accountId = getSelectedAccountId();
  if (accountId === 0) return null;
  const rows = db
    .select()
    .from(advanceTaxChallans)
    .where(
      and(
        eq(advanceTaxChallans.accountId, accountId),
        eq(advanceTaxChallans.fy, fy),
        eq(advanceTaxChallans.paidOn, paidOn),
        eq(advanceTaxChallans.amount, amountPaise / 100),
      ),
    )
    .orderBy(asc(advanceTaxChallans.id))
    .all();
  return rows.find((r) => r.id !== excludeId) ?? null;
}

export interface ChallanWriteResult {
  ok: boolean;
  message: string;
  /** True when the refusal is the aggregate-view write ban (route → 403). */
  forbidden?: boolean;
}

export interface ChallanUpsertInput {
  /** Editing an existing row; omit (or null) to record a NEW payment — there is no natural key to upsert on. */
  id?: number | null;
  fy: string;
  /** ISO date on the receipt. */
  paidOn: string;
  /** ₹ paid (rupees at runtime; the column stores integer paise). */
  amount: number;
  bsrCode?: string | null;
  challanSerial?: string | null;
  note?: string | null;
}

/** Record a new challan, or edit one of the selected account's existing rows. */
export function upsertChallan(input: ChallanUpsertInput): ChallanWriteResult {
  // Invariant 9 as a typed result FIRST (the route maps `forbidden` to 403);
  // getWriteAccountId() below would throw on the same 0 selection (v3.8).
  if (getSelectedAccountId() === 0) {
    return {
      ok: false,
      forbidden: true,
      message: "A challan is one account's payment to the department — pick an account in the sidebar first. The All-accounts view only reads.",
    };
  }
  const accountId = getWriteAccountId();

  if (!isValidFy(input.fy)) {
    return { ok: false, message: "The FY must look like 2026-27 (start year, then the next year's last two digits) — nothing was saved." };
  }
  if (!isRealIsoDate(input.paidOn)) {
    return { ok: false, message: `“${input.paidOn}” is not a real date — enter the payment date from the receipt as YYYY-MM-DD. Nothing was saved.` };
  }

  // The STATUTORY year, not settings.fyStartMonth — see advanceTaxFyWindow.
  const { start, end } = advanceTaxFyWindow(input.fy);
  if (input.paidOn > end) {
    // s.408(3): paid BY 31 March = advance tax; paid after it = self-assessment
    // tax. Crediting this to FY input.fy would satisfy an instalment ladder that
    // had already closed and understate the interest.
    return {
      ok: false,
      message: `Paid on ${input.paidOn}, after FY ${input.fy} ended on ${end} — a payment made after the year closes is SELF-ASSESSMENT tax, not advance tax for that year. File it under the FY it belongs to, or leave it out. Nothing was saved.`,
    };
  }
  if (input.paidOn < start) {
    return {
      ok: false,
      message: `Paid on ${input.paidOn}, before FY ${input.fy} began on ${start} — a payment cannot be advance tax for a year that had not started. Nothing was saved.`,
    };
  }
  const today = todayIstIso();
  if (input.paidOn > today) {
    return {
      ok: false,
      message: `${input.paidOn} is in the future — a challan records money that has already left your bank, not money you plan to pay. Nothing was saved.`,
    };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, message: "A challan needs a ₹ amount above zero — a challan for nothing is worse than no challan. Nothing was saved." };
  }

  // Optional receipt fields are normalised, never validated into a refusal: a
  // self-assessment receipt often omits the BSR code entirely, and refusing a
  // real payment over a blank transcription field would be the worse error.
  const bsrCode = input.bsrCode?.trim() ? input.bsrCode.trim() : null;
  const challanSerial = input.challanSerial?.trim() ? input.challanSerial.trim() : null;
  const note = input.note?.trim() ? input.note.trim() : null;

  const now = new Date().toISOString();
  const values = { fy: input.fy, paidOn: input.paidOn, amount: input.amount, bsrCode, challanSerial, note, updatedAt: now };

  if (input.id != null) {
    const existing = db
      .select()
      .from(advanceTaxChallans)
      .where(and(eq(advanceTaxChallans.id, input.id), eq(advanceTaxChallans.accountId, accountId)))
      .get();
    if (!existing) return { ok: false, message: "That challan no longer exists on this account — nothing was changed." };
    db.update(advanceTaxChallans).set(values).where(eq(advanceTaxChallans.id, existing.id)).run();
    // Single-binding convention (lib/audit.ts): BOTH snapshots are projections
    // of the row read before the write, over the columns this write touches.
    // `before: existing` against `after: values` carried id/accountId/createdAt
    // on one side only, which the audit screen rendered as three columns
    // cleared — the v3.8 key-set guard reddened it (tests/challans.test.ts).
    const touched = Object.keys(values) as (keyof typeof values)[];
    const project = (row: Record<string, unknown>) => Object.fromEntries(touched.map((k) => [k, row[k] ?? null]));
    recordAudit({
      entity: "advance_tax_challan",
      entityId: existing.id,
      action: "update",
      summary: `advance-tax challan updated — FY ${input.fy}, ₹${input.amount} paid ${input.paidOn}`,
      before: project(existing as unknown as Record<string, unknown>),
      after: project({ ...existing, ...values }),
      source: "ui",
    });
    return { ok: true, message: `Updated the ₹${input.amount} challan dated ${input.paidOn}.` };
  }

  db.insert(advanceTaxChallans).values({ accountId, ...values }).run();
  recordAudit({
    entity: "advance_tax_challan",
    entityId: accountId,
    action: "create",
    summary: `advance-tax challan recorded — FY ${input.fy}, ₹${input.amount} paid ${input.paidOn}`,
    after: values,
    source: "ui",
  });
  return { ok: true, message: `Recorded ₹${input.amount} paid on ${input.paidOn}.` };
}

/** Remove one of the selected account's challans by id. */
export function deleteChallan(id: number): ChallanWriteResult {
  if (getSelectedAccountId() === 0) {
    return { ok: false, forbidden: true, message: "Pick the account whose challan you want to remove — the All-accounts view only reads." };
  }
  const accountId = getWriteAccountId();
  const existing = db
    .select()
    .from(advanceTaxChallans)
    .where(and(eq(advanceTaxChallans.id, id), eq(advanceTaxChallans.accountId, accountId)))
    .get();
  if (!existing) return { ok: false, message: "That challan no longer exists on this account." };
  db.delete(advanceTaxChallans).where(eq(advanceTaxChallans.id, existing.id)).run();
  recordAudit({
    entity: "advance_tax_challan",
    entityId: existing.id,
    action: "delete",
    summary: `advance-tax challan removed — FY ${existing.fy}, ₹${existing.amount} paid ${existing.paidOn}`,
    before: existing as unknown as Record<string, unknown>,
    source: "ui",
  });
  return { ok: true, message: `Removed the ₹${existing.amount} challan dated ${existing.paidOn}.` };
}
