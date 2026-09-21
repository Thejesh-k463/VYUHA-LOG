import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// PURE (no DB, no React) — safe to import statically beside openTempDb.
import { inheritedPerTradeCap, isLegacySeedCap, LEGACY_SEED_CAP, resolvePerTradeCap, type CapRow } from "@/lib/risk/limits";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * v4.4.0 D1 — ONE per-trade cap, per segment, and every cap-derived R re-priced
 * when it moves (review verdict D1 REVISE, transition rules applied verbatim).
 *
 * WRONG looks like: two index_option trades in one book, one measured in ₹9,500
 * units and one in ₹5,000 units, averaged into one "Avg R". The cases below are
 * the writers that decide which unit a row is in:
 *
 *   import / re-import / reclassify → 'cap', re-resolved for the CURRENT segment
 *   create                          → 'set' when a risk is typed or SL-derived, else 'cap'
 *   SL writers                      → 'set' ONLY when a stop is in the request (S1)
 *   update                          → 'set' only when the posted risk differs from BOTH
 *                                     the stored value AND the resolved cap (S2)
 *   staged                          → 'frozen' (null with no first-entry stop); un-stage → 'set'
 *   Trash restore                   → classify NULL sources, then re-price the landed rows
 *   the risk editor's save          → cap_scheme 1 on every row + re-price, ONE transaction
 *
 * ONE temp database for the whole file (AGENTS.md Testing); every describe
 * clears `trades` and puts the caps back first. Money is read through the
 * `moneyPaise` columns (rupees) except where the PAISE at rest is the point.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let staged: typeof import("@/lib/queries/staged");
let del: typeof import("@/lib/queries/delete");
let trash: typeof import("@/lib/trash");
let dataFixes: typeof import("@/lib/db/data-fixes");
let riskCap: typeof import("@/lib/queries/risk-cap");
let settingsRoute: typeof import("@/app/api/settings/route");
let positionsRisk: typeof import("@/app/api/positions/risk/route");
let actions: typeof import("@/app/trades/actions");
let acct: number;

// Measured locally 2026-09-18: migrate + seed + the route/commit imports ~1.6 s.
beforeAll(async () => {
  t = await openTempDb("risk-cap", { seed: true });
  commit = await import("@/lib/import/commit");
  staged = await import("@/lib/queries/staged");
  del = await import("@/lib/queries/delete");
  trash = await import("@/lib/trash");
  dataFixes = await import("@/lib/db/data-fixes");
  riskCap = await import("@/lib/queries/risk-cap");
  settingsRoute = await import("@/app/api/settings/route");
  positionsRisk = await import("@/app/api/positions/risk/route");
  actions = await import("@/app/trades/actions");
  acct = t.db.select().from(t.schema.accounts).all()[0]!.id;
  t.db.update(t.schema.settings).set({ selectedAccountId: acct }).run();
}, 60_000);
afterAll(() => t?.cleanup());

// ── helpers ─────────────────────────────────────────────────────────────────

const OPT = (n: number) => `OPT NIFTY 29 Oct 2026 ${25000 + n * 50} CE`;
let seq = 0;

/** The seed's risk_config, reset: global ₹9,500, every other row inheriting (capScheme 1). */
function resetCaps() {
  t.sqlite.prepare("UPDATE risk_config SET per_trade_max_loss = NULL, cap_scheme = 1 WHERE scope <> 'global'").run();
  t.sqlite.prepare("UPDATE risk_config SET per_trade_max_loss = 9500, cap_scheme = 1 WHERE scope = 'global'").run();
}
const setCap = (scope: string, key: string, cap: number | null, capScheme: number | null = 1) =>
  t.sqlite.prepare("UPDATE risk_config SET per_trade_max_loss = ?, cap_scheme = ? WHERE scope = ? AND key = ?").run(cap, capScheme, scope, key);
const capRows = () => riskCap.readCapRows(t.sqlite);
const row = (id: number) => t.db.select().from(t.schema.trades).all().find((r) => r.id === id)!;
const rawRisk = (id: number) =>
  t.sqlite.prepare("SELECT risk_amount_paise AS p, r_multiple AS r, risk_source AS s, net_pnl_paise AS n FROM trades WHERE id = ?").get(id) as {
    p: number | null; r: number | null; s: string | null; n: number;
  };
const r2 = (n: number) => Math.round(n * 100) / 100;

beforeEach(() => {
  t.db.delete(t.schema.tradeLegs).run();
  t.db.delete(t.schema.trades).run();
  resetCaps();
});

/** One broker fill aggregate through the REAL importer (a closed round trip unless `open`). */
function importTrade(sym: string, over: Partial<NormalizedTrade> = {}, open = false): number {
  const n = ++seq;
  const tr = {
    broker: "dhan", tradingsymbol: sym, isin: null,
    buyQty: 75, avgBuyPrice: 200 + n, buyValue: 75 * (200 + n),
    sellQty: open ? 0 : 75, avgSellPrice: open ? 0 : 140 + n, sellValue: open ? 0 : 75 * (140 + n),
    closingPrice: null, grossPnl: open ? 0 : 75 * (140 + n) - 75 * (200 + n), unrealisedPnl: 0,
    buyDate: "2026-09-01", sellDate: open ? null : "2026-09-02",
    productHint: null, exchangeHint: "NSE", sourceFile: null,
    ...over,
  } as NormalizedTrade;
  const res = commit.commitParsedFile({ sourceId: "dhan-api", broker: "dhan", format: "api", trades: [tr], warnings: [] } as never, `risk-cap-${n}.json`, null, acct);
  expect(res.added, "the import added its row").toBe(1);
  return t.db.select().from(t.schema.trades).all().at(-1)!.id;
}

/** A manual trade through commitManualTrade — the Add form's save. */
function manual(sym: string, fields: Record<string, unknown> = {}, open = false): number {
  const n = ++seq;
  const res = commit.commitManualTrade(
    {
      broker: "zerodha", tradingsymbol: sym, isin: null,
      buyQty: 10, avgBuyPrice: 1000 + n, buyValue: 10 * (1000 + n),
      sellQty: open ? 0 : 10, avgSellPrice: open ? 0 : 950 + n, sellValue: open ? 0 : 10 * (950 + n),
      closingPrice: null, grossPnl: open ? 0 : -500, unrealisedPnl: 0,
      buyDate: "2026-09-01", sellDate: open ? null : "2026-09-03",
      productHint: "delivery", exchangeHint: "NSE", sourceFile: "manual",
    } as never,
    fields as never,
    acct,
  );
  return res.id!;
}

const jsonReq = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * The risk editor's save, as the editor posts it: EVERY row, every field, a
 * legacy seed-literal cell blank (components/settings/risk-editor.tsx), with
 * the named caps changed.
 */
async function saveCaps(changes: Record<string, number | null>): Promise<{ ok: boolean; repriced: number }> {
  const rows = t.db.select().from(t.schema.riskConfig).all();
  const body = {
    type: "risk",
    rows: rows.map((r) => {
      const k = `${r.scope}:${r.key}`;
      const cap = k in changes ? changes[k] : isLegacySeedCap(r) ? null : r.perTradeMaxLoss;
      return {
        id: r.id,
        perTradeMaxLoss: cap ?? "",
        maxOpen: r.maxOpen ?? "",
        maxTradesDay: r.maxTradesDay ?? "",
        dailyLossStop: r.dailyLossStop ?? "",
        concentrationPct: r.concentrationPct ?? "",
        monthlyTargetBase: r.monthlyTargetBase ?? "",
        monthlyTargetStretch: r.monthlyTargetStretch ?? "",
      };
    }),
  };
  const res = await settingsRoute.POST(jsonReq("/api/settings", body));
  return (await res.json()) as { ok: boolean; repriced: number };
}

// ── the resolver (pure) ──────────────────────────────────────────────────────

describe("resolvePerTradeCap — ONE rule, global < bucket < segment", () => {
  const rows = (over: Partial<Record<string, [number | null, number | null]>> = {}): CapRow[] =>
    [
      ["global", ""], ["bucket", "active"], ["bucket", "equity"], ["segment", "index_option"], ["segment", "eq_delivery"],
    ].map(([scope, key]) => {
      const [v, s] = over[`${scope}:${key}`] ?? [null, 1];
      return { scope, key, perTradeMaxLoss: v, capScheme: s };
    });

  it("the most specific STATED cap wins; a blank narrower row inherits, never clears", () => {
    const r = rows({ "global:": [9500, 1], "bucket:active": [7000, 1], "segment:index_option": [5000, 1] });
    expect(resolvePerTradeCap(r, "active", "index_option")).toBe(5000);
    expect(resolvePerTradeCap(r, "active", "stock_option")).toBe(7000);
    expect(resolvePerTradeCap(r, "equity", "eq_delivery")).toBe(9500);
    expect(resolvePerTradeCap(r, "", "")).toBe(9500);
  });

  it("the v1–v4.3 seed literal (9500, cap_scheme NULL) on a bucket/segment row reads as UNSET and inherits", () => {
    const r = rows({ "global:": [6000, 1], "segment:index_option": [LEGACY_SEED_CAP, null], "bucket:active": [LEGACY_SEED_CAP, null] });
    expect(resolvePerTradeCap(r, "active", "index_option")).toBe(6000);
    expect(isLegacySeedCap(r[3]!)).toBe(true);
    expect(inheritedPerTradeCap(r, r[3]!, () => "active")).toEqual({ cap: 6000, from: "global" });
    // …but a value the user saved through the editor (cap_scheme 1) means what it says,
    expect(resolvePerTradeCap(rows({ "global:": [6000, 1], "segment:index_option": [9500, 1] }), "active", "index_option")).toBe(9500);
    // …an edited legacy value (anything but the literal) is the user's,
    expect(resolvePerTradeCap(rows({ "global:": [6000, 1], "segment:index_option": [4000, null] }), "active", "index_option")).toBe(4000);
    // …and the GLOBAL row is never legacy: its 9500 is the cap.
    expect(resolvePerTradeCap(rows({ "global:": [9500, null] }), "active", "index_option")).toBe(9500);
  });

  it("nothing stated anywhere → null (no risk, no R — invariant 6), never a literal", () => {
    expect(resolvePerTradeCap(rows(), "active", "index_option")).toBeNull();
    expect(resolvePerTradeCap([], "equity", "eq_delivery")).toBeNull();
  });
});

// ── the importer ─────────────────────────────────────────────────────────────

describe("import — the cap THE resolver gives the row's own segment", () => {
  it("an index_option import takes the index_option cap, not the global row", () => {
    setCap("segment", "index_option", 5000);
    const id = importTrade(OPT(1));
    const r = row(id);
    expect(r.segment).toBe("index_option");
    expect([r.riskAmount, r.riskSource]).toEqual([5000, "cap"]);
    expect(r.rMultiple).toBe(r2(r.netPnl / 5000));
    expect(rawRisk(id).p, "stored as PAISE (invariant 1)").toBe(500000);
  });

  it("a legacy seed literal on the segment row inherits an EDITED global cap", () => {
    setCap("global", "", 6000);
    setCap("segment", "index_option", LEGACY_SEED_CAP, null);
    setCap("bucket", "active", LEGACY_SEED_CAP, null);
    const r = row(importTrade(OPT(2)));
    expect([r.riskAmount, r.riskSource]).toEqual([6000, "cap"]);
  });

  it("no cap configured anywhere → the row stores no risk and no R, and still follows the cap", async () => {
    setCap("global", "", null);
    const id = importTrade(OPT(3));
    expect([row(id).riskAmount, row(id).rMultiple, row(id).riskSource]).toEqual([null, null, "cap"]);
    // The moment one is set, the row is measured in it.
    await saveCaps({ "global:": 8000 });
    expect([row(id).riskAmount, row(id).rMultiple]).toEqual([8000, r2(row(id).netPnl / 8000)]);
  });
});

// ── the risk editor's save ───────────────────────────────────────────────────

describe("a cap edit re-prices every 'cap' row, and nothing else", () => {
  it("'cap' rows move to the new cap in one save; 'set' and staged rows are byte-identical", async () => {
    const capId = importTrade(OPT(4));
    const setId = manual("SETROW", { riskAmount: 4000 });
    const stagedId = manual("STAGEDROW", { slPlanned: 990 }, true);
    expect(staged.convertToStaged(stagedId).ok).toBe(true);
    expect([row(setId).riskSource, row(stagedId).riskSource]).toEqual(["set", "frozen"]);
    const before = JSON.stringify([row(setId), row(stagedId)]);

    const res = await saveCaps({ "segment:index_option": 5000 });
    expect(res.ok).toBe(true);
    expect(res.repriced).toBe(1);
    expect([row(capId).riskAmount, row(capId).rMultiple]).toEqual([5000, r2(row(capId).netPnl / 5000)]);
    expect(JSON.stringify([row(setId), row(stagedId)]), "a typed risk and a frozen staged R never follow the cap").toBe(before);
    // cap_scheme 1 on every posted row: from here on 9500 in any cell is a value the user kept.
    expect(capRows().every((c) => c.capScheme === 1)).toBe(true);
  });

  it("a staged row with no first-entry stop keeps R null — no cap is invented for it", async () => {
    const id = manual("NOSTOP", {}, true);
    expect(row(id).riskSource).toBe("cap");
    expect(staged.convertToStaged(id).ok).toBe(true);
    expect([row(id).riskAmount, row(id).rMultiple, row(id).riskSource]).toEqual([null, null, null]);
    await saveCaps({ "global:": 5000 });
    expect([row(id).riskAmount, row(id).rMultiple, row(id).riskSource]).toEqual([null, null, null]);
  });

  it("R is rounded in JS with the writers' formula (−0.125 → −0.12), never SQL ROUND (−0.13)", async () => {
    const id = t.db.insert(t.schema.trades).values(tradeRow({ accountId: acct, netPnl: -625, riskAmount: 9500, rMultiple: -0.07, riskSource: "cap" })).returning({ id: t.schema.trades.id }).get()!.id;
    await saveCaps({ "global:": 5000 });
    expect(rawRisk(id)).toMatchObject({ p: 500000, r: -0.12, s: "cap" });
  });
});

// ── the update rule (review D1, revised) ─────────────────────────────────────

describe("update — 'set' only when the posted risk differs from BOTH the stored value AND the resolved cap", () => {
  it("re-posting the stored figure, or typing exactly the cap, keeps a 'cap' row following the cap", () => {
    const id = importTrade(OPT(5));
    expect(commit.updateManualTrade(id, { riskAmount: 9500 }).ok).toBe(true);
    expect(row(id).riskSource).toBe("cap");
    expect(commit.updateManualTrade(id, { riskAmount: 4000 }).ok).toBe(true);
    expect([row(id).riskAmount, row(id).riskSource]).toEqual([4000, "set"]);
    // a 'set' row whose user types exactly today's cap hands it back to the cap
    expect(commit.updateManualTrade(id, { riskAmount: 9500 }).ok).toBe(true);
    expect([row(id).riskAmount, row(id).riskSource]).toEqual([9500, "cap"]);
  });

  it("a posted null clears risk, source and R together", () => {
    const id = importTrade(OPT(6));
    expect(commit.updateManualTrade(id, { riskAmount: null }).ok).toBe(true);
    expect([row(id).riskAmount, row(id).riskSource, row(id).rMultiple]).toEqual([null, null, null]);
  });

  it("S2 — the edit dialog opened BEFORE a cap edit and saved after it does not freeze the old cap as the user's", async () => {
    const id = importTrade(OPT(7));
    const opened = row(id);
    expect(opened.riskAmount).toBe(9500);
    // The dialog's FormData, prefilled at open (edit-trade-dialog.tsx): the risk
    // field AND the hidden riskAmountOpened carry the value it opened with.
    const fd = new FormData();
    const put = (k: string, v: unknown) => fd.append(k, v == null ? "" : String(v));
    put("tradeId", opened.id);
    put("buyQty", opened.buyQty); put("avgBuyPrice", opened.avgBuyPrice); put("buyDate", opened.buyDate);
    put("sellQty", opened.sellQty); put("avgSellPrice", opened.avgSellPrice); put("sellDate", opened.sellDate);
    put("slPlanned", opened.slPlanned); put("trailingSl", opened.trailingSl); put("targetPlanned", opened.targetPlanned);
    put("riskAmount", opened.riskAmount); put("riskAmountOpened", opened.riskAmount);
    put("setupTag", opened.setupTag); put("exitTrigger", opened.exitTrigger); put("notes", "saved after the cap moved");

    await saveCaps({ "segment:index_option": 5000 }); // re-priced while the dialog was open
    expect(row(id).riskAmount).toBe(5000);

    const res = await actions.updateTradeAction({ ok: false, message: "" }, fd);
    expect(res.ok, res.message).toBe(true);
    expect([row(id).riskAmount, row(id).riskSource, row(id).rMultiple]).toEqual([5000, "cap", r2(row(id).netPnl / 5000)]);
  });
});

// ── the two SL writers (review S1) ───────────────────────────────────────────

describe("SL writers stamp 'set' ONLY when a stop is in the request", () => {
  it("S1 — a price mark with no stop (both shapes the app sends) leaves a 'cap' row following the cap", async () => {
    const id = importTrade("RELIANCE", { productHint: "delivery" }, true);
    expect(row(id).riskSource).toBe("cap");
    // The unmarked-holdings panel: only a price.
    let res = await positionsRisk.POST(jsonReq("/api/positions/risk", { tradeId: id, mtmPrice: 2500 }));
    expect(res.status).toBe(200);
    // The risk dialog: all five fields, the stop blank.
    res = await positionsRisk.POST(jsonReq("/api/positions/risk", { tradeId: id, originalSl: "", trailingSl: "", target: "", impliedVol: "", mtmPrice: 2510 }));
    expect(res.status).toBe(200);
    expect([row(id).riskAmount, row(id).riskSource]).toEqual([9500, "cap"]);
    await saveCaps({ "global:": 5000 });
    expect(row(id).riskAmount, "it moved with every other cap row").toBe(5000);
  });

  it("a stop in the request makes the stop-derived risk the user's ('set')", async () => {
    const id = importTrade("TATAMOTORS", { productHint: "delivery" }, true);
    const entry = row(id).avgBuyPrice;
    const res = await positionsRisk.POST(jsonReq("/api/positions/risk", { tradeId: id, originalSl: entry - 10, trailingSl: "", target: "", impliedVol: "" }));
    expect(res.status).toBe(200);
    expect([row(id).riskAmount, row(id).riskSource]).toEqual([750, "set"]);
    await saveCaps({ "global:": 5000 });
    expect(row(id).riskAmount, "a planned stop never follows the cap").toBe(750);
  });
});

// ── the other writers ────────────────────────────────────────────────────────

describe("create, reclassify, close, un-stage", () => {
  it("create: a typed or SL-derived risk is 'set'; neither → the segment's cap as 'cap'", () => {
    setCap("segment", "eq_delivery", 3000);
    expect([row(manual("TYPED", { riskAmount: 1234 })).riskSource, row(manual("TYPED2", { riskAmount: 1234 })).riskAmount]).toEqual(["set", 1234]);
    const sl = row(manual("SLROW", { slPlanned: 990 }));
    expect([sl.riskSource, sl.riskAmount]).toEqual(["set", r2(Math.abs(sl.avgBuyPrice - 990) * 10)]);
    const cap = row(manual("CAPROW"));
    expect([cap.segment, cap.riskAmount, cap.riskSource]).toEqual(["eq_delivery", 3000, "cap"]);
  });

  it("reclassify: a 'cap' row re-resolves for its NEW segment (it used to keep the old denominator)", () => {
    setCap("segment", "eq_intraday", 2000);
    const id = manual("RECLASS");
    expect(row(id).riskAmount).toBe(9500);
    expect(commit.applyOverride(id, { segment: "eq_intraday" })).toBe(true);
    expect([row(id).segment, row(id).riskAmount, row(id).riskSource, row(id).rMultiple]).toEqual(["eq_intraday", 2000, "cap", r2(row(id).netPnl / 2000)]);
  });

  it("close: a 'cap' row re-reads today's cap on the close it is priced by", () => {
    const id = importTrade("INFY", { productHint: "delivery" }, true);
    setCap("global", "", 4000); // raw, no re-price: the close itself must not use the stale 9,500
    expect(commit.closePosition(id, row(id).avgBuyPrice + 5, "2026-09-10").ok).toBe(true);
    expect([row(id).riskAmount, row(id).riskSource, row(id).rMultiple]).toEqual([4000, "cap", r2(row(id).netPnl / 4000)]);
  });

  it("un-stage (the last leg deleted): the risk the ladder left is the plain trade's own — 'set'", () => {
    const id = manual("UNSTAGE", { slPlanned: 980 }, true);
    expect(staged.convertToStaged(id).ok).toBe(true);
    expect(row(id).riskSource).toBe("frozen");
    const legs = t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === id);
    expect(legs).toHaveLength(1);
    expect(staged.deleteLeg(legs[0]!.id).ok).toBe(true);
    const after = row(id);
    expect(after.riskAmount, "the first-entry stop's risk survives the un-stage").not.toBeNull();
    expect([after.staged, after.riskSource]).toEqual([false, "set"]);
  });
});

// ── Trash restore and the data fix — the SAME classifier ─────────────────────

describe("Trash restore re-prices what lands, after classifying a pre-0073 row", () => {
  const trashDir = () => path.join(path.dirname(t.dbPath), "trash");

  it("a 'cap' row trashed under ₹9,500 comes back in TODAY's cap", async () => {
    const id = importTrade(OPT(8));
    const d = del.deleteTradesByIds([id], "risk-cap test", "test");
    expect(d.ok).toBe(true);
    await saveCaps({ "segment:index_option": 5000 });
    const res = trash.restoreTrashSnapshot(d.snapshotId!, "test");
    expect(res.restored).toBe(1);
    expect([row(id).riskAmount, row(id).riskSource, row(id).rMultiple]).toEqual([5000, "cap", r2(row(id).netPnl / 5000)]);
  });

  it("a row from a pre-0073 envelope (no riskSource at all) is classified, then re-priced", async () => {
    const id = importTrade(OPT(9));
    const d = del.deleteTradesByIds([id], "risk-cap test", "test");
    const file = path.join(trashDir(), d.snapshotId!, "snapshot.json");
    expect(fs.existsSync(file), `the envelope is at ${file}`).toBe(true);
    const env = JSON.parse(fs.readFileSync(file, "utf8")) as { trades: Record<string, unknown>[] };
    for (const r of env.trades) delete r.riskSource;
    fs.writeFileSync(file, JSON.stringify(env));
    await saveCaps({ "segment:index_option": 5000 });
    expect(trash.restoreTrashSnapshot(d.snapshotId!, "test").restored).toBe(1);
    expect([row(id).riskSource, row(id).riskAmount]).toEqual(["cap", 5000]);
  });
});

describe("data fix risk-source-v1 — classify, then re-price; PAISE at rest", () => {
  const insert = (over: Record<string, unknown>) =>
    t.db.insert(t.schema.trades).values(tradeRow({ accountId: acct, isOpen: false, ...over })).returning({ id: t.schema.trades.id }).get()!.id;
  const rerun = () => {
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(dataFixes.RISK_SOURCE_FIX);
    return dataFixes.runDataFixes(t.sqlite).find((f) => f.name === dataFixes.RISK_SOURCE_FIX);
  };

  it("staged → frozen; a risk tied to its own stop → set; ₹9,500 or the global cap → cap; anything else → set", () => {
    setCap("global", "", 7000);
    const ids = {
      staged: insert({ staged: true, riskAmount: 9500, netPnl: -950 }),
      plan: insert({ buyQty: 100, avgBuyPrice: 100, slPlanned: 95, riskAmount: 500, netPnl: -250 }),
      seedCap: insert({ riskAmount: 9500, netPnl: -950, rMultiple: -0.1 }),
      globalCap: insert({ riskAmount: 7000, netPnl: -700, rMultiple: -0.1 }),
      typed: insert({ riskAmount: 1234, netPnl: -617, rMultiple: -0.5 }),
      none: insert({ netPnl: 10 }),
    };
    // What 0073 leaves: NULL on every row.
    t.sqlite.prepare("UPDATE trades SET risk_source = NULL").run();
    const res = rerun();
    expect(res?.applied).toBe(true);
    const got = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, rawRisk(id)]));
    expect(got.staged).toMatchObject({ s: "frozen", p: 950000 });
    expect(got.plan).toMatchObject({ s: "set", p: 50000 });
    // The two cap rows follow the CURRENT resolver (global 7,000) — in paise, R in JS.
    expect(got.seedCap).toMatchObject({ s: "cap", p: 700000, r: r2(-950 / 7000) });
    expect(got.globalCap).toMatchObject({ s: "cap", p: 700000, r: -0.1 });
    expect(got.typed).toMatchObject({ s: "set", p: 123400, r: -0.5 });
    expect(got.none).toMatchObject({ s: null, p: null });

    // Idempotent: a second run moves nothing.
    const snapshot = JSON.stringify(Object.values(ids).map(rawRisk));
    expect(rerun()?.rekeyed).toBe(0);
    expect(JSON.stringify(Object.values(ids).map(rawRisk))).toBe(snapshot);
  });
});
