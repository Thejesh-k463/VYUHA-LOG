import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 fix wave 2J (J1) — the NAMED Clear carries the sentence the card
 * showed, through the REAL card composer and the REAL route.
 *
 * I5 (wave 2I) gave a merge-carried record its own identity — it names no
 * connection, so it is told apart from another book's carry of the same span
 * ONLY by the sentences it states — and taught `clearUnfetchedLine` to take an
 * optional `fact` / `remedy`. Neither the card nor the route sent them: two
 * carried lines on one span produced byte-identical Clear bodies
 * (`connection: null`, the same from/to/reason), so whichever record came
 * first was cleared whichever line the user clicked, and the line they DID
 * clear stayed on screen.
 *
 * Here the halves run together: `bc.clearUnfetchedBody` builds the body from a
 * GET row, it is JSON round-tripped exactly as `fetch` would send it, and the
 * route's POST answers. The store is staged through the same writers the app
 * uses — `keepUnfetched` for each source book's pull, `carryUnfetchedOnMerge`
 * for the merge — never by hand-written audit rows.
 *
 * ONE temp database for the FILE (lib/db caches its connection); every case
 * owns its account ids. No clock is frozen: every date here is a literal, and
 * the spans are the ones lib/import/api/dhan.ts really keeps.
 *
 * Timing (measured locally 2026-09-15): the `beforeAll` is 2.3 s — the temp
 * database's migrations and the route's first call — hence its 30 s timeout,
 * the same one every temp-database file here carries. Each `it` is 4-16 ms.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let route: typeof import("@/app/api/import/broker/route");
let bc: typeof import("@/components/import/broker-connect");
let un: typeof import("@/lib/import/dhan-unfetched");
let dhan: typeof import("@/lib/import/api/dhan");

const S1 = 771;
const S2 = 772;
const T = 773;
const S3 = 774;
const T2 = 775;
const S4 = 776;
const S5 = 777;
const T3 = 778;

beforeAll(async () => {
  t = await openTempDb("pull-clear-route", { seed: true });
  route = await import("@/app/api/import/broker/route");
  bc = await import("@/components/import/broker-connect");
  un = await import("@/lib/import/dhan-unfetched");
  dhan = await import("@/lib/import/api/dhan");
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: S1, name: "J1 source A", isDefault: false },
      { id: S2, name: "J1 source B", isDefault: false },
      { id: T, name: "J1 target", isDefault: false },
      { id: S3, name: "J1 legacy source", isDefault: false },
      { id: T2, name: "J1 legacy target", isDefault: false },
      { id: S4, name: "J1 stale source A", isDefault: false },
      { id: S5, name: "J1 stale source B", isDefault: false },
      { id: T3, name: "J1 stale target", isDefault: false },
    ])
    .run();
  // The All-accounts view, so GET lists every target's Dhan row (invariant 8);
  // every POST below names its account id explicitly (invariant 9 — 0 is a
  // view, and getWriteAccountId validates the id it is given).
  t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
  // The route's first call does the vault sweep and compiles its queries
  // (~1 s locally, measured 2026-09-15). That belongs in the HOOK, not in an
  // `it`: the Windows CI budget is <= 300 ms per test and <= 3 s per hook.
  await route.GET();
}, 30_000);

afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});

/** A live JWT, so GET reads the row the way it reads a saved connection. */
const alive = () =>
  ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");

/** The target's own Dhan client — the row GET lists the kept notices under. */
const addDhan = (accountId: number) =>
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
    .run(accountId, "1000000009", alive());

/** The range-cap span a pull on 2026-09-11 keeps when the last stamp was `stamp`. */
const rangeCapAt = (stamp: string) =>
  dhan.toParsedFile([], dhan.catchUpRange(stamp, "2026-09-11"), { pages: 1, truncated: false, oldest: null, newest: null }, stamp).unfetched;

const carry = (fromAccountId: number, toAccountId: number, fromName: string) =>
  t.db.transaction((tx) => un.carryUnfetchedOnMerge(tx, { fromAccountId, toAccountId, fromName, toName: "J1 target", source: "ui" }));

type Line = import("@/components/import/broker-connect").UnfetchedSpan;
type CardRow = { broker: string; accountId: number; unfetched?: Line[]; unfetchedConnection?: (number | null)[] };

/** GET's Dhan row for the account, as the card receives it over the wire. */
async function cardRow(accountId: number): Promise<CardRow> {
  const body = (await (await route.GET()).json()) as { connections?: CardRow[] };
  const r = (body.connections ?? []).find((c) => c.broker === "dhan" && c.accountId === accountId);
  if (!r) throw new Error(`GET lists no Dhan connection for account ${accountId}`);
  return r;
}

/** POST, with the body JSON round-tripped exactly as fetch would send it. */
const post = (body: Record<string, unknown>) =>
  route.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );

const wire = (body: Record<string, unknown>) => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

const hhmm = (s: { fact: string }) => /after (\d\d:\d\d) IST/.exec(s.fact)?.[1] ?? s.fact;
/** Every stored record for the account, with its connection — the store, not the card. */
const records = (accountId: number) => un.outstandingUnfetchedRecords(accountId).map((r) => [r.connection, hhmm(r)]);
const auditRows = (accountId: number) =>
  (
    t.sqlite
      .prepare(
        "SELECT action, entity_id AS conn FROM audit_log WHERE json_extract(after_json, '$.notice') = 'dhan-unfetched' AND json_extract(after_json, '$.accountId') = ? ORDER BY id",
      )
      .all(accountId) as { action: string; conn: number | null }[]
  ).map((r) => [r.conn, r.action]);

/** Two books, each with its own last-pull time of day, merged into one target. */
function stageTwoCarries(a: number, b: number, target: number) {
  un.keepUnfetched(rangeCapAt("2026-05-13T09:00:00.000Z"), { connId: 81, accountId: a, source: "import" }); // 14:30 IST
  un.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: 82, accountId: b, source: "import" }); // 10:30 IST
  expect(carry(a, target, "book A")).toBe(1);
  expect(carry(b, target, "book B")).toBe(1);
  addDhan(target);
}

describe("J1 · the card's Clear of a merge-carried line names the sentence it shows (card → route → store)", () => {
  it("clearing the second carried line clears THAT record; GET still lists the first", async () => {
    stageTwoCarries(S1, S2, T);
    const row = await cardRow(T);
    const lines = bc.unfetchedLines(row);
    expect(lines.map((s) => [s.connection, hhmm(s)])).toEqual([
      [null, "14:30"],
      [null, "10:30"],
    ]);

    const res = await post(wire(bc.clearUnfetchedBody(row, lines[1]!)));
    expect(res.status).toBe(200);
    // THE assertion (on revert of the card's fact or of the route's forwarding:
    // [[null, "10:30"]] — the line the user clicked stays listed and the other
    // book's gap is dismissed in its place).
    expect(records(T)).toEqual([[null, "14:30"]]);
    expect(bc.unfetchedLines(await cardRow(T)).map((s) => hhmm(s))).toEqual(["14:30"]);

    // The first line's own Clear then clears the rest; every record is append-only.
    expect((await post(wire(bc.clearUnfetchedBody(row, lines[0]!)))).status).toBe(200);
    expect(records(T)).toEqual([]);
    expect(auditRows(T)).toEqual([
      [null, "create"],
      [null, "create"],
      [null, "update"],
      [null, "update"],
    ]);
  });

  it("a Clear naming a sentence no record holds changes nothing — 404, both lines still listed", async () => {
    stageTwoCarries(S4, S5, T3);
    const row = await cardRow(T3);
    const lines = bc.unfetchedLines(row);
    const body = { ...wire(bc.clearUnfetchedBody(row, lines[0]!)), fact: "Fills nobody ever kept." };

    const res = await post(body);
    // THE assertion (200 on revert: the route ignored the sentence and cleared
    // the span's first carried record).
    expect(res.status).toBe(404);
    expect((await res.json()).message).toContain("not open for this account");
    expect(records(T3)).toEqual([
      [null, "14:30"],
      [null, "10:30"],
    ]);
  });

  it("a body with NO fact (a card from before this wave) still clears the carried line — today's behaviour, byte for byte", async () => {
    un.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: 83, accountId: S3, source: "import" });
    expect(carry(S3, T2, "legacy book")).toBe(1);
    addDhan(T2);
    const row = await cardRow(T2);
    const [line] = bc.unfetchedLines(row);
    const { fact: _f, remedy: _r, ...legacy } = wire(bc.clearUnfetchedBody(row, line!));
    void _f;
    void _r;
    expect(Object.keys(legacy).sort()).toEqual(["accountId", "action", "broker", "connection", "from", "reason", "to"]);

    const res = await post(legacy);
    expect(res.status).toBe(200);
    expect(records(T2)).toEqual([]);
  });
});
