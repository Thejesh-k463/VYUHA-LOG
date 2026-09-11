import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

// ─── PURE HALVES, STATICALLY IMPORTED ────────────────────────────────────────
// Nothing here reaches `@/lib/db`: the components are client modules whose graph
// is `lib/format`, `lib/analytics/*`, `lib/domain/*` and `components/ui/*`, and
// the analytics/domain modules are pure by invariant 2. The two DB-bound halves
// (the server page and the route handler) are imported DYNAMICALLY in beforeAll,
// after `openTempDb()` has set VYUHA_DB_PATH.
import { buildStrategies, computeStrategy, type PositionedLeg } from "@/lib/analytics/strategies";
import {
  CATALOGUE,
  STRATEGY_IDS,
  getStrategyDef,
  strategyName,
  type StrategyDef,
} from "@/lib/analytics/strategy-catalogue";
import {
  EM_DASH,
  STRATEGY_COPY,
  UNCAPPED_SUB,
  capNote,
  customName,
  helpHref,
  netTone,
  withholdForFree,
  foldShelfPost,
} from "@/components/strategies/strategy-copy";
import {
  DEFAULT_SHELF,
  initShelfHistory,
  parseShelf,
  serializeShelf,
  shelfReducer,
  type ShelfPostResult,
} from "@/lib/domain/strategy-shelf";
import {
  OPTIONS_HELP,
  OPTIONS_STRATEGY_IDS,
  optionsAnchorId,
  sebiRealityLine,
} from "@/lib/domain/options-help";
import { HELP_ENTRIES, searchHelp } from "@/lib/domain/help-content";
import { SEBI_FNO_FACTS } from "@/lib/analytics/sebi-reality";
import { PRO_FEATURES } from "@/lib/license";
import { signedNumber } from "@/lib/format";
import { mtfDrift } from "@/lib/risk/mtf-drift";
import { StrategyCard } from "@/components/strategies/strategy-card";
import { StrategiesClient } from "@/components/strategies/strategies-client";
import { HelpDesk } from "@/components/system/help-desk";
import { MtfDriftCard } from "@/components/risk/mtf-drift-card";

/**
 * v4.3.0 WAVE 2 — THE SEAMS BETWEEN THE SIX BUILDERS' DISJOINT FILE SETS.
 *
 * Every test below runs BOTH real halves of one crossing: the value is BUILT by
 * the producer's own exported function (never a hand-written literal), handed
 * across exactly as the code hands it (a prop, a JSON body over a real
 * `Request`, a SQLite column, a rendered RSC tree), and the assertion is on the
 * CONSUMER'S OUTPUT — the HTML the card actually emits, the row the route
 * actually stored — not on the value having arrived.
 *
 * The client components are rendered with `react-dom/server`, so "the card
 * prints Not computed" is a fact about the DOM, not about the source text.
 *
 * ┌──────┬────────────────────────────────┬───────────────────────────────────────────────┬────────────────────────────────────────────────┬──────────────┐
 * │ SEAM │ CROSSING VALUE                 │ PRODUCER (file:line)                          │ CONSUMER (file:line)                           │ UNIT         │
 * ├──────┼────────────────────────────────┼───────────────────────────────────────────────┼────────────────────────────────────────────────┼──────────────┤
 * │ S1   │ strategyId / displayName /     │ B1 lib/analytics/strategies.ts:387-390        │ B4 components/strategies/strategy-copy.ts:139  │ id string /  │
 * │      │ legacyFree                     │ (computeStrategy → StrategyGroup)             │ (withholdForFree) → strategy-card.tsx:45       │ display name │
 * │ S2   │ the WITHHELD name, absent from │ B4 strategy-copy.ts:139 (before the payload)  │ B4 app/strategies/page.tsx:86 → rendered HTML  │ serialised   │
 * │      │ the serialised payload         │                                               │                                                │ tree         │
 * │ S3   │ expiries[] / nearestExpiry     │ B1 strategies.ts:299,301                      │ B4 strategy-card.tsx:38,49-51 ("nearest …")    │ ISO date     │
 * │ S4   │ capLabel.maxProfit =           │ B1 strategies.ts:355-356 (label())            │ B4 strategy-copy.ts:191 (capNote) →            │ CapLabel     │
 * │      │ "Computed at underlying = 0"   │                                               │ strategy-card.tsx:152 (title=)                 │              │
 * │ S6   │ notComputed.{maxProfit,maxLoss}│ B1 strategies.ts:352                          │ B4 strategy-card.tsx:151 (— , never Unlimited) │ boolean      │
 * │ S7   │ serializeShelf envelope        │ B2 lib/domain/strategy-shelf.ts:119           │ B3 app/api/strategies/shelf/route.ts:152 → the │ JSON v1      │
 * │      │ {v:1,selected}                 │                                               │ `strategy_shelf_json` column (migration 0071)  │ envelope     │
 * │ S8   │ STRATEGY_IDS as the route's    │ B1 strategy-catalogue.ts:95                   │ B3 route.ts:65,68,91 (400 + store untouched)   │ id string    │
 * │      │ validator                      │                                               │                                                │              │
 * │ S9   │ getEntitlement().pro           │ B3 lib/license.ts:283 (partial: true)         │ B3 route.ts:129 (403, no write, no audit) +    │ boolean      │
 * │      │                                │                                               │ B4 page.tsx:46,104 (locked strip, null picker) │              │
 * │ S10  │ ShelfPostResult (re-read)      │ B3 route.ts:179-183                           │ B4 strategy-copy.ts:158 (foldShelfPost) →      │ ShelfState   │
 * │      │                                │                                               │ strategies-client.tsx:59,109 → rendered tiles  │              │
 * │ S11  │ STRATEGY_IDS (40, in order)    │ B1 strategy-catalogue.ts:95                   │ B5 lib/domain/options-help.ts:71,114           │ id string    │
 * │ S12  │ /help#options-<id>             │ B5 options-help.ts:638 (optionsAnchorId) →    │ B5 components/system/help-desk.tsx:98 (id=) —  │ URL fragment │
 * │      │                                │ B4 strategy-copy.ts:96 (helpHref) → card:59   │ the anchor must EXIST in the rendered desk     │              │
 * │ S13  │ open UL rows for symbols with  │ B4 lib/queries/trades.ts:258 (subquery on     │ B4 page.tsx:69-84 (kind:"UL" legs) →           │ rows,        │
 * │      │ an open option leg             │ openOptionLegWhere(accountId), :215)          │ buildStrategies → the covered/protective card  │ account-      │
 * │      │                                │                                               │                                                │ scoped       │
 * │ S14  │ /strategies is `partial`       │ B3 lib/license.ts:283                         │ B4 page.tsx:46 (getEntitlement, no page gate)  │ boolean      │
 * │ S15  │ sebiRealityLine(SEBI_FNO_FACTS)│ B5 options-help.ts:669                        │ B4 page.tsx:124 AND B5 help-desk.tsx:86        │ %, ₹ lakh    │
 * │ B6   │ signedNumber(v)                │ B6 lib/format.ts:97                           │ B6 components/risk/mtf-drift-card.tsx:69       │ pct points   │
 * └──────┴────────────────────────────────┴───────────────────────────────────────────────┴────────────────────────────────────────────────┴──────────────┘
 *
 * ONE TEMP DATABASE FOR THE FILE (AGENTS.md: one per FILE, never per test) —
 * shared by the route, the query and the server page, which is itself the
 * point: the shelf the route writes is read back by the page that renders it.
 */

// The route revalidates /strategies; outside a request there is no store.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

// `PageHeader` → `BackButton` → `useRouter`, which needs a mounted app router.
// A framework stub, not a half of any seam under test.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    refresh: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  usePathname: () => "/strategies",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
}));

// THE LICENCE IS THE INPUT VARIABLE OF S9/S14, not a mocked seam half: both
// licences are driven through the same real route and the same real page.
const ent = vi.hoisted(() => ({ pro: true }));
vi.mock("@/lib/queries/license", () => ({
  getEntitlement: () => ({
    state: ent.pro ? "trial" : "unlicensed",
    pro: ent.pro,
    payload: null,
    trialDaysLeft: ent.pro ? 7 : 0,
  }),
}));

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

let t: TempDb;
let route: typeof import("@/app/api/strategies/shelf/route");
let page: typeof import("@/app/strategies/page");
let trades: typeof import("@/lib/queries/trades");

const selectAccount = (id: number) =>
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/** The stored column, verbatim — the only place the seam's bytes live. */
const storedShelfJson = (): string | null =>
  t.db.select({ j: t.schema.settings.strategyShelfJson }).from(t.schema.settings).get()?.j ?? null;

const auditCount = (): number =>
  t.db.select({ id: t.schema.auditLog.id }).from(t.schema.auditLog).all().length;

async function post(body: unknown): Promise<{ status: number; json: ShelfPostResult }> {
  const res = await route.POST(
    new Request("http://local/api/strategies/shelf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as ShelfPostResult };
}

/** The server page, rendered for real, as HTML. */
const renderPage = (): string => renderToStaticMarkup(page.default() as React.ReactElement);

/** Text content of a rendered tree — what a reader sees, tags removed. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");

beforeAll(async () => {
  t = await openTempDb("seams-v43-w2", { seed: true });
  route = await import("@/app/api/strategies/shelf/route");
  page = await import("@/app/strategies/page");
  trades = await import("@/lib/queries/trades");

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      // NIFTY — a REAL call calendar: short the near expiry, long the far one
      // (the catalogue's own pattern). Two expiries, so §7 applies.
      tradeRow({ accountId: PRIMARY, symbol: "NIFTY", instrumentType: "option", optionType: "CE", strike: 24000, expiry: "2026-09-24", isOpen: true, sellQty: 75, avgSellPrice: 210 }),
      tradeRow({ accountId: PRIMARY, symbol: "NIFTY", instrumentType: "option", optionType: "CE", strike: 24000, expiry: "2026-10-29", isOpen: true, buyQty: 75, avgBuyPrice: 300 }),
      // INFY — a protective put: an open PE leg plus the open holding (S13).
      tradeRow({ accountId: PRIMARY, symbol: "INFY", instrumentType: "option", optionType: "PE", strike: 1500, expiry: "2026-09-24", isOpen: true, buyQty: 400, avgBuyPrice: 30 }),
      tradeRow({ accountId: PRIMARY, symbol: "INFY", instrumentType: "equity", isOpen: true, buyQty: 400, avgBuyPrice: 1450 }),
      // SBIN — a bull call spread: one of the SIXTEEN names the pre-v4.3
      // if-chain already printed, so a free build must still see it (invariant 7).
      tradeRow({ accountId: PRIMARY, symbol: "SBIN", instrumentType: "option", optionType: "CE", strike: 800, expiry: "2026-09-24", isOpen: true, buyQty: 750, avgBuyPrice: 24 }),
      tradeRow({ accountId: PRIMARY, symbol: "SBIN", instrumentType: "option", optionType: "CE", strike: 850, expiry: "2026-09-24", isOpen: true, sellQty: 750, avgSellPrice: 9 }),
      // TCS — an open holding in THIS book with NO option leg of its own. The
      // option leg on TCS lives in the OTHER book (below): a subquery that
      // forgot its account scope pulls this row into the primary card.
      tradeRow({ accountId: PRIMARY, symbol: "TCS", instrumentType: "equity", isOpen: true, buyQty: 100, avgBuyPrice: 3000 }),
      tradeRow({ accountId: SWING, symbol: "TCS", instrumentType: "option", optionType: "CE", strike: 3200, expiry: "2026-09-24", isOpen: true, sellQty: 150, avgSellPrice: 55 }),
      tradeRow({ accountId: SWING, symbol: "TCS", instrumentType: "equity", isOpen: true, buyQty: 150, avgBuyPrice: 3100 }),
      // BANKNIFTY — the OTHER kind of underlying: an open FUTURE under a short
      // call. `inArray(instrumentType, ["equity","future"])` is the half that
      // makes a covered call on a future readable at all.
      tradeRow({ accountId: PRIMARY, symbol: "BANKNIFTY", instrumentType: "option", optionType: "CE", strike: 54000, expiry: "2026-09-24", isOpen: true, sellQty: 30, avgSellPrice: 400 }),
      tradeRow({ accountId: PRIMARY, symbol: "BANKNIFTY", instrumentType: "future", isOpen: true, buyQty: 30, avgBuyPrice: 53500 }),
    ])
    .run();

  selectAccount(PRIMARY);
});

afterAll(() => t?.cleanup());

afterEach(() => {
  ent.pro = true;
  vi.useRealTimers();
});

/* ═══════════════════════════════════════════════════════════════════════════
   FIXTURES — every leg set is built from the CATALOGUE's own pattern, so a
   pattern nobody can hit is a failure here rather than a shape nobody sees.
   ═══════════════════════════════════════════════════════════════════════════ */

const EXPIRIES = ["2026-09-24", "2026-10-29"];

function legsFor(def: StrategyDef, patternIndex = 0, symbol = "NIFTY"): PositionedLeg[] {
  return def.patterns[patternIndex].legs.map((l, i): PositionedLeg =>
    l.kind === "UL"
      ? { symbol, expiry: null, kind: "UL", strike: 0, side: l.side, qty: 75 * l.qtyRatio, premium: 1000 }
      : {
          symbol,
          expiry: EXPIRIES[l.expiryRank],
          kind: l.kind,
          optionType: l.kind,
          strike: 1000 + 100 * (l.strikeRank as number),
          side: l.side,
          qty: 75 * l.qtyRatio,
          premium: 30 + 4 * i,
        },
  );
}

const ce = (over: Partial<PositionedLeg> = {}): PositionedLeg => ({
  symbol: "NIFTY",
  expiry: "2026-09-24",
  kind: "CE",
  optionType: "CE",
  strike: 24000,
  side: "long",
  qty: 75,
  premium: 100,
  ...over,
});

const pe = (over: Partial<PositionedLeg> = {}): PositionedLeg => ce({ kind: "PE", optionType: "PE", ...over });

const cardHtml = (legs: PositionedLeg[], pro: boolean): string => {
  const [g] = withholdForFree(buildStrategies(legs), pro);
  return renderToStaticMarkup(React.createElement(StrategyCard, { group: g, chart: null }));
};

/**
 * THE SIXTEEN NAMES THE PRE-v4.3 IF-CHAIN PRINTED, quoted from
 * `git show 6198c8b:lib/analytics/strategies.ts` (classifyStrategy) — an
 * INDEPENDENT source, so this is not the catalogue agreeing with itself.
 * Invariant 7: a release may not take a name away, and casing drift silently
 * re-gates a free strategy.
 */
const PRE_V43_FREE_NAMES: Record<string, string> = {
  "long-call": "Long Call",
  "short-call": "Short Call",
  "long-put": "Long Put",
  "short-put": "Short Put",
  "long-straddle": "Long Straddle",
  "short-straddle": "Short Straddle",
  "long-strangle": "Long Strangle",
  "short-strangle": "Short Strangle",
  "bull-call-spread": "Bull Call Spread",
  "bear-call-spread": "Bear Call Spread",
  "bull-put-spread": "Bull Put Spread",
  "bear-put-spread": "Bear Put Spread",
  "long-call-butterfly": "Call Butterfly",
  "long-put-butterfly": "Put Butterfly",
  "iron-butterfly": "Iron Butterfly",
  "iron-condor": "Iron Condor",
};

/** The eight the shelf starts with, pinned by VALUE (B2's list is the other side). */
const PRE_PINNED_DEFAULT_SHELF = [
  "long-call",
  "long-put",
  "bull-call-spread",
  "bear-put-spread",
  "bull-put-spread",
  "bear-call-spread",
  "long-straddle",
  "iron-condor",
];

/** The props a client component receives — i.e. what the RSC payload carries. */
function propsOf(node: React.ReactNode, type: unknown): Record<string, unknown> | null {
  if (!React.isValidElement(node)) return null;
  const el = node as React.ReactElement<Record<string, unknown>>;
  if (el.type === type) return el.props;
  const kids = el.props.children;
  for (const child of Array.isArray(kids) ? kids : [kids]) {
    const hit = propsOf(child as React.ReactNode, type);
    if (hit) return hit;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   S1 / S11 — B1's forty rows, through B4's withholding and B5's registry.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S1 — every catalogue row survives buildStrategies and reaches the card by name", () => {
  it("all 40 rows: pattern → legs → buildStrategies → strategyId is the row's own id", () => {
    for (const def of CATALOGUE) {
      const groups = buildStrategies(legsFor(def));
      expect(groups, def.id).toHaveLength(1);
      expect(groups[0].strategyId, def.id).toBe(def.id);
      expect(groups[0].displayName, def.id).toBe(strategyName(def, def.patterns[0].variant ?? null));
      expect(groups[0].legacyFree, def.id).toBe(def.legacyFree);
    }
  });

  it("a Pro build prints that name in the card's own DOM, for all 40", () => {
    for (const def of CATALOGUE) {
      const html = cardHtml(legsFor(def), true);
      expect(textOf(html), def.id).toContain(strategyName(def, def.patterns[0].variant ?? null));
      expect(html, def.id).not.toContain("Pro — unlock with a licence key");
    }
  });

  it("withholdForFree(groups, true) is the identity on every field but the flag", () => {
    for (const def of CATALOGUE) {
      const [built] = buildStrategies(legsFor(def));
      const [screen] = withholdForFree([built], true);
      expect(screen, def.id).toEqual({ ...built, proWithheld: false });
    }
  });
});

describe("S2 — a free build never ships the withheld name, on the card or in the payload", () => {
  it("the 24 non-legacy rows lose id AND name, and neither survives JSON.stringify", () => {
    for (const def of CATALOGUE.filter((d) => !d.legacyFree)) {
      const [built] = buildStrategies(legsFor(def));
      const [screen] = withholdForFree([built], false);
      const variantName = strategyName(def, def.patterns[0].variant ?? null);

      expect(screen.strategyId, def.id).toBeNull();
      expect(screen.proWithheld, def.id).toBe(true);
      expect(screen.displayName, def.id).toBe(customName(built.legs.length));
      expect(screen.name, def.id).toBe(customName(built.legs.length));

      const wire = JSON.stringify(screen);
      expect(wire, def.id).not.toContain(def.id);
      expect(wire, def.id).not.toContain(def.name);
      expect(wire, def.id).not.toContain(variantName);
    }
  });

  it("legacyFree is EXACTLY the sixteen pre-v4.3 rows, and each name is byte-identical", () => {
    const flagged = CATALOGUE.filter((d) => d.legacyFree).map((d) => d.id).sort();
    expect(flagged).toEqual(Object.keys(PRE_V43_FREE_NAMES).sort());
    for (const [id, name] of Object.entries(PRE_V43_FREE_NAMES)) {
      expect(getStrategyDef(id)!.name, id).toBe(name);
      expect(getStrategyDef(id)!.legacyFree, id).toBe(true);
    }
  });

  it("the 16 legacy-free rows keep their exact name for a free build (invariant 7)", () => {
    for (const def of CATALOGUE.filter((d) => d.legacyFree)) {
      const [built] = buildStrategies(legsFor(def));
      const [screen] = withholdForFree([built], false);
      expect(screen.displayName, def.id).toBe(strategyName(def, def.patterns[0].variant ?? null));
      expect(screen.strategyId, def.id).toBe(def.id);
      expect(screen.proWithheld, def.id).toBe(false);
    }
  });

  it("the withheld card renders Custom (n legs), the Pro lock and the one-line note", () => {
    const ratio = getStrategyDef("call-ratio-spread")!;
    const html = cardHtml(legsFor(ratio), false);
    const text = textOf(html);
    expect(text).toContain(customName(2));
    expect(text).toContain(STRATEGY_COPY.proWithheldNote);
    expect(html).toContain("Pro — unlock with a licence key");
    expect(html).not.toContain("call-ratio-spread");
    expect(text).not.toContain("Call Ratio Spread");
    // The link falls back to the section top — there is no shape to deep-link.
    // Taken from `helpHref` rather than written out, so the card and the
    // fallback are one fact; S12 is where that fragment is proved to EXIST.
    expect(html).toContain(`href="${helpHref(null)}"`);
  });
});

describe("S11 — B1's id list and B5's help registry are one list", () => {
  it("OPTIONS_HELP ids are STRATEGY_IDS, in catalogue order", () => {
    expect(OPTIONS_HELP.map((e) => e.id)).toEqual([...STRATEGY_IDS]);
    expect(OPTIONS_STRATEGY_IDS).toEqual([...STRATEGY_IDS]);
    expect(OPTIONS_HELP).toHaveLength(40);
  });

  it("style and beginner agree row-for-row between the catalogue and the help entry", () => {
    for (const e of OPTIONS_HELP) {
      const def = getStrategyDef(e.id);
      expect(def, e.id).toBeDefined();
      expect(e.style, e.id).toBe(def!.style);
      expect(e.beginner, e.id).toBe(def!.beginner);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S3 / S4 / S6 — B1's expiry and cap seams, asserted on B4's rendered card.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S3/S6 — a two-expiry calendar: nearest expiry, and Not computed is NOT Unlimited", () => {
  const calendar = legsFor(getStrategyDef("call-calendar-spread")!);

  it("B1 reads two expiries, the nearer first, and flags max profit model-dependent", () => {
    const [g] = buildStrategies(calendar);
    expect(g.strategyId).toBe("call-calendar-spread");
    expect(g.expiries).toEqual(["2026-09-24", "2026-10-29"]);
    expect(g.nearestExpiry).toBe("2026-09-24");
    expect(g.expiry).toBeNull();
    expect(g.notComputed.maxProfit).toBe(true);
    // Every far leg is long, so the debit still caps the loss (§7).
    expect(g.notComputed.maxLoss).toBe(false);
    expect(g.capLabel.maxProfit).toBe("Not computed");
  });

  it("B4's card prints the em dash, the §7 sentence and the nearest expiry — and never Unlimited", () => {
    const html = cardHtml(calendar, true);
    const text = textOf(html);
    expect(text).toContain("nearest 2026-09-24");
    expect(text).toContain("|Max profit|" + EM_DASH + "|Not computed|");
    expect(text).not.toContain("Unlimited");
    expect(text).toContain(STRATEGY_COPY.multiExpiryNote);
    expect(html).toContain(STRATEGY_COPY.notComputedNote);
    expect(text).toContain("At nearest expiry");
  });

  it("a multi-expiry group whose upside IS unbounded still prints 'Not computed', never 'Unlimited'", () => {
    // B1's own `computeStrategy`, called the way `buildStrategies` calls it for
    // a whole symbol: a long near call and two long far calls. The slope is
    // positive (maxProfit === null = UNBOUNDED) AND the group spans two
    // expiries (§7 model-dependent). The two statements are different facts and
    // `label()` must resolve the §7 one FIRST — an "Unlimited" tile here would
    // be a forecast the model cannot make.
    const g = computeStrategy("NIFTY", null, [
      ce({ expiry: EXPIRIES[0], strike: 24000, side: "long", qty: 75, premium: 210 }),
      ce({ expiry: EXPIRIES[1], strike: 24000, side: "long", qty: 150, premium: 300 }),
    ]);
    expect(g.expiries).toEqual(EXPIRIES);
    expect(g.maxProfit).toBeNull();
    expect(g.notComputed.maxProfit).toBe(true);
    expect(g.capLabel.maxProfit).toBe("Not computed");

    const html = renderToStaticMarkup(
      React.createElement(StrategyCard, { group: { ...g, proWithheld: false }, chart: null }),
    );
    expect(textOf(html)).toContain("|Max profit|" + EM_DASH + "|Not computed|");
    expect(textOf(html)).not.toContain("|Max profit|Unlimited|");
  });

  it("a group with ONE expiry prints that expiry and no §7 sentence", () => {
    const text = textOf(cardHtml([ce()], true));
    expect(text).toContain("exp 2026-09-24");
    expect(text).not.toContain("nearest 2026-09-24");
    expect(text).not.toContain(STRATEGY_COPY.multiExpiryNote);
  });
});

describe("S4 — the three CapLabels each reach the card as their own sentence", () => {
  it("a long call: maxProfit is null (UNBOUNDED) and the card says Unlimited with no note", () => {
    const [g] = buildStrategies([ce()]);
    expect(g.maxProfit).toBeNull();
    expect(g.capLabel.maxProfit).toBe("Unlimited");
    expect(capNote("Unlimited")).toBeNull();
    const html = cardHtml([ce()], true);
    expect(textOf(html)).toContain("|Max profit|Unlimited|");
    expect(html).not.toContain(STRATEGY_COPY.atZeroNote);
  });

  it("a long put: the floor is labelled 'Computed at underlying = 0' and carries the atZero note", () => {
    const legs = [pe({ strike: 1500, premium: 30, qty: 400 })];
    const [g] = buildStrategies(legs);
    expect(g.strategyId).toBe("long-put");
    expect(g.maxProfit).toBe((1500 - 30) * 400);
    expect(g.capLabel.maxProfit).toBe("Computed at underlying = 0");
    expect(capNote(g.capLabel.maxProfit)).toBe(STRATEGY_COPY.atZeroNote);

    const html = cardHtml(legs, true);
    expect(textOf(html)).toContain("|Max profit|₹5,88,000|Computed at underlying = 0|");
    expect(html).toContain(`title="${STRATEGY_COPY.atZeroNote}"`);
  });

  it("a short call: the loss is unbounded, the profit is the credit, both labelled by B1", () => {
    const legs = [ce({ side: "short", premium: 160 })];
    const [g] = buildStrategies(legs);
    expect(g.capLabel).toEqual({ maxProfit: "At expiry", maxLoss: "Unlimited" });
    const text = textOf(cardHtml(legs, true));
    expect(text).toContain("|Max loss|Unlimited|");
    expect(text).toContain("|Max profit|₹12,000|At expiry|");
  });
});

describe("S1b — netTone reads the CATALOGUE, never the sign of a group holding the underlying", () => {
  it("a covered call is a CREDIT structure even though its netPremium is a large debit", () => {
    const legs = legsFor(getStrategyDef("covered-call")!);
    const [g] = buildStrategies(legs);
    expect(g.strategyId).toBe("covered-call");
    expect(g.netPremium).toBeLessThan(0); // the underlying's entry cash dominates
    expect(g.isCredit).toBe(false);
    expect(netTone(g.strategyId, g.netPremium, g.ulLegs.length > 0)).toBe("credit");
    expect(textOf(cardHtml(legs, true))).toContain("Net credit");
  });

  it("a withheld group has no catalogue row left to ask, so it prints no chip at all", () => {
    const text = textOf(cardHtml(legsFor(getStrategyDef("covered-call")!), false));
    expect(text).not.toContain("Net credit");
    expect(text).not.toContain("Net debit");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S4b / S1c — the four tiles, on the REAL page: B1's figures, B4's headings.
   Every value below is B1's own `computeStrategy` output rendered through B4's
   card; the fixtures are the rows seeded at the top of this file.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S4b — a tile's heading, tone and sub-label follow the FIGURE'S sign", () => {
  it("the married put's minimum payoff is a GAIN, and the card stops calling it a loss", () => {
    // 400 INFY at ₹1,450 under 400 × 1500 PE at ₹30: the worst outcome at
    // expiry is +₹8,000, reached at every price below the strike. B1 puts it in
    // `maxLoss` because that field is the MINIMUM, not because it is a loss.
    selectAccount(PRIMARY);
    const html = renderPage();
    const text = textOf(html);
    expect(text).toContain("Protective Put");
    expect(text).toContain("|Worst case|₹8,000|a gain at every price|");
    expect(text, "a gain printed as a loss").not.toContain("|Max loss|₹8,000|");
    expect(html, "…and printed in loss red").toContain('text-profit">₹8,000');
    expect(html).not.toContain('text-loss">₹8,000');
  });

  it("the same card's unbounded tile prints Unlimited ONCE (defect 4)", () => {
    selectAccount(PRIMARY);
    const text = textOf(renderPage());
    expect(text, "the value repeated as its own sub-label").not.toContain("|Unlimited|Unlimited|");
    expect(text).toContain(`|Max profit|Unlimited|${UNCAPPED_SUB}|`);
  });

  it("the covered call's premium tile is the CE credit alone, the underlying stated beside it", () => {
    // BANKNIFTY: 30 futures at ₹53,500 under a short 54000 CE at ₹400. The
    // chip reads "Net credit" from the catalogue; the tile now agrees with it.
    selectAccount(PRIMARY);
    const text = textOf(renderPage());
    expect(text).toContain("Covered Call");
    expect(text).toContain("|Net premium|+₹12,000|");
    expect(text).toMatch(/Underlying entry .?₹16,05,000 \(read-only\)/);
    // −₹15,93,000 is this position's real MAX LOSS and belongs on its own tile;
    // what it must never be is the number under "Net premium".
    expect(text).toContain("|Max loss|-₹15,93,000|");
    expect(text, "the underlying's entry cash inside a premium").not.toContain(
      "|Net premium|-₹15,93,000|",
    );
  });

  it("a one-leg group counts in English (defect 3)", () => {
    const one = textOf(cardHtml([ce()], true));
    expect(one).toContain("|1 leg|");
    expect(one).not.toContain("1 legs");
    const two = textOf(cardHtml([ce(), ce({ strike: 24500, side: "short", premium: 40 })], true));
    expect(two).toContain("|2 legs|");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S12 — the deep link a card emits must land on an anchor the desk renders.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S12 — every card's 'How this works' href exists as an anchor in the rendered help desk", () => {
  const deskHtml = renderToStaticMarkup(
    React.createElement(HelpDesk, { entries: HELP_ENTRIES, groups: [], options: OPTIONS_HELP }),
  );

  it("all 40: the href the CARD renders is an id the DESK renders", () => {
    for (const def of CATALOGUE) {
      const html = cardHtml(legsFor(def), true);
      const href = /href="(\/help#[^"]+)"/.exec(html)?.[1];
      expect(href, def.id).toBe(`/help#${optionsAnchorId(def.id)}`);
      expect(deskHtml, def.id).toContain(`id="${optionsAnchorId(def.id)}"`);
    }
  });

  it("helpHref falls back to the section top for an unnamed group, and THAT anchor exists too", () => {
    // U-2. This used to assert the href literal `/help#options` and then, on
    // the next line, that the desk rendered `id="options-help"` — two different
    // ids, so the test agreed with itself while the link was dead. The id is
    // now DERIVED from the href the code returns, which is the only form that
    // can fail: a Custom card's link lands where the desk actually has a target.
    const href = helpHref(null);
    const id = href.split("#")[1];
    expect(id, `${href} carries no fragment at all`).toBeTruthy();
    expect(deskHtml, `the desk renders no id="${id}" for ${href}`).toContain(`id="${id}"`);
  });

  it("searchHelp('iron condor') returns the options entry, in the union form the palette reads", () => {
    const hits = searchHelp("iron condor");
    const options = hits.filter((h) => h.kind === "options");
    expect(options.map((h) => h.entry.id)).toContain("iron-condor");
    expect(deskHtml).toContain(`id="${optionsAnchorId("iron-condor")}"`);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S15 — one SEBI sentence, computed by B5, printed on BOTH surfaces.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S15 — the SEBI line is derived on both surfaces and names no host", () => {
  const line = sebiRealityLine(SEBI_FNO_FACTS);

  it("the sentence carries 91.1, the FY2024 note and the loss in lakh", () => {
    expect(line).toContain("91.1%");
    expect(line).toContain("FY2024");
    expect(line).toContain("₹1.2 L");
    expect(line).toContain("Sept 2024");
  });

  it("the rendered /strategies page prints it", () => {
    const text = textOf(renderPage());
    expect(text).toContain("91.1% of them net loss-making in FY2024");
    expect(text).toContain("₹1.2 L per loss-making trader");
  });

  it("the rendered help desk prints the same sentence", () => {
    const text = textOf(
      renderToStaticMarkup(
        React.createElement(HelpDesk, { entries: HELP_ENTRIES, groups: [], options: OPTIONS_HELP }),
      ),
    );
    expect(text).toContain("91.1% of them net loss-making in FY2024");
    expect(text).toContain("₹1.2 L per loss-making trader");
  });

  it("neither surface puts a URL in front of the reader (egress by copy is still egress)", () => {
    expect(textOf(renderPage())).not.toContain("http");
    expect(
      textOf(
        renderToStaticMarkup(
          React.createElement(HelpDesk, { entries: HELP_ENTRIES, groups: [], options: OPTIONS_HELP }),
        ),
      ),
    ).not.toContain("http");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S7 / S8 / S9 / S10 — B2's envelope through B3's route into B4's screen.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S7 — migration 0071's column carries B2's envelope, byte for byte", () => {
  it("the column exists on the migrated database", () => {
    const cols = (t.sqlite.prepare("PRAGMA table_info(settings)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("strategy_shelf_json");
  });

  it("a real POST stores exactly serializeShelf(...) and parseShelf reads back the posted set", async () => {
    const selected = ["jade-lizard", "guts", "box-spread"];
    const { status, json } = await post({ action: "set", selected });

    expect(status).toBe(200);
    expect(storedShelfJson()).toBe(serializeShelf({ selected }));
    expect(parseShelf(storedShelfJson(), STRATEGY_IDS).selected).toEqual(selected);
    expect(json.ok && json.shelf.selected).toEqual(selected);
  });

  it("the empty shelf is a real choice and round-trips as empty, not as the defaults", async () => {
    const { status, json } = await post({ action: "set", selected: [] });
    expect(status).toBe(200);
    expect(json.ok && json.shelf.selected).toEqual([]);
    expect(parseShelf(storedShelfJson(), STRATEGY_IDS).selected).toEqual([]);
    // …and an UNREADABLE column is the defaults, which is the other branch.
    expect(parseShelf("{}", STRATEGY_IDS).selected).toEqual([...DEFAULT_SHELF]);
  });

  it("restore writes the explicit 8-id envelope, not null", async () => {
    const before = auditCount();
    const { status, json } = await post({ action: "restore" });
    expect(status).toBe(200);
    expect(storedShelfJson()).toBe(serializeShelf({ selected: [...DEFAULT_SHELF] }));
    expect(json.ok && json.shelf.selected).toEqual([...DEFAULT_SHELF]);
    expect(auditCount()).toBe(before + 1);
    // Pinned BY VALUE, not against DEFAULT_SHELF: the eight ids and their ORDER
    // are what every untouched install sees, and the strip renders them in it.
    expect(json.ok && json.shelf.selected).toEqual(PRE_PINNED_DEFAULT_SHELF);
    expect([...DEFAULT_SHELF]).toEqual(PRE_PINNED_DEFAULT_SHELF);
    // Every default is a real catalogue id — the shelf can never render a ghost.
    for (const id of DEFAULT_SHELF) expect(STRATEGY_IDS, id).toContain(id);
  });
});

describe("S8 — B1's id list is what the route refuses on, and a refusal stores nothing", () => {
  it("an id outside STRATEGY_IDS is a 400 that names it, with the column and the audit log untouched", async () => {
    const before = storedShelfJson();
    const audits = auditCount();
    const { status, json } = await post({ action: "set", selected: ["long-call", "covered-strangle"] });

    expect(status).toBe(400);
    expect(json.ok).toBe(false);
    expect(!json.ok && json.error).toContain("covered-strangle");
    expect(storedShelfJson()).toBe(before);
    expect(auditCount()).toBe(audits);
  });

  it("a duplicate is refused rather than silently deduped by serializeShelf", async () => {
    const before = storedShelfJson();
    const { status, json } = await post({ action: "set", selected: ["long-call", "long-call"] });
    expect(status).toBe(400);
    expect(!json.ok && json.error).toContain("the shelf is a set");
    expect(storedShelfJson()).toBe(before);
  });

  it("the cap is the catalogue's own length, not a literal", async () => {
    const tooMany = [...STRATEGY_IDS, "long-call"];
    expect(tooMany).toHaveLength(STRATEGY_IDS.length + 1);
    const { status, json } = await post({ action: "set", selected: tooMany });
    expect(status).toBe(400);
    expect(!json.ok && json.error).toContain(`at most ${STRATEGY_IDS.length} strategies`);
  });
});

describe("S9 — one entitlement, both halves: the route refuses and the page locks", () => {
  /**
   * The tail of the shelf tile's remove-button label (`Remove ${name} from the
   * shelf`, `components/strategies/shelf-strip.tsx:43`). One statement of it,
   * used by the positive control and the lapsed-trial negative both.
   */
  const SHELF_REMOVE_TAIL = "from the shelf";

  it("lib/license.ts carries /strategies as a PARTIAL feature (never a whole-page gate)", () => {
    const entry = PRO_FEATURES.find((f) => f.href === "/strategies");
    expect(entry).toBeDefined();
    expect(entry!.partial).toBe(true);
  });

  it("a free build gets 403, writes nothing and records no audit row", async () => {
    await post({ action: "set", selected: ["long-call"] });
    const before = storedShelfJson();
    const audits = auditCount();

    ent.pro = false;
    const { status, json } = await post({ action: "set", selected: ["iron-condor", "guts"] });

    expect(status).toBe(403);
    expect(!json.ok && json.error).toContain("Vyuha Pro");
    expect(storedShelfJson()).toBe(before);
    expect(auditCount()).toBe(audits);
  });

  it("the free PAGE renders the locked strip and ships no picker rows", () => {
    ent.pro = false;
    const html = renderPage();
    const text = textOf(html);
    expect(text).toContain(STRATEGY_COPY.shelfLocked);
    expect(text).not.toContain(STRATEGY_COPY.browseOpen);
    // The 24 sold names are not in the payload at all — not even as picker rows.
    expect(html).not.toContain("Jade Lizard");
    expect(html).not.toContain("jade-lizard");
    expect(html).not.toContain("Protective Put");
    expect(html).not.toContain("Call Calendar Spread");
    // …while the sixteen the journal has always named stay on screen.
    expect(text).toContain("Bull Call Spread");
    expect(text).toContain(customName(2));
  });

  it("the free page's RSC PROPS carry no picker and no withheld name — the payload, not the pixels", () => {
    ent.pro = false;
    const props = propsOf(page.default() as React.ReactElement, StrategiesClient);
    expect(props).not.toBeNull();
    expect(props!.pro).toBe(false);
    expect(props!.picker).toBeNull();

    const wire = JSON.stringify({ groups: props!.groups, picker: props!.picker, shelf: props!.shelf });
    for (const id of ["call-calendar-spread", "protective-put", "jade-lizard"]) {
      expect(wire, id).not.toContain(id);
      expect(wire, id).not.toContain(getStrategyDef(id)!.name);
    }
    expect(wire).toContain("Bull Call Spread");
  });

  it("the Pro page's props DO carry the 40 picker rows", () => {
    const props = propsOf(page.default() as React.ReactElement, StrategiesClient);
    expect(props!.pro).toBe(true);
    expect(props!.picker).toHaveLength(40);
  });

  it("the Pro PAGE names the same structures and offers all 40", () => {
    const text = textOf(renderPage());
    expect(text).toContain("Call Calendar Spread");
    expect(text).toContain("Protective Put");
    expect(text).toContain("Bull Call Spread");
    // C-3: the label and the derived count, ONCE each — "Browse all 40 (40)"
    // contained the bare label too, which is how a substring pin passed it.
    expect(text).toContain(`${STRATEGY_COPY.browseOpen} (${CATALOGUE.length})`);
    expect(text, "the count is printed twice").not.toMatch(/Browse all \d/);
    expect(text).not.toContain(STRATEGY_COPY.shelfLocked);
  });

  /**
   * THE CONTROL FOR THE NEGATIVE BELOW (R4-T-2).
   *
   * The lapsed-trial test proves the locked strip carries no control that could
   * call `run()` by asserting the rendered HTML does NOT contain the tail of the
   * remove button's aria-label (`Remove ${name} from the shelf`,
   * `components/strategies/shelf-strip.tsx:43`). Nothing asserted that string
   * was EVER rendered, so rewording the label — "remove from shelf", "take off
   * the shelf" — would have made the negative pass while the control it stands
   * for had vanished. The string is stated ONCE, here, and asserted in both
   * directions: present on a Pro strip with a tile on it, absent on the locked
   * one. A reworded label now fails HERE, loudly, instead of quietly there.
   */
  it("a Pro strip with a tile on it DOES render the remove control the lapsed strip must not", () => {
    const html = renderToStaticMarkup(
      React.createElement(StrategiesClient, {
        groups: [],
        charts: {},
        shelf: { selected: ["jade-lizard"] },
        picker: CATALOGUE.map((d) => ({ id: d.id, name: d.name, style: d.style, beginner: d.beginner })),
        pro: true,
      }),
    );
    expect(html, "the remove button's label is not the one the negative below looks for").toContain(
      `aria-label="Remove ${getStrategyDef("jade-lizard")!.name} ${SHELF_REMOVE_TAIL}"`,
    );
    expect(html, "the tile the free build must never get is not on the Pro strip either").toContain(
      SHELF_REMOVE_TAIL,
    );
  });

  it("a LAPSED trial on a Pro shelf: locked strip, no Pro name in the props, and nothing that could post", async () => {
    // Every free-build case above starts from a shelf a free build could have
    // built. This one stores a shape only Pro can pick and THEN takes the
    // licence away — which is what an expired trial actually looks like, and
    // the only path on which a withheld NAME is already sitting in the store.
    await post({ action: "set", selected: ["jade-lizard"] });
    ent.pro = false;

    const props = propsOf(page.default() as React.ReactElement, StrategiesClient);
    expect(props!.pro).toBe(false);
    expect(props!.picker).toBeNull();
    // The stored id survives — it is the user's own preference and a lapsed
    // licence does not delete it. What must not cross the wire is the NAME.
    expect(JSON.stringify(props!.shelf)).not.toContain(getStrategyDef("jade-lizard")!.name);

    const html = renderToStaticMarkup(
      React.createElement(
        StrategiesClient,
        props as unknown as React.ComponentProps<typeof StrategiesClient>,
      ),
    );
    const text = textOf(html);
    expect(text).toContain(STRATEGY_COPY.shelfLocked);
    expect(text, "the locked strip lists no names").not.toContain("Jade Lizard");

    // NOTHING ON THIS ISLAND CAN CALL `run()`: the locked strip has no remove
    // control and the picker is not rendered at all, so the 403 below is a
    // refusal the free build can never even trigger from the screen.
    expect(html, "a tile the user could unselect").not.toContain(SHELF_REMOVE_TAIL);
    for (const control of [STRATEGY_COPY.browseOpen, STRATEGY_COPY.restoreDefaults, STRATEGY_COPY.undo]) {
      expect(text, control).not.toContain(control);
    }

    const refused = await post({ action: "set", selected: ["jade-lizard"] });
    expect(refused.status).toBe(403);
  });
});

describe("S10 — the route's re-read is what the strip renders", () => {
  it("POST → ShelfPostResult → foldShelfPost → the tiles the client actually draws", async () => {
    const selected = ["iron-condor", "guts", "long-put"];
    // A STALE local state, which is the whole reason the answer is folded and
    // not assumed (`live-feed-card.tsx:603`): an initialiser does not re-run,
    // so the strip would otherwise go on printing what was there BEFORE the
    // write. The route's re-read is the database; the fold must win.
    const history = initShelfHistory({ selected: ["short-put"] });

    const { json } = await post({ action: "set", selected });
    expect(json.ok).toBe(true);

    const folded = foldShelfPost(history, json);
    expect(folded.present.selected).toEqual(selected);
    expect(folded.present.selected).not.toEqual(history.present.selected);
    // A server echo is not a user action: it must not spend an undo step.
    expect(folded.past).toEqual(history.past);
    expect(shelfReducer(folded, { type: "undo" })).toBe(folded);

    const html = renderToStaticMarkup(
      React.createElement(StrategiesClient, {
        groups: [],
        charts: {},
        shelf: folded.present,
        picker: CATALOGUE.map((d) => ({ id: d.id, name: d.name, style: d.style, beginner: d.beginner })),
        pro: true,
      }),
    );
    const text = textOf(html);
    expect(text).toContain("Iron Condor");
    expect(text).toContain("Guts");
    // Shelf ORDER is a preference too — it survives the round-trip.
    expect(text.indexOf("Iron Condor")).toBeLessThan(text.indexOf("Guts"));
    expect(text.indexOf("Guts")).toBeLessThan(text.indexOf("Long Put"));
    expect(text).not.toContain(STRATEGY_COPY.shelfEmpty);
  });

  it("a refusal folds NOTHING — the state stands", () => {
    const history = initShelfHistory({ selected: ["long-call"] });
    const refusal: ShelfPostResult = { ok: false, error: "no" };
    expect(foldShelfPost(history, refusal)).toBe(history);
  });

  it("the shelf the route stored is the shelf the PAGE renders on the next load", async () => {
    await post({ action: "set", selected: ["short-strangle", "box-spread"] });
    const text = textOf(renderPage());
    expect(text).toContain("Short Strangle");
    expect(text).toContain("Box Spread");
    expect(text.indexOf("Short Strangle")).toBeLessThan(text.indexOf("Box Spread"));
  });

  it("the stored envelope survives the IST day boundary (18:30–24:00 UTC)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T18:45:00.000Z")); // 00:15 IST on the 25th
    const { json } = await post({ action: "set", selected: ["long-straddle"] });
    expect(json.ok && json.updatedAt).toBe("2026-09-24T18:45:00.000Z");
    expect(parseShelf(storedShelfJson(), STRATEGY_IDS).selected).toEqual(["long-straddle"]);
    vi.useRealTimers();

    // The expiry a card prints is a stored DATE, not a clock read: same output.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T18:45:00.000Z"));
    const late = textOf(cardHtml([ce()], true));
    vi.useRealTimers();
    expect(late).toContain("exp 2026-09-24");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S13 — the underlying read, and the half the outer WHERE cannot protect.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S13 — open underlyings, restricted to symbols with an open option leg IN THIS BOOK", () => {
  afterEach(() => selectAccount(PRIMARY));

  it("the primary book gets INFY and the BANKNIFTY FUTURE — TCS's option leg belongs to the OTHER account", () => {
    selectAccount(PRIMARY);
    const rows = trades.getOpenUnderlyingPositions();
    expect(rows.map((r) => r.symbol).sort()).toEqual(["BANKNIFTY", "INFY"]);
    const infy = rows.find((r) => r.symbol === "INFY")!;
    expect(infy.buyQty).toBe(400);
    expect(infy.avgBuyPrice).toBe(1450);
    // A FUTURE is an underlying too — the covered call on it is the reason.
    expect(rows.find((r) => r.symbol === "BANKNIFTY")!.instrumentType).toBe("future");
  });

  it("the swing book gets its own TCS holding and nothing of the primary's", () => {
    selectAccount(SWING);
    const rows = trades.getOpenUnderlyingPositions();
    expect(rows.map((r) => r.symbol)).toEqual(["TCS"]);
    expect(rows[0].buyQty).toBe(150);
  });

  it("the All-accounts view widens BOTH halves of the statement together", () => {
    selectAccount(ALL);
    const rows = trades.getOpenUnderlyingPositions();
    expect(rows.map((r) => r.symbol).sort()).toEqual(["BANKNIFTY", "INFY", "TCS", "TCS"]);
  });

  it("the UL row reaches the page as a kind:'UL' leg and makes the protective put a NAMED shape", () => {
    selectAccount(PRIMARY);
    const text = textOf(renderPage());
    expect(text).toContain("Protective Put");
    expect(text).toContain("400 × underlying");
    expect(text).toContain("@ ₹1,450.00");
    // …and the future under the short call is the covered call (Q4's whole point).
    expect(text).toContain("Covered Call");
    expect(text).toContain("30 × underlying");
    // The primary book's TCS holding has no option leg of its own: no card.
    expect(text).not.toContain("|TCS|");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   B6 — one sign per number, zero unsigned, at a real consumer.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("B6 — signedNumber and the sign site that prints it", () => {
  it("zero stops claiming to be a gain, and null is the em dash", () => {
    expect(signedNumber(0)).toBe("0");
    expect(signedNumber(0, { decimals: 2 })).toBe("0.00");
    expect(signedNumber(null)).toBe(EM_DASH);
    expect(signedNumber(3.5)).toBe("+3.5");
    expect(signedNumber(-3.5)).toBe("-3.5");
  });

  it("a borrowed sign never lets the pair state one fact with two signs", () => {
    // The percentage rounds away; the rupee figure it sits beside is a loss.
    expect(signedNumber(0.004, { from: -1250, decimals: 2 })).toBe("-0.00");
    expect(signedNumber(0, { from: 0 })).toBe("0");
  });

  it("a REAL mtfDrift row prints its own sign in the card's DOM", () => {
    const rows = mtfDrift(
      [
        { id: 1, symbol: "TCS", broker: "dhan", buyValue: 100000, mtfFundedAmount: 75000 },
        { id: 2, symbol: "INFY", broker: "dhan", buyValue: 100000, mtfFundedAmount: 60000 },
      ],
      (_b, symbol) => ({
        pct: symbol === "TCS" ? 32 : 35,
        source: "stock-list",
        asOf: "2026-08-01",
        coverage: "full",
        note: null,
      }),
    );
    expect(rows.map((r) => r.deltaPct)).toEqual([7, -5]);
    const text = textOf(
      renderToStaticMarkup(
        React.createElement(MtfDriftCard, { drift: rows, bundleAsOf: "2026-08-01", stale: false }),
      ),
    );
    expect(text).toContain("+7 pts");
    expect(text).toContain("-5 pts");
    expect(text).not.toContain("+-");
  });
});
