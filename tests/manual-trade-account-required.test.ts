import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * The manual-trade entry point (`createManualTrade`, app/trades/actions.ts —
 * a server action, the only way a manual trade is created) answers a stable
 * `code: "ACCOUNT_REQUIRED"` when the write has no account to land on: the
 * All-accounts view selected and no accountId in the form. That is the
 * server-action analogue of the routes' 400 `{code}`; before the catch the
 * refusal was only its prose message, indistinguishable from any other error.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let actions: typeof import("@/app/trades/actions");

const ALL = 0;
const SWING = 2;
const PREV = { ok: false, message: "" };

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function form(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    broker: "zerodha", tradingsymbol: "INFY", productHint: "delivery", segment: "eq_delivery", exchange: "NSE",
    buyQty: "10", avgBuyPrice: "1500", buyDate: "2026-04-01", sellQty: "10", avgSellPrice: "1520", sellDate: "2026-04-10",
    ...extra,
  };
  for (const [k, v] of Object.entries(base)) fd.append(k, v);
  return fd;
}

beforeAll(async () => {
  t = await openTempDb("manual-trade-account", { seed: true });
  actions = await import("@/app/trades/actions");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});
afterAll(() => t?.cleanup());

describe("All accounts selected, no accountId in the form", () => {
  it("refuses with code ACCOUNT_REQUIRED and writes nothing", async () => {
    selectAccount(ALL);
    const res = await actions.createManualTrade(PREV, form());
    expect(res.ok).toBe(false);
    // THE assertion: without the catch the refusal has no code, only prose.
    expect(res.code).toBe("ACCOUNT_REQUIRED");
    expect(res.message).toMatch(/choose the account/i);
    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(0);
  });

  it("an ordinary validation failure carries NO code — the two refusals stay distinguishable", async () => {
    selectAccount(ALL);
    const res = await actions.createManualTrade(PREV, form({ buyQty: "0", sellQty: "0" }));
    expect(res.ok).toBe(false);
    expect(res.code).toBeUndefined();
  });
});

describe("the write lands when an account is named or selected", () => {
  it("All accounts selected + accountId in the form → ok, row in that account", async () => {
    selectAccount(ALL);
    const res = await actions.createManualTrade(PREV, form({ accountId: String(SWING) }));
    expect(res.ok).toBe(true);
    expect(res.code).toBeUndefined();
    const rows = t.db.select({ a: t.schema.trades.accountId }).from(t.schema.trades).all();
    expect(rows.map((r) => r.a)).toEqual([SWING]);
  });

  it("an account selected, no accountId → ok", async () => {
    selectAccount(SWING);
    const res = await actions.createManualTrade(PREV, form({ tradingsymbol: "TCS" }));
    expect(res.ok).toBe(true);
  });
});
