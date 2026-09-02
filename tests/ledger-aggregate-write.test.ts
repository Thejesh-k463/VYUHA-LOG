import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * D-2 (ledger half) — a cash entry added from the All-accounts view must be
 * REFUSED, not filed against whichever account sorts first (invariant 9).
 *
 * The shipped bug: `app/api/ledger/route.ts` resolved `getWriteAccountId()`
 * with nothing selected, and that resolver's no-selection fallback is
 * `orderBy(asc(accounts.id)).limit(1)`. Probed on a two-account temp DB with
 * `selected_account_id = 0`: `POST /api/ledger {action:"add", type:"deposit",
 * amount:50000}` returned 200 "Ledger entry added." with the row on
 * account_id 1. A ₹50,000 deposit in the wrong book, silently, behind a
 * success toast (components/cash/ledger-form.tsx toasts `data.message`).
 *
 * THE JUDGEMENT CALL: a ledger entry is genuinely a per-account record, so
 * this is the house refusal (lib/queries/challans.ts, /api/bf-losses) — 403
 * for the aggregate-view write ban, 400 for everything else. A
 * WriteAccountPicker on /cash, the way /import and /trades solve it, would be
 * friendlier; that is UI work and is recommended, not done here.
 *
 * DELETE is deliberately NOT refused: it locates the row first and the
 * aggregate view may only remove what it can already see — the same rule
 * lib/queries/delete.ts and /api/ipos DELETE use. Pinned below so the refusal
 * does not creep.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/ledger/route");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function req(body: unknown): Request {
  return new Request("http://local/api/ledger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const rows = () => t.db.select().from(t.schema.ledgerEntries).all();

beforeAll(async () => {
  t = await openTempDb("ledger-aggregate", { seed: true });
  route = await import("@/app/api/ledger/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("D-2: the All-accounts view may not add a cash entry", () => {
  it("REFUSES the ₹50,000 deposit the probe filed against account #1, with 403 and a reason", async () => {
    selectAccount(ALL);
    const res = await route.POST(req({ action: "add", type: "deposit", bucket: "equity", amount: 50000, date: "2026-06-20" }));

    expect(res.status).toBe(403); // the write is understood; this view may never make it
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.forbidden).toBe(true);
    expect(json.message).toMatch(/pick an account in the sidebar/i);
    expect(json.message).toMatch(/All-accounts view only reads/);

    // THE assertion. Reverting the guard files this on account #1 and answers
    // 200 "Ledger entry added." — ₹50,000 in a book the user never chose.
    expect(rows()).toHaveLength(0);
  });

  it("refuses BEFORE parsing, so an aggregate-view write can never be mistaken for a validation error", async () => {
    selectAccount(ALL);
    // A body that is ALSO invalid (unknown type) still 403s: the account
    // question is answered first, exactly as challans/review do it.
    const res = await route.POST(req({ action: "add", type: "not-a-type", amount: 1 }));
    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("every ledger type is refused, not just the money-shaped ones", async () => {
    selectAccount(ALL);
    for (const type of ["deposit", "withdrawal", "dividend", "charge", "realised_pnl"]) {
      const res = await route.POST(req({ action: "add", type, bucket: "equity", amount: 1000 }));
      expect(res.status, type).toBe(403);
    }
    expect(rows()).toHaveLength(0);
  });
});

describe("the per-account path still works — the guard must not over-refuse", () => {
  it("a selected account takes the deposit, in paise, on its own book", async () => {
    selectAccount(SWING);
    const res = await route.POST(req({ action: "add", type: "deposit", bucket: "equity", amount: 50000, date: "2026-06-20", note: "opening funding" }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("Ledger entry added.");

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].accountId).toBe(SWING);
    // Invariant 1 spot-check: integer paise at rest, rupees at the call site.
    expect(t.sqlite.prepare("select amount_paise as p from ledger_entries where id = ?").get(all[0].id)).toEqual({ p: 5_000_000 });
  });

  it("account #1 — the one the fallback kept hitting — has nothing in it", () => {
    expect(rows().filter((r) => r.accountId === PRIMARY)).toHaveLength(0);
  });

  it("a bad amount still 400s, not 403 — the two refusals stay distinguishable", async () => {
    selectAccount(SWING);
    expect((await route.POST(req({ action: "add", type: "deposit", amount: 0 }))).status).toBe(400);
    expect((await route.POST(req({ action: "add", type: "nonsense", amount: 5 }))).status).toBe(400);
    expect((await route.POST(req({ action: "sideways" }))).status).toBe(400);
  });

  it("DELETE from the aggregate view is still allowed — it can only remove what it can see", async () => {
    const id = rows()[0].id;
    selectAccount(ALL);
    const res = await route.POST(req({ action: "delete", id }));
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  it("a single-account view still cannot delete another account's row", async () => {
    selectAccount(SWING);
    await route.POST(req({ action: "add", type: "deposit", bucket: "equity", amount: 1000 }));
    const id = rows()[0].id;
    selectAccount(PRIMARY);
    expect((await route.POST(req({ action: "delete", id }))).status).toBe(404);
    expect(rows()).toHaveLength(1);
  });
});
