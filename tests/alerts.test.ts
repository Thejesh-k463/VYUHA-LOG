import { describe, expect, it } from "vitest";
import { detectBreaches, type AlertPositionInput } from "../lib/risk/alerts";

const pos = (over: Partial<AlertPositionInput>): AlertPositionInput => ({
  id: 1,
  symbol: "X",
  side: "long",
  qty: 100,
  entry: 100,
  mtm: 100,
  slPlanned: null,
  trailingSl: null,
  targetPlanned: null,
  riskAmount: null,
  ...over,
});

describe("detectBreaches", () => {
  it("long SL breach when mark is at/below the stop", () => {
    const b = detectBreaches([pos({ slPlanned: 95, mtm: 94 })]);
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("sl");
    expect(b[0].level).toBe(95);
  });

  it("no breach while the mark holds above a long stop", () => {
    expect(detectBreaches([pos({ slPlanned: 95, mtm: 96 })])).toHaveLength(0);
  });

  it("short SL breach when mark rises to/through the stop", () => {
    const b = detectBreaches([pos({ side: "short", entry: 100, slPlanned: 105, mtm: 106 })]);
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("sl");
  });

  it("TSL supersedes SL — one stop alert, not two", () => {
    const b = detectBreaches([pos({ slPlanned: 90, trailingSl: 98, mtm: 97 })]);
    expect(b.filter((x) => x.kind === "tsl")).toHaveLength(1);
    expect(b.filter((x) => x.kind === "sl")).toHaveLength(0);
  });

  it("target reached (long) reports alongside nothing else when stop holds", () => {
    const b = detectBreaches([pos({ slPlanned: 95, targetPlanned: 110, mtm: 111 })]);
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("target");
  });

  it("short target = mark falling to the level", () => {
    const b = detectBreaches([pos({ side: "short", entry: 100, targetPlanned: 90, mtm: 89 })]);
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("target");
  });

  it("stops sort before targets; deeper breach first", () => {
    const b = detectBreaches([
      pos({ id: 1, symbol: "A", targetPlanned: 110, mtm: 112 }),
      pos({ id: 2, symbol: "B", slPlanned: 95, mtm: 90 }),
      pos({ id: 3, symbol: "C", slPlanned: 95, mtm: 94.9 }),
    ]);
    expect(b.map((x) => x.symbol)).toEqual(["B", "C", "A"]);
  });

  it("ignores positions with no mark or zero qty and null levels", () => {
    expect(detectBreaches([pos({ mtm: 0, slPlanned: 95 }), pos({ qty: 0, slPlanned: 95, mtm: 90 }), pos({})])).toHaveLength(0);
  });

  it("messages tell the user to verify a live quote (caution framing)", () => {
    const b = detectBreaches([pos({ slPlanned: 95, mtm: 94 })]);
    expect(b[0].message).toMatch(/review your exit plan/);
  });
});
