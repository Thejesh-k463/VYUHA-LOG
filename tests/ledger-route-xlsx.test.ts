import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * The Cash & Ledger door learns BYTES (v3.9.0).
 *
 * `app/api/import/ledger/route.ts` read every upload as UTF-8 text and handed
 * it to `parseDhanCashFile`. Upstox and Angel One publish their ledgers as
 * WORKBOOKS only, so an `.xlsx` arrived as mojibake and came back "no rows" —
 * a 422 that read like "your file is empty".
 *
 * The route now builds a `ParseContext` and resolves a workbook through the
 * parsers' OWN detect functions. The CSV path is untouched, and the Dhan
 * ledger CSV regression below is what proves it.
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
let t: TempDb;
let route: typeof import("@/app/api/import/ledger/route");

function post(name: string, body: Buffer | string, mode: "preview" | "commit" = "preview"): Request {
  const fd = new FormData();
  fd.append("file", new File([body as BlobPart], name));
  fd.append("mode", mode);
  return new Request("http://local/api/import/ledger", { method: "POST", body: fd });
}

const fixture = (f: string) => fs.readFileSync(path.join(DIR, f));

beforeAll(async () => {
  t = await openTempDb("ledger-route-xlsx", { seed: true });
  route = await import("@/app/api/import/ledger/route");
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
});

afterAll(() => t?.cleanup());

describe("an Upstox ledger WORKBOOK is read, not mangled", () => {
  it("previews 4 entries with their kinds", async () => {
    // REVERTED (bytes -> toString('utf-8')) this answers 422 with
    // "Could not find the ledger header row" — the whole point of the change.
    const res = await route.POST(post("ledger_20250719_To_20260904_trading.xlsx", fixture("upstox-ledger-2025-07-19_2026-09-04.xlsx")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.total).toBe(4);
    expect(json.from).toBe("2026-08-28");
    const kinds = Object.fromEntries((json.byKind as { kind: string; amount: number }[]).map((k) => [k.kind, k.amount]));
    expect(kinds.deposit).toBe(2500);
    expect(kinds.realised_pnl).toBe(-358.85);
    expect(kinds.adjustment).toBe(-78.44);
    // The MTF wallet transfer must NOT be read as MTF interest.
    expect(json.mtf.actual).toBe(0);
  });

  it("commits them under their own source", async () => {
    const res = await route.POST(post("ledger_20250719_To_20260904_trading.xlsx", fixture("upstox-ledger-2025-07-19_2026-09-04.xlsx"), "commit"));
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(4);
    const rows = t.db.select().from(t.schema.ledgerEntries).all();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["upstox-ledger"]));
    expect(rows.every((r) => r.accountId === 1)).toBe(true);
  });
});

describe("an Angel One account statement WORKBOOK is read", () => {
  it("previews the 8 Broking Ledger rows and does NOT double-post the DP charge", async () => {
    const res = await route.POST(post("YourStatement.xlsx", fixture("angelone-statement-2026-08-01_2026-08-31.xlsx")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(8);
    expect(json.from).toBe("2026-08-07");
    expect(json.to).toBe("2026-08-27");
    // The Charges sheet details the same Rs23.60 the ledger already posts.
    // If it were folded into `rows` this would be 9 and the charge total -47.20.
    const kinds = Object.fromEntries((json.byKind as { kind: string; amount: number }[]).map((k) => [k.kind, k.amount]));
    expect(kinds.charge).toBe(-94.4);
    expect(json.warnings.some((w: string) => /debit the account twice for one charge/.test(w))).toBe(true);
  });
});

describe("the CSV path is unchanged — the Dhan ledger regression", () => {
  it("still reads the owner's redacted Dhan ledger CSV byte-for-byte as before", async () => {
    const csv = fixture("dhan-ledger-2026-04-01_2026-09-03-a1.csv");
    const res = await route.POST(post("Dhan_Ledger_01-04-2026_03-09-2026.csv", csv));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.total).toBeGreaterThan(0);
    expect(json.mtf).toBeTruthy();
  });

  it("still reads the Dhan dividend payout CSV through the same door", async () => {
    const res = await route.POST(post("Dhan_Dividend_payout.csv", fixture("dhan-dividend-2025-04-01_2026-03-31.csv")));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect((json.byKind as { kind: string }[]).map((k) => k.kind)).toEqual(["dividend"]);
  });
});

describe("an unrecognised workbook is refused, not read as something it is not", () => {
  it("answers 422 and names what the door accepts", async () => {
    const res = await route.POST(post("holdings.xlsx", fixture("groww-order-history.xlsx")));
    expect(res.status).toBe(422);
    expect((await res.json()).message).toMatch(/No cash-file parser recognised holdings\.xlsx/);
  });
});
