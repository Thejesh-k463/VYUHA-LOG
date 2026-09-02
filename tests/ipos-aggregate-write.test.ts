import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * D-2 (IPO half) — creating an IPO application from the All-accounts view must
 * be REFUSED, not filed against whichever account sorts first (invariant 9).
 *
 * The shipped bug, and the reason it hid for so long: the comment at the
 * insert claimed defect D9 (2026-08-12) had FIXED this by swapping
 * `getSelectedAccountId() || 1` for `getWriteAccountId()`. It had not.
 * getWriteAccountId's own no-selection fallback is
 * `orderBy(asc(accounts.id)).limit(1)` — the lowest account id — which on the
 * install shape that matters is exactly `|| 1`. Probed on a two-account temp
 * DB with `selected_account_id = 0`: `POST /api/ipos` → 200 "IPO added.",
 * `ipos.account_id = 1`. The comment was corrected with the code.
 *
 * THE JUDGEMENT CALL: same as the ledger — an IPO application is a per-account
 * record, so this is the house refusal (403 for the aggregate-view write ban,
 * 400 for everything else). An account picker on /ipos, the way /import and
 * /trades do it, would be friendlier; that is UI work and is recommended only.
 *
 * The EDIT and DELETE branches are deliberately NOT refused: each locates the
 * row first and lets the aggregate view touch only what it can already see.
 * Both are pinned below so the refusal does not creep past the create path.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/ipos/route");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function req(body: unknown): Request {
  return new Request("http://local/api/ipos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const del = (id: number) => route.DELETE(new Request(`http://local/api/ipos?id=${id}`, { method: "DELETE" }));

const rows = () => t.db.select().from(t.schema.ipos).all();

const application = (over: Record<string, unknown> = {}) => ({
  name: "TATA TECH",
  broker: "zerodha",
  exchange: "NSE",
  board: "mainboard",
  appliedPrice: 500,
  lotSize: 30,
  lotsApplied: 1,
  allotted: true,
  allottedQty: 30,
  ...over,
});

beforeAll(async () => {
  t = await openTempDb("ipos-aggregate", { seed: true });
  route = await import("@/app/api/ipos/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("D-2: the All-accounts view may not create an IPO application", () => {
  it("REFUSES the create the probe filed against account #1, with 403 and a reason", async () => {
    selectAccount(ALL);
    const res = await route.POST(req(application()));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.forbidden).toBe(true);
    expect(json.message).toMatch(/pick an account in the sidebar/i);

    // THE assertion. Reverting the guard puts this row on account_id 1 and
    // answers 200 "IPO added." — components/ipo/ipo-client.tsx then toasts
    // "IPO saved." for a record in a book the user never chose.
    expect(rows()).toHaveLength(0);
  });

  it("a body that would also fail validation still 403s — the account question is answered first", async () => {
    selectAccount(ALL);
    // Missing name is a 400 in a single-account view; in the aggregate view
    // the account ban is the reason the user needs to hear.
    const named = await route.POST(req(application({ name: "" })));
    expect(named.status).toBe(400); // name is checked before the row is built at all
    expect(rows()).toHaveLength(0);
  });
});

describe("the per-account path still works — the guard must not over-refuse", () => {
  let swingIpoId = 0;

  it("a selected account gets the application on its own book", async () => {
    selectAccount(SWING);
    const res = await route.POST(req(application()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    swingIpoId = json.id;

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].accountId).toBe(SWING);
    expect(all[0].name).toBe("TATA TECH");
    // Account #1, the one the fallback kept hitting, stayed empty.
    expect(all.filter((r) => r.accountId === PRIMARY)).toHaveLength(0);
  });

  it("EDIT from the aggregate view is still allowed — it locates the row before it writes", async () => {
    selectAccount(ALL);
    const res = await route.POST(req(application({ id: swingIpoId, listingPrice: 620, exitPrice: 640 })));
    expect(res.status).toBe(200);
    const row = rows()[0];
    expect(row.listingPrice).toBe(620);
    expect(row.accountId).toBe(SWING); // an edit never relocates the record
  });

  it("a single-account view still cannot edit another account's IPO", async () => {
    selectAccount(PRIMARY);
    const res = await route.POST(req(application({ id: swingIpoId, name: "STOLEN" })));
    expect(res.status).toBe(404);
    expect(rows()[0].name).toBe("TATA TECH");
  });

  it("DELETE from the aggregate view is still allowed", async () => {
    selectAccount(ALL);
    expect((await del(swingIpoId)).status).toBe(200);
    expect(rows()).toHaveLength(0);
  });
});

describe("the misleading D9 comment is gone", () => {
  it("the source no longer claims getWriteAccountId removed the account-1 misfiling", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("app/api/ipos/route.ts", "utf8"));
    // The old comment read: "the old fallback silently filed every IPO added
    // from the All-accounts view into account 1 (defect D9)" — past tense, on
    // a line that was still doing exactly that. It must not come back.
    expect(src).not.toMatch(/the old fallback silently filed every IPO/);
    expect(src).toMatch(/getSelectedAccountId\(\) === 0/);
  });
});
