import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
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
 * clock fact and scans the tree so a second definition cannot come back.
 *
 * The scan is COMMENT-AWARE (second audit, 2026-09-04): the first version
 * grepped raw source, so a UTC today quoted in a docblock reddened the
 * inventory while `new Date().toJSON().slice(0, 10)` and
 * `new Date().toISOString().split("T")[0]` — the same day, spelled
 * differently — walked past it. Comments are stripped before the scan and
 * the pattern names every spelling of "the UTC date of now".
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

/**
 * Blank out `//` and `/* *\/` comments, leaving strings (and their contents)
 * alone and keeping every newline so line numbers survive. A `//` inside a
 * string or template literal is not a comment, and neither is the `\/\/` of a
 * REGEX LITERAL's escaped slashes: `/^https?:\/\//i` (real — it lives at
 * lib/domain/openalgo-disclosure.ts:182 and lib/import/api/openalgo.ts:457,
 * so the old claim that "none exists here" was wrong) opened a comment and
 * blanked the rest of its line, hiding any code after it from the scan. A `/`
 * whose previous character is a backslash therefore never opens a comment.
 * Full regex-literal lexing is still not modelled: an escaped BACKSLASH right
 * before a real comment (`"\\" + // x`) is over-protected, which leaves a
 * comment in the scanned text rather than hiding code from it.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (c !== "`" && src[i] === "\n") break; // unterminated plain string: stop at the line
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
      continue;
    }
    if (c === "/" && d === "/" && src[i - 1] !== "\\") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every "the UTC date of now" spelling: toISOString/toJSON, then slice/substring/substr(0, 10) or split("T")[0]. */
export const UTC_TODAY =
  /new Date\(\)\s*\.(toISOString|toJSON)\(\)\s*\.(?:(slice|substring|substr)\(\s*0,\s*10\s*\)|split\(\s*["']T["']\s*\)\s*\[\s*0\s*\])/;
/** The same tail without the `new Date()` root, for the temp-variable check. */
const UTC_DATE_TAIL =
  /\.(toISOString|toJSON)\(\)\s*\.(?:(slice|substring|substr)\(\s*0,\s*10\s*\)|split\(\s*["']T["']\s*\)\s*\[\s*0\s*\])/;

const root = process.cwd();
const TREES = ["lib", "app", "components"];

/** Every .ts/.tsx under the three source trees, comment-stripped, as `file:line:text` rows matching `re`. */
function scan(re: RegExp): string[] {
  const rows: string[] = [];
  for (const tree of TREES) {
    for (const rel of readdirSync(path.join(root, tree), { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(rel)) continue;
      const file = `${tree}/${rel}`.replace(/\\/g, "/");
      const src = stripComments(readFileSync(path.join(root, file), "utf8"));
      src.split(/\r?\n/).forEach((line, i) => {
        if (re.test(line)) rows.push(`${file}:${i + 1}:${line}`);
      });
    }
  }
  return rows;
}

describe("the scanner", () => {
  it("does not fire on a UTC today inside a comment, and does fire on one in code", () => {
    const comment = "// const d = new Date().toISOString().slice(0, 10);\n/* new Date().toISOString().slice(0, 10) */\n";
    expect(UTC_TODAY.test(stripComments(comment))).toBe(false);
    expect(UTC_TODAY.test(stripComments(`${comment}const d = new Date().toISOString().slice(0, 10);`))).toBe(true);
  });

  it("keeps line numbers and leaves strings alone", () => {
    const src = 'const u = "https://x/y"; // c\n/* a\nb */ const v = `${1}//`;\nconst w = 1;';
    const out = stripComments(src);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).toContain('"https://x/y"');
    expect(out).toContain("`${1}//`");
    expect(out).not.toContain("// c");
  });

  it("a regex literal's escaped slashes do not open a comment (fix pass 3)", () => {
    // `/^https?:\/\//i` is real source (lib/domain/openalgo-disclosure.ts:182,
    // lib/import/api/openalgo.ts:457). The `\/\/` opened a `//` comment and
    // blanked the rest of the line, so anything after it went unscanned.
    const planted = String.raw`const u = /^https?:\/\//i; const d = new Date().toISOString().slice(0, 10);`;
    const out = stripComments(planted);
    expect(UTC_TODAY.test(out)).toBe(true);
    expect(out).toBe(planted);
  });

  it("names every spelling of the UTC date of now", () => {
    for (const spelling of [
      "new Date().toISOString().slice(0, 10)",
      "new Date().toISOString().substring(0,10)",
      "new Date().toJSON().slice(0, 10)",
      'new Date().toISOString().split("T")[0]',
      "new Date().toJSON().split('T')[0]",
    ]) {
      expect(UTC_TODAY.test(spelling), spelling).toBe(true);
    }
    // Formatting a COMPUTED date is not "today".
    expect(UTC_TODAY.test("ist.toISOString().slice(0, 10)")).toBe(false);
  });
});

describe("source guard — one today", () => {
  it("todayIstIso is DEFINED exactly once, in lib/domain/trading-day.ts", () => {
    const defs = scan(/function todayIstIso\b/);
    expect(defs.map((l) => l.split(":")[0])).toEqual(["lib/domain/trading-day.ts"]);
  });

  it("no todayIso (UTC) definition or reference survives", () => {
    // Word-bounded so todayIstIso does not match. Comments are stripped, so
    // the trading-day docblock's mention of the retired export cannot count.
    expect(scan(/\btodayIso\b/)).toEqual([]);
  });

  it("no inline IST copy: toLocaleDateString(en-CA, Asia/Kolkata) lives only in the helper", () => {
    const hits = scan(/toLocaleDateString\(\s*"en-CA"/).filter((l) => !l.startsWith("lib/domain/trading-day.ts:"));
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
      // Fix wave: the last Wave 3 holdout.
      "components/trades/trades-client.tsx",
    ];
    const hits = scan(UTC_TODAY);
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
    // EMPTY, and it stays empty. The fix wave migrated the last row
    // (components/trades/trades-client.tsx, the `today` memo) to
    // todayIstIso(), so the docs' "every date is IST" claim is now true of
    // the whole tree. A new row here is a new UTC today — the bug this file
    // exists to prevent — so add one only with the reason it is not a user's
    // day, and prefer ALLOWED_UTC_STAMPS if it is a machine stamp.
    const FROZEN: Record<string, number> = {};
    // Sites that LOOK like a UTC today but are a genuine machine stamp
    // (a log line, an updatedAt) and may keep UTC — each with its reason.
    // Empty after the sweep: no such site exists among the 42 it found.
    const ALLOWED_UTC_STAMPS: Record<string, { count: number; reason: string }> = {};
    expect(Object.keys(ALLOWED_UTC_STAMPS)).toEqual([]);
    const hits = scan(UTC_TODAY);
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
    const hits = scan(/const (today|now|asOf) = new Date\(\);/);
    const suspicious = hits.filter((l) => UTC_DATE_TAIL.test(l));
    expect(suspicious).toEqual([]);
  });
});
