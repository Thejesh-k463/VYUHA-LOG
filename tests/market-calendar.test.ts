import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import calendar from "@/lib/data/market-calendar.json";
import {
  CALENDAR_COVERS_THROUGH,
  CAS_EFFECTIVE_FROM,
  CAS_MEMBERS_AS_OF,
  COVERAGE_WARN_DAYS,
  calendarCoverage,
  casMembership,
  cashMarkMinute,
  classOf,
  isMarketOpen,
  isTradingDay,
  liveWindowOn,
  marketOf,
  nseTradingDaysInYear,
  officialCloseAvailableAt,
  phaseAt,
  previousTradingDay,
  sessionFor,
  tradingBandsOn,
  tradingDayStatus,
  type SessionRow,
} from "@/lib/domain/market-calendar";
import { sessionOf, sessionSpanLabel } from "@/lib/analytics/cockpit";
import { shouldSendDigest } from "@/lib/telegram/digest-gate";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { markAfterIstMin, shouldPersistMark } from "@/lib/quotes/persist-mark";
import { closeReopenMinute } from "@/lib/live/stream-link";
import { isWithinLiveWindow, sessionCloseIso } from "@/lib/quotes/mapping";

/**
 * v4.6.0 W1 — THE MARKET CALENDAR (owner rulings K1–K3, 2026-09-24).
 *
 * SEBI's Closing Auction Session went live 2026-08-03 and the app did not know
 * for 52 days: it saved the day's mark from 15:30 (an F&O stock's PRE-AUCTION
 * price), filed every fill after 15:30 as "outside the session", and kept a
 * sidebar clock that was green on Republic Day. These pins are the spec's W1
 * test list; the scan at the bottom fails on the drift class that produced
 * research R4's rows 14–17.
 */

/** An IST wall-clock instant: `ist("2026-09-25", "15:35")`. */
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);
const hm = (h: number, m: number) => h * 60 + m;
const CAS_STOCK = { symbol: "RELIANCE", exchange: "NSE" as const };
const NON_CAS = { symbol: "IRCTCZZZ", exchange: "NSE" as const }; // not an F&O underlying

describe("the snapshot — shape, provenance, non-overlap", () => {
  const rows = calendar.sessions as unknown as SessionRow[];
  const ids = new Set(calendar.provenance.map((p) => p.id));

  it("carries asOf / capturedAt / coversThrough and a sources digest", () => {
    expect(calendar.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calendar.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CALENDAR_COVERS_THROUGH).toBe("2026-12-31");
    expect(calendar.sourcesSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("every session row, holiday and special session names a source in provenance", () => {
    for (const r of rows) expect(ids.has(r.source), `${r.market} ${r.class} ${r.effectiveFrom}`).toBe(true);
    for (const h of calendar.holidays) expect(ids.has(h.source)).toBe(true);
    for (const s of calendar.specialSessions) expect(ids.has(s.source)).toBe(true);
  });

  it("every primary / supporting source carries a sha256; the required six are primary", () => {
    for (const p of calendar.provenance) {
      if (p.sourceKind !== "secondary") expect(p.sha256, p.id).toMatch(/^[0-9a-f]{64}$/);
    }
    const primary = new Set(calendar.provenance.filter((p) => p.sourceKind === "primary").map((p) => p.item));
    for (const item of [1, 2, 3, 4, 5, 7]) expect(primary.has(item), `DOWNLOAD-LIST item ${item}`).toBe(true);
  });

  it("rows of one market × class never overlap in their effective range", () => {
    const key = (r: SessionRow) => `${r.market}|${r.class}`;
    const groups = new Map<string, SessionRow[]>();
    for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    // A "*" row stands for every cash class, so it joins each cash class's group.
    for (const r of rows.filter((x) => x.class === "*")) {
      for (const cls of ["cas_stock", "equity"]) groups.set(`${r.market}|${cls}`, [...(groups.get(`${r.market}|${cls}`) ?? []), r]);
    }
    for (const [k, list] of groups) {
      const sorted = [...list].sort((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? ""));
      for (let i = 1; i < sorted.length; i++) {
        const prevTo = sorted[i - 1].effectiveTo;
        expect(prevTo, `${k}: an open-ended row is followed by another`).not.toBeNull();
        expect(sorted[i].effectiveFrom! > prevTo!, `${k}: ${prevTo} overlaps ${sorted[i].effectiveFrom}`).toBe(true);
      }
    }
  });

  it("phases inside a row are ordered and non-overlapping", () => {
    for (const r of rows) {
      for (let i = 1; i < r.phases.length; i++) expect(r.phases[i].from >= r.phases[i - 1].to, `${r.market} ${r.class}`).toBe(true);
    }
  });

  it("the CAS row starts 2026-08-03 and the revised pre-open row 2026-09-07", () => {
    const cas = rows.filter((r) => r.class === "cas_stock").map((r) => r.effectiveFrom);
    expect(cas).toContain("2026-08-03");
    expect(cas).toContain("2026-09-07");
    expect(CAS_EFFECTIVE_FROM).toBe("2026-08-03");
  });

  it("holds the ~200 F&O underlyings as CAS members, dated from the snapshot", () => {
    expect(calendar.casMembers.symbols.length).toBeGreaterThan(150);
    expect(calendar.casMembers.symbols).toContain("RELIANCE");
    expect(CAS_MEMBERS_AS_OF).toBe(calendar.asOf);
  });
});

describe("trading days — holidays, special sessions, coverage", () => {
  it("2026-01-26 (Republic Day) is not a trading day; 2026-02-01 (Budget Sunday) and 2026-11-08 (Muhurat) are", () => {
    expect(isTradingDay("2026-01-26")).toBe(false);
    expect(tradingDayStatus("2026-01-26").reason).toBe("holiday");
    expect(isTradingDay("2026-02-01")).toBe(true);
    expect(tradingDayStatus("2026-02-01").reason).toBe("special");
    expect(isTradingDay("2026-11-08")).toBe(true);
    expect(isTradingDay("2026-11-07")).toBe(false); // a plain Saturday
  });

  it("2026 has 245 weekday sessions — special sessions are NOT counted for annualisation", () => {
    expect(nseTradingDaysInYear(2026)).toBe(245);
    expect(nseTradingDaysInYear(2027)).toBeNull();
  });

  it("previousTradingDay skips holidays and visits a special Sunday", () => {
    expect(previousTradingDay("2026-01-27")).toBe("2026-01-23"); // Tue → past Mon holiday → Fri
    expect(previousTradingDay("2026-02-02")).toBe("2026-02-01"); // Mon → the Budget Sunday
    expect(previousTradingDay("2026-10-05")).toBe("2026-10-01"); // Mon → past Fri 10-02 holiday
  });

  // v4.6.0 audit TI-9: `isCovered`'s `<= CALENDAR_COVERS_THROUGH` → `<` survived,
  // because no case asked about the LAST covered day itself. It is a weekday in
  // this snapshot (checked below, so the pin cannot go vacuous on a weekend
  // coversThrough), and it must answer from the list — verified.
  it("the LAST covered day answers from the bundled list (verified); the day after does not", () => {
    const last = CALENDAR_COVERS_THROUGH;
    const weekday = new Date(`${last}T00:00:00Z`).getUTCDay();
    expect([0, 6], `coversThrough ${last} is a weekend — the pin needs a weekday`).not.toContain(weekday);
    const status = tradingDayStatus(last);
    expect(status.verified).toBe(true);
    expect(["session", "holiday"]).toContain(status.reason);
    const next = new Date(`${last}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const after = tradingDayStatus(next.toISOString().slice(0, 10));
    if (after.reason !== "weekend") expect(after).toMatchObject({ verified: false, reason: "unverified" });
  });

  it("past coversThrough a weekday is a session but NOT verified; a weekend is still closed", () => {
    expect(tradingDayStatus("2027-01-04")).toEqual({ trading: true, verified: false, reason: "unverified", name: null });
    expect(isTradingDay("2027-01-02")).toBe(false);
  });

  it(`Data Quality coverage: ok, then expiring ${COVERAGE_WARN_DAYS} days out, then expired`, () => {
    expect(calendarCoverage("2026-09-25").state).toBe("ok");
    expect(calendarCoverage("2026-11-01").state).toBe("expiring"); // 60 days before 12-31
    expect(calendarCoverage("2026-10-31").state).toBe("ok");
    expect(calendarCoverage("2027-01-01").state).toBe("expired");
  });
});

describe("K3 — marks wait for the official close (the spec's minute pins, 2026-09-25)", () => {
  const D = "2026-09-25"; // a Friday, a trading day
  it("a CAS stock: refused at 15:35, allowed at 15:36", () => {
    expect(officialCloseAvailableAt(D, "NSE_CM", "cas_stock")).toBe(hm(15, 36));
    expect(shouldPersistMark(ist(D, "15:35"), null, CAS_STOCK).code).toBe("before-close");
    expect(shouldPersistMark(ist(D, "15:36"), null, CAS_STOCK).ok).toBe(true);
  });
  it("a non-CAS stock: refused at 15:30, allowed at 15:31", () => {
    expect(officialCloseAvailableAt(D, "NSE_CM", "equity")).toBe(hm(15, 31));
    expect(shouldPersistMark(ist(D, "15:30"), null, NON_CAS).code).toBe("before-close");
    expect(shouldPersistMark(ist(D, "15:31"), null, NON_CAS).ok).toBe(true);
  });
  it("an F&O contract: refused at 15:44, allowed at 15:45", () => {
    const at = officialCloseAvailableAt(D, "NSE_FO", "derivative")!;
    expect(at).toBe(hm(15, 45));
    expect(hm(15, 44) < at && hm(15, 45) >= at).toBe(true);
  });
  it("2026-07-31, before CAS: every stock's mark from 15:31", () => {
    expect(markAfterIstMin("2026-07-31", CAS_STOCK)).toBe(hm(15, 31));
    expect(shouldPersistMark(ist("2026-07-31", "15:31"), null, CAS_STOCK).ok).toBe(true);
  });
  it("between CAS's start and the F&O snapshot membership is UNKNOWN → the later (CAS) minute", () => {
    expect(casMembership("RELIANCE", "2026-08-10")).toBe("unknown");
    expect(classOf("NSE_CM", "RELIANCE", "2026-08-10")).toBe("cash_unknown");
    expect(markAfterIstMin("2026-08-10", NON_CAS)).toBe(hm(15, 36));
    expect(casMembership("RELIANCE", "2026-09-25")).toBe("cas");
    expect(casMembership("IRCTCZZZ", "2026-09-25")).toBe("not-cas");
  });
  it("the desk reconnects once at the LATEST cash mark minute — 15:36 since CAS, 15:31 before", () => {
    expect(closeReopenMinute(D)).toBe(hm(15, 36));
    expect(cashMarkMinute("2026-07-31")).toBe(hm(15, 31));
    expect(closeReopenMinute("2026-09-26")).toBeNull(); // Saturday
  });
  it("a special session with no bundled hours (Muhurat) has no close — refused, never guessed", () => {
    expect(sessionFor("2026-11-08", "NSE_CM", "equity")).toBeNull();
    expect(markAfterIstMin("2026-11-08")).toBeNull();
    expect(shouldPersistMark(ist("2026-11-08", "20:00"), null).code).toBe("before-close");
  });
  it("the Budget Sunday runs normal hours: marks from 15:31 (pre-CAS)", () => {
    expect(shouldPersistMark(ist("2026-02-01", "15:31"), null).ok).toBe(true);
  });
});

describe("the Telegram digest on special weekend sessions", () => {
  const OPEN = { enabled: true, ackVersion: TELEGRAM_DISCLOSURE.version, hasCredentials: true, sendTime: "15:35", lastSentDate: null };
  it("sends on the Budget-day Sunday (normal hours) and not on Muhurat (hours not bundled) or a plain Saturday", () => {
    expect(shouldSendDigest(OPEN, ist("2026-02-01", "16:00")).send).toBe(true);
    expect(shouldSendDigest(OPEN, ist("2026-11-08", "16:00")).send).toBe(false);
    expect(shouldSendDigest(OPEN, ist("2026-09-26", "16:00")).send).toBe(false);
  });
});

describe("sessions and phases", () => {
  it("F&O trades to 15:40 since 2026-08-03 (15:30 before); the headline open answers with it", () => {
    expect(isMarketOpen(ist("2026-09-25", "15:39"))).toBe(true);
    expect(isMarketOpen(ist("2026-09-25", "15:40"))).toBe(false);
    expect(isMarketOpen(ist("2026-07-31", "15:35"))).toBe(false);
    expect(isMarketOpen(ist("2026-01-26", "11:00"))).toBe(false); // Republic Day
  });
  it("a CAS stock is in the auction 15:15–15:35; a non-CAS stock trades continuously to 15:30", () => {
    expect(phaseAt(ist("2026-09-25", "15:20"), "NSE_CM", "cas_stock").phase).toBe("cas");
    expect(phaseAt(ist("2026-09-25", "15:20"), "NSE_CM", "equity").phase).toBe("normal");
    expect(phaseAt(ist("2026-09-25", "15:55"), "NSE_CM", "equity").phase).toBe("postclose");
    expect(phaseAt(ist("2026-09-25", "15:36"), "NSE_FO", "derivative").phase).toBe("fno-extension");
  });
  it("the live window runs 09:00 to the F&O mark minute (15:45) since CAS", () => {
    expect(liveWindowOn("2026-09-25")).toEqual({ startMin: hm(9, 0), endMin: hm(15, 45) });
    expect(isWithinLiveWindow(ist("2026-09-25", "15:45"))).toBe(true);
    expect(isWithinLiveWindow(ist("2026-09-25", "15:46"))).toBe(false);
    expect(isWithinLiveWindow(ist("2026-01-26", "10:00"))).toBe(false);
  });
  it("an EOD bar's asOf is the close instant of its own day and class", () => {
    expect(sessionCloseIso("2026-09-25", CAS_STOCK)).toBe("2026-09-25T15:35:00+05:30");
    expect(sessionCloseIso("2026-09-25", NON_CAS)).toBe("2026-09-25T15:30:00+05:30");
    expect(sessionCloseIso("2026-07-31", CAS_STOCK)).toBe("2026-07-31T15:30:00+05:30");
  });
  it("marketOf reads exchange + segment", () => {
    expect(marketOf("NSE", "eq_delivery")).toBe("NSE_CM");
    expect(marketOf("NSE", "index_option")).toBe("NSE_FO");
    expect(marketOf("NFO")).toBe("NSE_FO");
    expect(marketOf("BSE", "future")).toBe("BSE_FO");
    expect(marketOf("MCX")).toBe("MCX");
    expect(marketOf("CDS")).toBeNull();
  });
});

describe("fills are bucketed by the rules of THEIR date (spec W1)", () => {
  it("2026-07-31 15:25 F&O fill → close; 2026-08-04 15:32 → the closing-auction band", () => {
    expect(sessionOf("15:25", "2026-07-31")).toBe("close");
    expect(sessionOf("15:32", "2026-08-04")).toBe("auction");
    expect(sessionOf("15:32", "2026-07-31")).toBeNull(); // before CAS nothing traded then
  });
  it("15:38 (F&O extension) and 15:55 (post-close) are in session since CAS; 15:45 (transition) is not", () => {
    expect(sessionOf("15:38", "2026-09-25")).toBe("auction");
    expect(sessionOf("15:55", "2026-09-25")).toBe("postclose");
    expect(sessionOf("15:45", "2026-09-25")).toBeNull();
  });
  it("15:30 exactly stays a closing-hour fill on both sides of CAS", () => {
    expect(sessionOf("15:30", "2026-07-31")).toBe("close");
    expect(sessionOf("15:30", "2026-09-25")).toBe("close");
  });
  it("the no-session copy names the real gaps — the 15:40–15:50 transition is not a band", () => {
    expect(sessionSpanLabel("2026-09-25")).toBe("09:00–15:40 or 15:50–16:00");
    expect(sessionSpanLabel("2026-07-31")).toBe("09:00–15:30");
  });
  it("the bands' exchange edges come from the calendar", () => {
    expect(tradingBandsOn("2026-07-31")).toEqual({ preopen: { from: "09:00", to: "09:15" }, continuousEnd: "15:30", auction: null, postclose: null });
    expect(tradingBandsOn("2026-09-25").auction).toEqual({ from: "15:30", to: "15:40" });
  });
});

/* ── The drift class: a timing literal outside the calendar module ─────────── */

const ROOT = path.resolve(__dirname, "..");
/** Files allowed to spell a timing or the IST offset: the calendar and the one IST. */
const ALLOWED = new Set(["lib/domain/market-calendar.ts", "lib/domain/trading-day.ts"]);
const BANNED: [string, RegExp][] = [
  ['a "15:30" string', /["'`]15:30["'`]/],
  ["15 * 60 arithmetic", /\b15\s*\*\s*60\b/],
  ["a second IST offset (330 * 60)", /\b330\s*\*\s*60/],
  ["a second IST offset (5.5 * 60)", /\b5\.5\s*\*\s*60/],
  ["a literal +05:30 offset", /\+05:30/],
];

/** Blank block and line comments (not `//` inside a URL string's `://`). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

describe("no timing literal outside the calendar (R4 rows 14–17)", () => {
  it("lib / app / components carry none of the banned spellings", () => {
    const hits: string[] = [];
    for (const tree of ["lib", "app", "components"]) {
      for (const rel of readdirSync(path.join(ROOT, tree), { recursive: true }) as string[]) {
        if (!/\.(ts|tsx)$/.test(rel)) continue;
        const file = `${tree}/${rel.replace(/\\/g, "/")}`;
        if (ALLOWED.has(file)) continue;
        const lines = stripComments(readFileSync(path.join(ROOT, file), "utf8")).split("\n");
        lines.forEach((line, i) => {
          for (const [what, re] of BANNED) if (re.test(line)) hits.push(`${file}:${i + 1} — ${what}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
