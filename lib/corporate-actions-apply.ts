import "server-only";
import { db } from "@/lib/db";
import { trades as tradesTable, corporateActions, ledgerEntries } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { splitBonusMultiplier, adjustForSplitOrBonus, dividendIncome } from "@/lib/analytics/corporate-actions";
import { computeEventTds } from "@/lib/analytics/dividend-tds";
import { getAliasMap } from "@/lib/queries/aliases";
import { resolveTicker } from "@/lib/analytics/aliases";
import { getSettings } from "@/lib/queries/settings";
import { toPaise } from "@/lib/money";
import { recordAudit } from "@/lib/audit";

// IND-6 — same FY-string convention used by lib/analytics/tax.ts and capital-gains.ts.
function fyOf(dateStr: string, fyStartMonth: number): string {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const start = m >= fyStartMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  positionsAdjusted?: number;
  ledgerPosted?: number;
}

/**
 * Apply a recorded split/bonus/dividend to every currently-open matching
 * position. One-shot: `appliedAt` locks the event so it can't be applied twice.
 *
 * split/bonus — scales qty up and every price level (avg cost, SL, TSL, target)
 * down by the same factor for BOTH long and short option/equity legs, preserving
 * invested value and ₹ stop-distance (see lib/analytics/corporate-actions.ts).
 *
 * dividend — scoped to open LONG EQUITY holdings only (options/futures don't pay
 * dividends; a genuine short seller owes the dividend rather than receiving it,
 * an edge case not modelled here). Posts one ledger entry per matching position.
 */
export function applyCorporateAction(id: number): ApplyResult {
  const action = db.select().from(corporateActions).where(eq(corporateActions.id, id)).get();
  if (!action) return { ok: false, message: "Corporate action not found." };
  if (action.appliedAt) return { ok: false, message: "Already applied — each event can only be applied once." };

  const aliasMap = getAliasMap();
  const target = action.symbol.toUpperCase();
  const open = db.select().from(tradesTable).where(eq(tradesTable.isOpen, true)).all();
  const matching = open.filter((t) => {
    const up = t.symbol.toUpperCase();
    return up === target || resolveTicker(up, aliasMap) === target;
  });

  if (matching.length === 0) {
    return db.transaction((tx) => {
      tx.update(corporateActions).set({ appliedAt: sql`(datetime('now'))` }).where(eq(corporateActions.id, id)).run();
      recordAudit({
        entity: "corporate_action",
        entityId: id,
        action: "update",
        summary: `${action.symbol} ${action.type} applied — no open positions matched`,
      });
      return { ok: true, message: "Marked applied — no open positions currently match this symbol.", positionsAdjusted: 0, ledgerPosted: 0 };
    });
  }

  if (action.type === "split" || action.type === "bonus") {
    const multiplier = splitBonusMultiplier(action.type, action.fromUnits ?? 0, action.toUnits ?? 0);
    if (multiplier <= 0 || multiplier === 1) {
      return { ok: false, message: "Invalid split/bonus ratio — nothing to adjust." };
    }
    let adjusted = 0;
    db.transaction((tx) => {
      for (const t of matching) {
        const isShort = t.sellQty > t.buyQty;
        const before = isShort
          ? { qty: t.sellQty, avgPrice: t.avgSellPrice, slPlanned: t.slPlanned, trailingSl: t.trailingSl, targetPlanned: t.targetPlanned }
          : { qty: t.buyQty, avgPrice: t.avgBuyPrice, slPlanned: t.slPlanned, trailingSl: t.trailingSl, targetPlanned: t.targetPlanned };
        const after = adjustForSplitOrBonus(before, multiplier);

        tx.update(tradesTable)
          .set(
            isShort
              ? {
                  sellQty: after.qty,
                  avgSellPrice: after.avgPrice,
                  sellValue: Math.round(after.qty * after.avgPrice * 100) / 100,
                  slPlanned: after.slPlanned,
                  trailingSl: after.trailingSl,
                  targetPlanned: after.targetPlanned,
                  updatedAt: sql`(datetime('now'))`,
                }
              : {
                  buyQty: after.qty,
                  avgBuyPrice: after.avgPrice,
                  buyValue: Math.round(after.qty * after.avgPrice * 100) / 100,
                  slPlanned: after.slPlanned,
                  trailingSl: after.trailingSl,
                  targetPlanned: after.targetPlanned,
                  updatedAt: sql`(datetime('now'))`,
                },
          )
          .where(eq(tradesTable.id, t.id))
          .run();

        recordAudit({
          entity: "trade",
          entityId: t.id,
          action: "update",
          summary: `${t.symbol} ${action.type} ${action.fromUnits}:${action.toUnits} applied (×${multiplier})`,
          before: { ...before },
          after: { ...after },
        });
        adjusted++;
      }
      tx.update(corporateActions).set({ appliedAt: sql`(datetime('now'))` }).where(eq(corporateActions.id, id)).run();
    });

    recordAudit({
      entity: "corporate_action",
      entityId: id,
      action: "update",
      summary: `${action.symbol} ${action.type} ${action.fromUnits}:${action.toUnits} applied to ${adjusted} position${adjusted === 1 ? "" : "s"}`,
    });
    return { ok: true, message: `Applied to ${adjusted} open position${adjusted === 1 ? "" : "s"}.`, positionsAdjusted: adjusted };
  }

  // dividend — open long equity holdings only.
  const perShare = action.dividendPerShare ?? 0;
  if (perShare <= 0) return { ok: false, message: "Invalid dividend amount — nothing to post." };
  const eligible = matching.filter((t) => t.instrumentType === "equity" && t.buyQty >= t.sellQty);

  // IND-6 — Section 194 TDS: 10% once this company's aggregate dividend to the
  // shareholder crosses ₹5,000 in the FY. Seed the running total from any
  // dividend already posted for this symbol this FY (earlier corporate actions).
  const fyStartMonth = getSettings()?.fyStartMonth ?? 4;
  const fy = fyOf(action.exDate, fyStartMonth);
  const priorDividends = db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.symbol, action.symbol))
    .all()
    .filter((e) => e.type === "dividend" && fyOf(e.date, fyStartMonth) === fy);
  let cumulative = priorDividends.reduce((s, e) => s + e.amountPaise, 0) / 100;

  let posted = 0;
  let tdsPosted = 0;
  db.transaction((tx) => {
    for (const t of eligible) {
      const qty = t.buyQty - t.sellQty || t.buyQty;
      const income = dividendIncome(qty, perShare);
      if (income <= 0) continue;
      const ins = tx
        .insert(ledgerEntries)
        .values({
          date: action.exDate,
          bucket: t.bucket,
          type: "dividend",
          amountPaise: toPaise(income),
          symbol: action.symbol,
          note: `${t.symbol} dividend @ ₹${perShare}/share × ${qty} qty`,
          refTradeId: t.id,
          source: "corporate_action",
        })
        .returning({ id: ledgerEntries.id })
        .get();
      recordAudit({
        entity: "ledger",
        entityId: ins?.id ?? null,
        action: "create",
        summary: `${t.symbol} dividend ₹${income} posted (₹${perShare}/share × ${qty})`,
        after: { symbol: t.symbol, qty, perShare, income },
      });
      posted++;

      const { tds } = computeEventTds(cumulative, income);
      cumulative += income;
      if (tds > 0) {
        const tdsIns = tx
          .insert(ledgerEntries)
          .values({
            date: action.exDate,
            bucket: t.bucket,
            type: "dividend_tds",
            amountPaise: -toPaise(tds),
            symbol: action.symbol,
            note: `${t.symbol} TDS @10% on dividend (FY ${fy} aggregate crossed ₹5,000)`,
            refTradeId: t.id,
            source: "corporate_action",
          })
          .returning({ id: ledgerEntries.id })
          .get();
        recordAudit({
          entity: "ledger",
          entityId: tdsIns?.id ?? null,
          action: "create",
          summary: `${t.symbol} dividend TDS ₹${tds} posted (FY ${fy})`,
          after: { symbol: t.symbol, fy, tds },
        });
        tdsPosted++;
      }
    }
    tx.update(corporateActions).set({ appliedAt: sql`(datetime('now'))` }).where(eq(corporateActions.id, id)).run();
  });

  recordAudit({
    entity: "corporate_action",
    entityId: id,
    action: "update",
    summary: `${action.symbol} dividend ₹${perShare}/share applied — ${posted} ledger entr${posted === 1 ? "y" : "ies"} posted`,
  });
  return {
    ok: true,
    message: `Posted ${posted} dividend ledger entr${posted === 1 ? "y" : "ies"}${tdsPosted > 0 ? ` (${tdsPosted} with TDS deducted — FY ${fy} aggregate crossed ₹5,000)` : ""}${matching.length > eligible.length ? ` (${matching.length - eligible.length} non-equity/short position${matching.length - eligible.length === 1 ? "" : "s"} skipped)` : ""}.`,
    ledgerPosted: posted + tdsPosted,
  };
}
