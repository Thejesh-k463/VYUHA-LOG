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
];

const load = (file: string) => buildContext(file, fs.readFileSync(path.join(DIR, file)));

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
