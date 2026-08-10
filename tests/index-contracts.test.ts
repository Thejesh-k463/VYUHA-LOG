import { describe, expect, it } from "vitest";
import {
  BUNDLED_INDEX_LOTS,
  INDEX_CONTRACTS,
  INDEX_LOTS_AS_OF,
  resolveIndexLot,
} from "@/lib/domain/index-contracts";
import { BSE_INDEX_UNDERLYINGS, INDEX_UNDERLYINGS } from "@/lib/domain/constants";

describe("INDEX_CONTRACTS covers the engine's vocabulary exactly", () => {
  it("one picker row per INDEX_UNDERLYING, in order — no invented, none missing", () => {
    // The engine classifies six index underlyings; a picker showing fewer
    // lies about what the app understands, one showing more invents markets.
    expect(INDEX_CONTRACTS.map((c) => c.symbol)).toEqual([...INDEX_UNDERLYINGS]);
  });

  it("every row has a human label distinct from the raw symbol", () => {
    for (const c of INDEX_CONTRACTS) {
      expect(c.label.length, c.symbol).toBeGreaterThan(0);
      expect(c.label, c.symbol).not.toBe(c.symbol);
    }
  });

  it("routes exactly the BSE underlyings to BSE — same split classify.ts applies", () => {
    for (const c of INDEX_CONTRACTS) {
      const expected = (BSE_INDEX_UNDERLYINGS as readonly string[]).includes(c.symbol) ? "BSE" : "NSE";
      expect(c.exchange, c.symbol).toBe(expected);
    }
  });
});

describe("the bundled lot snapshot", () => {
  it("has a positive integer lot for every underlying", () => {
    for (const u of INDEX_UNDERLYINGS) {
      const lot = BUNDLED_INDEX_LOTS[u];
      expect(Number.isInteger(lot), u).toBe(true);
      expect(lot, u).toBeGreaterThan(0);
    }
  });

  it("carries an ISO asOf date — a snapshot without a date is a trap", () => {
    expect(INDEX_LOTS_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches the January 2026 series revision it claims to be", () => {
    // Pinned to the verified circular values (docs/DECISIONS.md 2026-08-10:
    // NSE FAOP70616 + BSE notices, cross-checked against two broker tables).
    // If a later circular changes a lot, update the literal AND the AS_OF
    // together — this test failing is the reminder.
    expect(BUNDLED_INDEX_LOTS).toEqual({
      NIFTY: 65,
      BANKNIFTY: 30,
      FINNIFTY: 60,
      MIDCPNIFTY: 120,
      SENSEX: 20,
      BANKEX: 30,
    });
    expect(INDEX_LOTS_AS_OF).toBe("2026-01-01");
  });
});

describe("resolveIndexLot — the user's own upload beats the bundle", () => {
  it("prefers a positive instruments-table lot, with its own date", () => {
    const r = resolveIndexLot("NIFTY", { lotSize: 70, asOf: "2026-07-30" });
    expect(r).toEqual({ lot: 70, source: "instruments", asOf: "2026-07-30" });
  });

  it("falls back to the bundle when the row is absent", () => {
    for (const dbRow of [null, undefined]) {
      const r = resolveIndexLot("SENSEX", dbRow);
      expect(r).toEqual({ lot: 20, source: "bundled", asOf: INDEX_LOTS_AS_OF });
    }
  });

  it("treats a null, zero or negative DB lot as absent — a 0-lot contract does not exist", () => {
    for (const bad of [null, 0, -5]) {
      const r = resolveIndexLot("BANKNIFTY", { lotSize: bad });
      expect(r.source, String(bad)).toBe("bundled");
      expect(r.lot, String(bad)).toBe(30);
    }
  });

  it("a DB row with no date still resolves — with an empty asOf, never an invented one", () => {
    const r = resolveIndexLot("FINNIFTY", { lotSize: 60 });
    expect(r.source).toBe("instruments");
    expect(r.asOf).toBe("");
  });
});
