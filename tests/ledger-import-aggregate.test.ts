import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Second pass, item 1 — a Dhan ledger IMPORT from the All-accounts view must be
 * refused (invariant 9). Same defect as the single-row /api/ledger add, one
 * whole statement wide.
 *
 * `app/api/import/ledger/route.ts` committed inside `db.transaction()` with
 * `getWriteAccountId()` and nothing selected, so the resolver's
 * `orderBy(asc(accounts.id)).limit(1)` fallback filed EVERY line of someone's
 * broker statement against account #1 — behind "Imported N ledger entries".
 *
 * THE JUDGEMENT CALL: preview is refused too, not just the commit. The
 * preview's newCount / dupCount / MTF reconciliation come from existingKeys()
 * and estimatedMtfInterest(), both of which read across EVERY account when
 * none is selected — so an aggregate-view preview shows a reconciliation no
 * per-account commit could reproduce. Refusing at the door says the true thing
 * once instead of showing numbers and then rejecting the button.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/import/ledger/route");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

const LEDGER = `Ledger Statement,From 01-07-2026 to 29-07-2026
Name,TESTUSER

Date,Particulars,Debit,Credit,Running Balance
"01 Jul 2026","Opening Balance","0.00","150000.00","150000.00"
"14 Jul 2026","MTF Interest 07 Jul - 13 Jul","1190.25","0.00","148809.75"
"16 Jul 2026","UPI deposit received from TESTUSER","0.00","50000.00","198809.75"
"20 Jul 2026","Dividend credit RELIANCE","0.00","1200.00","200009.75"
"22 Jul 2026","Payout to bank account","25000.00","0.00","175009.75"
`;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function req(mode: "preview" | "commit"): Request {
  const fd = new FormData();
  fd.append("file", new File([LEDGER], "ledger.csv", { type: "text/csv" }));
  fd.append("mode", mode);
  return new Request("http://local/api/import/ledger", { method: "POST", body: fd });
}

const rows = () => t.db.select().from(t.schema.ledgerEntries).all();

beforeAll(async () => {
  t = await openTempDb("ledger-import-aggregate", { seed: true });
  route = await import("@/app/api/import/ledger/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("the All-accounts view may not import a broker ledger", () => {
  it("REFUSES the commit that filed a whole statement against account #1", async () => {
    selectAccount(ALL);
    const res = await route.POST(req("commit"));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.forbidden).toBe(true);
    expect(json.message).toMatch(/pick an account in the sidebar/i);

    // THE assertion. Reverting the guard writes every parsed line here, inside
    // one transaction, on account #1 — and answers 200.
    expect(rows()).toHaveLength(0);
  });

  it("REFUSES the preview too — its dup count and MTF figure are cross-account in this view", async () => {
    selectAccount(ALL);
    const res = await route.POST(req("preview"));
    expect(res.status).toBe(403);
    expect((await res.json()).forbidden).toBe(true);
  });

  it("refuses before the file is read, so a missing file is not what the user hears about", async () => {
    selectAccount(ALL);
    const empty = new Request("http://local/api/import/ledger", { method: "POST", body: new FormData() });
    const res = await route.POST(empty);
    expect(res.status).toBe(403); // not the 400 "No file supplied."
    expect(rows()).toHaveLength(0);
  });
});

describe("the per-account path still works — the guard must not over-refuse", () => {
  it("previews for a selected account", async () => {
    selectAccount(SWING);
    const res = await route.POST(req("preview"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("preview");
    expect(json.newCount).toBeGreaterThan(0);
    expect(rows()).toHaveLength(0); // a preview commits nothing
  });

  it("commits the whole statement onto the SELECTED account, and none of it onto account #1", async () => {
    selectAccount(SWING);
    const res = await route.POST(req("commit"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("commit");
    expect(json.added).toBeGreaterThan(0);

    const all = rows();
    expect(all.length).toBe(json.added);
    expect(all.every((r) => r.accountId === SWING)).toBe(true);
    expect(all.filter((r) => r.accountId === PRIMARY)).toHaveLength(0);
    expect(all.every((r) => r.source === "dhan-ledger")).toBe(true);
  });

  it("re-importing the same file is deduped, not doubled", async () => {
    selectAccount(SWING);
    const before = rows().length;
    const res = await route.POST(req("commit"));
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(0);
    expect(rows()).toHaveLength(before);
  });

  it("a file that is not a ledger still 422s, not 403 — the refusals stay distinguishable", async () => {
    selectAccount(SWING);
    const fd = new FormData();
    fd.append("file", new File(["not,a,ledger\n1,2,3\n"], "junk.csv", { type: "text/csv" }));
    fd.append("mode", "preview");
    const res = await route.POST(new Request("http://local/api/import/ledger", { method: "POST", body: fd }));
    expect(res.status).toBe(422);
  });
});
