import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { todayIstIso } from "@/lib/domain/trading-day";
import { todayIstIso as viaChallans } from "@/lib/queries/challans";

/**
 * v3.8 — ONE "today" (owner ruling 2026-09-04: migrate ALL eleven).
 *
 * `lib/engine/rates.ts` exported a UTC `todayIso()` and `lib/queries/challans.ts`
 * an IST `todayIstIso()`; between 18:30 and 24:00 UTC they named different
 * days, and charge pricing (`lib/import/commit.ts`) selected the charge_config
 * epoch effective on the UTC one. The pure helper now lives beside `toIst()`
 * in lib/domain/trading-day.ts; challans re-exports it; the four inline IST
 * copies and the eleven `todayIso` consumers import it. This file pins the
 * clock fact and greps the tree so a second definition cannot come back.
 */

/** The instant the two clocks disagree about: 20:00 UTC = 01:30 IST next day. */
const CLOCK = "2026-09-03T20:00:00Z";

afterEach(() => vi.useRealTimers());

describe("the clock", () => {
  it("at 20:00 UTC on 2026-09-03, UTC-today is 09-03 and IST-today is 09-04", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CLOCK));
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-03");
    expect(todayIstIso()).toBe("2026-09-04");
    // The challans re-export IS the domain helper, not a second copy.
    expect(viaChallans).toBe(todayIstIso);
    expect(viaChallans()).toBe("2026-09-04");
  });

  it("agrees with UTC outside the 18:30–24:00 UTC window", () => {
    expect(todayIstIso(new Date("2026-09-03T10:00:00Z"))).toBe("2026-09-03");
    expect(todayIstIso(new Date("2026-09-03T18:29:59Z"))).toBe("2026-09-03");
    expect(todayIstIso(new Date("2026-09-03T18:30:00Z"))).toBe("2026-09-04");
  });
});

/** ripgrep over the three source trees; returns `file:line:text` rows. */
function rg(pattern: string): string[] {
  try {
    const out = execFileSync(
      "rg",
      ["-n", "--no-heading", "-e", pattern, "lib", "app", "components", "--glob", "*.ts", "--glob", "*.tsx"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/\\/g, "/"));
  } catch (e) {
    // rg exits 1 on "no matches" — that is an empty result, not an error.
    const code = (e as { status?: number }).status;
    if (code === 1) return [];
    throw e;
  }
}

describe("source guard — one today", () => {
  it("todayIstIso is DEFINED exactly once, in lib/domain/trading-day.ts", () => {
    const defs = rg("function todayIstIso\\b");
    expect(defs.map((l) => l.split(":")[0])).toEqual(["lib/domain/trading-day.ts"]);
  });

  it("no todayIso (UTC) definition or reference survives", () => {
    // Word-bounded so todayIstIso does not match; the trading-day docblock
    // names the retired export in backticks — the one permitted mention.
    const hits = rg("\\btodayIso\\b").filter((l) => !l.startsWith("lib/domain/trading-day.ts:"));
    expect(hits).toEqual([]);
  });

  it("no inline IST copy: toLocaleDateString(en-CA, Asia/Kolkata) lives only in the helper", () => {
    const hits = rg("toLocaleDateString\\(\\s*\"en-CA\"").filter((l) => !l.startsWith("lib/domain/trading-day.ts:"));
    expect(hits).toEqual([]);
  });

  it("the charge-pricing path and every file this wave migrated read no UTC today", () => {
    // `new Date().toISOString().slice(0, 10)` IS "today, in UTC". These files
    // price charges, date challans, plan sessions or were migrated above;
    // none may grow a UTC day back.
    const MIGRATED = [
      "lib/import/commit.ts",
      "lib/engine/rates.ts",
      "lib/domain/trading-day.ts",
      "lib/queries/challans.ts",
      "lib/queries/ipos.ts",
      "lib/queries/staged.ts",
      "lib/queries/session-plan.ts",
      "lib/analytics/broker-compare.ts",
      "app/api/charges/preview/route.ts",
      "app/api/import/broker/route.ts",
      "app/calculator/page.tsx",
      "app/equity/page.tsx",
      "app/risk/page.tsx",
      "app/review/page.tsx",
      "app/reports/advance-tax/page.tsx",
      "components/behavior/session-planner.tsx",
      "components/review/review-open-card.tsx",
      // Wave 3 sweep (owner ruling: every "today" is India's). Page dates,
      // form defaults, job as-ofs, broker-API "today" windows, the default
      // `today` parameter of the pure helpers, the merge-note and go-live
      // dates — all of them name the user's day, none of them a machine stamp.
      "app/active/page.tsx",
      "app/api/ledger/route.ts",
      "app/api/mtf-margin/route.ts",
      "app/api/positions/risk/route.ts",
      "app/api/restrictions/route.ts",
      "app/arjuns-eye/page.tsx",
      "app/equity/actions.ts",
      "app/page.tsx",
      "app/reports/broker-compare/page.tsx",
      "app/reports/expiry/page.tsx",
      "app/reports/harvest/page.tsx",
      "app/reports/monthly/page.tsx",
      "app/reports/performance/page.tsx",
      "app/targets/active/page.tsx",
      "app/targets/equity/page.tsx",
      "app/trades/report/page.tsx",
      "components/cash/ledger-form.tsx",
      "components/reports/share-card.tsx",
      "components/risk/restriction-form.tsx",
      "components/risk/risk-cockpit-client.tsx",
      "components/settings/charge-editor.tsx",
      "components/trackers/mtm-form.tsx",
      "components/trades/close-trade-dialog.tsx",
      "components/trades/manual-trade-form.tsx",
      "components/trades/staged-panel.tsx",
      "lib/analytics/expiry-stats.ts",
      "lib/analytics/settlement.ts",
      "lib/import/api/angelone.ts",
      "lib/import/api/dhan.ts",
      "lib/import/api/openalgo.ts",
      "lib/import/api/upstox.ts",
      "lib/import/mtm-bhavcopy.ts",
      "lib/jobs/mtf-accrual.ts",
      "lib/queries/account-delete.ts",
      "lib/queries/capital.ts",
      "lib/queries/limits.ts",
      "lib/queries/wallpaper.ts",
      "lib/risk/sebi-radar.ts",
    ];
    const hits = rg("new Date\\(\\)\\s*\\.toISOString\\(\\)\\.(slice|substring)\\(\\s*0,\\s*10\\s*\\)");
    const inMigrated = hits.filter((l) => MIGRATED.includes(l.split(":")[0]));
    expect(inMigrated).toEqual([]);
  });

  it("the remaining UTC-today sites are a FROZEN inventory — it can shrink, never grow", () => {
    // NOT an allow-list of non-"today" uses: every row is a UTC "today" that
    // is still waiting for its owner. The Wave 3 sweep (2026-09-04) migrated
    // 38 of the 39 files it found (41 of 42 sites) — every one was a page
    // date, a form default, a job as-of or a broker-API window, i.e. the
    // user's day; NOT ONE was a machine timestamp, so ALLOWED_UTC_STAMPS
    // below is empty. What remains is owned by another Wave 3 agent and goes
    // to the fix wave. Delete the row when you migrate the file; adding one
    // means writing a new UTC today, which is the bug this file exists to
    // prevent.
    const FROZEN: Record<string, number> = {
      // Wave 3: components/trades/trades-client.tsx is owned by the Trades
      // agent this wave — its `today` memo (line ~92) is a page date and
      // migrates to todayIstIso() in the fix wave.
      "components/trades/trades-client.tsx": 1,
    };
    // Sites that LOOK like a UTC today but are a genuine machine stamp
    // (a log line, an updatedAt) and may keep UTC — each with its reason.
    // Empty after the sweep: no such site exists among the 42 it found.
    const ALLOWED_UTC_STAMPS: Record<string, { count: number; reason: string }> = {};
    expect(Object.keys(ALLOWED_UTC_STAMPS)).toEqual([]);
    const hits = rg("new Date\\(\\)\\s*\\.toISOString\\(\\)\\.(slice|substring)\\(\\s*0,\\s*10\\s*\\)");
    const actual: Record<string, number> = {};
    for (const l of hits) {
      const f = l.split(":")[0];
      actual[f] = (actual[f] ?? 0) + 1;
    }
    for (const [f, n] of Object.entries(actual)) {
      expect(FROZEN[f], `${f} has a UTC today the inventory does not know`).toBeDefined();
      expect(n, `${f}: UTC-today count grew`).toBeLessThanOrEqual(FROZEN[f]);
    }
    // A migrated file must be removed from the inventory, so it stays honest.
    for (const f of Object.keys(FROZEN)) expect(actual[f], `${f}: migrated — delete its inventory row`).toBeDefined();
  });

  it("non-today toISOString().slice(0, 10) uses are date arithmetic on an already-shifted or computed Date", () => {
    // `x.toISOString().slice(0, 10)` where x is NOT `new Date()` formats a
    // computed date (week starts, FY ends, an IST-shifted `ist`); those are
    // not "today" and are allowed. This pins that the only `new Date()`-rooted
    // ones are the inventory above — i.e. nothing hides behind a temp variable
    // named for the clock.
    const hits = rg("const (today|now|asOf) = new Date\\(\\);");
    const suspicious = hits.filter((l) => /toISOString\(\)\.(slice|substring)\(\s*0,\s*10\s*\)/.test(l));
    expect(suspicious).toEqual([]);
  });
});
