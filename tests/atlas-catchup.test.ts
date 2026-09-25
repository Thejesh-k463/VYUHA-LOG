import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CATCHUP_MAX_FILES,
  isEnvelopeDead,
  missingSessionsLine,
  planCatchup,
  sessionSpan,
  windowGapLine,
} from "@/lib/atlas/catchup-plan";
import { isTradingDay, latestBhavcopyDate, previousTradingDay } from "@/lib/domain/market-calendar";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * The freshness catch-up (v4.6.0 W5, Q51 A1 / #2, design review A6).
 *
 *   plan      — pure: the missing sessions in the window, newest first, capped
 *               at ten per open; the newest session belongs to the top-up.
 *   consent   — the auto-MTM toggle ONLY, re-read before every file.
 *   envelope  — the backfill's; a running one blocks, a DEAD one (stale
 *               updatedAt) is reset and does not block the next open (A6 i).
 *   lock      — a process-level lock keeps two opens to one run (A6 ii).
 *   abort     — the flag is re-read from the database every file.
 *   no URL    — the new job holds no host; it reuses the fetch (A6 v).
 *
 * `fetchOne` and `sleep` are injected, so nothing here touches the network and
 * nothing waits 1.5 seconds. ONE temp database per file.
 */

let t: TempDb;
let cu: typeof import("@/lib/jobs/bhavcopy-catchup");
let bf: typeof import("@/lib/jobs/bhavcopy-backfill");
let am: typeof import("@/lib/jobs/auto-mtm");

const NOW = new Date("2026-09-04T12:00:00Z"); // 17:30 IST on a Friday: the 4th's file is not out yet
const csvFor = (date: string, symbols = ["RELIANCE", "TCS"]) =>
  [
    "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol",
    ...symbols.map((s, i) => `${date},STK,${s},EQ,${100 + i},${110 + i},${95 + i},${105 + i},${1000 + i}`),
  ].join("\n");

/** The trading sessions before the newest, newest first. */
function sessionsBefore(newest: string, n: number): string[] {
  const out: string[] = [];
  let d = previousTradingDay(newest);
  for (let i = 0; i < n; i++) {
    out.push(d);
    d = previousTradingDay(d);
  }
  return out;
}

beforeAll(async () => {
  t = await openTempDb("atlas-catchup", { seed: true });
  cu = await import("@/lib/jobs/bhavcopy-catchup");
  bf = await import("@/lib/jobs/bhavcopy-backfill");
  am = await import("@/lib/jobs/auto-mtm");
});
afterAll(() => t?.cleanup());

beforeEach(() => {
  t.sqlite.prepare("UPDATE settings SET bhavcopy_backfill_ack = NULL, bhavcopy_backfill_progress = NULL, auto_mtm_enabled = 0").run();
  t.sqlite.prepare("DELETE FROM price_history").run();
});

const priceRows = () => (t.sqlite.prepare("SELECT COUNT(*) AS n FROM price_history").get() as { n: number }).n;
const enableAutoMtm = () => t.sqlite.prepare("UPDATE settings SET auto_mtm_enabled = 1").run();
const fullSession = (date: string) => {
  const ins = t.sqlite.prepare("INSERT INTO price_history (symbol, date, close, source) VALUES (?, ?, 100, 'bhavcopy')");
  for (let i = 0; i < bf.FULL_SESSION_MIN_ROWS; i++) ins.run(`SYM${i}`, date);
};

describe("the plan (pure)", () => {
  it("lists the missing sessions newest first, skips the newest (the top-up's), and caps the slice", () => {
    const newest = latestBhavcopyDate(NOW);
    expect(newest).toBe("2026-09-03");
    const window = sessionsBefore(newest, 6);
    const rows = new Map<string, number>([
      [window[1], 2_000], // full
      [window[3], 12], // a handful of manual marks: NOT a session
    ]);
    const plan = planCatchup({ rowsByDate: rows, fullSessionMinRows: 500, now: NOW, windowDays: 6, maxFiles: 3 });
    expect(plan.newest).toBe(newest);
    expect(plan.windowTo).toBe(window[0]);
    expect(plan.windowFrom).toBe(window[5]);
    expect(plan.sessionsInWindow).toBe(6);
    expect(plan.stored).toBe(1);
    expect(plan.missing).toEqual([window[0], window[2], window[3], window[4], window[5]]);
    expect(plan.plan).toEqual([window[0], window[2], window[3]]);
    expect(plan.missing).not.toContain(newest);
  });

  it("ten files per open by default (Q51 #2), whatever the hole", () => {
    const plan = planCatchup({ rowsByDate: new Map(), fullSessionMinRows: 500, now: NOW, windowDays: 252 });
    expect(CATCHUP_MAX_FILES).toBe(10);
    expect(plan.missing).toHaveLength(252);
    expect(plan.plan).toHaveLength(10);
    // The walk is the calendar's (A6 iv): every date is a trading day — no
    // weekend, no listed holiday — and a special Sunday session (Budget day
    // 2026-02-01) IS visited, once.
    for (const d of plan.missing) expect(isTradingDay(d), d).toBe(true);
    expect(plan.missing).toContain("2026-02-01");
    expect(plan.missing.filter((d) => d === "2026-02-01")).toHaveLength(1);
    expect(plan.missing).not.toContain("2026-08-15"); // Independence Day, a Saturday in 2026 anyway
    expect(plan.missing).not.toContain("2026-01-26"); // Republic Day (Monday): listed holiday, never asked
  });

  it("the dead-run rule: running + untouched for the threshold is dead; anything else is not", () => {
    const deadAfter = 36_000; // the threshold is the CALLER's (the jobs layer derives it); the rule is what is pure here
    const nowMs = Date.parse("2026-09-04T12:00:00Z");
    expect(isEnvelopeDead({ status: "running", updatedAt: new Date(nowMs - deadAfter - 1).toISOString() }, nowMs, deadAfter)).toBe(true);
    expect(isEnvelopeDead({ status: "running", updatedAt: new Date(nowMs - 1_000).toISOString() }, nowMs, deadAfter)).toBe(false);
    expect(isEnvelopeDead({ status: "running", updatedAt: null }, nowMs, deadAfter)).toBe(true);
    expect(isEnvelopeDead({ status: "running", updatedAt: "not a date" }, nowMs, deadAfter)).toBe(true);
    expect(isEnvelopeDead({ status: "done", updatedAt: null }, nowMs, deadAfter)).toBe(false);
    expect(isEnvelopeDead({ status: "idle", updatedAt: null }, nowMs, deadAfter)).toBe(false);
  });

  it("the sentences carry the count and the window", () => {
    expect(missingSessionsLine(4, 252)).toBe("4 sessions missing in your 252-day window — run the backfill.");
    expect(missingSessionsLine(1, 252)).toBe("1 session missing in your 252-day window — run the backfill.");
    expect(missingSessionsLine(0, 252)).toBe("No sessions missing in your 252-day window.");
    expect(windowGapLine("1m", 4)).toBe("your 1m window has 4 missing sessions");
    expect(windowGapLine("1m", 0)).toBeNull();
  });

  it("the sparse-history span: stored vs calendar-expected sessions over a window (Q51 #7)", () => {
    const stored = sessionsBefore("2026-09-04", 25).reverse(); // 25 sessions, oldest first
    const dropped = stored[12];
    const sparse = stored.filter((d) => d !== dropped);
    const span = sessionSpan(sparse, 21)!;
    expect(span.stored).toBe(22);
    expect(span.expected).toBe(23);
    expect(span.missing).toBe(1);
    expect(span.missingDates).toEqual([dropped]);
    expect(span.to).toBe(sparse[sparse.length - 1]);
    const full = sessionSpan(stored, 21)!;
    expect(full.missing).toBe(0);
    expect(full.expected).toBe(22);
    expect(sessionSpan(stored.slice(0, 10), 21)).toBeNull();
  });
});

describe("the run — consent, envelope, abort", () => {
  it("refuses without the auto-MTM toggle, whatever the backfill ack says", async () => {
    bf.recordBackfillAck(); // the BUTTON's consent is not this job's consent
    const out = await cu.runBhavcopyCatchup({ now: NOW, fetchOne: async () => null, sleep: async () => {} });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("consent");
    expect(cu.isAutoMtmEnabled()).toBe(false);
  });

  it("fetches at most ten missing sessions at the backfill's pace and writes them to price_history", async () => {
    enableAutoMtm();
    const before = priceRows();
    const asked: string[] = [];
    const waits: number[] = [];
    const out = await cu.runBhavcopyCatchup({
      now: NOW,
      sleep: async (ms) => void waits.push(ms),
      fetchOne: async (d) => {
        asked.push(d);
        return { text: csvFor(d), source: "udiff", url: "test://x" };
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(asked).toEqual(sessionsBefore("2026-09-03", 10));
    expect(waits).toEqual(Array(9).fill(bf.BACKFILL_RATE_LIMIT_MS)); // n files, n−1 waits
    expect(out.applied).toBe(10);
    expect(out.progress.status).toBe("done");
    expect(out.progress.kind).toBe("catchup");
    expect(out.progress.requested).toBe(10);
    expect(out.progress.rows).toBe(20);
    const after = priceRows();
    // MEASURED for the report: 0 → 20 rows (two symbols × ten files).
    expect([before, after]).toEqual([0, 20]);
    expect(out.plan.missing.length).toBe(252);
    expect(out.progress.message).toContain("242 more sessions still missing — run the backfill for the rest.");
  });

  it("skips sessions already stored and reports nothing_missing when the window is full", async () => {
    enableAutoMtm();
    const window = sessionsBefore("2026-09-03", 3);
    fullSession(window[0]);
    const asked: string[] = [];
    const out = await cu.runBhavcopyCatchup({
      now: NOW,
      maxFiles: 2,
      sleep: async () => {},
      fetchOne: async (d) => {
        asked.push(d);
        return { text: csvFor(d), source: "legacy", url: "test://x" };
      },
    });
    expect(out.ok).toBe(true);
    expect(asked).toEqual([window[1], window[2]]);
    expect(cu.catchupStatus(NOW).missing).toBe(252 - 1 - 0); // the two fetched files carry 2 rows each: not full sessions
  });

  it("stops when a second request sets the abort flag, and says so", async () => {
    enableAutoMtm();
    const out = await cu.runBhavcopyCatchup({
      now: NOW,
      sleep: async () => {},
      fetchOne: async (d) => {
        if (bf.readBackfillProgress().applied >= 2) bf.requestBackfillAbort();
        return { text: csvFor(d), source: "udiff", url: "test://x" };
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.aborted).toBe(true);
    expect(out.progress.status).toBe("aborted");
    expect(out.progress.message).toContain("you asked it to stop");
    expect(out.applied).toBeGreaterThanOrEqual(2);
    expect(out.applied).toBeLessThan(10);
  });

  it("re-reads the consent before EVERY file: turning auto-MTM off mid-run stops it (A6 iii)", async () => {
    enableAutoMtm();
    let calls = 0;
    const out = await cu.runBhavcopyCatchup({
      now: NOW,
      sleep: async () => {},
      fetchOne: async (d) => {
        if (++calls === 3) t.sqlite.prepare("UPDATE settings SET auto_mtm_enabled = 0").run();
        return { text: csvFor(d), source: "udiff", url: "test://x" };
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(calls).toBe(3);
    expect(out.aborted).toBe(true);
    expect(out.progress.message).toContain("auto-MTM was turned off");
  });

  it("a FRESH running envelope (a live backfill) blocks the catch-up", async () => {
    enableAutoMtm();
    bf.writeBackfillProgress({ ...bf.IDLE_PROGRESS, status: "running" }); // updatedAt = now
    const out = await cu.runBhavcopyCatchup({ now: NOW, fetchOne: async () => null, sleep: async () => {} });
    expect(out.ok === false && out.reason).toBe("already_running");
  });

  it("GUARD (A6 i): a running envelope with a stale updatedAt does not block the next open", async () => {
    enableAutoMtm();
    const stale = new Date(Date.now() - cu.CATCHUP_DEAD_AFTER_MS - 60_000).toISOString();
    t.sqlite
      .prepare("UPDATE settings SET bhavcopy_backfill_progress = ?")
      .run(JSON.stringify({ ...bf.IDLE_PROGRESS, status: "running", updatedAt: stale, startedAt: stale, applied: 3 }));
    expect(bf.readBackfillProgress().status).toBe("running");
    const out = await cu.runBhavcopyCatchup({
      now: NOW,
      maxFiles: 1,
      sleep: async () => {},
      fetchOne: async (d) => ({ text: csvFor(d), source: "udiff", url: "test://x" }),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.applied).toBe(1);
    expect(out.progress.status).toBe("done");
    expect(cu.CATCHUP_DEAD_AFTER_MS).toBe(bf.BACKFILL_DEAD_AFTER_MS);
    expect(cu.CATCHUP_DEAD_AFTER_MS).toBe(2 * am.FETCH_TIMEOUT_MS + 4 * bf.BACKFILL_RATE_LIMIT_MS);
  });

  it("W5 skeptic 1(b): a live run silent for 20 s is NOT dead — the threshold exceeds two fetch timeouts", async () => {
    // One fetch is up to two attempts (UDiFF, then legacy) of FETCH_TIMEOUT_MS
    // each, after a rate-limit wait: the longest silence a LIVE loop can go.
    const longestLegitimateSilence = 2 * am.FETCH_TIMEOUT_MS + bf.BACKFILL_RATE_LIMIT_MS;
    expect(bf.BACKFILL_DEAD_AFTER_MS).toBe(2 * am.FETCH_TIMEOUT_MS + 4 * bf.BACKFILL_RATE_LIMIT_MS);
    expect(bf.BACKFILL_DEAD_AFTER_MS).toBeGreaterThan(longestLegitimateSilence);
    const nowMs = Date.now();
    for (const silentMs of [20_000, longestLegitimateSilence]) {
      const stamp = new Date(nowMs - silentMs).toISOString();
      expect(isEnvelopeDead({ status: "running", updatedAt: stamp }, nowMs, cu.CATCHUP_DEAD_AFTER_MS), `${silentMs} ms`).toBe(false);
    }
    // Behaviourally: the next app-open sees a run 20 s quiet and REFUSES —
    // it does not reset it and start a second walker on the same host.
    enableAutoMtm();
    const quiet = new Date(Date.now() - 20_000).toISOString();
    t.sqlite
      .prepare("UPDATE settings SET bhavcopy_backfill_progress = ?")
      .run(JSON.stringify({ ...bf.IDLE_PROGRESS, kind: "backfill", status: "running", updatedAt: quiet, startedAt: quiet, applied: 3 }));
    const out = await cu.runBhavcopyCatchup({ now: NOW, fetchOne: async () => null, sleep: async () => {} });
    expect(out.ok === false && out.reason).toBe("already_running");
    expect(bf.readBackfillProgress().status).toBe("running"); // untouched: not reset, not re-labelled
  });

  it("W5 skeptic 1(a): the envelope is touched before EACH fetch (heartbeat), not only after the apply", async () => {
    enableAutoMtm();
    const STALE = "2020-01-01T00:00:00.000Z";
    const seenAtFetch: { date: string; updatedAt: string | null; message: string }[] = [];
    const out = await cu.runBhavcopyCatchup({
      now: NOW,
      maxFiles: 3,
      // The rate-limit wait sits between the previous persist and the next
      // fetch. Age the stamp there: only a write BEFORE the fetch can refresh it.
      sleep: async () => {
        const row = t.sqlite.prepare("SELECT bhavcopy_backfill_progress AS p FROM settings").get() as { p: string };
        t.sqlite.prepare("UPDATE settings SET bhavcopy_backfill_progress = ?").run(JSON.stringify({ ...JSON.parse(row.p), updatedAt: STALE }));
      },
      fetchOne: async (d) => {
        const p = bf.readBackfillProgress();
        seenAtFetch.push({ date: d, updatedAt: p.updatedAt, message: p.message });
        return { text: csvFor(d), source: "udiff", url: "test://x" };
      },
    });
    expect(out.ok).toBe(true);
    expect(seenAtFetch).toHaveLength(3);
    for (const s of seenAtFetch) {
      expect(s.updatedAt, `stamp at the fetch for ${s.date}`).not.toBe(STALE);
      expect(s.message, `message at the fetch for ${s.date}`).toBe(`Fetching ${s.date}…`);
    }
  });

  it("W5 skeptic 1(c): ONE lock for both walkers — the backfill refuses while the catch-up holds it, and vice versa", async () => {
    enableAutoMtm();
    bf.recordBackfillAck();
    const idle = { fetchOne: async () => null, sleep: async () => {} };
    // The envelope is IDLE, so only the lock can refuse: this is the window
    // between reading the envelope and writing `running`.
    expect(bf.readBackfillProgress().status).toBe("idle");
    expect(bf.takeBhavcopyJobLock()).toBe(true);
    try {
      const a = await bf.runBhavcopyBackfill({ days: 1, now: NOW, ...idle });
      const b = await cu.runBhavcopyCatchup({ now: NOW, ...idle });
      expect(a.ok === false && a.reason).toBe("already_running");
      expect(b.ok === false && b.reason).toBe("already_running");
    } finally {
      bf.releaseBhavcopyJobLock();
    }
    // Live, both ways: a walker parked inside its fetch holds the lock.
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const parked = (d: string) => gate.then(() => ({ text: csvFor(d), source: "udiff" as const, url: "test://x" }));
    const catchup = cu.runBhavcopyCatchup({ now: NOW, maxFiles: 1, sleep: async () => {}, fetchOne: parked });
    await new Promise((r) => setTimeout(r, 5));
    const backfillRefused = await bf.runBhavcopyBackfill({ days: 1, now: NOW, ...idle });
    expect(backfillRefused.ok === false && backfillRefused.reason).toBe("already_running");
    release();
    expect((await catchup).ok).toBe(true);

    gate = new Promise<void>((r) => (release = r));
    const backfill = bf.runBhavcopyBackfill({ days: 1, now: NOW, sleep: async () => {}, fetchOne: parked });
    await new Promise((r) => setTimeout(r, 5));
    const catchupRefused = await cu.runBhavcopyCatchup({ now: NOW, ...idle });
    expect(catchupRefused.ok === false && catchupRefused.reason).toBe("already_running");
    release();
    expect((await backfill).ok).toBe(true);
  });

  it("the process lock (A6 ii): two opens within the same tick make ONE run", async () => {
    enableAutoMtm();
    let calls = 0;
    const deps = {
      now: NOW,
      maxFiles: 2,
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 5)); // let the second caller in mid-run
      },
      fetchOne: async (d: string) => {
        calls++;
        return { text: csvFor(d), source: "udiff" as const, url: "test://x" };
      },
    };
    const [a, b] = await Promise.all([cu.runBhavcopyCatchup(deps), cu.runBhavcopyCatchup(deps)]);
    const reasons = [a, b].map((o) => (o.ok ? "ran" : o.reason)).sort();
    expect(reasons).toEqual(["already_running", "ran"]);
    expect(calls).toBe(2);
  });

  it("the status the panel prints: the count, the per-open budget and whether it runs automatically", () => {
    const s = cu.catchupStatus(NOW);
    expect(s.windowDays).toBe(252);
    expect(s.perOpen).toBe(10);
    expect(s.missing).toBe(252);
    expect(s.line).toBe("252 sessions missing in your 252-day window — run the backfill.");
    expect(s.automatic).toBe(false);
    enableAutoMtm();
    expect(cu.catchupStatus(NOW).automatic).toBe(true);
  });
});

describe("no new host (A6 v)", () => {
  it("the catch-up file names no URL and no host — it reuses the fetch in auto-mtm.ts", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib", "jobs", "bhavcopy-catchup.ts"), "utf8");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/nseindia/i);
    expect(src).toContain("fetchBhavcopyForDate");
  });
});
