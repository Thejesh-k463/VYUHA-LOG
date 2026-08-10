import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * replaceRestrictionCategories — the per-category merge behind surveillance
 * FILE uploads.
 *
 * Temp-db, not pure: the behaviour under test IS the SQL (the DELETE's WHERE
 * scope inside the transaction). The failure this guards against: NSE ships
 * ban and ASM/GSM/ESM as SEPARATE files, and a whole-table replace — which is
 * what the paste path correctly does — would make the day's second upload
 * silently erase the first. Nothing would look broken; the surveillance page
 * would simply be missing half its rows.
 */

let t: TempDb;
let replaceRestrictionCategories: typeof import("@/lib/queries/restrictions")["replaceRestrictionCategories"];

const row = (symbol: string, category: string, stage: string | null = null) => ({
  symbol,
  category: category as never,
  stage,
  note: null,
  asOfDate: "2026-08-10",
  source: "NSE",
});

function listAll(): { symbol: string; category: string }[] {
  return t.sqlite
    .prepare("SELECT symbol, category FROM restricted_securities ORDER BY category, symbol")
    .all() as { symbol: string; category: string }[];
}

beforeAll(async () => {
  t = await openTempDb("restr-merge", { seed: true });
  ({ replaceRestrictionCategories } = await import("@/lib/queries/restrictions"));
});
afterAll(() => t.cleanup());

describe("replaceRestrictionCategories", () => {
  it("an upload touches ONLY its own categories — pasted rows of others survive", () => {
    // Day starts with a pasted mixed list (the paste path's whole-replace
    // equivalent): one GSM row, one circuit row.
    replaceRestrictionCategories(["gsm"], [row("IDEA", "gsm", "Stage 4")]);
    replaceRestrictionCategories(["circuit"], [row("YESBANK", "circuit", "5%")]);

    // The ban-file upload replaces fno_ban only.
    replaceRestrictionCategories(["fno_ban"], [row("RBLBANK", "fno_ban"), row("LICI", "fno_ban")]);

    expect(listAll()).toEqual([
      { symbol: "YESBANK", category: "circuit" },
      { symbol: "LICI", category: "fno_ban" },
      { symbol: "RBLBANK", category: "fno_ban" },
      { symbol: "IDEA", category: "gsm" },
    ]);
  });

  it("re-uploading the same file is idempotent — replace, never accumulate", () => {
    const before = listAll();
    const out = replaceRestrictionCategories(["fno_ban"], [row("RBLBANK", "fno_ban"), row("LICI", "fno_ban")]);
    expect(out).toEqual({ deleted: 2, inserted: 2 });
    expect(listAll()).toEqual(before);
  });

  it("a REG_IND upload replaces gsm+asm+esm together and leaves ban/circuit alone", () => {
    const out = replaceRestrictionCategories(
      ["gsm", "asm", "esm"],
      [row("BLUECHIP", "gsm", "Stage 1"), row("63MOONS", "asm", "Short-term Stage 1"), row("AARTECH", "esm", "Stage 1")],
    );
    expect(out.deleted).toBe(1); // the old IDEA gsm row
    const now = listAll();
    expect(now.filter((r) => r.category === "fno_ban")).toHaveLength(2);
    expect(now.filter((r) => r.category === "circuit")).toHaveLength(1);
    expect(now.find((r) => r.category === "gsm")?.symbol).toBe("BLUECHIP");
    expect(now.some((r) => r.symbol === "IDEA")).toBe(false);
  });

  it("an EMPTY row set still clears its categories — an empty ban day is real data", () => {
    const out = replaceRestrictionCategories(["fno_ban"], []);
    expect(out).toEqual({ deleted: 2, inserted: 0 });
    expect(listAll().some((r) => r.category === "fno_ban")).toBe(false);
    // Everything else untouched.
    expect(listAll().filter((r) => r.category === "circuit")).toHaveLength(1);
  });
});
