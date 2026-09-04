import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * /api/import REFUSES a commit of a file that parsed cleanly into NO trades
 * (v3.8.0 fix wave, finder 3 item 6).
 *
 * The route guarded only `generic-unmapped`, so the two Dhan CASH sources —
 * and any PDF whose rows this route cannot read — went straight to
 * `commitParsedFile`, which writes an `import_batches` row unconditionally.
 * The result was a batch with rowCount 0 and status "completed": the Imports
 * table reported a successful import of nothing, which is exactly how a user
 * fails to notice they uploaded the wrong file.
 *
 * The ledger fixture is the one pinned in tests/dhan-cash-sources.test.ts as
 * parsing to `trades: []` by design (it goes to the Cash & Ledger screen).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/import/route");

const LEDGER = fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "dhan-ledger.csv"), "utf8");
const GTR = path.join(process.cwd(), "tests", "fixtures", "dhan-gtr.csv");

function post(file: File, fields: Record<string, string>): Promise<Response> {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return route.POST(new Request("http://local/api/import", { method: "POST", body: fd }));
}

const ledgerFile = () => new File([LEDGER], "Dhan_Ledger_x.csv", { type: "text/csv" });

const batches = () => t.db.select().from(t.schema.importBatches).all();

beforeAll(async () => {
  t = await openTempDb("import-route-empty-commit", { seed: true });
  route = await import("@/app/api/import/route");
});
afterAll(() => t?.cleanup());

describe("a commit with zero parsed trades", () => {
  it("is refused 422 NO_TRADES_PARSED, and writes NO import batch", async () => {
    const before = batches().length;
    const res = await post(ledgerFile(), { mode: "commit" });

    // THE assertion, red on revert: without the guard this is a 200 whose
    // `result` reports added 0 — and a new import_batches row with rowCount 0.
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe("NO_TRADES_PARSED");
    expect(json.error).toMatch(/no trades/i);
    expect(batches()).toHaveLength(before);
  });

  it("says where the file actually goes — the parser's own warnings survive the refusal", async () => {
    const json = await (await post(ledgerFile(), { mode: "commit" })).json();
    expect(json.warnings.join(" ")).toMatch(/Cash & Ledger/);
  });

  it("PREVIEW of the same file is untouched — the user must still be able to look", async () => {
    const res = await post(ledgerFile(), { mode: "preview" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("preview");
    expect(json.preview.summary.total).toBe(0);
  });

  it("a file that DOES carry trades still commits", async () => {
    const res = await post(new File([fs.readFileSync(GTR)], "Dhan_GlobalTransction_Report.csv", { type: "text/csv" }), {
      mode: "commit",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result.added).toBeGreaterThan(0);
  });
});
