import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aliasHeld, heldIdentityHashes, lotIdentityHashes, readsLong, withStaleCloseNote } from "@/lib/import/close-open-lots";

/**
 * V1 (v4.3.0 wave 2H fourth seam fix) — ONE predicate for "this row's
 * `dedup-alias:` segments still record the trade they name".
 *
 * H1 keeps a joined lot's alias when the trade editor re-opens it (sell 0). U1
 * made the restore refusal stop counting such an alias, but the sale's own
 * recovery paths (H3's restore skip, R26's re-import dedup) still did, so the
 * sale was on no row and nothing could bring it back. An alias is identity ONLY
 * while its holder's closing leg holds quantity — a long's sell leg, a short's
 * buy leg, read the way H1 reads a row (the exit is the later date). The row's
 * OWN hash always counts.
 */

const OWN = "a".repeat(40);
const SALE = "b".repeat(40);
const notes = withStaleCloseNote(null, SALE);

type Legs = { buyQty: number; sellQty: number; buyDate: string | null; sellDate: string | null; side?: string | null };
const lot = (legs: Legs) => ({ dedupHash: OWN, importNotes: notes, ...legs });

describe("aliasHeld — the unit matrix", () => {
  const cases: [string, Legs, boolean, boolean][] = [
    // name, legs, readsLong, aliasHeld
    ["long closed (buy 08-20, sell 08-25)", { buyQty: 100, sellQty: 100, buyDate: "2026-08-20", sellDate: "2026-08-25" }, true, true],
    ["long re-opened in the editor (sell 0, date blank)", { buyQty: 100, sellQty: 0, buyDate: "2026-08-20", sellDate: null }, true, false],
    ["long partly re-made (sell 60 of 100)", { buyQty: 100, sellQty: 60, buyDate: "2026-08-20", sellDate: "2026-08-25" }, true, true],
    ["short closed (sell 08-20, cover 08-25)", { buyQty: 100, sellQty: 100, buyDate: "2026-08-25", sellDate: "2026-08-20" }, false, true],
    ["short re-opened in the editor (buy 0, date blank)", { buyQty: 0, sellQty: 100, buyDate: null, sellDate: "2026-08-20" }, false, false],
    ["short partly covered (buy 40 of 100)", { buyQty: 40, sellQty: 100, buyDate: "2026-08-25", sellDate: "2026-08-20" }, false, true],
    // RE-PINNED v4.6.0 W6 (contract D1 clause 3): an undated flat row with no
    // stated side and no intraday-short note reads LONG — it read as neither
    // before, which `readsLong` answered false. Held either way. (Fix wave,
    // finding 2: `backfillSide` now answers null for this no-signal row and
    // `sideOf` — which `readsLong` reads — falls back to long, so the reading
    // here is unchanged; only `statedSideOf` says it states no side.)
    ["closed with no ordered dates (both legs hold quantity)", { buyQty: 100, sellQty: 100, buyDate: null, sellDate: null }, true, true],
    // …and a flat row that STATES its side (migration 0077) reads that side.
    ["closed, no dates, stated short", { buyQty: 100, sellQty: 100, buyDate: null, sellDate: null, side: "short" }, false, true],
    ["closed same day, stated short (a covered intraday short)", { buyQty: 100, sellQty: 100, buyDate: "2026-08-20", sellDate: "2026-08-20", side: "short" }, false, true],
  ];

  it.each(cases)("%s", (_name, legs, long, held) => {
    expect([readsLong(legs), aliasHeld(lot(legs))]).toEqual([long, held]);
    expect(heldIdentityHashes(lot(legs))).toEqual(held ? [OWN, SALE] : [OWN]);
    // lotIdentityHashes stays the full set: the restore re-key and the duplicate
    // scan still read every alias.
    expect(lotIdentityHashes(lot(legs))).toEqual([OWN, SALE]);
  });

  it("the row's OWN hash always counts, and a row with no alias answers with it alone", () => {
    const open = { buyQty: 100, sellQty: 0, buyDate: "2026-08-20", sellDate: null };
    expect(heldIdentityHashes({ dedupHash: OWN, importNotes: null, ...open })).toEqual([OWN]);
    expect(heldIdentityHashes({ dedupHash: OWN, importNotes: notes, ...open })).toEqual([OWN]);
    expect(heldIdentityHashes({ dedupHash: OWN, importNotes: null, buyQty: 100, sellQty: 100, buyDate: "2026-08-20", sellDate: "2026-08-25" })).toEqual([OWN]);
  });

  it("one definition: lib/trash.ts imports the long/short reading instead of keeping its own copy", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib", "trash.ts"), "utf8");
    expect(src).not.toMatch(/const\s+readsLong\s*=/);
    expect(src).not.toMatch(/const\s+holdsClose\s*=/);
    expect(src).toMatch(/import \{[^}]*\breadsLong\b[^}]*\} from "@\/lib\/import\/close-open-lots"/);
  });
});
