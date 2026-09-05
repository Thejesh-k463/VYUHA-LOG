import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { LIVE_DESK_RANGES } from "@/components/sizing/lab-config";

/**
 * /api/risk/live-desk — the Sizing Lab's write-back (owner Q36).
 *
 * Three properties, and only three, because they are the ones that can be
 * wrong silently:
 *
 *   1. a valid POST actually lands the migration-0064 columns on the
 *      `scope:'global'` risk_config row (a route that answers {ok:true} while
 *      writing nothing is the failure mode the dismissals route had);
 *   2. every out-of-range value is a 400 that names the field — ppm columns
 *      have no defence of their own, so a 0.0001% risk or a 900% deploy cap
 *      would otherwise be stored and then multiplied into every size;
 *   3. a cross-origin POST is a 403 and writes nothing.
 *
 * One temp database for the FILE (the helper caches its connection on
 * globalThis); the route is imported after `openTempDb` has set VYUHA_DB_PATH,
 * which is why the import is dynamic.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/risk/live-desk/route");

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return route.POST(
    new Request("http://localhost:3000/api/risk/live-desk", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost:3000", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function globalRow() {
  return t.db
    .select()
    .from(t.schema.riskConfig)
    .all()
    .find((r) => r.scope === "global" && r.key === "")!;
}

const VALID = {
  riskPctPpm: 2500,
  deployCapPpm: 250_000,
  stopMethod: "atr",
  stopAtrLen: 21,
  stopAtrMultPermille: 2000,
  stopDefaultPctPpm: null,
  heatCeilingPpm: 60_000,
};

beforeAll(async () => {
  t = await openTempDb("sizing-lab-route", { seed: true });
  route = await import("@/app/api/risk/live-desk/route");
});

afterAll(() => t?.cleanup());

describe("the write actually lands", () => {
  it("seeds with risk_pct_ppm null — the column means 'not chosen' (migration 0064)", () => {
    const row = globalRow();
    expect(row.riskPctPpm).toBeNull();
    expect(row.stopMethod).toBeNull();
    // The one column with a NOT NULL DEFAULT: the deploy cap is on from row one.
    expect(row.deployCapPpm).toBe(250_000);
  });

  it("POSTs the seven Live Desk columns onto the scope:'global' row", async () => {
    const res = await post({ ...VALID, riskPctPpm: 4000, stopAtrMultPermille: 2500 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const row = globalRow();
    expect(row.riskPctPpm).toBe(4000);
    expect(row.stopMethod).toBe("atr");
    expect(row.stopAtrLen).toBe(21);
    expect(row.stopAtrMultPermille).toBe(2500);
    expect(row.deployCapPpm).toBe(250_000);
    expect(row.heatCeilingPpm).toBe(60_000);
    // The dialog renders old → new from this payload, so the before-image has
    // to be the value that was on the row, not the value just written.
    expect(json.before.riskPctPpm).toBeNull();
    expect(json.after.riskPctPpm).toBe(4000);
  });

  it("audits the change, with a symmetric before/after snapshot", () => {
    const entries = t.db.select().from(t.schema.auditLog).all().filter((a) => a.entity === "risk_config");
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(last.action).toBe("update");
    expect(Object.keys(last.beforeJson as object).sort()).toEqual(
      Object.keys(last.afterJson as object).sort(),
    );
  });

  it("leaves the ₹ per-trade rule and the other scopes alone", () => {
    expect(globalRow().perTradeMaxLoss).toBe(9500);
    const bucket = t.db.select().from(t.schema.riskConfig).all().find((r) => r.key === "equity")!;
    expect(bucket.riskPctPpm).toBeNull();
  });
});

describe("out-of-range is a 400 that names the field, and writes nothing", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["risk below the slider floor", { riskPctPpm: LIVE_DESK_RANGES.riskPctPpm.min - 1 }],
    ["risk above the slider ceiling", { riskPctPpm: LIVE_DESK_RANGES.riskPctPpm.max + 1 }],
    ["deploy cap below 5%", { deployCapPpm: LIVE_DESK_RANGES.deployCapPpm.min - 1 }],
    ["deploy cap above 100%", { deployCapPpm: LIVE_DESK_RANGES.deployCapPpm.max + 1 }],
    ["ATR length below 5", { stopAtrLen: 4 }],
    ["ATR length above 100", { stopAtrLen: 101 }],
    ["ATR multiple below 0.5 N", { stopAtrMultPermille: 499 }],
    ["ATR multiple above 5 N", { stopAtrMultPermille: 5001 }],
    ["a fractional ppm", { riskPctPpm: 2500.5 }],
    ["a percentage sent as a float instead of ppm", { riskPctPpm: 0.025 }],
    ["an unknown stop method", { stopMethod: "vibes" }],
  ];

  for (const [name, over] of cases) {
    it(`400s on ${name}`, async () => {
      const beforeRow = { ...globalRow() };
      const res = await post({ ...VALID, ...over });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(typeof json.message).toBe("string");
      expect(json.message.length).toBeGreaterThan(0);
      // Nothing moved.
      const afterRow = globalRow();
      expect(afterRow.riskPctPpm).toBe(beforeRow.riskPctPpm);
      expect(afterRow.deployCapPpm).toBe(beforeRow.deployCapPpm);
      expect(afterRow.stopAtrLen).toBe(beforeRow.stopAtrLen);
      expect(afterRow.stopAtrMultPermille).toBe(beforeRow.stopAtrMultPermille);
      expect(afterRow.stopMethod).toBe(beforeRow.stopMethod);
    });
  }

  it("a malformed body is a 400 too", async () => {
    const res = await route.POST(
      new Request("http://localhost:3000/api/risk/live-desk", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost:3000" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("the origin guard", () => {
  it("403s a cross-origin POST and writes nothing", async () => {
    const before = { ...globalRow() };
    const res = await post(
      { ...VALID, riskPctPpm: 12_345 },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
    expect(globalRow().riskPctPpm).toBe(before.riskPctPpm);
  });

  it("403s on a foreign Origin even without sec-fetch-site", async () => {
    const res = await post({ ...VALID }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("still accepts the app itself — same-origin fetches send no Origin header", async () => {
    const res = await post({ ...VALID, riskPctPpm: 3000 }, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(globalRow().riskPctPpm).toBe(3000);
  });

  it("accepts the desktop shell's tauri.localhost origin", async () => {
    const res = await post({ ...VALID, riskPctPpm: 3500 }, { origin: "http://tauri.localhost" });
    expect(res.status).toBe(200);
    expect(globalRow().riskPctPpm).toBe(3500);
  });
});
