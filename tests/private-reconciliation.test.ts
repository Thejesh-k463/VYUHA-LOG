import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { rankParsers, buildContext } from "@/lib/import/detect";

// SheetJS 0.20.x ships an `exports` map whose `import` condition resolves to
// xlsx.mjs, which has no bound `fs` — `XLSX.readFile` throws "Cannot access
// file". 0.18.5 had no exports map, so the CJS build (which self-binds fs) was
// picked. Binding it here keeps readFile working; the app itself never calls
// readFile, it hands SheetJS a Buffer.
XLSX.set_fs(fs);


/**
 * RECONCILIATION AGAINST THE BROKER'S OWN STATEMENT.
 *
 * Until 2026-09-04 this ran only where the real exports existed
 * (tests/fixtures/private/, gitignored) and was skipped on CI. It now reads
 * the REDACTED copies of the same three files (tests/fixtures/redacted/,
 * three-row rule: every row kept, only identity tokenised — see
 * scripts/fixtures/redact-broker-export.mjs), so it runs everywhere and
 * nothing here is `skipIf`. Every number below was re-derived from the
 * redacted files on 2026-09-04 and is pinned exactly; the source figure is
 * beside each one.
 *
 * What it proves (first measured 2026-08-20, recorded in DECISIONS.md):
 *
 * Paytm Money — the 414-execution tradebook, paired FIFO with same-day
 * netting and the inferred opening inventory, reproduces Paytm's own
 * "Realized P&L Detail" lot by lot: Paytm's lot values are CHARGE-INCLUSIVE
 * (its P&L Value is net), so our gross P&L minus the apportioned stated
 * charges is compared with its P&L per ISIN. 47 of the 52 ISINs with an
 * in-window lot agree within ₹25; four more within ₹400 (charge split between
 * an opening-sell portion and the closed remainder); the last differs by
 * exactly the 3,200 shares of opening inventory the tradebook cannot see.
 * Totals: our closed net ₹12,34,049.34 vs Paytm's in-window-bought lots
 * ₹12,51,954.19 (−1.43%); the ₹7,71,677.78 Paytm earns on the 27 lots bought
 * BEFORE the window is exactly what our 24 opening sells leave blank —
 * unknowable from this file, never invented.
 *
 * Zerodha — 1,554 fills → 28 positions; 11 are opening sells carrying no
 * P&L; the conservation check passes; every position has a fill time. The
 * Console P&L on disk covers a different period, so it cannot serve as the
 * tradebook's reference — stated, not glossed over.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const PAYTM_TB = path.join(DIR, "paytm-tradebook-2026-08-01_2026-08-18.xlsx");
const PAYTM_PNL = path.join(DIR, "paytm-equity-pnl-2026-08-01_2026-08-18.xls");
const ZERODHA_TB = path.join(DIR, "zerodha-tradebook-2026-04-01_2026-08-11.xlsx");

const MON: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const iso = (s: unknown) => {
  const m = String(s).match(/(\d{2})-([A-Za-z]{3})-(\d{4})/);
  return m ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Loaded under a NEUTRAL name (the real exports name no broker either), so the claim is carried by content. */
async function parse(file: string, name: string) {
  const ctx = buildContext(name, fs.readFileSync(file));
  const top = rankParsers(ctx)[0];
  return { sourceId: top.sourceId, parsed: await top.parse(ctx) };
}

describe("Paytm Money tradebook vs Paytm's own Realized P&L Detail", () => {
  it("pairs the real tradebook into positions that match the broker's lots (net of charges)", async () => {
    const { sourceId, parsed } = await parse(PAYTM_TB, "Tradebook_EQ.xlsx");
    expect(sourceId).toBe("paytm-tradebook");
    expect(parsed.sourceRows).toBe(414); // 414 execution rows in the file

    const trades = parsed.trades;
    const opening = trades.filter((t) => t.basisUnknown);
    const closed = trades.filter((t) => !t.basisUnknown && t.buyQty === t.sellQty && t.buyQty > 0);
    expect(trades).toHaveLength(146); // 414 executions → 146 positions
    // Nothing is fabricated for a sale whose purchase the file never shows.
    expect(opening).toHaveLength(24); // 24 opening sells
    for (const t of opening) expect(t.grossPnl).toBe(0);
    expect(closed).toHaveLength(92); // 92 fully closed positions (30 remain open)
    // The stated charges are conserved to the paise across the positions.
    const statedTotal = r2(trades.reduce((a, t) => a + (t.reportedCharges?.total ?? 0), 0));
    expect(statedTotal).toBe(198915.04); // Σ of the file's six charge columns

    // Broker reference: one row per matched lot, charge-inclusive values.
    const wb = XLSX.readFile(PAYTM_PNL);
    const rows = (XLSX.utils.sheet_to_json(wb.Sheets["Realized P&L Detail"], { header: 1, raw: true, defval: "" }) as unknown[][]).filter((r) => r.some((c) => c !== ""));
    const hi = rows.findIndex((r) => r[0] === "Scrip Name");
    const lots = rows.slice(hi + 1).filter((r) => r[0] !== "Total" && r[1]);
    expect(lots).toHaveLength(124); // 124 matched lots in Paytm's statement
    const ref = new Map<string, number>();
    let refInWindow = 0, preWindowLots = 0, preWindowPl = 0;
    for (const r of lots) {
      const bought = iso(r[3])!;
      const pl = Number(r[9]);
      if (bought < "2026-08-03") { preWindowLots++; preWindowPl += pl; continue; } // bought before the tradebook window → our opening sells
      ref.set(String(r[1]), (ref.get(String(r[1])) ?? 0) + pl);
      refInWindow += pl;
    }
    expect(preWindowLots).toBe(27); // 27 lots bought before 03-08-2026…
    expect(r2(preWindowPl)).toBe(771677.78); // …earning ₹7,71,677.78 that our 24 opening sells leave blank
    const ours = new Map<string, number>();
    for (const t of closed) ours.set(t.isin!, (ours.get(t.isin!) ?? 0) + t.grossPnl - (t.reportedCharges?.total ?? 0));
    let within25 = 0, within400 = 0;
    for (const [isin, pl] of ref) {
      const d = Math.abs((ours.get(isin) ?? 0) - pl);
      if (d < 25) within25++;
      if (d < 400) within400++;
    }
    expect(ref.size).toBe(52); // ISINs with at least one lot bought inside the window
    expect(within25).toBe(47); // 47 of 52 within ₹25
    expect(within400).toBe(51); // 51 of 52 within ₹400 (the last is the 3,200-share opening inventory)
    const ourNet = r2(closed.reduce((a, t) => a + t.grossPnl - (t.reportedCharges?.total ?? 0), 0));
    expect(ourNet).toBe(1234049.34); // our closed net
    expect(r2(refInWindow)).toBe(1251954.19); // Paytm's in-window-bought lots
    expect(r2((100 * Math.abs(ourNet - refInWindow)) / refInWindow)).toBe(1.43); // −1.43%, under the 2% the parser promises
  });
});

describe("Zerodha Console tradebook (real, redacted)", () => {
  it("1,554 fills pair into 28 positions with no fabricated P&L and fill times throughout", async () => {
    const { sourceId, parsed } = await parse(ZERODHA_TB, "export.xlsx");
    expect(sourceId).toBe("zerodha");
    expect(parsed.sourceRows).toBe(1554); // 1,554 fills
    expect(parsed.trades).toHaveLength(28); // → 28 positions (not the old 23-row whole-file aggregate, not one per fill)
    const opening = parsed.trades.filter((t) => t.basisUnknown);
    expect(opening).toHaveLength(11); // 11 opening sells
    for (const t of opening) expect(t.grossPnl).toBe(0);
    expect(parsed.trades.filter((t) => !(t.entryTime ?? t.exitTime))).toHaveLength(0); // every position has a fill time
    expect(r2(parsed.trades.reduce((a, t) => a + t.grossPnl, 0))).toBe(521783.6); // Σ gross over the 17 positions with a basis
    expect(parsed.warnings.some((w) => /conservation check FAILED/i.test(w))).toBe(false);
  });
});
