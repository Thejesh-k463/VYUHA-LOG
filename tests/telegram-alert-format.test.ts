import { describe, expect, it } from "vitest";
import { ALERT_FOOTER, alertPrice, formatAlert, formatAlertSummary, type AlertMessageInput } from "@/lib/telegram/format";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";
import { istWallClockIso } from "@/lib/domain/trading-day";

/**
 * The Telegram alert TEXT (v4.7.0 C5, design D8, owner answer TG5, review
 * R2/R9; the Q32 "same commit" rule). Levels only: no quantity, no rupee
 * figure, no risk number, and no transaction verb in the TEMPLATE. The regexes
 * run over messages rendered with NEUTRAL fixture names, so a hit can only be
 * the template's; the user's own strings are escaped, never scanned (R9).
 */

const VERBS = /\b(buy|sell|book|exit|square|trail|hold|add|average)\b/i;
const CHECKED = new Date(istWallClockIso("2026-10-07", "10:42"));

const base: AlertMessageInput = {
  symbol: "ZZALPHA",
  kind: "sl",
  side: "long",
  level: 1230,
  mark: 1228.4,
  throughPct: 0.13,
  accountName: "Main",
  multiAccount: false,
  checkedAt: CHECKED,
  providerId: "openalgo",
};

describe("formatAlert — the template", () => {
  it("renders the D8 sentence with 'checked HH:MM IST', the feed's name and the footer", () => {
    expect(formatAlert(base)).toBe(
      "<b>ZZALPHA</b>: mark 1,228.40 is through your recorded stop 1,230.00 (0.1%) · checked 10:42 IST via OpenAlgo. Open Vyuha to review your plan.\n\n" +
        TELEGRAM_DISCLOSURE.footer,
    );
  });

  it("names each kind in its own words", () => {
    expect(formatAlert({ ...base, kind: "tsl" })).toContain("is through your recorded trailing stop 1,230.00");
    expect(formatAlert({ ...base, kind: "target", mark: 1240, level: 1235 })).toContain("has reached your recorded target 1,235.00");
  });

  it("says 'checked', never 'as of' — the adapters stamp receipt time, not a source time (R2)", () => {
    expect(formatAlert(base)).not.toMatch(/as of/i);
    expect(formatAlert(base)).toContain("checked 10:42 IST");
  });

  it("the footer is the disclosure's own constant, and every message ends on it", () => {
    expect(ALERT_FOOTER).toBe(TELEGRAM_DISCLOSURE.footer);
    expect(formatAlert(base).endsWith(TELEGRAM_DISCLOSURE.footer)).toBe(true);
    expect(formatAlertSummary(3, 20).endsWith(TELEGRAM_DISCLOSURE.footer)).toBe(true);
  });

  it("names the account ONLY when the install has more than one", () => {
    expect(formatAlert(base)).not.toContain("Main");
    expect(formatAlert({ ...base, multiAccount: true })).toContain("<b>ZZALPHA</b> · Main:");
    expect(formatAlert({ ...base, multiAccount: true, accountName: null })).toContain("<b>ZZALPHA</b>:");
  });

  it("escapes every user string — symbol and account name", () => {
    const html = formatAlert({ ...base, symbol: "M&M<FUT>", multiAccount: true, accountName: "A&B <x>" });
    expect(html).toContain("<b>M&amp;M&lt;FUT&gt;</b> · A&amp;B &lt;x&gt;:");
  });

  it("an account named 'Long hold' is escaped and still renders — the user's word is not Vyuha's advice (R9)", () => {
    const html = formatAlert({ ...base, multiAccount: true, accountName: "Long hold" });
    expect(html).toContain("· Long hold:");
    // The TEMPLATE around it stays clean once the user's string is removed.
    expect(VERBS.test(html.replace("Long hold", "ZZACCT"))).toBe(false);
  });

  it("carries no quantity, no rupee sign and no risk figure", () => {
    const html = formatAlert(base);
    expect(html).not.toContain("₹");
    expect(html).not.toMatch(/\bqty\b|\bquantity\b|\bshares?\b|\blots?\b|\brisk\b|\bR\b/i);
  });

  it("prices keep two decimals with Indian grouping; depth reads 'at the level' / 'under 0.1%'", () => {
    expect(alertPrice(123456.5)).toBe("1,23,456.50");
    expect(alertPrice(0.05)).toBe("0.05");
    expect(formatAlert({ ...base, throughPct: 0 })).toContain("(at the level)");
    expect(formatAlert({ ...base, throughPct: 0.04 })).toContain("(under 0.1%)");
    expect(formatAlert({ ...base, throughPct: 2.345 })).toContain("(2.3%)");
  });
});

describe("Q32 — no transaction verb and no prescriptive phrase, in EVERY case", () => {
  const kinds: AlertMessageInput["kind"][] = ["sl", "tsl", "target"];
  const sides: AlertMessageInput["side"][] = ["long", "short"];
  const feeds = ["openalgo", "upstox", "angelone", "mock"];
  const cases: AlertMessageInput[] = [];
  for (const kind of kinds)
    for (const side of sides)
      for (const multiAccount of [false, true])
        for (const providerId of feeds)
          for (const throughPct of [0, 0.04, 1.5])
            cases.push({ ...base, kind, side, multiAccount, providerId, throughPct, accountName: "ZZACCT" });

  it(`renders ${cases.length} cases and none matches either regex`, () => {
    expect(cases.length).toBe(3 * 2 * 2 * 4 * 3);
    for (const c of cases) {
      const html = formatAlert(c);
      expect(VERBS.test(html), html).toBe(false);
      expect(PRESCRIPTIVE_LANGUAGE.test(html), html).toBe(false);
    }
  });

  it("the summary line too, singular and plural", () => {
    for (const n of [1, 7]) {
      const html = formatAlertSummary(n, 20);
      expect(VERBS.test(html), html).toBe(false);
      expect(PRESCRIPTIVE_LANGUAGE.test(html), html).toBe(false);
      expect(html).toContain(`${n} more`);
      expect(html).toContain("daily limit of 20 alerts");
    }
  });

  it("the regexes really fire — a check that matches nothing proves nothing", () => {
    expect(VERBS.test("review whether to book, trail, or hold")).toBe(true);
    expect(PRESCRIPTIVE_LANGUAGE.test("you should exit")).toBe(true);
  });
});
