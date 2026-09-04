import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildContext, rankParsers } from "@/lib/import/detect";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v3.9 "Trust the numbers" — WHY a segment line differs.
 *
 * RED-FIRST. `e2e/z-reconcile.spec.ts:89` asserted, over exactly the pair of
 * files below:
 *
 *     await expect.poll(() => reasons.count()).toBeGreaterThan(0);
 *     // Expected: > 0   Received: 0
 *
 * and, at :102, that a reason is "a sentence, not a code" (length > 20). Both
 * failed because the Dhan Realised P&L states SEGMENT rows and nothing else —
 * no FY row, no scrip row — while `reconcileFrom` computed `open_lots` and
 * `product_difference` for `scope === "scrip"` only, and counted an unpriced
 * sale only BELOW the `isOpen` guard, which an opening sell never gets past.
 * So the owner's own primary reference file put two rows on screen, ₹84k and
 * ₹101k out of tolerance, with an empty "Why" column on both.
 *
 * Asserted here against the REAL redacted exports, through the real commit
 * path, so a fixture that stops parsing fails this file rather than passing it
 * vacuously. One temp DB per file (AGENTS.md); lib/queries is imported
 * dynamically so VYUHA_DB_PATH binds first.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
/** The book: 209 bill lines → 178 positions (174 closed, 3 open, 1 opening sell). */
const GTR = "dhan-gtr-2026-04-01_2026-09-03-a2.csv";
/** The reference: four segment rows, no FY row, no scrip row, charges stated. */
const REALISED = "dhan-realised-pnl-2026-04-01_2026-09-03-a2.xls";

const ACCOUNT = 4200;

let t: TempDb;
let refq: typeof import("@/lib/queries/reference");
let recon: import("@/lib/queries/reference").Reconciliation;

beforeAll(async () => {
  t = await openTempDb("reconcile-segment-reasons", { seed: true });
  const commit = await import("@/lib/import/commit");
  refq = await import("@/lib/queries/reference");

  t.db.insert(t.schema.accounts).values({ id: ACCOUNT, name: "broker truth" }).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: ACCOUNT }).run();

  for (const f of [GTR, REALISED]) {
    const ctx = buildContext(f, fs.readFileSync(path.join(DIR, f)));
    const parsed = await rankParsers(ctx)[0].parse(ctx);
    commit.commitParsedFile(parsed, f, null, ACCOUNT);
  }
  recon = refq.reconcile(ACCOUNT);
}, 180_000);

afterAll(() => t?.cleanup());

const SANCTIONED = ["unpriced_sales", "charges_omitted", "open_lots", "product_difference"];

describe("a Dhan Realised P&L reconciles on its segment rows — the only rows it states", () => {
  it("states the segments and nothing else, so the segment table is the whole screen", () => {
    expect(recon.segment.map((l) => l.key).sort()).toEqual(["equity", "fno"]);
    expect(recon.fy, "the file states no period — inventing one would be a second bucketing").toHaveLength(0);
    expect(recon.scrip).toHaveLength(0);
  });

  it("counts the book's F&O against the broker's F&O — not against zero", () => {
    // `FAMILY_OF` was written over a vocabulary that does not exist
    // (fut_index / opt_stock / comm_fut), so every index_option and
    // stock_option trade fell through `?? null` and this row read ₹0.00
    // against the broker's own total: a 100%-of-the-figure error wearing the
    // costume of a reconciliation.
    const fno = recon.segment.find((l) => l.key === "fno")!;
    expect(fno.stated.grossPnl).toBeCloseTo(-50987.04, 2);
    expect(fno.vyuha.grossPnl, "the book's own F&O rows must land in the F&O family").not.toBe(0);
    expect(Math.abs(fno.vyuha.grossPnl)).toBeGreaterThan(1000);
  });
});

describe("every line out of tolerance explains itself, or names what it checked", () => {
  it("carries at least one counted reason, or a checked-and-found-nothing sentence", () => {
    const out = recon.segment.filter((l) => !l.matched);
    expect(out.length, "this pair is ~₹84k apart — a silent screen would be the defect").toBeGreaterThan(0);
    for (const l of out) {
      const said = l.reasons.length > 0 ? l.reasons.map((r) => r.detail) : [l.checkedNote ?? ""];
      expect(said.filter(Boolean).length, `${l.key} states no reason and no checked note`).toBeGreaterThan(0);
      for (const detail of said) {
        // e2e :102 — "a reason must be a sentence, not a code".
        expect(detail.length).toBeGreaterThan(20);
        expect(detail).toMatch(/\d/);
        expect(detail.toLowerCase(), "never the word the whole feature exists to replace").not.toContain("mismatch");
      }
    }
  });

  it("uses only the four sanctioned codes — an invented excuse is worse than none", () => {
    for (const l of [...recon.segment, ...recon.fy, ...recon.scrip]) {
      for (const r of l.reasons) expect(SANCTIONED).toContain(r.code);
    }
  });

  it("counts the OPENING SELL as an unpriced sale on the equity segment", () => {
    // 37 SBI Funds Management shares sold on 2026-07-22 with no purchase in
    // the book: `acquisition = "unknown"`, and `is_open` — which is why the
    // old `if (t.isOpen) … continue` above the unpriced block meant the one
    // shape that is ALWAYS unpriced was the one shape never counted.
    const eq = recon.segment.find((l) => l.key === "equity")!;
    const u = eq.reasons.find((r) => r.code === "unpriced_sales");
    expect(u, "an opening sell is a sale with no purchase — the reason exists for it").toBeTruthy();
    expect(u!.count).toBe(1);
    expect(u!.amount).toBeCloseTo(21904, 2);
    expect(u!.detail).toContain("21,904");
  });

  it("states the equity segment's open lots, which a segment total never contains", () => {
    const eq = recon.segment.find((l) => l.key === "equity")!;
    const o = eq.reasons.find((r) => r.code === "open_lots");
    expect(o, "3 open positions + the opening sell are in the book and not in the broker's realised total").toBeTruthy();
    expect(o!.count).toBe(4);
    expect(o!.detail).toMatch(/still open in your book/);
  });

  it("the F&O segment RECONCILES once the Realised P&L no longer double-counts the book", () => {
    // Before the reference-beside-book rule (2026-09-04) this line was exactly
    // 2× the broker: the Realised P&L committed its own trades beside the GTR's.
    const fno = recon.segment.find((l) => l.key === "fno")!;
    expect(fno.matched).toBe(true);
    for (const v of Object.values(fno.delta)) expect(Math.abs(v)).toBeLessThanOrEqual(0.05);
    expect(fno.reasons).toHaveLength(0);
    expect(fno.checkedNote).toBeNull();
  });

  it("says WHICH facts came back zero when none of them fired", () => {
    // Synthetic: the broker's F&O figures against an EMPTY book, so the line
    // is out of tolerance and every counted fact is genuinely zero. A bare
    // dash on a row ₹50k out is the "generic line" defect.
    const fnoRefs = refq.getReferenceRows(ACCOUNT).filter((r) => r.scope === "segment" && r.key === "fno");
    expect(fnoRefs.length).toBeGreaterThan(0);
    const lone = refq.reconcileFrom(fnoRefs, []);
    const fno = lone.segment.find((l) => l.key === "fno")!;
    expect(fno.matched).toBe(false);
    expect(fno.reasons).toHaveLength(0);
    expect(fno.checkedNote).toBeTruthy();
    expect(fno.checkedNote!).toMatch(/0 sales without a purchase/);
    expect(fno.checkedNote!).toMatch(/0 open lots/);
    expect(fno.checkedNote!).toMatch(/states its own charges/);
    expect(fno.checkedNote!.toLowerCase()).not.toContain("mismatch");
  });

  it("leaves a matched line with no checked note — nothing to explain", () => {
    for (const l of [...recon.segment, ...recon.scrip, ...recon.fy]) {
      if (l.matched) expect(l.checkedNote).toBeNull();
    }
  });
});
