import "server-only";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts as accountsTable, trades as tradesTable } from "@/lib/db/schema";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { normalizeDate, todayIstIso } from "@/lib/domain/trading-day";
import {
  mtfInterestOver,
  plansFor,
  resolvePlan,
  resolvePlanAcross,
  type PlanAccount,
  type RatesMap,
} from "@/lib/engine/rates";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { recordAudit } from "@/lib/audit";

/**
 * WHICH PLAN PRICES A TRADE — the server-only half (invariant 2).
 *
 * `lib/engine/rates.ts` holds the RULE (`resolvePlan`, pure, unit-testable);
 * this module holds the READ (which account, what it states) and nothing else.
 * Every pricing site takes its plan from here or from a plan string handed
 * down from here — no site invents one, and no site passes a broker's plan to
 * another broker's rate key.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The plan facts of every account, keyed by id. One query. */
export function planAccountsById(): Map<number, PlanAccount> {
  const rows = db
    .select({
      id: accountsTable.id,
      broker: accountsTable.broker,
      brokerPlan: accountsTable.brokerPlan,
      brokerPlanFrom: accountsTable.brokerPlanFrom,
    })
    .from(accountsTable)
    .all();
  return new Map(rows.map((a) => [a.id, { broker: a.broker, brokerPlan: a.brokerPlan, brokerPlanFrom: a.brokerPlanFrom }]));
}

/** One account's plan facts, or null when the id names no account. */
export function planAccountOf(accountId: number | null | undefined): PlanAccount | null {
  if (accountId == null || accountId <= 0) return null;
  const a = db
    .select({
      broker: accountsTable.broker,
      brokerPlan: accountsTable.brokerPlan,
      brokerPlanFrom: accountsTable.brokerPlanFrom,
    })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId))
    .get();
  return a ?? null;
}

/**
 * The plan for a trade written to / read from ONE account. "default" for an
 * account that states none, for another broker's row in that account, and for
 * a date before the plan started — the pure rule decides all three.
 */
export function planForAccount(
  accountId: number | null | undefined,
  tradeBroker: string | null | undefined,
  onDate: string,
  map: RatesMap,
): string {
  return resolvePlan(planAccountOf(accountId), tradeBroker, onDate, map);
}

/**
 * The plan for a figure priced in a VIEW — the read-only estimate surfaces
 * whose rows carry no account id (/equity breakeven, /targets/equity,
 * /sizing-lab). In a single-account view it is that account's plan; in the
 * All-accounts view every account on the broker must agree (invariant 6 — two
 * accounts under two plans have no single honest answer).
 */
export function planForView(tradeBroker: string | null | undefined, onDate: string, map: RatesMap): string {
  const id = getSelectedAccountId();
  const all = [...planAccountsById().entries()];
  const inView = id > 0 ? all.filter(([aid]) => aid === id) : all;
  return resolvePlanAcross(inView.map(([, a]) => a), tradeBroker, onDate, map);
}

/** The plan keys `charge_config` holds for a broker, "default" first. */
export function plansForBroker(broker: string | null | undefined, map: RatesMap = loadRatesMap()): string[] {
  return broker ? plansFor(map, broker) : [];
}

/**
 * Every broker that sells more than one plan, with each plan's label and
 * monthly fee — what the account editor renders a plan picker from. Derived
 * from `charge_config`, never a hard-coded broker name (D1): the day a second
 * broker gets a tier, its accounts get the picker with no UI change.
 */
export interface PlanOption {
  plan: string;
  label: string;
  subscriptionMonthly: number;
}

export function brokerPlanOptions(map: RatesMap = loadRatesMap()): Record<string, PlanOption[]> {
  const out: Record<string, PlanOption[]> = {};
  const labels = new Map<string, { label: string | null; monthly: number }>();
  for (const [k, epochs] of map) {
    const [broker, plan] = k.split("|");
    const row = epochs[0];
    if (!row) continue;
    if (!labels.has(`${broker}|${plan}`)) labels.set(`${broker}|${plan}`, { label: row.planLabel ?? null, monthly: row.subscriptionMonthly ?? 0 });
  }
  const byBroker = new Map<string, Set<string>>();
  for (const key of labels.keys()) {
    const [broker, plan] = key.split("|");
    const set = byBroker.get(broker) ?? new Set<string>();
    set.add(plan);
    byBroker.set(broker, set);
  }
  for (const [broker, plans] of byBroker) {
    if (plans.size < 2) continue; // one plan = no question to ask
    out[broker] = [...plans]
      .sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)))
      .map((plan) => {
        const meta = labels.get(`${broker}|${plan}`);
        return {
          plan,
          label: plan === "default" ? (meta?.label ?? "Standard (free)") : (meta?.label ?? plan),
          subscriptionMonthly: meta?.monthly ?? 0,
        };
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Changing an account's plan: preview first, then audit every row it moves
// ---------------------------------------------------------------------------

export interface PlanChangeRow {
  id: number;
  tradingsymbol: string;
  was: number;
  will: number;
}

export interface PlanChangePreview {
  /** Open MTF rows in this account whose accrued interest the change moves. */
  rows: PlanChangeRow[];
  count: number;
  wasTotal: number;
  willTotal: number;
  message: string;
}

/**
 * WHAT SETTING THIS PLAN WOULD MOVE — asked BEFORE it is set.
 *
 * Nothing else in this feature touches a stored figure: a saved row's
 * `charges_*` is money that already left the account and the plan changes only
 * what is computed fresh. The ONE exception is the daily MTF accrual, which
 * recomputes interest on still-OPEN rows from the buy date and writes
 * `chargesTotal` and `netPnl` back — so a plan change silently restates them
 * on the next /equity render. DECISIONS 2026-08-30 decision 6 forbids a stored
 * P&L moving with no prompt and no audit row, so the user is shown the rows
 * and the two totals, and `applyPlanChange` writes one audit row per row moved.
 *
 * Staged rows are NOT listed: their charges have one writer, the ladder
 * (`rebuildStagedTrade`), which re-prices per leg on its next rebuild.
 */
export function previewPlanChange(
  accountId: number,
  next: { brokerPlan: string | null; brokerPlanFrom: string | null },
  today = todayIstIso(),
): PlanChangePreview {
  const map = loadRatesMap();
  const before = planAccountOf(accountId);
  const after: PlanAccount = {
    broker: before?.broker ?? null,
    brokerPlan: next.brokerPlan,
    brokerPlanFrom: next.brokerPlanFrom,
  };
  const open = db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.accountId, accountId), eq(tradesTable.segment, "eq_mtf"), eq(tradesTable.isOpen, true)))
    .all();

  const rows: PlanChangeRow[] = [];
  for (const t of open) {
    if (t.staged) continue; // the ladder owns a staged row's charges
    const funded = t.mtfFundedAmount;
    if (funded == null) continue; // an unpriced row accrues nothing either way (Q-A)
    const buyIso = normalizeDate(t.buyDate);
    if (!buyIso) continue;
    try {
      const was = mtfInterestOver(map, t, funded, before, buyIso, today);
      const will = mtfInterestOver(map, t, funded, after, buyIso, today);
      if (was !== will) rows.push({ id: t.id, tradingsymbol: t.tradingsymbol, was, will });
    } catch {
      // No rate epoch covers this holding period under one of the two plans —
      // the accrual leaves such a row alone, so this preview claims nothing.
    }
  }
  const wasTotal = r2(rows.reduce((s, r) => s + r.was, 0));
  const willTotal = r2(rows.reduce((s, r) => s + r.will, 0));
  return {
    rows,
    count: rows.length,
    wasTotal,
    willTotal,
    message:
      rows.length === 0
        ? "No stored figure moves: no open MTF position in this account re-accrues under this plan."
        : `${rows.length} open MTF ${rows.length === 1 ? "row" : "rows"} re-accrue: was ₹${wasTotal.toLocaleString("en-IN")}, will be ₹${willTotal.toLocaleString("en-IN")}. Each one is recorded in the audit trail.`,
  };
}

/**
 * Re-accrue the rows `previewPlanChange` listed, writing ONE audit row each.
 *
 * Called by the accounts route immediately after the plan is stored, inside
 * the same request, so the figures the user confirmed are the figures written.
 * Idempotent with the daily job: it computes the same number the next accrual
 * would, which is the point — the accrual then finds nothing to move.
 */
export function applyPlanChange(accountId: number, preview: PlanChangePreview, planLabel: string): number {
  let moved = 0;
  for (const row of preview.rows) {
    const t = db.select().from(tradesTable).where(eq(tradesTable.id, row.id)).get();
    if (!t) continue;
    const newCharges = r2(t.chargesTotal - t.mtfInterest + row.will);
    const newNet = r2(t.grossPnl - newCharges);
    const before = { mtfInterest: t.mtfInterest, chargesTotal: t.chargesTotal, netPnl: t.netPnl };
    db.update(tradesTable)
      .set({ mtfInterest: row.will, chargesTotal: newCharges, netPnl: newNet })
      .where(eq(tradesTable.id, t.id))
      .run();
    recordAudit({
      entity: "trade",
      entityId: t.id,
      action: "update",
      summary: `MTF interest re-accrued on ${t.tradingsymbol} — broker plan set to ${planLabel}`,
      before,
      after: { mtfInterest: row.will, chargesTotal: newCharges, netPnl: newNet },
      source: "account-plan",
    });
    moved++;
  }
  return moved;
}
