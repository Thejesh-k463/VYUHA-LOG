import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { backfillSide, INTRADAY_SHORT_NOTE, sideAfterEdit, sideOf, statedSideOf } from "@/lib/domain/side";
import { pairLegs, type Leg, type PairedPosition } from "@/lib/import/pair-legs";
import { dedupHash } from "@/lib/import/dedup";
import { legacyShortGroupRefusals, legacyShortLegMatch } from "@/lib/import/legacy-short";
import { staleSaleRows, type QualityTrade } from "@/lib/analytics/data-quality";

/**
 * v4.6.0 W6 — `trades.side` (migration 0077). Contract D1–D3, D5.
 *
 *   1. THE SCAN: no direction comparison (`sellQty > buyQty`, `buyQty >= sellQty`,
 *      `buyDate <= sellDate`, a SQL `sell_qty <`…) anywhere in lib/ app/
 *      components/ scripts/ but lib/domain/side.ts — every reader goes through
 *      `sideOf`.
 *   2. `backfillSide` over every clause, including the two shapes a SQL byte
 *      compare gets wrong: a 4.2.x 'DD-MM-YYYY' date and a time-suffixed
 *      same-day ISO date.
 *   3. The `trades-side-v1` data fix on a temp DB (NULLs only; a stated side is
 *      never overwritten), the backup restore (fix re-run in the same
 *      transaction) and the Trash restore (`withSide` fill).
 *
 * ONE temp database per FILE.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["lib", "app", "components", "scripts"];
const ALLOWED = new Set([path.join("lib", "domain", "side.ts")]);
// Fix wave (finding 5): the shapes the first scan could be dodged with —
// arithmetic (`sellQty - buyQty >= 0`), a non-null `!`, a `?? 0` default in
// parentheses, and the comparison written on the left (`0 < sellQty - buyQty`).
// A line that is a genuine QUANTITY fact, not a direction read, says so with
// the marker `// side-scan: quantity` on that line (`ALLOW_MARKER`).
const CMP = "(>=|<=|>|<)";
/** A comparison operator that is not the `>` of an arrow `=>`. */
const LCMP = String.raw`(?<![=\-])(>=|<=|>|<)`;
const NULLISH = String.raw`(?:\s*\?\?\s*(?:0|""|''|null)\s*\)?)?`;
const LEFT = (a: string) => String.raw`\b${a}\b(?:\s*!)?` + NULLISH;
const RIGHT = (b: string) => String.raw`\(?\s*[\w.?!]*\b${b}\b`;
const PAIRS: [string, string][] = [["sellQty", "buyQty"], ["buyQty", "sellQty"], ["sellDate", "buyDate"], ["buyDate", "sellDate"]];
const QTY_PAIRS = PAIRS.slice(0, 2);
const PATTERNS: RegExp[] = [
  ...PAIRS.map(([a, b]) => new RegExp(LEFT(a) + String.raw`\s*` + CMP + String.raw`\s*` + RIGHT(b))),
  ...QTY_PAIRS.map(([a, b]) => new RegExp(LEFT(a) + String.raw`\s*-\s*` + RIGHT(b) + String.raw`(?:\s*!)?` + NULLISH + String.raw`\s*` + CMP)),
  ...QTY_PAIRS.map(([a, b]) => new RegExp(LCMP + String.raw`\s*\(?\s*[\w.?!]*` + LEFT(a) + String.raw`\s*-\s*` + RIGHT(b))),
  /\bsell_qty\s*[<>]/,
  /\bbuy_qty\s*[<>]/,
];
const ALLOW_MARKER = "// side-scan: quantity";

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
}

/**
 * Code only: a line whose trimmed start is `//` or `*` is prose, and so is a
 * trailing ` //` comment — but only a ` //` OUTSIDE a string literal (the part
 * before it holds an even number of each quote character), so a code line is
 * never cut at a `" // "` inside a string and its comparison hidden.
 */
function codeOf(line: string): string {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*")) return "";
  const even = (s: string, q: string) => s.split(q).length % 2 === 1;
  for (let i = line.indexOf(" //"); i >= 0; i = line.indexOf(" //", i + 1)) {
    const before = line.slice(0, i);
    if (even(before, '"') && even(before, "'") && even(before, "`")) return before;
  }
  return line;
}

/** A line the scan reads: its code, unless it carries the quantity marker. */
const scanned = (line: string) => (line.includes(ALLOW_MARKER) ? "" : codeOf(line));

describe("the scan — direction is read only through sideOf", () => {
  it("finds no direction comparison outside lib/domain/side.ts", () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
    const hits: string[] = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      if (ALLOWED.has(rel)) continue;
      fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
        const code = scanned(line);
        if (PATTERNS.some((re) => re.test(code))) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the patterns can fire (a plant of each shape the scan exists for)", () => {
    const fires = (line: string) => PATTERNS.some((re) => re.test(scanned(line)));
    for (const plant of [
      "t.sellQty > t.buyQty", "t.buyQty >= t.sellQty", "p.buyDate <= p.sellDate", "x.sellDate < x.buyDate", "WHERE sell_qty > buy_qty",
      // Fix wave (finding 5) — the dodges:
      "t.sellQty - t.buyQty >= 0", // the arithmetic the W6 build used in positions.ts
      "0 < t.sellQty - t.buyQty",
      "(t.sellQty ?? 0) > (t.buyQty ?? 0)",
      "(t.sellQty ?? 0) - (t.buyQty ?? 0) > 0",
      "t.sellQty! > t.buyQty!",
      `(r.sellDate ?? "") < (r.buyDate ?? "")`,
      // A ` //` inside a string no longer hides the code after it…
      `const s = "a // b"; if (t.sellQty > t.buyQty) short();`,
      // …and a code line that opens with a block comment is still code.
      "/* legacy */ const short = t.sellQty > t.buyQty;",
    ]) {
      expect(fires(plant), plant).toBe(true);
    }
    // …and these are not direction reads: a sort on two rows' sale dates, a
    // net quantity, a lopsided test, prose, and a line MARKED as a quantity fact.
    for (const clean of [
      "return a.sellDate < b.sellDate ? dir : -dir;",
      "rows.map((t) => t.sellQty - t.buyQty)",
      "Math.abs(t.buyQty - t.sellQty) > 0",
      "// t.sellQty > t.buyQty was the old reading",
      " * t.sellQty > t.buyQty read every flat short as long",
      "const n = f(x); // t.sellQty > t.buyQty in prose",
      `: t.sellQty >= t.buyQty ${ALLOW_MARKER}`,
    ]) {
      expect(fires(clean), clean).toBe(false);
    }
  });
});

describe("backfillSide — every clause", () => {
  const row = (o: Partial<Parameters<typeof backfillSide>[0]>) => ({ buyQty: 10, sellQty: 10, buyDate: null, sellDate: null, importNotes: null, ...o });

  it("1. a lopsided row: the larger leg opened it", () => {
    expect(backfillSide(row({ buyQty: 0 }))).toBe("short");
    expect(backfillSide(row({ sellQty: 4 }))).toBe("long");
  });

  it("2. flat, two dates: the earlier one opened it — ISO", () => {
    expect(backfillSide(row({ buyDate: "2026-01-10", sellDate: "2026-01-05" }))).toBe("short");
    expect(backfillSide(row({ buyDate: "2026-01-05", sellDate: "2026-01-10" }))).toBe("long");
  });

  it("2. flat, a 4.2.x DD-MM-YYYY date against an ISO one — compared as days, not bytes", () => {
    // Sold 10 Jan, bought back 5 Feb: a short. Bytes say '05-02-2026' < '2026-01-10' → long (wrong).
    expect(backfillSide(row({ buyDate: "05-02-2026", sellDate: "2026-01-10" }))).toBe("short");
    // Both DD-MM-YYYY: bought 03 Jan, sold 20 Jan. Bytes say '20-01' > '03-01' → long by luck; days agree.
    expect(backfillSide(row({ buyDate: "03-01-2026", sellDate: "20-01-2026" }))).toBe("long");
    // Bought 25 Dec 2025, sold 02 Jan 2026 — bytes '02-01-2026' < '25-12-2025' → short (wrong).
    expect(backfillSide(row({ buyDate: "25-12-2025", sellDate: "02-01-2026" }))).toBe("long");
  });

  it("3. flat, same day through a time suffix, no note: NO signal → null (bytes would say short)", () => {
    expect(backfillSide(row({ buyDate: "2026-03-05 10:15:00", sellDate: "2026-03-05" }))).toBe(null);
  });

  it("3. flat, same day or undated, with the intraday-short note → short (stored string or parser array)", () => {
    const joined = `Product derived from the charge signature | ${INTRADAY_SHORT_NOTE}`;
    expect(backfillSide(row({ buyDate: "2026-03-05", sellDate: "2026-03-05", importNotes: joined }))).toBe("short");
    expect(backfillSide(row({ importNotes: [INTRADAY_SHORT_NOTE] }))).toBe("short");
  });

  it("3. flat, same day or undated, NO note: no signal is no side — null, never a guessed long (fix wave, finding 2)", () => {
    expect(backfillSide(row({}))).toBe(null);
    expect(backfillSide(row({ buyDate: "2026-03-05", sellDate: "2026-03-05", importNotes: "Product derived from the charge signature" }))).toBe(null);
    // …and the readers: sideOf keeps the pre-W6 reading (long); statedSideOf says it states none.
    expect([sideOf(row({})), statedSideOf(row({}))]).toEqual(["long", null]);
    expect(statedSideOf(row({ side: "short" }))).toBe("short");
    expect(statedSideOf(row({ buyDate: "2026-01-09", sellDate: "2026-01-01" }))).toBe("short");
    expect(statedSideOf(row({ sellQty: 4 }))).toBe("long");
  });

  it("sideOf: quantities WIN on a lopsided row; the column only on a flat one", () => {
    expect(sideOf({ buyQty: 0, sellQty: 5, side: "long" })).toBe("short");
    expect(sideOf({ buyQty: 5, sellQty: 0, side: "short" })).toBe("long");
    expect(sideOf({ buyQty: 5, sellQty: 5, side: "short", buyDate: "2026-01-01", sellDate: "2026-01-09" })).toBe("short");
    expect(sideOf({ buyQty: 5, sellQty: 5, side: null, buyDate: "2026-01-09", sellDate: "2026-01-01" })).toBe("short");
    expect(sideOf({ buyQty: 5, sellQty: 5, side: "garbage" })).toBe("long");
  });

  it("R-7 editor rule: lopsided → quantities; flat with two dates → dates; flat same-day → the stored side", () => {
    const storedShort = { buyQty: 0, sellQty: 10, side: "short" };
    // An opening sell given its buy leg, bought BEFORE the sale → long.
    expect(sideAfterEdit({ buyQty: 10, sellQty: 10, buyDate: "2026-01-02", sellDate: "2026-01-09" }, storedShort)).toBe("long");
    // …given it the same day → the stored side (short) is kept.
    expect(sideAfterEdit({ buyQty: 10, sellQty: 10, buyDate: "2026-01-09", sellDate: "2026-01-09" }, storedShort)).toBe("short");
    expect(sideAfterEdit({ buyQty: 3, sellQty: 10 }, { buyQty: 10, sellQty: 10, side: "long" })).toBe("short");
  });
});

// ─────── the pre-W6 pairing, per SYMBOL GROUP (fix wave, finding 1) ───────
//
// The per-leg check matches only when ONE incoming leg equals ONE stored
// single-leg row. A partly covered short and a multi-lot short restate the
// stored pre-W6 rows with legs that equal none of them, so the refusal is by
// GROUP: the file's own pre-W6 pairing is recomputed, and if any of its rows is
// stored, nothing of that contract in this file is inserted.

describe("legacyShortGroupRefusals — the whole symbol group, against the pre-W6 pairing", () => {
  const SYMG = "NIFTY26OCT25300CE";
  const r2l = (n: number) => Math.round(n * 100) / 100;
  const legsOf = (spec: ["buy" | "sell", string, number, number][]): Leg[] =>
    spec.map(([side, date, qty, price]) => ({ symbol: SYMG, side, date, qty, value: qty * price, charges: 0 }));
  const asRow = (p: PairedPosition, id: number, hash: "real" | "none") => {
    const row = {
      id, broker: "zerodha", tradingsymbol: p.symbol, isin: null, importNotes: null, side: p.side,
      buyQty: p.buyQty, avgBuyPrice: p.buyQty > 0 ? r2l(p.buyValue / p.buyQty) : 0, buyValue: p.buyValue, buyDate: p.buyDate,
      sellQty: p.sellQty, avgSellPrice: p.sellQty > 0 ? r2l(p.sellValue / p.sellQty) : 0, sellValue: p.sellValue, sellDate: p.sellDate,
    };
    return { ...row, dedupHash: hash === "real" ? dedupHash(row) : `not-a-hash-${id}` };
  };
  /** What a pre-W6 import STORED (ids 101…) and what a post-W6 parser now emits for the same legs. */
  const scenario = (legs: Leg[], hash: "real" | "none") => ({
    stored: pairLegs(legs).map((p, i) => asRow(p, 101 + i, hash)),
    incoming: pairLegs(legs, { shortable: true }).map((p, i) => asRow(p, 900 + i, "none")),
  });

  it("partial cover: sold 100, bought back 60 — the leftover opening sale 40 is refused WITH the closed 60", () => {
    const { stored, incoming } = scenario(legsOf([["sell", "2026-09-01", 100, 122], ["buy", "2026-09-02", 60, 90]]), "real");
    expect(stored.map((r) => [r.buyQty, r.sellQty])).toEqual([[0, 100], [60, 0]]);
    expect(incoming.map((r) => [r.buyQty, r.sellQty, r.side])).toEqual([[60, 60, "short"], [0, 40, "short"]]);
    const refusals = legacyShortGroupRefusals(incoming, stored);
    expect(refusals.map((g) => [g.rows, g.storedIds])).toEqual([[[0, 1], [101, 102]]]);
    expect(refusals[0].reason).toContain("already imported under the pre-4.6 pairing — 2 rows (#101, #102)");
    expect(refusals[0].reason).toContain("Join the pair from Data Quality");
  });

  it("two sells, one buy: sold 50 + 50, bought 130 — no single leg matches, the group is still refused (by legs, not only by hash)", () => {
    const legs = legsOf([["sell", "2026-09-01", 50, 122], ["sell", "2026-09-02", 50, 124], ["buy", "2026-09-03", 130, 90]]);
    const { stored, incoming } = scenario(legs, "none");
    expect(stored.map((r) => [r.buyQty, r.sellQty])).toEqual([[0, 50], [0, 50], [130, 0]]);
    expect(incoming.map((r) => [r.buyQty, r.sellQty, r.side])).toEqual([[100, 100, "short"], [30, 0, "long"]]);
    // Aggregates only (a pre-aggregated parser row): the sale dates collapse to the oldest, and the open long still matches.
    expect(legacyShortGroupRefusals(incoming, stored).map((g) => [g.rows, g.storedIds])).toEqual([[[0, 1], [103]]]);
    // With the fills a tradebook carries, the pre-W6 pairing is rebuilt exactly — all three stored rows.
    const withFills = incoming.map((r, i) => ({
      ...r,
      executions: i === 0
        ? [{ side: "sell" as const, qty: 50, price: 122, date: "2026-09-01" }, { side: "sell" as const, qty: 50, price: 124, date: "2026-09-02" }, { side: "buy" as const, qty: 100, price: 90, date: "2026-09-03" }]
        : [{ side: "buy" as const, qty: 30, price: 90, date: "2026-09-03" }],
    }));
    expect(legacyShortGroupRefusals(withFills, stored).map((g) => [g.rows, g.storedIds])).toEqual([[[0, 1], [101, 102, 103]]]);
    // A per-leg check alone sees nothing here — the reason this rule exists.
    expect(incoming.map((r) => legacyShortLegMatch(r, stored))).toEqual([{ saleId: null, purchaseId: null }, { saleId: null, purchaseId: null }]);
  });

  it("refuses nothing when the stored book holds none of the pre-W6 rows, or only a row BOTH pairings state", () => {
    const legs = legsOf([["buy", "2026-08-01", 20, 80], ["sell", "2026-08-05", 20, 95], ["sell", "2026-09-01", 100, 122], ["buy", "2026-09-02", 60, 90]]);
    const { stored, incoming } = scenario(legs, "real");
    expect(legacyShortGroupRefusals(incoming, [])).toEqual([]);
    // The closed LONG of August is in both pairings: an earlier import of it is not the pre-W6 shape of the short.
    const closedLong = stored.filter((r) => r.buyQty === 20 && r.sellQty === 20);
    expect(closedLong).toHaveLength(1);
    expect(legacyShortGroupRefusals(incoming, closedLong)).toEqual([]);
    // Another book's symbol never matches.
    expect(legacyShortGroupRefusals(incoming, stored.map((r) => ({ ...r, tradingsymbol: "BANKNIFTY26OCT50000CE" })))).toEqual([]);
    // No overnight short in the file (a plain long round trip): nothing to recompute.
    const long = scenario(legsOf([["buy", "2026-08-01", 20, 80], ["sell", "2026-08-05", 20, 95]]), "real");
    expect(legacyShortGroupRefusals(long.incoming, long.stored)).toEqual([]);
  });
});

// ─── Data Quality's closed-lot reading goes through the stated side (finding 4) ───

describe("Data Quality: a CLOSED row is a lot of the side it states (closedLotEntry)", () => {
  let n = 5000;
  const q = (p: Partial<QualityTrade>): QualityTrade => ({
    id: ++n, dedupHash: n.toString(16).padStart(40, "0"), isOpen: false, acquisition: null, acquisitionPrice: null,
    closingPrice: null, slPlanned: 1, riskAmount: 1, segment: "index_option", mtfFundedAmount: null, instrumentType: "option",
    expiry: null, strike: null, optionType: "CE", symbol: "NIFTY", tradingsymbol: "NIFTY26OCT25500CE", accountId: 1, broker: "zerodha",
    exchange: "NFO", buyQty: 0, sellQty: 0, avgBuyPrice: 0, avgSellPrice: 0, buyDate: null, sellDate: null,
    createdAt: "2026-09-10 04:00:00", staged: false, ...p,
  });
  /** A same-day round trip of the contract: flat, closed — direction only if STATED. */
  const sameDay = (p: Partial<QualityTrade>) => q({ buyQty: 75, avgBuyPrice: 100, sellQty: 75, avgSellPrice: 120, buyDate: "2026-09-01", sellDate: "2026-09-01", ...p });
  const laterBuy = () => q({ isOpen: true, buyQty: 75, avgBuyPrice: 95, buyDate: "2026-09-03" });
  const laterSale = () => q({ isOpen: true, sellQty: 75, avgSellPrice: 130, sellDate: "2026-09-03" });
  const warn = (rows: QualityTrade[]) => staleSaleRows(rows).map((s) => [s.saleId, s.side, s.closedLotIds]);

  it("a same-day row that STATES short is a closed short lot; one that states long is a closed long lot", () => {
    const short = sameDay({ side: "short" });
    const buy = laterBuy();
    expect(warn([short, buy])).toEqual([[buy.id, "short", [short.id]]]);
    const long = sameDay({ side: "long" });
    const sale = laterSale();
    expect(warn([long, sale])).toEqual([[sale.id, "long", [long.id]]]);
    // …and never a lot of the OTHER side (the date reading counted neither, the column says which).
    expect(warn([sameDay({ side: "short" }), laterSale()])).toEqual([]);
    expect(warn([sameDay({ side: "long" }), laterBuy()])).toEqual([]);
  });

  it("a row with NO stated side keeps the pre-W6 reading: a same-day round trip is evidence of neither side", () => {
    expect(warn([sameDay({ side: null }), laterBuy()])).toEqual([]);
    expect(warn([sameDay({ side: null }), laterSale()])).toEqual([]);
    // The intraday-short note IS a statement.
    const noted = sameDay({ side: null, importNotes: INTRADAY_SHORT_NOTE });
    const buy = laterBuy();
    expect(warn([noted, buy])).toEqual([[buy.id, "short", [noted.id]]]);
    // Two dated legs state it by their order, column or not.
    const dated = q({ buyQty: 75, avgBuyPrice: 90, sellQty: 75, avgSellPrice: 122, sellDate: "2026-09-01", buyDate: "2026-09-02" });
    const buy2 = laterBuy();
    expect(warn([dated, buy2])).toEqual([[buy2.id, "short", [dated.id]]]);
  });
});

// ───────────────────────── the database half ─────────────────────────

let t: TempDb;
let fixes: typeof import("@/lib/db/data-fixes");
let backup: typeof import("@/lib/backup");
let trash: typeof import("@/lib/trash");

beforeAll(async () => {
  t = await openTempDb("side-column", { seed: true });
  fixes = await import("@/lib/db/data-fixes");
  backup = await import("@/lib/backup");
  trash = await import("@/lib/trash");
});
afterAll(() => t?.cleanup());

type Seed = { symbol: string; buyQty: number; sellQty: number; buyDate: string | null; sellDate: string | null; importNotes?: string | null; side?: "long" | "short" | null };

function seed(rows: Seed[]): number[] {
  return rows.map((r, i) =>
    t.db
      .insert(t.schema.trades)
      .values({
        accountId: 1, broker: "zerodha", bucket: "equity", segment: "stock_option", instrumentType: "option",
        exchange: "NFO", symbol: r.symbol, tradingsymbol: r.symbol,
        buyQty: r.buyQty, avgBuyPrice: r.buyQty ? 100 : 0, buyValue: r.buyQty * 100,
        sellQty: r.sellQty, avgSellPrice: r.sellQty ? 110 : 0, sellValue: r.sellQty * 110,
        buyDate: r.buyDate, sellDate: r.sellDate, importNotes: r.importNotes ?? null, side: r.side ?? null,
        isOpen: r.buyQty !== r.sellQty,
        dedupHash: `side-col-${r.symbol}-${i}`,
      })
      .returning({ id: t.schema.trades.id })
      .get().id,
  );
}

const sideById = (id: number) => (t.sqlite.prepare("SELECT side FROM trades WHERE id = ?").get(id) as { side: string | null } | undefined)?.side;
const clear = () => t.sqlite.prepare("DELETE FROM trades").run();

const LEGACY: Seed[] = [
  { symbol: "LOPSHORT", buyQty: 0, sellQty: 10, buyDate: null, sellDate: "2026-01-05" },
  { symbol: "DDMM", buyQty: 10, sellQty: 10, buyDate: "05-02-2026", sellDate: "2026-01-10" },
  { symbol: "TIMESFX", buyQty: 10, sellQty: 10, buyDate: "2026-03-05 10:15:00", sellDate: "2026-03-05" },
  { symbol: "INTRA", buyQty: 10, sellQty: 10, buyDate: "2026-03-05", sellDate: "2026-03-05", importNotes: `x | ${INTRADAY_SHORT_NOTE}` },
  { symbol: "UNDATED", buyQty: 10, sellQty: 10, buyDate: null, sellDate: null },
  // A STATED side the backfill would contradict: never overwritten.
  { symbol: "STATED", buyQty: 10, sellQty: 10, buyDate: "2026-03-05", sellDate: "2026-03-05", side: "short" },
];
// TIMESFX and UNDATED carry no signal (flat, same day or undated, no note): they stay NULL (finding 2).
const EXPECTED = ["short", "short", null, "short", null, "short"];

describe("migration 0077 + the trades-side-v1 data fix", () => {
  it("adds a nullable text column with a CHECK and no default; journal idx 77", () => {
    const col = (t.sqlite.prepare("PRAGMA table_info(trades)").all() as { name: string; type: string; notnull: number; dflt_value: string | null }[]).find((c) => c.name === "side");
    expect([col?.type.toLowerCase(), col?.notnull, col?.dflt_value]).toEqual(["text", 0, null]);
    expect(() => t.sqlite.prepare("UPDATE trades SET side = 'flat' WHERE 0 = 1").run()).not.toThrow();
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle", "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 77)?.tag).toBe("0077_trades-side");
    const sql = fs.readFileSync(path.join(ROOT, "drizzle", "0077_trades-side.sql"), "utf8");
    expect(sql).toContain("ALTER TABLE `trades` ADD COLUMN `side` text CHECK (`side` IN ('long', 'short'));");
    // The CHECK refuses a third value.
    const [id] = seed([{ symbol: "CHK", buyQty: 1, sellQty: 0, buyDate: "2026-01-01", sellDate: null, side: "long" }]);
    expect(() => t.sqlite.prepare("UPDATE trades SET side = 'flat' WHERE id = ?").run(id)).toThrow(/CHECK/);
    clear();
  });

  it("fills every NULL with backfillSide and never overwrites a stated side", () => {
    const ids = seed(LEGACY);
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(fixes.TRADES_SIDE_FIX);
    const r = fixes.runDataFixes(t.sqlite).find((x) => x.name === fixes.TRADES_SIDE_FIX)!;
    expect([r.applied, r.rekeyed]).toEqual([true, 3]);
    expect(ids.map(sideById)).toEqual(EXPECTED);
    clear();
  });

  it("a pre-W6 BACKUP restores with every side filled inside the restore (the fix re-runs in its transaction)", () => {
    const ids = seed(LEGACY);
    const dump = backup.dumpDatabase(false);
    // The pre-0077 envelope: no `side` on any trade — except keep STATED's, a post-W6 row.
    for (const row of dump.tables.trades as Record<string, unknown>[]) if (row.symbol !== "STATED") delete row.side;
    clear();
    expect(backup.restoreDatabase(dump).ok).toBe(true);
    expect(ids.map(sideById)).toEqual(EXPECTED);
    clear();
  });

  it("a pre-W6 TRASH envelope restores with the side filled (no data fix runs there)", () => {
    const ids = seed(LEGACY);
    const rows = t.db.select().from(t.schema.trades).all().map((r) => {
      const o = { ...r } as Record<string, unknown>;
      if (o.symbol !== "STATED") delete o.side;
      return o;
    });
    const snap = trash.writeTrashSnapshot({ trades: rows, legs: [], attachments: [], reason: "side-column test", accountId: 1 });
    clear();
    const res = trash.restoreTrashSnapshot(snap);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(ids.map(sideById)).toEqual(EXPECTED);
    clear();
  });
});

// ───────────────── the sequences the review walked (contract §2) ─────────────────

describe("v4.6.0 W6 — sequences on stored rows", () => {
  const FO = "NIFTY26OCT25200CE";
  const Q = 75;
  let commit: typeof import("@/lib/import/commit");
  let del: typeof import("@/lib/queries/delete");
  let lots: typeof import("@/lib/import/close-open-lots");
  let legacy: typeof import("@/lib/import/legacy-short");
  let dq: typeof import("@/lib/queries/data-quality");

  beforeAll(async () => {
    commit = await import("@/lib/import/commit");
    del = await import("@/lib/queries/delete");
    lots = await import("@/lib/import/close-open-lots");
    legacy = await import("@/lib/import/legacy-short");
    dq = await import("@/lib/queries/data-quality");
    t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
  });

  type NT = import("@/lib/engine/types").NormalizedTrade;
  const nt = (o: Partial<NT>): NT => ({
    broker: "zerodha", tradingsymbol: FO, isin: null,
    buyQty: 0, avgBuyPrice: 0, buyValue: 0, sellQty: 0, avgSellPrice: 0, sellValue: 0,
    closingPrice: null, grossPnl: 0, unrealisedPnl: 0, buyDate: null, sellDate: null,
    productHint: null, exchangeHint: null, sourceFile: null, ...o,
  }) as NT;
  const file = (trades: NT[]) => ({ sourceId: "zerodha", broker: "zerodha" as const, format: "tradebook", trades, warnings: [] });
  const SALE = { sellQty: Q, avgSellPrice: 122, sellValue: 122 * Q, sellDate: "2026-09-01" };
  const COVER = { buyQty: Q, avgBuyPrice: 90, buyValue: 90 * Q, buyDate: "2026-09-02" };
  const closedShort = () => nt({ ...SALE, ...COVER, grossPnl: 32 * Q, side: "short" });
  const rowsOf = () => t.db.select().from(t.schema.trades).all().filter((r) => r.tradingsymbol === FO);

  it("import an overnight short → delete → Trash restore: the row comes back a closed SHORT", () => {
    clear();
    expect(commit.commitParsedFile(file([closedShort()]), "ovn.csv", null, 1).added).toBe(1);
    const [row] = rowsOf();
    expect([row.side, row.isOpen, row.grossPnl]).toEqual(["short", false, 32 * Q]);
    const res = del.deleteTradesByIds([row.id], "side-column test", "test");
    expect(res.ok).toBe(true);
    const snap = trash.listTrashSnapshots()[0]!.id;
    expect(trash.restoreTrashSnapshot(snap).ok).toBe(true);
    expect(rowsOf().map((r) => [r.side, r.buyQty, r.sellQty])).toEqual([["short", Q, Q]]);
    clear();
  });

  it("the pre-W6 pair: the per-leg refusal in PREVIEW and COMMIT, then after deleting the phantom long", () => {
    clear();
    commit.commitParsedFile(file([nt({ ...SALE, basisUnknown: true })]), "pre-w6-sale.csv", null, 1);
    commit.commitParsedFile(file([nt({ ...COVER })]), "pre-w6-buy.csv", null, 1);
    const [sale, buy] = rowsOf();
    expect([sale.acquisition, sale.side, buy.side]).toEqual(["unknown", "short", "long"]);
    // PREVIEW: a duplicate with the reason naming BOTH stored rows.
    const p = commit.previewParsedFile(file([closedShort()]), null, 1);
    expect([p.summary.dupCount, p.summary.newCount]).toEqual([1, 0]);
    expect(p.rows[0].duplicateReason).toContain(`sale #${sale.id} and purchase #${buy.id}`);
    // COMMIT: skipped, said so, nothing inserted.
    const c = commit.commitParsedFile(file([closedShort()]), "post-w6.csv", null, 1);
    expect([c.added, c.skipped]).toEqual([0, 1]);
    expect((c.warnings ?? []).join(" ")).toContain("pre-4.6 import");
    // Deleting the phantom long cannot let the sale in twice: the sale leg still matches.
    expect(del.deleteTradesByIds([buy.id], "phantom long", "test").ok).toBe(true);
    expect(commit.commitParsedFile(file([closedShort()]), "post-w6.csv", null, 1).added).toBe(0);
    expect(rowsOf().filter((r) => r.sellQty > 0)).toHaveLength(1);
    clear();
  });

  it("the pre-W6 pair is LISTED by Data Quality as a legacy short; the join states the side, clears 'unknown' and records the W6 hash as an alias", () => {
    clear();
    commit.commitParsedFile(file([nt({ ...SALE, basisUnknown: true })]), "pre-w6-sale.csv", null, 1);
    commit.commitParsedFile(file([nt({ ...COVER })]), "pre-w6-buy.csv", null, 1);
    const pair = dq.getStaleOpenPairs().find((x) => x.tradingsymbol === FO)!;
    expect([pair.side, pair.legacyShort, pair.oneClick]).toEqual(["short", true, true]);
    const [saleRow, buyRow] = rowsOf();
    const expectedHash = legacy.joinedShortHash(saleRow, buyRow);
    const res = commit.closeStaleLot(pair.lotId, pair.saleId, pair.saleDate);
    expect(res.ok, res.message).toBe(true);
    const [joined] = rowsOf();
    expect([joined.side, joined.acquisition, joined.buyQty, joined.sellQty, joined.isOpen]).toEqual(["short", null, Q, Q, false]);
    // The alias IS the hash a post-W6 parser gives this closed short.
    const w6 = commit.previewParsedFile(file([closedShort()]), null, 1);
    expect(lots.heldIdentityHashes(joined)).toContain(expectedHash);
    expect([w6.summary.dupCount, w6.rows[0].duplicateReason]).toEqual([1, undefined]);
    clear();
  });

  it("the auto-close slice of a SHORT lot is a short, and its un-close restores an open short", () => {
    clear();
    // An open short lot (sold to open, nothing bought), then a same-day partial cover.
    commit.commitParsedFile(file([nt({ ...SALE, sellDate: "2026-09-03" })]), "short-open.csv", null, 1);
    const cover = nt({ buyQty: 25, avgBuyPrice: 100, buyValue: 2500, buyDate: "2026-09-03" });
    const res = commit.commitParsedFile(file([cover]), "cover.csv", null, 1, { autoClose: true });
    expect(res.autoClose?.reduced).toBe(1);
    const slice = rowsOf().find((r) => r.buyQty === 25 && r.sellQty === 25)!;
    // Flat and same-day: only the stated side says short (R-8).
    expect([slice.side, lots.readsLong(slice)]).toEqual(["short", false]);
    const un = commit.unCloseExecution(1, "zerodha", lots.executionHashOfPiece(slice));
    expect(un.ok, un.message).toBe(true);
    const back = rowsOf().map((r) => [r.side, r.buyQty, r.sellQty, r.isOpen]).sort();
    expect(back).toEqual([["long", 25, 0, true], ["short", 0, Q, true]].sort());
    clear();
  });
});
