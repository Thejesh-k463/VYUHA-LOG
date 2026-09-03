import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * /api/import answers 400 `{code: "ACCOUNT_REQUIRED"}` — not a 500 — when the
 * upload has no account to land on: the All-accounts view is selected and the
 * form carries no accountId. `getWriteAccountId` throws `AccountRequiredError`
 * there since v3.8 (the lowest-id fallback is gone); before this catch the
 * commit path answered "Commit failed: Choose the account…" at 500 and the
 * preview path let the throw escape the handler altogether.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/import/route");

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "dhan-gtr.csv");
const ALL = 0;
const SWING = 2;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function post(fields: Record<string, string>): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([fs.readFileSync(FIXTURE)], "Dhan_GlobalTransction_Report.csv", { type: "text/csv" }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return route.POST(new Request("http://local/api/import", { method: "POST", body: fd }));
}

beforeAll(async () => {
  t = await openTempDb("import-route-account", { seed: true });
  route = await import("@/app/api/import/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});
afterAll(() => t?.cleanup());

describe("All accounts selected, no accountId in the body", () => {
  it("preview → 400 ACCOUNT_REQUIRED", async () => {
    selectAccount(ALL);
    const res = await post({ mode: "preview" });
    // THE assertion: without the catch this is an unhandled throw (a 500).
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("ACCOUNT_REQUIRED");
    expect(json.error).toMatch(/choose the account/i);
  });

  it("commit → 400 ACCOUNT_REQUIRED, and nothing is written", async () => {
    selectAccount(ALL);
    const res = await post({ mode: "commit" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ACCOUNT_REQUIRED");
    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(0);
  });

  it("an explicit accountId: 0 is refused the same way — 0 is a view, not a place", async () => {
    selectAccount(ALL);
    const res = await post({ mode: "commit", accountId: "0" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ACCOUNT_REQUIRED");
  });
});

describe("the write lands when an account is named or selected", () => {
  it("All accounts selected + accountId in the body → 200, rows in that account", async () => {
    selectAccount(ALL);
    const res = await post({ mode: "commit", accountId: String(SWING) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.added).toBeGreaterThan(0);
    const accounts = new Set(t.db.select({ a: t.schema.trades.accountId }).from(t.schema.trades).all().map((r) => r.a));
    expect([...accounts]).toEqual([SWING]);
  });

  it("an account selected, no accountId → 200 preview", async () => {
    selectAccount(SWING);
    const res = await post({ mode: "preview" });
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("preview");
  });
});
