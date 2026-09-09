import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { todayIstIso } from "@/lib/domain/trading-day";
// The PURE half — no React, no DB, no `"use client"` — is what the server
// render and the route call (see the module's own header, and
// tests/client-value-imports.test.ts).
import {
  UNKNOWN_SPOT,
  SPOT_SOURCE_LABEL,
  isContractKey,
  resolveSpotRef,
  spotChipLabel,
  type SpotRef,
} from "@/lib/risk/spot-ref";
// The client half: the chip's own door and the body it posts.
import { SPOT_MARK_ENDPOINT, spotMarkPayload, submitSpotMark } from "@/components/risk/spot-mark-editor";
import { SPOT_DOOR_NOTE } from "@/components/risk/expiry-obligations";

// The route revalidates five paths; outside a request there is no store to
// revalidate against (the shape tests/goals.test.ts uses).
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
// The chip's own `useRouter`. `submitSpotMark` takes the refresh as an
// argument, so the assertions below never need a renderer — this only keeps a
// real app-router out of the module graph.
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

/**
 * R7 — the `spot?` chip becomes an inline editor, with an EOD-close fallback.
 *
 * Four facts this file pins, because each of them was wrong or absent:
 *
 *  1. `getLatestCloseMap()` had ZERO callers. Every end-of-day close the
 *     bhavcopy importer had already stored sat unread while the panel printed
 *     "spot?" over an option whose moneyness the book could resolve.
 *  2. A TYPED mark always wins over that close, and the chip says WHICH it is —
 *     an EOD-derived ITM must never read as a number the user typed.
 *  3. The chip writes through the typed-mark door under the UNDERLYING's
 *     symbol, exactly once, and can never send an `OPT `/`FUT ` contract key:
 *     `mtm_prices` is keyed on symbol, so a premium stored there deletes the
 *     cash mark every share position reads (v4.2 contract rules). The route
 *     refuses the same key on its own side of the wire.
 *  4. That write is a ROUTE HANDLER + `fetch` + `router.refresh()`, never a
 *     server action (AGENTS.md). An action revalidates /risk and remounts the
 *     cockpit's client components, silently resetting its open row — which is
 *     why `app/risk/page.tsx` no longer imports `app/equity/actions` at all.
 *
 * Note the module under test imports NO database. That is load-bearing:
 * `components/risk/expiry-obligations.tsx` is imported STATICALLY by two seam
 * files, and a `lib/db` anywhere in that graph binds the connection before
 * `openTempDb()` sets `VYUHA_DB_PATH`.
 */

/* ── the reference price, and where it came from (pure) ──────────────────── */

const typedMap = (o: Record<string, number>) => new Map(Object.entries(o));

describe("resolveSpotRef — typed mark ▸ newest EOD close ▸ unknown", () => {
  it("falls back to the EOD close when nothing has been typed, and says so", () => {
    const ref = resolveSpotRef("RELIANCE", new Map(), typedMap({ RELIANCE: 2950 }));
    expect(ref).toEqual({ value: 2950, source: "eod" });
  });

  it("lets a typed mark win over the EOD close", () => {
    const ref = resolveSpotRef("RELIANCE", typedMap({ RELIANCE: 2900 }), typedMap({ RELIANCE: 2950 }));
    expect(ref).toEqual({ value: 2900, source: "typed" });
  });

  it("stays UNKNOWN with neither — never 0 (invariant 6)", () => {
    expect(resolveSpotRef("INFY", new Map(), new Map())).toEqual(UNKNOWN_SPOT);
    expect(resolveSpotRef("INFY", new Map(), new Map()).value).toBeNull();
  });

  it("treats a stored 0 or a negative as no price at all", () => {
    expect(resolveSpotRef("X", typedMap({ X: 0 }), typedMap({ X: 2950 }))).toEqual({ value: 2950, source: "eod" });
    expect(resolveSpotRef("X", typedMap({ X: -5 }), new Map())).toEqual(UNKNOWN_SPOT);
  });

  it("is case-insensitive on the symbol, like every other mtm reader", () => {
    expect(resolveSpotRef(" reliance ", new Map(), typedMap({ RELIANCE: 2950 })).source).toBe("eod");
  });
});

describe("spotChipLabel — the chip says which number it is showing", () => {
  it("reads exactly 'spot?' when there is nothing to show", () => {
    expect(SPOT_SOURCE_LABEL.none).toBe("spot?");
    expect(spotChipLabel(UNKNOWN_SPOT)).toBe("spot?");
    expect(spotChipLabel({ value: null, source: "eod" })).toBe("spot?");
  });

  it("names the EOD close rather than letting it pass as a typed number", () => {
    expect(spotChipLabel({ value: 2950, source: "eod" })).toContain("EOD close");
    expect(spotChipLabel({ value: 2950, source: "eod" })).not.toContain("typed");
  });

  it("names a typed mark", () => {
    expect(spotChipLabel({ value: 2900.5, source: "typed" })).toBe("₹2,900.50 · typed");
  });
});

/* ── the body: the UNDERLYING and a price, no stops ───────────────────────── */

describe("spotMarkPayload — what reaches the typed-mark route", () => {
  it("is the UNDERLYING's symbol and a price, and nothing else", () => {
    expect(spotMarkPayload("reliance", 2950)).toEqual({ symbol: "RELIANCE", price: 2950 });
    expect(Object.keys(spotMarkPayload("TCS", 3100.25))).toEqual(["symbol", "price"]);
  });

  it("carries no SL, TSL, target or as-of day — a chip must never touch a stop", () => {
    const body = spotMarkPayload("RELIANCE", 2950) as unknown as Record<string, unknown>;
    for (const k of ["sl", "tsl", "target", "asOf", "asOfDate", "prices"]) expect(body[k]).toBeUndefined();
  });

  it("refuses a contract key outright", () => {
    expect(isContractKey("OPT RELIANCE 24 SEP 2026 2800 CE")).toBe(true);
    expect(isContractKey("FUT SBIN 24 SEP 2026")).toBe(true);
    expect(isContractKey("RELIANCE")).toBe(false);
    expect(() => spotMarkPayload("OPT RELIANCE 24 SEP 2026 2800 CE", 40)).toThrow(/contract key/);
    expect(() => spotMarkPayload("FUT SBIN 24 SEP 2026", 1410)).toThrow(/contract key/);
  });

  it("refuses a price that is not one (the day's row would be replaced by it)", () => {
    expect(() => spotMarkPayload("RELIANCE", 0)).toThrow(RangeError);
    expect(() => spotMarkPayload("RELIANCE", -1)).toThrow(RangeError);
    expect(() => spotMarkPayload("RELIANCE", Number.NaN)).toThrow(RangeError);
  });
});

describe("submitSpotMark — a POST to the route, then the refresh", () => {
  const okBody = { ok: true, message: "SBIN spot stored.", updated: 1 };
  const stubFetch = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  afterEach(() => {
    vi.unstubAllGlobals();
    routerRefresh.mockClear();
  });

  it("calls fetch ONCE — POST /api/risk/spot, `{symbol, price}` as JSON — then refreshes", async () => {
    const spy = stubFetch(okBody);
    vi.stubGlobal("fetch", spy);
    const refresh = vi.fn();

    const res = await submitSpotMark("SBIN", 812, refresh);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/risk/spot");
    expect(SPOT_MARK_ENDPOINT).toBe("/api/risk/spot");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ symbol: "SBIN", price: 812 });
    // A route write is only finished when the server re-reads (AGENTS.md).
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, message: "SBIN spot stored.", updated: 1 });
  });

  it("does NOT refresh when the route refused — nothing changed to re-read", async () => {
    const spy = stubFetch({ ok: false, message: "A mark is a price above zero.", updated: 0 }, 400);
    vi.stubGlobal("fetch", spy);
    const refresh = vi.fn();

    const res = await submitSpotMark("SBIN", 812, refresh);

    expect(res.ok).toBe(false);
    expect(res.message).toBe("A mark is a price above zero.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never reaches the network with a contract key", async () => {
    const spy = stubFetch(okBody);
    vi.stubGlobal("fetch", spy);
    const refresh = vi.fn();
    await expect(submitSpotMark("OPT RELIANCE 24 SEP 2026 2800 CE", 40, refresh)).rejects.toThrow(/contract key/);
    expect(spy).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

/* ── the footer names BOTH doors, in plain words ─────────────────────────── */

describe("the panel's footer sentence", () => {
  it("names the chip, the bulk box and the EOD fallback", () => {
    expect(SPOT_DOOR_NOTE).toMatch(/spot chip/);
    expect(SPOT_DOOR_NOTE).toMatch(/bulk-MTM box/);
    expect(SPOT_DOOR_NOTE).toMatch(/end-of-day close/);
    expect(SPOT_DOOR_NOTE).toMatch(/typed mark takes precedence/);
  });

  it("is what the panel renders, and the one-door sentence is gone", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "components", "risk", "expiry-obligations.tsx"),
      "utf8",
    );
    expect(src).toMatch(/\{SPOT_DOOR_NOTE\}/);
    expect(src).not.toMatch(/Enter the underlying spot in the bulk-MTM box below/);
    // The dead badge is gone; the chip took its place.
    expect(src).not.toMatch(/<Badge variant="outline">spot\?<\/Badge>/);
    expect(src).toMatch(/<SpotMarkEditor/);
  });

  it("advises nothing — SEBI copy rules", () => {
    expect(SPOT_DOOR_NOTE).not.toMatch(/\b(recommend|recommended|should|must)\b/i);
    expect(SPOT_DOOR_NOTE).not.toMatch(/\b(buy|sell)\b/i);
  });
});

/* ── the chip is wired to the real component, not a constant nobody calls ── */

describe("the editor component", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "components", "risk", "spot-mark-editor.tsx"),
    "utf8",
  );

  it("renders the label through spotChipLabel and submits through submitSpotMark", () => {
    expect(src).toMatch(/spotChipLabel\(spot\)/);
    expect(src).toMatch(/await submitSpotMark\(symbol, price, \(\) => router\.refresh\(\)\)/);
  });

  it("takes no server action — the door is a fetch to the route (AGENTS.md)", () => {
    expect(src).toMatch(/fetch\(SPOT_MARK_ENDPOINT/);
    expect(src).not.toMatch(/SpotMarkAction/);
    expect(src).not.toMatch(/FormData/);
    expect(src).not.toMatch(/"use server"/);
  });

  it("imports no database, directly or through the action module", () => {
    expect(src).not.toMatch(/@\/lib\/db/);
    expect(src).not.toMatch(/@\/app\/equity\/actions/);
    expect(src).not.toMatch(/@\/lib\/queries\//);
  });

  it("is the ONLY door the page opens: /risk imports no server action for it", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "app", "risk", "page.tsx"), "utf8");
    expect(page).not.toMatch(/@\/app\/equity\/actions/);
    expect(page).not.toMatch(/saveMtmPrices/);
    expect(page).not.toMatch(/saveSpotMark/);
    // …and the panel is still handed the resolved refs it renders.
    expect(page).toMatch(/spotRefs=\{spotRefs\}/);
  });

  it("keeps the pure half OUT of the client module, and re-exports none of it", () => {
    // Every export of a `"use client"` module reaches the server layer as a
    // throwing `registerClientReference` stub, so the server render and the
    // route must read these from lib/risk, and this module must not offer a
    // second way in through a re-export.
    for (const pure of ["UNKNOWN_SPOT", "SPOT_SOURCE_LABEL", "resolveSpotRef", "spotChipLabel", "isContractKey"]) {
      expect(src, `${pure} is still exported by the client module`).not.toMatch(
        new RegExp(`export\\s+(?:const|function|interface|type)\\s+${pure}\\b`),
      );
    }
    expect(src).not.toMatch(/export\s*\{[^}]*\}\s*from\s*["']@\/lib\/risk\/spot-ref["']/);
    expect(src).not.toMatch(/export\s*\*\s*from/);
    expect(src).toMatch(/from "@\/lib\/risk\/spot-ref"/);
  });

  it("the page and the route read the rule from the pure module, not from here", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "app", "risk", "page.tsx"), "utf8");
    const route = fs.readFileSync(path.join(process.cwd(), "app", "api", "risk", "spot", "route.ts"), "utf8");
    const panel = fs.readFileSync(path.join(process.cwd(), "components", "risk", "expiry-obligations.tsx"), "utf8");
    expect(page).toMatch(/import \{ resolveSpotRef, type SpotRef \} from "@\/lib\/risk\/spot-ref"/);
    expect(panel).toMatch(/import \{ UNKNOWN_SPOT, type SpotRef \} from "@\/lib\/risk\/spot-ref"/);
    // The panel may still take the COMPONENT from the client module — that is
    // the one thing a client module is for.
    expect(panel).toMatch(/import \{ SpotMarkEditor \} from "@\/components\/risk\/spot-mark-editor"/);
    // The route's hand-copied contract-key rule is gone; it calls the shared one.
    expect(route).toMatch(/import \{ isContractKey \} from "@\/lib\/risk\/spot-ref"/);
    expect(route).not.toMatch(/const isContractKey =/);
    // …and no server file names the client module for a VALUE.
    for (const [name, s] of [["page", page], ["route", route]] as const) {
      expect(s, `${name} still reaches into the client module`).not.toMatch(
        /import \{[^}]*\b(?:resolveSpotRef|UNKNOWN_SPOT|isContractKey|spotChipLabel|SPOT_SOURCE_LABEL)\b[^}]*\} from "@\/components\/risk\/spot-mark-editor"/,
      );
    }
  });

  it("the pure module is pure — no React, no DB, no `use client` (invariant 2)", () => {
    const pure = fs.readFileSync(path.join(process.cwd(), "lib", "risk", "spot-ref.ts"), "utf8");
    // The DIRECTIVE, not the word — the file's header explains at length why
    // these names left a `"use client"` module.
    expect(pure.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/^\s*["']use client["']/);
    expect(pure).not.toMatch(/from "react"/);
    expect(pure).not.toMatch(/@\/lib\/db/);
    expect(pure).not.toMatch(/@\/lib\/queries\//);
    expect(pure).not.toMatch(/next\/navigation/);
  });

  it("calls no effect at all (AGENTS.md: derive, never set state in one)", () => {
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/useEffect\s*\(/);
    // …and nothing silenced the rule instead of deriving.
    expect(src).not.toMatch(/set-state-in-effect/);
  });
});

/* ── the PAGE resolves it, against a real database ───────────────────────── */

interface Elem {
  type: unknown;
  key: string | null;
  props: Record<string, unknown>;
}
const isElem = (n: unknown): n is Elem =>
  !!n && typeof n === "object" && "props" in (n as object) && typeof (n as Elem).props === "object";

function findElem(node: unknown, pick: (e: Elem) => boolean): Elem | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElem(n, pick);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElem(node)) return null;
  if (pick(node)) return node;
  return findElem(node.props.children, pick);
}

const ACCOUNT = 1;
const iso = (daysFromToday: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
};
const EXPIRY = iso(5);

let t: TempDb;
let panelProps: Record<string, unknown>;
let route: typeof import("@/app/api/risk/spot/route");
let mtm: typeof import("@/lib/queries/mtm");

beforeAll(async () => {
  t = await openTempDb("spot-mark", { seed: true });
  route = await import("@/app/api/risk/spot/route");
  mtm = await import("@/lib/queries/mtm");
  const riskPage = (await import("@/app/risk/page")).default as () => unknown;

  t.db.update(t.schema.settings).set({ selectedAccountId: ACCOUNT }).run();

  const opt = (over: Record<string, unknown>) =>
    tradeRow({
      accountId: ACCOUNT,
      bucket: "active",
      segment: "stock_option",
      instrumentType: "option",
      exchange: "NFO",
      expiry: EXPIRY,
      optionType: "CE",
      sellQty: 0,
      avgSellPrice: 0,
      isOpen: true,
      ...over,
    });

  t.db
    .insert(t.schema.trades)
    .values([
      // EOD CLOSE ONLY — nothing typed. 2950 close vs a 2800 call: the panel
      // can resolve this, and before R7 it printed "spot?".
      opt({
        id: 9001,
        symbol: "RELIANCE",
        tradingsymbol: "OPT RELIANCE 24 SEP 2026 2800 CE",
        strike: 2800,
        buyQty: 500,
        avgBuyPrice: 40,
      }),
      // BOTH — and they disagree on the VERDICT, not just the number: a 3000
      // put is ITM against the typed 2900 and OTM against the 4000 close.
      opt({
        id: 9002,
        symbol: "TCS",
        tradingsymbol: "OPT TCS 24 SEP 2026 3000 PE",
        optionType: "PE",
        strike: 3000,
        buyQty: 175,
        avgBuyPrice: 55,
      }),
      // NEITHER.
      opt({
        id: 9003,
        symbol: "INFY",
        tradingsymbol: "OPT INFY 24 SEP 2026 1500 CE",
        strike: 1500,
        buyQty: 400,
        avgBuyPrice: 22,
      }),
    ])
    .run();

  t.db
    .insert(t.schema.priceHistory)
    .values([
      { symbol: "RELIANCE", date: iso(-1), close: 2950, source: "bhavcopy" },
      { symbol: "RELIANCE", date: iso(-4), close: 2100, source: "bhavcopy" }, // older, must lose
      { symbol: "TCS", date: iso(-1), close: 4000, source: "bhavcopy" },
    ])
    .run();

  // The typed mark for TCS — a CASH row (its tradingsymbol is not `OPT `/`FUT `),
  // which is the only kind `getSpotMap()` reads.
  t.db
    .insert(t.schema.mtmPrices)
    .values({ symbol: "TCS", tradingsymbol: "TCS", price: 2900, asOfDate: iso(0) })
    .run();

  const tree = riskPage();
  const panel = findElem(tree, (e) => typeof e.type === "function" && "summary" in e.props && "spotRefs" in e.props);
  expect(panel, "the risk page no longer renders ExpiryObligations with spotRefs").not.toBeNull();
  panelProps = panel!.props;
});

afterAll(() => t?.cleanup());

const refs = () => panelProps.spotRefs as Record<string, SpotRef>;
const obligation = (id: number) => {
  const summary = panelProps.summary as { obligations: Array<Record<string, unknown>> };
  return summary.obligations.find((o) => o.id === id)!;
};

describe("/risk resolves the option's underlying reference", () => {
  it("with no typed mark, the ref IS the newest EOD close, and the source is 'eod'", () => {
    expect(refs().RELIANCE).toEqual({ value: 2950, source: "eod" });
    // Threaded all the way into the settlement maths: 2950 vs a 2800 call.
    expect(obligation(9001).moneyness).toBe("ITM");
    expect(obligation(9001).intrinsicPerUnit).toBe(150);
  });

  it("with both on record, the typed mark wins — verdict included", () => {
    expect(refs().TCS).toEqual({ value: 2900, source: "typed" });
    // The typed 2900 makes the 3000 put ITM; the 4000 close would call it OTM.
    expect(obligation(9002).moneyness).toBe("ITM");
    expect(obligation(9002).intrinsicPerUnit).toBe(100);
  });

  it("with neither, the chip reads 'spot?' and the obligation stays conditional", () => {
    expect(refs().INFY).toEqual(UNKNOWN_SPOT);
    expect(spotChipLabel(refs().INFY)).toBe("spot?");
    expect(obligation(9003).moneyness).toBe("unknown");
    expect(obligation(9003).settles).toBe("if-ITM");
  });

  it("hands the panel NO server action, and keys the refs on the UNDERLYING", () => {
    // The write is a route + fetch + refresh (AGENTS.md); an action handed down
    // here would remount the cockpit below on every typed spot.
    expect(panelProps.saveSpotMark).toBeUndefined();
    expect("saveSpotMark" in panelProps).toBe(false);
    for (const key of Object.keys(refs())) {
      expect(isContractKey(key), `${key} is a contract key, not an underlying`).toBe(false);
    }
    expect(Object.keys(refs()).sort()).toEqual(["INFY", "RELIANCE", "TCS"]);
  });
});

/* ── the route the chip posts to, against that same database ─────────────── */

const post = (body: unknown) =>
  route.POST(
    new Request("http://local/api/risk/spot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const rowsFor = (symbol: string) =>
  t.db
    .select()
    .from(t.schema.mtmPrices)
    .all()
    .filter((r) => r.symbol === symbol);

describe("POST /api/risk/spot", () => {
  it("writes ONE dated mark for the underlying, readable by getSpotMap()", async () => {
    expect(mtm.getSpotMap().get("SBIN")).toBeUndefined();

    const res = await post({ symbol: "SBIN", price: 812 });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 });
    const rows = rowsFor("SBIN");
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(812);
    // The bulk box's own default — today's IST day, not a UTC one and not a
    // date the chip invented.
    expect(rows[0].asOfDate).toBe(todayIstIso());
    // The panel reads it through the spot map, which is the whole point.
    expect(mtm.getSpotMap().get("SBIN")).toBe(812);
  });

  it("upper-cases the symbol and REPLACES the day's row rather than adding one", async () => {
    const res = await post({ symbol: " sbin ", price: 820.5 });
    expect(res.status).toBe(200);
    expect(rowsFor("SBIN")).toHaveLength(1);
    expect(mtm.getSpotMap().get("SBIN")).toBe(820.5);
  });

  it("refuses an OPT …/FUT … contract key with 400, and writes nothing", async () => {
    const keys = ["OPT SBIN 24 SEP 2026 800 CE", "FUT SBIN 24 SEP 2026"];
    for (const symbol of keys) {
      // The route calls this very function — one rule, both sides of the wire.
      expect(isContractKey(symbol)).toBe(true);
      const res = await post({ symbol, price: 40 });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, updated: 0 });
      expect(rowsFor(symbol)).toHaveLength(0);
    }
    // The cash row that was already there is untouched.
    expect(mtm.getSpotMap().get("SBIN")).toBe(820.5);
  });

  it("refuses a price that is not one with 400, and writes nothing", async () => {
    for (const price of [0, -1, Number.NaN, "abc", null, undefined]) {
      const res = await post({ symbol: "SBIN", price });
      expect(res.status, `price ${String(price)} was accepted`).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, updated: 0 });
    }
    // Still the last good mark — a refused write must not have replaced it.
    expect(rowsFor("SBIN")).toHaveLength(1);
    expect(mtm.getSpotMap().get("SBIN")).toBe(820.5);
  });

  it("refuses an empty symbol with 400", async () => {
    expect((await post({ symbol: "   ", price: 100 })).status).toBe(400);
    expect((await post({ price: 100 })).status).toBe(400);
  });

  it("does not carry a CONTRACT tradingsymbol onto the spot it just wrote", async () => {
    // The bulk-MTM box files the pasted symbol under the first OPEN trade's
    // tradingsymbol, which for an underlying whose only open position is an
    // option is `OPT …` — and getSpotMap() SKIPS such a row. Carrying that key
    // would store the typed spot where the moneyness panel cannot read it, and
    // the chip would appear to do nothing.
    t.db
      .insert(t.schema.mtmPrices)
      .values({ symbol: "HDFCBANK", tradingsymbol: "OPT HDFCBANK 24 SEP 2026 1600 CE", price: 12, asOfDate: todayIstIso() })
      .run();
    expect(mtm.getSpotMap().get("HDFCBANK")).toBeUndefined();

    expect((await post({ symbol: "HDFCBANK", price: 1655 })).status).toBe(200);

    expect(rowsFor("HDFCBANK")).toHaveLength(1);
    expect(mtm.getSpotMap().get("HDFCBANK")).toBe(1655);
  });
});
