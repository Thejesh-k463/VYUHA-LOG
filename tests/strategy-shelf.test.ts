import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  DEFAULT_SHELF,
  SHELF_UNDO_DEPTH,
  canRedo,
  canUndo,
  defaultShelf,
  initShelfHistory,
  parseShelf,
  serializeShelf,
  shelfJsonEquivalent,
  shelfReducer,
  type ShelfHistory,
  type ShelfState,
} from "@/lib/domain/strategy-shelf";

/**
 * The shelf is a PREFERENCE with three failure modes, and each one is silent:
 * an unreadable stored value read as "nothing selected", an undo that skips a
 * step, and a migration with no journal entry (AGENTS.md, 0027+) that leaves
 * the column absent so every save fails with "no such column".
 */

// A stand-in catalogue. B1 owns the real 40-id list
// (lib/analytics/strategy-catalogue.ts); parseShelf takes the ids as an
// argument precisely so this file can fuzz it without one.
const VALID = [...DEFAULT_SHELF, "short-strangle", "calendar-spread", "butterfly"];

describe("parseShelf — an unreadable value is DEFAULTS, never a partial read", () => {
  it("falls back to the eight defaults for null, empty and broken JSON", () => {
    for (const raw of [null, "", "not json", "{", "[1,2,3]"]) {
      expect(parseShelf(raw, VALID).selected, `raw=${JSON.stringify(raw)}`).toEqual([...DEFAULT_SHELF]);
    }
  });

  it("falls back for an alien SHAPE or an alien VERSION", () => {
    // `{}` has no version; `{v:2}` is a shape this release cannot read; a
    // non-array `selected` is the half-read that must never happen.
    for (const raw of ['{}', '{"v":2,"selected":["long-call"]}', '{"v":1}', '{"v":1,"selected":"long-call"}',
                       '{"v":"1","selected":[]}', "null", "true", '"long-call"']) {
      expect(parseShelf(raw, VALID).selected, `raw=${raw}`).toEqual([...DEFAULT_SHELF]);
    }
  });

  it("drops ids the catalogue no longer knows, and non-string members", () => {
    const raw = '{"v":1,"selected":["long-call","made-up-strategy","iron-condor",7,null,{"id":"x"}]}';
    expect(parseShelf(raw, VALID).selected).toEqual(["long-call", "iron-condor"]);
  });

  it("removes duplicates and preserves the user's order", () => {
    const raw = '{"v":1,"selected":["iron-condor","long-put","iron-condor","long-call","long-put"]}';
    expect(parseShelf(raw, VALID).selected).toEqual(["iron-condor", "long-put", "long-call"]);
  });

  it("keeps an EMPTY shelf empty — 'nothing on my shelf' is a real choice", () => {
    // Only an UNREADABLE value falls back. If an empty envelope returned the
    // defaults, the one thing the user cannot express is an empty shelf.
    expect(parseShelf('{"v":1,"selected":[]}', VALID).selected).toEqual([]);
    // …and so does an envelope whose every id has been retired.
    expect(parseShelf('{"v":1,"selected":["gone-1","gone-2"]}', VALID).selected).toEqual([]);
  });

  it("hands back a fresh array each time — no caller can mutate the defaults", () => {
    const a = parseShelf(null, VALID);
    a.selected.push("mutated");
    expect(parseShelf(null, VALID).selected).toEqual([...DEFAULT_SHELF]);
    expect(DEFAULT_SHELF).not.toContain("mutated");
  });

  it("round-trips through serializeShelf", () => {
    const state: ShelfState = { selected: ["long-straddle", "long-call"] };
    const raw = serializeShelf(state);
    expect(JSON.parse(raw)).toEqual({ v: 1, selected: ["long-straddle", "long-call"] });
    expect(parseShelf(raw, VALID)).toEqual(state);
  });
});

describe("DEFAULT_SHELF is the owner's eight, in the owner's order", () => {
  it("is exactly these ids", () => {
    expect([...DEFAULT_SHELF]).toEqual([
      "long-call", "long-put", "bull-call-spread", "bear-put-spread",
      "bull-put-spread", "bear-call-spread", "long-straddle", "iron-condor",
    ]);
  });
});

describe("shelfReducer — the undo/redo laws", () => {
  const start = (): ShelfHistory => initShelfHistory({ selected: ["long-call"] });

  it("undo ∘ do = identity, for every mutating action", () => {
    const cases: Parameters<typeof shelfReducer>[1][] = [
      { type: "select", id: "iron-condor" },
      { type: "unselect", id: "long-call" },
      { type: "set", ids: ["long-put", "long-straddle"] },
      { type: "restore" },
    ];
    for (const action of cases) {
      const h0 = start();
      const done = shelfReducer(h0, action);
      expect(done.present.selected, `${action.type} changed nothing`).not.toEqual(h0.present.selected);
      const back = shelfReducer(done, { type: "undo" });
      expect(back.present.selected, `undo after ${action.type}`).toEqual(h0.present.selected);
    }
  });

  it("redo after undo returns to where the undo came from", () => {
    const h = shelfReducer(start(), { type: "select", id: "iron-condor" });
    const undone = shelfReducer(h, { type: "undo" });
    expect(canRedo(undone)).toBe(true);
    const redone = shelfReducer(undone, { type: "redo" });
    expect(redone.present.selected).toEqual(["long-call", "iron-condor"]);
    expect(canRedo(redone)).toBe(false);
  });

  it("a NEW action clears the redo stack — a branch that was undone is unreachable", () => {
    const h = shelfReducer(start(), { type: "select", id: "iron-condor" });
    const undone = shelfReducer(h, { type: "undo" });
    const branched = shelfReducer(undone, { type: "select", id: "long-straddle" });
    expect(branched.future).toEqual([]);
    expect(canRedo(branched)).toBe(false);
    // Redo on an empty future is a no-op, not a throw and not a resurrection.
    expect(shelfReducer(branched, { type: "redo" })).toBe(branched);
    expect(branched.present.selected).toEqual(["long-call", "long-straddle"]);
  });

  it("a NO-OP action does not consume an undo step", () => {
    const h = start();
    // Selecting what is already selected, unselecting what is not there, and
    // setting the same list are all nothing happening; if they pushed history,
    // one Ctrl+Z would do nothing visible and read as broken undo.
    expect(shelfReducer(h, { type: "select", id: "long-call" })).toBe(h);
    expect(shelfReducer(h, { type: "unselect", id: "iron-condor" })).toBe(h);
    expect(shelfReducer(h, { type: "set", ids: ["long-call"] })).toBe(h);
    expect(canUndo(h)).toBe(false);
    // …and undo on an empty past is a no-op too.
    expect(shelfReducer(h, { type: "undo" })).toBe(h);
  });

  it("is bounded at SHELF_UNDO_DEPTH — the oldest step falls off, the newest survive", () => {
    let h = initShelfHistory({ selected: [] });
    const n = SHELF_UNDO_DEPTH + 10;
    for (let i = 0; i < n; i++) h = shelfReducer(h, { type: "set", ids: [`s-${i}`] });
    expect(h.past.length).toBe(SHELF_UNDO_DEPTH);
    for (let i = 0; i < SHELF_UNDO_DEPTH; i++) h = shelfReducer(h, { type: "undo" });
    expect(canUndo(h)).toBe(false);
    // 60 steps deep with a 50-step memory: the 10 oldest are gone for good.
    expect(h.present.selected).toEqual([`s-${n - SHELF_UNDO_DEPTH - 1}`]);
  });

  it("restore puts back exactly DEFAULT_SHELF, and is itself undoable", () => {
    const mine: ShelfState = { selected: ["butterfly", "calendar-spread"] };
    const h = shelfReducer(initShelfHistory(mine), { type: "restore" });
    expect(h.present.selected).toEqual([...DEFAULT_SHELF]);
    expect(shelfReducer(h, { type: "undo" }).present.selected).toEqual(mine.selected);
  });

  it("set() dedupes, and the history never aliases the defaults", () => {
    const h = shelfReducer(initShelfHistory({ selected: [] }), { type: "set", ids: ["a", "b", "a"] });
    expect(h.present.selected).toEqual(["a", "b"]);
    const r = shelfReducer(h, { type: "restore" });
    r.present.selected.push("mutated");
    expect(defaultShelf().selected).toEqual([...DEFAULT_SHELF]);
  });
});

/* ────────────── the column, on a really migrated database ───────────────── */

let t: TempDb;
beforeAll(async () => {
  t = await openTempDb("shelf", { seed: true });
});
afterAll(() => t?.cleanup());

describe("migration 0071 — settings.strategy_shelf_json, on a really migrated database", () => {
  /**
   * A hand-written migration with no `drizzle/meta/_journal.json` entry is
   * SILENTLY SKIPPED (AGENTS.md, migrations 0027+), and the failure then
   * surfaces as a SQLite "no such column" the first time somebody saves a
   * shelf. This asserts the column exists where it matters — in a database
   * built by running the migrations — and that it round-trips the envelope.
   */
  it("exists on the migrated schema, nullable and with no default", () => {
    const cols = t.sqlite.prepare("PRAGMA table_info(settings)").all() as
      { name: string; type: string; notnull: number; dflt_value: string | null }[];
    const col = cols.find((c) => c.name === "strategy_shelf_json");
    expect(col, "migration 0071 did not run — is it in drizzle/meta/_journal.json?").toBeDefined();
    expect(col!.type.toLowerCase()).toBe("text");
    // NULL is the honest default: an upgraded install has picked no shelf, and
    // a stored copy of the defaults would freeze this release's list forever.
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  it("is null on a seeded install, and null reads as the eight defaults", () => {
    const row = t.db.select({ shelf: t.schema.settings.strategyShelfJson }).from(t.schema.settings).limit(1).all()[0];
    expect(row?.shelf ?? null).toBeNull();
    expect(parseShelf(row?.shelf ?? null, VALID).selected).toEqual([...DEFAULT_SHELF]);
  });

  it("round-trips a shelf through the real column", () => {
    const mine: ShelfState = { selected: ["iron-condor", "long-put"] };
    t.db.update(t.schema.settings).set({ strategyShelfJson: serializeShelf(mine) }).run();
    const back = t.db.select({ shelf: t.schema.settings.strategyShelfJson }).from(t.schema.settings).limit(1).all()[0];
    expect(parseShelf(back!.shelf, VALID)).toEqual(mine);
    // Leave the row as the rest of the file found it.
    t.db.update(t.schema.settings).set({ strategyShelfJson: null }).run();
  });
});

describe("shelfJsonEquivalent — null and the explicit eight are ONE value (S-1)", () => {
  // The column carries two encodings of "the eight defaults": null (an untouched
  // install) and the explicit envelope the shelf route's `restore` writes. A
  // by-string diff calls those different and "Restoring would change:" names a
  // field nothing would change -- a phantom, and invariant 6 in miniature.
  const explicitDefault = serializeShelf(defaultShelf());
  const nine = serializeShelf({ selected: [...DEFAULT_SHELF, "short-strangle"] });

  it("treats null and the explicit default envelope as the same value", () => {
    expect(shelfJsonEquivalent(null, explicitDefault)).toBe(true);
    expect(shelfJsonEquivalent(explicitDefault, null)).toBe(true);
    expect(shelfJsonEquivalent(null, null)).toBe(true);
  });

  it("does NOT treat null as a shelf the user actually changed", () => {
    expect(shelfJsonEquivalent(null, nine)).toBe(false);
    expect(shelfJsonEquivalent(nine, null)).toBe(false);
    // Emptying the shelf is a real choice and must read as a difference.
    expect(shelfJsonEquivalent(null, serializeShelf({ selected: [] }))).toBe(false);
  });

  it("compares two envelopes by their selection, not their bytes", () => {
    expect(shelfJsonEquivalent(nine, JSON.stringify(JSON.parse(nine)))).toBe(true);
    expect(shelfJsonEquivalent(nine, '{ "v": 1, "selected": ' + JSON.stringify(JSON.parse(nine).selected) + " }")).toBe(true);
    // Order is part of the preference -- the shelf renders in the order stored.
    expect(shelfJsonEquivalent(explicitDefault, serializeShelf({ selected: [...DEFAULT_SHELF].reverse() }))).toBe(false);
  });

  it("falls back to string equality for anything that is not an envelope", () => {
    expect(shelfJsonEquivalent("not json", null)).toBe(false);
    expect(shelfJsonEquivalent("not json", "not json")).toBe(true);
    expect(shelfJsonEquivalent("not json", "other junk")).toBe(false);
    // A future version is not readable, so it is not equal to the defaults.
    expect(shelfJsonEquivalent(null, '{"v":2,"selected":[]}')).toBe(false);
  });

  it("needs no catalogue: unknown ids are compared, never validated", () => {
    const alien = serializeShelf({ selected: ["no-such-strategy"] });
    expect(shelfJsonEquivalent(alien, alien)).toBe(true);
    expect(shelfJsonEquivalent(alien, null)).toBe(false);
  });
});
