import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import {
  STRATEGY_COPY,
  customName,
  foldShelfPost,
  helpHref,
  netTone,
  optionNetPremium,
  underlyingEntryLine,
  withholdForFree,
} from "@/components/strategies/strategy-copy";
import { buildStrategies, type PositionedLeg, type StrategyGroup } from "@/lib/analytics/strategies";
import { canUndo, initShelfHistory, shelfReducer } from "@/lib/domain/strategy-shelf";
import { optionsAnchorId } from "@/lib/domain/options-help";

/**
 * `/strategies` — the wiring, the withholding and the underlying read (v4.3).
 *
 * NOTHING HERE STATICALLY IMPORTS `@/lib/db` or a `lib/queries/*` module: the
 * temp-db helper sets `VYUHA_DB_PATH` before the FIRST dynamic
 * `import("@/lib/db")`, and a static import anywhere in this file's graph would
 * bind the connection to the real database first. `@/components/strategies/…`
 * and `@/lib/analytics/…` are pure, which is exactly why the withholding lives
 * in a pure module.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** A group as `buildStrategies` really produces it — never a hand-written literal. */
function groupOf(legs: PositionedLeg[]): StrategyGroup {
  const [g] = buildStrategies(legs);
  return g;
}

const ce = (over: Partial<PositionedLeg>): PositionedLeg => ({
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

describe("the Pro withholding happens BEFORE the payload", () => {
  // A real 1×2 call ratio spread: long one CE, short two of a higher strike.
  // Named by the catalogue, and NOT one of the names the pre-v4.3 if-chain
  // printed — which is the case the withholding exists for.
  const spread = groupOf([ce({}), ce({ strike: 24500, side: "short", qty: 150, premium: 40 })]);

  it("the fixture is a NAMED, non-legacy-free catalogue shape — otherwise this suite proves nothing", () => {
    expect(spread.strategyId).not.toBeNull();
    expect(spread.legacyFree).toBe(false);
    expect(spread.displayName).not.toMatch(/^Custom/);
  });

  it("a Pro build keeps the name and the id, and is not marked withheld", () => {
    const [g] = withholdForFree([spread], true);
    expect(g.strategyId).toBe(spread.strategyId);
    expect(g.displayName).toBe(spread.displayName);
    expect(g.proWithheld).toBe(false);
  });

  it("a free build loses BOTH the name and the id — proved on the SERIALISED result", () => {
    // The whole point (app/live/page.tsx:21): a prop check would only prove a
    // flag was set. This proves the string never crosses the wire, which is
    // what a locked chip on screen is claiming.
    const wire = JSON.stringify(withholdForFree([spread], false));
    expect(wire).not.toContain(spread.strategyId as string);
    expect(wire).not.toContain(spread.displayName);
    expect(wire).toContain(customName(2));
    expect(wire).toContain('"proWithheld":true');
  });

  it("the legs, the figures and the payoff stay free (invariant 7)", () => {
    const [g] = withholdForFree([spread], false);
    expect(g.legs).toEqual(spread.legs);
    expect(g.netPremium).toBe(spread.netPremium);
    expect(g.maxProfit).toBe(spread.maxProfit);
    expect(g.maxLoss).toBe(spread.maxLoss);
    expect(g.payoff).toEqual(spread.payoff);
    expect(g.breakevens).toEqual(spread.breakevens);
  });

  it("a legacyFree shape keeps its name on a free build — a release never takes one away", () => {
    const straddle = groupOf([ce({}), ce({ kind: "PE", optionType: "PE" })]);
    expect(straddle.legacyFree, "the fixture must be one of the pre-v4.3 names").toBe(true);
    const [g] = withholdForFree([straddle], false);
    expect(g.displayName).toBe(straddle.displayName);
    expect(g.strategyId).toBe(straddle.strategyId);
    expect(g.proWithheld).toBe(false);
  });

  it("an unnamed group has nothing to withhold and is untouched", () => {
    const odd = groupOf([ce({}), ce({ strike: 24500, qty: 150 }), ce({ strike: 25000, qty: 25 })]);
    expect(odd.strategyId).toBeNull();
    const [g] = withholdForFree([odd], false);
    expect(g.displayName).toBe(odd.displayName);
    expect(g.proWithheld).toBe(false);
  });
});

describe("the card's seams", () => {
  it("credit/debit is read from the CATALOGUE, never from the sign of netPremium", () => {
    // B1's note: a covered call's netPremium carries the underlying entry cash,
    // so its sign describes the cash flow and not the structure.
    expect(netTone("covered-call", -999999, true), "the catalogue says credit, the sign says debit").toBe(
      "credit",
    );
    expect(netTone("bull-call-spread", 4500, false), "and the other way round").toBe("debit");
    // `either` with no underlying leg: the sign IS the answer, and is used.
    expect(netTone("call-ratio-spread", 4500, false)).toBe("credit");
    expect(netTone("call-ratio-spread", -4500, false)).toBe("debit");
    // `either` WITH an underlying leg, and an unnamed or withheld group: no
    // chip at all, rather than a guess.
    expect(netTone("collar", 4500, true)).toBeNull();
    expect(netTone(null, -4500, false)).toBeNull();
  });

  it("every card links into /help, and a Custom group lands on the section top", () => {
    expect(helpHref("iron-condor")).toBe(`/help#${optionsAnchorId("iron-condor")}`);
    expect(helpHref("iron-condor")).toBe("/help#options-iron-condor");
    // U-2: the section top is the desk's own heading id, `options-help`.
    // `/help#options` is an anchor NO surface renders — the link opened /help
    // and left the reader at the top of it. That the id really exists in the
    // rendered desk is proved in tests/seams-v43-wave2.test.ts (S12), where the
    // id is derived from this very href.
    expect(helpHref(null)).toBe("/help#options-help");
  });
});

describe("the shelf write folds the route's own answer", () => {
  const base = initShelfHistory({ selected: ["long-call", "long-put"] });

  it("an accepted write lands the RE-READ shelf on screen", () => {
    const h = foldShelfPost(base, {
      ok: true,
      shelf: { selected: ["long-call", "iron-condor"] },
      updatedAt: "2026-09-10T10:00:00.000Z",
    });
    expect(h.present.selected).toEqual(["long-call", "iron-condor"]);
  });

  it("the fold is not an edit — it spends no undo step", () => {
    const h = foldShelfPost(base, { ok: true, shelf: { selected: ["long-call"] }, updatedAt: "" });
    expect(h.past).toEqual(base.past);
    expect(h.future).toEqual(base.future);
  });

  it("a refusal folds nothing — the state stands and the caller states the error", () => {
    const h = foldShelfPost(base, { ok: false, error: "nope" });
    expect(h).toBe(base);
  });

  /**
   * R5-U-1, BEHAVIOURALLY: ONE REFUSAL MUST NOT COST THE UNDO HISTORY.
   *
   * `foldShelfPost` returns `{ ...h, present }`, so the `committed` ref's
   * `past`/`future` are ALWAYS empty — it is a record of the STORE, not of the
   * session. Reverting the WHOLE history to it therefore emptied `past`, and
   * `canUndo` went false after N accepted ticks: the header of
   * `strategies-client.tsx` says in its first paragraph that this screen exists
   * as a route-handler write precisely so the undo history is never reset.
   *
   * THE EXPRESSION BELOW IS DUPLICATED FROM THE COMPONENT, deliberately. The
   * real one is a closure over the gesture's pre-tick `history` and the
   * `committed` ref inside a `"use client"` island — not importable here (the
   * island is React, and `tests/client-value-imports.test.ts` is what keeps it
   * out of server graphs). The pin that ties this copy to the shipped one is
   * "a refusal puts the strip back …" below, which asserts the literal
   * `{ ...history, present: committed.current.present }` in the source; if that
   * pin and this test ever disagree, the source pin is the one that is right.
   */
  it("a refused tick after three accepted ones leaves Undo alive and the strip on the store (R5-U-1)", () => {
    const seed = { selected: ["long-call", "long-put"] };
    let history = initShelfHistory(seed);
    // The ref the component seeds from the SAME server prop — a different
    // object, which is why every comparison downstream is by value.
    let committed = initShelfHistory(seed);

    // Three ticks, each accepted and each re-read by the route.
    for (const id of ["iron-condor", "long-straddle", "bull-call-spread"]) {
      history = shelfReducer(history, { type: "select", id });
      committed = foldShelfPost(committed, {
        ok: true,
        shelf: { selected: history.present.selected },
        updatedAt: "",
      });
    }
    expect(history.past).toHaveLength(3);
    expect(committed.past, "the fold spends no undo step, so this is always []").toHaveLength(0);
    expect(committed.present.selected).toEqual(history.present.selected);

    // The fourth tick: reduced, rendered — and then REFUSED by the route.
    const next = shelfReducer(history, { type: "select", id: "jade-lizard" });
    expect(next.past, "the optimistic tick pushed the pre-tick present onto `past`").toHaveLength(4);

    // ── the component's revert expression, verbatim ──
    const reverted = { ...history, present: committed.present };

    expect(canUndo(reverted), "one refused tick disabled Undo for the whole session").toBe(true);
    expect(reverted.past, "the accepted ticks' history was replaced by the store's empty one").toHaveLength(3);
    expect(reverted.present.selected, "the strip is not on the last shelf the store confirmed").toEqual([
      "long-call",
      "long-put",
      "iron-condor",
      "long-straddle",
      "bull-call-spread",
    ]);
    // …and NOT `cur`-based: `cur === next` already carries the optimistic
    // present pushed onto `past`, so undoing from a `{ ...cur }` revert would
    // land on a shelf the store never held.
    expect(shelfReducer(reverted, { type: "undo" }).present.selected).toEqual([
      "long-call",
      "long-put",
      "iron-condor",
      "long-straddle",
    ]);
  });
});

describe("the page is wired the way the estate requires", () => {
  const page = read("app/strategies/page.tsx");
  const client = read("components/strategies/strategies-client.tsx");

  it("reads the entitlement itself and carries no whole-page gate (invariant 7)", () => {
    expect(page).toContain("getEntitlement");
    expect(page, "a page gate would take the free journal away").not.toContain("<ProGate>");
  });

  it("is force-dynamic, like every DB-reading page", () => {
    expect(page).toContain('export const dynamic = "force-dynamic"');
  });

  it("withholds before the payload, and hands the client no entitlement to undo it with", () => {
    expect(page).toContain("withholdForFree(");
    // The picker's rows are the other half: a free build is sent none.
    expect(page).toMatch(/pro\s*\n?\s*\?\s*CATALOGUE\.map/);
  });

  it("imports only PascalCase COMPONENTS out of the client island", () => {
    // tests/client-value-imports.test.ts enforces this estate-wide; this is the
    // local statement of it, so a bad import fails in the suite that owns the
    // screen too.
    const clientImports = [...page.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)]
      .filter(([, , src]) => src.includes("components/strategies/strategies-client"))
      .flatMap(([, names]) => names.split(",").map((n) => n.trim()));
    expect(clientImports).toEqual(["StrategiesClient"]);
    // The shared VALUES come from the pure module instead.
    expect(page).toContain('from "@/components/strategies/strategy-copy"');
  });

  /**
   * The refusal branch of `run`'s `.then` — everything between `if (!r.ok) {`
   * and the fold that follows it. Read as a slice rather than matched with one
   * regex so a failure names WHICH half moved.
   */
  const refusalBranch = (src: string): string => {
    const from = src.indexOf("if (!r.ok) {");
    const to = src.indexOf("setHistory((cur) => foldShelfPost");
    expect(from, "the refusal branch is not where this test expects it").toBeGreaterThan(-1);
    expect(to, "the ok path's fold is not where this test expects it").toBeGreaterThan(from);
    return src.slice(from, to);
  };

  /**
   * The STALE branch — everything the `mine !== latest` guard runs before it
   * returns, i.e. between that guard and the refusal branch above. Sliced the
   * same way and for the same reason: a failure names which half moved.
   */
  const staleBranch = (src: string): string => {
    const from = src.indexOf("if (mine !== latest.current) {");
    const to = src.indexOf("if (!r.ok) {");
    expect(from, "the stale guard is not where this test expects it").toBeGreaterThan(-1);
    expect(to, "the refusal branch no longer follows the stale guard").toBeGreaterThan(from);
    return src.slice(from, to);
  };

  it("writes through the route and FOLDS the answer — never a server action", () => {
    expect(client).toContain('"use client"');
    expect(client).toContain('fetch("/api/strategies/shelf"');
    expect(client).toContain("foldShelfPost(");
    expect(client, "an action remounts the picker and resets its undo history").not.toContain('"use server"');
    expect(client, "no setState in an effect — derive instead").not.toContain("useEffect");
  });

  it("purges the router cache AFTER the fold — the condition staleTimes:120 was granted on (U-1)", () => {
    // next.config.ts:25 keeps the client router cache for 120s, and
    // docs/DECISIONS.md:2038-2056 made that conditional on EVERY write path
    // calling router.refresh() after its write. Browser Back reuses the page
    // payload regardless. Without the refresh: tick a tile (the DB holds 9),
    // navigate away and back, and the island re-mounts on the CACHED 8-id prop
    // — the next tick posts the stale 8 and the first tick is gone from the
    // database. The fold keeps the screen right NOW; the refresh is what keeps
    // the next mount's seed right.
    expect(client).toMatch(/import\s*\{[^}]*\buseRouter\b[^}]*\}\s*from\s*"next\/navigation"/);
    expect(client).toMatch(/const router = useRouter\(\);/);
    expect(client, "the refresh follows the fold on the ok path").toMatch(
      /setHistory\(\(cur\) => foldShelfPost\(cur, r\)\);\r?\n\s*router\.refresh\(\);/,
    );
  });

  it("…and never on a refusal — nothing was stored, so nothing upstream is stale (U-1)", () => {
    expect(refusalBranch(client)).not.toContain("router.refresh()");
  });

  it("a refusal puts the strip back — the screen never keeps what the store refused (U-3)", () => {
    // R4-U-1: the state to go back to is the last SERVER-CONFIRMED shelf, held
    // in a ref, NOT a `previous` snapshotted per gesture. With two ticks in
    // flight and both refused, `previous` was tick A's OPTIMISTIC state, so the
    // revert landed the strip on a shelf the store never held.
    expect(client, "the revert target is not the last server-confirmed shelf").toMatch(
      /const committed = React\.useRef\(initShelfHistory\(shelf\)\);/,
    );
    expect(client, "the ref is not seeded from the server prop at mount").toMatch(
      /committed[\s\S]{0,400}?initShelfHistory\(shelf\)/,
    );
    const refusal = refusalBranch(client);
    // R5-U-1: the PRESENT comes from the confirmed ref, the past/future from
    // the gesture's own PRE-TICK `history`. Reverting the WHOLE history to
    // `committed.current` disabled Undo, because `foldShelfPost` is
    // `{ ...h, present }` and that ref's `past` is empty by construction; and
    // reverting `{ ...cur }` would keep the optimistic present the reducer had
    // already pushed onto `past` — a phantom undo step onto a shelf the store
    // never held. Behaviour: "a refused tick after three accepted ones …".
    expect(refusal, "a functional update, so a later successful tick is not overwritten").toContain(
      "setHistory((cur) => (cur === next ? { ...history, present: committed.current.present } : cur));",
    );
    expect(refusal, "the whole history is replaced — one refusal empties past/future (R5-U-1)").not.toContain(
      "? committed.current :",
    );
    expect(refusal, "the error is still stated").toContain("toast.error(r.error)");
    expect(client, "a `previous` snapshot is what this fix removed").not.toContain("const previous = history;");

    // R5-T-1: NOTHING PINNED THE ADVANCE. Deleting the two lines that move
    // `committed` leaves every refusal reverting to the mount seed — the exact
    // bug R4-U-1 was written against — with the rest of this suite green. The
    // ref must also be advanced BEFORE the refusal branch reads it.
    const advance =
      /const advanced = r\.ok && mine > committedAt\.current;\r?\n\s*if \(advanced\) \{\r?\n\s*committedAt\.current = mine;\r?\n\s*committed\.current = foldShelfPost\(committed\.current, r\);/;
    expect(client, "the confirmed shelf is never advanced — `committed` stays the mount seed").toMatch(advance);
    expect(
      client.search(advance),
      "the refusal branch reads `committed` before this reply advances it",
    ).toBeLessThan(client.indexOf("if (!r.ok) {"));
  });

  it("a STALE accepted reply still purges the cache and re-syncs a screen left behind it (R5-U-2)", () => {
    // Tick A accepted-but-slow, tick B refused-and-fast: B lands first, reverts
    // to `committed` (still the mount seed) and the screen is pre-A. A's `ok`
    // then arrives stale — it advanced `committed`, and used to return before
    // touching either the screen or the router cache. Result: screen pre-A,
    // store post-A, cache never purged, and the NEXT tick posts the screen's
    // list and erases A permanently.
    const stale = staleBranch(client);
    expect(stale, "the store moved and the client router cache still holds the shelf before it").toContain(
      "router.refresh()",
    );
    expect(stale, "a screen still sitting on the pre-advance confirmed shelf is left behind").toContain(
      "sameSelection(cur.present, before)",
    );
    expect(stale, "…and one that has moved on since must not be dragged back").toContain(
      "!sameSelection(cur.present, committed.current.present)",
    );
    expect(stale, "the re-sync replaces the present only, never the history").toContain(
      "{ ...cur, present: committed.current.present }",
    );
    expect(client, "the pre-advance confirmed selection is not captured before the advance").toContain(
      "const before = committed.current.present;",
    );
    // BY VALUE, not by identity: `useState` and `useRef` seed two different
    // objects from the same server prop, so `cur.present === before` is false
    // at mount even when the two say the same shelf.
    expect(client, "an identity comparison would never match at mount").toMatch(
      /function sameSelection\(a: ShelfState, b: ShelfState\)/,
    );
    // A stale REFUSAL stays silent — the fix-wave-4 decision, unchanged.
    expect(stale, "a stale refusal must not toast: a newer acceptance carries its change").not.toContain(
      "toast.error",
    );
  });

  it("states what the free build is really denied, not a bundling claim that is false (G-1)", () => {
    // `strategy-copy.ts` VALUE-imports `getStrategyDef` and `legKind`, so the
    // whole 40-row catalogue — names, patterns, legacyFree — is in the client
    // chunk of every build, free included (`grep -o 'patterns:\[' on the built
    // chunks returns 40). The ruling asks only that the RSC PAYLOAD be clean,
    // and it is. Two comments claimed more than that: the drawer said a free
    // build "bundles none" and the page cited payload weight.
    const drawer = read("components/strategies/browse-drawer.tsx");
    expect(drawer, "a free build bundles the catalogue exactly like every other build").not.toMatch(
      /bundles none/,
    );
    expect(drawer).toContain("client chunk of every build");
    expect(page, "weight is not why the rows are withheld").not.toMatch(/weight on every page load/);
    expect(page).toContain("client chunk of every build");
  });

  it("keeps the shelf reducer, its undo/redo and the free refusal", () => {
    for (const seam of ["initShelfHistory", "shelfReducer", "canUndo(", "canRedo(", "toast.error"]) {
      expect(client, seam).toContain(seam);
    }
    expect(client).toMatch(/if \(!pro\) return;/);
  });

  it("keeps the chart mounted on approach ON THE PAGE, where the perf guard pins it", () => {
    // `tests/render-windowing.test.ts` reads app/strategies/page.tsx for both
    // names and for their nesting — 626 charts built in one commit after
    // hydration was this screen's entire cost. The card takes the rendered node.
    expect(page).toContain("LazyMount");
    expect(page).toContain("<PayoffChart");
    expect(page.indexOf("<LazyMount")).toBeLessThan(page.indexOf("<PayoffChart"));
    const card = read("components/strategies/strategy-card.tsx");
    expect(card).toContain("{chart}");
    expect(card).toContain("helpHref(g.strategyId)");
    expect(card).toContain("ProLock");
  });

  it("feeds the underlying legs in beside the option legs (Q4)", () => {
    expect(page).toContain("getOpenUnderlyingPositions");
    expect(page).toMatch(/kind: "UL"/);
    expect(page).toContain("buildStrategies([...optionLegs, ...underlyingLegs])");
  });

  it("prints the §6 notes once, at page level", () => {
    expect(page).toContain("STRATEGY_COPY.beforeCharges");
    expect(page).toContain("STRATEGY_COPY.sttNote");
    expect(STRATEGY_COPY.sttNote.match(/\./g)).toHaveLength(1);
  });
});

describe("getOpenUnderlyingPositions (Q4) — account-scoped, and only where an option leg is open", () => {
  let t: TempDb;
  let trades: typeof import("@/lib/queries/trades");

  const PRIMARY = 1;
  const SWING = 2;
  const ALL = 0;

  const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

  beforeAll(async () => {
    t = await openTempDb("strategies-underlying", { seed: true });
    trades = await import("@/lib/queries/trades");

    t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();

    t.db
      .insert(t.schema.trades)
      .values([
        // RELIANCE: an open CE leg and an open equity holding → the covered call.
        tradeRow({
          accountId: PRIMARY,
          symbol: "RELIANCE",
          instrumentType: "option",
          optionType: "CE",
          strike: 3000,
          expiry: "2026-09-24",
          isOpen: true,
          sellQty: 250,
          avgSellPrice: 40,
        }),
        tradeRow({
          accountId: PRIMARY,
          symbol: "RELIANCE",
          instrumentType: "equity",
          isOpen: true,
          buyQty: 250,
          avgBuyPrice: 2900,
        }),
        // TCS: an open holding with NO option leg anywhere → not a strategy leg.
        tradeRow({ accountId: PRIMARY, symbol: "TCS", instrumentType: "equity", isOpen: true, buyQty: 100 }),
        // INFY: an option leg but the holding is CLOSED.
        tradeRow({
          accountId: PRIMARY,
          symbol: "INFY",
          instrumentType: "option",
          optionType: "PE",
          strike: 1500,
          expiry: "2026-09-24",
          isOpen: true,
          buyQty: 400,
        }),
        tradeRow({ accountId: PRIMARY, symbol: "INFY", instrumentType: "equity", isOpen: false, buyQty: 400 }),
        // The other book: its own covered call, which must never merge in.
        tradeRow({
          accountId: SWING,
          symbol: "HDFCBANK",
          instrumentType: "option",
          optionType: "CE",
          strike: 1700,
          expiry: "2026-09-24",
          isOpen: true,
          sellQty: 550,
          avgSellPrice: 20,
        }),
        tradeRow({
          accountId: SWING,
          symbol: "HDFCBANK",
          instrumentType: "equity",
          isOpen: true,
          buyQty: 550,
          avgBuyPrice: 1650,
        }),
        // THE ROW THAT MAKES INVARIANT 8 TESTABLE: the same symbol, open in the
        // OTHER book, with no option leg of its own. A reader that scopes only
        // its subquery still passes every other case here and merges this row
        // into the primary book's covered call — two books in one structure,
        // and nothing on screen looks broken.
        tradeRow({
          accountId: SWING,
          symbol: "RELIANCE",
          instrumentType: "equity",
          isOpen: true,
          buyQty: 100,
          avgBuyPrice: 2800,
        }),
      ])
      .run();
  });

  afterAll(() => t?.cleanup());

  it("returns only the symbols that already carry an open option leg", () => {
    select(PRIMARY);
    expect(trades.getOpenUnderlyingPositions().map((r) => r.symbol)).toEqual(["RELIANCE"]);
  });

  it("is account-scoped (invariant 8) — the other book's holding never leaks in", () => {
    select(PRIMARY);
    const primary = trades.getOpenUnderlyingPositions();
    expect(primary.map((r) => r.symbol)).toEqual(["RELIANCE"]);
    expect(primary.map((r) => r.avgBuyPrice), "the OTHER book holds RELIANCE too, at 2800").toEqual([2900]);

    select(SWING);
    expect(trades.getOpenUnderlyingPositions().map((r) => r.symbol)).toEqual(["HDFCBANK"]);
  });

  it("the restriction is scoped too: an option leg in ANOTHER account does not unlock a holding", () => {
    // Both halves of the statement carry the same account filter, so a
    // single-account view narrows the legs and the underlyings together.
    select(PRIMARY);
    expect(trades.getOpenUnderlyingPositions().map((r) => r.symbol)).not.toContain("HDFCBANK");
    // …and the aggregate view widens BOTH halves together, so the second
    // book's RELIANCE holding appears exactly once it is in scope (0 is a view).
    select(ALL);
    expect(trades.getOpenUnderlyingPositions().map((r) => r.symbol).sort()).toEqual([
      "HDFCBANK",
      "RELIANCE",
      "RELIANCE",
    ]);
  });

  it("projects the six columns the page feeds into a UL leg, and nothing else", () => {
    select(PRIMARY);
    const [row] = trades.getOpenUnderlyingPositions();
    expect(Object.keys(row).sort()).toEqual(
      ["avgBuyPrice", "avgSellPrice", "buyQty", "instrumentType", "sellQty", "symbol"].sort(),
    );
    expect(row.avgBuyPrice).toBe(2900);
  });

  it("the covered call is nameable once the underlying is in the group", () => {
    select(PRIMARY);
    const legs: PositionedLeg[] = [
      ...trades.getOpenOptionPositions().map((o) => ({
        symbol: o.symbol,
        expiry: o.expiry,
        kind: o.optionType as "CE" | "PE",
        strike: o.strike as number,
        side: (o.buyQty >= o.sellQty ? "long" : "short") as "long" | "short",
        qty: Math.abs(o.buyQty - o.sellQty) || Math.max(o.buyQty, o.sellQty),
        premium: o.buyQty >= o.sellQty ? o.avgBuyPrice : o.avgSellPrice,
      })),
      ...trades.getOpenUnderlyingPositions().map((u) => ({
        symbol: u.symbol,
        expiry: null,
        kind: "UL" as const,
        strike: 0,
        side: (u.buyQty >= u.sellQty ? "long" : "short") as "long" | "short",
        qty: Math.abs(u.buyQty - u.sellQty) || Math.max(u.buyQty, u.sellQty),
        premium: u.buyQty >= u.sellQty ? u.avgBuyPrice : u.avgSellPrice,
      })),
    ];
    const g = buildStrategies(legs).find((x) => x.symbol === "RELIANCE")!;
    expect(g.ulLegs).toHaveLength(1);
    expect(g.strategyId, "without the underlying this group is Custom (1 legs)").toBe("covered-call");
  });
});

/**
 * THE NET PREMIUM TILE, AND THE TWO FIGURES BESIDE IT (wave 2 defects 1–4).
 *
 * All four are decided in the PURE module and only rendered by the card, which
 * is what lets them be asserted as arithmetic here and pinned as a source shape
 * below — a tone chosen in JSX can only be grepped.
 */
describe("optionNetPremium — a premium tile counts premiums (defect 2)", () => {
  const ul = (over: Partial<PositionedLeg> = {}): PositionedLeg => ({
    symbol: "NIFTY",
    expiry: null,
    kind: "UL",
    strike: 0,
    side: "long",
    qty: 150,
    premium: 3100,
    ...over,
  });

  /** A real covered call: 150 shares held under a short 3200 CE at ₹55. */
  const covered = () => groupOf([ce({ side: "short", strike: 3200, qty: 150, premium: 55 }), ul()]);

  it("the underlying's entry cash is not a premium — the tile is the CE credit alone", () => {
    const g = covered();
    expect(g.strategyId).toBe("covered-call");
    expect(g.ulLegs).toHaveLength(1);
    // What the tile used to print, and why it contradicted its own chip.
    expect(g.netPremium).toBe(55 * 150 - 3100 * 150);
    expect(g.netPremium).toBeLessThan(0);
    expect(netTone(g.strategyId, g.netPremium, true)).toBe("credit");
    // What it prints now: B1's sign convention, option legs only.
    expect(optionNetPremium(g)).toBe(55 * 150);
    expect(optionNetPremium(g)).toBeGreaterThan(0);
  });

  it("with no underlying leg the two are the SAME number — nothing else moved", () => {
    const spread = groupOf([ce({}), ce({ strike: 24500, side: "short", qty: 150, premium: 40 })]);
    expect(spread.ulLegs).toHaveLength(0);
    expect(optionNetPremium(spread)).toBe(spread.netPremium);
    expect(underlyingEntryLine(spread)).toBeNull();
  });

  it("the underlying's own cash is stated on its own line, read-only", () => {
    // 150 × ₹3,100 = ₹4,65,000 paid — the digits, whatever the locale's sign is.
    expect(underlyingEntryLine(covered())).toMatch(/^Underlying entry .?₹4,65,000 \(read-only\)$/);
    expect(underlyingEntryLine(groupOf([ce({}), ul({ side: "short" })]))).toMatch(/\(read-only\)$/);
  });
});

describe("the card takes its labels, tones and counts from the pure module (wave 2)", () => {
  const card = read("components/strategies/strategy-card.tsx");

  it("neither payoff tile hard-codes a heading or a colour (defects 1 and 4)", () => {
    expect(card).toContain("figureDescriptor(");
    expect(card).toContain("FIGURE_TONE_CLASS[");
    expect(card, 'a heading that ignores the figure\'s sign').not.toMatch(/label="Max (profit|loss)"/);
    expect(card, "a tone that ignores the figure's sign").not.toMatch(/text-(profit|loss)\b/);
    expect(card, "the sub-label is the descriptor's, not the cap word again").not.toMatch(/sub=\{cap\}/);
  });

  it("the premium tile and the leg count come from the pure module too (defects 2 and 3)", () => {
    expect(card).toContain("optionNetPremium(g)");
    expect(card).toContain("underlyingEntryLine(g)");
    expect(card, "netPremium counts the underlying's entry cash").not.toMatch(/inr\(g\.netPremium/);
    expect(card).toContain("legCountLabel(g.legs.length)");
    expect(card, "an English plural written in JSX").not.toMatch(/\{g\.legs\.length\} legs/);
  });
});
