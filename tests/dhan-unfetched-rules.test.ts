import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
// app/audit/page.tsx's own diff helper (the Audit log renders exactly this).
import { diffFields } from "@/lib/analytics/audit-diff";

/**
 * v4.3.0 fix wave 2R (R2-PULLNOTICE) — the kept Dhan "not fetched" notice's
 * connection and clear rules, against lib/import/dhan-unfetched.ts itself.
 *
 * N4 (medium): an account merge carries the source's notice with NO connection
 * (`connId` null), and `sameConnection(null, x)` was true — so the TARGET's own
 * Dhan client, a different client by R4a, cleared or superseded a notice about
 * fills it never read. A carried span now matches no connection; only the
 * user's Clear removes it.
 *
 * N5 (low): a CLAMPED + truncated pull whose commit threw keeps range-cap
 * [L, floor1-1] and page-cap [floor1, D1-1]. The retry on a later day
 * supersedes the range-cap span with [L, floor2-1] and reads [floor2, today]
 * in full — but the page-cap span starts on floor1, before that window, so it
 * stayed listed, telling the user to import a tradebook for days the retry
 * had just imported. An untruncated committed read now clears every page-cap
 * span of its connection that lies wholly inside the window the pull accounted
 * for: the days it read, plus the days its own range-cap notice names.
 *
 * The spans are the ones lib/import/api/dhan.ts toParsedFile really keeps.
 * One temp database for the file; each case uses its own account id.
 */

let t: TempDb;
let un: typeof import("@/lib/import/dhan-unfetched");
let dhan: typeof import("@/lib/import/api/dhan");

beforeAll(async () => {
  t = await openTempDb("dhan-unfetched-rules");
  un = await import("@/lib/import/dhan-unfetched");
  dhan = await import("@/lib/import/api/dhan");
}, 30_000);

afterAll(() => t?.cleanup());

const STAMP_AT = "T05:00:00.000Z"; // 10:30 IST
/** The spans a pull on `today` keeps, the last stamp at 10:30 IST on `lastDay`. */
const spansOf = (lastDay: string, today: string, truncated: boolean) =>
  dhan.toParsedFile(
    [],
    dhan.catchUpRange(`${lastDay}${STAMP_AT}`, today),
    { pages: truncated ? 50 : 1, truncated, oldest: null, newest: null },
    `${lastDay}${STAMP_AT}`,
  ).unfetched;
const open = (accountId: number) => un.outstandingUnfetched(accountId).map((s) => [s.from, s.to, s.reason]);
const trail = (accountId: number) =>
  t.sqlite
    .prepare(
      "SELECT entity_id AS conn, action, summary, json_extract(after_json, '$.from') AS f, json_extract(after_json, '$.to') AS too FROM audit_log WHERE json_extract(after_json, '$.notice') = 'dhan-unfetched' AND json_extract(after_json, '$.accountId') = ? ORDER BY id",
    )
    .all(accountId) as { conn: number | null; action: string; summary: string; f: string; too: string }[];
const carry = (fromAccountId: number, toAccountId: number) =>
  t.db.transaction((tx) => un.carryUnfetchedOnMerge(tx, { fromAccountId, toAccountId, fromName: "X", toName: "Y", source: "ui" }));
/** The user's Clear with NO connection field, exactly as app/api/import/broker/route.ts
 *  writes it: entity_id = the account's current Dhan connection, no scope, source "ui". */
const userClear = (accountId: number, connId: number, s: { from: string; to: string; reason: string }) => {
  const snap = { notice: "dhan-unfetched", broker: "dhan", accountId, from: s.from, to: s.to, reason: s.reason };
  t.db
    .insert(t.schema.auditLog)
    .values({
      entity: "settings",
      entityId: connId,
      action: "update",
      summary: `Dhan notice cleared by the user: fills from ${s.from} to ${s.to} were not fetched by a pull.`,
      beforeJson: { ...snap, clearedAt: null },
      afterJson: { ...snap, clearedAt: new Date().toISOString() },
      source: "ui",
    })
    .run();
};

describe("N4 · a merge-carried notice (no connection) is removed by no pull — only by the user's Clear", () => {
  it("the target's own client's untruncated read, whose window covers the carried page-cap span, leaves it listed", () => {
    const [X, Y, X_CONN, Y_CONN] = [401, 402, 41, 42];
    // X's pull on 2026-09-11 (stamp 2026-09-07) stopped at the page cap: page-cap [09-07, 09-10].
    un.keepUnfetched(spansOf("2026-09-07", "2026-09-11", true), { connId: X_CONN, accountId: X, source: "import" });
    expect(carry(X, Y)).toBe(1);
    expect(trail(Y).map((r) => r.conn)).toEqual([null]);

    // Y keeps its OWN Dhan client; its untruncated read covers 2026-09-07..2026-09-11.
    un.keepUnfetchedAndStamp([], { connId: Y_CONN, accountId: Y, source: "import" }, "2026-09-11T05:00:00.000Z", {
      from: "2026-09-07",
      to: "2026-09-11",
    });
    // THE assertion ([] on revert: Y's read "cleared" fills of X's client it never read).
    expect(open(Y)).toEqual([["2026-09-07", "2026-09-10", "page-cap"]]);
    expect(trail(Y).map((r) => r.action)).toEqual(["create"]);
  });

  it("the target's own pull keeping a span with the carried span's `from` does not supersede it — both facts stay listed", () => {
    const [X, Y, X_CONN, Y_CONN] = [403, 404, 43, 44];
    // X's pull on 2026-09-10 (stamp 2026-05-13): range-cap [05-13, 06-11].
    un.keepUnfetched(spansOf("2026-05-13", "2026-09-10", false), { connId: X_CONN, accountId: X, source: "import" });
    carry(X, Y);
    // Y's own pull a day later, its stamp on the same day: range-cap [05-13, 06-12].
    un.keepUnfetched(spansOf("2026-05-13", "2026-09-11", false), { connId: Y_CONN, accountId: Y, source: "import" });
    // THE assertion (only Y's span on revert: the carried one was superseded).
    expect(open(Y)).toEqual([
      ["2026-05-13", "2026-06-11", "range-cap"],
      ["2026-05-13", "2026-06-12", "range-cap"],
    ]);
  });

  it("control: a span the SAME connection kept is still cleared by that connection's untruncated read (P11 unchanged)", () => {
    const [A, CONN] = [405, 45];
    un.keepUnfetched(spansOf("2026-09-07", "2026-09-11", true), { connId: CONN, accountId: A, source: "import" });
    expect(open(A)).toEqual([["2026-09-07", "2026-09-10", "page-cap"]]);
    un.keepUnfetchedAndStamp([], { connId: CONN, accountId: A, source: "import" }, "2026-09-11T05:00:00.000Z", {
      from: "2026-09-07",
      to: "2026-09-11",
    });
    expect(open(A)).toEqual([]);
    // Another connection of the same account never clears it either.
    un.keepUnfetched(spansOf("2026-09-07", "2026-09-11", true), { connId: CONN, accountId: A + 100, source: "import" });
    un.keepUnfetchedAndStamp([], { connId: CONN + 1, accountId: A + 100, source: "import" }, "2026-09-11T05:00:00.000Z", {
      from: "2026-09-07",
      to: "2026-09-11",
    });
    expect(open(A + 100)).toEqual([["2026-09-07", "2026-09-10", "page-cap"]]);
  });
});

/**
 * L1 (v4.3.0 fix wave 2G). The outstanding / idempotency key was the account's
 * from|to|reason, across every connection. When the merge TARGET already held a
 * span with the same from / to / reason from its OWN Dhan client (the auto-pull
 * sweep stamps every connection together), writeSpans skipped the carried span
 * as "already outstanding" (carry returned 0), and the target client's own
 * untruncated read then cleared the only row — so the source client's unread
 * fills were named nowhere. The key now includes the connection: a carried span
 * (connId null) is distinct, a pull's clear names its own connection's span,
 * and GET lists records with the same span AND the same sentences as one line
 * (wave 2H: a different sentence is a second line — see H4 below).
 */
describe("L1 · a carried notice is distinct from the target client's identical one", () => {
  it("the recheck's reproduce: the carry is written, and the target client's read clears only its own row", () => {
    const [X, Y, X_CONN, Y_CONN] = [601, 602, 61, 62];
    const spans = spansOf("2026-09-07", "2026-09-11", true);
    expect(spans.map((s) => [s.from, s.to, s.reason])).toEqual([["2026-09-07", "2026-09-10", "page-cap"]]);
    un.keepUnfetched(spans, { connId: X_CONN, accountId: X, source: "import" });
    un.keepUnfetched(spans, { connId: Y_CONN, accountId: Y, source: "import" });
    // THE assertion (0 on revert: the carried span was skipped as Y's own).
    expect(carry(X, Y)).toBe(1);
    // GET lists the book's notice once, however many connections hold it.
    expect(open(Y)).toEqual([["2026-09-07", "2026-09-10", "page-cap"]]);

    un.keepUnfetchedAndStamp([], { connId: Y_CONN, accountId: Y, source: "import" }, "2026-09-12T05:00:00.000Z", {
      from: "2026-09-07",
      to: "2026-09-12",
    });
    // THE assertion ([] on revert: Y's own client's read cleared the only notice).
    expect(open(Y)).toEqual([["2026-09-07", "2026-09-10", "page-cap"]]);
    expect(trail(Y).map((r) => [r.conn, r.action])).toEqual([
      [Y_CONN, "create"],
      [null, "create"],
      [Y_CONN, "update"],
    ]);
  });

  it("the other order: carried first, then the target's own pull keeps the same span — its read clears its own, the carried stays", () => {
    const [X, Y, X_CONN, Y_CONN] = [603, 604, 63, 64];
    const spans = spansOf("2026-09-07", "2026-09-11", true);
    un.keepUnfetched(spans, { connId: X_CONN, accountId: X, source: "import" });
    expect(carry(X, Y)).toBe(1);
    un.keepUnfetched(spans, { connId: Y_CONN, accountId: Y, source: "import" });
    // Idempotent per connection: a repeated carry, or the same pull's retry, adds nothing.
    expect(carry(X, Y)).toBe(0);
    un.keepUnfetched(spans, { connId: Y_CONN, accountId: Y, source: "import" });
    expect(trail(Y).map((r) => [r.conn, r.action])).toEqual([
      [null, "create"],
      [Y_CONN, "create"],
    ]);
    un.keepUnfetchedAndStamp([], { connId: Y_CONN, accountId: Y, source: "import" }, "2026-09-12T05:00:00.000Z", {
      from: "2026-09-07",
      to: "2026-09-12",
    });
    // THE assertion ([] on revert of the connection-scoped clear: Y's read cleared the carried span too).
    expect(open(Y)).toEqual([["2026-09-07", "2026-09-10", "page-cap"]]);
  });

  it("the user's Clear still removes the line in one click — every connection's row with that from / to / reason", () => {
    const [X, Y, X_CONN, Y_CONN] = [605, 606, 65, 66];
    const spans = spansOf("2026-09-07", "2026-09-11", true);
    un.keepUnfetched(spans, { connId: X_CONN, accountId: X, source: "import" });
    un.keepUnfetched(spans, { connId: Y_CONN, accountId: Y, source: "import" });
    expect(carry(X, Y)).toBe(1);
    // THE assertion (two identical lines on revert of GET's one-line-per-span listing).
    expect(open(Y)).toEqual([["2026-09-07", "2026-09-10", "page-cap"]]);
    userClear(Y, Y_CONN, spans[0]!);
    // THE assertion (the carried row still listed on revert: a clear naming Y's connection cleared only Y's own row).
    expect(open(Y)).toEqual([]);
  });
});

describe("N5 · a clamped page-cap span is cleared by an untruncated retry on a later day", () => {
  it("commit threw on 2026-09-10; the untruncated retry on 2026-09-11 leaves ONE notice — the range-cap span that still names 2026-06-12", () => {
    const [A, CONN] = [501, 51];
    const owner = { connId: CONN, accountId: A, source: "import" };
    // The pull on 2026-09-10 (stamp 2026-05-13): clamped at 06-12, truncated. R19 keeps both spans; the commit then throws.
    un.keepUnfetched(spansOf("2026-05-13", "2026-09-10", true), owner);
    expect(open(A)).toEqual([
      ["2026-05-13", "2026-06-11", "range-cap"],
      ["2026-06-12", "2026-09-09", "page-cap"],
    ]);
    // The retry on 2026-09-11, the stamp unmoved: range-cap [05-13, 06-12] (supersedes), the walk untruncated.
    const retry = spansOf("2026-05-13", "2026-09-11", false);
    expect(retry.map((s) => [s.from, s.to, s.reason])).toEqual([["2026-05-13", "2026-06-12", "range-cap"]]);
    un.keepUnfetched(retry, owner);
    un.keepUnfetchedAndStamp([], owner, "2026-09-11T05:00:00.000Z", { from: "2026-06-13", to: "2026-09-11" });

    // THE assertion (the stale page-cap span [06-12, 09-09] still listed on revert).
    expect(open(A)).toEqual([["2026-05-13", "2026-06-12", "range-cap"]]);
    // The clear row says which days were read and which notice still names the rest.
    const clear = trail(A).find((r) => r.action === "update" && r.f === "2026-06-12");
    expect(clear?.summary).toBe(
      "Dhan notice cleared by a later pull that read Dhan's trade history from 2026-06-13 to 2026-09-11 in full: fills from 2026-06-13 to 2026-09-09 were read; fills from 2026-06-12 to 2026-06-12 are named by the notice for fills from 2026-05-13 to 2026-06-12.",
    );
  });

  it("the same, on the nothing-new path: the retry's range-cap span and the clear land in ONE call", () => {
    const [A, CONN] = [502, 52];
    const owner = { connId: CONN, accountId: A, source: "auto-pull" };
    un.keepUnfetched(spansOf("2026-05-13", "2026-09-10", true), owner);
    un.keepUnfetchedAndStamp(spansOf("2026-05-13", "2026-09-12", false), owner, "2026-09-12T05:00:00.000Z", {
      from: "2026-06-14",
      to: "2026-09-12",
    });
    // THE assertion (the page-cap span [06-12, 09-09] still listed on revert).
    expect(open(A)).toEqual([["2026-05-13", "2026-06-13", "range-cap"]]);
  });

  it("not cleared: a page-cap span BEFORE the read with no notice of this pull naming those days (a committed truncated pull, stamp moved)", () => {
    const [A, CONN] = [503, 53];
    const owner = { connId: CONN, accountId: A, source: "import" };
    // The truncated pull on 2026-09-10 committed: stamp moved to 2026-09-10, page-cap [06-12, 09-09] kept.
    un.keepUnfetched(spansOf("2026-05-13", "2026-09-10", true), owner);
    // The next day's untruncated read covers only 2026-09-10..2026-09-11 and keeps no span.
    un.keepUnfetchedAndStamp(spansOf("2026-09-10", "2026-09-11", false), owner, "2026-09-11T05:00:00.000Z", {
      from: "2026-09-10",
      to: "2026-09-11",
    });
    expect(open(A)).toEqual([
      ["2026-05-13", "2026-06-11", "range-cap"],
      ["2026-06-12", "2026-09-09", "page-cap"],
    ]);
  });

  it("not cleared: the span's first day before the read is named only by ANOTHER connection's notice", () => {
    const [A, CONN] = [504, 54];
    const owner = { connId: CONN, accountId: A, source: "import" };
    un.keepUnfetched(spansOf("2026-05-13", "2026-09-10", true), owner);
    // A range-cap notice that ends the day before the read, but a DIFFERENT connection's.
    un.keepUnfetched(spansOf("2026-05-13", "2026-09-11", false), { ...owner, connId: CONN + 1 });
    un.keepUnfetchedAndStamp([], owner, "2026-09-11T05:00:00.000Z", { from: "2026-06-13", to: "2026-09-11" });
    expect(open(A).filter((s) => s[2] === "page-cap")).toEqual([["2026-06-12", "2026-09-09", "page-cap"]]);
  });
});

/**
 * v4.3.0 fix wave 2H (H4) — kept pull notices at the card, per RECORD.
 *
 * GET listed one line per from / to / reason with the FIRST record's fact, and
 * the user's Clear (no connection) removed every connection's record with that
 * span. A merge-carried record can share the span with the target client's own
 * record but state a different fact — the source client's last pull ran at
 * another time of day — so the second client's unread fills were dismissed
 * unseen. Now: one line per record (same span AND same sentences share a line),
 * each with its connection; a Clear naming a connection clears exactly that
 * record's line; a Clear with no connection field keeps clearing every
 * same-span record. And a clear row's audit diff shows `clearedAt` only.
 */
describe("H4 · one card line per kept record, and a Clear that names its record", () => {
  const SPAN = { from: "2026-05-13", to: "2026-06-12", reason: "range-cap" };
  /** The range-cap span a pull on 2026-09-11 keeps, its last stamp at `stamp`. */
  const rangeCapAt = (stamp: string) =>
    dhan.toParsedFile([], dhan.catchUpRange(stamp, "2026-09-11"), { pages: 1, truncated: false, oldest: null, newest: null }, stamp).unfetched;
  /** "after HH:MM IST" — the part of the fact that differs between the two clients. */
  const hhmm = (fact: string) => /after (\d\d:\d\d) IST/.exec(fact)?.[1] ?? fact;
  const lines = (A: number) => un.outstandingUnfetchedLines(A).map((s) => [s.connection, s.from, s.to, s.reason, hhmm(s.fact)]);
  const records = (A: number) => un.outstandingUnfetchedRecords(A).map((s) => [s.connection, hhmm(s.fact)]);
  const USER = "Dhan notice cleared by the user.";

  /** The re-check's reproduce: Y's own client (62) stamped 10:30 IST, X's client (61)
   *  stamped 14:30 IST the same day, X's record carried into Y by a merge. */
  function stageTwoFacts(X: number, Y: number) {
    un.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: 62, accountId: Y, source: "import" });
    un.keepUnfetched(rangeCapAt("2026-05-13T09:00:00.000Z"), { connId: 61, accountId: X, source: "import" });
    expect(carry(X, Y)).toBe(1);
    expect(records(Y)).toEqual([
      [62, "10:30"],
      [null, "14:30"],
    ]);
  }

  it("GET lists BOTH records, each line with its own connection and its own stored fact", () => {
    const [X, Y] = [701, 702];
    stageTwoFacts(X, Y);
    // THE assertion (one line, 62's "10:30", on revert of the per-record listing).
    expect(lines(Y)).toEqual([
      [62, ...Object.values(SPAN), "10:30"],
      [null, ...Object.values(SPAN), "14:30"],
    ]);
    // GET's `unfetched` keeps its shape (no connection key) — the connection rides beside it.
    expect(un.outstandingUnfetched(Y).map((s) => Object.keys(s).sort())).toEqual([
      ["fact", "from", "reason", "remedy", "to"],
      ["fact", "from", "reason", "remedy", "to"],
    ]);
  });

  it("a Clear naming connection 62 clears 62's record only — the carried record stays outstanding", () => {
    const [X, Y] = [703, 704];
    stageTwoFacts(X, Y);
    expect(un.clearUnfetchedLine(Y, { ...SPAN, connection: 62 }, USER)).toBe(1);
    // THE assertion ([] on revert: the named Clear cleared every same-span record).
    expect(records(Y)).toEqual([[null, "14:30"]]);
  });

  it("a Clear naming null clears only the carried record; a record no longer open clears nothing", () => {
    const [X, Y] = [705, 706];
    stageTwoFacts(X, Y);
    expect(un.clearUnfetchedLine(Y, { ...SPAN, connection: null }, USER)).toBe(1);
    // THE assertion ([] on revert: the null Clear cleared 62's record too).
    expect(records(Y)).toEqual([[62, "10:30"]]);
    expect(un.clearUnfetchedLine(Y, { ...SPAN, connection: null }, USER)).toBe(0);
    expect(un.clearUnfetchedLine(Y, { ...SPAN, connection: 61 }, USER)).toBe(0);
    expect(records(Y)).toEqual([[62, "10:30"]]);
  });

  it("a Clear with NO connection field (the route's legacy row) still clears both records", () => {
    const [X, Y] = [707, 708];
    stageTwoFacts(X, Y);
    userClear(Y, 62, SPAN);
    expect(records(Y)).toEqual([]);
  });

  it("the same span with the SAME fact is one line, and a Clear naming either record clears both", () => {
    const [X, Y] = [709, 710];
    un.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: 72, accountId: Y, source: "import" });
    un.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: 71, accountId: X, source: "import" });
    expect(carry(X, Y)).toBe(1);
    expect(records(Y)).toEqual([
      [72, "10:30"],
      [null, "10:30"],
    ]);
    // THE assertion (two identical lines on revert of the same-sentence grouping).
    expect(lines(Y)).toEqual([[72, ...Object.values(SPAN), "10:30"]]);
    expect(un.clearUnfetchedLine(Y, { ...SPAN, connection: 72 }, USER)).toBe(2);
    // THE assertion (the carried record still listed on revert: the Clear left the line's other record).
    expect(records(Y)).toEqual([]);
  });

  it("the audit diff of a clear row — a pull's and the named user Clear's — shows clearedAt only", () => {
    const [A, CONN] = [711, 70];
    const updates = () =>
      (
        t.sqlite
          .prepare(
            "SELECT source, before_json AS b, after_json AS a FROM audit_log WHERE action = 'update' AND json_extract(after_json, '$.notice') = 'dhan-unfetched' AND json_extract(after_json, '$.accountId') = ? ORDER BY id",
          )
          .all(A) as { source: string; b: string; a: string }[]
      ).map((r) => ({ source: r.source, diff: diffFields(JSON.parse(r.b), JSON.parse(r.a)).map((c) => [c.field, c.from, typeof c.to]) }));
    // A pull clear: the re-check's reproduce (a truncated pull's page-cap span, then an untruncated read).
    un.keepUnfetched(spansOf("2026-09-07", "2026-09-11", true), { connId: CONN, accountId: A, source: "import" });
    un.keepUnfetchedAndStamp([], { connId: CONN, accountId: A, source: "import" }, "2026-09-12T05:00:00.000Z", { from: "2026-09-07", to: "2026-09-12" });
    // A named user Clear.
    un.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: CONN, accountId: A, source: "import" });
    expect(un.clearUnfetchedLine(A, { ...SPAN, connection: CONN }, USER)).toBe(1);
    // THE assertion (a second ["scope", null, "string"] entry on revert: scope sat in afterJson only).
    expect(updates()).toEqual([
      { source: "import", diff: [["clearedAt", null, "string"]] },
      { source: "ui", diff: [["clearedAt", null, "string"]] },
    ]);
    expect(open(A)).toEqual([]);
  });

  /**
   * S3 (v4.3.0 fix wave 2H seam, low). A shared line (the same span and sentences)
   * carries the target client's connection. The target's own untruncated pull
   * (or lib/jobs/auto-pull.ts) clears THAT record while the card is open; the
   * card's Clear still names it. It answered 0 (the route's 404 "not open") while
   * the carried record stating the identical sentence stayed listed. The Clear
   * now targets the LINE the card showed: the named record when it is open, else
   * the open records with the same span and the same stored sentences.
   */
  it("S3 · a card loaded before a pull cleared its line's named record: the Clear clears the line's other record, and nothing else", () => {
    const [X, Y, X_CONN, Y_CONN, Y_OTHER] = [721, 722, 81, 82, 83];
    /** The page-cap span a truncated pull on 2026-09-11 keeps, its last stamp at `stamp` (the fact names HH:MM IST). */
    const pageCapAt = (stamp: string) =>
      dhan.toParsedFile([], dhan.catchUpRange(stamp, "2026-09-11"), { pages: 50, truncated: true, oldest: null, newest: null }, stamp).unfetched;
    const PAGE = { from: "2026-09-07", to: "2026-09-10", reason: "page-cap" };
    // The fixD-style merge: target and source clients stamped 10:30 IST the same day — one sentence.
    un.keepUnfetched(pageCapAt("2026-09-07T05:00:00.000Z"), { connId: Y_CONN, accountId: Y, source: "import" });
    un.keepUnfetched(pageCapAt("2026-09-07T05:00:00.000Z"), { connId: X_CONN, accountId: X, source: "import" });
    expect(carry(X, Y)).toBe(1);
    // Another connection of Y states a different fact on the same span (14:30 IST) — H4: its own line.
    un.keepUnfetched(pageCapAt("2026-09-07T09:00:00.000Z"), { connId: Y_OTHER, accountId: Y, source: "import" });
    const card = un.outstandingUnfetchedLines(Y);
    expect(card.map((s) => [s.connection, s.from, s.to, s.reason, hhmm(s.fact)])).toEqual([
      [Y_CONN, ...Object.values(PAGE), "10:30"],
      [Y_OTHER, ...Object.values(PAGE), "14:30"],
    ]);

    // While the card is open, the target's own untruncated read clears its record (P11).
    un.keepUnfetchedAndStamp([], { connId: Y_CONN, accountId: Y, source: "import" }, "2026-09-12T05:00:00.000Z", { from: "2026-09-07", to: "2026-09-12" });
    expect(records(Y)).toEqual([
      [null, "10:30"],
      [Y_OTHER, "14:30"],
    ]);

    // The card's Clear of the line it showed, naming the connection it carried.
    // THE assertion (0 on revert — the route's 404 "not open" — the carried 10:30 record still listed).
    expect(un.clearUnfetchedLine(Y, { ...PAGE, connection: card[0]!.connection }, USER)).toBe(1);
    expect(records(Y)).toEqual([[Y_OTHER, "14:30"]]);
    // The line is gone: the same Clear again finds no open record stating it, and the other fact is untouched.
    expect(un.clearUnfetchedLine(Y, { ...PAGE, connection: Y_CONN }, USER)).toBe(0);
    expect(records(Y)).toEqual([[Y_OTHER, "14:30"]]);
    expect(trail(Y).map((r) => [r.conn, r.action])).toEqual([
      [Y_CONN, "create"],
      [null, "create"],
      [Y_OTHER, "create"],
      [Y_CONN, "update"],
      [null, "update"],
    ]);
  });
});
