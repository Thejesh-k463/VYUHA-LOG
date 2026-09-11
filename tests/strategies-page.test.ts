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
import {
  canRedo,
  canUndo,
  initShelfHistory,
  shelfReducer,
  type ShelfAction,
  type ShelfHistory,
  type ShelfPostResult,
  type ShelfState,
} from "@/lib/domain/strategy-shelf";
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
   * R6-U-1, BEHAVIOURALLY: THE UNDO STACK MAY HOLD ONLY SHELVES THE STORE HELD.
   *
   * Two answers have already been wrong here, and both for the same reason — a
   * CLOSURE is one gesture's optimistic view of the world:
   *
   *   • reverting the whole history to the `committed` REF emptied `past`
   *     (`foldShelfPost` is `{ ...h, present }`, so that ref's stack was empty
   *     by construction) — one refusal after N accepted ticks disabled Undo,
   *     the reset the island's header says a route-handler write exists to
   *     avoid (R5-U-1);
   *   • taking `past`/`future` from the gesture's own pre-tick `history`
   *     instead fixed that for ONE write in flight and broke it for two: with
   *     ticks A and B in flight and B refused, B's closure `history` IS A's
   *     optimistic state, so A's never-stored shelf stayed in `past`. Three
   *     refusals deep, Undo lands on a shelf the store never held — and the
   *     next tick POSTS it, which stores it (R6-U-1).
   *
   * The shipped answer makes `committed` a real HISTORY: an accepted reply
   * replays that gesture's own action through the reducer before folding the
   * route's re-read over it, so a refusal can revert WHOLESALE to it.
   *
   * THE TWO EXPRESSIONS MARKED "verbatim" BELOW ARE DUPLICATED FROM THE
   * COMPONENT, deliberately. The real ones are a ref and a closure inside a
   * `"use client"` island — not importable here (the island is React, and
   * `tests/client-value-imports.test.ts` is what keeps it out of server
   * graphs). What ties this copy to the shipped code is the SOURCE-SHAPE pins
   * below ("a refusal puts the strip back …", "the confirmed history is
   * advanced …"); if a pin and this harness ever disagree, the pin is right.
   */
  const sameSelection = (a: ShelfState, b: ShelfState): boolean =>
    a.selected.length === b.selected.length && a.selected.every((id, i) => id === b.selected[i]);

  const ok = (selected: string[]): ShelfPostResult => ({
    ok: true,
    shelf: { selected },
    updatedAt: "2026-09-11T10:00:00.000Z",
  });
  const refused: ShelfPostResult = { ok: false, error: "Nothing was stored." };

  /**
   * `prev` is the gesture's PRE-TICK history — the `history` its `.then()`
   * closes over in the component. The shipped revert must not read it (that was
   * the R6-U-1 defect); it is carried here so a test can SHOW what it holds
   * while another write is in flight.
   */
  type Gesture = { mine: number; prev: ShelfHistory; next: ShelfHistory; action: ShelfAction };

  /**
   * `run()` and its `.then((r) => …)`, outside React: `history` stands in for
   * the `useState`, `committed`/`committedAt`/`latest` for the three refs. The
   * component's own no-op guard (`next === history`) is left out — every
   * gesture below really changes the shelf.
   */
  function island(seed: ShelfState) {
    let history = initShelfHistory(seed);
    // Seeded from the SAME server prop as `history` and a different object,
    // which is why every comparison downstream is by value.
    let committed = initShelfHistory(seed);
    let committedAt = 0;
    let latest = 0;
    // The component's `router.refresh()`, counted rather than performed: the
    // R5-U-2 fix is half screen and half CACHE, and a harness that records only
    // the screen cannot say the cache half happened at all.
    let refreshes = 0;

    return {
      /** The gesture: reduce, render optimistically, number the write. */
      tick(action: ShelfAction): Gesture {
        const prev = history;
        const next = shelfReducer(history, action);
        history = next;
        const mine = ++latest;
        return { mine, prev, next, action };
      },
      /** Its reply, whenever it lands. */
      reply(g: Gesture, r: ShelfPostResult): void {
        const before = committed.present;
        const advanced = r.ok && g.mine > committedAt;
        if (advanced) {
          committedAt = g.mine;
          // ── the component's advance, verbatim ──
          committed = foldShelfPost(shelfReducer(committed, g.action), r);
        }
        if (g.mine !== latest) {
          if (advanced) {
            history =
              sameSelection(history.present, before) && !sameSelection(history.present, committed.present)
                ? { ...history, present: committed.present }
                : history;
            refreshes++;
          }
          return;
        }
        if (!r.ok) {
          // ── the component's revert, verbatim ──
          history = history === g.next ? committed : history;
          return;
        }
        history = foldShelfPost(history, r);
        refreshes++;
      },
      get history(): ShelfHistory {
        return history;
      },
      get committed(): ShelfHistory {
        return committed;
      },
      get refreshes(): number {
        return refreshes;
      },
    };
  }

  /** Everything Undo can reach from here, oldest first — `past` then `present`. */
  const stackOf = (h: ShelfHistory): string[][] => [...h.past, h.present].map((s) => s.selected);

  /**
   * Everything REDO can reach, in the order the reducer will hand it back.
   * `stackOf` folds `present` into the undo side, so a step in `future` that is
   * value-equal to `present` is invisible to it — and that duplicate is exactly
   * the R7-U-1 shape: Redo enabled onto the shelf already on screen, a click
   * that POSTs the same shelf and writes one audit row for nothing.
   */
  const redoStackOf = (h: ShelfHistory): string[][] => h.future.map((s) => s.selected);

  it("two ticks in flight, both refused: the store never moved, so there is nothing to undo (R6-U-1)", () => {
    const seed = { selected: ["long-call", "long-put"] };
    const s = island(seed);
    const a = s.tick({ type: "select", id: "iron-condor" });
    const b = s.tick({ type: "select", id: "long-straddle" });
    // A answers first and is already stale (B is `latest`), so it stays silent;
    // B is the reply that decides the screen.
    s.reply(a, refused);
    s.reply(b, refused);

    // WHY A CLOSURE CANNOT BE THE REVERT TARGET, stated as a fact: what B's
    // `.then()` closes over is A's optimistic shelf, which the store refused.
    expect(b.prev.present.selected, "B's pre-tick history is A's OPTIMISTIC state").toEqual([
      ...seed.selected,
      "iron-condor",
    ]);
    expect(s.history.present.selected, "the strip kept a shelf the route refused").toEqual(seed.selected);
    expect(
      s.history.past,
      "the revert carried the OTHER in-flight gesture's optimistic shelf into `past`",
    ).toHaveLength(0);
    expect(canUndo(s.history), "there is an undo step for a write that never happened").toBe(false);
    expect(
      redoStackOf(s.history),
      "a redo step equal to `present` is a no-op write onto the shelf already on screen (R7-U-1)",
    ).not.toContainEqual(s.history.present.selected);
  });

  it("three refusals deep, every shelf Undo can still reach is one the store held (R6-U-1)", () => {
    const seed = { selected: ["long-call", "long-put"] };
    const s = island(seed);
    const a = s.tick({ type: "select", id: "iron-condor" });
    const b = s.tick({ type: "select", id: "long-straddle" });
    const c = s.tick({ type: "select", id: "bull-call-spread" });
    s.reply(a, refused);
    s.reply(b, refused);
    s.reply(c, refused);

    // The store answered "no" three times, so the ONLY shelf it ever held is
    // the seed — and that is the whole stack. Anything else here is a shelf
    // the user can undo onto and the next tick will then POST.
    expect(stackOf(s.history), "the undo stack holds a shelf the store never held").toEqual([seed.selected]);
    expect(canUndo(s.history)).toBe(false);
    expect(
      redoStackOf(s.history),
      "a redo step equal to `present` is a no-op write onto the shelf already on screen (R7-U-1)",
    ).not.toContainEqual(s.history.present.selected);
  });

  it("a refused tick after three accepted ones leaves Undo alive and the strip on the store (R5-U-1)", () => {
    const seed = { selected: ["long-call", "long-put"] };
    const s = island(seed);

    // Three ticks, each accepted and each re-read by the route.
    for (const id of ["iron-condor", "long-straddle", "bull-call-spread"]) {
      const g = s.tick({ type: "select", id });
      s.reply(g, ok(g.next.present.selected));
    }
    expect(s.history.past).toHaveLength(3);
    expect(
      s.committed.past,
      "the confirmed history does not advance with the screen's — the fold alone never moves a stack",
    ).toHaveLength(3);
    expect(s.committed.present.selected).toEqual(s.history.present.selected);

    // The fourth tick: reduced, rendered — and then REFUSED by the route.
    const fourth = s.tick({ type: "select", id: "jade-lizard" });
    expect(fourth.next.past, "the optimistic tick pushed the pre-tick present onto `past`").toHaveLength(4);
    s.reply(fourth, refused);

    expect(canUndo(s.history), "one refused tick disabled Undo for the whole session").toBe(true);
    expect(s.history.past, "the accepted ticks' history was replaced by an empty one").toHaveLength(3);
    expect(s.history.present.selected, "the strip is not on the last shelf the store confirmed").toEqual([
      "long-call",
      "long-put",
      "iron-condor",
      "long-straddle",
      "bull-call-spread",
    ]);
    // …and one step back is the shelf the store held before the third tick —
    // not the optimistic present the reducer had already pushed onto `past`.
    expect(shelfReducer(s.history, { type: "undo" }).present.selected).toEqual([
      "long-call",
      "long-put",
      "iron-condor",
      "long-straddle",
    ]);
    expect(
      redoStackOf(s.history),
      "a redo step equal to `present` is a no-op write onto the shelf already on screen (R7-U-1)",
    ).not.toContainEqual(s.history.present.selected);
  });

  it("an accepted UNDO moves the confirmed history too, so the next refusal lands on that step (R6-U-1)", () => {
    const seed = { selected: ["long-call"] };
    const s = island(seed);
    for (const id of ["iron-condor", "long-straddle"]) {
      const g = s.tick({ type: "select", id });
      s.reply(g, ok(g.next.present.selected));
    }

    // Undo is a write like any other: the route stores the undone shelf and
    // re-reads it back.
    const undo = s.tick({ type: "undo" });
    s.reply(undo, ok(undo.next.present.selected));
    expect(s.history.present.selected).toEqual(["long-call", "iron-condor"]);

    // …and then a tick the route refuses.
    const refusedTick = s.tick({ type: "select", id: "bull-call-spread" });
    s.reply(refusedTick, refused);

    expect(s.history.present.selected, "the strip is not on the shelf the accepted undo confirmed").toEqual([
      "long-call",
      "iron-condor",
    ]);
    expect(s.history.past, "the confirmed history is not standing where the undo left it").toHaveLength(1);
    expect(canRedo(s.history), "the redo the accepted undo created was lost by a refusal").toBe(true);
    expect(shelfReducer(s.history, { type: "redo" }).present.selected).toEqual([
      "long-call",
      "iron-condor",
      "long-straddle",
    ]);
    // The redo this leaves behind is a REAL step: it goes somewhere the screen
    // is not. The R7-U-1 shape — a `future` entry value-equal to `present`, so
    // Redo posts the shelf already on screen — is absent here, and this is the
    // interleaving where an undo/redo replay could most easily have produced it.
    expect(
      redoStackOf(s.history),
      "a redo step equal to `present` is a no-op write onto the shelf already on screen (R7-U-1)",
    ).not.toContainEqual(s.history.present.selected);
  });

  /**
   * R7-T-5, THE R5-U-2 INTERLEAVING ITSELF, DRIVEN — the one the fix was
   * written for and the one no test had ever run: tick A accepted but slow,
   * tick B refused and fast, B's reply first.
   *
   * TWO THINGS THIS TEST IS NOT. It cannot go red on a component plant: the
   * island above DUPLICATES the handler (a closure and three refs inside a
   * `"use client"` file cannot be imported), so what ties it to the shipped
   * code is the source-shape pins in the next describe, not this harness. And
   * it does not claim the bound is tight — it DOCUMENTS the recorded bound
   * (R5-U-2's residual tick C, R6-U-2's value-equal re-sync), which is why the
   * assertions below also state the DEPTH the two stacks end up at.
   */
  it("the stale-accepted branch: the screen re-syncs and the cache is purged — the R5-U-2/R6-U-2 bound DOCUMENTED, not pinned, because this harness duplicates the island and cannot go red on a component plant", () => {
    const seed = { selected: ["long-call", "long-put"] };
    const s = island(seed);
    const a = s.tick({ type: "select", id: "iron-condor" });
    const b = s.tick({ type: "select", id: "long-straddle" });

    // B answers first and is `latest`, so its refusal reverts the strip
    // WHOLESALE to the confirmed history — which is still the mount seed,
    // because A has not been confirmed yet. The screen is now pre-A.
    s.reply(b, refused);
    expect(s.history.present.selected, "the refusal did not put the strip back").toEqual(seed.selected);
    expect(s.refreshes, "a refusal stored nothing, so nothing upstream is stale").toBe(0);

    // …and now A's `ok` lands, stale. Before the fix it moved `committed` and
    // returned: screen pre-A, store post-A, cache never purged, and the next
    // tick would post the screen's list and erase A permanently.
    s.reply(a, ok(a.next.present.selected));

    const postA = ["long-call", "long-put", "iron-condor"];
    expect(s.history.present.selected, "the screen was left on the shelf this reply superseded").toEqual(postA);
    expect(s.committed.present.selected, "the confirmed present is not the route's re-read").toEqual(postA);
    expect(s.refreshes, "the store moved and the client router cache was never purged").toBe(1);

    // THE STACK IS INTACT: the re-sync replaces `present` and nothing else, so
    // the screen keeps the (empty) stack the wholesale revert gave it.
    expect(s.history.past, "the re-sync replaced the history instead of just the present").toHaveLength(0);
    expect(
      redoStackOf(s.history),
      "a redo step equal to `present` is a no-op write onto the shelf already on screen (R7-U-1)",
    ).not.toContainEqual(s.history.present.selected);

    // AND THE RECORDED BOUND, stated as a number: the confirmed history now
    // stands one step DEEPER than the screen's, because A's acceptance was
    // replayed here and the screen had already reverted past it. Nothing is
    // lost — every shelf either side held was stored — but this is the
    // divergence an undo/redo replay later pops the wrong entry from (R7-U-1),
    // and it is fixable only by ordering the replies at the route.
    expect(s.committed.past, "the confirmed history did not record A's step").toHaveLength(1);
  });
});

/**
 * THE SOURCE-SHAPE PINS, AND WHAT THEY CAN AND CANNOT SAY.
 *
 * The island is a `"use client"` file: its handler closes over `useState` and
 * three refs, so no test can call it. Everything below therefore reads the FILE
 * and asserts its SHAPE — the literal, its neighbours, its NESTING (R7-T-1) and
 * how many times each name is declared or assigned (R7-T-2/T-3/T-4).
 *
 * THE CAVEAT, WIDENED (R7, and recorded so it is not re-filed): a shape pin
 * says what IS there, never what is not. Two rounds have already found live
 * code the pins could not see — a block moved OUT of the guard it must run
 * inside, a second declaration shadowing a pinned one — and the counts below
 * close those two classes. Beyond them, ANY FURTHER LIVE STATEMENT INSIDE THE
 * REPLY CALLBACK THAT IS NOT ITSELF PINNED IS THE ACCEPTED WEAKNESS OF THIS
 * METHOD, not a new defect: closing it completely needs the handler to be
 * callable, which needs a jsdom harness this screen does not have. The
 * previously recorded forms — a dead branch, a wrong comment — stand under the
 * same caveat. Round 8 may not re-file any of it as a finding.
 */
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

  const STALE_GUARD = "if (mine !== latest.current) {";
  const REFUSAL_GUARD = "if (!r.ok) {";
  const OK_FOLD = "setHistory((cur) => foldShelfPost";

  /**
   * R7-T-1, THE NESTING PINS. The two slices above end at the NEXT branch, not
   * at the guard's own `return;`, so a block lifted OUT of its guard and
   * dropped after its closing brace stays inside them and every content pin
   * stays green — while the code now runs on replies the guard exists to keep
   * it away from. `returnAfter` is what makes "inside the guard" assertable:
   * the body of a guard that returns is everything above that `return;`.
   */
  const returnAfter = (src: string, from: number, what: string): number => {
    const at = src.indexOf("return;", from);
    expect(at, `${what} no longer ends in a \`return;\``).toBeGreaterThan(from);
    return at;
  };

  /** Everything the STALE guard runs before returning — its real body. */
  const staleGuardBody = (src: string): string => {
    const from = src.indexOf(STALE_GUARD);
    expect(from, "the stale guard is not where this test expects it").toBeGreaterThan(-1);
    return src.slice(from, returnAfter(src, from, "the stale guard"));
  };

  /** …and everything between that `return;` and the refusal branch, which must do no work. */
  const afterStaleGuard = (src: string): string => {
    const from = src.indexOf(STALE_GUARD);
    const to = src.indexOf(REFUSAL_GUARD);
    expect(to, "the refusal branch no longer follows the stale guard").toBeGreaterThan(from);
    return src.slice(returnAfter(src, from, "the stale guard"), to);
  };

  /** Everything the REFUSAL branch runs before returning. */
  const refusalBody = (src: string): string => {
    const from = src.indexOf(REFUSAL_GUARD);
    expect(from, "the refusal branch is not where this test expects it").toBeGreaterThan(-1);
    return src.slice(from, returnAfter(src, from, "the refusal branch"));
  };

  /** …and everything between that `return;` and the ok path's fold. */
  const afterRefusal = (src: string): string => {
    const from = src.indexOf(REFUSAL_GUARD);
    const to = src.indexOf(OK_FOLD);
    expect(to, "the ok path's fold is not where this test expects it").toBeGreaterThan(from);
    return src.slice(returnAfter(src, from, "the refusal branch"), to);
  };

  /**
   * The POST's reply callback down to the ok path's fold: every statement that
   * runs before the screen takes the route's answer. R7-T-2/T-3/T-4 count over
   * this slice.
   */
  const replyCallback = (src: string): string => {
    const from = src.indexOf("void postShelf(body).then((r) => {");
    const to = src.indexOf(OK_FOLD);
    expect(from, "the POST's reply handler is not where this test expects it").toBeGreaterThan(-1);
    expect(to, "the ok path's fold is not where this test expects it").toBeGreaterThan(from);
    return src.slice(from, to);
  };

  /**
   * How many times `needle` occurs — a COUNT, never an `indexOf`. R7-T-2: every
   * index pin in this file reads the FIRST occurrence, so a second copy of a
   * pinned declaration is invisible to all of them and is the one the code
   * below actually reads.
   */
  const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

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
    // R6-U-1: THE WHOLE CONFIRMED HISTORY, stack included — which is only safe
    // because `committed` is now advanced by replaying each accepted gesture's
    // action (pinned by ADVANCE below). The two rejected shapes both put a
    // shelf the store never held into the stack: `{ ...cur }` keeps the
    // optimistic present the reducer already pushed onto `past`, and
    // `{ ...history, present: … }` keeps the OTHER in-flight gesture's
    // optimistic state there. Behaviour: the four tests in "the shelf write
    // folds the route's own answer".
    expect(refusal, "a functional update, so a later successful tick is not overwritten").toContain(
      "setHistory((cur) => (cur === next ? committed.current : cur));",
    );
    expect(
      refusal,
      "a closure's `past` is back in the revert — with two writes in flight that is another gesture's optimistic shelf (R6-U-1)",
    ).not.toContain("{ ...history, present:");
    expect(refusal, "the error is still stated").toContain("toast.error(r.error)");
    expect(client, "a `previous` snapshot is what this fix removed").not.toContain("const previous = history;");
  });

  /**
   * The advance of the confirmed history. R5-T-1 pinned its old shape; R6-U-1
   * changed it, because a ref that only ever took `{ ...h, present }` could not
   * be reverted to wholesale — its stack was empty by construction.
   */
  const ADVANCE =
    /const advanced = r\.ok && mine > committedAt\.current;\r?\n\s*if \(advanced\) \{\r?\n\s*committedAt\.current = mine;\r?\n\s*committed\.current = foldShelfPost\(shelfReducer\(committed\.current, action\), r\);/;

  it("the confirmed history is advanced by REPLAYING the gesture's action, and before either guard (R6-T-1/T-2)", () => {
    // Without the replay, `committed`'s `past`/`future` stay `[]` for the whole
    // session (`foldShelfPost` is `{ ...h, present }`) and the wholesale revert
    // silently becomes R5-U-1 again: one refusal, no undo history. Deleting the
    // advance outright is R4-U-1 in a new coat — every refusal reverts to the
    // mount seed.
    expect(client, "the confirmed history is never advanced, or no longer replays the action").toMatch(ADVANCE);

    // R6-T-1. `before` is the PRE-advance confirmed present: the stale branch
    // asks whether the screen still sits on the shelf THIS reply superseded,
    // which the advance overwrites. Declared below the advance, that question
    // compares the screen against the answer instead — it can never be true,
    // and the re-sync silently stops happening.
    expect(
      client.indexOf("const before = committed.current.present;"),
      "`before` is captured AFTER the advance, so it is the new confirmed shelf and not the superseded one",
    ).toBeLessThan(client.search(ADVANCE));

    // R6-T-2. The load-bearing order pin: the advance must precede the STALE
    // guard, which returns. (The refusal branch is mutually exclusive with the
    // advance — `!r.ok` — so anchoring on it alone was vacuous; it is kept
    // because it still catches the block being moved past the ok path.)
    expect(
      client.search(ADVANCE),
      "the stale guard returns before this reply's acceptance is recorded — a stale `ok` is lost (R5-U-2)",
    ).toBeLessThan(client.indexOf("if (mine !== latest.current) {"));
    expect(
      client.search(ADVANCE),
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

  /** The stale re-sync as ONE block: guard, comparison, both arms, refresh. */
  const STALE_BLOCK =
    /if \(advanced\) \{\r?\n\s*setHistory\(\(cur\) =>\r?\n\s*sameSelection\(cur\.present, before\) && !sameSelection\(cur\.present, committed\.current\.present\)\r?\n\s*\? \{ \.\.\.cur, present: committed\.current\.present \}\r?\n\s*: cur,\r?\n\s*\);\r?\n\s*router\.refresh\(\);/;

  it("the stale re-sync is pinned as ONE block — guard, comparison, arms and refresh together (R6-T-3)", () => {
    // The `toContain`s above are five independent assertions over one slice, so
    // each of them stays green while the block around it is rearranged: negate
    // the guard to `!advanced`, turn the `&&` into `||`, swap the ternary arms,
    // and every fragment is still present somewhere in the slice. This is the
    // adjacency pin — the technique ADVANCE and the ok-path refresh already use
    // — so the block is asserted as the thing it actually is.
    expect(
      client,
      "the stale re-sync block has been rearranged: check the `advanced` guard, the `&&`, the ternary arms and the refresh",
    ).toMatch(STALE_BLOCK);
  });

  it("the stale re-sync sits INSIDE the stale guard, above its `return;` (R7-T-1)", () => {
    // The block above is matched against the WHOLE file, so it goes on matching
    // wherever in the callback the block sits. Lift it out and drop it just
    // after the guard's closing brace and BOTH halves of R5-U-2 come back: the
    // stale reply — the only one this block was written for — now hits a guard
    // whose whole body is `return;`, so the store moves, the screen stays
    // pre-A and the cache is never purged; meanwhile every reply that is NOT
    // stale runs the re-sync and drags the screen onto `committed`.
    expect(
      staleGuardBody(client),
      "the stale re-sync is no longer inside `if (mine !== latest.current)` — a stale accepted reply now returns having done nothing (R5-U-2)",
    ).toMatch(STALE_BLOCK);
    const after = afterStaleGuard(client);
    expect(
      after,
      "a `setHistory` sits between the stale guard's `return;` and the refusal branch — it runs on every non-stale reply",
    ).not.toContain("setHistory");
    expect(
      after,
      "a `router.refresh()` sits between the stale guard's `return;` and the refusal branch",
    ).not.toContain("router.refresh()");
  });

  it("the refusal revert sits INSIDE the refusal branch, above its `return;` (R7-T-1)", () => {
    // Same hole, other branch: `refusalBranch` ends at the ok path's fold, so
    // the revert keeps satisfying it from just below the branch's closing
    // brace — where it reverts an ACCEPTED write as well, throwing away the
    // shelf the route just confirmed on every successful tick.
    expect(
      refusalBody(client),
      "the revert is no longer inside `if (!r.ok)` — nothing puts the strip back when the store refuses (U-3)",
    ).toContain("setHistory((cur) => (cur === next ? committed.current : cur));");
    expect(
      afterRefusal(client),
      "the revert sits below the refusal branch's `return;` — it now reverts accepted writes too",
    ).not.toContain("setHistory((cur) => (cur === next");
  });

  it("the reply callback declares each name once and assigns each ref once (R7-T-2/T-4)", () => {
    // Every ORDER pin in this file is an `indexOf`, which reads the FIRST
    // occurrence — so a second `const before = …` as the guard's first line
    // keeps all of them green while being the declaration the branch actually
    // reads, and a second `committed.current = …` after the advance keeps the
    // ADVANCE regex green while overwriting what it just proved.
    const reply = replyCallback(client);
    expect(
      occurrences(reply, "const before = committed.current.present;"),
      "`before` is declared more than once — the index pins read the first, the branches read the last",
    ).toBe(1);
    expect(
      occurrences(reply, "const advanced = r.ok && mine > committedAt.current;"),
      "`advanced` is declared more than once — the guard the pins checked is not the one that runs",
    ).toBe(1);
    expect(
      occurrences(reply, "committed.current ="),
      "the confirmed history is assigned more than once per reply — a second assignment undoes the advance the pins proved",
    ).toBe(1);
    expect(
      occurrences(reply, "committedAt.current ="),
      "the confirmation watermark is assigned more than once per reply",
    ).toBe(1);
    expect(
      occurrences(reply, "latest.current ="),
      "the reply renumbers the writes — `latest` belongs to the gesture, and moving it here makes every later reply look current",
    ).toBe(0);
  });

  it("…and declares NOTHING else, destructuring included (R7-T-3)", () => {
    // The R6-T-4 regex reads `const NAME`, so a destructuring shadow
    // (`const { committed } = …`) walks straight past it. Counting every
    // declaration keyword in the slice is the form that cannot be written
    // around: the callback is two declarations long, and anything else in it is
    // a name the pins below do not know about.
    const reply = replyCallback(client);
    expect(
      reply.match(/\b(const|let|var|function|class)\b/g) ?? [],
      "the reply callback declares something other than `before` and `advanced` — every pin below reads the outer names",
    ).toHaveLength(2);
    expect(
      reply.match(
        /\b(const|let|var)\b[^=;]*\b(history|committed|next|before|advanced|latest|committedAt|action|router)\b/g,
      ) ?? [],
      "a declaration inside the reply callback binds one of the island's own names — destructuring counts (R7-T-3)",
    ).toEqual(["const before", "const advanced"]);
  });

  it("nothing inside the reply callback shadows `history`, `committed` or `next` (R6-T-4)", () => {
    // Every pin in this file reads the callback's three names as the ones
    // declared in `run` and at component scope. A local `const committed = …`
    // or `const history = …` inside the callback would satisfy every regex
    // above while sending the revert somewhere else entirely — the one way the
    // source-shape technique can be defeated without touching a pinned line.
    const from = client.indexOf("void postShelf(body).then((r) => {");
    const to = client.indexOf("const rows = picker");
    expect(from, "the POST's reply handler is not where this test expects it").toBeGreaterThan(-1);
    expect(to, "`run` no longer ends before the render").toBeGreaterThan(from);
    expect(
      client.slice(from, to),
      "a declaration inside the reply callback shadows the state the revert is supposed to use",
    ).not.toMatch(/\b(const|let|var) (history|committed|next)\b/);
  });

  it("sameSelection really compares the two selections, element by element (R6-T-5)", () => {
    // The stale re-sync and the whole R5-U-2 fix rest on this one helper, and
    // the pins above only assert that it is CALLED. A body of `return a === b;`
    // makes the guard false at mount — `useState` and `useRef` build two
    // objects from the same server prop — so the re-sync never fires and the
    // lost write comes back; a length-only body calls two different shelves the
    // same when a tick and an untick are both in flight.
    expect(client, "sameSelection no longer compares the selections by value, in order").toMatch(
      /function sameSelection\(a: ShelfState, b: ShelfState\): boolean \{\r?\n\s*return a\.selected\.length === b\.selected\.length && a\.selected\.every\(\(id, i\) => id === b\.selected\[i\]\);\r?\n\}/,
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
