import { describe, it, expect } from "vitest";
import {
  SIGNAL_ENVELOPE_VERSION,
  SIGNAL_TOMBSTONE,
  emptySignal,
  parseSignal,
  serializeSignal,
  signalFromForm,
  prefillLadder,
  parseSeededSignalNotes,
  classifyStoredSignal,
  type TradeSignal,
} from "@/lib/domain/signal";
import {
  ADHERENCE_TOL_PCT,
  ADHERENCE_LABELS,
  ruleAdherence,
  edgeByGroup,
  ladderStats,
  withholdSignalAnalytics,
  type SignalTradeRow,
} from "@/lib/analytics/signal-book";

/**
 * THE SIGNAL BOOK's two pure modules (v4.3.0).
 *
 * `lib/domain/signal.ts` owns the stored envelope — the ONLY reader and the only
 * writer of `trades.signal_json` — and `lib/analytics/signal-book.ts` owns the
 * three analytics blocks over it. Neither touches the database or React
 * (invariant 2), so every rule below is asserted on values, not on a screen.
 */

/** The exact four-line note `scripts/seed-options-account.ts` writes. */
const SAMPLE_NOTES = [
  "Options strategy log #12 · TIER 1 — HIGH CONVICTION",
  "Spot 672.6 · S/R zone 687.22 - 692 · Day H/L 10.5/7.55",
  "T1 14.48 · T2 19.3 · SL 6.27 · Exit: EOD PROFIT CLOSE (12.34%)",
  "ΔOI -3.21% (unwind) · Volume 2443",
].join("\n");

/** A closed long CE signal trade, with the fields the analytics read. */
function row(over: Partial<SignalTradeRow> = {}, sig: Partial<TradeSignal> = {}): SignalTradeRow {
  return {
    id: 1,
    symbol: "TATAMOTORS",
    tradingsymbol: "TATAMOTORS 26JUN 700 CE",
    strike: 700,
    optionType: "CE",
    lotSize: 500,
    buyQty: 500,
    sellQty: 500,
    avgBuyPrice: 9.65,
    avgSellPrice: 16.8875,
    buyDate: "2026-06-11",
    sellDate: "2026-06-11",
    isOpen: false,
    netPnl: 3600,
    side: null,
    importNotes: null,
    signal: { ...emptySignal(), t1: 14.48, t2: 19.3, sl: 6.27, exitStatus: "T2_HIT", ...sig },
    ...over,
  };
}

describe("signal envelope — parse / serialise", () => {
  it("round-trips and writes a fixed key order, model always present", () => {
    const s: TradeSignal = { ...emptySignal(), model: "S1", spot: 672.6, t1: 14.48, exitStatus: "T1_HIT" };
    const json = serializeSignal(s)!;
    expect(json.startsWith(`{"v":${SIGNAL_ENVELOPE_VERSION},"model":"S1"`)).toBe(true);
    // Null fields are OMITTED; the keys that remain keep the declared order.
    expect(Object.keys(JSON.parse(json))).toEqual(["v", "model", "spot", "t1", "exitStatus"]);
    expect(parseSignal(json)).toEqual(s);
  });

  it("a model-less signal still writes model:null", () => {
    const json = serializeSignal({ ...emptySignal(), spot: 100 })!;
    expect(JSON.parse(json)).toEqual({ v: 1, model: null, spot: 100 });
  });

  it("discards anything that is not a v1 object — whole envelope, never half-read", () => {
    for (const raw of [null, undefined, "", "   ", "{", "[1,2]", '"x"', "7", '{"v":2,"spot":100}', '{"spot":100}']) {
      expect(parseSignal(raw), `${raw} must not parse`).toBeNull();
    }
  });

  it("a bad FIELD nulls that field only", () => {
    const parsed = parseSignal('{"v":1,"model":"S9","spot":"672.6","t1":14.48,"volume":null,"rank":true,"exitStatus":"MOONED"}')!;
    expect(parsed.model).toBeNull();
    expect(parsed.spot).toBeNull();
    expect(parsed.rank).toBeNull();
    expect(parsed.exitStatus).toBeNull();
    expect(parsed.t1).toBe(14.48);
  });

  it("an EMPTY signal serialises to null — a trade with no signal stores SQL NULL", () => {
    expect(serializeSignal(emptySignal())).toBeNull();
    expect(serializeSignal({ ...emptySignal(), model: null })).toBeNull();
  });

  it("the tombstone is READ as cleared, an alien envelope as unreadable", () => {
    // 2c: an explicit clear stores {"v":1}. parseSignal answers null for both,
    // but the edit form must offer one and refuse the other.
    expect(parseSignal(SIGNAL_TOMBSTONE)).toBeNull();
    expect(classifyStoredSignal(SIGNAL_TOMBSTONE)).toBe("cleared");
    expect(classifyStoredSignal('{"v":1,"model":null}')).toBe("cleared");
    expect(classifyStoredSignal('{"v":2,"spot":100}')).toBe("unreadable");
    expect(classifyStoredSignal("not json")).toBe("unreadable");
    expect(classifyStoredSignal(null)).toBe("absent");
    expect(classifyStoredSignal('{"v":1,"spot":100}')).toBe("signal");
  });

  it("prefillLadder is +30% / +60% / −25% of the entry, 2 dp", () => {
    expect(prefillLadder(100)).toEqual({ t1: 130, t2: 160, sl: 75 });
    expect(prefillLadder(9.65)).toEqual({ t1: 12.55, t2: 15.44, sl: 7.24 });
    expect(prefillLadder(0)).toBeNull();
    expect(prefillLadder(-5)).toBeNull();
    expect(prefillLadder(Number.NaN)).toBeNull();
  });
});

describe("signalFromForm — the server-side door", () => {
  const form = (o: Record<string, string>) => (k: string) => (o[k] ?? "").trim() || null;

  it("builds the envelope from raw strings and strips thousands separators", () => {
    const res = signalFromForm(form({ model: "S2", spot: "1,544.60", t1: "14.48", exitStatus: "T1_HIT" }));
    expect(res.ok).toBe(true);
    expect(res.ok && parseSignal(res.json)).toEqual({ ...emptySignal(), model: "S2", spot: 1544.6, t1: 14.48, exitStatus: "T1_HIT" });
  });

  it("REFUSES a non-blank field that is not a finite number (2a) — never coerced to 0", () => {
    const res = signalFromForm(form({ t1: "14,48abc" }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toMatch(/T1/);
  });

  it("SIG-1: a comma is a THOUSANDS separator only — '14,48' is refused, never read as 1448", () => {
    // Western and Indian lakh grouping both end in a three-digit group and are accepted.
    const ok = signalFromForm(form({ t1: "1,448", strikeOi: "3,00,000", oiChgPct: "-3.21" }));
    expect(ok.ok && JSON.parse(ok.json!)).toMatchObject({ t1: 1448, strikeOi: 300000, oiChgPct: -3.21 });
    for (const bad of ["14,48", "1,44", "1e5", "1,,448", ",448", "14.4.8"]) {
      expect(signalFromForm(form({ t1: bad })).ok, `"${bad}" must be refused`).toBe(false);
    }
  });

  it("refuses an out-of-range level rather than storing it", () => {
    expect(signalFromForm(form({ spot: "0" })).ok).toBe(false);
    expect(signalFromForm(form({ zoneLow: "700", zoneHigh: "690" })).ok).toBe(false);
    expect(signalFromForm(form({ dayHigh: "7", dayLow: "10" })).ok).toBe(false);
    expect(signalFromForm(form({ strikeOi: "-1" })).ok).toBe(false);
    expect(signalFromForm(form({ rank: "0" })).ok).toBe(false);
    expect(signalFromForm(form({ rank: "1.5" })).ok).toBe(false);
    expect(signalFromForm(form({ model: "S3" })).ok).toBe(false);
    // A percentage may be any finite number, negative included.
    expect(signalFromForm(form({ oiChgPct: "-3.21", score: "0" })).ok).toBe(true);
  });

  it("an all-blank form is not a signal — json null, no empty envelope stored", () => {
    const res = signalFromForm(form({}));
    expect(res.ok && res.json).toBeNull();
  });
});

describe("parseSeededSignalNotes — the 42 seeded rows", () => {
  it("reads the exact four-line sample", () => {
    const s = parseSeededSignalNotes(SAMPLE_NOTES, "CE BREAKOUT (RES)", "CE")!;
    expect(s).not.toBeNull();
    expect([s.spot, s.zoneLow, s.zoneHigh, s.dayHigh, s.dayLow]).toEqual([672.6, 687.22, 692, 10.5, 7.55]);
    expect([s.t1, s.t2, s.sl]).toEqual([14.48, 19.3, 6.27]);
    expect(s.exitStatus).toBe("EOD_PROFIT");
    expect([s.oiChgPct, s.volume]).toEqual([-3.21, 2443]);
    // The rulings assign S1/S2 by hand; the tier text stays in notes and log # is not rank.
    expect([s.model, s.rank, s.distPct]).toEqual([null, null, null]);
  });

  it("accepts the widened shapes the live journal carries (review item 3)", () => {
    const withZone = (zone: string, l1 = "Options strategy log #5 · ") =>
      parseSeededSignalNotes(
        [l1, `Spot 672.6 · S/R zone ${zone} · Day H/L 10.5/7.55`, "T1 14.48 · T2 19.3 · SL 6.27 · Exit: TARGET 2 HIT (75.00%)", "ΔOI -0.00% (unwind) · Volume 2443"].join("\n"),
        "CE BREAKOUT (RES)",
        "CE",
      );
    // 3a: an EMPTY tier. 3b: an en dash, and no spaces around the dash. Commas.
    expect(withZone("1,544.60 - 1,556.80")).toMatchObject({ zoneLow: 1544.6, zoneHigh: 1556.8 });
    expect(withZone("687.22–692")).toMatchObject({ zoneLow: 687.22, zoneHigh: 692 });
    expect(withZone("687.22-692")).toMatchObject({ zoneLow: 687.22, zoneHigh: 692, exitStatus: "T2_HIT" });
  });

  it("3c: a trailing U+FE0F on the exit status no longer refuses the row", () => {
    const notes = SAMPLE_NOTES.replace("EOD PROFIT CLOSE (", "EOD PROFIT CLOSE️ (");
    expect(parseSeededSignalNotes(notes, "CE BREAKOUT (RES)", "CE")?.exitStatus).toBe("EOD_PROFIT");
  });

  it("reads the PE side under its own tag", () => {
    const s = parseSeededSignalNotes(SAMPLE_NOTES.replace("EOD PROFIT CLOSE", "SL HIT"), "PE BREAKDOWN (SUP)", "PE")!;
    expect(s.exitStatus).toBe("SL_HIT");
  });

  it("refuses rather than half-reads — the row is then left exactly as stored", () => {
    const L = SAMPLE_NOTES.split("\n");
    const cases: [string, string | null, string | null, string][] = [
      [SAMPLE_NOTES + "\nsomething else", "CE BREAKOUT (RES)", "CE", "a fifth line"],
      [[L[0], L[1], L[2].replace("EOD PROFIT CLOSE", "WENT SIDEWAYS"), L[3]].join("\n"), "CE BREAKOUT (RES)", "CE", "an unknown status"],
      [SAMPLE_NOTES, "PE BREAKDOWN (SUP)", "CE", "a tag that contradicts optionType"],
      [SAMPLE_NOTES, "ORB", "CE", "a tag outside the two"],
      [SAMPLE_NOTES, null, "CE", "no tag at all"],
      [[L[0], L[1], L[2], L[3].replace(" (unwind)", "")].join("\n"), "CE BREAKOUT (RES)", "CE", "a missing (unwind)"],
      [[L[0], L[1].replace("687.22 - 692", "692 - 687.22"), L[2], L[3]].join("\n"), "CE BREAKOUT (RES)", "CE", "zoneLow > zoneHigh"],
      [[L[0], L[1].replace("10.5/7.55", "7.55/10.5"), L[2], L[3]].join("\n"), "CE BREAKOUT (RES)", "CE", "dayLow > dayHigh"],
      [[L[0], L[1], L[2].replace("SL 6.27", "SL 0"), L[3]].join("\n"), "CE BREAKOUT (RES)", "CE", "a level of 0"],
      [[L[0], L[1], L[2], "ΔOI NaN% (unwind) · Volume 2443"].join("\n"), "CE BREAKOUT (RES)", "CE", "a NaN ΔOI"],
      ["not a log at all", "CE BREAKOUT (RES)", "CE", "an unrelated note"],
    ];
    for (const [notes, tag, opt, why] of cases) {
      expect(parseSeededSignalNotes(notes, tag, opt), why).toBeNull();
    }
  });
});

describe("(A) rule adherence — judged on each trade's OWN recorded levels", () => {
  it("the seeded T2 row is ADHERENT under the blended (t1+t2)/2 scale-out", () => {
    const a = ruleAdherence([row()]);
    expect(ADHERENCE_TOL_PCT).toBe(2);
    expect(a.judged).toBe(1);
    expect(a.deviating.n).toBe(0);
    expect(a.byCode).toEqual([]);
  });

  it("an exit off the status it claims, and a stop that was not honoured", () => {
    const off = row({ id: 2, avgSellPrice: 11, netPnl: 500 }, { exitStatus: "T1_HIT" }); // expected 14.48
    const through = row({ id: 3, avgSellPrice: 5, netPnl: -2300 }, { exitStatus: "SL_HIT" }); // sl 6.27
    const a = ruleAdherence([off, through]);
    expect(a.judged).toBe(2);
    const codes = Object.fromEntries(a.byCode.map((c) => [c.code, c.n]));
    expect(codes.EXIT_OFF_STATUS).toBe(2);
    expect(codes.SL_NOT_HONOURED).toBe(1);
    // Each trade counted ONCE in deviating, however many codes it carries.
    expect(a.deviating).toEqual({ n: 2, netPnl: -1800 });
  });

  it("an EOD status that contradicts its own P&L direction is a mismatch", () => {
    const a = ruleAdherence([row({ avgSellPrice: 8, netPnl: -800 }, { exitStatus: "EOD_PROFIT" })]);
    expect(a.byCode.map((c) => c.code)).toContain("EXIT_OFF_STATUS");
  });

  it("HELD_OVERNIGHT compares the DAY each date states, not its bytes", () => {
    expect(ruleAdherence([row({ sellDate: "12-06-2026" })]).byCode.map((c) => c.code)).toContain("HELD_OVERNIGHT");
    // A 4.2.x row storing the same day day-first is NOT overnight.
    expect(ruleAdherence([row({ buyDate: "11-06-2026" })]).byCode.map((c) => c.code)).not.toContain("HELD_OVERNIGHT");
  });

  it("TARGET_REACHED_NOT_TAKEN is reported but EXCLUDED from deviating (4a)", () => {
    const r = row({ id: 9, avgSellPrice: 10.2, netPnl: 275 }, { exitStatus: "EOD_PROFIT", dayHigh: 15.2, dayLow: 7.55 });
    const a = ruleAdherence([r]);
    expect(a.byCode.map((c) => c.code)).toEqual(["TARGET_REACHED_NOT_TAKEN"]);
    expect(a.deviating).toEqual({ n: 0, netPnl: 0 });
    expect(ADHERENCE_LABELS.TARGET_REACHED_NOT_TAKEN).toBe("day high ≥ T1 (may precede entry)");
  });

  it("a missing status, or a missing level, is NOT_JUDGEABLE — never a pass", () => {
    const noStatus = row({ id: 4 }, { exitStatus: null });
    const noLevel = row({ id: 5 }, { exitStatus: "T1_HIT", t1: null });
    const a = ruleAdherence([noStatus, noLevel]);
    expect([a.judged, a.notJudgeable]).toEqual([0, 2]);
    expect(a.deviating.n).toBe(0);
  });

  it("short signal trades are excluded and COUNTED, and open trades are not population", () => {
    const short = row({ id: 6, buyQty: 0, sellQty: 500, buyDate: null, avgBuyPrice: 0, avgSellPrice: 9.65 });
    const open = row({ id: 7, isOpen: true });
    const a = ruleAdherence([row(), short, open]);
    expect(a.excludedShort).toBe(1);
    expect(a.judged + a.notJudgeable).toBe(1);
  });
});

describe("(B) edge by model × direction × exit", () => {
  it("groups on the three keys, with '—' for what was never recorded", () => {
    const g = edgeByGroup([
      row({ id: 1, netPnl: 3600 }, { model: "S1" }),
      row({ id: 2, netPnl: -900 }, { model: "S1" }),
      row({ id: 3, netPnl: 100 }, { model: null, exitStatus: null }),
    ]);
    const s1 = g.find((x) => x.model === "S1" && x.exitStatus === "T2_HIT")!;
    expect([s1.n, s1.winRate, s1.expectancy]).toEqual([2, 0.5, 1350]);
    const unlabelled = g.find((x) => x.model === "—")!;
    expect([unlabelled.optionType, unlabelled.exitStatus, unlabelled.n]).toEqual(["CE", "—", 1]);
  });

  it("avgR is R ON THE SIGNAL SL, and is null (never 0) when no row carries one", () => {
    const withSl = edgeByGroup([row({ netPnl: 3380 })])[0];
    // (9.65 − 6.27) × 500 = 1690 of risk; 3380 / 1690 = 2R.
    expect([withSl.rN, withSl.avgR]).toEqual([1, 2]);
    const noSl = edgeByGroup([row({ id: 2 }, { sl: null })])[0];
    expect([noSl.rN, noSl.avgR]).toEqual([0, null]);
    // entry ≤ sl prices nothing — excluded, never substituted with riskAmount.
    const inverted = edgeByGroup([row({ id: 3 }, { sl: 12 })])[0];
    expect([inverted.rN, inverted.avgR]).toEqual([0, null]);
  });
});

describe("(C) ladder — the day's recorded range", () => {
  const withHl = (o: Partial<SignalTradeRow>, s: Partial<TradeSignal>) => row(o, { dayHigh: 10.5, dayLow: 7.55, ...s });

  it("counts each hit out of the rows that carry that level", () => {
    const l = ladderStats([
      withHl({ id: 1 }, { t1: 10.0, t2: 19.3, sl: 7.0 }), // T1 reached, T2 not, SL not touched
      withHl({ id: 2 }, { t1: 14.48, t2: null, sl: 7.6 }), // T1 not, no T2, SL touched
    ]);
    expect(l.eligible).toBe(2);
    expect(l.total).toBe(2);
    expect(l.reachT1).toEqual({ n: 1, of: 2 });
    expect(l.reachT2).toEqual({ n: 0, of: 1 });
    expect(l.touchSl).toEqual({ n: 1, of: 2 });
  });

  it("MFE / MAE are means over the eligible rows", () => {
    const l = ladderStats([withHl({}, {})]);
    expect(l.mfePct).toBeCloseTo((10.5 - 9.65) / 9.65, 10);
    expect(l.maePct).toBeCloseTo((7.55 - 9.65) / 9.65, 10);
  });

  it("a contradictory or missing H/L is excluded from eligible but still counted in total", () => {
    const contradictory = withHl({ id: 2 }, { dayHigh: 7, dayLow: 10 });
    const entryOutside = withHl({ id: 3, avgBuyPrice: 20 }, {});
    const noRange = row({ id: 4 }, {});
    const l = ladderStats([withHl({}, {}), contradictory, entryOutside, noRange]);
    expect([l.eligible, l.total]).toEqual([1, 4]);
    expect(Number.isFinite(l.mfePct!)).toBe(true);
  });

  it("shorts are excluded and counted; an empty population reports null, not 0 (invariant 6)", () => {
    const short = row({ id: 6, buyQty: 0, sellQty: 500, avgBuyPrice: 0, buyDate: null });
    const l = ladderStats([short]);
    expect(l.excludedShort).toBe(1);
    expect([l.eligible, l.mfePct, l.maePct]).toEqual([0, null, null]);
  });
});

describe("withholding", () => {
  it("a free build gets NO analytics keys on the wire — withheld before the payload", () => {
    expect(withholdSignalAnalytics([row()], false)).toBeNull();
    const wire = JSON.stringify({ rows: [{ id: 1 }], analytics: withholdSignalAnalytics([row()], false) });
    for (const key of ["adherence", "byCode", "expectancy", "avgR", "mfePct"]) {
      expect(wire, `${key} must not reach a free build`).not.toContain(key);
    }
    const pro = withholdSignalAnalytics([row()], true)!;
    expect(Object.keys(pro).sort()).toEqual(["adherence", "edge", "ladder"]);
  });
});
