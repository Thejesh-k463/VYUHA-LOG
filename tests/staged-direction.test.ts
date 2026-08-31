import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { summarise, type Leg } from "@/lib/domain/staged";

/**
 * Fix A6 — a short position that has been PARTIALLY covered has buyQty > 0.
 * The old inference (`sellQty > 0 && buyQty === 0`) flipped it to "long" after
 * the first cover, which sign-inverted the P&L rebuilt onto the parent trades
 * row. The heuristic is now `sellQty > buyQty → short`; equal quantities stay
 * "long" — the long-standing shape of fully-closed rows, pinned deliberately.
 * (Heuristic until a stored direction column lands in v3.6.)
 */

let t: TempDb;
let directionOf: typeof import("@/lib/queries/staged")["directionOf"];

beforeAll(async () => {
  t = await openTempDb("staged-direction");
  ({ directionOf } = await import("@/lib/queries/staged"));
});

afterAll(() => t?.cleanup());

describe("directionOf", () => {
  it("keeps a partially covered short SHORT (sell 100, cover 40)", () => {
    expect(directionOf({ buyQty: 40, sellQty: 100 })).toBe("short");
  });

  it("still calls an untouched short short", () => {
    expect(directionOf({ buyQty: 0, sellQty: 100 })).toBe("short");
  });

  it("leaves longs alone, open and partially scaled out", () => {
    expect(directionOf({ buyQty: 100, sellQty: 0 })).toBe("long");
    expect(directionOf({ buyQty: 100, sellQty: 40 })).toBe("long");
  });

  it("pins equal quantities (fully closed) to long — the status quo", () => {
    expect(directionOf({ buyQty: 100, sellQty: 100 })).toBe("long");
  });
});

describe("partially covered short, replayed with the inferred direction", () => {
  // Sell 100 @ 500, cover 40 @ 480 — the parent row reads buyQty 40, sellQty 100.
  const legs: Leg[] = [
    { id: 1, kind: "entry", seq: 1, tradeDate: "2026-01-01", qty: 100, price: 500 },
    { id: 2, kind: "exit", seq: 2, tradeDate: "2026-01-02", qty: 40, price: 480 },
  ];

  it("books the cover as a PROFIT and stays 60 short", () => {
    const pos = summarise(legs, directionOf({ buyQty: 40, sellQty: 100 }));
    expect(pos.direction).toBe("short");
    expect(pos.realisedGross).toBe(800); // (500 − 480) × 40
    expect(pos.openQty).toBe(60);
    expect(pos.isClosed).toBe(false);
  });

  it("would sign-invert under the old buyQty===0 inference — the bug this pins out", () => {
    expect(summarise(legs, "long").realisedGross).toBe(-800);
  });
});
