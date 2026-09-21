import type Database from "better-sqlite3";
import { resolvePerTradeCap, LEGACY_SEED_CAP, type CapRow } from "@/lib/risk/limits";
import { hasPlanR } from "@/lib/analytics/win-loss";

/**
 * CAP-R — the per-trade cap is a UNIT, so every R measured in it follows it
 * (v4.4.0 D1, owner ruling OQ1).
 *
 * R is STORED and re-priced by writers, never derived at read time: thirty-odd
 * readers of `r_multiple` would be thirty chances to read it under another
 * rule. The invariant every writer keeps, and `tests/harness-book-sequences`
 * (I7) sweeps after every operation:
 *
 *   risk_source = 'cap'  ⇒  risk_amount = resolvePerTradeCap(bucket, segment)
 *                           (null allowed — no cap, no risk, no R)
 *                        and r_multiple = r2(net ÷ risk) when risk > 0, else null
 *
 * 'set' and 'frozen' rows are never touched here: a typed risk is the user's,
 * and a staged position's R is frozen at its first entry (invariant 4).
 *
 * NOT server-only and no `@/lib/db` import, on purpose: `lib/db/data-fixes.ts`
 * (the `risk-source-v1` fix, run on every connection open and after every
 * backup restore) calls these with its own connection, and the desktop
 * migrator reaches that module without Next's server condition. `tx` is the
 * better-sqlite3 connection the caller's transaction runs on — `sqlite` from
 * lib/db inside a `db.transaction(...)` is the same connection, so these raw
 * statements join it.
 *
 * MONEY (invariant 1): `risk_amount_paise` and `net_pnl_paise` are INTEGER
 * paise at rest and these statements read and write them raw, so each
 * crossing converts exactly ONCE — paise ÷ 100 on the read, rupees × 100
 * rounded on the write (the `moneyPaise` column's own two formulas). R is
 * computed in JS with the writers' `Math.round(x * 100) / 100`, never SQL
 * ROUND (−0.125 → −0.12 in JS, −0.13 in SQLite).
 */

export type RiskSource = "cap" | "set" | "frozen";

type Conn = Pick<Database.Database, "prepare">;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Every risk_config row as the resolver reads it (raw — no drizzle select). */
export function readCapRows(tx: Conn): CapRow[] {
  return tx
    .prepare("SELECT scope, key, per_trade_max_loss AS perTradeMaxLoss, cap_scheme AS capScheme FROM risk_config")
    .all() as CapRow[];
}

/** R for a row whose risk is `risk` rupees — the writers' one formula. */
export const capR = (netPnl: number, risk: number | null): number | null =>
  risk != null && risk > 0 ? r2(netPnl / risk) : null;

/** Build `AND id IN (…)` for an optional id list; an EMPTY list matches nothing. */
function idFilter(ids: readonly number[] | undefined): { sql: string; args: number[] } | null {
  if (ids === undefined) return { sql: "", args: [] };
  if (ids.length === 0) return null;
  return { sql: ` AND id IN (${ids.map(() => "?").join(",")})`, args: [...ids] };
}

interface RawRiskRow {
  id: number;
  staged: number;
  bucket: string;
  segment: string;
  risk_amount_paise: number | null;
  net_pnl_paise: number;
  r_multiple: number | null;
  sl_planned: number | null;
  trailing_sl: number | null;
  avg_buy_price: number;
  avg_sell_price: number;
  buy_qty: number;
  sell_qty: number;
}

/**
 * The classification of a row whose `risk_source` is NULL but which holds a
 * risk — a row written before migration 0073, or one restored from a pre-0073
 * backup or Trash envelope. ONE function, called by the `risk-source-v1` data
 * fix AND by Trash restore (lib/trash.ts), so the two can never disagree:
 *
 *   staged                                     → 'frozen'  (invariant 4)
 *   its risk ties to its own stop (`hasPlanR`) → 'set'     (the user's plan)
 *   risk = ₹9,500 or the current global cap    → 'cap'     (what imports wrote)
 *   anything else                              → 'set'     (typed — kept)
 *
 * qty = max(buy_qty, sell_qty), the /arjuns-eye projection `hasPlanR` is fed.
 * The undetectable edge: a row imported under a global cap the user has since
 * changed holds neither figure, and is kept as 'set' at the value it holds.
 */
export function classifyRiskSource(row: {
  staged: boolean;
  riskAmount: number;
  slPlanned: number | null;
  trailingSl: number | null;
  avgBuyPrice: number;
  avgSellPrice: number;
  buyQty: number;
  sellQty: number;
}, globalCap: number | null): RiskSource {
  if (row.staged) return "frozen";
  const plan = hasPlanR({
    riskAmount: row.riskAmount,
    qty: Math.max(row.buyQty, row.sellQty),
    slPlanned: row.slPlanned,
    trailingSl: row.trailingSl,
    avgBuyPrice: row.avgBuyPrice,
    avgSellPrice: row.avgSellPrice,
  } as Parameters<typeof hasPlanR>[0]);
  if (plan) return "set";
  if (row.riskAmount === LEGACY_SEED_CAP || (globalCap != null && row.riskAmount === globalCap)) return "cap";
  return "set";
}

/**
 * Stamp a source on every row that holds a risk but states none (optionally
 * only the rows in `ids`). Returns how many rows were classified.
 */
export function classifyUnsourcedRisk(tx: Conn, opts: { ids?: readonly number[] } = {}): number {
  const f = idFilter(opts.ids);
  if (!f) return 0;
  const rows = tx
    .prepare(
      `SELECT id, staged, bucket, segment, risk_amount_paise, net_pnl_paise, r_multiple, sl_planned, trailing_sl,
              avg_buy_price, avg_sell_price, buy_qty, sell_qty
         FROM trades
        WHERE risk_source IS NULL AND risk_amount_paise IS NOT NULL${f.sql}
        ORDER BY id`,
    )
    .all(...f.args) as RawRiskRow[];
  if (rows.length === 0) return 0;
  const globalCap = resolvePerTradeCap(readCapRows(tx), "", "");
  const write = tx.prepare("UPDATE trades SET risk_source = ? WHERE id = ?");
  for (const r of rows) {
    const source = classifyRiskSource(
      {
        staged: r.staged === 1,
        riskAmount: r.risk_amount_paise! / 100,
        slPlanned: r.sl_planned,
        trailingSl: r.trailing_sl,
        avgBuyPrice: r.avg_buy_price,
        avgSellPrice: r.avg_sell_price,
        buyQty: r.buy_qty,
        sellQty: r.sell_qty,
      },
      globalCap,
    );
    write.run(source, r.id);
  }
  return rows.length;
}

/**
 * Re-price every non-staged `'cap'` row (optionally only `opts.ids`) to the cap
 * its bucket/segment resolves to NOW, and its R to r2(net ÷ risk). Rows already
 * holding today's figures are not written at all. Returns the rows it moved.
 *
 * Called by the risk editor's save (app/api/settings/route.ts), "back to my
 * defaults" (lib/queries/settings-baseline.ts), Trash restore (lib/trash.ts)
 * and the `risk-source-v1` data fix — each inside its own transaction.
 */
export function repriceCapTrades(tx: Conn, opts: { ids?: readonly number[] } = {}): number {
  const f = idFilter(opts.ids);
  if (!f) return 0;
  const rows = tx
    .prepare(
      `SELECT id, bucket, segment, risk_amount_paise, net_pnl_paise, r_multiple
         FROM trades
        WHERE risk_source = 'cap' AND staged = 0${f.sql}
        ORDER BY id`,
    )
    .all(...f.args) as Pick<RawRiskRow, "id" | "bucket" | "segment" | "risk_amount_paise" | "net_pnl_paise" | "r_multiple">[];
  if (rows.length === 0) return 0;
  const caps = readCapRows(tx);
  const write = tx.prepare("UPDATE trades SET risk_amount_paise = ?, r_multiple = ? WHERE id = ?");
  let moved = 0;
  for (const r of rows) {
    const cap = resolvePerTradeCap(caps, r.bucket, r.segment);
    const riskPaise = cap == null ? null : Math.round(cap * 100);
    const rMultiple = capR(r.net_pnl_paise / 100, riskPaise == null ? null : riskPaise / 100);
    if (riskPaise === r.risk_amount_paise && rMultiple === r.r_multiple) continue;
    write.run(riskPaise, rMultiple, r.id);
    moved++;
  }
  return moved;
}
