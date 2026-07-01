import { describe, it, expect } from "vitest";
import { diffFields } from "@/lib/analytics/audit-diff";

describe("diffFields", () => {
  it("reports only changed fields", () => {
    const d = diffFields({ a: 1, b: 2, c: "x" }, { a: 1, b: 5, c: "x" });
    expect(d).toEqual([{ field: "b", from: 2, to: 5 }]);
  });

  it("captures added and removed keys as null transitions", () => {
    const d = diffFields({ a: 1 }, { a: 1, b: 9 });
    expect(d).toEqual([{ field: "b", from: null, to: 9 }]);
    const d2 = diffFields({ a: 1, b: 9 }, { a: 1 });
    expect(d2).toEqual([{ field: "b", from: 9, to: null }]);
  });

  it("honours an explicit field list and order", () => {
    const d = diffFields({ x: 1, y: 2 }, { x: 3, y: 4 }, ["y", "x"]);
    expect(d.map((c) => c.field)).toEqual(["y", "x"]);
  });

  it("treats deep-equal values as unchanged", () => {
    expect(diffFields({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(diffFields(null, null)).toEqual([]);
    expect(diffFields({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
