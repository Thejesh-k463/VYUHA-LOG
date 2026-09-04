import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { detectPaytmRealisedPnl, parsePaytmRealisedPnl, lotDate, dateShape } from "@/lib/import/parsers/paytm-realised-pnl";
import type { ParseContext } from "@/lib/import/types";

/**
 * Paytm Money Realized P&L (.xls) — the v3.9 REFERENCE parser.
 *
 * Pinned against the redacted copies of the owner's real exports. The large
 * one is a byte-for-byte-structure redaction of an 918-lot export: same header
 * row, same date notation, same Σ, same Total. Nothing in this file may print
 * a UCC, a name or a PAN, and the assertions below prove the parser emits
 * none of them.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const LARGE = "paytm-equity-pnl-2026-04-01_2026-08-28.xls";
const SMALL = "paytm-equity-pnl-2026-08-01_2026-08-18.xls";
const TRADEBOOK = "paytm-tradebook-2026-08-01_2026-08-18.xlsx";

const have = (f: string) => fs.existsSync(path.join(DIR, f));
const ctxFor = (f: string, name = f): ParseContext => ({ filename: name, buffer: fs.readFileSync(path.join(DIR, f)) });

/** The four identity fields the file carries and this parser must never emit. */
const IDENTITY = [/\bUCC\b/i, /PAN\s*number/i, /\bREDACTED NAME\b/i, /AAAAA0000A/];

describe("detection", () => {
  it("claims the Realized P&L export on its sheet + header alone, under a neutral filename", () => {
    if (!have(LARGE)) return; // the fixture is gitignored on some machines
    // NEUTRAL name on purpose: the real export names no broker either, and
    // the workbook itself never writes the word "Paytm" (verified on the real
    // file and both redacted copies), so 0.9 is the ceiling here.
    expect(detectPaytmRealisedPnl(ctxFor(LARGE, "export.xls"))).toBe(0.9);
  });

  it("adds the name bonus when the filename says Paytm", () => {
    if (!have(LARGE)) return;
    expect(detectPaytmRealisedPnl(ctxFor(LARGE, "Paytm Money realised.xls"))).toBe(1);
  });

  it("refuses a CSV outright — this file is a container, not a table", () => {
    expect(detectPaytmRealisedPnl({ filename: "export.csv", text: "Scrip Name,ISIN,Quantity,Buy Date,Buy Price,Buy Value,Sell Date,Sell Price,Sell Value,P&L Value\n" })).toBe(0);
  });

  it("refuses Paytm's own TRADEBOOK — the sibling it must never claim", () => {
    if (!have(TRADEBOOK)) return;
    expect(detectPaytmRealisedPnl(ctxFor(TRADEBOOK))).toBe(0);
  });

  it("refuses a workbook with no bytes at all", () => {
    expect(detectPaytmRealisedPnl({ filename: "empty.xls" })).toBe(0);
  });
});

describe("date notation is read FROM the file", () => {
  it("recognises each notation a broker export could carry", () => {
    expect(dateShape("20-Jul-2026")).toBe("dd-mmm-yyyy");
    expect(dateShape("20-07-2026")).toBe("numeric-day-first");
    expect(dateShape("20/07/2026")).toBe("numeric-day-first");
    expect(dateShape("2026-07-20")).toBe("iso");
    expect(dateShape("46223")).toBe("excel-serial");
    expect(dateShape("")).toBeNull();
    expect(dateShape("not a date")).toBeNull();
  });

  it("converts each of them to the same ISO day", () => {
    expect(lotDate("20-Jul-2026")).toBe("2026-07-20");
    expect(lotDate("20-07-2026")).toBe("2026-07-20");
    expect(lotDate("20/07/2026")).toBe("2026-07-20");
    expect(lotDate("2026-07-20")).toBe("2026-07-20");
    expect(lotDate("nonsense")).toBeNull();
  });

  it("the verified export is dd-MMM-yyyy, so nothing is ever guessed day-vs-month on it", () => {
    if (!have(LARGE)) return;
    const parsed = parsePaytmRealisedPnl(ctxFor(LARGE));
    expect(parsed.warnings.some((w) => /dd-mm-yyyy/.test(w)), "no ambiguity warning belongs on an unambiguous file").toBe(false);
  });
});

describe("the 918-lot export", () => {
  it("reads every lot row, emits no trades, and conserves Σ against the file's own Total", () => {
    if (!have(LARGE)) return;
    const parsed = parsePaytmRealisedPnl(ctxFor(LARGE));
    expect(parsed.sourceId).toBe("paytm-realised-pnl");
    expect(parsed.broker).toBe("paytm");
    expect(parsed.trades, "a reference source never writes the book").toEqual([]);
    expect(parsed.sourceRows).toBe(918);
    // The file's Total is 21,371,252.57. A conservation warning is emitted ONLY
    // on a mismatch, so its absence IS the check.
    expect(parsed.warnings.filter((w) => /Total says/.test(w))).toEqual([]);
    const fy = parsed.reference!.filter((r) => r.scope === "fy");
    expect(fy).toHaveLength(1);
    expect(fy[0].key).toBe("2026-27");
    expect(fy[0].figures.grossPnl).toBeCloseTo(21371252.57, 2);
  });

  it("emits one scrip figure per (ISIN, sell date), never one per lot", () => {
    if (!have(LARGE)) return;
    const scrips = parsePaytmRealisedPnl(ctxFor(LARGE)).reference!.filter((r) => r.scope === "scrip");
    expect(scrips.length).toBeGreaterThan(0);
    expect(scrips.length, "918 lots must collapse — two rows sharing a key would double the broker's side").toBeLessThan(918);
    const keys = scrips.map((r) => `${r.key}|${r.asOf}`);
    expect(new Set(keys).size, "the store's identity is (scope, key, as_of); a repeat would silently overwrite").toBe(keys.length);
    const sum = scrips.reduce((s, r) => s + r.figures.grossPnl, 0);
    expect(sum, "aggregation must not lose a paisa").toBeCloseTo(21371252.57, 1);
  });

  it("keys scrip rows by ISIN, carries the scrip name as the symbol, and dates them by SELL date", () => {
    if (!have(LARGE)) return;
    const scrips = parsePaytmRealisedPnl(ctxFor(LARGE)).reference!.filter((r) => r.scope === "scrip");
    const dyn = scrips.find((r) => r.key === "INE600Y01019")!;
    expect(dyn, "the first lot row of the verified export").toBeTruthy();
    expect(dyn.isin).toBe("INE600Y01019");
    expect(dyn.symbol).toBe("Dynamic Cables Limited");
    expect(dyn.asOf).toBe("2026-07-20");
    expect(dyn.fy).toBe("2026-27");
    expect(dyn.figures).toEqual({ qty: 300, buyValue: 124830.87, sellValue: 125686.47, grossPnl: 855.6 });
    for (const r of scrips) expect(Object.keys(r.figures).sort()).toEqual(["buyValue", "grossPnl", "qty", "sellValue"]);
  });

  it("says plainly that the file states no charges", () => {
    if (!have(LARGE)) return;
    const w = parsePaytmRealisedPnl(ctxFor(LARGE)).warnings;
    expect(w.some((x) => /states no charges/.test(x) && /tradebook/.test(x))).toBe(true);
  });

  it("emits no UCC, no name and no PAN anywhere in its output", () => {
    if (!have(LARGE)) return;
    const parsed = parsePaytmRealisedPnl(ctxFor(LARGE));
    const blob = JSON.stringify({ warnings: parsed.warnings, reference: parsed.reference });
    for (const pattern of IDENTITY) expect(blob, `identity leaked: ${pattern}`).not.toMatch(pattern);
    // Belt and braces: the Period line too. It is file metadata, not a figure.
    expect(blob).not.toMatch(/01-Apr-2026 to 28-Aug-2026/);
  });
});

describe("the 124-lot export", () => {
  it("reads the narrower window the same way", () => {
    if (!have(SMALL)) return;
    const parsed = parsePaytmRealisedPnl(ctxFor(SMALL));
    expect(parsed.sourceRows).toBe(124);
    expect(parsed.trades).toEqual([]);
    expect(parsed.warnings.filter((w) => /Total says/.test(w))).toEqual([]);
    const fy = parsed.reference!.filter((r) => r.scope === "fy");
    expect(fy.map((r) => r.key)).toEqual(["2026-27"]);
    expect(fy[0].figures.grossPnl).toBeCloseTo(2023631.97, 2);
  });
});

describe("a file this parser cannot read refuses rather than inventing", () => {
  it("returns no reference and says why when the detail header is missing", () => {
    if (!have(TRADEBOOK)) return;
    const parsed = parsePaytmRealisedPnl(ctxFor(TRADEBOOK));
    expect(parsed.reference).toBeUndefined();
    expect(parsed.trades).toEqual([]);
    expect(parsed.warnings[0]).toMatch(/Could not find Paytm's Realized P&L Detail header/);
  });
});
