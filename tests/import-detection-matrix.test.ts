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
import { ownerContext, ownerFile, ownerFiles } from "./helpers/owner-broker-files";

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
  // The ledger and P&L summary have no parser: the mapper (or nothing, for a
  // zero-data-row sample) must take them — no parser may claim them outright.
  { file: "YourStatement_TEST0000.xlsx", broker: "angelone", expect: "generic-or-none", label: "Angel One ledger" },
  { file: "paytm-pnl.xlsx", broker: "paytm", expect: "generic-or-none", label: "Paytm Money P&L" },
  // ── 2026-08-20 batch: schema-only copies of a SECOND set of real exports
  // (Paytm, Zerodha and Upstox), redacted the same way — the owner's real
  // book is never committed; data rows are three synthetic lines each.
  // Filenames here are NEUTRAL on purpose (the real ones name no broker
  // either: `Tradebook_EQ.xlsx`, `trade_<from>_<to>_<code>.xlsx`, …), so
  // every claim below is carried by in-content fingerprints alone.
  { file: "paytm-tradebook-v2.xlsx", broker: "paytm", expect: "paytm-tradebook", label: "Paytm Money tradebook (Tradebook_EQ export, numeric Script codes)" },
  { file: "paytm-equity-pnl.xls", broker: "paytm", expect: "generic-or-none", label: "Paytm Money Equity P&L (.xls, 3 sheets)" },
  { file: "zerodha-tradebook-console.xlsx", broker: "zerodha", expect: "zerodha", label: "Zerodha tradebook (Console export with preamble)" },
  { file: "zerodha-console-pnl-cola.xlsx", broker: "zerodha", expect: "zerodha", label: "Zerodha Console P&L (column-A variant)" },
  { file: "upstox-trade-report.xlsx", broker: "upstox", expect: "upstox", label: "Upstox trade report" },
  { file: "upstox-realized-pnl.xlsx", broker: "upstox", expect: "upstox", label: "Upstox realised P&L report" },
  // No column header at all — nothing can read it; nothing may claim it.
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
  { file: "Paytm Money - EquityPnL (real).xls", expect: "generic-or-none" },
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

describe("no detector claims another BROKER's file", () => {
  // Strict zero applies CROSS-broker. A detector may recognise its own
  // broker's name on a sibling format (detectAngelOne returns its named-file
  // floor on the Angel tax P&L) — that is not a misroute as long as the real
  // owner outranks it, which the routing block above pins.
  const DETECTORS: { name: string; broker: string; fn: (ctx: ReturnType<typeof buildContext>) => number }[] = [
    { name: "detectZerodha", broker: "zerodha", fn: detectZerodha },
    { name: "detectGrowwXlsx", broker: "groww", fn: detectGrowwXlsx },
    { name: "detectGrowwOrders", broker: "groww", fn: detectGrowwOrders },
    { name: "detectAngelOne", broker: "angelone", fn: detectAngelOne },
    { name: "detectAngelOneTaxPnl", broker: "angelone", fn: detectAngelOneTaxPnl },
    { name: "detectUpstox", broker: "upstox", fn: detectUpstox },
    { name: "detectPaytmTradebook", broker: "paytm", fn: detectPaytmTradebook },
    // 2026-09-04: the five Dhan detectors join the refusal matrix.
    { name: "detectDhanGtr", broker: "dhan", fn: detectDhanGtr },
    { name: "detectDhanCsv", broker: "dhan", fn: detectDhanCsv },
    { name: "detectDhanRealisedPnl", broker: "dhan", fn: detectDhanRealisedPnl },
    { name: "detectDhanLedgerFile", broker: "dhan", fn: detectDhanLedgerFile },
    { name: "detectDhanDividend", broker: "dhan", fn: detectDhanDividend },
  ];

  for (const d of DETECTORS) {
    for (const f of FIXTURES) {
      if (f.broker === d.broker) continue;
      it(`${d.name} scores 0 on ${f.label}`, () => {
        expect(d.fn(load(f.file))).toBe(0);
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
const OWNER: { file: string; broker: string; expect: string }[] = [
  ...ownerFiles(/^Dhan_Ledger_.*\.csv$/).map((file) => ({ file, broker: "dhan", expect: "dhan-ledger" })),
  ...ownerFiles(/^Dhan_Dividend_.*\.csv$/).map((file) => ({ file, broker: "dhan", expect: "dhan-dividend" })),
  ...ownerFiles(/^Dhan_P&L_.*\.xlsx$/).map((file) => ({ file, broker: "dhan", expect: "dhan-csv" })),
  ...ownerFiles(/^realized_pnl-report.*\.xls$/).map((file) => ({ file, broker: "dhan", expect: "dhan-realised-pnl" })),
  ...(ownerFile(/^Trades_History_.*\.xlsx$/) ? [{ file: ownerFile(/^Trades_History_.*\.xlsx$/)!, broker: "angelone", expect: "angelone" }] : []),
];
const haveOwner = OWNER.length >= 8;

describe.skipIf(!haveOwner)("the owner's real Dhan and Angel One exports route to their own source", () => {
  for (const o of OWNER) {
    it(`${path.basename(o.file).slice(0, 22)}… → ${o.expect}`, () => {
      const { filename, bytes } = ownerContext(o.file);
      const ranked = rankParsers(buildContext(filename, bytes));
      expect(ranked[0].sourceId).toBe(o.expect);
      expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.9);
    });
  }
});

describe.skipIf(!haveOwner)("no detector claims another broker's REAL file (owner's folder)", () => {
  const DETECTORS: { name: string; broker: string; fn: (ctx: ReturnType<typeof buildContext>) => number }[] = [
    { name: "detectZerodha", broker: "zerodha", fn: detectZerodha },
    { name: "detectGrowwXlsx", broker: "groww", fn: detectGrowwXlsx },
    { name: "detectGrowwOrders", broker: "groww", fn: detectGrowwOrders },
    { name: "detectAngelOne", broker: "angelone", fn: detectAngelOne },
    { name: "detectAngelOneTaxPnl", broker: "angelone", fn: detectAngelOneTaxPnl },
    { name: "detectUpstox", broker: "upstox", fn: detectUpstox },
    { name: "detectPaytmTradebook", broker: "paytm", fn: detectPaytmTradebook },
    { name: "detectDhanGtr", broker: "dhan", fn: detectDhanGtr },
    { name: "detectDhanCsv", broker: "dhan", fn: detectDhanCsv },
    { name: "detectDhanRealisedPnl", broker: "dhan", fn: detectDhanRealisedPnl },
    { name: "detectDhanLedgerFile", broker: "dhan", fn: detectDhanLedgerFile },
    { name: "detectDhanDividend", broker: "dhan", fn: detectDhanDividend },
  ];
  for (const d of DETECTORS) {
    for (const o of OWNER) {
      if (o.broker === d.broker) continue;
      it(`${d.name} scores 0 on ${path.basename(o.file).slice(0, 22)}…`, () => {
        const { filename, bytes } = ownerContext(o.file);
        expect(d.fn(buildContext(filename, bytes))).toBe(0);
      });
    }
  }
});
