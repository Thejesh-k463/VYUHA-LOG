import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * The one-time history backfill (research answer Q43).
 *
 * This is the only thing in v4.0 that downloads in bulk, so the tests are
 * about its manners rather than its arithmetic:
 *
 *   consent   — no ack, no run. Not a silent no-op: the caller is told which
 *               of the two consents is missing, and the route turns that into
 *               a 403 rather than starting and stopping.
 *   pacing    — n files make exactly n-1 waits, sequential. A parallel burst
 *               is how a free public archive stops being free and public.
 *   honesty   — applied / skipped / missing are three different facts and are
 *               never summed into one "done". A market holiday and a blocked
 *               download are not the same event.
 *   restraint — ten misses in a row is offline or blocked; grinding through
 *               242 more requests to discover that is neither polite nor
 *               useful. And a date that already holds a full session is not
 *               re-downloaded at all.
 *   abortable — the flag is re-read from the DATABASE every iteration, since
 *               the request that sets it is a different request.
 *
 * `fetchOne` and `sleep` are injected, so nothing here touches the network and
 * nothing waits 1.5 seconds.
 */

let t: TempDb;
let bf: typeof import("@/lib/jobs/bhavcopy-backfill");

const csvFor = (date: string, symbols = ["RELIANCE", "TCS"]) =>
  [
    "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol",
    ...symbols.map((s, i) => `${date},STK,${s},EQ,${100 + i},${110 + i},${95 + i},${105 + i},${1000 + i}`),
  ].join("\n");

beforeAll(async () => {
  t = await openTempDb("bhavcopy-backfill", { seed: true });
  bf = await import("@/lib/jobs/bhavcopy-backfill");
});

afterAll(() => t?.cleanup());

beforeEach(() => {
  t.sqlite.prepare("UPDATE settings SET bhavcopy_backfill_ack = NULL, bhavcopy_backfill_progress = NULL, auto_mtm_enabled = 0").run();
  t.sqlite.prepare("DELETE FROM price_history").run();
});

describe("consent", () => {
  it("refuses to start with neither auto-MTM nor an explicit ack", async () => {
    expect(bf.hasBackfillConsent()).toBe(false);
    const out = await bf.runBhavcopyBackfill({ fetchOne: async () => null, sleep: async () => {} });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("consent");
  });

  it("accepts the auto-MTM toggle as consent to the same host and file family", () => {
    t.sqlite.prepare("UPDATE settings SET auto_mtm_enabled = 1").run();
    expect(bf.hasBackfillConsent()).toBe(true);
  });

  it("records WHEN the explicit ack was given, so it is auditable", () => {
    bf.recordBackfillAck("2026-09-06T04:00:00.000Z");
    expect(bf.hasBackfillConsent()).toBe(true);
    const row = t.sqlite.prepare("SELECT bhavcopy_backfill_ack AS a FROM settings").get() as { a: string };
    expect(row.a).toBe("2026-09-06T04:00:00.000Z");
  });
});

describe("the walk", () => {
  beforeEach(() => bf.recordBackfillAck());

  it("counts applied, missing and rows separately and finishes 'done'", async () => {
    const dates = bf.backfillDates(new Date("2026-09-04T12:00:00Z"), 3);
    const seen: string[] = [];
    const out = await bf.runBhavcopyBackfill({
      days: 3,
      now: new Date("2026-09-04T12:00:00Z"),
      sleep: async () => {},
      fetchOne: async (d) => {
        seen.push(d);
        return d === dates[1] ? null : { text: csvFor(d), source: "udiff", url: `test://${d}` };
      },
    });
    expect(out.ok).toBe(true);
    const p = out.progress;
    expect(seen).toEqual(dates);
    expect(p.status).toBe("done");
    expect([p.applied, p.missing, p.skipped]).toEqual([2, 1, 0]);
    expect(p.rows).toBe(4); // two symbols on each of the two files that answered
    expect(p.requested).toBe(3);
    expect(p.message).toContain("2 sessions downloaded");
    // Persisted, so a reload sees it.
    expect(bf.readBackfillProgress().status).toBe("done");
  });

  it("waits between files and not before the first — n files, n-1 waits", async () => {
    const waits: number[] = [];
    await bf.runBhavcopyBackfill({
      days: 4,
      now: new Date("2026-09-04T12:00:00Z"),
      sleep: async (ms) => void waits.push(ms),
      fetchOne: async (d) => ({ text: csvFor(d), source: "udiff", url: "test://x" }),
    });
    expect(waits).toEqual([bf.BACKFILL_RATE_LIMIT_MS, bf.BACKFILL_RATE_LIMIT_MS, bf.BACKFILL_RATE_LIMIT_MS]);
  });

  it("skips a date that already holds a full session, and never fetches it", async () => {
    const dates = bf.backfillDates(new Date("2026-09-04T12:00:00Z"), 2);
    const insert = t.sqlite.prepare("INSERT INTO price_history (symbol, date, close, source) VALUES (?, ?, 100, 'bhavcopy')");
    for (let i = 0; i < bf.FULL_SESSION_MIN_ROWS; i++) insert.run(`SYM${i}`, dates[0]);
    const asked: string[] = [];
    const out = await bf.runBhavcopyBackfill({
      days: 2,
      now: new Date("2026-09-04T12:00:00Z"),
      sleep: async () => {},
      fetchOne: async (d) => {
        asked.push(d);
        return { text: csvFor(d), source: "udiff", url: "test://x" };
      },
    });
    expect(asked).toEqual([dates[1]]);
    expect(out.progress.skipped).toBe(1);
    expect(out.progress.applied).toBe(1);
  });

  it("does NOT mistake a handful of manual MTM rows for a session", async () => {
    const dates = bf.backfillDates(new Date("2026-09-04T12:00:00Z"), 1);
    const insert = t.sqlite.prepare("INSERT INTO price_history (symbol, date, close, source) VALUES (?, ?, 100, 'manual')");
    for (let i = 0; i < 5; i++) insert.run(`HELD${i}`, dates[0]);
    const out = await bf.runBhavcopyBackfill({
      days: 1,
      now: new Date("2026-09-04T12:00:00Z"),
      sleep: async () => {},
      fetchOne: async (d) => ({ text: csvFor(d), source: "legacy", url: "test://x" }),
    });
    expect(out.progress.skipped).toBe(0);
    expect(out.progress.applied).toBe(1);
  });

  it("gives up after ten consecutive misses instead of grinding through the year", async () => {
    let calls = 0;
    const out = await bf.runBhavcopyBackfill({
      days: 60,
      now: new Date("2026-09-04T12:00:00Z"),
      sleep: async () => {},
      fetchOne: async () => {
        calls++;
        return null;
      },
    });
    expect(calls).toBe(bf.BACKFILL_MAX_CONSECUTIVE_MISSES);
    expect(out.progress.status).toBe("error");
    expect(out.progress.message).toContain("nothing already saved was lost");
  });

  it("stops when a second request sets the abort flag, and keeps what it had", async () => {
    const out = await bf.runBhavcopyBackfill({
      days: 5,
      now: new Date("2026-09-04T12:00:00Z"),
      sleep: async () => {},
      fetchOne: async (d) => {
        // Another request, arriving mid-run: it writes the flag to the DB.
        if (bf.readBackfillProgress().applied >= 1) bf.requestBackfillAbort();
        return { text: csvFor(d), source: "udiff", url: "test://x" };
      },
    });
    expect(out.progress.status).toBe("aborted");
    expect(out.progress.applied).toBeGreaterThanOrEqual(1);
    expect(out.progress.applied).toBeLessThan(5);
    expect(out.progress.message).toContain("you asked it to stop");
  });

  it("refuses a second run while one is going", async () => {
    bf.writeBackfillProgress({ ...bf.IDLE_PROGRESS, status: "running" });
    const out = await bf.runBhavcopyBackfill({ fetchOne: async () => null, sleep: async () => {} });
    expect(out.ok === false && out.reason).toBe("already_running");
  });

  it("clamps the request to the 252 sessions PRIVACY item 2 states", async () => {
    let calls = 0;
    const out = await bf.runBhavcopyBackfill({
      days: 5_000,
      now: new Date("2026-09-04T12:00:00Z"),
      sleep: async () => {},
      fetchOne: async () => {
        calls++;
        return null;
      },
    });
    expect(out.progress.requested).toBe(bf.BACKFILL_MAX_DAYS);
    expect(calls).toBeLessThanOrEqual(bf.BACKFILL_MAX_DAYS);
  });
});

describe("the stored envelope", () => {
  it("discards a shape from another version rather than half-reading it", () => {
    t.sqlite.prepare("UPDATE settings SET bhavcopy_backfill_progress = ?").run(JSON.stringify({ v: 2, status: "running", applied: 99 }));
    expect(bf.readBackfillProgress()).toEqual(bf.IDLE_PROGRESS);
  });

  it("survives a corrupt blob", () => {
    t.sqlite.prepare("UPDATE settings SET bhavcopy_backfill_progress = ?").run("{not json");
    expect(bf.readBackfillProgress().status).toBe("idle");
  });
});
