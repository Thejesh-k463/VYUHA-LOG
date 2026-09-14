import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { todayIstIso } from "@/lib/domain/trading-day";
// PURE (no DB): the panel renders on the server and reads these values.
import { ExpiryObligations } from "@/components/risk/expiry-obligations";
import { SPOT_CLOSE_DIFF_PANEL, type SpotRef } from "@/lib/risk/spot-ref";

/**
 * R13 — the inline "official close differs" notice on /risk, end to end over
 * ONE real migrated, seeded SQLite file (one temp database per file).
 *
 * The defect: `mtm_prices` cannot tell a typed mark from the bhavcopy auto-MTM
 * or a live-feed mark, yet the chip called every stored row "typed", and a
 * stale automatic mark silently outranked a NEWER official close. The owner's
 * design keeps the mark's priority (ruling 225) and makes the disagreement
 * visible: "Official close <day>: ₹X — differs from your mark ₹Y", with
 * "Use official close" (the same mark door, dated on the close's day) and
 * "Keep my mark" (a per-account, per-symbol `panel_dismissals` row whose
 * fingerprint is the close — a newer close brings the notice back).
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
// SpotMarkEditor calls `useRouter`; a framework stub, not a half of the seam.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/risk",
  useSearchParams: () => new URLSearchParams(),
}));

type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
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

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;
/** A UTC calendar day `n` days from now — always ≤ today in IST for n ≤ 0. */
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const MARK_DAY = day(-4);
const CLOSE_DAY = day(-2);
const NEWER_CLOSE_DAY = day(-1);

let t: TempDb;
let riskPage: () => unknown;
let spotRoute: typeof import("@/app/api/risk/spot/route");
let dismissRoute: typeof import("@/app/api/risk/spot/dismiss/route");

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const dismissals = () => t.db.select().from(t.schema.panelDismissals).all();

const postJson = (fn: (r: Request) => Promise<Response>, url: string, body: unknown) =>
  fn(new Request(`http://local${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const keepMark = (body: unknown) => postJson(dismissRoute.POST, "/api/risk/spot/dismiss", body);
const useClose = (body: unknown) => postJson(spotRoute.POST, "/api/risk/spot", body);

/** The page's panel props and the panel's rendered HTML, as the user would see them. */
function panel() {
  const el = findElem(riskPage(), (e) => e.type === ExpiryObligations);
  if (!el) throw new Error("the risk page no longer renders <ExpiryObligations>");
  const props = el.props as unknown as React.ComponentProps<typeof ExpiryObligations>;
  return { props, html: renderToStaticMarkup(React.createElement(ExpiryObligations, props)) };
}
const sbinRef = () => panel().props.spotRefs?.SBIN as SpotRef;

// HOOK TIME, measured locally 2026-09-14 (three runs): 2388 / 3089 / ~4189 ms
// cold, of which openTempDb is ~0.8–0.9 s and the `app/risk/page` import graph
// ~1.5–2 s — the page IS the seam under test, and tests/spot-mark.test.ts pays
// the same import. No timeout is raised (vitest.config.ts's 30 s hookTimeout).
beforeAll(async () => {
  t = await openTempDb("spot-close-notice", { seed: true });
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  spotRoute = await import("@/app/api/risk/spot/route");
  dismissRoute = await import("@/app/api/risk/spot/dismiss/route");

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
  selectAccount(PRIMARY);

  const sbinCall = (id: number, accountId: number) =>
    tradeRow({
      id,
      accountId,
      bucket: "active",
      segment: "stock_option",
      instrumentType: "option",
      exchange: "NFO",
      symbol: "SBIN",
      tradingsymbol: "OPT SBIN 29 SEP 2026 790 CE",
      optionType: "CE",
      strike: 790,
      expiry: day(6),
      buyQty: 750,
      avgBuyPrice: 12,
      sellQty: 0,
      avgSellPrice: 0,
      isOpen: true,
    });
  // The same position in two books: the mark and the close are market facts
  // (no account column); the "Keep my mark" choice is per book.
  t.db.insert(t.schema.trades).values([sbinCall(97001, PRIMARY), sbinCall(97002, SWING)]).run();

  // An OLDER mark in exactly the shape the bhavcopy auto-MTM writes
  // (lib/import/mtm-bhavcopy.ts: tradingsymbol = symbol) — nothing in the row
  // says whether a person typed it.
  t.db.insert(t.schema.mtmPrices).values({ symbol: "SBIN", tradingsymbol: "SBIN", price: 800, asOfDate: MARK_DAY }).run();
  // …and a NEWER official close that differs.
  t.db.insert(t.schema.priceHistory).values({ symbol: "SBIN", date: CLOSE_DAY, close: 820.5, source: "bhavcopy" }).run();
});

afterAll(() => t?.cleanup());

const NOTICE = `Official close ${CLOSE_DAY}: ₹820.50 — differs from your mark ₹800.00`;

describe("R13 · an older stored mark + a newer differing close", () => {
  it("keeps the mark (ruling 225), labels it 'mark' with its day, and renders the notice on the row", () => {
    const { props, html } = panel();
    const ref = props.spotRefs?.SBIN as SpotRef;
    expect(ref).toEqual({ value: 800, source: "mark", asOf: MARK_DAY, close: { price: 820.5, asOf: CLOSE_DAY } });
    // The settlement still prices on the mark: 800 vs a 790 call.
    const o = props.summary.obligations.find((x) => x.id === 97001);
    expect(o?.intrinsicPerUnit).toBe(10);
    expect(html).toContain(`₹800.00 · mark · ${MARK_DAY}`);
    expect(html).toContain(NOTICE);
    expect(html).not.toMatch(/typed/i);
    expect(props.spotCloseDismissed).toEqual([]);
  });
});

describe("R13 · 'Keep my mark' — POST /api/risk/spot/dismiss", () => {
  it("refuses the All-accounts view with 403 and writes no row (invariant 9)", async () => {
    selectAccount(ALL);
    try {
      const res = await keepMark({ symbol: "SBIN", closeAsOf: CLOSE_DAY, closePrice: 820.5 });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, forbidden: true });
      expect(dismissals()).toHaveLength(0);
    } finally {
      selectAccount(PRIMARY);
    }
  });

  it("refuses a body that names no close with 400, and writes nothing", async () => {
    for (const body of [
      { symbol: "", closeAsOf: CLOSE_DAY, closePrice: 820.5 },
      { symbol: "OPT SBIN 29 SEP 2026 790 CE", closeAsOf: CLOSE_DAY, closePrice: 820.5 },
      { symbol: "SBIN", closeAsOf: "2026-02-30", closePrice: 820.5 },
      { symbol: "SBIN", closeAsOf: CLOSE_DAY, closePrice: 0 },
      { symbol: "SBIN", closeAsOf: CLOSE_DAY },
    ]) {
      expect((await keepMark(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(dismissals()).toHaveLength(0);
  });

  it("files ONE row on the write account, panel 'spot-close-diff', fingerprint SYMBOL|close day|close paise — and the notice is hidden", async () => {
    const res = await keepMark({ symbol: "sbin", closeAsOf: CLOSE_DAY, closePrice: 820.5 });
    expect(res.status).toBe(200);
    expect(dismissals().map((d) => [d.accountId, d.panel, d.fingerprint])).toEqual([
      [PRIMARY, SPOT_CLOSE_DIFF_PANEL, `SBIN|${CLOSE_DAY}|82050`],
    ]);
    const { html, props } = panel();
    expect(props.spotCloseDismissed).toEqual([`SBIN|${CLOSE_DAY}|82050`]);
    expect(html).not.toContain("Official close");
    // The mark is untouched — keeping it wrote no price.
    expect(sbinRef()).toMatchObject({ value: 800, source: "mark", asOf: MARK_DAY });
  });

  it("the dismissal is per ACCOUNT: another book still sees the notice", () => {
    selectAccount(SWING);
    try {
      expect(panel().props.spotCloseDismissed).toEqual([]);
      expect(panel().html).toContain(NOTICE);
    } finally {
      selectAccount(PRIMARY);
    }
  });

  it("a NEWER close row changes the fingerprint, so the notice is back", () => {
    t.db.insert(t.schema.priceHistory).values({ symbol: "SBIN", date: NEWER_CLOSE_DAY, close: 826, source: "bhavcopy" }).run();
    const { html } = panel();
    expect(html).toContain(`Official close ${NEWER_CLOSE_DAY}: ₹826.00 — differs from your mark ₹800.00`);
  });
});

describe("R13 · 'Use official close' — the SAME door, dated on the close's day", () => {
  it("POST /api/risk/spot with the close's value and asOfDate leaves no notice, and the mark is the close", async () => {
    const res = await useClose({ symbol: "SBIN", price: 826, asOfDate: NEWER_CLOSE_DAY });
    expect(res.status).toBe(200);
    const rows = t.db.select().from(t.schema.mtmPrices).all().filter((r) => r.symbol === "SBIN");
    expect(rows.map((r) => [r.asOfDate, r.price]).sort()).toEqual([[MARK_DAY, 800], [NEWER_CLOSE_DAY, 826]].sort());
    const { html } = panel();
    expect(sbinRef()).toEqual({ value: 826, source: "mark", asOf: NEWER_CLOSE_DAY, close: { price: 826, asOf: NEWER_CLOSE_DAY } });
    expect(html).not.toContain("Official close");
    expect(html).toContain(`₹826.00 · mark · ${NEWER_CLOSE_DAY}`);
  });

  it("a mark entered today (no asOfDate) is newer than every close — still no notice", async () => {
    expect((await useClose({ symbol: "SBIN", price: 830 })).status).toBe(200);
    expect(sbinRef()).toMatchObject({ value: 830, source: "mark", asOf: todayIstIso() });
    expect(panel().html).not.toContain("Official close");
  });
});
