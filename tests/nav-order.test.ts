import { describe, expect, it } from "vitest";
import { mergeOrder, moveKey } from "@/components/layout/nav-config";

describe("mergeOrder — a saved nav order must survive app updates", () => {
  const current = ["a", "b", "c", "d"];

  it("no saved order → default order", () => {
    expect(mergeOrder(null, current)).toEqual(current);
    expect(mergeOrder([], current)).toEqual(current);
  });

  it("saved order wins for keys it knows", () => {
    expect(mergeOrder(["d", "a", "c", "b"], current)).toEqual(["d", "a", "c", "b"]);
  });

  it("a screen ADDED by an update slots in at its default position, not the end", () => {
    // User saved when only a,b,d existed; c arrived later between b and d.
    expect(mergeOrder(["d", "b", "a"], current)).toEqual(["d", "b", "c", "a"]);
  });

  it("a screen REMOVED by an update drops out silently", () => {
    expect(mergeOrder(["x", "b", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });

  it("brand-new install after saving nothing relevant → still every current key", () => {
    const out = mergeOrder(["z", "y"], current);
    expect([...out].sort()).toEqual([...current].sort());
  });
});

describe("moveKey", () => {
  it("swaps a step in either direction and clamps at the edges", () => {
    expect(moveKey(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveKey(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveKey(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]); // clamp
    expect(moveKey(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]); // clamp
    expect(moveKey(["a", "b", "c"], "nope", 1)).toEqual(["a", "b", "c"]);
  });
});
