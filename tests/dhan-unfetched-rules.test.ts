import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

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
