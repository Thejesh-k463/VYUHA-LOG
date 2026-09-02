import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * WS2 pre-req fix (v3.6), completed in v3.7 — capital resolution is
 * ACCOUNT-FIRST everywhere.
 *
 * The performance page computed its capital base as
 * `(settings?.equityCapital ?? 0) + (settings?.activeCapital ?? 0)` — the
 * GLOBAL settings row — while every trade on the page is scoped to the
 * selected account. With two accounts, the second account's Sharpe, total
 * return and Monte Carlo all divided by the FIRST account's capital, and
 * nothing on screen looked broken (the invariant-8 failure shape, applied to
 * the denominator instead of the rows).
 *
 * v3.6 fixed that ONE page. Eight sibling sites kept the global read, so a
 * multi-account book showed one account's goal beside another's capital base —
 * including the dashboard, where the "Total ₹XL" tile sat three lines from an
 * already-account-scoped goal badge. v3.7 switched all eight.
 *
 * `getBucketCapital()` — now in its own module `lib/queries/bucket-capital.ts`,
 * re-exported by `lib/queries/capital.ts` — owns the one copy of the
 * `account ?? settings ?? 0` chain. It had to move: `capital.ts` imports
 * `./trades` and `./ipos`, and neither the pre-trade limit path nor the cash
 * ledger may inherit that graph.
 *
 * This file proves three things:
 *  1. the helper resolves account-first against a real migrated database,
 *  2. all NINE sites actually use it (source checks — reverting any one of them
 *     to the settings-row read reddens here even though the maths would still
 *     be "correct" on any base), and
 *  3. the two sites that ARE callable without React — the cash ledger and the
 *     pre-trade limits check — return the selected account's figure against a
 *     real database, including when the settings row is zeroed.
 */

let t: TempDb;
let capital: typeof import("@/lib/queries/capital");
let ledger: typeof import("@/lib/queries/ledger");
let limits: typeof import("@/lib/queries/limits");

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

beforeAll(async () => {
  t = await openTempDb("capital-first", { seed: true });
  capital = await import("@/lib/queries/capital");
  ledger = await import("@/lib/queries/ledger");
  limits = await import("@/lib/queries/limits");
  // Global (legacy) settings figures, distinct from every account figure so a
  // wrong fallback is unmistakable in the assertions.
  t.db.update(t.schema.settings).set({ equityCapital: 111111, activeCapital: 22222 }).run();
  // Account 1 (seeded) carries NO capital of its own -> settings fallback.
  // Account 2 carries its own -> the account figure must win.
  t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", equityCapital: 500000, activeCapital: 70000 }).run();
});

afterAll(() => t?.cleanup());

describe("getBucketCapital resolves account-first", () => {
  it("uses the selected account's own capital when it has one", () => {
    selectAccount(2);
    const c = capital.getBucketCapital();
    expect(c.equityCapital).toBe(500000);
    expect(c.activeCapital).toBe(70000);
    expect(c.totalCapital).toBe(570000);
  });

  it("falls back to the settings figures only when the account carries none", () => {
    selectAccount(1);
    const c = capital.getBucketCapital();
    expect(c.equityCapital).toBe(111111);
    expect(c.activeCapital).toBe(22222);
    expect(c.totalCapital).toBe(133333);
  });

  it("the aggregate view falls back to settings (no single account to ask)", () => {
    selectAccount(0);
    const c = capital.getBucketCapital();
    expect(c.totalCapital).toBe(133333);
  });

  it("capital unknown stays 0 — never an invented base (invariant 6)", () => {
    selectAccount(1);
    t.db.update(t.schema.settings).set({ equityCapital: 0, activeCapital: 0 }).run();
    const c = capital.getBucketCapital();
    expect(c.totalCapital).toBe(0); // page renders "—" + nudge on this
    t.db.update(t.schema.settings).set({ equityCapital: 111111, activeCapital: 22222 }).run();
  });

  it("agrees with getCapitalSummary (which now delegates to it)", () => {
    selectAccount(2);
    const s = capital.getCapitalSummary();
    expect(s.equityCapital).toBe(500000);
    expect(s.activeCapital).toBe(70000);
    expect(s.totalCapital).toBe(570000);
  });
});

describe("the performance page reads capital through the helper", () => {
  const src = readFileSync(path.join(process.cwd(), "app/reports/performance/page.tsx"), "utf8");

  it("derives its base from getBucketCapital, not the raw settings row", () => {
    expect(src).toMatch(/getBucketCapital\(\)\.totalCapital/);
  });

  it("no longer sums the global settings capital columns (red-on-revert)", () => {
    expect(src).not.toMatch(/settings\?\.equityCapital\s*\?\?\s*0\)\s*\+\s*\(settings\?\.activeCapital/);
  });
});

/* ------------------------------------------------------------------------- *
 * v3.7 — the eight sibling sites.
 *
 * A source check, like tests/capital-fallback-guard.ts, and for the same
 * reason: the bug class is "the maths is right, the base is the wrong
 * account's". No assertion about the OUTPUT can see it — every figure on the
 * page is internally consistent with the base it was handed. What must be
 * pinned is WHERE the base comes from.
 *
 * Two negatives per file, so a revert cannot slip through by renaming:
 *  A. no `??` fallback applied to a bucket-capital column at the call site —
 *     the `account ?? settings ?? 0` chain lives in the helper and nowhere
 *     else, so every historical revert shape (`settings?.equityCapital ?? 0`,
 *     `s?.activeCapital ?? 0`, the summed pair) reddens here; and
 *  B. no read of those columns off a settings-row receiver at all.
 * ------------------------------------------------------------------------- */

// Comments legitimately NAME the old expressions ("the old settings?.equityCapital
// read"), so strip them before matching — same stripper family, and same MIME
// caveat, as tests/capital-fallback-guard.test.ts.
const stripComments = (src: string) =>
  src
    .replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** A `??` fallback hung off a bucket-capital column — the chain leaked out of the helper. */
const CALLSITE_FALLBACK_CHAIN = /(equityCapital|activeCapital)\s*(\?\?|\|\|)/;
/** The global settings row read for a capital base, whatever the local is called. */
const SETTINGS_ROW_CAPITAL_READ = /(^|[^.\w])(s|settings)\s*\??\.\s*(equityCapital|activeCapital)/m;

const SITES: Array<{ file: string; feeds: string; positive: RegExp }> = [
  {
    file: "app/equity/page.tsx",
    feeds: "TrackerClient available/deployed % and per-position concentration",
    positive: /getBucketCapital\(\)\.equityCapital/,
  },
  {
    file: "app/active/page.tsx",
    feeds: "TrackerClient available/deployed % for the F&O bucket",
    positive: /getBucketCapital\(\)\.activeCapital/,
  },
  {
    file: "app/risk/page.tsx",
    feeds: "the capital nudge, estimateMargin utilisation and cockpit exposure/allocation",
    positive: /=\s*getBucketCapital\(\)/,
  },
  {
    file: "app/reports/monthly/page.tsx",
    feeds: "computePerformance — total return %, max drawdown %, Sharpe, Sortino, CAGR",
    positive: /getBucketCapital\(\)\.totalCapital/,
  },
  {
    file: "app/targets/equity/page.tsx",
    feeds: "top-position concentration and PositionSizeCalc risk sizing",
    positive: /getBucketCapital\(\)\.equityCapital/,
  },
  {
    file: "lib/queries/ledger.ts",
    feeds: "/cash opening balances and the capital-configured label",
    positive: /getBucketCapital\(\)/,
  },
  {
    file: "lib/queries/limits.ts",
    feeds: "getPortfolioState().capital — the pre-trade concentration limit check",
    positive: /getBucketCapital\(\)/,
  },
  {
    file: "app/page.tsx",
    feeds: 'the dashboard "Total ₹XL" tile, beside its account-scoped goal badge',
    positive: /getBucketCapital\(\)/,
  },
];

describe("all eight v3.7 sibling sites resolve capital account-first", () => {
  for (const site of SITES) {
    describe(site.file, () => {
      const src = stripComments(readFileSync(path.join(process.cwd(), site.file), "utf8"));

      it(`resolves its base through getBucketCapital (feeds: ${site.feeds})`, () => {
        expect(src).toMatch(site.positive);
      });

      it("does not re-implement the fallback chain at the call site (red-on-revert)", () => {
        expect(src).not.toMatch(CALLSITE_FALLBACK_CHAIN);
      });

      it("does not read the global settings capital columns (red-on-revert)", () => {
        expect(src).not.toMatch(SETTINGS_ROW_CAPITAL_READ);
      });
    });
  }

  it("the helper lives in its own module so limits/ledger skip the trades graph", () => {
    const helper = readFileSync(path.join(process.cwd(), "lib/queries/bucket-capital.ts"), "utf8");
    // Whatever else it grows, it must not reach for trades/ipos: lib/queries/limits.ts
    // is the pre-trade path and lib/queries/ledger.ts is /cash.
    expect(helper).not.toMatch(/from\s+"\.\/(trades|ipos|capital)"/);
    // …and capital.ts must keep re-exporting it, or a dozen importers break.
    const cap = readFileSync(path.join(process.cwd(), "lib/queries/capital.ts"), "utf8");
    expect(cap).toMatch(/export\s*\{\s*getBucketCapital\s*\}/);
  });
});

/**
 * The two sites callable without a React render — proved against the real
 * migrated database, not the source text. Account 2 carries 500000/70000; the
 * settings row carries 111111/22222.
 */
describe("cash openings and the pre-trade limit base follow the selected account", () => {
  it("/cash opens on THIS account's capital, not the settings row", () => {
    selectAccount(2);
    expect(ledger.getOpeningByBucketPaise()).toEqual({ equity: 50000000, active: 7000000 });
    selectAccount(1);
    expect(ledger.getOpeningByBucketPaise()).toEqual({ equity: 11111100, active: 2222200 });
  });

  it("the pre-trade concentration base is THIS account's capital", () => {
    selectAccount(2);
    expect(limits.getPortfolioState("equity", "TCS").capital).toBe(500000);
    expect(limits.getPortfolioState("active", "TCS").capital).toBe(70000);
    expect(limits.getPortfolioState("", "TCS").capital).toBe(570000);
    selectAccount(1);
    expect(limits.getPortfolioState("equity", "TCS").capital).toBe(111111);
  });

  it("a zeroed settings row cannot blank an account that has its own capital", () => {
    selectAccount(2);
    t.db.update(t.schema.settings).set({ equityCapital: 0, activeCapital: 0 }).run();
    try {
      // If any of these still read the settings row, they read 0 here — which
      // is exactly the "capital not configured" state, so /cash would relabel
      // its balances as flows-only and the concentration rule would be skipped
      // for an account that HAS capital.
      expect(capital.getBucketCapital().equityCapital).toBe(500000);
      expect(ledger.getOpeningByBucketPaise().equity).toBe(50000000);
      expect(ledger.getCapitalConfigured()).toEqual({ equity: true, active: true, any: true });
      expect(limits.getPortfolioState("equity", "TCS").capital).toBe(500000);
    } finally {
      t.db.update(t.schema.settings).set({ equityCapital: 111111, activeCapital: 22222 }).run();
    }
  });

  it("0 still means NOT CONFIGURED when neither account nor settings has one", () => {
    selectAccount(1); // account 1 carries no capital of its own
    t.db.update(t.schema.settings).set({ equityCapital: 0, activeCapital: 0 }).run();
    try {
      expect(ledger.getOpeningByBucketPaise()).toEqual({ equity: 0, active: 0 });
      expect(ledger.getCapitalConfigured()).toEqual({ equity: false, active: false, any: false });
      // The limit check reports the concentration rule "skipped" on a 0 base —
      // it never divides by an invented one (invariant 6).
      expect(limits.getPortfolioState("equity", "TCS").capital).toBe(0);
    } finally {
      t.db.update(t.schema.settings).set({ equityCapital: 111111, activeCapital: 22222 }).run();
    }
  });
});
