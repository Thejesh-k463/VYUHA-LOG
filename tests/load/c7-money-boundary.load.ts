import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "../helpers/temp-db";
import { report, rng, time } from "./helpers/measure";

/**
 * C7 — money at the column boundary, summed 250,000 times.
 *
 * `moneyPaise.fromDriver` hands each row back as `paise / 100` — a double
 * that is exact for the row (every value with two decimals is representable
 * closely enough to print) but not exact to add: `getTradeStats` folds
 * 250,000 of them with `+` and rounds at the end. The book's true net is an
 * INTEGER — `SELECT SUM(net_pnl_paise)` — and that is what the float sum is
 * compared against here, in paise, before and after the two-decimal rounding
 * the query applies.
 *
 * Seeded by RAW SQL in one transaction, so the wire is paise (README: pick a
 * side and say so). Amounts are drawn to look like a real F&O + delivery
 * book — mostly small, a fat tail up to ±₹5 lakh, and every value has a
 * non-zero paise part so the float sum is genuinely fractional.
 */

let t: TempDb;
let q: typeof import("@/lib/queries/trades");

const TRADES = 250_000;

beforeAll(async () => {
  t = await openTempDb("c7-money", { seed: true });
  q = await import("@/lib/queries/trades");

  const rand = rng(0xc7);
  const ins = t.sqlite.prepare(
    `insert into trades (account_id, broker, bucket, segment, instrument_type, exchange, symbol, tradingsymbol, dedup_hash,
       buy_date, sell_date, is_open, gross_pnl_paise, charges_total_paise, net_pnl_paise)
     values (1, 'dhan', 'equity', 'eq_delivery', 'equity', 'NSE', ?, ?, ?, '2026-07-01', '2026-07-10', 0, ?, ?, ?)`,
  );
  const seedMs = time("seed 250k trades (raw SQL, paise)", TRADES, () => {
    t.sqlite.transaction(() => {
      for (let i = 0; i < TRADES; i++) {
        // Log-ish magnitude: 80% under ₹5,000, tail to ±₹5,00,000. Always with paise.
        const mag = rand() < 0.8 ? rand() * 500_000 : rand() * 50_000_000;
        const gross = Math.round((rand() < 0.45 ? -1 : 1) * mag) || 1;
        const charges = Math.round(37 + rand() * 25_000);
        ins.run(`S${i % 500}`, `S${i % 500}`, `c7-${i}`, gross, charges, gross - charges);
      }
    })();
  });
  report(seedMs, { test: "c7-seed" });
});
afterAll(() => t?.cleanup());

describe("C7 · float summation vs the integer book", () => {
  it("getTradeStats totals equal SUM(*_paise)/100 to the paise", () => {
    const truth = t.sqlite
      .prepare("select sum(net_pnl_paise) as net, sum(gross_pnl_paise) as gross, sum(charges_total_paise) as charges, count(*) as n from trades")
      .get() as { net: number; gross: number; charges: number; n: number };
    expect(truth.n).toBe(TRADES);

    let stats!: ReturnType<typeof q.getTradeStats>;
    const timing = time("getTradeStats over 250k trades", TRADES, () => { stats = q.getTradeStats(); });

    // Also measure the RAW drift of the naive fold, before rounding, so the
    // decision log records how far off the double actually is at this scale.
    const rows = t.sqlite.prepare("select net_pnl_paise as p from trades").all() as { p: number }[];
    const naive = rows.reduce((s, r) => s + r.p / 100, 0);
    const driftPaise = naive * 100 - truth.net;

    report(timing, { test: "c7", driftPaiseBeforeRounding: driftPaise, net: stats.net, truthNet: truth.net / 100 });
    console.log(
      `    truth ₹${(truth.net / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })} · naive fold drift ${driftPaise.toExponential(2)} paise · ` +
        `getTradeStats.net ₹${stats.net.toLocaleString("en-IN", { minimumFractionDigits: 2 })} · ${timing.ms.toFixed(0)} ms`,
    );

    // The user-facing figures, in paise, must be the integer truth exactly.
    expect(Math.round(stats.net * 100), `net drifted by ${Math.round(stats.net * 100) - truth.net} paise`).toBe(truth.net);
    expect(Math.round(stats.gross * 100), `gross drifted by ${Math.round(stats.gross * 100) - truth.gross} paise`).toBe(truth.gross);
    expect(Math.round(stats.charges * 100), `charges drifted by ${Math.round(stats.charges * 100) - truth.charges} paise`).toBe(truth.charges);
    expect(stats.count).toBe(TRADES);
  });

  it("the drift, if any, is below a paisa across many seeds of a 25k book (HEAVY tier)", () => {
    // Twenty different 25k subsets, so the result is not one lucky seed. Pure
    // arithmetic on the values already loaded — no DB reseed.
    const rows = t.sqlite.prepare("select net_pnl_paise as p from trades").all() as { p: number }[];
    const rand = rng(0xc7 + 1);
    let worst = 0;
    for (let s = 0; s < 20; s++) {
      const start = Math.floor(rand() * (TRADES - 25_000));
      const slice = rows.slice(start, start + 25_000);
      const truth = slice.reduce((a, r) => a + r.p, 0);
      const naive = slice.reduce((a, r) => a + r.p / 100, 0);
      worst = Math.max(worst, Math.abs(Math.round(naive * 100) - truth));
    }
    console.log(`    worst rounded drift over 20 × 25k slices: ${worst} paise`);
    expect(worst).toBe(0);
  });
});
