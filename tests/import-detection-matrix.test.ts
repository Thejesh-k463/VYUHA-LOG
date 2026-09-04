import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { rankParsers, buildContext } from "@/lib/import/detect";
import { detectZerodha } from "@/lib/import/parsers/zerodha";
import { detectGrowwXlsx } from "@/lib/import/parsers/groww-xlsx";
import { detectGrowwOrders } from "@/lib/import/parsers/groww-orders";
import { detectAngelOne, detectUpstox } from "@/lib/import/parsers/angelone-upstox";
import { detectAngelOneTaxPnl } from "@/lib/import/parsers/angelone-taxpnl";
import { detectPaytmTradebook } from "@/lib/import/parsers/paytm-tradebook";
import { detectDhanCsv } from "@/lib/import/parsers/dhan-csv";
import { detectDhanGtr } from "@/lib/import/parsers/dhan-gtr";
import { detectDhanRealisedPnl } from "@/lib/import/parsers/dhan-realised-pnl";
import { detectDhanDividend, detectDhanLedgerFile } from "@/lib/import/parsers/dhan-ledger";
import { detectDhanDpCharges } from "@/lib/import/parsers/dhan-dp-charges";
import { detectDhanHoldings } from "@/lib/import/parsers/dhan-holdings";
import { detectDhanContractNote } from "@/lib/import/parsers/dhan-contract-note";
import { detectPaytmRealisedPnl } from "@/lib/import/parsers/paytm-realised-pnl";
import { detectUpstoxLedger } from "@/lib/import/parsers/upstox-ledger";
import { detectAngelOneLedger } from "@/lib/import/parsers/angelone-ledger";
import { detectAngelOnePnlStatement } from "@/lib/import/parsers/angelone-pnl-statement";
import { ownerContext, ownerFiles } from "./helpers/owner-broker-files";

/**
 * THE MISROUTE MATRIX — every real export routes to its own parser, and every
 * broker-named detector scores ZERO on every other broker's file.
 *
 * Why this exists: on 2026-08-12 a Groww order-history export imported as
 * broker "zerodha" — 111 rows, priced at Zerodha's rates, reported as success.
 * `detectZerodha` scored 0.30 on column SHAPE (`symbol` + `isin`), which every
 * Indian broker's export has. The same probe found a SECOND live misroute:
 * Paytm's tradebook, claimed at 0.35 because its filename contains the English
 * word "tradebook". No test had ever asserted a detector REFUSES a foreign
 * file — they only asserted it wins on its own.
 *
 * The fixtures are REDACTED copies of real exports (layout, sheet names,
 * headers and blank-row structure preserved exactly; client codes, PANs and
 * names scrubbed — regenerate with the redaction script against
 * tests/fixtures/private/, then re-run the leak scan). Five of six source
 * files carried no data rows, so this file proves DETECTION and ROUTING —
 * value-level parsing is covered by the synthetic-row tests per parser.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");

/** Every redacted fixture, with the broker whose export it really is. */
const FIXTURES: { file: string; broker: string; expect: string; label: string }[] = [
  { file: "groww-order-history.xlsx", broker: "groww", expect: "groww-orders", label: "Groww stocks order history" },
  { file: "zerodha-tradebook.xlsx", broker: "zerodha", expect: "zerodha", label: "Zerodha tradebook" },
  { file: "zerodha-console-pnl.xlsx", broker: "zerodha", expect: "zerodha", label: "Zerodha Console P&L" },
  { file: "paytm-tradebook.xlsx", broker: "paytm", expect: "paytm-tradebook", label: "Paytm Money tradebook" },
  { file: "angelone-tax-pnl.xlsx", broker: "angelone", expect: "angelone-taxpnl", label: "Angel One tax P&L" },
  // 2026-09-04: the Angel One account statement gained a parser — it feeds the
  // Cash & Ledger screen and imports no trades, but it must be NAMED rather
  // than fall to the column mapper.
  { file: "YourStatement_TEST0000.xlsx", broker: "angelone", expect: "angelone-ledger", label: "Angel One ledger" },
  { file: "paytm-pnl.xlsx", broker: "paytm", expect: "generic-or-none", label: "Paytm Money P&L" },
  // ── 2026-08-20 batch: schema-only copies of a SECOND set of real exports
  // (Paytm, Zerodha and Upstox), redacted the same way — the owner's real
  // book is never committed; data rows are three synthetic lines each.
  // Filenames here are NEUTRAL on purpose (the real ones name no broker
  // either: `Tradebook_EQ.xlsx`, `trade_<from>_<to>_<code>.xlsx`, …), so
  // every claim below is carried by in-content fingerprints alone.
  { file: "paytm-tradebook-v2.xlsx", broker: "paytm", expect: "paytm-tradebook", label: "Paytm Money tradebook (Tradebook_EQ export, numeric Script codes)" },
  // 2026-09-04: the Paytm Realized P&L gained a parser. It imports no trades —
  // it stores Paytm's own stated figures for reconciliation — so the claim is
  // carried entirely by its in-content fingerprint under a neutral filename.
  { file: "paytm-equity-pnl.xls", broker: "paytm", expect: "paytm-realised-pnl", label: "Paytm Money Equity P&L (.xls, 3 sheets)" },
  { file: "zerodha-tradebook-console.xlsx", broker: "zerodha", expect: "zerodha", label: "Zerodha tradebook (Console export with preamble)" },
  { file: "zerodha-console-pnl-cola.xlsx", broker: "zerodha", expect: "zerodha", label: "Zerodha Console P&L (column-A variant)" },
  { file: "upstox-trade-report.xlsx", broker: "upstox", expect: "upstox", label: "Upstox trade report" },
  { file: "upstox-realized-pnl.xlsx", broker: "upstox", expect: "upstox", label: "Upstox realised P&L report" },
  // No column header at all — nothing can read it; nothing may claim it.
  // The `upstox-ledger` parser exists as of 2026-09-04, and it still must NOT
  // claim THIS copy: the redacted sample carries no header row, so
  // `findUpstoxLedgerHeader` finds nothing and the detector scores 0. The
  // refusal is by design, not a gap — a populated ledger is pinned by
  // tests/golden-books.test.ts against the owner's real export.
  { file: "upstox-ledger.xlsx", broker: "upstox", expect: "generic-or-none", label: "Upstox ledger" },
  // ── 2026-09-01 batch: Zerodha Console TAX P&L (taxpnl-*.xlsx), redacted
  // from two real multi-sheet exports. The trade table sits on sheet 0 and
  // the "- Z" charge heads on sheet 1 — the exact layout that fell to the
  // column mapper while detection read only the first sheet. Real filenames
  // name no broker (taxpnl-<name>-<fy>-Q1-Q4.xlsx), so both load NEUTRAL:
  // the claim is carried by the in-content "Zerodha's guide" line + the
  // tradewise table + the "- Z" heads.
  { file: "zerodha-taxpnl-fy2425.xlsx", broker: "zerodha", expect: "zerodha", label: "Zerodha Console tax P&L (FY24-25, F&O + empty Currency/Commodity sections)" },
  { file: "zerodha-taxpnl-fy2526.xlsx", broker: "zerodha", expect: "zerodha", label: "Zerodha Console tax P&L (FY25-26, single F&O section)" },
];

/**
 * The REAL files, when this machine has them (gitignored under
 * tests/fixtures/private/). Same assertions as the redacted copies — this is
 * the proof that redaction preserved exactly the cells detection reads. On CI
 * and on any other machine the block is skipped, not failed.
 */
const PRIVATE_DIR = path.join(process.cwd(), "tests", "fixtures", "private");
const PRIVATE: { file: string; expect: string }[] = [
  { file: "Paytm Money - Tradebook (real).xlsx", expect: "paytm-tradebook" },
  { file: "Paytm Money - EquityPnL (real).xls", expect: "paytm-realised-pnl" },
  { file: "Zerodha Tradebook (real).xlsx", expect: "zerodha" },
  { file: "Zerodha Console PnL (real).xlsx", expect: "zerodha" },
  { file: "Upstox trade report (schema-only).xlsx", expect: "upstox" },
  { file: "Upstox realizedPnL (schema-only).xlsx", expect: "upstox" },
  { file: "Upstox ledger (schema-only).xlsx", expect: "generic-or-none" },
  { file: "Zerodha TaxPnL FY2024-25 (real).xlsx", expect: "zerodha" },
  { file: "Zerodha TaxPnL FY2025-26 (real).xlsx", expect: "zerodha" },
  { file: "Zerodha Console PnL Ravi (real).xlsx", expect: "zerodha" },
];
const havePrivate = PRIVATE.every((p) => fs.existsSync(path.join(PRIVATE_DIR, p.file)));

// The 2026-08-20 batch is loaded under a NEUTRAL filename so that a claim can
// only come from the file's content — the real exports name no broker.
const NEUTRAL = new Set(["paytm-tradebook-v2.xlsx", "paytm-equity-pnl.xls", "zerodha-tradebook-console.xlsx", "zerodha-console-pnl-cola.xlsx", "upstox-trade-report.xlsx", "upstox-realized-pnl.xlsx", "upstox-ledger.xlsx", "zerodha-taxpnl-fy2425.xlsx", "zerodha-taxpnl-fy2526.xlsx"]);
const load = (file: string) =>
  buildContext(NEUTRAL.has(file) ? "export" + path.extname(file) : file, fs.readFileSync(path.join(DIR, file)));

describe("every real export routes to its own parser", () => {
  for (const f of FIXTURES.filter((x) => x.expect !== "generic-or-none")) {
    it(`${f.label} → ${f.expect}`, () => {
      const ranked = rankParsers(load(f.file));
      expect(ranked[0].sourceId).toBe(f.expect);
      expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.7);
    });
  }

  for (const f of FIXTURES.filter((x) => x.expect === "generic-or-none")) {
    it(`${f.label} is never claimed by a broker parser`, () => {
      // These samples carry zero data rows, so even the generic mapper may
      // score 0 (it requires a data row). Either outcome is honest; a broker
      // parser winning is the bug.
      const top = rankParsers(load(f.file)).filter((r) => r.confidence > 0)[0];
      if (top) expect(top.sourceId).toBe("generic-table");
    });
  }
});

describe.skipIf(!havePrivate)("the real exports route exactly like their redacted copies", () => {
  for (const p of PRIVATE) {
    it(`${p.file.replace(/\(.*\)/, "").trim()} → ${p.expect}`, () => {
      // Neutral filename — the real names carry no broker word either.
      const ranked = rankParsers(buildContext("export" + path.extname(p.file), fs.readFileSync(path.join(PRIVATE_DIR, p.file))));
      const top = ranked.filter((r) => r.confidence > 0)[0];
      if (p.expect === "generic-or-none") {
        if (top) expect(top.sourceId).toBe("generic-table");
      } else {
        expect(top?.sourceId).toBe(p.expect);
        expect(top!.confidence).toBeGreaterThanOrEqual(0.7);
      }
    });
  }
});

/**
 * THE CONTAINER RULE — a refusal only counts when the detector can READ the
 * container it is offered.
 *
 * `buildContext` decodes `ctx.text` for `.csv`/`.txt` ONLY (detect.ts). A
 * text-only detector opens `if (!text) return 0`, so it scores 0 on every
 * `.xlsx` by EXTENSION, deciding nothing whatever about the content: the
 * identical Dhan GTR bytes score 0.98 as `export.csv` and 0 as `export.xlsx`.
 * Until 2026-09-04 that made 48 of this matrix's cells vacuous — the three
 * text-only Dhan detectors against sixteen workbook fixtures.
 *
 * Each detector therefore declares its container, and each fixture is offered
 * in both: its own bytes ("binary"), and the same workbook projected to CSV
 * text by SheetJS under a NEUTRAL `.csv` name ("text"). A detector is asserted
 * only in a container it reads, so every cell below is content-decided.
 */
type Container = "text" | "binary" | "both";
const CROSS_DETECTORS: {
  name: string;
  broker: string;
  container: Container;
  fn: (ctx: ReturnType<typeof buildContext>) => number;
}[] = [
  { name: "detectZerodha", broker: "zerodha", container: "both", fn: detectZerodha },
  // `if (!ctx.buffer) return 0` — these three read a workbook or nothing.
  { name: "detectGrowwXlsx", broker: "groww", container: "binary", fn: detectGrowwXlsx },
  { name: "detectGrowwOrders", broker: "groww", container: "binary", fn: detectGrowwOrders },
  { name: "detectAngelOne", broker: "angelone", container: "both", fn: detectAngelOne },
  { name: "detectAngelOneTaxPnl", broker: "angelone", container: "binary", fn: detectAngelOneTaxPnl },
  { name: "detectUpstox", broker: "upstox", container: "both", fn: detectUpstox },
  { name: "detectPaytmTradebook", broker: "paytm", container: "both", fn: detectPaytmTradebook },
  // 2026-09-04: the five Dhan detectors join the refusal matrix.
  { name: "detectDhanGtr", broker: "dhan", container: "text", fn: detectDhanGtr },
  { name: "detectDhanCsv", broker: "dhan", container: "both", fn: detectDhanCsv },
  // `if (ctx.text != null) return 0` — a .xls/.xlsx report, never a CSV.
  { name: "detectDhanRealisedPnl", broker: "dhan", container: "binary", fn: detectDhanRealisedPnl },
  { name: "detectDhanLedgerFile", broker: "dhan", container: "text", fn: detectDhanLedgerFile },
  { name: "detectDhanDividend", broker: "dhan", container: "text", fn: detectDhanDividend },
  // 2026-09-04: the seven v3.9 reference/enrichment sources. All are workbook
  // or PDF readers — each returns 0 without `ctx.buffer` — so all join as
  // "binary" only.
  { name: "detectDhanDpCharges", broker: "dhan", container: "binary", fn: detectDhanDpCharges },
  { name: "detectDhanHoldings", broker: "dhan", container: "binary", fn: detectDhanHoldings },
  { name: "detectDhanContractNote", broker: "dhan", container: "binary", fn: detectDhanContractNote },
  { name: "detectPaytmRealisedPnl", broker: "paytm", container: "binary", fn: detectPaytmRealisedPnl },
  { name: "detectUpstoxLedger", broker: "upstox", container: "binary", fn: detectUpstoxLedger },
  { name: "detectAngelOneLedger", broker: "angelone", container: "binary", fn: detectAngelOneLedger },
  { name: "detectAngelOnePnlStatement", broker: "angelone", container: "binary", fn: detectAngelOnePnlStatement },
];
const readsText = (c: Container) => c === "text" || c === "both";
const readsBinary = (c: Container) => c === "binary" || c === "both";

/**
 * The same bytes in a TEXT container: EVERY sheet flattened to CSV by the
 * repo's SheetJS and offered under a neutral `.csv` name, so `buildContext`
 * decodes `ctx.text` and a text-only detector actually runs its content
 * fingerprints. A `.csv` fixture is passed through unchanged.
 */
function loadAsText(dir: string, file: string): ReturnType<typeof buildContext> {
  const bytes = fs.readFileSync(path.join(dir, file));
  if (/\.(csv|txt)$/i.test(file)) return buildContext("export.csv", bytes);
  const wb = XLSX.read(bytes, { type: "buffer" });
  const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join("\n");
  return buildContext("export.csv", Buffer.from(csv, "utf8"));
}

describe("no detector claims another BROKER's file", () => {
  // Strict zero applies CROSS-broker. A detector may recognise its own
  // broker's name on a sibling format (detectAngelOne returns its named-file
  // floor on the Angel tax P&L) — that is not a misroute as long as the real
  // owner outranks it, which the routing block above pins.
  for (const d of CROSS_DETECTORS) {
    for (const f of FIXTURES) {
      if (f.broker === d.broker) continue;
      // DEFECT FIXED 2026-09-04 — kept as a named regression, not a pin.
      // `detectDhanCsv`'s TEXT branch used to score 0.4 on Angel One's tax P&L
      // content with no broker named anywhere: `/Scrip Name,.*Realised P&L/i`
      // had no word boundary and no column anchoring, so Angel One's
      // "…,Scrip Name,…,Short term Unrealised P&L" header line matched — a
      // claim on SHAPE alone, the class AGENTS.md forbids, and 0.4 beat the
      // generic mapper's 0.05. It could not bite only because Angel One ships
      // this report as .xlsx (no `ctx.text`); a `.csv` export in the same
      // layout would have imported as Dhan. The parser now gates every score
      // above the filename bonus on a Dhan/Raise/Moneylicious content
      // fingerprint or Dhan's own `PnL report` title, and reads the header as
      // COLUMNS. Expected here — as for every other foreign file — is 0.
      if (readsBinary(d.container)) {
        it(`${d.name} scores 0 on ${f.label} [binary container]`, () => {
          expect(d.fn(load(f.file))).toBe(0);
        });
      }
      if (readsText(d.container)) {
        it(`${d.name} scores 0 on ${f.label} [text container]`, () => {
          expect(d.fn(loadAsText(DIR, f.file))).toBe(0);
        });
      }
    }
  }
});

/**
 * The committed Dhan CSVs (redacted real exports) close the other half of the
 * container rule: real broker text that every FOREIGN detector must refuse,
 * on CI, without the owner's folder. `tests/fixtures/zerodha-tradebook.csv` is
 * the reverse direction — a non-Dhan CSV no Dhan detector may claim.
 */
const CSV_FIXTURES: { dir: string; file: string; broker: string; label: string }[] = [
  { dir: DIR, file: "dhan-gtr-2026-04-01_2026-09-04-a1.csv", broker: "dhan", label: "Dhan Global Transaction Report" },
  { dir: DIR, file: "dhan-ledger-2026-04-01_2026-09-03-a1.csv", broker: "dhan", label: "Dhan ledger" },
  { dir: DIR, file: "dhan-dividend-2025-04-01_2026-03-31.csv", broker: "dhan", label: "Dhan dividend payout" },
  { dir: path.join(process.cwd(), "tests", "fixtures"), file: "zerodha-tradebook.csv", broker: "zerodha", label: "Zerodha tradebook (CSV)" },
];

describe("no detector claims another BROKER's CSV", () => {
  for (const d of CROSS_DETECTORS.filter((x) => readsText(x.container))) {
    for (const f of CSV_FIXTURES) {
      if (f.broker === d.broker) continue;
      it(`${d.name} scores 0 on ${f.label} [text container]`, () => {
        expect(d.fn(loadAsText(f.dir, f.file))).toBe(0);
      });
    }
  }
});

describe("a populated Paytm P&L reaches the generic mapper", () => {
  it("label/value preamble and section titles do not stop the mapper from asking", () => {
    // The redacted sample has ZERO data rows, so nothing claims it — an
    // artefact of the sample, not the layout. With rows present the file must
    // land on the generic mapper (a question), never on a broker parser and
    // never nowhere. Rows synthesized under the VERIFIED section header.
    const matrix = [
      ["UCC"], ["Name"], ["PAN number"], ["Period"], [],
      ["Unrealized P/L Summary (As on 11 Aug 2026)"],
      ["Scrip Name", "ISIN", "Quantity", "Buy Average", "Buy Value", "Closing Price", "Present Value", "Unrealized P&L", "P&L%"],
      ["ACME", "INE000000001", "10", "100", "1000", "110", "1100", "100", "10"],
      ["ZETA", "INE000000002", "5", "200", "1000", "190", "950", "-50", "-5"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const ranked = rankParsers(buildContext("Paytm Money - P&L.xlsx", buf));
    expect(ranked.filter((r) => r.confidence > 0)[0]?.sourceId).toBe("generic-table");
  });
});

describe("a content mention of 'zerodha' is not a claim (v3.5.1 audit fix)", () => {
  it("a user's multi-broker log with Zerodha in a DATA column goes to the mapper, not to parseZerodha", () => {
    // The 2026-08-12 misclaim class, nearly reintroduced by the taxpnl
    // in-content name check: a wide row's data cell saying "Zerodha" is not
    // the broker naming its own export. Verified live by the v3.5.0 audit.
    const csv = [
      "Date,Broker,Symbol,Type,Qty,Price",
      "2026-08-01,Zerodha,TCS,BUY,10,4100",
      "2026-08-02,Groww,TCS,SELL,10,4180",
    ].join("\n");
    const ctx = buildContext("MyTrades.csv", Buffer.from(csv));
    expect(detectZerodha(ctx)).toBe(0);
    expect(rankParsers(ctx).filter((r) => r.confidence > 0)[0]?.sourceId).toBe("generic-table");
  });

  it("a preamble-shaped mention WITHOUT any Zerodha fingerprint still claims nothing", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Exported with help from Zerodha's guide"],
      ["Symbol", "Qty", "Price", "Amount"],
      ["TCS", "10", "4100", "41000"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectZerodha(buildContext("export.xlsx", buf))).toBe(0);
  });
});

describe("the incident files, replayed", () => {
  it("a Groww order history with a NEUTRAL filename is still claimed by content", () => {
    // The word "Groww" appears nowhere in the file; the Unique Client Code
    // metadata label is the fingerprint. Renaming must not break routing.
    const buf = fs.readFileSync(path.join(DIR, "groww-order-history.xlsx"));
    const ranked = rankParsers(buildContext("export.xlsx", buf));
    expect(ranked[0].sourceId).toBe("groww-orders");
  });

  it("a Paytm tradebook is not claimed by Zerodha despite 'tradebook' in its filename", () => {
    // The exact second misroute: filename word-match + symbol/isin shape.
    const buf = fs.readFileSync(path.join(DIR, "paytm-tradebook.xlsx"));
    expect(detectZerodha(buildContext("Paytm Money - Tradebook.xlsx", buf))).toBe(0);
  });

  it("Zerodha's own Console P&L wins on its fingerprint, not by filename accident", () => {
    // Data starts at column B and the trade table sits past row 25 — the old
    // header scan missed it and the file won only via a filename clamp.
    const buf = fs.readFileSync(path.join(DIR, "zerodha-console-pnl.xlsx"));
    const score = detectZerodha(buildContext("statement.xlsx", buf)); // name withheld
    expect(score).toBeGreaterThanOrEqual(0.4); // "- Z" charge heads carry it alone
  });
});

/**
 * 2026-09-04 batch: the owner's REAL Dhan exports (ledger ×2, dividend
 * payout, P&L .xlsx ×2, Realised P&L .xls ×2) and Angel One's Trades_History,
 * read IN PLACE from the owner's folder — never copied into the repo. Each
 * routes to its own source under a neutral filename, and every broker-named
 * detector scores 0 on the files that are not its broker's. Skipped, not
 * failed, anywhere the folder is absent.
 */
/**
 * PRESENCE IS ASSERTED PER PATTERN, never in bulk. A single `OWNER.length >= 8`
 * threshold meant renaming ONE of the owner's eight files silently skipped all
 * 67 tests below — a green run proving nothing. Each pattern now either finds
 * its files and runs, or produces an `it.skip` NAMED with the pattern that
 * found nothing, so an absent folder reads as "skipped" and a renamed file
 * reads as "this pattern found nothing".
 */
const OWNER_PATTERNS: { pattern: RegExp; broker: string; expect: string }[] = [
  { pattern: /^Dhan_Ledger_.*\.csv$/, broker: "dhan", expect: "dhan-ledger" },
  { pattern: /^Dhan_Dividend_.*\.csv$/, broker: "dhan", expect: "dhan-dividend" },
  { pattern: /^Dhan_P&L_.*\.xlsx$/, broker: "dhan", expect: "dhan-csv" },
  { pattern: /^realized_pnl-report.*\.xls$/, broker: "dhan", expect: "dhan-realised-pnl" },
  { pattern: /^Trades_History_.*\.xlsx$/, broker: "angelone", expect: "angelone" },
  // ── 2026-09-04: the v3.9 reference sources, by the broker's own filename
  // shape. Nothing here reads a path — `ownerFiles` matches in place.
  { pattern: /^dp-charges.*\.xls$/, broker: "dhan", expect: "dhan-dp-charges" },
  { pattern: /^Dhan_Demat_Holding.*\.xlsx$/, broker: "dhan", expect: "dhan-holdings" },
  { pattern: /_Contract_Note_.*\.pdf$/, broker: "dhan", expect: "dhan-contract-note" },
  { pattern: /^ledger_.*\.xlsx$/, broker: "upstox", expect: "upstox-ledger" },
  { pattern: /^YourStatement_.*\.xlsx$/, broker: "angelone", expect: "angelone-ledger" },
  { pattern: /^ProfitLoss_Statement_.*\.xlsx$/, broker: "angelone", expect: "angelone-pnl-statement" },
  // The owner's two Paytm files share a stem and differ only by extension:
  // the `.xls` is the Realized P&L, the `.xlsx` is the tradebook. The pattern
  // is anchored on `\.xls$` for exactly that reason — an unanchored
  // `.*\.xls` would have swallowed the tradebook too and pinned the wrong
  // source for it. The tradebook keeps its own mapping, in the redacted
  // routing block above (`paytm-tradebook-v2.xlsx`, loaded NEUTRAL); it is
  // deliberately not listed here because under a neutral name it scores 0.75
  // on content alone, below this block's 0.9 floor for a named real export.
  { pattern: /^ACCOUNT 2=3-PAYTM MONEY-LARGE DATA\.xls$/, broker: "paytm", expect: "paytm-realised-pnl" },
];
describe("the owner's real Dhan and Angel One exports route to their own source", () => {
  for (const p of OWNER_PATTERNS) {
    const found = ownerFiles(p.pattern);
    if (found.length === 0) {
      it.skip(`no owner file matches ${p.pattern} — expected ${p.expect}`, () => {});
      continue;
    }
    for (const file of found) {
      it(`${path.basename(file).slice(0, 22)}… → ${p.expect}`, () => {
        const { filename, bytes } = ownerContext(file);
        const ranked = rankParsers(buildContext(filename, bytes));
        expect(ranked[0].sourceId).toBe(p.expect);
        expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.9);
      // Ranking opens the workbook once per fingerprinting detector, and the
      // owner's real files are the big ones (the DP charges .xls carries ~350
      // merged ranges over 173 rows). Two of these crossed the 5 s default the
      // moment the v3.9 detectors joined — slow by size, not by defect.
      }, 60_000);
    }
  }
});

describe("no detector claims another broker's REAL file (owner's folder)", () => {
  // The container rule applies here too: an owner `.xlsx` is offered to a
  // text-only detector as its CSV projection, never as bytes it cannot open.
  for (const d of CROSS_DETECTORS) {
    for (const p of OWNER_PATTERNS) {
      if (p.broker === d.broker) continue;
      const found = ownerFiles(p.pattern);
      if (found.length === 0) {
        it.skip(`${d.name}: no owner file matches ${p.pattern}`, () => {});
        continue;
      }
      for (const file of found) {
        const label = `${path.basename(file).slice(0, 22)}…`;
        if (readsBinary(d.container)) {
          it(`${d.name} scores 0 on ${label} [binary container]`, () => {
            const { filename, bytes } = ownerContext(file);
            expect(d.fn(buildContext(filename, bytes))).toBe(0);
          }, 60_000);
        }
        if (readsText(d.container)) {
          it(`${d.name} scores 0 on ${label} [text container]`, () => {
            expect(d.fn(loadAsText(path.dirname(file), path.basename(file)))).toBe(0);
          }, 60_000);
        }
      }
    }
  }
});
