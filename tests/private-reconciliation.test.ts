import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { rankParsers, buildContext } from "@/lib/import/detect";

/**
 * RECONCILIATION AGAINST THE BROKER'S OWN STATEMENT — runs only where the
 * real exports exist (tests/fixtures/private/, gitignored). On CI it is
 * skipped, never failed. Nothing here quotes an identifier.
 *
 * What it proves (measured 2026-08-20, recorded in DECISIONS.md):
 *
 * Paytm Money — the 414-execution tradebook, paired FIFO with same-day
 * netting and the inferred opening inventory, reproduces Paytm's own
 * "Realized P&L Detail" lot by lot: Paytm's lot values are CHARGE-INCLUSIVE
 * (its P&L Value is net), so our gross P&L minus the apportioned stated
 * charges is compared with its P&L per ISIN. 47 of the 52 ISINs with an in-window lot agree within
 * ₹25; four more within ₹400 (charge split between an opening-sell portion
 * and the closed remainder); the last differs by exactly the 3,200 shares
 * of opening inventory the tradebook cannot see (the file shows a minimum of
 * 44,800 sold-from-holdings; the broker had 48,000). Totals: our closed net
 * ₹12,34,049 vs Paytm's in-window-bought lots ₹12,51,954 (−1.4%); the
 * ₹7.7 L Paytm earns on lots bought BEFORE the window is exactly what our
 * 24 opening sells leave blank — unknowable from this file, never invented.
 *
 * Zerodha — 1,554 fills → 28 positions; 11 are opening sells carrying no
 * P&L; the conservation check passes; every position has a fill time. The
 * Console P&L on disk covers a different period (JSLL shows 0 there; QUESTLAB
 * is absent), so it cannot serve as the tradebook's reference — stated, not
 * glossed over.
 */

const PRIV = path.join(process.cwd(), "tests", "fixtures", "private");
const PAYTM_TB = path.join(PRIV, "Paytm Money - Tradebook (real).xlsx");
const PAYTM_PNL = path.join(PRIV, "Paytm Money - EquityPnL (real).xls");
const ZERODHA_TB = path.join(PRIV, "Zerodha Tradebook (real).xlsx");
const have = [PAYTM_TB, PAYTM_PNL, ZERODHA_TB].every((f) => fs.existsSync(f));

const MON: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const iso = (s: unknown) => {
  const m = String(s).match(/(\d{2})-([A-Za-z]{3})-(\d{4})/);
  return m ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null;
};

async function parse(file: string, name: string) {
  const ctx = buildContext(name, fs.readFileSync(file));
  const top = rankParsers(ctx)[0];
  return { sourceId: top.sourceId, parsed: await top.parse(ctx) };
}

describe.skipIf(!have)("Paytm Money tradebook vs Paytm's own Realized P&L Detail", () => {
  it("pairs the real tradebook into positions that match the broker's lots (net of charges)", async () => {
    const { sourceId, parsed } = await parse(PAYTM_TB, "Tradebook_EQ.xlsx");
    expect(sourceId).toBe("paytm-tradebook");
    expect(parsed.sourceRows).toBe(414);

    const trades = parsed.trades;
    const opening = trades.filter((t) => t.basisUnknown);
    const closed = trades.filter((t) => !t.basisUnknown && t.buyQty === t.sellQty && t.buyQty > 0);
    // Nothing is fabricated for a sale whose purchase the file never shows.
    expect(opening.length).toBeGreaterThan(0);
    for (const t of opening) expect(t.grossPnl).toBe(0);
    // The stated charges are conserved to the paise across the positions.
    const statedTotal = trades.reduce((a, t) => a + (t.reportedCharges?.total ?? 0), 0);
    expect(Math.abs(statedTotal - 198915.04)).toBeLessThan(0.5);

    // Broker reference: one row per matched lot, charge-inclusive values.
    const wb = XLSX.readFile(PAYTM_PNL);
    const rows = (XLSX.utils.sheet_to_json(wb.Sheets["Realized P&L Detail"], { header: 1, raw: true, defval: "" }) as unknown[][]).filter((r) => r.some((c) => c !== ""));
    const hi = rows.findIndex((r) => r[0] === "Scrip Name");
    const lots = rows.slice(hi + 1).filter((r) => r[0] !== "Total" && r[1]);
    const ref = new Map<string, number>();
    let refInWindow = 0;
    for (const r of lots) {
      const bought = iso(r[3])!;
      if (bought < "2026-08-03") continue; // bought before the tradebook window → our opening sells
      const pl = Number(r[9]);
      ref.set(String(r[1]), (ref.get(String(r[1])) ?? 0) + pl);
      refInWindow += pl;
    }
    const ours = new Map<string, number>();
    for (const t of closed) ours.set(t.isin!, (ours.get(t.isin!) ?? 0) + t.grossPnl - (t.reportedCharges?.total ?? 0));
    let agree = 0;
    for (const [isin, pl] of ref) if (Math.abs((ours.get(isin) ?? 0) - pl) < 25) agree++;
    expect(ref.size).toBe(52); // ISINs with at least one lot bought inside the window
    expect(agree).toBeGreaterThanOrEqual(47); // 47 of 52 within ₹25 (55 of 60 counting pre-window-only ISINs, which agree at 0)
    const ourNet = closed.reduce((a, t) => a + t.grossPnl - (t.reportedCharges?.total ?? 0), 0);
    expect(Math.abs(ourNet - refInWindow) / refInWindow).toBeLessThan(0.02);
  });
});

describe.skipIf(!have)("Zerodha Console tradebook (real)", () => {
  it("1,554 fills pair into positions with no fabricated P&L and fill times throughout", async () => {
    const { sourceId, parsed } = await parse(ZERODHA_TB, "export.xlsx");
    expect(sourceId).toBe("zerodha");
    expect(parsed.sourceRows).toBe(1554);
    expect(parsed.trades.length).toBeGreaterThan(23); // the old whole-file aggregate
    expect(parsed.trades.length).toBeLessThan(100); // and not one position per fill
    const opening = parsed.trades.filter((t) => t.basisUnknown);
    expect(opening.length).toBeGreaterThan(0);
    for (const t of opening) expect(t.grossPnl).toBe(0);
    for (const t of parsed.trades) expect(t.entryTime ?? t.exitTime).toBeTruthy();
    expect(parsed.warnings.some((w) => /conservation check FAILED/i.test(w))).toBe(false);
  });
});
