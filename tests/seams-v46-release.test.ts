import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { todayIstIso } from "@/lib/domain/trading-day";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { buildContext, rankParsers } from "@/lib/import/detect";
import type { ParsedFile } from "@/lib/import/types";
import {
  hhmmOf,
  isMarketOpen,
  latestBhavcopyDate,
  markMinuteInForce,
  officialCloseAvailableAt,
  CALENDAR_COVERS_THROUGH,
  COVERAGE_WARN_DAYS,
} from "@/lib/domain/market-calendar";
import { shouldPersistMark } from "@/lib/quotes/persist-mark";
import { DEFAULT_SEND_TIME, shouldSendDigest } from "@/lib/telegram/digest-gate";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { isMarketOpenIst } from "@/lib/live/market-hours";
import { planCatchup } from "@/lib/atlas/catchup-plan";
import { exitDateOf, entryDateOf, sideOf, INTRADAY_SHORT_NOTE, OVERNIGHT_SHORT_NOTE } from "@/lib/domain/side";
import { closedOnOrAfter, taxByFy } from "@/lib/analytics/tax";
import { aggregateTradesByFy } from "@/lib/analytics/capital-gains";
import { itrPackByFy, itrPageInputs } from "@/lib/analytics/itr";
import { itrScheduleByFy, scheduleExportRows } from "@/lib/analytics/itr-schedule";
import type { ReconcileTrade, ReferenceRowRecord } from "@/lib/queries/reference";
import { ruleAdherence } from "@/lib/analytics/signal-book";
import { emptySignal, serializeSignal } from "@/lib/domain/signal";
import { computeCohorts } from "@/lib/atlas/cohort";
import { COHORT_MIN_PRICED } from "@/lib/atlas/types";
import { universeClassification } from "@/lib/analytics/stock-universe";
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import type { Series } from "@/lib/atlas/types";
import { HUBS, hubTabHref, resolveTab, hubForHref } from "@/lib/domain/hubs";
import { HELP_ENTRIES, HELP_TOPIC_LINKS } from "@/lib/domain/help-content";
import { HELP_TASKS } from "@/lib/domain/help-topics";
import { tabVisible } from "@/lib/domain/workspace";
import { topicForPath } from "@/components/help/help-link";
import { buildCommands, commandsFor } from "@/components/system/command-palette";
import nextConfig from "../next.config";
import { findRates } from "@/lib/engine/rates";
import { OPENALGO_MIN_VERSION, openAlgoBrokerOptions } from "@/lib/import/api/openalgo";

/**
 * ════════════════════════════════════════════════════════════════════════════
 * v4.6.0 RELEASE SEAM PASS — the values handed between the nine wave builders
 * (W1 e8d8f58 · W8 023b48f+4c04e4e · W2 0c40e86 · W9 2907833 · W3 0d9a36e ·
 *  W4 6a4b966 · W5 980a9c9 · W6 3532dae · W7 5548d46), both real halves run
 * together. Base for "pre-wave" = tag v4.5.0 (b6b8863).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * crossing value              | producer (wave)                                | consumer (wave)                                        | unit                 | case
 * ----------------------------|------------------------------------------------|--------------------------------------------------------|----------------------|-----
 * official-close mark minute  | W1 market-calendar.ts:455 officialCloseAvailableAt | persist-mark.ts:101 markAfterIstMin → shouldPersistMark | IST min past 00:00  | 1a
 * F&O mark minute (send time) | W1 market-calendar.ts markMinuteInForce         | digest-gate.ts:53 DEFAULT_SEND_TIME; W8 schema default | "HH:MM" IST          | 1b
 * special session w/ hours    | W1 tradingDayStatus/sessionFor                  | digest-gate.ts shouldSendDigest (Budget Sunday)        | ISO IST date         | 1b
 * is-it-open                  | W1 market-calendar.ts:437 isMarketOpen          | live/market-hours.ts isMarketOpenIst (sidebar, desk)   | instant → bool       | 1c
 * newest bhavcopy session     | W1 market-calendar.ts:282 latestBhavcopyDate    | W5 catchup-plan.ts:52 planCatchup; auto-mtm.ts:223     | ISO IST date         | 1d
 * coversThrough - today       | W1 market-calendar.ts:565 calendarCoverage      | queries/data-quality.ts:279 (todayIstIso) → DQ issue   | days, IST day        | 1e
 * trades.side (flat row)      | W6 commit.ts:2490 side: sideOf(t) / pair-legs   | side.ts:102 sideOf / exitDateOf → tax, signal book     | 'long'|'short'|null  | 2a,2b,2c
 * FY of a closed short        | W6 overnight short (sellDate = ENTRY)           | analytics/tax.ts:99 fyOf(t.sellDate)                   | FY "YYYY-YY"         | 2b
 * purchase rows per entry leg | W7 realised-rows.ts:378 purchaseRows            | app/api/ais/route.ts bump(fyOf(p.buyDate))             | rupees, FY           | 3a
 * basis write on a ladder     | app/trades/actions.ts:641 setAcquisitionAction  | purchaseRows guard / realised rows / invariant 5       | qty, rupees, date    | 3b
 * classification ref          | W2 stock-universe.json → getClassificationResolution | W5 queries/atlas.ts:493 classificationOfFn → cohort.ts | macro/sector/industry | 4a
 * AMFI band by ISIN           | W2 instruments.ts:224 getCapBandMap             | W5 queries/atlas.ts:506 capBandOfFn (instrument join)  | "large"|"mid"|"small" | 4b
 * user sector tag             | instruments.sector (user)                       | W5 cohort level (industry null → sector)               | label                | 4c
 * hub tab URL                 | W3 hubs.ts hubTabHref / next.config.ts:16       | W4 help-link.tsx:21 topicForPath, HELP_TASKS, palette  | "/reports/x?tab=y"   | 5a,5b
 * charge_config fyers/nuvama  | W9 seed-data.ts (Fyers Prime, Nuvama)           | commit.ts:222 ratesForTrade(resolvePlan) → stored row  | rupees per order     | 6a
 * parser output (heads, side) | W9 fyers-tradebook / nuvama-pnl-report          | commit.ts buildRow reportedCharges; W6 side column     | rupees; side         | 6b,2a
 * app-info version            | W8 openalgo.ts assertOpenAlgoVersion            | app/api/import/broker/route.ts:777 (commit mode)       | dotted version       | 7
 * KPI totals                  | W6 trades.ts getTradeStatsSql (integer paise)   | = tradeStatsOf(getJournalTrades()) over W9 rows        | rupees               | 8
 *
 * ── RED ON EITHER SIDE (probes run 2026-09-26, `tests/zzprobe-*`, deleted) ──
 * Each seam was re-run with ONE side swapped for its v4.5.0 text (or, where no
 * v4.5.0 text exists, the pre-wave state) — the quoted reds are in the report.
 *
 * ── RECORDED DEFECTS (it.fails; flip to `it` in the fix commit) ────────────
 *   SEAM-V46-1  lib/queries/signals.ts:39 + lib/analytics/signal-book.ts:108 —
 *               the signal book never reads `trades.side`: a same-day covered
 *               short reads LONG and is judged as a long exit (case 2c).
 *   SEAM-V46-2  lib/analytics/tax.ts:99 (same class: itr.ts:189,
 *               itr-schedule.ts:189) — a W6 overnight F&O short is filed in the
 *               FY of its SALE (its entry) instead of its cover (case 2b).
 *   SEAM-V46-3  app/trades/actions.ts:594 setAcquisitionAction has no
 *               `hasLadder` guard — a basis write on a staged row leaves the
 *               parent contradicting its legs (invariant 5) (case 3b).
 *
 * ONE temp database for the FILE (tests/helpers/temp-db.ts).
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
// Pins the vault wrap so the OpenAlgo save behaves the same on Windows and CI.
process.env.VYUHA_VAULT_PROVIDER = "machine";

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const FYERS_FIXTURE = "fyers-tradebook-2026-07-25_2026-08-25.csv";
const NUVAMA_FIXTURE = "nuvama-pnl-report-2026-07-01_2026-09-22.xlsx";
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);

/** A synthetic Fyers tradebook (the W9 parser's verified layout, newest first):
 *  an overnight short sold 30 Mar 2026 (FY 2025-26) and covered 01 Apr 2026
 *  (FY 2026-27), and a same-day covered short on 06 Apr 2026. */
const FYERS_SHORTS_CSV = [
  "Report Title,Tradebook report,,,,,,,,,",
  "Date Range,From 30/03/2026 to 06/04/2026,,,,,,,,,",
  ",,,,,,,,,,",
  "Symbol name,Symbol code,Date & time,Side,Product type,Qty,Traded price,Total value,Segment,Exchange order ID,OMS order ID",
  'NIFTY26APR22500CE,NIFTY 22500 CE,"06 Apr 2026, 02:00:00 PM",BUY,Overnight,75,80,"6,000.00",Derivatives,1300000000000014,2604060000014',
  'NIFTY26APR22500CE,NIFTY 22500 CE,"06 Apr 2026, 09:30:00 AM",SELL,Overnight,75,100,"7,500.00",Derivatives,1300000000000013,2604060000013',
  'NIFTY26APR23000PE,NIFTY 23000 PE,"01 Apr 2026, 02:40:00 PM",BUY,Overnight,75,90,"6,750.00",Derivatives,1300000000000012,2604010000012',
  'NIFTY26APR23000PE,NIFTY 23000 PE,"30 Mar 2026, 09:20:00 AM",SELL,Overnight,75,120,"9,000.00",Derivatives,1300000000000011,2603300000011',
].join("\n");

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let trades: typeof import("@/lib/queries/trades");
let staged: typeof import("@/lib/queries/staged");
let ratesDb: typeof import("@/lib/engine/rates-db");
let aisRoute: typeof import("@/app/api/ais/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let realisedQ: typeof import("@/lib/queries/realised-rows");
let taxItr: typeof import("@/lib/queries/tax-itr");
let signals: typeof import("@/lib/queries/signals");
let dq: typeof import("@/lib/queries/data-quality");
let autoMtm: typeof import("@/lib/jobs/auto-mtm");
let atlasQ: typeof import("@/lib/queries/atlas");
let instrumentsQ: typeof import("@/lib/queries/instruments");
let actions: typeof import("@/app/trades/actions");
let referenceQ: typeof import("@/lib/queries/reference");
let fyersParsed: ParsedFile;
let nuvamaParsed: ParsedFile;

const FYERS_ACC = 2;
const NUVAMA_ACC = 3;
const BASIS_ACC = 4;

function parseFile(file: string, bytes: Buffer): Promise<ParsedFile> {
  const ctx = buildContext(file, bytes);
  return Promise.resolve(rankParsers(ctx)[0].parse(ctx));
}
const select = (id: number) => t.sqlite.prepare("UPDATE settings SET selected_account_id = ?").run(id);

beforeAll(async () => {
  // Measured locally: ~1.9 s (two real fixtures parsed and committed); the
  // raised timeout is for the Windows runner, > 15x slower (AGENTS.md § Testing).
  t = await openTempDb("seams-v46-release", { seed: true });
  commit = await import("@/lib/import/commit");
  trades = await import("@/lib/queries/trades");
  staged = await import("@/lib/queries/staged");
  ratesDb = await import("@/lib/engine/rates-db");
  aisRoute = await import("@/app/api/ais/route");
  brokerRoute = await import("@/app/api/import/broker/route");
  realisedQ = await import("@/lib/queries/realised-rows");
  taxItr = await import("@/lib/queries/tax-itr");
  signals = await import("@/lib/queries/signals");
  dq = await import("@/lib/queries/data-quality");
  autoMtm = await import("@/lib/jobs/auto-mtm");
  atlasQ = await import("@/lib/queries/atlas");
  instrumentsQ = await import("@/lib/queries/instruments");
  actions = await import("@/app/trades/actions");
  referenceQ = await import("@/lib/queries/reference");

  const acc = t.sqlite.prepare("INSERT INTO accounts (id, name, broker, broker_plan) VALUES (?, ?, ?, ?)");
  acc.run(FYERS_ACC, "Fyers seam", "fyers", "prime");
  acc.run(NUVAMA_ACC, "Nuvama seam", "nuvama", null);
  acc.run(BASIS_ACC, "Basis seam", "zerodha", null);

  fyersParsed = await parseFile(FYERS_FIXTURE, fs.readFileSync(path.join(DIR, FYERS_FIXTURE)));
  nuvamaParsed = await parseFile(NUVAMA_FIXTURE, fs.readFileSync(path.join(DIR, NUVAMA_FIXTURE)));
  commit.commitParsedFile(fyersParsed, FYERS_FIXTURE, null, FYERS_ACC);
  commit.commitParsedFile(nuvamaParsed, NUVAMA_FIXTURE, null, NUVAMA_ACC);
  const shorts = await parseFile("FYERS_tradebook_SHORTS.csv", Buffer.from(FYERS_SHORTS_CSV));
  commit.commitParsedFile(shorts, "FYERS_tradebook_SHORTS.csv", null, FYERS_ACC);
}, 30_000);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.cleanup();
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (iso: string) => new Date(iso);

// ─────────────────────────────────────────────────────────────────────────────
// 1 · W1 market calendar → every "is the mark final / is the market open" reader
// ─────────────────────────────────────────────────────────────────────────────

describe("1 · W1 calendar timings into the marks, the digest, the desk, the catch-up and Data Quality", () => {
  // 2026-09-28 is a Monday, after CAS began (2026-08-03). RELIANCE is an F&O
  // underlying (CAS stock), so its close waits for the auction.
  const MON = "2026-09-28";
  const ist = (hhmm: string) => at(`${MON}T${hhmm}:00+05:30`);

  it("1a · persist-mark: a CAS stock waits to its official close + 1 (15:36), a non-CAS to 15:31, a derivative to 15:45", () => {
    const cas = officialCloseAvailableAt(MON, "NSE_CM", "cas_stock")!;
    const eq = officialCloseAvailableAt(MON, "NSE_CM", "equity")!;
    const fo = officialCloseAvailableAt(MON, "NSE_FO", "derivative")!;
    expect([hhmmOf(eq), hhmmOf(cas), hhmmOf(fo)], "the calendar's own minutes").toEqual(["15:31", "15:36", "15:45"]);

    const reliance = { symbol: "RELIANCE", exchange: "NSE" as const };
    const nifty = { symbol: "NIFTY", exchange: "NFO" as const, tradingsymbol: "NIFTY26SEP24500CE" };
    // 15:33 IST: past the non-CAS door, before the auction's.
    expect(shouldPersistMark(ist("15:33"), null, reliance)).toMatchObject({ ok: false, code: "before-close", date: MON });
    expect(shouldPersistMark(ist("15:36"), null, reliance)).toMatchObject({ ok: true, date: MON });
    // 15:42 IST: F&O traded until 15:40 — its mark is not final until 15:45.
    expect(shouldPersistMark(ist("15:42"), null, nifty)).toMatchObject({ ok: false, code: "before-close" });
    expect(shouldPersistMark(ist("15:45"), null, nifty)).toMatchObject({ ok: true });
    // 18:45 UTC on Thursday 1 Oct is 00:15 IST on Friday 2 Oct — Gandhi Jayanti.
    expect(shouldPersistMark(at("2026-10-01T18:45:00Z"), null, reliance)).toMatchObject({ ok: false, code: "holiday", date: "2026-10-02" });
  });

  it("1b · the digest's fallback send time IS the F&O mark minute, the stored default (W8 schema) agrees, and Budget Sunday sends", () => {
    const foMark = hhmmOf(markMinuteInForce("NSE_FO", "derivative")!);
    expect(DEFAULT_SEND_TIME).toBe(foMark);
    const stored = (t.sqlite.prepare("SELECT telegram_send_time AS s FROM settings").get() as { s: string }).s;
    expect(stored, "the seeded settings row (drizzle writes the schema default)").toBe(foMark);

    const base = { enabled: true, ackVersion: TELEGRAM_DISCLOSURE.version, hasCredentials: true, lastSentDate: null };
    // An UNREADABLE stored time falls back to the calendar's minute: 15:42 is F&O still settling.
    const gate = (now: Date, sendTime: string | null) => shouldSendDigest({ ...base, sendTime }, now);
    expect(gate(ist("15:44"), stored)).toMatchObject({ send: false, today: MON });
    expect(gate(ist("15:42"), "garbage")).toMatchObject({ send: false, today: MON });
    expect(gate(ist("15:45"), "garbage")).toMatchObject({ send: true, today: MON });
    // Budget Sunday 2026-02-01 is a special session with normal hours: a digest goes.
    expect(gate(at("2026-02-01T16:00:00+05:30"), stored)).toMatchObject({ send: true, today: "2026-02-01" });
    // 18:45 UTC Friday 2 Oct = 00:15 IST Saturday: the IST day is a weekend.
    expect(gate(at("2026-10-02T18:45:00Z"), stored)).toMatchObject({ send: false, today: "2026-10-03" });
  });

  it("1c · the desk's is-it-open is the calendar's: F&O trades to 15:40, a holiday is shut, 18:30 UTC is tomorrow in IST", () => {
    expect(isMarketOpenIst(ist("15:35"))).toBe(true);
    expect(isMarketOpenIst(ist("15:35"))).toBe(isMarketOpen(ist("15:35")));
    expect(isMarketOpenIst(ist("15:41"))).toBe(false);
    expect(isMarketOpenIst(at("2026-10-02T10:00:00+05:30"))).toBe(false); // Gandhi Jayanti
    // 04:00 UTC Mon = 09:30 IST Mon (open); 18:30 UTC Mon = 00:00 IST Tue (closed).
    expect(isMarketOpenIst(at(`${MON}T04:00:00Z`))).toBe(true);
    expect(isMarketOpenIst(at(`${MON}T18:30:00Z`))).toBe(false);
  });

  it("1d · the Atlas catch-up and auto-MTM agree on the newest session across the IST day boundary (holiday, Budget Sunday)", async () => {
    // 18:45 UTC Fri 2 Oct = 00:15 IST Sat 3 Oct: the newest session is Thu 1 Oct (2 Oct is a holiday).
    const plan = planCatchup({ rowsByDate: new Map(), fullSessionMinRows: 1, now: at("2026-10-02T18:45:00Z"), windowDays: 3 });
    expect(plan.newest).toBe("2026-10-01");
    expect(plan.missing).toEqual(["2026-09-30", "2026-09-29", "2026-09-28"]);
    // 18:45 UTC Sun 1 Feb = 00:15 IST Mon 2 Feb: the newest session is the Budget SUNDAY.
    const budget = planCatchup({ rowsByDate: new Map(), fullSessionMinRows: 1, now: at("2026-02-01T18:45:00Z"), windowDays: 1 });
    expect(budget.newest).toBe("2026-02-01");
    expect(budget.missing).toEqual(["2026-01-30"]);

    // auto-MTM reads the SAME calendar: with the Budget Sunday already applied it
    // is a no-op, and never dials the network (the stub throws if it does).
    vi.stubGlobal("fetch", () => {
      throw new Error("TEST GUARD: auto-MTM reached the network");
    });
    try {
      t.sqlite.prepare("UPDATE settings SET auto_mtm_enabled = 1, last_auto_mtm_date = '2026-02-01'").run();
      const out = await autoMtm.runAutoMtm(at("2026-02-01T18:45:00Z"));
      expect(out).toMatchObject({ ran: false, date: latestBhavcopyDate(at("2026-02-01T18:45:00Z")) });
      expect(out.reason).toBe("Already applied the 2026-02-01 bhavcopy.");
    } finally {
      t.sqlite.prepare("UPDATE settings SET auto_mtm_enabled = 0, last_auto_mtm_date = NULL").run();
      vi.unstubAllGlobals();
    }
  });

  it("1e · Data Quality's calendar warning turns on at the IST day, not the UTC one (60 days before coversThrough)", () => {
    expect([CALENDAR_COVERS_THROUGH, COVERAGE_WARN_DAYS]).toEqual(["2026-12-31", 60]);
    const coverage = () => dq.getDataQualityReport().issues.find((i) => i.code === "calendar_coverage");
    vi.useFakeTimers({ toFake: ["Date"] });
    // 18:15 UTC on 31 Oct = 23:45 IST on 31 Oct: 61 days left — no warning yet.
    vi.setSystemTime(at("2026-10-31T18:15:00Z"));
    expect(coverage()).toBeUndefined();
    // 18:45 UTC on 31 Oct = 00:15 IST on 1 Nov: 60 days left — it warns.
    vi.setSystemTime(at("2026-10-31T18:45:00Z"));
    expect(coverage()).toMatchObject({ severity: "warning", title: "Market calendar runs out soon" });
    expect(coverage()!.detail).toContain("(60 days left)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · W6 trades.side → the readers (tax, signal book), through a W9 parser
// ─────────────────────────────────────────────────────────────────────────────

type Row = { id: number; side: string | null; buyQty: number; sellQty: number; buyDate: string; sellDate: string; importNotes: string | null; netPnl: number; grossPnl: number; isOpen: boolean; tradingsymbol: string };
const rowsOf = (accountId: number, where = "1=1") =>
  t.sqlite
    .prepare(
      `SELECT id, side, buy_qty AS buyQty, sell_qty AS sellQty, buy_date AS buyDate, sell_date AS sellDate, import_notes AS importNotes,
              net_pnl_paise / 100.0 AS netPnl, gross_pnl_paise / 100.0 AS grossPnl, is_open AS isOpen, tradingsymbol
         FROM trades WHERE account_id = ? AND ${where} ORDER BY id`,
    )
    .all(accountId) as Row[];

describe("2 · W6 side → the readers of a closed short (W9 Fyers parser → W6 pairing → commit)", () => {
  const overnight = () => rowsOf(FYERS_ACC).filter((r) => (r.importNotes ?? "").includes(OVERNIGHT_SHORT_NOTE));
  const sameDay = () => rowsOf(FYERS_ACC).filter((r) => (r.importNotes ?? "").includes(INTRADAY_SHORT_NOTE));

  it("2a · the overnight short is ONE closed short row: side 'short', entry = the sale (30 Mar), exit = the cover (1 Apr)", () => {
    const rows = overnight();
    expect(rows.map((r) => [r.side, r.buyQty, r.sellQty, r.sellDate, r.buyDate, !!r.isOpen])).toEqual([["short", 75, 75, "2026-03-30", "2026-04-01", false]]);
    const r = rows[0];
    expect([sideOf(r), entryDateOf(r), exitDateOf(r)]).toEqual(["short", "2026-03-30", "2026-04-01"]);
    expect(r.grossPnl).toBe(9000 - 6750);
    // …and the same-day short reads short ONLY through the stored column (its dates are equal).
    const s = sameDay();
    expect(s.map((x) => [x.side, x.buyDate, x.sellDate])).toEqual([["short", "2026-04-06", "2026-04-06"]]);
    expect(sideOf({ ...s[0], side: null, importNotes: null }), "without the column the row states nothing → long").toBe("long");
  });

  // SEAM-V46-2 — RECORDED DEFECT. W6 made an overnight F&O short a CLOSED row whose
  // sellDate is its ENTRY; the tax pack files a closed row by `fyOf(t.sellDate)`
  // (lib/analytics/tax.ts:99; same read: itr.ts:189, itr-schedule.ts:189), so a
  // short sold in March and covered in April is income of the SALE's year. The
  // position is squared off — the income arises — on the cover (`exitDateOf`).
  // FIXED in the v4.6.0 fix wave: every tax boundary fills the REQUIRED `fyDate`
  // with `fyDateOf(t)` (the closing leg's day) and the builders file by it.
  it("2b · the tax pack files the overnight short in the FY of its cover (2026-27), not of its sale (2025-26)", () => {
    select(FYERS_ACC);
    const { taxRows } = taxItr.getTaxBase(null);
    const byFy = new Map(taxByFy(taxRows, 4, "2026-27").map((s) => [s.fy, s]));
    const short = overnight()[0];
    // On HEAD: 2025-26 holds fnoBusiness = this short's net and 1 trade.
    expect(byFy.get("2025-26")?.trades ?? 0, "FY 2025-26 (the sale) must hold nothing").toBe(0);
    expect(short.netPnl).toBeGreaterThan(0);
  });

  // The guard case the design review asked for (fix wave A2): ONE cross-FY
  // overnight short, filed under the COVER's FY by every surface that files a
  // realised row in a year — /reports/tax (scaffold + set-off engine), the ITR
  // pack's mapping (pack, set-off, schedule and its export), the harvest and
  // advance-tax FY windows, and the broker reconciliation's closed-P&L bucket.
  it("2d · the cross-FY overnight short sits in FY 2026-27 on /reports/tax, /reports/itr, harvest, advance-tax and reconcile", () => {
    select(FYERS_ACC);
    const short = overnight()[0];
    const base = taxItr.getTaxBase(null);
    const fys = (xs: { fy: string }[]) => xs.map((x) => x.fy);
    // /reports/tax — the scaffold and the set-off engine.
    expect(fys(taxByFy(base.taxRows, 4, "2026-27")), "taxByFy").toEqual(["2026-27"]);
    expect(fys(aggregateTradesByFy(base.cgTrades, 4, "2026-27")), "set-off engine").toEqual(["2026-27"]);
    // /reports/itr — the page's own mapping into all three builders.
    const inputs = itrPageInputs(realisedQ.getRealisedRows(trades.getTrades([FYERS_ACC])));
    const packs = itrPackByFy(inputs.pack, 4, "2026-27");
    expect(fys(packs), "ITR pack").toEqual(["2026-27"]);
    expect(fys(aggregateTradesByFy(inputs.capitalGains, 4, "2026-27")), "ITR set-off").toEqual(["2026-27"]);
    const sched = itrScheduleByFy(inputs.schedule, 4, "2026-27");
    expect(fys(sched), "ITR schedule").toEqual(["2026-27"]);
    expect([...new Set(scheduleExportRows(sched).map((r) => r.fy))], "ITR schedule export").toEqual(["2026-27"]);
    // …and it IS the short that moved: its row is in the 2026-27 F&O head.
    const shortRow = inputs.pack.find((p) => p.sellDate === "2026-03-30")!;
    expect([shortRow.buyDate, shortRow.fyDate]).toEqual(["2026-04-01", "2026-04-01"]);
    // /reports/harvest + /reports/advance-tax — the FY window (2026-27 opens 1 Apr).
    const harvestRow = trades.getHarvestTrades([FYERS_ACC]).find((r) => r.id === short.id)!;
    expect(closedOnOrAfter(harvestRow, "2026-04-01"), "closed this FY").toBe(true);
    expect(harvestRow.sellDate! >= "2026-04-01", "the pre-fix read (sellDate) said last FY").toBe(false);
    for (const page of ["app/reports/harvest/page.tsx", "app/reports/advance-tax/page.tsx"]) {
      const code = fs.readFileSync(page, "utf8").replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");
      expect(/closedOnOrAfter\(t, fyStart\)/.test(code), `${page} windows through closedOnOrAfter`).toBe(true);
      expect(/t\.sellDate\s*(?:>=|<)\s*fyStart/.test(code), `${page} has no sellDate window left`).toBe(false);
      expect(/fyDate: fyDateOf\(t\)/.test(code), `${page} fills fyDate`).toBe(true);
    }
    // reconcile — the broker's FY lines: the short's P&L is in 2026-27, not 2025-26.
    const recRows = t.sqlite
      .prepare(
        `SELECT isin, symbol, tradingsymbol, segment, sell_date AS sellDate, buy_date AS buyDate, buy_qty AS buyQty, sell_qty AS sellQty,
                buy_value_paise / 100.0 AS buyValue, sell_value_paise / 100.0 AS sellValue, gross_pnl_paise / 100.0 AS grossPnl,
                net_pnl_paise / 100.0 AS netPnl, charges_total_paise / 100.0 AS chargesTotal, is_open AS isOpen, acquisition, side, import_notes AS importNotes
           FROM trades WHERE id = ?`,
      )
      .all(short.id) as ReconcileTrade[];
    const ref = (fy: string): ReferenceRowRecord => ({
      id: 1, accountId: FYERS_ACC, broker: "fyers", sourceId: "fyers-realised-pnl", scope: "fy",
      key: fy, isin: null, symbol: null, fy, asOf: null, figures: { grossPnl: 0 }, note: null, importBatchId: null, createdAt: "2026-09-26",
    });
    const rec = referenceQ.reconcileFrom([ref("2025-26"), ref("2026-27")], recRows.map((r) => ({ ...r, isOpen: !!r.isOpen })), 4);
    const gross = Object.fromEntries(rec.fy.map((l) => [l.key, l.vyuha.grossPnl ?? 0]));
    expect(gross, "reconcile FY lines").toEqual({ "2025-26": 0, "2026-27": short.grossPnl });
  });

  // SEAM-V46-1 — RECORDED DEFECT. getSignalTrades (lib/queries/signals.ts:39)
  // selects no `side`, and signalSide (lib/analytics/signal-book.ts:108) passes
  // none, so a same-day covered short — flat, equal dates — reads LONG: block A
  // judges its exit as a long's and `excludedShort` stays 0.
  // FIXED in the v4.6.0 fix wave: signals.ts selects side + importNotes and
  // signalSide hands both to sideOf.
  it("2c · the signal book excludes a same-day covered short (side read from trades.side)", () => {
    const s = sameDay()[0];
    const sig = serializeSignal({ ...emptySignal(), model: "S1", exitStatus: "T1_HIT", spot: 22500 });
    t.sqlite.prepare("UPDATE trades SET signal_json = ? WHERE id = ?").run(sig, s.id);
    try {
      select(FYERS_ACC);
      const rows = signals.getSignalTrades();
      expect(rows.map((r) => r.id)).toEqual([s.id]);
      expect(ruleAdherence(rows).excludedShort).toBe(1);
    } finally {
      t.sqlite.prepare("UPDATE trades SET signal_json = NULL WHERE id = ?").run(s.id);
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · W7 purchaseRows → the AIS route; and the basis-write contradiction
// ─────────────────────────────────────────────────────────────────────────────

async function aisTotals(): Promise<Record<string, number | null>> {
  const res = await aisRoute.POST(
    new Request("http://local/api/ais", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "nothing to parse" }) }),
  );
  expect(res.status).toBe(200);
  const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
  return Object.fromEntries(recon.fyTotals.map((f) => [`${f.fy} ${f.kind}`, f.journal]));
}

describe("3 · W7 purchase rows through POST /api/ais, beside the realised sale rows of the SAME ladder", () => {
  it("3a · a ladder bought across two FYs and partly sold states each purchase in its own FY and the sale in its fill's FY", async () => {
    const id = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: 1, broker: "zerodha", segment: "eq_delivery", symbol: "W7SEAM", tradingsymbol: "W7SEAM", buyQty: 100, avgBuyPrice: 20, buyValue: 2000, buyDate: "2026-03-20", isOpen: true, side: "long" }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    select(1);
    const conv = staged.convertToStaged(id);
    expect(conv.ok, conv.message).toBe(true);
    for (const leg of [
      { kind: "entry" as const, tradeDate: "2026-04-10", qty: 40, price: 21 },
      { kind: "exit" as const, tradeDate: "2026-04-20", qty: 60, price: 25 },
    ]) {
      const res = staged.addLeg({ tradeId: id, direction: "long", ...leg });
      expect(res.ok, res.message).toBe(true);
    }
    select(1);
    const totals = await aisTotals();
    const parent = t.sqlite.prepare("SELECT buy_value_paise / 100.0 AS bv FROM trades WHERE id = ?").get(id) as { bv: number };
    expect(parent.bv).toBe(2840);
    expect(totals["2025-26 purchase"], "e1 — the FY it was bought").toBe(2000);
    expect(totals["2026-27 purchase"], "e2 — the next FY").toBe(840);
    expect(totals["2026-27 sale"], "the 60 sold on 20 Apr, at its own consideration").toBe(1500);
    expect(r2((totals["2025-26 purchase"] ?? 0) + (totals["2026-27 purchase"] ?? 0))).toBe(parent.bv);
    // The purchase and the realised rows come from ONE staged-views batch.
    const tr = trades.getTrades([1]).filter((x) => x.id === id);
    const { realised, purchases } = realisedQ.getRealisedAndPurchaseRows(tr);
    expect(purchases.map((p) => [p.buyDate, p.buyValue])).toEqual([["2026-03-20", 2000], ["2026-04-10", 840]]);
    expect(realised.map((r) => [r.buyDate, r.sellDate, r.realisedQty])).toEqual([["2026-03-20", "2026-04-20", 60]]);
  });

  // SEAM-V46-3 — RECORDED DEFECT (LEDGER D-14 "recorded, not built"). The IPO
  // push refuses a staged row (`hasLadder`, actions.ts:703); the basis write does
  // not (actions.ts:594-653). After it the parent says 50 bought at ₹150 on
  // 2024-01-15 while the ladder says 100 bought at ₹100 on 2025-03-10: the AIS
  // purchase side (guard refuses the split → parent whole) states ₹7,500 in
  // FY 2023-24, the realised side states a ₹5,000 cost acquired 2025-03-10.
  // FIXED in the v4.6.0 fix wave: setAcquisitionAction refuses a staged row
  // (`hasLadder`, as the IPO push does) and reads the row in the viewing scope.
  it("3b · a basis write on a staged ladder is refused, so the parent still states its legs (invariant 5)", async () => {
    const id = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: BASIS_ACC, broker: "zerodha", segment: "eq_delivery", symbol: "BASISLAD", tradingsymbol: "BASISLAD", buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2025-03-10", isOpen: true, side: "long" }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    select(BASIS_ACC);
    const conv = staged.convertToStaged(id);
    expect(conv.ok, `setup: ${conv.message}`).toBe(true);
    const leg = staged.addLeg({ tradeId: id, direction: "long", kind: "exit", tradeDate: "2025-05-02", qty: 50, price: 300 });
    expect(leg.ok, `setup: ${leg.message}`).toBe(true);

    const fd = new FormData();
    fd.set("tradeId", String(id));
    fd.set("acquisition", "gift");
    fd.set("acquisitionPrice", "150");
    fd.set("acquisitionDate", "2024-01-15");
    const res = await actions.setAcquisitionAction({ ok: false, message: "" }, fd);

    const legQty = (t.sqlite.prepare("SELECT SUM(qty) AS q FROM trade_legs WHERE trade_id = ? AND kind = 'entry'").get(id) as { q: number }).q;
    const parent = t.sqlite.prepare("SELECT buy_qty AS q, buy_value_paise / 100.0 AS v, buy_date AS d FROM trades WHERE id = ?").get(id) as { q: number; v: number; d: string };
    const totals = await aisTotals();
    const realised = realisedQ.getRealisedRows(trades.getTrades([BASIS_ACC]).filter((x) => x.id === id));
    // What the readers see on HEAD (quoted in the report): res.ok true; parent
    // {q:50, v:7500, d:"2024-01-15"}; legs 100; AIS {"2023-24 purchase": 7500};
    // realised [{buyValue: 5000, buyDate: "2025-03-10"}].
    expect({ ok: res.ok, parentQty: parent.q, legQty }).toEqual({ ok: false, parentQty: 100, legQty: 100 });
    expect(res.message).toContain("Add the purchase as an entry leg on the ladder");
    expect(totals["2024-25 purchase"]).toBe(10000);
    expect(realised.map((r) => [r.buyDate, r.buyValue])).toEqual([["2025-03-10", 5000]]);
    // …and the /trades AcquisitionPanel does not offer a staged row (no refusal loop).
    const page = fs.readFileSync("app/trades/page.tsx", "utf8");
    expect(/\.filter\(\(t\) => !hasKnownBasis\(t\) && !t\.staged\)/.test(page), "pending excludes staged rows").toBe(true);
  });

  it("3c · a basis write is read in the VIEWING scope (invariant 8): another account's row is refused and untouched", async () => {
    const id = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: BASIS_ACC, broker: "zerodha", segment: "eq_delivery", symbol: "BASISX", tradingsymbol: "BASISX", sellQty: 10, avgSellPrice: 50, sellValue: 500, sellDate: "2025-06-02", acquisition: "unknown", isOpen: false, side: "short" }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    try {
      select(FYERS_ACC);
      const fd = new FormData();
      fd.set("tradeId", String(id));
      fd.set("acquisition", "gift");
      fd.set("acquisitionPrice", "20");
      const res = await actions.setAcquisitionAction({ ok: false, message: "" }, fd);
      const after = t.sqlite.prepare("SELECT buy_qty AS q, acquisition AS a FROM trades WHERE id = ?").get(id) as { q: number; a: string };
      expect([res.ok, after.q, after.a]).toEqual([false, 0, "unknown"]);
      select(BASIS_ACC);
      const ok = await actions.setAcquisitionAction({ ok: false, message: "" }, fd);
      expect([ok.ok, (t.sqlite.prepare("SELECT buy_qty AS q FROM trades WHERE id = ?").get(id) as { q: number }).q], ok.message).toEqual([true, 10]);
    } finally {
      t.sqlite.prepare("DELETE FROM trades WHERE id = ?").run(id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · W2 stock universe → W5 Atlas cohorts and cap bands
// ─────────────────────────────────────────────────────────────────────────────

describe("4 · W2 universe → W5 cohorts (industry falling UP to sector, level decided once) and the AMFI band join", () => {
  /** A deterministic pick from the REAL bundled universe: the first sector (by
   *  name) with one industry of ≥ COHORT_MIN_PRICED symbols and another industry. */
  function pick() {
    const res = instrumentsQ.getClassificationResolution();
    const bySector = new Map<string, Map<string, string[]>>();
    for (const [sym, r] of [...res.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (r.source !== "taxonomy" || !r.sector || !r.industry) continue;
      const inds = bySector.get(r.sector) ?? new Map<string, string[]>();
      inds.set(r.industry, [...(inds.get(r.industry) ?? []), sym]);
      bySector.set(r.sector, inds);
    }
    for (const sector of [...bySector.keys()].sort()) {
      const inds = [...bySector.get(sector)!.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      const big = inds.find(([, s]) => s.length >= COHORT_MIN_PRICED);
      const other = inds.find(([i]) => i !== big?.[0]);
      if (big && other) return { sector, bigIndustry: big[0], members: big[1].slice(0, COHORT_MIN_PRICED), lone: other[1][0], loneIndustry: other[0] };
    }
    throw new Error("the bundled universe offers no sector with two industries");
  }
  const series = (symbol: string, drift: number): Series => ({
    symbol,
    bars: Array.from({ length: 30 }, (_, i) => ({ symbol, date: `2026-07-${String(i + 1).padStart(2, "0")}`, high: null, low: null, close: 100 * (1 + (drift * i) / 1000), volume: null })),
  });

  it("4a · a held symbol alone in its industry falls UP to its sector; a member of a full industry stays at industry", () => {
    const p = pick();
    const aligned = [...p.members.map((s, i) => series(s, i + 1)), series(p.lone, 20)];
    const resolve = atlasQ.classificationOfFn();
    expect(resolve(p.lone)).toMatchObject({ sector: p.sector, industry: p.loneIndustry });
    // The labels that cross ARE the W2 universe's, read by the exchange ISIN.
    for (const sym of [p.lone, p.members[0]]) {
      const isin = bundledIsinBySymbol(sym);
      expect(universeClassification(isin ?? "")?.industry ?? null, `${sym} (${isin}) in the W2 universe`).toBe(resolve(sym)?.industry);
    }
    const out = computeCohorts(aligned, [p.lone, p.members[0]], resolve, new Map());
    const lone = out.rows.find((r) => r.symbol === p.lone)!;
    const full = out.rows.find((r) => r.symbol === p.members[0])!;
    expect([lone.level, lone.fellUp, lone.group, lone.thin, lone.decidedOn?.members]).toEqual(["sector", true, p.sector, false, COHORT_MIN_PRICED + 1]);
    expect([full.level, full.fellUp, full.group, full.decidedOn?.members]).toEqual(["industry", false, p.bigIndustry, COHORT_MIN_PRICED]);
    // Level decided ONCE: both windows of a row compare against the same members.
    expect(lone.windows["1w"].members).toBe(lone.windows["1m"].members);
  });

  it("4b · the AMFI band crosses by ISIN through the instrument join (RELIANCE INE002A01018 → large)", () => {
    expect(instrumentsQ.getCapBandMap().get("INE002A01018")?.band).toBe("large");
    t.sqlite.prepare("INSERT INTO instruments (symbol, isin) VALUES ('RELIANCE', 'INE002A01018')").run();
    try {
      expect(atlasQ.capBandOfFn()("reliance")).toBe("large");
    } finally {
      t.sqlite.prepare("DELETE FROM instruments WHERE symbol = 'RELIANCE'").run();
    }
  });

  // v4.6.0 fix wave (audit OBS, design review A8): the band is resolved PER SYMBOL
  // — the user's instrument ISIN first, else the bundled listing's owner of the
  // ticker (NSE > Emerge > BSE) — so a fresh install with no instrument rows
  // still gets AMFI bands, and a user's ISIN still wins.
  it("4d · a fresh install (no instruments row) gets the AMFI band; a user's instrument ISIN wins; shared tickers take their OWNER's band", () => {
    const bands = instrumentsQ.getCapBandMap();
    expect((t.sqlite.prepare("SELECT count(*) AS n FROM instruments WHERE isin IS NOT NULL").get() as { n: number }).n, "no instrument ISINs on file").toBe(0);
    expect(atlasQ.capBandOfFn()("RELIANCE"), "RELIANCE on a fresh install").toBe("large");
    // The user's row wins: RELIANCE pointed at a MID-cap's ISIN reads mid.
    const midIsin = [...bands.entries()].find(([, b]) => b.band === "mid")![0];
    t.sqlite.prepare("INSERT INTO instruments (symbol, isin) VALUES ('RELIANCE', ?)").run(midIsin);
    try {
      expect(atlasQ.capBandOfFn()("reliance")).toBe("mid");
    } finally {
      t.sqlite.prepare("DELETE FROM instruments WHERE symbol = 'RELIANCE'").run();
    }
    const resolve = atlasQ.capBandOfFn();
    for (const sym of ["MAL", "GSTL", "SEL", "ZEAL", "RAJPUTANA", "FOCUS"]) {
      const owner = bundledIsinBySymbol(sym);
      expect(resolve(sym), `${sym} → its owner ${owner}`).toBe(owner ? bands.get(owner)?.band ?? null : null);
    }
  });

  it("4c · a user's own sector tag replaces the universe row: no industry, so the cohort is the TAG's sector", () => {
    const p = pick();
    t.sqlite.prepare("INSERT INTO instruments (symbol, sector) VALUES (?, 'My Own Tag')").run(p.members[0]);
    try {
      const resolve = atlasQ.classificationOfFn();
      expect(resolve(p.members[0])).toMatchObject({ sector: "My Own Tag", industry: null });
      const aligned = p.members.map((s, i) => series(s, i + 1));
      const row = computeCohorts(aligned, [p.members[0]], resolve, new Map()).rows[0];
      expect([row.level, row.fellUp, row.group, row.thin]).toEqual(["sector", false, "My Own Tag", true]);
    } finally {
      t.sqlite.prepare("DELETE FROM instruments WHERE symbol = ?").run(p.members[0]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · W3 hubs → W4 help (the "?" link, the task layer, the palette keywords)
// ─────────────────────────────────────────────────────────────────────────────

describe("5 · W3 hub tabs → W4 help", () => {
  it("5a · every old analytics URL redirects (config 307) to a live tab whose '?' opens THAT tab's topic, with a task record", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects.length).toBe(HUBS.flatMap((h) => h.tabs).length);
    for (const r of redirects) {
      expect(r.permanent, r.source).toBe(false);
      // TI-6 (fix wave): no `destination === legacyRedirect(source)` here — both
      // sides are built from HUBS (next.config.ts maps each tab's legacyHref to
      // hubTabHref), so it could never fail. The W4 half below is the seam.
      const u = new URL(r.destination, "http://x");
      const hub = hubForHref(u.pathname)!;
      const tab = resolveTab(hub, u.searchParams.get("tab") ?? undefined);
      expect(hubTabHref(hub, tab.id), "the page opens the tab the redirect names").toBe(r.destination);
      const topic = topicForPath(u.pathname, u.searchParams.get("tab"), HELP_TOPIC_LINKS);
      expect(topic?.href, r.source).toBe(r.destination);
      expect(HELP_TASKS[r.destination]?.steps.length ?? 0, `${r.destination} task steps`).toBeGreaterThanOrEqual(3);
      expect(HELP_ENTRIES.find((e) => e.href === r.destination)?.title.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("5b · the palette's tab rows take their search words from the tab's help entry, and workspace mode hides only the F&O tab", () => {
    const all = buildCommands(null, null);
    for (const hub of HUBS) {
      for (const tab of hub.tabs) {
        const href = hubTabHref(hub, tab.id);
        const entry = HELP_ENTRIES.find((e) => e.href === href);
        expect(entry?.keywords.length ?? 0, `${href} has help search words for the palette`).toBeGreaterThan(0);
        const row = all.find((c) => c.href === href);
        expect(row?.label).toBe(`${hub.label} › ${tab.label}`);
        for (const ws of ["equity", "fno", "both"] as const) {
          expect(commandsFor(all, ws).some((c) => c.href === href), `${href} in ${ws}`).toBe(tabVisible(hub, tab, ws));
        }
      }
    }
    const expiry = hubTabHref(HUBS.find((h) => h.href === "/reports/capital")!, "expiry");
    expect(commandsFor(all, "equity").some((c) => c.href === expiry)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · W9 rate cards + parsers → the engine and the stored row
// ─────────────────────────────────────────────────────────────────────────────

describe("6 · W9 Fyers / Nuvama → charge_config → the stored rows", () => {
  it("6a · a Fyers Prime account's committed option rows are billed Prime's per-order card, never Zerodha's or Standard's", () => {
    const map = ratesDb.loadRatesMap();
    const rows = t.sqlite
      .prepare(
        `SELECT t.id, t.segment, t.exchange, t.sell_date AS sellDate, t.brokerage_paise / 100.0 AS brokerage,
                t.buy_qty AS buyQty, t.sell_qty AS sellQty, t.broker,
                (SELECT COUNT(*) FROM trade_legs l WHERE l.trade_id = t.id) AS legs
           FROM trades t WHERE t.account_id = ? AND t.segment IN ('index_option', 'stock_option') AND t.is_open = 0
            AND t.buy_qty > 0 AND COALESCE(t.import_notes, '') NOT LIKE '%short%'`,
      )
      .all(FYERS_ACC) as { id: number; segment: "index_option" | "stock_option"; exchange: "NSE"; sellDate: string; brokerage: number; buyQty: number; sellQty: number; broker: string; legs: number }[];
    expect(rows.length, "closed option round trips in the Fyers fixture").toBeGreaterThan(10);
    // An imported row is billed the settings' order counts per side (commit.ts buildRow:
    // `defaults.buyOrders`), not per execution — a ladder is re-billed per leg only on a rebuild.
    const s = t.sqlite.prepare("SELECT default_buy_orders AS b, default_sell_orders AS s FROM settings").get() as { b: number; s: number };
    for (const r of rows) {
      const prime = findRates(map, "fyers", r.segment, r.exchange, r.sellDate, "prime").brokerageFlat!;
      const standard = findRates(map, "fyers", r.segment, r.exchange, r.sellDate, "default").brokerageFlat!;
      const zerodha = findRates(map, "zerodha", r.segment, r.exchange, r.sellDate, "default").brokerageFlat!;
      expect(prime, "the plan must discriminate").toBeLessThan(Math.min(standard, zerodha));
      const orders = (r.buyQty > 0 ? s.b : 0) + (r.sellQty > 0 ? s.s : 0);
      expect([r.broker, r.brokerage], `row ${r.id} (${r.segment}, ${orders} orders, ${r.legs} legs)`).toEqual(["fyers", r2(orders * prime)]);
    }
  });

  it("6b · Nuvama's billed heads are stored as stated: Σ total 3,859.52, Σ brokerage 1,579.20, every row = its own bill", () => {
    const stored = t.sqlite
      .prepare("SELECT charges_total_paise / 100.0 AS c, brokerage_paise / 100.0 AS b, broker FROM trades WHERE account_id = ? ORDER BY id")
      .all(NUVAMA_ACC) as { c: number; b: number; broker: string }[];
    expect(stored.length).toBe(nuvamaParsed.trades.length);
    expect(new Set(stored.map((s) => s.broker))).toEqual(new Set(["nuvama"]));
    expect(r2(sum(stored.map((s) => s.c)))).toBe(r2(sum(nuvamaParsed.trades.map((x) => x.reportedCharges?.total ?? 0))));
    expect(r2(sum(stored.map((s) => s.c)))).toBe(3859.52);
    expect(r2(sum(stored.map((s) => s.b)))).toBe(1579.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · W8 version gate → the broker pull route, for every OpenAlgo underlying
// ─────────────────────────────────────────────────────────────────────────────

describe("7 · W8 OpenAlgo version gate → every underlying's COMMIT pull (incl. W9's fyers)", () => {
  const post = (body: unknown) =>
    brokerRoute.POST(new Request("http://localhost/api/import/broker", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

  const dialled: string[] = [];
  let version = "2.0.2.5";
  const tradesCount = () => (t.sqlite.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
  beforeAll(async () => {
    const CURRENT = (await import("@/lib/domain/openalgo-disclosure")).OPENALGO_DISCLOSURE_VERSION;
    t.sqlite.prepare("UPDATE settings SET openalgo_enabled = 1, openalgo_ack_version = ?").run(CURRENT);
  });
  beforeEach(() => {
    dialled.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      dialled.push(String(url));
      if (String(url).endsWith("/auth/app-info")) return new Response(JSON.stringify({ status: "success", version, name: "OpenAlgo" }), { status: 200 });
      return new Response(
        JSON.stringify({ status: "success", data: [{ action: "BUY", symbol: "RELIANCE", exchange: "NSE", product: "CNC", quantity: 10, average_price: 1400, trade_value: 14000, timestamp: "10:00:00" }] }),
        { status: 200 },
      );
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("7a · W9's fyers is one of the underlyings the gate must cover", () => {
    expect(openAlgoBrokerOptions().map((b) => b.broker)).toContain("fyers");
  });

  it.each(openAlgoBrokerOptions().map((b) => b.broker))("7b · openalgo:%s on 2.0.2.5 — the COMMIT pull is refused, only /auth/app-info is dialled, nothing is written", async (u) => {
    version = "2.0.2.5";
    const before = tradesCount();
    const save = await post({ action: "save", broker: "openalgo", apiKey: "oa-secret-key-abcdef", host: "127.0.0.1:5000", underlyingBroker: u, accountId: FYERS_ACC });
    expect(save.status, `save ${u}`).toBe(200);
    dialled.length = 0;
    const res = await post({ action: "pull", broker: `openalgo:${u}`, mode: "commit", accountId: FYERS_ACC });
    const json = (await res.json()) as { message?: string };
    expect({ status: res.status, dialled: [...dialled], written: tradesCount() - before }).toEqual({
      status: 502,
      dialled: ["http://127.0.0.1:5000/auth/app-info"],
      written: 0,
    });
    expect(json.message).toContain(`older than ${OPENALGO_MIN_VERSION}`);
  });

  it("7c · at the minimum a Fyers pull commits, priced at the account's Fyers Prime card", async () => {
    version = OPENALGO_MIN_VERSION;
    const save = await post({ action: "save", broker: "openalgo", apiKey: "oa-secret-key-abcdef", host: "127.0.0.1:5000", underlyingBroker: "fyers", accountId: FYERS_ACC });
    expect(save.status).toBe(200);
    const ok = await post({ action: "pull", broker: "openalgo:fyers", mode: "commit", accountId: FYERS_ACC });
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    const row = t.sqlite
      .prepare("SELECT broker, segment, brokerage_paise / 100.0 AS b FROM trades WHERE account_id = ? AND symbol = 'RELIANCE'")
      .get(FYERS_ACC) as { broker: string; segment: string; b: number };
    const card = findRates(ratesDb.loadRatesMap(), "fyers", "eq_delivery", "NSE", todayIstIso(), "prime");
    const zerodha = findRates(ratesDb.loadRatesMap(), "zerodha", "eq_delivery", "NSE", todayIstIso(), "default");
    const primeBrokerage = Math.min(card.brokerageCap!, r2(14000 * card.brokeragePct));
    expect(primeBrokerage).not.toBe(zerodha.brokerageFlat ?? r2(14000 * zerodha.brokeragePct));
    expect(row).toEqual({ broker: "fyers", segment: "eq_delivery", b: primeBrokerage });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · W6 speed lever over the W9 rows (short, opening-sell, billed charges)
// ─────────────────────────────────────────────────────────────────────────────

describe("8 · W6 KPI aggregate = the whole-book reduce, over the W9 books, in every view", () => {
  it.each([
    ["Fyers account", FYERS_ACC],
    ["Nuvama account", NUVAMA_ACC],
    ["All accounts", 0],
  ])("%s", (_l, id) => {
    select(id);
    const sql = trades.getTradeStatsSql();
    const js = trades.tradeStatsOf(trades.getJournalTrades());
    expect(sql).toEqual(js);
    expect(sql.count).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 · MO-4 (fix wave) — Paytm / Groww parser allocation → commit's ladder → the
//     realised rows and Data Quality (invariant 5)
// ─────────────────────────────────────────────────────────────────────────────

describe("9 · MO-4: every Paytm and Groww ladder states its parent, through commit, the realised book and Data Quality", () => {
  const PAYTM_ACC = 5;
  const GROWW_ACC = 6;
  const PAYTM_FILE = "paytm-tradebook-2026-04-01_2026-08-28.xlsx";
  const GROWW_FILE = "groww-orders-2025-04-01_2026-03-31.xlsx";
  let growwParsed: ParsedFile;
  let del: typeof import("@/lib/queries/delete");

  beforeAll(async () => {
    // Measured locally 2026-09-26: ~3.5 s (parse + commit of both real books —
    // Paytm 7,544 fills / 793 positions, Groww 952 orders / 483). Over the 3 s
    // hook budget because the seam IS the real books; the raised timeout is for
    // the Windows runner, > 15x slower (AGENTS.md § Testing).
    del = await import("@/lib/queries/delete");
    const acc = t.sqlite.prepare("INSERT INTO accounts (id, name, broker) VALUES (?, ?, ?)");
    acc.run(PAYTM_ACC, "Paytm seam", "paytm");
    acc.run(GROWW_ACC, "Groww seam", "groww");
    const paytm = await parseFile(PAYTM_FILE, fs.readFileSync(path.join(DIR, PAYTM_FILE)));
    growwParsed = await parseFile(GROWW_FILE, fs.readFileSync(path.join(DIR, GROWW_FILE)));
    commit.commitParsedFile(paytm, PAYTM_FILE, null, PAYTM_ACC);
    commit.commitParsedFile(growwParsed, GROWW_FILE, null, GROWW_ACC);
  }, 120_000);

  type Ladder = { id: number; sym: string; side: string | null; bq: number; sq: number; eq: number | null; xq: number | null };
  const ladders = (accountId: number): Ladder[] =>
    t.sqlite
      .prepare(
        `SELECT t.id, t.tradingsymbol AS sym, t.side, t.buy_qty AS bq, t.sell_qty AS sq,
                (SELECT SUM(qty) FROM trade_legs l WHERE l.trade_id = t.id AND l.kind = 'entry') AS eq,
                (SELECT SUM(qty) FROM trade_legs l WHERE l.trade_id = t.id AND l.kind = 'exit') AS xq
           FROM trades t WHERE t.account_id = ? AND t.staged = 1 ORDER BY t.id`,
      )
      .all(accountId) as Ladder[];

  it.each([
    ["Paytm", PAYTM_ACC],
    ["Groww", GROWW_ACC],
  ])("9a · %s: every staged row's Σ entry legs = its entry qty and Σ exit legs = its exit qty", (_b, acc) => {
    const rows = ladders(acc);
    expect(rows.length, "the book has ladders").toBeGreaterThan(0);
    const off = rows
      .map((r) => {
        const short = sideOf({ buyQty: r.bq, sellQty: r.sq, side: r.side }) === "short";
        const [entryQty, exitQty] = short ? [r.sq, r.bq] : [r.bq, r.sq];
        return { r, entryQty, exitQty };
      })
      .filter(({ r, entryQty, exitQty }) => Math.abs((r.eq ?? 0) - entryQty) > 1e-9 || Math.abs((r.xq ?? 0) - exitQty) > 1e-9)
      .map(({ r, entryQty, exitQty }) => `${r.sym} entry ${r.eq ?? 0} ≠ ${entryQty} / exit ${r.xq ?? 0} ≠ ${exitQty}`);
    // The two the audit named (PARAS on Paytm, AEQUS on Groww) are quoted by name on a red.
    expect({ count: off.length, named: off.filter((s) => /^(PARAS|AEQUS) /.test(s)).slice(0, 2) }).toEqual({ count: 0, named: [] });
  });

  it.each([
    ["Paytm", PAYTM_ACC],
    ["Groww", GROWW_ACC],
  ])("9b · %s: a closed ladder's realised rows sum to the parent's sellValue, and Data Quality lists no ladder mismatch", (_b, acc) => {
    const closed = trades.getTrades([acc]).filter((r) => r.staged && !r.isOpen);
    expect(closed.length).toBeGreaterThan(0);
    const rows = realisedQ.getRealisedRows(closed);
    const off: string[] = [];
    for (const p of closed) {
      const s = r2(sum(rows.filter((x) => x.id === p.id).map((x) => x.sellValue)));
      if (s !== r2(p.sellValue)) off.push(`${p.symbol} ${s} ≠ ${p.sellValue}`);
    }
    expect(off.slice(0, 6), `${off.length} closed ladders`).toEqual([]);
    select(acc);
    expect(dq.getDataQualityReport().issues.find((i) => i.code === "ladder_mismatch")).toBeUndefined();
  });

  // A 4.5.x book: the ladder the date-window filter wrote (one fill too many on
  // the entry side). Re-importing the same file is a duplicate by the parent's
  // hash, so Data Quality names the remedy — delete, then re-import — and the
  // re-import (with the deleted row sitting in Trash) writes the corrected ladder.
  it("9c · a 4.5.x over-counted ladder is listed by Data Quality; delete → re-import writes a ladder that states its parent", () => {
    const victim = ladders(GROWW_ACC).find((r) => (r.eq ?? 0) > 0 && r.bq === r.sq)!;
    const leg = t.sqlite.prepare("SELECT * FROM trade_legs WHERE trade_id = ? AND kind = 'entry' ORDER BY seq LIMIT 1").get(victim.id) as Record<string, unknown>;
    const cols = Object.keys(leg).filter((c) => c !== "id");
    t.sqlite
      .prepare(`INSERT INTO trade_legs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...cols.map((c) => (c === "seq" ? 9999 : leg[c])));
    select(GROWW_ACC);
    const issue = dq.getDataQualityReport().issues.find((i) => i.code === "ladder_mismatch");
    expect(issue?.ids).toEqual([victim.id]);
    expect(issue?.detail).toContain("Delete the position, then re-import the same file");
    // Re-importing without deleting: the parent's hash is on file → skipped, the ladder stays wrong.
    expect(commit.commitParsedFile(growwParsed, GROWW_FILE, null, GROWW_ACC).added).toBe(0);
    expect(dq.getDataQualityReport().issues.find((i) => i.code === "ladder_mismatch")?.ids).toEqual([victim.id]);
    // The remedy the line names.
    const res = del.deleteTradesByIds([victim.id], "seam 9c", "test");
    expect(res.ok, res.message).toBe(true);
    const again = commit.commitParsedFile(growwParsed, GROWW_FILE, null, GROWW_ACC);
    expect(again.added, "the deleted row comes back — Trash does not hold its hash as a duplicate").toBe(1);
    const back = ladders(GROWW_ACC).find((r) => r.sym === victim.sym && r.bq === victim.bq && r.sq === victim.sq && r.id !== victim.id)!;
    expect([back.eq, back.xq]).toEqual([victim.bq, victim.sq]);
    expect(dq.getDataQualityReport().issues.find((i) => i.code === "ladder_mismatch")).toBeUndefined();
  });
});
