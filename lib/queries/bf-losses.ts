import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bfLossLots, trades } from "@/lib/db/schema";
import type { CarryForwardLot, LossBucket } from "@/lib/analytics/capital-gains";
import { lossExpiryFy } from "@/lib/analytics/capital-gains";
import { currentFy } from "@/lib/analytics/tax";
import { getSelectedAccountId } from "./accounts";
import { getSettings } from "./settings";
import { recordAudit } from "@/lib/audit";

/**
 * bf_loss_lots CRUD — pre-journal brought-forward losses (v3.6, WS5).
 *
 * Scoping (invariants 8/9, the goals.ts pattern): reads go through
 * getSelectedAccountId() — the aggregate view (id 0) reads EVERY account's
 * lots (the tax pages already blend every account's trades in that view, so
 * the seed must match) and REFUSES writes outright: a brought-forward loss is
 * a statement about ONE demat account's filed history, and 0 is a view, not
 * a place.
 *
 * Refusals over defaults (invariant 6): a lot without a positive amount, a
 * malformed FY, or an unknown head is refused — never coerced. An
 * originalAmount smaller than the remaining amount is refused too: a loss
 * can only shrink after it is incurred, so that pair is not a statement the
 * filed returns could have made.
 *
 * The seed boundary: `moneyPaise` already converts paise→rupees at the COLUMN
 * boundary, so rows arrive here in rupees and toSeedLots passes amounts
 * through unchanged — CarryForwardLot.amount is rupees, same units as every
 * FyGrossGains figure. No second conversion (the 100× bug, invariant 1).
 *
 * Expiry is NEVER computed here: displayRows derives it via lossExpiryFy from
 * the engine module, which mirrors pruneExpired exactly — the window math has
 * one home.
 */

export type BfLossRow = typeof bfLossLots.$inferSelect;

/**
 * The engine's own loss-head taxonomy, verbatim. `satisfies` ties this list to
 * the LossBucket union: renaming a bucket in capital-gains.ts breaks this
 * module's compile, not silently strands stored rows.
 */
export const LOSS_HEADS = ["stcl", "ltcl", "speculative", "nonSpeculative"] as const satisfies readonly LossBucket[];

/** Plain-language labels for the editor's head select. */
export const HEAD_LABELS: Record<LossBucket, string> = {
  stcl: "Short-term capital loss (STCL)",
  ltcl: "Long-term capital loss (LTCL)",
  speculative: "Speculative business loss (equity intraday)",
  nonSpeculative: "Non-speculative business loss (F&O)",
};

/** "YYYY-YY" with the second part consistent: 2022-23, 2099-00. */
export function isValidFy(fy: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(fy)) return false;
  const start = Number(fy.slice(0, 4));
  if (start < 1961 || start > 2100) return false; // the Act's own epoch, sane upper bound
  return fy.slice(5) === String((start + 1) % 100).padStart(2, "0");
}

/** FY label of an ISO date under the journal's FY convention. */
function fyOfDate(dateStr: string, fyStartMonth: number): string {
  const d = new Date(dateStr + "T00:00:00");
  const start = d.getMonth() + 1 >= fyStartMonth ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * The EARLIEST FY the journal itself covers for the current scope, or null on
 * an empty journal. One cheap aggregate (min sell_date + a closed count over
 * the invariant-8 scope), so the write path can call it per request: from this
 * FY onward, losses come out of the imported trades via computeTaxTimeline —
 * a hand-entered lot for such an FY would be counted twice. Undated closed
 * trades bucket under TODAY'S FY (the tax page's own fallback), so their
 * presence alone still journals the current FY.
 */
export function earliestJournalledFy(): string | null {
  const accountId = getSelectedAccountId();
  const cond = eq(trades.isOpen, false);
  const agg = db
    .select({ minSell: sql<string | null>`min(${trades.sellDate})`, closed: sql<number>`count(*)` })
    .from(trades)
    .where(accountId > 0 ? and(cond, eq(trades.accountId, accountId)) : cond)
    .get();
  if (!agg || agg.closed === 0) return null;
  const fyStartMonth = getSettings()?.fyStartMonth ?? 4;
  const cur = currentFy(fyStartMonth);
  if (agg.minSell == null) return cur; // only undated closed trades — they land in today's FY
  const fy = fyOfDate(agg.minSell, fyStartMonth);
  return fy < cur ? fy : cur;
}

/** The selected account's b/f loss rows (aggregate view: every account's). */
export function getBfLossRows(): BfLossRow[] {
  const accountId = getSelectedAccountId();
  const q = db.select().from(bfLossLots);
  const rows = (accountId > 0 ? q.where(eq(bfLossLots.accountId, accountId)) : q).all();
  return rows.sort((a, b) => a.incurredFy.localeCompare(b.incurredFy) || a.head.localeCompare(b.head));
}

/**
 * Read-time seed guard (belt-and-braces to the upsert refusal): a lot whose
 * FY the journal ALSO covers must not seed — the engine already computes that
 * FY's losses from the imported trades, so seeding it counts the same loss
 * twice. The upsert refuses such lots today, but a user who imports an old
 * year LATER leaves a legacy lot behind; excluding it here (and telling them
 * — see excludedSeedLots) beats silently double-counting. A future-dated lot
 * (beyond today's FY) cannot come from a filed return and is dropped too.
 */
export interface SeedGuard {
  /** FY labels the journal's timeline covers (aggregateTradesByFy output). */
  journalledFys: ReadonlySet<string>;
  /** Today's FY — lots dated beyond it are excluded as well. */
  currentFy?: string;
}

function seedExcluded(r: BfLossRow, guard?: SeedGuard): boolean {
  if (!guard) return false;
  if (guard.journalledFys.has(r.incurredFy)) return true;
  return guard.currentFy != null && r.incurredFy > guard.currentFy;
}

/**
 * Rows → engine seed. Amounts are ALREADY rupees (moneyPaise converted at the
 * column boundary) and CarryForwardLot.amount is rupees — passed through
 * unchanged, explicitly. Expired vintages are NOT filtered here: the engine's
 * own pruneExpired drops them on entry, so the window math has one home.
 * Pass a SeedGuard (both tax surfaces do) to drop journalled-FY collisions.
 */
export function toSeedLots(rows: BfLossRow[], guard?: SeedGuard): CarryForwardLot[] {
  return rows
    .filter((r) => !seedExcluded(r, guard))
    .map((r) => ({
      bucket: r.head as LossBucket,
      fyIncurred: r.incurredFy,
      amount: r.amount, // rupees → rupees; no conversion here (invariant 1)
    }));
}

/** The rows toSeedLots(rows, guard) dropped — the page names these vintages. */
export function excludedSeedLots(rows: BfLossRow[], guard: SeedGuard): BfLossRow[] {
  return rows.filter((r) => seedExcluded(r, guard));
}

export interface BfLossDisplayRow extends BfLossRow {
  /** Last FY the vintage is usable — lossExpiryFy, the engine's own formula. */
  expiresAfterFy: string;
}

/** Editor rows with expiry derived by the SAME formula the engine uses. */
export function displayRows(rows: BfLossRow[]): BfLossDisplayRow[] {
  return rows.map((r) => ({ ...r, expiresAfterFy: lossExpiryFy(r.head as LossBucket, r.incurredFy) }));
}

export interface BfLossWriteResult {
  ok: boolean;
  message: string;
  /** True when the refusal is the aggregate-view write ban (route → 403). */
  forbidden?: boolean;
}

export interface BfLossUpsertInput {
  incurredFy: string;
  head: LossBucket;
  /** ₹ still unabsorbed (rupees at runtime). */
  amount: number;
  /** ₹ the loss was when incurred; null = unknown. */
  originalAmount?: number | null;
  note?: string | null;
}

/** Create or edit the selected account's lot for one (FY, head) vintage. */
export function upsertBfLoss(input: BfLossUpsertInput): BfLossWriteResult {
  const accountId = getSelectedAccountId();
  if (accountId === 0) {
    return {
      ok: false,
      forbidden: true,
      message: "A brought-forward loss belongs to one account's filed history — pick an account in the sidebar first. The All-accounts view only reads.",
    };
  }
  if (!isValidFy(input.incurredFy)) {
    return { ok: false, message: "The FY must look like 2022-23 (start year, then the next year's last two digits)." };
  }
  // isValidFy checks the SHAPE; the calendar caps it here. A brought-forward
  // loss is a transcription of a filed return, so it cannot be dated beyond
  // the current FY…
  const fyStartMonth = getSettings()?.fyStartMonth ?? 4;
  const cur = currentFy(fyStartMonth);
  if (input.incurredFy > cur) {
    return { ok: false, message: `FY ${input.incurredFy} hasn't happened yet — a brought-forward loss comes from a filed return, so it cannot be dated beyond the current FY (${cur}).` };
  }
  // …and it cannot fall inside the journal's own coverage: from the earliest
  // journalled FY onward the set-off engine computes losses from the imported
  // trades, so a hand-entered lot for such an FY would count the loss twice.
  const earliest = earliestJournalledFy();
  if (earliest != null && input.incurredFy >= earliest) {
    return {
      ok: false,
      message: `FY ${input.incurredFy} is already in your journal — losses from imported trades are computed, not entered. Brought-forward lots are only for FYs before ${earliest}.`,
    };
  }
  if (!(LOSS_HEADS as readonly string[]).includes(input.head)) {
    return { ok: false, message: "Unknown loss head — nothing was saved." };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, message: "The remaining loss needs a ₹ amount above zero — nothing was saved." };
  }
  const originalAmount = input.originalAmount ?? null;
  if (originalAmount != null && (!Number.isFinite(originalAmount) || originalAmount <= 0)) {
    return { ok: false, message: "The original loss, if given, needs a ₹ amount above zero — leave it blank if unknown." };
  }
  if (originalAmount != null && originalAmount < input.amount) {
    return { ok: false, message: "The original loss cannot be smaller than what remains — a loss only shrinks after it is incurred." };
  }

  const note = input.note?.trim() ? input.note.trim() : null;
  const existing = db
    .select()
    .from(bfLossLots)
    .where(and(eq(bfLossLots.accountId, accountId), eq(bfLossLots.incurredFy, input.incurredFy), eq(bfLossLots.head, input.head)))
    .get();

  const now = new Date().toISOString();
  const values = { amount: input.amount, originalAmount, note, updatedAt: now };
  if (existing) {
    db.update(bfLossLots).set(values).where(eq(bfLossLots.id, existing.id)).run();
  } else {
    db.insert(bfLossLots).values({ accountId, incurredFy: input.incurredFy, head: input.head, ...values }).run();
  }

  recordAudit({
    entity: "bf_loss",
    entityId: existing?.id ?? accountId,
    action: existing ? "update" : "create",
    summary: `b/f loss ${existing ? "updated" : "entered"} — ${HEAD_LABELS[input.head]} FY ${input.incurredFy}, ₹${input.amount} remaining`,
    after: { incurredFy: input.incurredFy, head: input.head, ...values },
    source: "ui",
  });

  return { ok: true, message: existing ? `Updated the ${input.incurredFy} ${input.head} lot.` : `Recorded the ${input.incurredFy} ${input.head} loss.` };
}

/** Remove one of the selected account's lots by id. */
export function deleteBfLoss(id: number): BfLossWriteResult {
  const accountId = getSelectedAccountId();
  if (accountId === 0) {
    return { ok: false, forbidden: true, message: "Pick the account whose lot you want to remove — the All-accounts view only reads." };
  }
  const existing = db
    .select()
    .from(bfLossLots)
    .where(and(eq(bfLossLots.id, id), eq(bfLossLots.accountId, accountId)))
    .get();
  if (!existing) return { ok: false, message: "That lot no longer exists on this account." };
  db.delete(bfLossLots).where(eq(bfLossLots.id, existing.id)).run();
  recordAudit({
    entity: "bf_loss",
    entityId: existing.id,
    action: "delete",
    summary: `b/f loss removed — ${existing.head} FY ${existing.incurredFy}`,
    before: existing as unknown as Record<string, unknown>,
    source: "ui",
  });
  return { ok: true, message: "Lot removed." };
}
