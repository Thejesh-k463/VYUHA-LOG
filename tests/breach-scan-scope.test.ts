import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// The banner is a client component with no database in its import graph (React,
// lucide, the button, and `Breach` as a type only), so a static import here
// cannot bind `lib/db` before `openTempDb()` sets VYUHA_DB_PATH.
import { BreachBanner, lastNotifiedKey, markNotified } from "@/components/risk/breach-banner";
import type { Breach } from "@/lib/risk/alerts";

/**
 * OWNER RULING (2026-09-08, v4.2 fix wave 4) — WHO the breach banner speaks for.
 *
 * `scanBreaches()` in lib/jobs/auto-mtm.ts selects every open trade in the
 * database with no `account_id` filter at all. That is right for the EOD
 * auto-MTM job, which prices EVERY account from one bhavcopy and must report on
 * every account it just marked. It is wrong for the two page banners
 * (app/page.tsx and app/risk/page.tsx), which sit on account-scoped pages: with
 * the "Personal" account selected, the dashboard raised a stop breach naming a
 * symbol that is not in the book on screen — invariant 8's exact failure mode,
 * and nothing on screen looks broken.
 *
 * THE RULING, as implemented:
 *   • the banners call `scanBreachesForSelectedAccount()` → `getSelectedAccountId()`,
 *     applying the house rule `accountId > 0 ? filter : all`, so 0 ("All
 *     accounts") is every account exactly as it is for every other read;
 *   • the EOD job's `breaches` keeps `scanBreaches()` — every account, because
 *     it just marked every account. Its call site is unchanged.
 *
 * WHY A DATABASE: the behaviour under test IS the WHERE clause. A pure test of
 * `detectBreaches` cannot see it, and would only agree with itself.
 *
 * ONE temp database for the FILE (`lib/db` caches its connection on
 * `globalThis`), and everything server-only is imported DYNAMICALLY after
 * `openTempDb` has set `VYUHA_DB_PATH`.
 */

let t: TempDb;
let job: typeof import("@/lib/jobs/auto-mtm");
let riskPage: () => unknown;
let dashboardPage: () => unknown;

const PERSONAL = 1;
const SWING = 2;
const ALL = 0;

/** One open position per account, each already through its own target. */
const PERSONAL_ID = 951;
const SWING_ID = 952;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** Every `props[key]` in a React element tree (the pages are never rendered). */
function collectProps(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const n of node) collectProps(n, key, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props) {
    if (key in props) out.push(props[key]);
    collectProps(props.children, key, out);
  }
  return out;
}

/** The `breaches` prop the page hands `<BreachBanner>`. */
function bannerBreaches(page: () => unknown): Array<{ id: number; symbol: string }> {
  const found = collectProps(page(), "breaches").find((b) => Array.isArray(b));
  expect(found, "no <BreachBanner breaches={…}> in the rendered element tree").toBeDefined();
  return found as Array<{ id: number; symbol: string }>;
}

/** The `<BreachBanner>` element itself, found by IDENTITY — so "the props the
 *  banner is given" cannot be satisfied by some other component that happens to
 *  carry a prop of the same name. */
function findByType(node: unknown, type: unknown): { props: Record<string, unknown> } | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findByType(n, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type && el.props) return { props: el.props };
  return el.props ? findByType(el.props.children, type) : undefined;
}

function bannerElement(page: () => unknown): { props: Record<string, unknown> } {
  const found = findByType(page(), BreachBanner);
  expect(found, "no <BreachBanner> in the rendered element tree").toBeDefined();
  return found!;
}

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id).sort((a, b) => a - b);

beforeAll(async () => {
  t = await openTempDb("breach-scan-scope", { seed: true });
  job = await import("@/lib/jobs/auto-mtm");
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  dashboardPage = (await import("@/app/page")).default as () => unknown;

  t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, activeCapital: 1_000_000 }).run();
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      // Account 1 — TCS through its target on its own recorded close.
      tradeRow({
        id: PERSONAL_ID,
        accountId: PERSONAL,
        symbol: "TCS",
        tradingsymbol: "TCS",
        instrumentType: "equity",
        buyQty: 10,
        sellQty: 0,
        avgBuyPrice: 2000,
        closingPrice: 2100,
        targetPlanned: 2050,
        isOpen: true,
      }),
      // Account 2 — INFY, likewise. A different symbol, so a leak is legible.
      tradeRow({
        id: SWING_ID,
        accountId: SWING,
        symbol: "INFY",
        tradingsymbol: "INFY",
        instrumentType: "equity",
        buyQty: 10,
        sellQty: 0,
        avgBuyPrice: 1500,
        closingPrice: 1600,
        targetPlanned: 1550,
        isOpen: true,
      }),
    ])
    .run();
});

afterAll(() => t?.cleanup());

describe("the breach BANNERS are account-scoped (invariant 8)", () => {
  it("a floor: both positions really do breach, so an empty result cannot pass for the right reason", () => {
    expect(ids(job.scanBreaches())).toEqual([PERSONAL_ID, SWING_ID]);
  });

  it("with Personal selected, the scan returns Personal's breach and NOT Swing's", () => {
    selectAccount(PERSONAL);
    const rows = job.scanBreachesForSelectedAccount();
    expect(ids(rows)).toEqual([PERSONAL_ID]);
    expect(rows.map((r) => r.symbol)).not.toContain("INFY");
  });

  it("with Swing selected, the other book's breach is the one that disappears", () => {
    selectAccount(SWING);
    const rows = job.scanBreachesForSelectedAccount();
    expect(ids(rows)).toEqual([SWING_ID]);
    expect(rows.map((r) => r.symbol)).not.toContain("TCS");
  });

  it("0 is the All-accounts VIEW, so it shows both — the same rule every other read applies", () => {
    selectAccount(ALL);
    expect(ids(job.scanBreachesForSelectedAccount())).toEqual([PERSONAL_ID, SWING_ID]);
  });
});

describe("both page banners are fed the scoped scan", () => {
  it("/risk hands <BreachBanner> only the selected account's breaches", () => {
    selectAccount(PERSONAL);
    const rows = bannerBreaches(riskPage);
    expect(ids(rows)).toEqual([PERSONAL_ID]);
    selectAccount(SWING);
    expect(ids(bannerBreaches(riskPage))).toEqual([SWING_ID]);
  });

  it("the dashboard does the same", () => {
    selectAccount(PERSONAL);
    expect(ids(bannerBreaches(dashboardPage))).toEqual([PERSONAL_ID]);
    selectAccount(SWING);
    expect(ids(bannerBreaches(dashboardPage))).toEqual([SWING_ID]);
  });
});

describe("the EOD auto-MTM job still reports every account it marked", () => {
  it("scanBreaches() ignores the selection entirely, on either setting", () => {
    selectAccount(PERSONAL);
    expect(ids(job.scanBreaches())).toEqual([PERSONAL_ID, SWING_ID]);
    selectAccount(SWING);
    expect(ids(job.scanBreaches())).toEqual([PERSONAL_ID, SWING_ID]);
  });

  it("an explicit scope of null is the whole database, and account 0 is too", () => {
    selectAccount(PERSONAL);
    expect(ids(job.scanBreaches({ accountId: null }))).toEqual([PERSONAL_ID, SWING_ID]);
    expect(ids(job.scanBreaches({ accountId: 0 }))).toEqual([PERSONAL_ID, SWING_ID]);
    expect(ids(job.scanBreaches({ accountId: SWING }))).toEqual([SWING_ID]);
  });

  it("the EOD call site is the UNSCOPED one — the job prices every account, so it reports on every account", () => {
    const src = fs.readFileSync("lib/jobs/auto-mtm.ts", "utf8");
    expect(src).toContain("breaches: scanBreaches()");
    expect(src).not.toContain("breaches: scanBreachesForSelectedAccount()");
  });
});

/**
 * U-2 (owner ruling 2026-09-08, round 5) — THE OPT-IN DESKTOP NOTIFICATION
 * FIRED AGAIN ON EVERY ACCOUNT SWITCH.
 *
 * Scoping the banners (the ruling above) changed what the `breaches` prop
 * holds from "the whole database" to "this account". The banner's dedup did
 * not move with it: it hashed `id:kind:level` with no account anywhere and
 * stored that hash under ONE localStorage key. Personal → Swing → Personal is
 * three different sets against one record, so a user who had opted in was
 * re-notified about breaches they had already been shown, every time they
 * changed account — the notification's whole promise ("same set twice =
 * silent") only ever held while there was one set.
 *
 * THE FIX: the banner is TOLD which account it speaks for — both pages pass
 * the same `getSelectedAccountId()` that scoped the scan (invariant 8) — and
 * the last-notified hash is stored per account. Switching back to Personal
 * with Personal's set unchanged is therefore silent, which a hash that merely
 * INCLUDED the account id could not deliver: one record cannot remember two
 * accounts.
 *
 * The dedup step is exported as one pure function taking the store, so it can
 * be driven here — vitest runs `environment: "node"`, there is no DOM and no
 * `localStorage`, and the component itself cannot be rendered.
 */
describe("both banners are told WHICH account the breaches belong to (U-2)", () => {
  it("/risk hands <BreachBanner> the selected account id, and 0 for the All view", () => {
    selectAccount(PERSONAL);
    expect(
      bannerElement(riskPage).props.accountId,
      "/risk gives the banner breaches but never says whose they are (U-2)",
    ).toBe(PERSONAL);
    selectAccount(ALL);
    expect(
      bannerElement(riskPage).props.accountId,
      "the All-accounts VIEW is 0 — a view is an account id like any other here (invariant 9)",
    ).toBe(ALL);
  });

  it("the dashboard does the same, with the same call", () => {
    selectAccount(PERSONAL);
    expect(
      bannerElement(dashboardPage).props.accountId,
      "the dashboard gives the banner breaches but never says whose they are (U-2)",
    ).toBe(PERSONAL);
    selectAccount(SWING);
    expect(bannerElement(dashboardPage).props.accountId).toBe(SWING);
    selectAccount(ALL);
    expect(bannerElement(dashboardPage).props.accountId).toBe(ALL);
  });

  it("the id the banner is given is the id the scan was scoped by — one selection, not two reads that can disagree", () => {
    for (const id of [PERSONAL, SWING] as const) {
      selectAccount(id);
      for (const page of [riskPage, dashboardPage]) {
        const props = bannerElement(page).props;
        expect(props.accountId, "the banner is scoped to an account the scan was not").toBe(id);
        expect(ids(props.breaches as Array<{ id: number }>)).toEqual([id === PERSONAL ? PERSONAL_ID : SWING_ID]);
      }
    }
  });
});

describe("the last-notified record is kept PER ACCOUNT (U-2)", () => {
  /** A `localStorage` stand-in — node has none, and this is the whole surface. */
  const fakeStore = () => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
  };
  const breach = (id: number, kind: Breach["kind"], level: number): Breach => ({
    id,
    symbol: `S${id}`,
    kind,
    side: "long",
    level,
    mtm: level + 10,
    throughPct: 1,
    message: "Review this against a live quote.",
  });
  const PERSONAL_SET = [breach(PERSONAL_ID, "target", 2050)];
  const SWING_SET = [breach(SWING_ID, "target", 1550)];

  it("switching to another account and back announces nothing new", () => {
    const store = fakeStore();
    expect(
      markNotified(store, PERSONAL, PERSONAL_SET),
      "a set this device has never announced was treated as already seen",
    ).not.toBeNull();
    expect(
      markNotified(store, PERSONAL, PERSONAL_SET),
      "the same set announced itself twice for the same account",
    ).toBeNull();

    expect(markNotified(store, SWING, SWING_SET), "Swing's own first set was silent").not.toBeNull();

    expect(
      markNotified(store, PERSONAL, PERSONAL_SET),
      "switching account and back re-announced breaches this device has already shown (U-2)",
    ).toBeNull();
    expect(
      markNotified(store, SWING, SWING_SET),
      "…and the same in the other direction: Swing's record was overwritten by Personal's",
    ).toBeNull();
  });

  it("it is a record, not a mute: a genuinely new breach in the same account still announces", () => {
    const store = fakeStore();
    expect(markNotified(store, PERSONAL, PERSONAL_SET)).not.toBeNull();
    expect(
      markNotified(store, PERSONAL, [...PERSONAL_SET, breach(953, "sl", 1900)]),
      "a new breach in an account that had already been notified stayed silent",
    ).not.toBeNull();
    // The level moving through is a different set too — the hash is unchanged
    // in shape, only its key moved (`id:kind:level`).
    expect(markNotified(store, PERSONAL, [breach(PERSONAL_ID, "target", 2075)])).not.toBeNull();
  });

  it("every account, and the All view, has its own `vyuha-` key", () => {
    expect(lastNotifiedKey(PERSONAL)).not.toBe(lastNotifiedKey(SWING));
    expect(lastNotifiedKey(ALL)).not.toBe(lastNotifiedKey(PERSONAL));
    for (const id of [ALL, PERSONAL, SWING]) {
      expect(lastNotifiedKey(id), "the key left the vyuha- kebab-case convention (a `:suffix`, AGENTS.md)").toMatch(
        /^vyuha-breach-last-notified:\d+$/,
      );
    }
    const store = fakeStore();
    markNotified(store, SWING, SWING_SET);
    expect([...store.map.keys()], "the record was not written under this account's key").toEqual([
      lastNotifiedKey(SWING),
    ]);
  });

  it("the banner itself uses this function and the account it is given — not a second copy of the rule", () => {
    const src = fs.readFileSync("components/risk/breach-banner.tsx", "utf8");
    expect(src, "the effect no longer goes through the exported dedup").toMatch(
      /markNotified\(localStorage, accountId, breaches\)/,
    );
    expect(src, "the account id never reaches the notification effect").toMatch(
      /\[optIn, breaches, accountId\]/,
    );
  });
});
