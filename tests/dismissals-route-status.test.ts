import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Second pass, item 4 — /api/dismissals must surface the refusal the query
 * module now returns, instead of discarding it and answering {ok:true}.
 *
 * lib/queries/dismissals.ts refuses the aggregate view (invariant 9) and hands
 * back the `forbidden` marker. The route ignored the return value entirely.
 * Nothing lied to the user today, because the only caller
 * (components/trades/unmarked-holdings-panel.tsx) shows no toast — it just
 * calls router.refresh() — so a refused dismissal simply left the panel up.
 * But a route that drops a refusal on the floor is one UI change away from
 * reporting success for a write that never happened, which is the whole defect
 * class this wave exists to close. Mapping is the house one (/api/bf-losses):
 * 403 for the aggregate-view write ban, 400 for everything else.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/dismissals/route");

const SWING = 2;
const ALL = 0;
const PANEL = "unmarked-holdings";
const FP = "fingerprint-abc123";

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function post(body: unknown): Promise<Response> {
  return route.POST(new Request("http://local/api/dismissals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const rows = () => t.db.select().from(t.schema.panelDismissals).all();

beforeAll(async () => {
  t = await openTempDb("dismissals-route", { seed: true });
  route = await import("@/app/api/dismissals/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("the route stops discarding the refusal", () => {
  it("403s a dismiss from the aggregate view, with the reason in the body", async () => {
    selectAccount(ALL);
    const res = await post({ action: "dismiss", panel: PANEL, fingerprint: FP });

    // THE assertion. Reverting the mapping answers 200 {ok:true} for a write
    // the query module refused to make.
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.forbidden).toBe(true);
    expect(json.message).toMatch(/pick an account in the sidebar/i);
    expect(rows()).toHaveLength(0);
  });

  it("403s a restore from the aggregate view too", async () => {
    selectAccount(ALL);
    expect((await post({ action: "restore" })).status).toBe(403);
    expect((await post({ action: "restore", panel: PANEL })).status).toBe(403);
  });

  it("a malformed body still 400s — the two refusals stay distinguishable", async () => {
    selectAccount(ALL);
    expect((await post({ action: "dismiss", panel: "no-such-panel", fingerprint: FP })).status).toBe(400);
    expect((await post({ action: "sideways" })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
  });
});

describe("the per-account path still answers 200", () => {
  it("dismisses for the selected account and reports ok", async () => {
    selectAccount(SWING);
    const res = await post({ action: "dismiss", panel: PANEL, fingerprint: FP });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(rows().map((r) => r.accountId)).toEqual([SWING]);
  });

  it("restores for the selected account and reports ok", async () => {
    selectAccount(SWING);
    const res = await post({ action: "restore", panel: PANEL });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(rows()).toHaveLength(0);
  });
});
