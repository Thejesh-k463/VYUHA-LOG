import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { SLIM_TRADE_FIELDS } from "@/lib/domain/slim-trade";
import { diffFields } from "@/lib/analytics/audit-diff";

/**
 * WS1 — the Trade Review Desk's SERVER layer against a real migrated temp DB,
 * which also proves migrations 0055/0056 apply cleanly (openTempDb runs the
 * whole drizzle folder).
 *
 * Covers: the queue's membership rule (closed AND unreviewed), its ordering,
 * the window vs the unwindowed `total` (a shortened list always states what it
 * held back), the account boundary in BOTH directions (invariant 8), the
 * aggregate view's write ban (invariant 9), the journal save's `?? now` stamp
 * (saving a review IS reviewing it — and the journal stays FREE, invariant 7),
 * the CLOSED-ONLY half of that stamp (journalling a live position is not a
 * review, and the trade joins the queue on the day it closes), what the audit
 * row says about the stamp in BOTH directions, mark/reopen round trips,
 * UNIQUE(account, week) on the weekly ritual, the completion pair being
 * written once, and the route's 400/403 mapping.
 *
 * ONE temp database per FILE: lib/db caches its connection on globalThis, so a
 * second openTempDb() here would silently reuse the first.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let review: typeof import("@/lib/queries/review");
let route: typeof import("@/app/api/review/route");
let journalRoute: typeof import("@/app/api/trades/journal/route");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

const MON = "2026-08-24"; // ISO Monday; the week runs to Sunday 2026-08-30
const MON_NEXT = "2026-08-31";
const WED = "2026-08-26";

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function req(body: unknown): Request {
  return new Request("http://local/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function journalReq(body: unknown): Request {
  return new Request("http://local/api/trades/journal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Insert one trade, returning its id. */
function addTrade(over: Record<string, unknown>): number {
  const res = t.db.insert(t.schema.trades).values(tradeRow(over) as never).run();
  return Number(res.lastInsertRowid);
}

function clearTrades() {
  t.db.delete(t.schema.trades).run();
}

function reviewedAtOf(id: number): string | null {
  return (t.sqlite.prepare("select reviewed_at as r from trades where id = ?").get(id) as { r: string | null }).r;
}

function notesOf(id: number): string | null {
  return (t.sqlite.prepare("select notes as n from trades where id = ?").get(id) as { n: string | null }).n;
}

/** The newest audit row for the weekly ritual. `before` is null on a create. */
function lastWeeklyAudit(): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  const row = t.sqlite
    .prepare("select before_json as b, after_json as a from audit_log where entity = 'weekly_review' order by id desc limit 1")
    .get() as { b: string | null; a: string | null } | undefined;
  return {
    before: JSON.parse(row?.b ?? "null") as Record<string, unknown> | null,
    after: JSON.parse(row?.a ?? "null") as Record<string, unknown> | null,
  };
}

/** Raw column, so "none" can be told apart from the empty array. */
function mistakeTagsOf(id: number): string | null {
  return (t.sqlite.prepare("select mistake_tags as m from trades where id = ?").get(id) as { m: string | null }).m;
}

/**
 * The newest audit row for a trade, parsed the way the viewer reads it.
 *
 * recordAudit is best-effort and swallows its own errors, so a missing row
 * surfaces here as two empty snapshots — which reddens the assertions rather
 * than quietly passing them.
 */
function lastTradeAudit(id: number): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const row = t.sqlite
    .prepare("select before_json as b, after_json as a from audit_log where entity = 'trade' and entity_id = ? order by id desc limit 1")
    .get(id) as { b: string | null; a: string | null } | undefined;
  return {
    before: JSON.parse(row?.b ?? "{}") as Record<string, unknown>,
    after: JSON.parse(row?.a ?? "{}") as Record<string, unknown>,
  };
}

beforeAll(async () => {
  t = await openTempDb("review-queue", { seed: true });
  review = await import("@/lib/queries/review");
  route = await import("@/app/api/review/route");
  journalRoute = await import("@/app/api/trades/journal/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("the queue: closed AND unreviewed, this account, newest close first", () => {
  let older = 0;
  let newer = 0;
  let open = 0;
  let done = 0;
  let swing = 0;

  beforeAll(() => {
    clearTrades();
    older = addTrade({ symbol: "OLDER", isOpen: false, sellDate: "2026-08-10" });
    newer = addTrade({ symbol: "NEWER", isOpen: false, sellDate: "2026-08-20" });
    open = addTrade({ symbol: "OPEN", isOpen: true, sellDate: null });
    done = addTrade({ symbol: "DONE", isOpen: false, sellDate: "2026-08-19", reviewedAt: "2026-08-21 09:00:00" });
    swing = addTrade({ accountId: SWING, symbol: "SWING", isOpen: false, sellDate: "2026-08-21" });
  });

  it("excludes open trades, reviewed trades and the other account's book", () => {
    selectAccount(PRIMARY);
    const q = review.getReviewQueue();
    expect(q.rows.map((r) => r.id)).toEqual([newer, older]); // newest sellDate first
    expect(q.rows.map((r) => r.id)).not.toContain(open);
    expect(q.rows.map((r) => r.id)).not.toContain(done);
    expect(q.rows.map((r) => r.id)).not.toContain(swing);
    expect(q.total).toBe(2);
  });

  it("scopes the OTHER way too — Swing sees only its own (invariant 8)", () => {
    selectAccount(SWING);
    const q = review.getReviewQueue();
    expect(q.rows.map((r) => r.id)).toEqual([swing]);
    expect(q.total).toBe(1);
  });

  it("the aggregate view reads every account's queue (accountId > 0 ? filter : all)", () => {
    selectAccount(ALL);
    const q = review.getReviewQueue();
    expect(q.rows.map((r) => r.id)).toEqual([swing, newer, older]);
    expect(q.total).toBe(3);
  });

  it("projects exactly the slim wire shape the journal dialog is typed against", () => {
    selectAccount(PRIMARY);
    const row = review.getReviewQueue().rows[0];
    expect(Object.keys(row).sort()).toEqual([...SLIM_TRADE_FIELDS].sort());
    expect(row).toHaveProperty("reviewedAt", null);
  });

  it("counts the week the desk header asks about, and nothing outside it", () => {
    selectAccount(PRIMARY);
    // Week 2026-08-24 → 2026-08-30 holds nothing of PRIMARY's; the earlier one does.
    expect(review.getReviewStats(MON)).toMatchObject({ weekStart: MON, weekEnd: "2026-08-30", closed: 0, reviewed: 0, unreviewed: 0 });
    const stats = review.getReviewStats("2026-08-17");
    expect(stats.weekEnd).toBe("2026-08-23");
    expect(stats).toMatchObject({ closed: 2, reviewed: 1, unreviewed: 1 }); // NEWER + DONE; OPEN and OLDER are outside
  });
});

describe("the window states what it held back", () => {
  beforeAll(() => {
    clearTrades();
    for (let i = 0; i < 160; i++) {
      addTrade({ symbol: `T${i}`, isOpen: false, sellDate: `2026-0${1 + (i % 9)}-01` });
    }
    selectAccount(PRIMARY);
  });

  it("windows the rows at the default 150 but totals the whole queue", () => {
    const q = review.getReviewQueue();
    expect(q.rows).toHaveLength(150);
    expect(q.limit).toBe(150);
    expect(q.total).toBe(160); // "showing 150 of 160"
  });

  it("honours an explicit smaller window, still totalling everything", () => {
    const q = review.getReviewQueue({ limit: 10 });
    expect(q.rows).toHaveLength(10);
    expect(q.total).toBe(160);
  });
});

describe("writes: the aggregate view is a view, not a place (invariant 9)", () => {
  let id = 0;

  beforeAll(() => {
    clearTrades();
    id = addTrade({ symbol: "AGG", isOpen: false, sellDate: "2026-08-25" });
    t.db.delete(t.schema.weeklyReviews).run();
    selectAccount(ALL);
  });

  it("refuses mark-reviewed, reopen and the weekly upsert alike", () => {
    for (const res of [review.markReviewed(id), review.reopenReview(id), review.upsertWeeklyReview({ weekStart: MON, note: "x" })]) {
      expect(res.ok).toBe(false);
      expect(res.forbidden).toBe(true);
    }
  });

  it("and writes nothing while refusing", () => {
    expect(reviewedAtOf(id)).toBeNull();
    expect(t.db.select().from(t.schema.weeklyReviews).all()).toHaveLength(0);
  });
});

describe("mark reviewed / reopen", () => {
  let mine = 0;
  let theirs = 0;

  beforeAll(() => {
    clearTrades();
    mine = addTrade({ symbol: "MINE", isOpen: false, sellDate: "2026-08-25" });
    theirs = addTrade({ accountId: SWING, symbol: "THEIRS", isOpen: false, sellDate: "2026-08-25" });
    selectAccount(PRIMARY);
  });

  it("stamps, leaves the queue, reopens and comes back", () => {
    expect(review.markReviewed(mine).ok).toBe(true);
    expect(reviewedAtOf(mine)).not.toBeNull();
    expect(review.getReviewQueue().rows.map((r) => r.id)).not.toContain(mine);

    expect(review.reopenReview(mine).ok).toBe(true);
    expect(reviewedAtOf(mine)).toBeNull();
    expect(review.getReviewQueue().rows.map((r) => r.id)).toContain(mine);
  });

  it("does not move an existing stamp when marked twice", () => {
    review.markReviewed(mine);
    t.sqlite.prepare("update trades set reviewed_at = '2020-01-01 00:00:00' where id = ?").run(mine);
    expect(review.markReviewed(mine).ok).toBe(true);
    expect(reviewedAtOf(mine)).toBe("2020-01-01 00:00:00");
    review.reopenReview(mine);
  });

  it("refuses an OPEN trade — the queue is a caller, not a guarantee", () => {
    // The queue only ever LISTS closed trades, but markReviewed is an exported
    // write and the stamp it lands is permanent: nothing clears it when the
    // position closes. So the closed-only rule is enforced at the writer, the
    // same way the journal route and migration 0055's backfill enforce it,
    // rather than assumed from the one caller that happens to be safe.
    selectAccount(PRIMARY);
    const live = addTrade({ symbol: "LIVE", isOpen: true, sellDate: null });
    const res = review.markReviewed(live);
    expect(res.ok).toBe(false);
    expect(res.forbidden).toBeUndefined(); // a 400, not the aggregate 403
    expect(res.message).toMatch(/still open/i);
    expect(reviewedAtOf(live), "an OPEN trade was stamped reviewed").toBeNull();
  });

  it("the audit row NAMES the stamp — a row that exists and says nothing is the same lie", () => {
    // `before: {reviewedAt: null}` with NO `after` was the shape here: the
    // viewer's diff walks the union of both key sets and normalises a missing
    // key to null, so null === null yielded ZERO changes. The audit row was
    // present, looked complete, and did not contain the mutation it was
    // written for. Pin the FIELD, not just the values.
    selectAccount(PRIMARY);
    const fresh = addTrade({ symbol: "AUDITMARK", isOpen: false, sellDate: "2026-08-25" });
    expect(review.markReviewed(fresh).ok).toBe(true);
    const { before, after } = lastTradeAudit(fresh);
    const stored = reviewedAtOf(fresh);

    expect(stored).not.toBeNull();
    expect(diffFields(before, after), "the mark produced an audit row with no changes in it")
      .toEqual([{ field: "reviewedAt", from: null, to: stored }]);
  });

  it("and reopen states the clearing in the other direction", () => {
    // The sibling writer already passed both sides; this pins that it stays so.
    selectAccount(PRIMARY);
    const fresh = addTrade({ symbol: "AUDITREOPEN", isOpen: false, sellDate: "2026-08-25" });
    expect(review.markReviewed(fresh).ok).toBe(true);
    const stamp = reviewedAtOf(fresh);
    expect(review.reopenReview(fresh).ok).toBe(true);
    const { before, after } = lastTradeAudit(fresh);

    expect(diffFields(before, after)).toEqual([{ field: "reviewedAt", from: stamp, to: null }]);
    expect(reviewedAtOf(fresh)).toBeNull();
  });

  it("cannot reach across the account boundary (invariant 8, the write half)", () => {
    selectAccount(PRIMARY);
    const res = review.markReviewed(theirs);
    expect(res.ok).toBe(false);
    expect(res.forbidden).toBeUndefined(); // a 400, not the aggregate 403
    expect(reviewedAtOf(theirs)).toBeNull();

    selectAccount(SWING);
    expect(review.markReviewed(mine).ok).toBe(false);
    expect(reviewedAtOf(mine)).toBeNull();
    selectAccount(PRIMARY);
  });
});

describe("saving the journal IS reviewing (and the journal stays free — invariant 7)", () => {
  let id = 0;

  beforeAll(() => {
    clearTrades();
    id = addTrade({ symbol: "JOURNAL", isOpen: false, sellDate: "2026-08-25" });
    selectAccount(PRIMARY);
  });

  it("stamps reviewed_at on a save that had none", async () => {
    expect(reviewedAtOf(id)).toBeNull();
    const res = await journalRoute.POST(journalReq({ id, notes: "sized down after the gap" }));
    expect(res.status).toBe(200);
    expect(reviewedAtOf(id)).not.toBeNull();
    expect(review.getReviewQueue().rows.map((r) => r.id)).not.toContain(id);
  });

  it("a second save does NOT move the stamp", async () => {
    t.sqlite.prepare("update trades set reviewed_at = '2020-01-01 00:00:00' where id = ?").run(id);
    const res = await journalRoute.POST(journalReq({ id, notes: "fixed a typo" }));
    expect(res.status).toBe(200);
    expect(reviewedAtOf(id)).toBe("2020-01-01 00:00:00");
  });

  it("keeps its own validation and revalidates /review as well", async () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/api/trades/journal/route.ts"), "utf8");
    // Untouched: emotion/mistake validation and the playbook-rule check.
    expect(src).toContain("EMOTIONS.has(body.emotionTag)");
    expect(src).toContain("MISTAKES.has(t)");
    expect(src).toContain("valid.has(r)");
    // The core journal is never gated — no entitlement check may appear here.
    expect(src).not.toMatch(/getEntitlement|ProGate/);
    expect(src).toContain('"/review"');
  });
});

describe("journalling an OPEN position is not reviewing it", () => {
  let id = 0;

  beforeAll(() => {
    clearTrades();
    id = addTrade({ symbol: "OPENJRNL", isOpen: true, sellDate: null });
    selectAccount(PRIMARY);
  });

  it("saves the journal on a position still held, and stamps nothing", async () => {
    // Invariant 7 in both directions: the save must WORK (the notebook icon
    // renders on every row of /trades, and a thesis on a live position is
    // exactly what it is for) but must not claim a review happened.
    const res = await journalRoute.POST(journalReq({ id, notes: "thesis: holding into the result" }));
    expect(res.status).toBe(200);
    expect(notesOf(id)).toBe("thesis: holding into the result");
    expect(reviewedAtOf(id), "an OPEN trade was stamped reviewed").toBeNull();
  });

  it("so it JOINS the queue the day it closes — it has never been reviewed as a closed trade", () => {
    // The close writes is_open (lib/import/commit.ts, the close dialog) and
    // never touches reviewed_at; if the save above had stamped, this trade
    // would be permanently absent from the queue and would already count in
    // the week's `reviewed` figure.
    t.sqlite.prepare("update trades set is_open = 0, sell_date = '2026-08-26' where id = ?").run(id);
    expect(reviewedAtOf(id)).toBeNull();
    expect(review.getReviewQueue().rows.map((r) => r.id)).toContain(id);
    expect(review.getReviewStats(MON)).toMatchObject({ closed: 1, reviewed: 0, unreviewed: 1 });
  });

  it("and the first save AFTER the close is the one that stamps it", async () => {
    const res = await journalRoute.POST(journalReq({ id, notes: "took the gap, sized right" }));
    expect(res.status).toBe(200);
    expect(reviewedAtOf(id)).not.toBeNull();
    expect(review.getReviewQueue().rows.map((r) => r.id)).not.toContain(id);
    expect(review.getReviewStats(MON)).toMatchObject({ closed: 1, reviewed: 1, unreviewed: 0 });
  });
});

describe("the audit row states the stamp that happened, and no stamp that did not", () => {
  let id = 0;

  beforeAll(() => {
    clearTrades();
    id = addTrade({ symbol: "AUDITED", isOpen: false, sellDate: "2026-08-26" });
    selectAccount(PRIMARY);
  });

  it("the save that LANDS the stamp diffs null → the time actually stored", async () => {
    expect((await journalRoute.POST(journalReq({ id, notes: "first pass" }))).status).toBe(200);
    const { before, after } = lastTradeAudit(id);
    const stored = reviewedAtOf(id);

    expect(stored).not.toBeNull();
    expect(diffFields(before, after).find((c) => c.field === "reviewedAt"), "the stamp landed with no reviewedAt row")
      .toMatchObject({ from: null, to: stored });
    expect(before.reviewedAt).toBeNull();
    // Not merely truthy: the log must carry the value the row carries, or the
    // "before/after snapshots" claim (help-content, README, the client docs)
    // is describing a different write than the one that happened.
    expect(after.reviewedAt).toBe(stored);
  });

  it("a re-save shows NO reviewedAt row — the viewer diffs the UNION of both key sets", async () => {
    // `after` omitting the key is not neutral: diffFields walks the union, so
    // an absent key reads as `undefined` → null and renders a CLEARING this
    // route explicitly cannot perform.
    const stampedAt = reviewedAtOf(id);
    expect((await journalRoute.POST(journalReq({ id, notes: "fixed a typo" }))).status).toBe(200);
    const { before, after } = lastTradeAudit(id);

    expect(reviewedAtOf(id)).toBe(stampedAt); // untouched, as `?? now` promises
    expect(
      diffFields(before, after).map((c) => c.field),
      "the log renders a reviewedAt CLEARING this route cannot perform",
    ).not.toContain("reviewedAt");
    expect(Object.keys(after)).toContain("reviewedAt");
    expect(after.reviewedAt).toBe(stampedAt);
  });

  it("names ONLY the field that changed — no phantom null → [] on the JSON columns", async () => {
    // The two JSON columns store NULL for "none". A snapshot that says `[]`
    // where the row says NULL renders an edit the user never made, in a log
    // the product calls an append-only record of every mutation.
    const clean = addTrade({ symbol: "NOMISTAKES", isOpen: false, sellDate: "2026-08-26" });
    // The row already holds NULL for both after the first save; the SECOND
    // save is the one under test, where nothing but the note moves.
    expect((await journalRoute.POST(journalReq({ id: clean, notes: "clean" }))).status).toBe(200);
    expect((await journalRoute.POST(journalReq({ id: clean, notes: "clean, reworded" }))).status).toBe(200);
    const { before, after } = lastTradeAudit(clean);

    expect(mistakeTagsOf(clean)).toBeNull();
    expect(after.mistakeTags, "the log wrote [] where the row holds NULL").toBeNull();
    expect(after.ruleViolations, "the log wrote [] where the row holds NULL").toBeNull();
    expect(before.mistakeTags).toBeNull();
    expect(before.ruleViolations).toBeNull();
    expect(diffFields(before, after).map((c) => c.field), "changes the user never made").toEqual(["notes"]);
  });

  it("and still reports the JSON columns when they DO change — this is not 'hide the field'", async () => {
    const tagged = addTrade({ symbol: "TAGGEDSAVE", isOpen: false, sellDate: "2026-08-26" });
    // A pre-existing ENTRY-TIME limit breach: not the journal's to erase, so it
    // must survive the save unchanged and therefore raise no diff row either.
    t.sqlite.prepare("update trades set rule_violations = ? where id = ?").run('["Daily loss limit breached"]', tagged);
    expect((await journalRoute.POST(journalReq({ id: tagged, notes: "sized wrong", mistakeTags: ["oversized"] }))).status).toBe(200);
    const { before, after } = lastTradeAudit(tagged);

    expect(diffFields(before, after).find((c) => c.field === "mistakeTags"))
      .toMatchObject({ from: null, to: ["oversized"] });
    expect(after.ruleViolations).toEqual(["Daily loss limit breached"]);
    expect(diffFields(before, after).map((c) => c.field)).not.toContain("ruleViolations");
  });

  it("a weekly note edit audits the note only — weekStart is not a change", async () => {
    // `weekStart` sat on `after` alone, and the union diff turned that into a
    // phantom `weekStart: null → "2026-08-24"` on every note edit. The row is
    // looked up BY that week, so it is provably identical on the update path.
    selectAccount(PRIMARY);
    t.db.delete(t.schema.weeklyReviews).run();
    expect(review.upsertWeeklyReview({ weekStart: MON, note: "first sitting" }).ok).toBe(true);
    expect(review.upsertWeeklyReview({ weekStart: MON, note: "second sitting" }).ok).toBe(true);
    const { before, after } = lastWeeklyAudit();

    expect(diffFields(before, after), "a change the user never made")
      .toEqual([{ field: "note", from: "first sitting", to: "second sitting" }]);
    // The CREATE path is a different, honest shape: nothing existed, so
    // `before` is null rather than a key set that disagrees with `after`.
    t.db.delete(t.schema.weeklyReviews).run();
    expect(review.upsertWeeklyReview({ weekStart: MON, note: "brand new" }).ok).toBe(true);
    expect(lastWeeklyAudit().before).toBeNull();
    t.db.delete(t.schema.weeklyReviews).run();
  });

  it("and an open trade's save reports no review either way", async () => {
    const openId = addTrade({ symbol: "OPENAUDIT", isOpen: true, sellDate: null });
    expect((await journalRoute.POST(journalReq({ id: openId, notes: "live thesis" }))).status).toBe(200);
    const { before, after } = lastTradeAudit(openId);
    expect(before.reviewedAt).toBeNull();
    expect(after.reviewedAt).toBeNull();
    expect(diffFields(before, after).map((c) => c.field)).not.toContain("reviewedAt");
  });
});

describe("the weekly ritual: one row per (account, week)", () => {
  beforeAll(() => {
    t.db.delete(t.schema.weeklyReviews).run();
    selectAccount(PRIMARY);
  });

  it("creates, then EDITS rather than duplicating", () => {
    expect(review.upsertWeeklyReview({ weekStart: MON, note: "first pass" }).ok).toBe(true);
    expect(review.upsertWeeklyReview({ weekStart: MON, note: "second pass" }).ok).toBe(true);
    const rows = t.db.select().from(t.schema.weeklyReviews).all().filter((r) => r.accountId === PRIMARY);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("second pass");
    expect(rows[0].completedAt).toBeNull(); // a note edit does not complete the week
  });

  it("lets the OTHER account hold its own row for the same week", () => {
    selectAccount(SWING);
    expect(review.upsertWeeklyReview({ weekStart: MON, note: "swing's week" }).ok).toBe(true);
    expect(t.db.select().from(t.schema.weeklyReviews).all()).toHaveLength(2);
    expect(review.getWeeklyReview(MON)?.note).toBe("swing's week");
    selectAccount(PRIMARY);
    expect(review.getWeeklyReview(MON)?.note).toBe("second pass");
  });

  it("resolves no single week's note in the aggregate view, but lists every account's", () => {
    selectAccount(ALL);
    expect(review.getWeeklyReview(MON)).toBeNull();
    expect(review.listWeeklyReviews()).toHaveLength(2);
    selectAccount(PRIMARY);
    expect(review.listWeeklyReviews()).toHaveLength(1);
  });

  it("records the completion pair ONCE — the score at completion is history", () => {
    selectAccount(PRIMARY);
    expect(review.upsertWeeklyReview({ weekStart: MON, note: "done", completed: true, scoreAtCompletion: 62 }).ok).toBe(true);
    const first = review.getWeeklyReview(MON)!;
    expect(first.completedAt).not.toBeNull();
    expect(first.scoreAtCompletion).toBe(62);

    // Re-completing (or editing the note afterwards) must not restamp the pair.
    expect(review.upsertWeeklyReview({ weekStart: MON, note: "done, plus a thought", completed: true, scoreAtCompletion: 91 }).ok).toBe(true);
    const again = review.getWeeklyReview(MON)!;
    expect(again.completedAt).toBe(first.completedAt);
    expect(again.scoreAtCompletion).toBe(62);
    expect(again.note).toBe("done, plus a thought");
  });

  it("stores NULL when the week refused to score, never 0", () => {
    selectAccount(PRIMARY);
    expect(review.upsertWeeklyReview({ weekStart: MON_NEXT, note: "thin week", completed: true, scoreAtCompletion: null }).ok).toBe(true);
    const row = review.getWeeklyReview(MON_NEXT)!;
    expect(row.completedAt).not.toBeNull();
    expect(row.scoreAtCompletion).toBeNull();
  });

  it("refuses a week that is not an ISO Monday, and an impossible score", () => {
    selectAccount(PRIMARY);
    const wed = review.upsertWeeklyReview({ weekStart: WED, note: "wrong day" });
    expect(wed.ok).toBe(false);
    expect(wed.forbidden).toBeUndefined();
    expect(review.upsertWeeklyReview({ weekStart: "2026-02-30", note: "no such day" }).ok).toBe(false);
    expect(review.upsertWeeklyReview({ weekStart: "2026-09-07", note: "x", completed: true, scoreAtCompletion: 101 }).ok).toBe(false);
    expect(review.upsertWeeklyReview({ weekStart: "2026-09-07", note: "x", completed: true, scoreAtCompletion: 62.5 }).ok).toBe(false);
    expect(t.db.select().from(t.schema.weeklyReviews).all().some((r) => r.weekStart === WED || r.weekStart === "2026-09-07")).toBe(false);
  });
});

describe("the route parses, calls and revalidates — nothing else", () => {
  let id = 0;

  beforeAll(() => {
    clearTrades();
    id = addTrade({ symbol: "ROUTED", isOpen: false, sellDate: "2026-08-25" });
    selectAccount(PRIMARY);
  });

  it("400s an unknown action and a malformed payload", async () => {
    for (const body of [{ action: "nope" }, { action: "mark-reviewed" }, { action: "mark-reviewed", id: "7" }, { action: "weekly-upsert", weekStart: "24-08-2026" }, null]) {
      expect((await route.POST(req(body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("never lets an unknown action FALL THROUGH into another action's write", async () => {
    // The discriminated union is what stops `{action:"typo"}` carrying a valid
    // weekStart from landing on the last branch of the ternary and completing
    // a week nobody asked to complete. Payload-shaped bodies alone are
    // refused twice over (the query layer refuses them too), so this is the
    // case that pins the union itself.
    t.db.delete(t.schema.weeklyReviews).run();
    const res = await route.POST(req({ action: "weekly-completed", weekStart: MON, note: "sneaked in", scoreAtCompletion: 99 }));
    expect(res.status).toBe(400);
    expect(t.db.select().from(t.schema.weeklyReviews).all()).toHaveLength(0);
  });

  it("403s the aggregate write and 400s a refusal the view understands", async () => {
    selectAccount(ALL);
    expect((await route.POST(req({ action: "mark-reviewed", id }))).status).toBe(403);
    expect((await route.POST(req({ action: "weekly-upsert", weekStart: MON, note: "x" }))).status).toBe(403);
    selectAccount(PRIMARY);
    expect((await route.POST(req({ action: "mark-reviewed", id: id + 9999 }))).status).toBe(400);
    expect((await route.POST(req({ action: "weekly-upsert", weekStart: WED, note: "x" }))).status).toBe(400);
    // An open trade is a refusal of the same shape — a 400, never a silent no-op.
    const live = addTrade({ symbol: "ROUTEDLIVE", isOpen: true, sellDate: null });
    expect((await route.POST(req({ action: "mark-reviewed", id: live }))).status).toBe(400);
    expect(reviewedAtOf(live)).toBeNull();
  });

  it("marks, completes and revalidates every surface a stamp changes", async () => {
    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();
    selectAccount(PRIMARY);

    const ok = await route.POST(req({ action: "mark-reviewed", id }));
    expect(ok.status).toBe(200);
    expect(reviewedAtOf(id)).not.toBeNull();
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(["/review", "/trades", "/reports/discipline", "/"]);

    expect((await route.POST(req({ action: "reopen", id }))).status).toBe(200);
    expect(reviewedAtOf(id)).toBeNull();

    t.db.delete(t.schema.weeklyReviews).run();
    expect((await route.POST(req({ action: "weekly-complete", weekStart: MON, note: "shipped", scoreAtCompletion: 70 }))).status).toBe(200);
    const row = review.getWeeklyReview(MON)!;
    expect(row.scoreAtCompletion).toBe(70);
    expect(row.completedAt).not.toBeNull();
  });
});
