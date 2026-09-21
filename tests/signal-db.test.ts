import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { SIGNAL_TOMBSTONE, emptySignal, parseSeededSignalNotes, parseSignal, serializeSignal } from "@/lib/domain/signal";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";

/**
 * THE SIGNAL BOOK against a real migrated database (v4.3.0, migration 0072).
 *
 * The pure half is `tests/signal-domain-analytics.test.ts`. Everything here is
 * behaviour that IS the I/O: the column exists and defaults to NULL, the two
 * writers carry it, NOTHING ELSE ON THE ROW MOVES BECAUSE OF IT, the seeded
 * notes are read back by the data fix, and the value survives every sequence
 * that carries a trades row — a backup round trip, a Trash restore, and a
 * same-day re-pull that supersedes the row in place.
 *
 * ONE temp database for the FILE (AGENTS.md: `lib/db` caches its connection on
 * globalThis, so a second `openTempDb()` here would silently reuse this one).
 * `temp-db.ts` runs the data fixes when it opens, so every test that drives the
 * backfill DELETES ITS MARKER first, or goes through `rerunDataFixesAfterRestore`
 * — never through a quiet guard, which `runDataFixes` would mark as done.
 */

const ROOT = path.resolve(__dirname, "..");
const PRIMARY = 1;
const SECOND = 2;

/** The four-line note `scripts/seed-options-account.ts` writes. */
const SEEDED_NOTES = [
  "Options strategy log #12 · TIER 1 — HIGH CONVICTION",
  "Spot 672.6 · S/R zone 687.22 - 692 · Day H/L 10.5/7.55",
  "T1 14.48 · T2 19.3 · SL 6.27 · Exit: TARGET 2 HIT (75.00%)",
  "ΔOI -3.21% (unwind) · Volume 2443",
].join("\n");

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let fixes: typeof import("@/lib/db/data-fixes");
let backup: typeof import("@/lib/backup");
let del: typeof import("@/lib/queries/delete");
let trash: typeof import("@/lib/trash");
let signals: typeof import("@/lib/queries/signals");
let day: typeof import("@/lib/domain/trading-day");

/** A manual option NormalizedTrade — the Add form's own shape. */
function optionTrade(over: Partial<NormalizedTrade> = {}): NormalizedTrade {
  return {
    broker: "zerodha",
    tradingsymbol: "OPT TATAMOTORS 26 Jun 2026 700 CE",
    isin: null,
    buyQty: 500,
    avgBuyPrice: 9.65,
    buyValue: 4825,
    sellQty: 500,
    avgSellPrice: 16.8875,
    sellValue: 8443.75,
    closingPrice: null,
    grossPnl: 3618.75,
    unrealisedPnl: 0,
    buyDate: "2026-06-11",
    sellDate: "2026-06-11",
    productHint: null,
    exchangeHint: null,
    sourceFile: "manual",
    ...over,
  } as NormalizedTrade;
}

const raw = (id: number) => t.sqlite.prepare("SELECT * FROM trades WHERE id = ?").get(id) as Record<string, unknown>;
const signalOf = (id: number) => (raw(id).signal_json ?? null) as string | null;
const setSignal = (id: number, v: string | null) => t.sqlite.prepare("UPDATE trades SET signal_json = ? WHERE id = ?").run(v, id);
const forgetMarker = (name: string) => t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(name);
const selectAccount = (id: number) => t.sqlite.prepare("UPDATE settings SET selected_account_id = ?").run(id);

/** Every column but the ones a second row is ALLOWED to differ in. */
function comparable(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const k of ["id", "account_id", "created_at", "updated_at", "signal_json"]) delete out[k];
  return out;
}

beforeAll(async () => {
  t = await openTempDb("signal", { seed: true });
  commit = await import("@/lib/import/commit");
  fixes = await import("@/lib/db/data-fixes");
  backup = await import("@/lib/backup");
  del = await import("@/lib/queries/delete");
  trash = await import("@/lib/trash");
  signals = await import("@/lib/queries/signals");
  day = await import("@/lib/domain/trading-day");
  t.db.insert(t.schema.accounts).values({ id: SECOND, name: "Signal book B", isDefault: false }).run();
});

afterAll(() => t?.cleanup());

describe("migration 0072", () => {
  it("is in the journal, has its .sql file, and the column arrives NULL", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.idx === 72)!;
    expect(entry?.tag).toBe("0072_trades-signal-json");
    // Contiguous indexes: a gap means a migration that never runs.
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    expect(fs.existsSync(path.join(ROOT, "drizzle", `${entry.tag}.sql`))).toBe(true);

    const cols = t.sqlite.prepare("PRAGMA table_info(trades)").all() as { name: string; notnull: number; dflt_value: unknown }[];
    const col = cols.find((c) => c.name === "signal_json")!;
    expect(col, "0072 must have added trades.signal_json").toBeTruthy();
    expect([col.notnull, col.dflt_value], "nullable, no default — NULL is the honest value").toEqual([0, null]);

    const id = commit.commitManualTrade(optionTrade({ tradingsymbol: "OPT TCS 26 Jun 2026 3000 CE" }), {}, PRIMARY).id!;
    expect(signalOf(id), "an option entered with no signal is not a signal trade").toBeNull();
  });
});

describe("THE MONEY IS UNTOUCHED", () => {
  it("the same option, with and without a signal, stores identical money, charge, qty, dedup and R columns", () => {
    const json = serializeSignal({ ...emptySignal(), model: "S1", spot: 672.6, t1: 14.48, t2: 19.3, sl: 6.27, exitStatus: "T2_HIT" })!;
    // The SAME trade in two accounts: `dedup_hash` spans (account, broker, hash),
    // so the two rows are identical in every column including the hash — which is
    // the point. A signal must not re-key a row, or a re-import would double it.
    const plain = commit.commitManualTrade(optionTrade(), {}, PRIMARY).id!;
    const withSignal = commit.commitManualTrade(optionTrade(), { signalJson: json }, SECOND).id!;
    expect(signalOf(withSignal)).toBe(json);
    expect(signalOf(plain)).toBeNull();
    expect(comparable(raw(withSignal))).toEqual(comparable(raw(plain)));
    // Named explicitly too, so a future column added to BOTH rows cannot hide a move.
    const named = ["buy_qty", "avg_buy_price", "buy_value_paise", "sell_qty", "avg_sell_price", "sell_value_paise", "gross_pnl_paise", "charges_total_paise", "net_pnl_paise", "brokerage_paise", "stt_ctt_paise", "gst_paise", "risk_amount_paise", "r_multiple", "dedup_hash"];
    for (const c of named) expect(raw(withSignal)[c], `${c} moved because of a signal`).toEqual(raw(plain)[c]);
  });

  it("a signal-only EDIT moves nothing else on the row", () => {
    const id = commit.commitManualTrade(optionTrade({ tradingsymbol: "OPT INFY 26 Jun 2026 1800 CE" }), {}, PRIMARY).id!;
    const before = comparable(raw(id));
    const res = commit.updateManualTrade(id, { signalJson: '{"v":1,"model":"S2","t1":14.48}' });
    expect(res.ok).toBe(true);
    expect(comparable(raw(id))).toEqual(before);
    expect(signalOf(id)).toBe('{"v":1,"model":"S2","t1":14.48}');
  });
});

describe("the edit rule: undefined keeps, null clears, a non-option never carries one", () => {
  it("undefined keeps the stored signal; an explicit clear stores the TOMBSTONE, not NULL", () => {
    const id = commit.commitManualTrade(optionTrade({ tradingsymbol: "OPT SBIN 26 Jun 2026 800 CE" }), { signalJson: '{"v":1,"model":"S1"}' }, PRIMARY).id!;
    commit.updateManualTrade(id, { notes: "just a note" });
    expect(signalOf(id), "a save that never mentions the signal keeps it").toBe('{"v":1,"model":"S1"}');

    expect(commit.updateManualTrade(id, { signalJson: null }).ok).toBe(true);
    expect(signalOf(id), "a clear leaves a tombstone so a restore cannot resurrect it").toBe(SIGNAL_TOMBSTONE);
    expect(parseSignal(signalOf(id))).toBeNull();
  });

  it("a stored envelope from a NEWER version is kept, and the save says so", () => {
    const id = commit.commitManualTrade(optionTrade({ tradingsymbol: "OPT WIPRO 26 Jun 2026 300 CE" }), {}, PRIMARY).id!;
    setSignal(id, '{"v":2,"model":"S1","regime":"trend"}');
    const res = commit.updateManualTrade(id, { signalJson: '{"v":1,"model":"S2"}' });
    expect(res.ok).toBe(true);
    expect(signalOf(id), "one keystroke must not replace a richer envelope with a one-field v1").toBe('{"v":2,"model":"S1","regime":"trend"}');
    expect(res.message).toContain("recorded by a newer version");
  });

  it("an EQUITY trade forces null on both doors — a signal describes a strike's chain", () => {
    const eq = commit.commitManualTrade(
      optionTrade({ tradingsymbol: "TATAMOTORS", buyDate: "2026-06-12", sellDate: "2026-06-12" }),
      { signalJson: '{"v":1,"model":"S1"}' },
      PRIMARY,
    ).id!;
    expect(signalOf(eq)).toBeNull();
    commit.updateManualTrade(eq, { signalJson: '{"v":1,"model":"S1"}' });
    expect(signalOf(eq)).toBeNull();
  });
});

describe("signal-notes-backfill-v1", () => {
  let good: number;
  let bad: number;

  beforeAll(() => {
    good = commit.commitManualTrade(
      optionTrade({ tradingsymbol: "OPT HDFCBANK 26 Jun 2026 2000 CE" }),
      { notes: SEEDED_NOTES, setupTag: "CE BREAKOUT (RES)" },
      SECOND,
    ).id!;
    bad = commit.commitManualTrade(
      optionTrade({ tradingsymbol: "OPT ITC 26 Jun 2026 400 CE" }),
      { notes: SEEDED_NOTES + "\nand a fifth line nobody planned for", setupTag: "CE BREAKOUT (RES)" },
      SECOND,
    ).id!;
  });

  it("reads the seeded note into the envelope, leaves the notes byte-equal, and refuses the rest", () => {
    const notesBefore = raw(good).notes;
    forgetMarker(fixes.SIGNAL_NOTES_BACKFILL_FIX);
    const [res] = fixes.runDataFixes(t.sqlite).filter((r) => r.name === fixes.SIGNAL_NOTES_BACKFILL_FIX);
    expect([res.applied, res.rekeyed, res.skippedCollisions]).toEqual([true, 1, 1]);

    const expected = serializeSignal(parseSeededSignalNotes(SEEDED_NOTES, "CE BREAKOUT (RES)", "CE")!);
    expect(signalOf(good)).toBe(expected);
    expect(parseSignal(signalOf(good))).toMatchObject({ t1: 14.48, t2: 19.3, sl: 6.27, exitStatus: "T2_HIT", spot: 672.6 });
    expect(raw(good).notes, "a fix must not rewrite what the user typed").toBe(notesBefore);
    expect(signalOf(bad), "a note that cannot be read in full is left exactly as it is").toBeNull();
  });

  it("the marker stops a second run, and the IS NULL guard stops a re-run from writing twice", () => {
    expect(fixes.runDataFixes(t.sqlite).find((r) => r.name === fixes.SIGNAL_NOTES_BACKFILL_FIX)).toMatchObject({ applied: false, rekeyed: 0 });
    forgetMarker(fixes.SIGNAL_NOTES_BACKFILL_FIX);
    expect(fixes.runDataFixes(t.sqlite).find((r) => r.name === fixes.SIGNAL_NOTES_BACKFILL_FIX)).toMatchObject({ applied: true, rekeyed: 0 });
  });

  it("the TOMBSTONE is skipped: a signal the user cleared never comes back from the notes", () => {
    setSignal(good, SIGNAL_TOMBSTONE);
    forgetMarker(fixes.SIGNAL_NOTES_BACKFILL_FIX);
    expect(fixes.runDataFixes(t.sqlite).find((r) => r.name === fixes.SIGNAL_NOTES_BACKFILL_FIX)).toMatchObject({ rekeyed: 0 });
    expect(signalOf(good)).toBe(SIGNAL_TOMBSTONE);
    setSignal(good, serializeSignal(parseSeededSignalNotes(SEEDED_NOTES, "CE BREAKOUT (RES)", "CE")!));
  });

  it("is registered LAST, after the three fixes that came before it", () => {
    t.sqlite.prepare("DELETE FROM data_fixes").run();
    expect(fixes.runDataFixes(t.sqlite).map((r) => r.name)).toEqual([
      "paytm-dedup-isin-v1",
      "ipo-account-rehome-v1",
      "leg-trade-date-iso-v1",
      "signal-notes-backfill-v1",
      "risk-source-v1", // v4.4.0 D1 — registered after it; the Signal fix stays last of the v4.3.0 four
    ]);
  });
});

/**
 * MEASURED LOCALLY 2026-09-18: the three `restoreDatabase` cases below run
 * 287 / 288 / 312 ms; everything else in this file is 1–30 ms. No timeout is
 * raised — `tests/backup-roundtrip.test.ts` has restored the whole database in
 * 682–1204 ms per `it` on the same runner for four releases, so a full restore
 * is the established cost of pinning a restore, not a budget this file broke.
 */
describe("every sequence that carries a trades row carries the signal", () => {
  it("backup dump → restore is BYTE-equal, and a cleared signal does not resurrect", () => {
    const kept = commit.commitManualTrade(optionTrade({ tradingsymbol: "OPT AXISBANK 26 Jun 2026 1200 CE" }), { signalJson: '{"v":1,"model":"S1","spot":672.6}' }, PRIMARY).id!;
    const cleared = commit.commitManualTrade(
      optionTrade({ tradingsymbol: "OPT LT 26 Jun 2026 3600 CE" }),
      { notes: SEEDED_NOTES, setupTag: "CE BREAKOUT (RES)", signalJson: '{"v":1,"model":"S2"}' },
      PRIMARY,
    ).id!;
    expect(commit.updateManualTrade(cleared, { signalJson: null }).ok).toBe(true);

    const dump = backup.dumpDatabase(false);
    expect(backup.restoreDatabase(dump).ok).toBe(true);
    expect(signalOf(kept)).toBe('{"v":1,"model":"S1","spot":672.6}');
    // The restore replays every fix (the markers are forgotten), and the seeded
    // notes are still on this row — the tombstone is what stops the resurrection.
    expect(signalOf(cleared)).toBe(SIGNAL_TOMBSTONE);
  });

  it("an OLD backup, with the column absent, is re-read from the notes by the restore's fix rerun", () => {
    const dump = backup.dumpDatabase(false) as { tables: Record<string, Record<string, unknown>[]> };
    const seeded = dump.tables.trades.find((r) => r.notes === SEEDED_NOTES && r.signalJson != null)!;
    for (const r of dump.tables.trades) delete r.signalJson; // a pre-0072 envelope carries no key
    expect(backup.restoreDatabase(dump).ok).toBe(true);
    expect(signalOf(seeded.id as number), "rerunDataFixesAfterRestore re-parses it").toBe(
      serializeSignal(parseSeededSignalNotes(SEEDED_NOTES, "CE BREAKOUT (RES)", "CE")!),
    );
  });

  it("a restore never overwrites a signal the user edited on a seeded row", () => {
    const seeded = (t.sqlite.prepare("SELECT id FROM trades WHERE notes = ? AND signal_json IS NOT NULL ORDER BY id LIMIT 1").get(SEEDED_NOTES) as { id: number }).id;
    const mine = '{"v":1,"model":"S2","t1":99.5}';
    setSignal(seeded, mine);
    const dump = backup.dumpDatabase(false);
    expect(backup.restoreDatabase(dump).ok).toBe(true);
    expect(signalOf(seeded), "the IS NULL guard is what protects the user's own edit").toBe(mine);
  });

  it("Trash delete → restore is byte-equal", () => {
    const id = commit.commitManualTrade(optionTrade({ tradingsymbol: "OPT MARUTI 26 Jun 2026 12000 CE" }), { signalJson: '{"v":1,"model":"S1","score":8}' }, PRIMARY).id!;
    expect(del.deleteTradesByIds([id], "signal trash pin").ok).toBe(true);
    const snap = trash.listTrashSnapshots()[0];
    expect(trash.restoreTrashSnapshot(snap.id).ok).toBe(true);
    const back = t.sqlite.prepare("SELECT signal_json FROM trades WHERE tradingsymbol = ?").get("OPT MARUTI 26 Jun 2026 12000 CE") as { signal_json: string | null };
    expect(back.signal_json).toBe('{"v":1,"model":"S1","score":8}');
  });

  it("a same-day re-pull supersedes the row IN PLACE and the signal rides along", () => {
    const today = day.todayIstIso();
    const pull = "zerodha-api-" + today;
    const row = (buyQty: number, sellQty: number): NormalizedTrade =>
      optionTrade({
        tradingsymbol: "OPT BAJFINANCE 26 Jun 2026 9000 CE",
        buyQty,
        buyValue: buyQty * 9.65,
        sellQty,
        sellValue: sellQty * 16.8875,
        grossPnl: sellQty ? Math.round((sellQty * 16.8875 - buyQty * 9.65) * 100) / 100 : 0,
        buyDate: today,
        sellDate: sellQty ? today : null,
        sourceFile: pull,
      });
    const file = (r: NormalizedTrade): ParsedFile => ({ sourceId: "zerodha-tradebook", broker: "zerodha", format: "csv", trades: [r], warnings: [] });

    expect(commit.commitParsedFile(file(row(500, 0)), pull, null, PRIMARY, { supersedeSnapshot: { fileName: pull } }).added).toBe(1);
    const id = (t.sqlite.prepare("SELECT id FROM trades WHERE tradingsymbol = ?").get("OPT BAJFINANCE 26 Jun 2026 9000 CE") as { id: number }).id;
    setSignal(id, '{"v":1,"model":"S1","t1":14.48}');

    const res = commit.commitParsedFile(file(row(500, 500)), pull, null, PRIMARY, { supersedeSnapshot: { fileName: pull } });
    expect([res.added, res.skipped], "the evening pull replaced the morning row rather than adding a second").toEqual([0, 0]);
    const after = raw(id);
    expect([after.sell_qty, after.is_open]).toEqual([500, 0]);
    expect(after.signal_json, "the supersede patch is explicit-keyed and never names signal_json").toBe('{"v":1,"model":"S1","t1":14.48}');
  });
});

describe("getSignalTrades", () => {
  it("returns only readable signals, scoped to the selected account", () => {
    selectAccount(SECOND);
    const mine = signals.getSignalTrades();
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.signal !== null)).toBe(true);

    selectAccount(PRIMARY);
    const primary = signals.getSignalTrades();
    expect(primary.some((r) => mine.some((m) => m.id === r.id)), "one account's signals must not reach another's book").toBe(false);

    selectAccount(0);
    const all = signals.getSignalTrades();
    expect(all.length).toBe(mine.length + primary.length);
  });

  it("drops the tombstone and an envelope it cannot read — never a blank row on screen", () => {
    selectAccount(PRIMARY);
    const before = signals.getSignalTrades().length;
    const id = commit.commitManualTrade(optionTrade({ tradingsymbol: "OPT ONGC 26 Jun 2026 300 CE" }), {}, PRIMARY).id!;
    for (const stored of [SIGNAL_TOMBSTONE, '{"v":9,"model":"S1"}', "not json at all", '{"v":1}']) {
      setSignal(id, stored);
      expect(signals.getSignalTrades().length, `${stored} must not become a blank row on screen`).toBe(before);
    }
    setSignal(id, '{"v":1,"model":"S1"}');
    expect(signals.getSignalTrades().length).toBe(before + 1);
  });
});
