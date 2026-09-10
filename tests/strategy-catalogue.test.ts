import { describe, it, expect } from "vitest";
import {
  CATALOGUE,
  STRATEGY_IDS,
  type LegPattern,
  type StrategyId,
} from "@/lib/analytics/strategy-catalogue";
import { computeStrategy, matchStrategy, type OptionLeg } from "@/lib/analytics/strategies";

// ONE convention for every fixture in this file, stated once so a closed form
// never fails spuriously: premiums are PER UNIT, every leg carries qty 1 except
// the 1×2 ratio rows (qty 1 and 2), and every expected figure below is stated in
// RUPEES FOR THE WHOLE POSITION — §4's per-unit closed form × the leg quantity.
// Expected numbers are hand-evaluated from §4 and written as literals; they are
// never produced by payoffAt(), or the check would agree with itself.

const ce = (strike: number, side: "long" | "short", premium: number, qty = 1): OptionLeg => ({
  optionType: "CE", strike, side, premium, qty,
});
const pe = (strike: number, side: "long" | "short", premium: number, qty = 1): OptionLeg => ({
  optionType: "PE", strike, side, premium, qty,
});

describe("catalogue shape", () => {
  it("is exactly the 40 frozen ids, in §4 order", () => {
    expect([...STRATEGY_IDS]).toEqual([
      "long-call", "long-put", "short-call", "short-put",
      "covered-call", "protective-put", "protective-call", "covered-put", "collar",
      "bull-call-spread", "bear-call-spread", "bull-put-spread", "bear-put-spread",
      "long-straddle", "short-straddle", "long-strangle", "short-strangle",
      "iron-condor", "iron-butterfly", "long-call-butterfly", "long-put-butterfly",
      "short-butterfly", "long-call-condor", "short-call-condor", "long-put-condor",
      "reverse-iron-condor", "call-ratio-spread", "put-ratio-spread",
      "call-backspread", "put-backspread",
      "call-calendar-spread", "put-calendar-spread", "diagonal-spread",
      "synthetic-long-stock", "synthetic-short-stock", "split-strike-combo",
      "box-spread", "jade-lizard", "strip-strap", "guts",
    ]);
    expect(STRATEGY_IDS.length).toBe(40);
    expect(CATALOGUE.map((d) => d.id)).toEqual([...STRATEGY_IDS]);
    expect(new Set(STRATEGY_IDS).size).toBe(40);
  });

  it("omits §4 row 38 (covered strangle) and row 42 (ladders)", () => {
    const ids = [...STRATEGY_IDS] as string[];
    for (const absent of ["covered-strangle", "covered-combination", "call-ladder", "put-ladder", "ladder"]) {
      expect(ids).not.toContain(absent);
    }
  });

  it("marks §4 rows 1, 2, 5, 6 and 10 — and only those — as beginner", () => {
    expect(CATALOGUE.filter((d) => d.beginner).map((d) => d.id)).toEqual([
      "long-call", "long-put", "covered-call", "protective-put", "bull-call-spread",
    ]);
  });

  it("pins the 16 legacy display names byte-identically (casing drift re-gates a free strategy)", () => {
    const LEGACY: Record<string, string> = {
      "long-call": "Long Call",
      "long-put": "Long Put",
      "short-call": "Short Call",
      "short-put": "Short Put",
      "long-straddle": "Long Straddle",
      "short-straddle": "Short Straddle",
      "long-strangle": "Long Strangle",
      "short-strangle": "Short Strangle",
      "bull-call-spread": "Bull Call Spread",
      "bear-call-spread": "Bear Call Spread",
      "bear-put-spread": "Bear Put Spread",
      "bull-put-spread": "Bull Put Spread",
      "long-call-butterfly": "Call Butterfly",
      "long-put-butterfly": "Put Butterfly",
      "iron-butterfly": "Iron Butterfly",
      "iron-condor": "Iron Condor",
    };
    expect(Object.keys(LEGACY).length).toBe(16);
    for (const [id, name] of Object.entries(LEGACY)) {
      const def = CATALOGUE.find((d) => d.id === id);
      expect(def, id).toBeDefined();
      expect(def!.name).toBe(name);
      expect(def!.legacyFree, id).toBe(true);
    }
    expect(CATALOGUE.filter((d) => d.legacyFree).map((d) => d.id).sort()).toEqual(
      Object.keys(LEGACY).sort(),
    );
  });

  it("every pattern is well formed: contiguous ranks, coprime integer ratios, UL without a strike", () => {
    for (const def of CATALOGUE) {
      expect(def.patterns.length, def.id).toBeGreaterThan(0);
      for (const p of def.patterns) {
        const strikeRanks = p.legs.filter((l) => l.kind !== "UL").map((l) => l.strikeRank);
        expect(strikeRanks.every((r) => r !== null), def.id).toBe(true);
        const distinct = [...new Set(strikeRanks as number[])].sort((a, b) => a - b);
        expect(distinct, `${def.id} strike ranks`).toEqual(distinct.map((_, i) => i));
        const expiryRanks = [...new Set(p.legs.map((l) => l.expiryRank))].sort((a, b) => a - b);
        expect(expiryRanks, `${def.id} expiry ranks`).toEqual(expiryRanks.map((_, i) => i));
        for (const l of p.legs) {
          expect(Number.isInteger(l.qtyRatio) && l.qtyRatio > 0, def.id).toBe(true);
          if (l.kind === "UL") {
            expect(l.strikeRank, def.id).toBeNull();
            expect(l.expiryRank, def.id).toBe(0);
          }
        }
        const g = p.legs.map((l) => l.qtyRatio).reduce((a, b) => (b === 0 ? a : gcd(a, b)));
        expect(g, `${def.id} ratios must be coprime`).toBe(1);
      }
      // A row with more than one shape must label every one of them.
      if (def.patterns.length > 1) {
        expect(def.patterns.every((p) => !!p.variant), def.id).toBe(true);
        expect(new Set(def.patterns.map((p) => p.variant)).size, def.id).toBe(def.patterns.length);
      }
    }
  });
});

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

// §5.3 property 1 — no two rows can claim the same normalised leg set at equal
// specificity, otherwise the name shown depends on array order.
describe("§5.3 property 1 — no two patterns collide", () => {
  it("every (pattern, specificity) signature in the catalogue is unique", () => {
    const seen = new Map<string, string>();
    for (const def of CATALOGUE) {
      for (const p of def.patterns) {
        const sig =
          `${p.specificity ?? p.legs.length * 10}::` +
          [...p.legs]
            .map((l) => `${l.expiryRank}|${l.strikeRank ?? "-"}|${l.kind}|${l.side}|${l.qtyRatio}`)
            .sort()
            .join(",");
        expect(seen.get(sig), `${def.id} collides with ${seen.get(sig)}`).toBeUndefined();
        seen.set(sig, `${def.id}${p.variant ? ` (${p.variant})` : ""}`);
      }
    }
    expect(seen.size).toBe(CATALOGUE.reduce((n, d) => n + d.patterns.length, 0));
  });
});

// §5.3 property 3 — every entry round-trips: build legs from the pattern,
// classify them, get the same id back. Catches a pattern nobody can hit.
const EXPIRIES = ["2026-06-25", "2026-07-30"];

function legsFromPattern(legs: readonly LegPattern[]): OptionLeg[] {
  return legs.map((l, i): OptionLeg =>
    l.kind === "UL"
      ? { kind: "UL", strike: 0, side: l.side, qty: l.qtyRatio, premium: 100, expiry: null }
      : {
          kind: l.kind,
          optionType: l.kind,
          strike: 100 + 10 * (l.strikeRank as number),
          side: l.side,
          qty: l.qtyRatio,
          premium: 3 + i,
          expiry: EXPIRIES[l.expiryRank],
        },
  );
}

describe("§5.3 property 3 — pattern → legs → id round-trips for all 40 rows", () => {
  for (const def of CATALOGUE) {
    for (const p of def.patterns) {
      it(`${def.id}${p.variant ? ` (${p.variant})` : ""}`, () => {
        const match = matchStrategy(legsFromPattern(p.legs));
        expect(match, def.id).not.toBeNull();
        expect(match!.id).toBe(def.id);
        expect(match!.variant).toBe(p.variant ?? null);
        expect(match!.name).toBe(p.name ?? def.name);
        expect(match!.legacyFree).toBe(def.legacyFree);
      });
    }
  }

  it("also round-trips when the quantities are a multiple of the pattern (GCD reduction)", () => {
    for (const def of CATALOGUE) {
      for (const p of def.patterns) {
        const scaled = legsFromPattern(p.legs).map((l) => ({ ...l, qty: l.qty * 3 }) as OptionLeg);
        expect(matchStrategy(scaled)?.id, def.id).toBe(def.id);
      }
    }
  });
});

// §5.3 property 2 — the §4 closed forms agree with the vertex computation.
interface Fixture {
  id: StrategyId;
  legs: OptionLeg[];
  maxProfit: number | null; // null = unbounded, per §4
  maxLoss: number | null;
  breakevens: number[]; // the §4 breakevens; the computed set must contain them
}

const FIXTURES: Fixture[] = [
  // §4 1–4, singles
  { id: "long-call", legs: [ce(100, "long", 5)], maxProfit: null, maxLoss: -5, breakevens: [105] },
  // Boundary (M-1): a premium above 15 % of the strike puts the breakeven past
  // the chart pad, so the vertex scan alone never reaches it.
  { id: "long-call", legs: [ce(1000, "long", 200)], maxProfit: null, maxLoss: -200, breakevens: [1200] },
  { id: "long-put", legs: [pe(100, "long", 5)], maxProfit: 95, maxLoss: -5, breakevens: [95] },
  { id: "short-call", legs: [ce(100, "short", 5)], maxProfit: 5, maxLoss: null, breakevens: [105] },
  { id: "short-put", legs: [pe(100, "short", 5)], maxProfit: 5, maxLoss: -95, breakevens: [95] },
  // §4 10–13, verticals
  { id: "bull-call-spread", legs: [ce(100, "long", 6), ce(110, "short", 2)], maxProfit: 6, maxLoss: -4, breakevens: [104] },
  { id: "bear-call-spread", legs: [ce(100, "short", 6), ce(110, "long", 2)], maxProfit: 4, maxLoss: -6, breakevens: [104] },
  { id: "bull-put-spread", legs: [pe(90, "long", 2), pe(100, "short", 6)], maxProfit: 4, maxLoss: -6, breakevens: [96] },
  { id: "bear-put-spread", legs: [pe(90, "short", 2), pe(100, "long", 6)], maxProfit: 6, maxLoss: -4, breakevens: [96] },
  // §4 14–17, straddles and strangles
  { id: "long-straddle", legs: [ce(100, "long", 5), pe(100, "long", 5)], maxProfit: null, maxLoss: -10, breakevens: [90, 110] },
  { id: "short-straddle", legs: [ce(100, "short", 5), pe(100, "short", 5)], maxProfit: 10, maxLoss: null, breakevens: [90, 110] },
  { id: "long-strangle", legs: [pe(95, "long", 3), ce(105, "long", 3)], maxProfit: null, maxLoss: -6, breakevens: [89, 111] },
  { id: "short-strangle", legs: [pe(95, "short", 3), ce(105, "short", 3)], maxProfit: 6, maxLoss: null, breakevens: [89, 111] },
  // §4 18–19, iron wings
  {
    id: "iron-condor",
    legs: [pe(90, "long", 1), pe(95, "short", 2), ce(105, "short", 2), ce(110, "long", 1)],
    maxProfit: 2, maxLoss: -3, breakevens: [93, 107],
  },
  {
    id: "iron-butterfly",
    legs: [pe(90, "long", 1), pe(100, "short", 4), ce(100, "short", 4), ce(110, "long", 1)],
    maxProfit: 6, maxLoss: -4, breakevens: [94, 106],
  },
  // §4 20–22, butterflies
  {
    id: "long-call-butterfly",
    legs: [ce(95, "long", 7), ce(100, "short", 4, 2), ce(105, "long", 2)],
    maxProfit: 4, maxLoss: -1, breakevens: [96, 104],
  },
  {
    id: "long-put-butterfly",
    legs: [pe(95, "long", 2), pe(100, "short", 4, 2), pe(105, "long", 7)],
    maxProfit: 4, maxLoss: -1, breakevens: [96, 104],
  },
  {
    id: "short-butterfly",
    legs: [ce(95, "short", 7), ce(100, "long", 4, 2), ce(105, "short", 2)],
    maxProfit: 1, maxLoss: -4, breakevens: [96, 104],
  },
  {
    id: "short-butterfly",
    legs: [pe(95, "short", 2), pe(100, "long", 4, 2), pe(105, "short", 7)],
    maxProfit: 1, maxLoss: -4, breakevens: [96, 104],
  },
  // §4 23–26, condors
  {
    id: "long-call-condor",
    legs: [ce(90, "long", 12), ce(95, "short", 8), ce(105, "short", 3), ce(110, "long", 1)],
    maxProfit: 3, maxLoss: -2, breakevens: [92, 108],
  },
  {
    id: "short-call-condor",
    legs: [ce(90, "short", 12), ce(95, "long", 8), ce(105, "long", 3), ce(110, "short", 1)],
    maxProfit: 2, maxLoss: -3, breakevens: [92, 108],
  },
  {
    id: "long-put-condor",
    legs: [pe(90, "long", 1), pe(95, "short", 3), pe(105, "short", 8), pe(110, "long", 12)],
    maxProfit: 3, maxLoss: -2, breakevens: [92, 108],
  },
  {
    id: "reverse-iron-condor",
    legs: [pe(90, "short", 1), pe(95, "long", 2), ce(105, "long", 2), ce(110, "short", 1)],
    maxProfit: 3, maxLoss: -2, breakevens: [93, 107],
  },
  // §4 27–30, ratios and backspreads
  { id: "call-ratio-spread", legs: [ce(100, "long", 6), ce(105, "short", 2, 2)], maxProfit: 3, maxLoss: null, breakevens: [102, 108] },
  { id: "put-ratio-spread", legs: [pe(95, "short", 2, 2), pe(100, "long", 6)], maxProfit: 3, maxLoss: -92, breakevens: [92, 98] },
  { id: "call-backspread", legs: [ce(100, "short", 6), ce(105, "long", 2, 2)], maxProfit: null, maxLoss: -3, breakevens: [102, 108] },
  { id: "put-backspread", legs: [pe(95, "long", 2, 2), pe(100, "short", 6)], maxProfit: 92, maxLoss: -3, breakevens: [92, 98] },
  // §4 34–37, synthetics, combos and the box
  { id: "synthetic-long-stock", legs: [ce(100, "long", 5), pe(100, "short", 4)], maxProfit: null, maxLoss: -101, breakevens: [101] },
  { id: "synthetic-short-stock", legs: [ce(100, "short", 5), pe(100, "long", 4)], maxProfit: 101, maxLoss: null, breakevens: [101] },
  { id: "split-strike-combo", legs: [pe(95, "short", 2), ce(105, "long", 3)], maxProfit: null, maxLoss: -96, breakevens: [106] },
  {
    id: "box-spread",
    legs: [ce(90, "long", 12), pe(90, "short", 1), ce(100, "short", 5), pe(100, "long", 2)],
    maxProfit: 2, maxLoss: 2, breakevens: [],
  },
  // §4 39–41
  {
    id: "jade-lizard",
    legs: [pe(95, "short", 4), ce(105, "short", 3), ce(110, "long", 1)],
    maxProfit: 6, maxLoss: -89, breakevens: [89],
  },
  { id: "strip-strap", legs: [ce(100, "long", 4), pe(100, "long", 4, 2)], maxProfit: null, maxLoss: -12, breakevens: [94, 112] },
  { id: "strip-strap", legs: [ce(100, "long", 4, 2), pe(100, "long", 4)], maxProfit: null, maxLoss: -12, breakevens: [88, 106] },
  { id: "guts", legs: [ce(95, "long", 8), pe(105, "long", 9)], maxProfit: null, maxLoss: -7, breakevens: [88, 112] },
  { id: "guts", legs: [ce(95, "short", 8), pe(105, "short", 9)], maxProfit: 7, maxLoss: null, breakevens: [88, 112] },
];

describe("§5.3 property 2 — §4 closed forms agree with the vertex computation", () => {
  for (const f of FIXTURES) {
    it(`${f.id} — ${f.legs.map((l) => `${l.side[0]}${l.qty}×${l.strike}${l.kind ?? l.optionType}`).join(" ")}`, () => {
      const s = computeStrategy("X", "2026-06-25", f.legs);
      expect(s.strategyId).toBe(f.id);
      expect(s.maxProfit, "maxProfit").toBe(f.maxProfit);
      expect(s.maxLoss, "maxLoss").toBe(f.maxLoss);
      for (const be of f.breakevens) expect(s.breakevens, "breakevens").toContain(be);
      if (f.breakevens.length === 0) expect(s.breakevens).toEqual([]);
    });
  }

  it("covers EVERY single-expiry, non-underlying row in the catalogue", () => {
    const singleExpiryNoUl = CATALOGUE.filter((d) =>
      d.patterns.every((p) => p.legs.every((l) => l.kind !== "UL" && l.expiryRank === 0)),
    ).map((d) => d.id);
    const covered = [...new Set(FIXTURES.map((f) => f.id))];
    expect(covered.length).toBeGreaterThanOrEqual(21);
    expect([...covered].sort()).toEqual([...singleExpiryNoUl].sort());
  });
});
