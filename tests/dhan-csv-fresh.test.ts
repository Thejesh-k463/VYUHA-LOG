import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildContext, rankParsers } from "@/lib/import/detect";
import { detectDhanCsv } from "@/lib/import/parsers/dhan-csv";

/**
 * OWNER RULING, pinned (2026-09-04): `tests/fixtures/dhan-pnl-fresh.csv`
 * scores 1.0 under its own filename and 0.8 under a neutral one, and that
 * 0.8 is NOT a contradiction of the detection matrix.
 *
 * Why the two numbers differ. `detectDhanCsv` (dhan-csv.ts) adds:
 *   +0.30  "dhan" in the FILENAME
 *   +0.40  the file's own `PnL report` title line
 *   +0.40  the P&L header read as COLUMNS
 *   +0.20  the footer line `Net P&L,…Brokerage,…Gross P&L,…Total Charges`
 * This fixture is a FRESH export with no footer, so the +0.20 is absent:
 *   own filename  0.30 + 0.40 + 0.40 = 1.10 -> capped at 1.00
 *   neutral name         0.40 + 0.40 = 0.80
 *
 * Why 0.8 is honest rather than a hole. The matrix's contradiction to hunt is
 * a parser claiming a file at >= 0.9 WITHOUT the broker being named — the
 * 2026-08-12 misroute class. Here the content DOES name Dhan (its own
 * `PnL report` title), the score sits below 0.9 without the filename, and the
 * file's matrix rule is therefore "named only": it reaches the 0.9 bar only
 * when the name is present. A neutral-name claim at 0.8 still wins the
 * registry — which is correct, because the title line is Dhan's own — but it
 * is not the "named-only" contradiction, and this test pins both halves so a
 * future +0.2 tweak cannot quietly turn 0.8 into 0.9.
 *
 * `dhan-csv.ts` is NOT changed by this test. It records what it does.
 */
const FILE = path.join(process.cwd(), "tests", "fixtures", "dhan-pnl-fresh.csv");
const bytes = () => fs.readFileSync(FILE);
const own = () => buildContext("Dhan_P&L_fresh.csv", bytes());
const neutral = () => buildContext("export.csv", bytes());

describe("the fresh Dhan P&L CSV scores exactly 1.0 named and 0.8 neutral", () => {
  it("1.0 under a Dhan-named filename", () => {
    expect(detectDhanCsv(own())).toBe(1);
  });

  it("0.8 under a neutral filename — the missing 0.2 is the absent footer", () => {
    expect(detectDhanCsv(neutral())).toBe(0.8);
  });

  it("the fixture really has no footer line, which is where the 0.2 lives", () => {
    const text = bytes().toString("utf-8");
    expect(/Net P&L,.*Brokerage,.*Gross P&L,.*Total Charges/i.test(text)).toBe(false);
    // ... and it does carry the two terms that make up the 0.8.
    expect(/^PnL report/i.test(text.trimStart())).toBe(true);
  });

  it("appending the footer this export lacks moves the NEUTRAL score 0.8 -> 1.0", () => {
    // Direct proof that the missing 0.2 is the footer and nothing else.
    const withFooter = `${bytes().toString("utf-8")}\nNet P&L,100.00,Brokerage,10.00,Gross P&L,110.00,Total Charges,10.00\n`;
    expect(detectDhanCsv(buildContext("export.csv", Buffer.from(withFooter, "utf-8")))).toBe(1);
  });
});

describe("neither score is a '>= 0.9 named-only' contradiction", () => {
  it("the 0.9 bar is reached ONLY with the name — this fixture's matrix rule is 'named only'", () => {
    expect(detectDhanCsv(neutral())).toBeLessThan(0.9);
    expect(detectDhanCsv(own())).toBeGreaterThanOrEqual(0.9);
  });

  it("the neutral-name claim is carried by CONTENT that names Dhan, not by shape", () => {
    // Strip the `PnL report` title and the header still parses, but nothing
    // above the filename bonus is awarded — the gate AGENTS.md requires.
    const text = bytes().toString("utf-8").split(/\r?\n/).slice(1).join("\n");
    expect(detectDhanCsv(buildContext("export.csv", Buffer.from(text, "utf-8")))).toBe(0);
  });

  it("the file still routes to dhan-csv under either name", () => {
    expect(rankParsers(own())[0]!.sourceId).toBe("dhan-csv");
    expect(rankParsers(neutral())[0]!.sourceId).toBe("dhan-csv");
  });
});
