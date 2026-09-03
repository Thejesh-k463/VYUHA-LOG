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
    ];
    const hits = rg("new Date\\(\\)\\s*\\.toISOString\\(\\)\\.(slice|substring)\\(\\s*0,\\s*10\\s*\\)");
    const inMigrated = hits.filter((l) => MIGRATED.includes(l.split(":")[0]));
    expect(inMigrated).toEqual([]);
  });

  it("the remaining UTC-today sites are a FROZEN inventory — it can shrink, never grow", () => {
    // NOT an allow-list of non-"today" uses: every one of these is a UTC
    // "today" (a page date, a form default, a job's as-of). They sit in files
    // outside the v3.8 cross-cutting set and are display/entry dates, not
    // charge pricing — left for a follow-up wave, pinned here so the count
    // cannot rise and a migrated file cannot regress. Delete a row when you
    // migrate the file; adding one means writing a new UTC today, which is
    // the bug this file exists to prevent. Callers of pure helpers that take
    // `today` as a parameter (expiry-stats, settlement, limits, sebi-radar,
    // mtf-accrual) should pass todayIstIso() rather than lean on the default.
    const FROZEN: Record<string, number> = {
      "app/active/page.tsx": 1,
      "app/api/ledger/route.ts": 1,
      "app/api/mtf-margin/route.ts": 1,
      "app/api/positions/risk/route.ts": 1,
      "app/api/restrictions/route.ts": 2,
      "app/arjuns-eye/page.tsx": 1,
      "app/equity/actions.ts": 1,
      "app/page.tsx": 1,
      "app/reports/broker-compare/page.tsx": 1,
      "app/reports/expiry/page.tsx": 1,
      "app/reports/harvest/page.tsx": 1,
      "app/reports/monthly/page.tsx": 1,
      "app/reports/performance/page.tsx": 1,
      "app/targets/active/page.tsx": 1,
      "app/targets/equity/page.tsx": 1,
      "app/trades/report/page.tsx": 1,
      "components/cash/ledger-form.tsx": 1,
      "components/reports/share-card.tsx": 1,
      "components/risk/restriction-form.tsx": 1,
      "components/risk/risk-cockpit-client.tsx": 1,
      "components/settings/charge-editor.tsx": 1,
      "components/trackers/mtm-form.tsx": 1,
      "components/trades/close-trade-dialog.tsx": 1,
      "components/trades/manual-trade-form.tsx": 1,
      "components/trades/staged-panel.tsx": 1,
      "components/trades/trades-client.tsx": 1,
      "lib/analytics/expiry-stats.ts": 1,
      "lib/analytics/settlement.ts": 1,
      "lib/import/api/angelone.ts": 1,
      "lib/import/api/dhan.ts": 1,
      "lib/import/api/openalgo.ts": 1,
      "lib/import/api/upstox.ts": 1,
      "lib/import/mtm-bhavcopy.ts": 1,
      "lib/jobs/mtf-accrual.ts": 1,
      "lib/queries/account-delete.ts": 2,
      "lib/queries/capital.ts": 2,
      "lib/queries/limits.ts": 1,
      "lib/queries/wallpaper.ts": 1,
      "lib/risk/sebi-radar.ts": 1,
    };
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
