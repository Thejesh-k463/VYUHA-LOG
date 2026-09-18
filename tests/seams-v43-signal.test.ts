import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  SIGNAL_NUMBER_FIELDS,
  SIGNAL_TOMBSTONE,
  prefillLadder,
  serializeSignal,
  emptySignal,
} from "@/lib/domain/signal";
import { ruleAdherence } from "@/lib/analytics/signal-book";

/**
 * THE SIGNAL BOOK's LAYER SEAMS (v4.3.0, one builder, six layers).
 *
 * One builder owned every file, so the untested surface is not between two
 * people's folders — it is between the LAYERS the value crosses. Each case below
 * runs the two real halves together: the wire the client actually emits, through
 * the real action, the real writer, the real reader, into the real analytics.
 * Nothing is mocked but `next/cache` (a server action outside a request has no
 * store to revalidate into).
 *
 * ── THE CROSSING VALUES ─────────────────────────────────────────────────────
 *
 * value              | producer                          | consumer                            | unit / shape         | case
 * signalPresent      | signal-section.tsx:218            | actions.ts:75 signalFromFormData    | "1" or ABSENT        | 1,5,6
 * signal.<field>     | signal-section.tsx:220-223        | signal.ts:220 signalFromForm        | RAW string, "" =null | 1,2,3,9
 * signal.t1 "abc"    | signal-section.tsx:221            | signal.ts:238                       | refusal sentence     | 2
 * signal.t1 "14,48"  | signal-section.tsx:221            | signal.ts:237                       | RAW string           | 3 (fixed 2026-09-18)
 * fields.signalJson  | actions.ts:209 / :334             | commit.ts:1810 / :2685              | string|null|undefined| 1,4,5,6,7
 * instrumentType     | classify (commit.ts:1810)         | commit.ts:1810                      | "option" or force null| 4
 * t.signalJson       | commit.ts:2684 nextSignalJson     | signals.ts:63 parseSignal           | envelope or tombstone| 6,7
 * signal (parsed)    | signals.ts:66                     | signal-book.ts:121 ruleAdherence    | REAL levels, ₹       | 1,8
 * notes/setup_tag    | seed-options-account.ts (seeded)  | data-fixes.ts:255 backfill          | 4 lines, commas in ₹ | 8
 * prefill t1/t2/sl   | signal.ts:262 prefillLadder       | signal-section.tsx:131 -> the wire  | REAL rupees, 2 dp    | 9,10
 *
 * ── ALREADY PINNED THROUGH BOTH HALVES — NOT DUPLICATED HERE ────────────────
 *
 *  - account scope (invariant 8/9): tests/signal-db.test.ts:315 already drives
 *    getSignalTrades under account 1, account 2 AND the aggregate 0, asserting
 *    all === mine + primary. Nothing to add.
 *  - the Pro withhold (invariant 7): tests/signal-domain-analytics.test.ts:329
 *    serialises a free payload and asserts no analytics key reaches the wire
 *    while the rows do. Nothing to add.
 *  - the writer's own edit rule at the FIELD level (undefined keeps / null
 *    tombstones / equity forces null): tests/signal-db.test.ts:146-165. Cases
 *    4-7 below cross the ACTION door with real FormData instead, which that file
 *    never does.
 *
 * ONE temp database for the FILE (AGENTS.md Testing: lib/db caches its
 * connection on globalThis). The backfill in case 8 is driven through
 * `rerunDataFixesAfterRestore`, never a quiet guard.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ACC_ADD = 2;
const ACC_EDIT = 3;
const ACC_FIX = 4;
const PREV = { ok: false, message: "" };

let t: TempDb;
let actions: typeof import("@/app/trades/actions");
let commit: typeof import("@/lib/import/commit");
let signals: typeof import("@/lib/queries/signals");
let fixes: typeof import("@/lib/db/data-fixes");

const rawSignal = (id: number) =>
  ((t.sqlite.prepare("SELECT signal_json FROM trades WHERE id = ?").get(id) as { signal_json: string | null } | undefined)
    ?.signal_json ?? null);
const countOf = (sym: string) =>
  (t.sqlite.prepare("SELECT COUNT(*) c FROM trades WHERE tradingsymbol = ?").get(sym) as { c: number }).c;
const selectAccount = (id: number) => t.sqlite.prepare("UPDATE settings SET selected_account_id = ?").run(id);
const rowsOf = (account: number) => {
  selectAccount(account);
  return signals.getSignalTrades();
};

/**
 * THE WIRE, exactly as components/trades/signal-section.tsx:216-224 emits it:
 * one hidden `signalPresent`, then `signal.model`, then every number field in
 * SIGNAL_NUMBER_FIELDS order, then `signal.exitStatus` — all of them present,
 * all of them RAW strings, a blank one as "".
 */
function emitSignalSection(fd: FormData, v: Record<string, string> = {}) {
  fd.append("signalPresent", "1");
  fd.append("signal.model", v.model ?? "");
  for (const k of SIGNAL_NUMBER_FIELDS) fd.append(`signal.${k}`, v[k] ?? "");
  fd.append("signal.exitStatus", v.exitStatus ?? "");
}

/** The Add form's own fields (components/trades/manual-trade-form.tsx). */
function addForm(tradingsymbol: string, over: Record<string, string> = {}) {
  const fd = new FormData();
  const base: Record<string, string> = {
    broker: "zerodha",
    tradingsymbol,
    buyQty: "500",
    avgBuyPrice: "9.65",
    buyDate: "2026-06-11",
    sellQty: "500",
    avgSellPrice: "16.8875",
    sellDate: "2026-06-11",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) fd.append(k, v);
  return fd;
}

/** The edit dialog's own fields (components/trades/edit-trade-dialog.tsx). */
function editForm(id: number, over: Record<string, string> = {}) {
  const fd = new FormData();
  const base: Record<string, string> = {
    tradeId: String(id),
    buyQty: "500",
    avgBuyPrice: "9.65",
    buyDate: "2026-06-11",
    sellQty: "500",
    avgSellPrice: "16.8875",
    sellDate: "2026-06-11",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) fd.append(k, v);
  return fd;
}

/** The signal the seeded sheet's four lines state, as strings the form posts. */
const TYPED = {
  model: "S1",
  spot: "672.6",
  zoneLow: "687.22",
  zoneHigh: "692",
  dayHigh: "17.4",
  dayLow: "7.55",
  t1: "14.48",
  t2: "19.3",
  sl: "6.27",
  oiChgPct: "-3.21",
  volume: "2,443",
  rank: "3",
  exitStatus: "T2_HIT",
};

/** The four lines scripts/seed-options-account.ts writes into `notes`. */
const seededNotes = (t1: number, t2: number, sl: number, exit: string, pct: string, dayH: number, dayL: number) =>
  [
    "Options strategy log #12 · TIER 1 — HIGH CONVICTION",
    `Spot 672.6 · S/R zone 687.22 - 692 · Day H/L ${dayH}/${dayL}`,
    `T1 ${t1} · T2 ${t2} · SL ${sl} · Exit: ${exit} (${pct}%)`,
    "ΔOI -3.21% (unwind) · Volume 2443",
  ].join("\n");

beforeAll(async () => {
  t = await openTempDb("seams-v43-signal", { seed: true });
  actions = await import("@/app/trades/actions");
  commit = await import("@/lib/import/commit");
  signals = await import("@/lib/queries/signals");
  fixes = await import("@/lib/db/data-fixes");
  for (const [id, name] of [
    [ACC_ADD, "Seam add"],
    [ACC_EDIT, "Seam edit"],
    [ACC_FIX, "Seam backfill"],
  ] as const) {
    t.db.insert(t.schema.accounts).values({ id, name, isDefault: false }).run();
  }
});

afterAll(() => t?.cleanup());

/* ══════ 1. FORM -> ACTION -> WRITER -> READER -> ANALYTICS ══════ */

describe("the Add form's wire reaches the Signal book with the numbers the user typed", () => {
  it("raw `signal.<field>` strings survive the action, the writer and the reader, and block A judges them", async () => {
    const sym = "OPT TATAMOTORS 26 Jun 2026 700 CE";
    const fd = addForm(sym, { accountId: String(ACC_ADD) });
    emitSignalSection(fd, TYPED);

    const res = await actions.createManualTrade(PREV, fd);
    expect([res.ok, res.message]).toEqual([true, "Trade added."]);
    const id = res.tradeId!;

    // THE READER's output, not "the value arrived": the numbers, parsed.
    const row = rowsOf(ACC_ADD).find((r) => r.id === id)!;
    expect(row, "the row must reach the Signal book at all").toBeTruthy();
    expect(row.signal).toEqual({
      ...emptySignal(),
      model: "S1",
      spot: 672.6,
      zoneLow: 687.22,
      zoneHigh: 692,
      dayHigh: 17.4,
      dayLow: 7.55,
      t1: 14.48,
      t2: 19.3,
      sl: 6.27,
      oiChgPct: -3.21,
      // "2,443" is a thousands separator, not a second number.
      volume: 2443,
      rank: 3,
      exitStatus: "T2_HIT",
    });
    // The projection's own half of the seam: the fills the analytics divide by.
    expect([row.avgBuyPrice, row.avgSellPrice, row.optionType, row.isOpen]).toEqual([9.65, 16.8875, "CE", false]);

    // ANALYTICS on the parsed envelope: exit 16.8875 is the blended (14.48+19.3)/2
    // = 16.89 scale-out, inside the 2% band — judged, and NOT a deviation.
    const a = ruleAdherence([row]);
    expect([a.judged, a.notJudgeable, a.deviating.n, a.byCode.length]).toEqual([1, 0, 0, 0]);
  });

  it("a `signal.t1` that is not a number REFUSES the save and writes NO row", async () => {
    const sym = "OPT ITC 26 Jun 2026 400 CE";
    const fd = addForm(sym, { accountId: String(ACC_ADD) });
    emitSignalSection(fd, { ...TYPED, t1: "abc" });

    const res = await actions.createManualTrade(PREV, fd);
    // The sentence the dialog shows, from signal.ts:238 through actions.ts:192.
    expect(res.message).toBe("T1 “abc” is not a number. Nothing was saved.");
    expect(res.ok).toBe(false);
    // Refused BEFORE the writer: not a trade saved without its ladder.
    expect(countOf(sym), "nothing may be half-saved").toBe(0);
  });

  /**
   * SEAM DEFECT SIG-1 (lib/domain/signal.ts:237) — RECORDED, not loosened.
   *
   * `Number(raw.replace(/,/g, ""))` strips EVERY comma, so the decimal-comma
   * "14,48" the module's own header (signal.ts:211-216) promises to REFUSE is
   * coerced to 1448 and stored as the T1 level: measured res.ok true, stored
   * `"t1":1448`, and block A then judges every exit against 1448 for the life of
   * the trade. Expected: refused, as "abc" is. Right fix: the thousands-group
   * rule this same file already uses for the seeded notes (NUM, signal.ts:284) —
   * "1,448" still reads as 1448, "14,48" is refused.
   */
  it("SIG-1: a decimal-comma '14,48' must be refused, not read as 1448", async () => {
    const sym = "OPT WIPRO 26 Jun 2026 300 CE";
    const fd = addForm(sym, { accountId: String(ACC_ADD) });
    emitSignalSection(fd, { ...TYPED, t1: "14,48" });

    const res = await actions.createManualTrade(PREV, fd);
    expect(res.ok, "a level that cannot be read is refused, never coerced").toBe(false);
    expect(countOf(sym)).toBe(0);
  });

  it("the SAME wire stores an envelope on an option and NULL on an equity — the classifier decides, not the form", async () => {
    const wire = (sym: string, over: Record<string, string>) => {
      const fd = addForm(sym, { accountId: String(ACC_ADD), ...over });
      emitSignalSection(fd, { model: "S2", t1: "14.48", t2: "19.3", sl: "6.27" });
      return fd;
    };
    const opt = await actions.createManualTrade(PREV, wire("OPT SBIN 26 Jun 2026 800 PE", {}));
    const eq = await actions.createManualTrade(PREV, wire("TCS", { avgBuyPrice: "3000", avgSellPrice: "3100" }));
    expect([opt.ok, eq.ok]).toEqual([true, true]);

    // Both halves of the one rule (commit.ts:1810), in one case: the option
    // keeps what was posted, the equity is forced to NULL.
    expect(rawSignal(opt.tradeId!)).toBe('{"v":1,"model":"S2","t1":14.48,"t2":19.3,"sl":6.27}');
    expect(rawSignal(eq.tradeId!), "a signal describes a strike's chain").toBeNull();
    const book = rowsOf(ACC_ADD).map((r) => r.id);
    expect([book.includes(opt.tradeId!), book.includes(eq.tradeId!)]).toEqual([true, false]);
  });
});

/* ══════ 2. THE EDIT DOOR ══════ */

describe("the edit dialog says nothing about the signal unless the section was touched", () => {
  const STORED = '{"v":1,"model":"S1","spot":672.6,"t1":14.48,"t2":19.3,"sl":6.27,"exitStatus":"T2_HIT"}';
  const option = (sym: string, signalJson: string | null) =>
    commit.commitManualTrade(
      {
        broker: "zerodha",
        tradingsymbol: sym,
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
      } as never,
      signalJson === null ? {} : { signalJson },
      ACC_EDIT,
    ).id!;

  it("no `signalPresent` (the section was never dirtied): the stored envelope is BYTE-identical", async () => {
    const id = option("OPT HDFCBANK 26 Jun 2026 2000 CE", STORED);
    const res = await actions.updateTradeAction(PREV, editForm(id, { avgSellPrice: "17.5" }));
    expect(res.ok).toBe(true);
    // The edit really ran — this is not a no-op passing for a keep.
    expect(
      (t.sqlite.prepare("SELECT avg_sell_price p FROM trades WHERE id = ?").get(id) as { p: number }).p,
    ).toBe(17.5);
    expect(rawSignal(id), "an absent field is NOT MENTIONED, never a clear").toBe(STORED);
  });

  it("`signalPresent` with every field blank on a row that HAD one stores the tombstone, and the reader drops it", async () => {
    const id = option("OPT AXISBANK 26 Jun 2026 1200 CE", STORED);
    expect(rowsOf(ACC_EDIT).some((r) => r.id === id)).toBe(true);

    const fd = editForm(id);
    emitSignalSection(fd, {});
    const res = await actions.updateTradeAction(PREV, fd);
    expect(res.ok).toBe(true);
    // NOT SQL NULL: a NULL would let the seeded-notes backfill resurrect it on
    // the next restore (commit.ts:2683, data-fixes.ts:262).
    expect(rawSignal(id)).toBe(SIGNAL_TOMBSTONE);
    expect(rowsOf(ACC_EDIT).some((r) => r.id === id), "a cleared signal is not a blank row on screen").toBe(false);
  });

  it("an envelope from a NEWER release survives an edit that posts signal fields, and the save says so", async () => {
    const alien = '{"v":2,"model":"S9","t1":14.48,"regime":"from a newer Vyuha"}';
    const id = option("OPT LT 26 Jun 2026 3600 CE", alien);

    const fd = editForm(id);
    emitSignalSection(fd, { ...TYPED, t1: "99.5" });
    const res = await actions.updateTradeAction(PREV, fd);
    expect(res.ok).toBe(true);
    expect(rawSignal(id), "a v:2 envelope is kept byte-for-byte, never replaced by a one-field v1").toBe(alien);
    expect(res.message).toContain("recorded by a newer version of Vyuha");
  });
});

/* ══════ 3. DATA FIX -> READER -> ANALYTICS ══════ */

describe("the seeded notes reach block A through the fix and the reader", () => {
  it("backfilled rows come back model-null; the T2 row is adherent and TARGET_REACHED_NOT_TAKEN stays out of `deviating`", () => {
    const seeded = (sym: string, notes: string, avgSellPrice: number) =>
      commit.commitManualTrade(
        {
          broker: "zerodha",
          tradingsymbol: sym,
          isin: null,
          buyQty: 500,
          avgBuyPrice: 9.65,
          buyValue: 4825,
          sellQty: 500,
          avgSellPrice,
          sellValue: Math.round(500 * avgSellPrice * 100) / 100,
          closingPrice: null,
          grossPnl: Math.round((500 * avgSellPrice - 4825) * 100) / 100,
          unrealisedPnl: 0,
          buyDate: "2026-06-11",
          sellDate: "2026-06-11",
          productHint: null,
          exchangeHint: null,
          sourceFile: "manual",
        } as never,
        { notes, setupTag: "CE BREAKOUT (RES)" },
        ACC_FIX,
      ).id!;

    // entry 9.65; T1 +50%, T2 +100%, SL -35%; exit = entry x 1.75 = the blended
    // (14.48 + 19.3) / 2 = 16.89 the scale-out ruling expects.
    const t2Row = seeded("OPT SBIN 26 Jun 2026 800 CE", seededNotes(14.48, 19.3, 6.27, "TARGET 2 HIT", "75.00", 17.4, 7.55), 16.8875);
    // An EOD close whose recorded day high passed T1: reported, never charged.
    const eodRow = seeded("OPT ONGC 26 Jun 2026 300 CE", seededNotes(14.48, 19.3, 6.27, "EOD PROFIT CLOSE", "5.70", 17.4, 7.55), 10.2);

    expect([rawSignal(t2Row), rawSignal(eodRow)], "nothing is backfilled before the fix runs").toEqual([null, null]);
    const results = fixes.rerunDataFixesAfterRestore(t.sqlite);

    const rows = rowsOf(ACC_FIX);
    expect(
      rows.map((r) => r.id).sort((a, b) => a - b),
      "both seeded notes must arrive in the Signal book through the fix",
    ).toEqual([t2Row, eodRow].sort((a, b) => a - b));
    expect(results.find((r) => r.name === "signal-notes-backfill-v1")).toMatchObject({
      applied: true,
      rekeyed: 2,
      skippedCollisions: 0,
    });
    // The fix never invents a model — "—" on screen is NEVER RECORDED.
    expect(rows.map((r) => r.signal.model)).toEqual([null, null]);
    expect(rows.find((r) => r.id === t2Row)!.signal).toMatchObject({ t1: 14.48, t2: 19.3, sl: 6.27, exitStatus: "T2_HIT" });

    const a = ruleAdherence(rows);
    expect([a.judged, a.notJudgeable, a.excludedShort]).toEqual([2, 0, 0]);
    // The T2 row is adherent, and the EOD row's only code is the excluded one.
    expect(a.deviating).toEqual({ n: 0, netPnl: 0 });
    expect(a.byCode.map((c) => [c.code, c.n])).toEqual([["TARGET_REACHED_NOT_TAKEN", 1]]);
  });
});

/* ══════ 4. PREFILL -> WIRE -> STORE ══════ */

describe("the ladder prefill is what gets stored, and only where there is nothing to overwrite", () => {
  it("an untouched ladder on entry 100 stores 130 / 160 / 75 — the prefill, through the wire", async () => {
    const entry = 100;
    // The section renders String(prefillLadder(entry)[k]) for an untouched
    // ladder field (signal-section.tsx:129-134) and posts exactly that string.
    const ladder = prefillLadder(entry)!;
    expect(ladder).toEqual({ t1: 130, t2: 160, sl: 75 });

    const fd = addForm("OPT RELIANCE 26 Jun 2026 1500 CE", {
      accountId: String(ACC_ADD),
      avgBuyPrice: String(entry),
      avgSellPrice: "132",
    });
    emitSignalSection(fd, {
      model: "S2",
      t1: String(ladder.t1),
      t2: String(ladder.t2),
      sl: String(ladder.sl),
      exitStatus: "T1_HIT",
    });

    const res = await actions.createManualTrade(PREV, fd);
    expect(res.ok).toBe(true);
    const row = rowsOf(ACC_ADD).find((r) => r.id === res.tradeId)!;
    expect([row.signal.t1, row.signal.t2, row.signal.sl]).toEqual([130, 160, 75]);
    // And block A judges the exit against THOSE levels: 132 vs T1 130, tol 2.6.
    expect(ruleAdherence([row]).deviating.n).toBe(0);
  });

  it("a model-only edit of a stored signal with NO levels prefills nothing into the store", async () => {
    const stored = serializeSignal({ ...emptySignal(), model: "S1" })!;
    const id = commit.commitManualTrade(
      {
        broker: "zerodha",
        tradingsymbol: "OPT BAJFINANCE 26 Jun 2026 9000 CE",
        isin: null,
        buyQty: 500,
        avgBuyPrice: 100,
        buyValue: 50000,
        sellQty: 500,
        avgSellPrice: 132,
        sellValue: 66000,
        closingPrice: null,
        grossPnl: 16000,
        unrealisedPnl: 0,
        buyDate: "2026-06-11",
        sellDate: "2026-06-11",
        productHint: null,
        exchangeHint: null,
        sourceFile: "manual",
      } as never,
      { signalJson: stored },
      ACC_EDIT,
    ).id!;

    // The section on a row whose stored value is a SIGNAL offers no prefill
    // (signal-section.tsx:125), so the ladder inputs post "" beside the new
    // model — a blank stays blank, and the +30/+60/-25 ladder is never stored
    // on a trade that was not taken on it.
    const fd = editForm(id, { avgBuyPrice: "100", avgSellPrice: "132" });
    emitSignalSection(fd, { model: "S2" });
    const res = await actions.updateTradeAction(PREV, fd);
    expect(res.ok).toBe(true);

    expect(rawSignal(id)).toBe('{"v":1,"model":"S2"}');
    const row = rowsOf(ACC_EDIT).find((r) => r.id === id)!;
    expect([row.signal.model, row.signal.t1, row.signal.t2, row.signal.sl]).toEqual(["S2", null, null, null]);
    // Nothing to judge against: a prefilled ladder here would have made this 1.
    expect(ruleAdherence([row]).judged).toBe(0);
  });

  // Boundary 1 of this file's header (page.tsx -> signal-book.tsx RSC props) had no RUNTIME case:
  // the page was only source-scanned. This renders the real component over the real reader's rows,
  // exactly as app/strategies/page.tsx hands them over, in both entitlement states.
  it("the page's hand-off renders: the free table shows the recorded option data, and the analytics exist only when the payload was not withheld", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SignalBook } = await import("@/components/strategies/signal-book");
    const { withholdSignalAnalytics } = await import("@/lib/analytics/signal-book");

    selectAccount(0);
    const rows = signals.getSignalTrades();
    expect(rows.length, "the earlier cases left signal trades in the book").toBeGreaterThan(0);

    const pro = renderToStaticMarkup(React.createElement(SignalBook, { rows, analytics: withholdSignalAnalytics(rows, true) }));
    const free = renderToStaticMarkup(React.createElement(SignalBook, { rows, analytics: withholdSignalAnalytics(rows, false) }));

    for (const html of [pro, free]) {
      // every recorded signal is a row of the user's own journal - never gated (invariant 7)
      for (const r of rows) expect(html, `row ${r.id} is on screen`).toContain(r.symbol);
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("undefined");
    }
    expect(pro, "the edge block names its own R rule").toContain("R on signal SL");
    expect(free, "a withheld payload renders no analytics column at all").not.toContain("R on signal SL");
  });
});
