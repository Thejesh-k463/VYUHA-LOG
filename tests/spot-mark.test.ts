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
  SPOT_CLOSE_DIFF_PANEL,
  closeDiffers,
  isContractKey,
  isIsoDay,
  resolveSpotRef,
  spotChipLabel,
  spotCloseFingerprint,
  spotCloseNotice,
  type DatedPrice,
  type SpotRef,
} from "@/lib/risk/spot-ref";
// The client half: the chip's own door and the body it posts.
import {
  SPOT_KEEP_MARK_ENDPOINT,
  SPOT_MARK_ENDPOINT,
  spotMarkPayload,
  submitKeepMark,
  submitSpotMark,
} from "@/components/risk/spot-mark-editor";
import { SPOT_DOOR_NOTE } from "@/components/risk/expiry-obligations";
// PURE too (no DB, no React): the engine the page feeds the resolved ref into.
import { computeSettlement, DEFAULT_SETTLEMENT_RATES } from "@/lib/analytics/settlement";

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

/** A per-symbol map of DATED prices — both sources carry their own day (R13).
 *  (Was `typedMap` of bare prices; moved deliberately with the new signature.) */
const dated = (o: Record<string, [price: number, asOf: string]>) =>
  new Map<string, DatedPrice>(Object.entries(o).map(([k, [price, asOf]]) => [k, { price, asOf }]));

describe("resolveSpotRef — stored mark ▸ newest EOD close ▸ unknown", () => {
  it("falls back to the EOD close when no mark is stored, and carries the close's day", () => {
    const ref = resolveSpotRef("RELIANCE", new Map(), dated({ RELIANCE: [2950, "2026-09-11"] }));
    expect(ref).toEqual({ value: 2950, source: "eod", asOf: "2026-09-11" });
  });

  it("lets a stored mark win over the EOD close, labelled 'mark' with its own day", () => {
    const ref = resolveSpotRef(
      "RELIANCE",
      dated({ RELIANCE: [2900, "2026-09-14"] }),
      dated({ RELIANCE: [2950, "2026-09-11"] }),
    );
    expect(ref).toEqual({ value: 2900, source: "mark", asOf: "2026-09-14", close: { price: 2950, asOf: "2026-09-11" } });
  });

  it("R13 / ruling 225: an OLDER mark still wins over a NEWER close — labelled 'mark', with its asOf", () => {
    const ref = resolveSpotRef("SBIN", dated({ SBIN: [800, "2026-09-08"] }), dated({ SBIN: [820, "2026-09-11"] }));
    expect(ref.value).toBe(800);
    expect(ref.source).toBe("mark");
    expect(ref.asOf).toBe("2026-09-08");
    // …and the newer close rides along so the row can say it differs.
    expect(ref.close).toEqual({ price: 820, asOf: "2026-09-11" });
  });

  it("stays UNKNOWN with neither — never 0 (invariant 6)", () => {
    expect(resolveSpotRef("INFY", new Map(), new Map())).toEqual(UNKNOWN_SPOT);
    expect(resolveSpotRef("INFY", new Map(), new Map()).value).toBeNull();
  });

  it("treats a stored 0 or a negative as no price at all", () => {
    expect(resolveSpotRef("X", dated({ X: [0, "2026-09-14"] }), dated({ X: [2950, "2026-09-11"] }))).toEqual({
      value: 2950,
      source: "eod",
      asOf: "2026-09-11",
    });
    expect(resolveSpotRef("X", dated({ X: [-5, "2026-09-14"] }), new Map())).toEqual(UNKNOWN_SPOT);
  });

  it("is case-insensitive on the symbol, like every other mtm reader", () => {
    expect(resolveSpotRef(" reliance ", new Map(), dated({ RELIANCE: [2950, "2026-09-11"] })).source).toBe("eod");
  });
});

/* ── R13: does the official close say something the mark does not? ───────── */

describe("closeDiffers — the matrix", () => {
  const mark = (price: number, asOf: string): DatedPrice => ({ price, asOf });
  it.each([
    // N23 (wave 2R), re-pinned deliberately: this row was 800 vs 800 → true, a
    // later close at the SAME price, which printed "differs from your mark ₹800.00"
    // over ₹800.00. It now reads a different price (820); the equal-price case is
    // its own row below and is false (the owner's R13 intent: a DIFFERENT price).
    ["older mark, newer close, different price", mark(800, "2026-09-08"), mark(820, "2026-09-11"), true],
    ["N23: older mark, newer close, equal at the paisa", mark(800, "2026-09-08"), mark(800.004, "2026-09-11"), false],
    ["older mark, newer close, one paisa apart", mark(800, "2026-09-08"), mark(800.01, "2026-09-11"), true],
    ["same day, different price", mark(800, "2026-09-11"), mark(800.05, "2026-09-11"), true],
    ["same day, equal at the paisa", mark(800.001, "2026-09-11"), mark(800.004, "2026-09-11"), false],
    ["newer mark, older close", mark(800, "2026-09-14"), mark(820, "2026-09-11"), false],
    ["newer mark, older close, equal price", mark(800, "2026-09-14"), mark(800, "2026-09-11"), false],
  ] as const)("%s → %s", (_name, m, c, want) => {
    expect(closeDiffers(m, c)).toBe(want);
  });
});

describe("spotCloseNotice — the row's line, and what hides it", () => {
  const older: SpotRef = { value: 800, source: "mark", asOf: "2026-09-08", close: { price: 820.5, asOf: "2026-09-11" } };

  it("states the close, its day and the mark — descriptive, no advice word", () => {
    const n = spotCloseNotice("sbin", older);
    expect(n?.text).toBe("Official close 2026-09-11: ₹820.50 — differs from your mark ₹800.00");
    expect(n?.close).toEqual({ price: 820.5, asOf: "2026-09-11" });
    expect(n?.fingerprint).toBe("SBIN|2026-09-11|82050");
    expect(n?.text).not.toMatch(/\b(recommend|should|must|buy|sell)\b/i);
  });

  it("is null for a newer mark, an EOD ref, a mark with no close, and a kept mark against THIS close", () => {
    expect(spotCloseNotice("SBIN", { ...older, asOf: "2026-09-14" })).toBeNull();
    expect(spotCloseNotice("SBIN", { value: 820.5, source: "eod", asOf: "2026-09-11" })).toBeNull();
    expect(spotCloseNotice("SBIN", { value: 800, source: "mark", asOf: "2026-09-08" })).toBeNull();
    expect(spotCloseNotice("SBIN", older, ["SBIN|2026-09-11|82050"])).toBeNull();
  });

  it("N23: a LATER close at the SAME price says nothing — 'differs from your mark ₹800.00' over ₹800.00 is false", () => {
    // The recheck's reproduction, verbatim.
    const sameLater: SpotRef = { value: 800, source: "mark", asOf: "2026-09-08", close: { price: 800, asOf: "2026-09-11" } };
    expect(spotCloseNotice("SBIN", sameLater)?.text).toBeUndefined();
    // …and the moment the later close differs by a paisa, the line is back.
    const paisaLater: SpotRef = { ...sameLater, close: { price: 800.01, asOf: "2026-09-11" } };
    expect(spotCloseNotice("SBIN", paisaLater)?.text).toBe("Official close 2026-09-11: ₹800.01 — differs from your mark ₹800.00");
  });

  it("comes back when the close moves: a kept fingerprint for an OLDER close hides nothing", () => {
    const moved: SpotRef = { ...older, close: { price: 830, asOf: "2026-09-12" } };
    expect(spotCloseNotice("SBIN", moved, ["SBIN|2026-09-11|82050"])?.fingerprint).toBe("SBIN|2026-09-12|83000");
  });

  it("the fingerprint is per symbol, and the panel is the one the dismissal route files under", () => {
    expect(spotCloseFingerprint(" tcs ", { price: 4000, asOf: "2026-09-11" })).toBe("TCS|2026-09-11|400000");
    expect(SPOT_CLOSE_DIFF_PANEL).toBe("spot-close-diff");
  });
});

/* ── R79: the EOD fallback → an ITM SHORT → the STT figure (pure seam) ──────
 * R7 made the newest end-of-day close resolve moneyness with NOTHING typed, so
 * every written stock option on an underlying with a close on record now
 * reaches the ITM branch of computeSettlement by itself. That seam carried no
 * money assertion, and the branch charged an assigned writer the purchaser's
 * exercise STT (₹75 here) instead of its own delivery STT (₹700) — R77. */
describe("an EOD-resolved ITM short stock option carries the writer's STT (R77/R79)", () => {
  it("no stored mark + a close of 1500 → ITM 1400 CE ×500 → ₹700 delivery STT, in the tile total", () => {
    // Moved to R13's dated signature: the close carries its own day.
    const ref = resolveSpotRef("SBIN", new Map(), dated({ SBIN: [1500, "2026-09-19"] }));
    expect(ref).toEqual({ value: 1500, source: "eod", asOf: "2026-09-19" });
    const s = computeSettlement(
      [
        {
          id: 1,
          symbol: "SBIN",
          tradingsymbol: "OPT SBIN 24 SEP 2026 1400 CE",
          segment: "stock_option",
          optionType: "CE",
          strike: 1400,
          expiry: "2026-09-24",
          netQty: 500,
          side: "short",
          refPrice: ref.value,
        },
      ],
      DEFAULT_SETTLEMENT_RATES,
      "2026-09-20",
    );
    const o = s.obligations[0];
    expect(o.moneyness).toBe("ITM");
    expect(o.settles).toBe("yes");
    // 0.1% × (1400 × 500) — delivery STT on the strike value; no exercise STT,
    // which only the purchaser who exercises pays.
    expect(o.physicalStt).toBe(700);
    expect(o.physicalStt).not.toBe(75);
    expect(s.physicalSttTotal).toBe(700);
  });
});

describe("spotChipLabel — the chip says which number it is showing", () => {
  it("reads exactly 'spot?' when there is nothing to show", () => {
    expect(SPOT_SOURCE_LABEL.none).toBe("spot?");
    expect(spotChipLabel(UNKNOWN_SPOT)).toBe("spot?");
    expect(spotChipLabel({ value: null, source: "eod" })).toBe("spot?");
  });

  it("names the EOD close and its day", () => {
    expect(spotChipLabel({ value: 2950, source: "eod", asOf: "2026-09-11" })).toBe("₹2,950.00 · EOD close · 2026-09-11");
    expect(spotChipLabel({ value: 2950, source: "eod" })).not.toContain("typed");
  });

  it("names a stored mark 'mark' and its day — never 'typed' (R13)", () => {
    expect(spotChipLabel({ value: 2900.5, source: "mark", asOf: "2026-09-14" })).toBe("₹2,900.50 · mark · 2026-09-14");
  });

  it("R13: no source label says 'typed' — the DB cannot tell a typed mark from an automatic one", () => {
    expect(Object.keys(SPOT_SOURCE_LABEL).sort()).toEqual(["eod", "mark", "none"]);
    for (const label of Object.values(SPOT_SOURCE_LABEL)) expect(label).not.toMatch(/typed/i);
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

  it("R13 'Use official close': carries the CLOSE's own day, and only a real calendar day", () => {
    expect(spotMarkPayload("sbin", 820.5, "2026-09-11")).toEqual({ symbol: "SBIN", price: 820.5, asOfDate: "2026-09-11" });
    expect(() => spotMarkPayload("SBIN", 820.5, "2026-02-30")).toThrow(RangeError);
    expect(() => spotMarkPayload("SBIN", 820.5, "11-09-2026")).toThrow(RangeError);
    expect(isIsoDay("2024-02-29")).toBe(true);
    expect(isIsoDay("2026-13-01")).toBe(false);
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

  it("R13 'Use official close' is the SAME door with the close's value and day", async () => {
    const spy = stubFetch(okBody);
    vi.stubGlobal("fetch", spy);
    const refresh = vi.fn();
    await submitSpotMark("SBIN", 820.5, refresh, "2026-09-11");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SPOT_MARK_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({ symbol: "SBIN", price: 820.5, asOfDate: "2026-09-11" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("R13 'Keep my mark' posts the close it was shown to the dismissal route, then refreshes", async () => {
    const spy = stubFetch({ ok: true, message: "kept" });
    vi.stubGlobal("fetch", spy);
    const refresh = vi.fn();
    const res = await submitKeepMark("sbin", { price: 820.5, asOf: "2026-09-11" }, refresh);
    expect(res.ok).toBe(true);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/risk/spot/dismiss");
    expect(SPOT_KEEP_MARK_ENDPOINT).toBe("/api/risk/spot/dismiss");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ symbol: "SBIN", closeAsOf: "2026-09-11", closePrice: 820.5 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("R13 'Keep my mark' does NOT refresh on a refusal (the All-accounts 403)", async () => {
    vi.stubGlobal("fetch", stubFetch({ ok: false, message: "pick an account" }, 403));
    const refresh = vi.fn();
    const res = await submitKeepMark("SBIN", { price: 820.5, asOf: "2026-09-11" }, refresh);
    expect(res).toEqual({ ok: false, message: "pick an account" });
    expect(refresh).not.toHaveBeenCalled();
  });
});

/* ── the footer names BOTH doors, in plain words ─────────────────────────── */

describe("the panel's footer sentence", () => {
  it("names the chip, the bulk box and the EOD fallback", () => {
    expect(SPOT_DOOR_NOTE).toMatch(/spot chip/);
    expect(SPOT_DOOR_NOTE).toMatch(/bulk-MTM box/);
    expect(SPOT_DOOR_NOTE).toMatch(/end-of-day close/);
    // R13, moved deliberately: "typed mark takes precedence" → "stored mark".
    expect(SPOT_DOOR_NOTE).toMatch(/stored mark takes precedence/);
  });

  it("R13: says 'mark', never 'typed' — the DB cannot tell a typed mark from an automatic one", () => {
    expect(SPOT_DOOR_NOTE).not.toMatch(/typed/i);
    expect(SPOT_DOOR_NOTE).toMatch(/newer official close differs from the mark/);
  });

  it("R13: the chip's tooltips say 'typed' nowhere either", () => {
    const editor = fs.readFileSync(path.join(process.cwd(), "components", "risk", "spot-mark-editor.tsx"), "utf8");
    const titles = editor.slice(editor.indexOf("function sourceTitle"), editor.indexOf("export function SpotMarkEditor"));
    expect(titles).toMatch(/return `/);
    expect(titles).not.toMatch(/typed/i);
    expect(titles).not.toMatch(/\b(recommend|should|must|buy|sell)\b/i);
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
    // Re-pinned for R13: the page also reads the dismissal panel name, the
    // panel the notice builder, and the route the day validator — all pure.
    expect(page).toMatch(/import \{ resolveSpotRef, SPOT_CLOSE_DIFF_PANEL, type SpotRef \} from "@\/lib\/risk\/spot-ref"/);
    expect(panel).toMatch(/import \{ UNKNOWN_SPOT, spotCloseNotice, type SpotRef \} from "@\/lib\/risk\/spot-ref"/);
    // The panel may still take the COMPONENT from the client module — that is
    // the one thing a client module is for.
    expect(panel).toMatch(/import \{ SpotMarkEditor \} from "@\/components\/risk\/spot-mark-editor"/);
    // The route's hand-copied contract-key rule is gone; it calls the shared one.
    expect(route).toMatch(/import \{ isContractKey, isIsoDay \} from "@\/lib\/risk\/spot-ref"/);
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

  /**
   * U-2 — Save, Cancel and Escape all unmount the `<Input>` and remount the
   * chip `<button>`. Focus fell to `<body>`: a keyboard user was returned to
   * the top of the document and had to tab the whole obligations table again.
   * Every close path now goes through ONE door that arms a ref-callback
   * restore — no `useEffect`, so the file's no-effect rule above still holds.
   */
  it("U-2 — the chip carries a ref, and closing focuses it back", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    expect(code).toMatch(/<button\r?\n\s*ref=\{attachChip\}/);
    expect(code).toMatch(/const attachChip = \(el: HTMLButtonElement \| null\) =>/);
    expect(code).toMatch(/restoreFocus\.current = false;\r?\n\s*el\.focus\(\);/);
  });

  it("U-2 — Save, Cancel and Escape leave through that ONE door, not by flipping state", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    // Save, on a stored mark.
    expect(code).toMatch(/if \(res\.ok\) \{\r?\n\s*closeEditor\(\);/);
    // Escape, from the input.
    expect(code).toMatch(/if \(e\.key === "Escape"\) closeEditor\(\);/);
    // Cancel.
    expect(code).toMatch(/onClick=\{\(\) => closeEditor\(\)\}[\s\S]{0,80}?Cancel/);
    // Exactly ONE `setEditing(false)` survives, and it is inside closeEditor —
    // a fourth close path added later cannot quietly skip the restore.
    expect(code.match(/setEditing\(false\)/g)).toHaveLength(1);
    expect(code).toMatch(/function closeEditor\(\) \{\r?\n\s*restoreFocus\.current = true;\r?\n\s*setEditing\(false\);/);
  });

  /**
   * R13 (wave 2R) — "Use official close" must post the CLOSE's day. Dropping the
   * 4th argument stored yesterday's close dated TODAY: the chip then read
   * "mark · <today>" for a number that belongs to the close's day, with every
   * other test green (submitSpotMark's own tests call it directly, and the seam
   * B8c too). No renderer is installed (vitest runs `environment: "node"`), so
   * this pins the handler's call — the same shape as Save's pin above — while
   * submitSpotMark's behaviour tests pin that the 4th argument becomes asOfDate.
   */
  it("R13 — 'Use official close' posts the close's value ON the close's day; 'Keep my mark' posts that close", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    const apply = code.slice(code.indexOf("async function applyOfficialClose"), code.indexOf("async function keepMark"));
    const keep = code.slice(code.indexOf("async function keepMark"), code.indexOf("if (!editing)"));
    expect(apply).toMatch(/^async function applyOfficialClose\(close: DatedPrice\)/);
    expect(apply).toMatch(/await submitSpotMark\(symbol, close\.price, \(\) => router\.refresh\(\), close\.asOf\);/);
    expect(keep).toMatch(/^async function keepMark\(close: DatedPrice\)/);
    expect(keep).toMatch(/await submitKeepMark\(symbol, close, \(\) => router\.refresh\(\)\);/);
    // …and each button hands its handler the close the row SHOWED.
    expect(code).toMatch(/onClick=\{\(\) => void applyOfficialClose\(closeNotice\.close\)\}[\s\S]{0,40}?Use official close/);
    expect(code).toMatch(/onClick=\{\(\) => void keepMark\(closeNotice\.close\)\}[\s\S]{0,40}?Keep my mark/);
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
  it("with no stored mark, the ref IS the newest EOD close, and the source is 'eod' with the close's day", () => {
    expect(refs().RELIANCE).toEqual({ value: 2950, source: "eod", asOf: iso(-1) });
    // Threaded all the way into the settlement maths: 2950 vs a 2800 call.
    expect(obligation(9001).moneyness).toBe("ITM");
    expect(obligation(9001).intrinsicPerUnit).toBe(150);
  });

  it("with both on record, the stored mark wins — verdict included", () => {
    // Moved for R13: labelled 'mark' (not 'typed') with its own day, and the
    // older close rides along — a NEWER mark raises no close notice.
    expect(refs().TCS).toEqual({ value: 2900, source: "mark", asOf: iso(0), close: { price: 4000, asOf: iso(-1) } });
    expect(spotCloseNotice("TCS", refs().TCS, panelProps.spotCloseDismissed as string[])).toBeNull();
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

  it("R13: an asOfDate after today (IST), or not a calendar day, is refused with 400 and writes nothing", async () => {
    const tomorrow = new Date(Date.now() + 36 * 3_600_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    for (const asOfDate of [tomorrow, "2099-01-01", "2026-02-30", "14-09-2026", 20260914]) {
      const res = await post({ symbol: "SBIN", price: 999, asOfDate });
      expect(res.status, `asOfDate ${String(asOfDate)} was accepted`).toBe(400);
    }
    expect(rowsFor("SBIN")).toHaveLength(1);
    expect(mtm.getSpotMap().get("SBIN")).toBe(820.5);
  });

  it("R13: a past asOfDate files the mark on THAT day, and the default stays today", async () => {
    const res = await post({ symbol: "WIPRO", price: 250.25, asOfDate: iso(-3) });
    expect(res.status).toBe(200);
    expect(rowsFor("WIPRO").map((r) => [r.asOfDate, r.price])).toEqual([[iso(-3), 250.25]]);
    expect(mtm.getSpotMarkEntries().get("WIPRO")).toEqual({ price: 250.25, asOf: iso(-3) });
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
