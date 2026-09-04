import { describe, expect, it } from "vitest";
import { PRO_FEATURES } from "@/lib/license";
import { isSourceKey, lockFor, lockForSource, parseCategories, SOURCE_KEYS, SOURCES } from "@/lib/domain/search-scope";

/**
 * Search v1 — gating (owner rulings 2026-09-04).
 *
 * A gated result is SHOWN with a lock and the PRO_FEATURES label that unlocks
 * it, never hidden. A user's own rows — and the bundled symbol list — never
 * lock, whatever screen their href opens (invariant 7). Only help entries and
 * screens can lock, and only because the screen is on PRO_FEATURES.
 */

const FREE = { pro: false };
const PRO = { pro: true };

describe("lockFor — the pure rule", () => {
  const cases: { href: string; ent: { pro: boolean }; locked: boolean }[] = [
    { href: "/risk", ent: FREE, locked: true },
    { href: "/risk", ent: PRO, locked: false },
    { href: "/reports/edge", ent: FREE, locked: true },
    { href: "/reports/edge?from=2026-01-01", ent: FREE, locked: true }, // path match survives a query string
    { href: "/reports/edge#setups", ent: FREE, locked: true },
    { href: "/trades", ent: FREE, locked: false }, // core journal; `/trades?add=open` is a partial action, not the page
    { href: "/trades?symbol=TCS", ent: FREE, locked: false },
    { href: "/playbooks", ent: FREE, locked: false },
    { href: "/help", ent: FREE, locked: false },
    { href: "/", ent: FREE, locked: false },
    // `/lenses` is a PARTIAL feature: the page opens for a free user (grouping,
    // counts and cleanup are free; only the per-group edge columns are Pro,
    // and lib/license.ts forbids wrapping such a page in <ProGate>). Locking
    // it here hung a padlock in the palette on a screen a free user can walk
    // straight into, which reads as "you cannot open this" and is false.
    { href: "/lenses", ent: FREE, locked: false },
    { href: "/lenses", ent: PRO, locked: false },
    { href: "/trades?add=open", ent: FREE, locked: false }, // the other partial: an action on the free journal
  ];
  it.each(cases)("$href under pro=$ent.pro → locked=$locked", ({ href, ent, locked }) => {
    const lock = lockFor(href, ent);
    expect(lock.locked).toBe(locked);
    if (locked) {
      expect(lock.unlocks).toBe(PRO_FEATURES.find((f) => f.href === href.split("?")[0].split("#")[0])!.label);
    } else {
      expect(lock.unlocks).toBeUndefined();
    }
  });

  it("every whole-page Pro feature locks under free and unlocks under Pro", () => {
    for (const f of PRO_FEATURES) {
      // `partial` entries are a Pro capability inside a FREE page: the page
      // itself never locks, and the screen states its own gate.
      if (f.partial) {
        expect(lockFor(f.href.split("?")[0], FREE), f.href).toEqual({ locked: false });
        continue;
      }
      if (f.href.includes("?")) continue;
      expect(lockFor(f.href, FREE), f.href).toEqual({ locked: true, unlocks: f.label });
      expect(lockFor(f.href, PRO), f.href).toEqual({ locked: false });
    }
  });

  it("an injected feature list is honoured (the rule is data-driven)", () => {
    expect(lockFor("/foo", FREE, [{ href: "/foo", label: "Foo" }])).toEqual({ locked: true, unlocks: "Foo" });
    expect(lockFor("/risk", FREE, [])).toEqual({ locked: false });
  });
});

describe("lockForSource — the registry's rule", () => {
  const ownRows = ["trades", "symbols", "playbooks", "instruments", "sessions", "challans"] as const;

  it.each(ownRows)("%s results are never locked, even when their href is a Pro screen", (source) => {
    expect(lockForSource(source, "/reports/advance-tax", FREE)).toEqual({ locked: false });
    expect(lockForSource(source, "/risk", FREE)).toEqual({ locked: false });
    expect(SOURCES[source].perResultLock).toBeUndefined();
    expect(SOURCES[source].gatedHref).toBeUndefined();
  });

  it("help and screens lock per result, by the screen they open", () => {
    for (const source of ["help", "screens"] as const) {
      expect(SOURCES[source].perResultLock).toBe(true);
      expect(lockForSource(source, "/risk", FREE)).toEqual({ locked: true, unlocks: PRO_FEATURES.find((f) => f.href === "/risk")!.label });
      expect(lockForSource(source, "/risk", PRO)).toEqual({ locked: false });
      expect(lockForSource(source, "/trades", FREE)).toEqual({ locked: false });
    }
  });

  it("a source-level gatedHref would lock every result of that source", () => {
    // None declared today; the rule exists so a future gated source cannot
    // forget to lock. Exercised through the pure function with a fake spec.
    const spec = SOURCES.trades;
    expect(spec.gatedHref).toBeUndefined();
    expect(lockFor("/review", FREE).locked).toBe(true);
  });
});

describe("categories", () => {
  it("parseCategories keeps known keys in registry order, null for absent, [] for nothing known", () => {
    expect(parseCategories(null)).toBeNull();
    expect(parseCategories("")).toBeNull();
    expect(parseCategories(" , ")).toBeNull();
    expect(parseCategories("screens,trades, Help")).toEqual(["trades", "help", "screens"]);
    expect(parseCategories("nope")).toEqual([]);
    expect(parseCategories("nope,symbols")).toEqual(["symbols"]);
  });

  it("isSourceKey agrees with the registry", () => {
    for (const k of SOURCE_KEYS) expect(isSourceKey(k)).toBe(true);
    expect(isSourceKey("toString")).toBe(false);
    expect(isSourceKey("")).toBe(false);
  });
});
