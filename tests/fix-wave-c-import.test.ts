import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 FIX WAVE C — C-5 and C-6, both halves at once.
 *
 * C-5: the commit's own sentences (`result.warnings`, lib/import/commit.ts)
 * reached the response and no client read them. Here the REAL broker route and
 * the REAL file route answer, and their JSON goes straight into the REAL client
 * composers (`pullResultMessage`, `commitResultNotes`) — the seam the defect
 * lived on. Auto-close is SWITCHED OFF for 4.3.0 (owner ruling 2026-09-11,
 * 06-ANSWERS "v4.3.0 release-level-audit rulings", row 1): a SELL of a held
 * lot is written as its own row, as in v4.2.0, and no screen states a close
 * plan or a close. The C-5 cases below pin exactly that.
 *
 * C-6 (owner ruling "Say it plainly"): a Dhan gap over DHAN_MAX_PULL_RANGE_DAYS
 * was clamped with no word, lastPullAt moved to now and the older fills were
 * never fetched. The pull now names the dates and the remedy; a COMMIT keeps
 * the span in the append-only audit trail (no migration — 4.3.0 ships only
 * 0071); the card lists it until the user clears it; the scheduled auto-pull
 * records it through the same store.
 *
 * The only stub is `globalThis.fetch` (the network). ONE temp database for the
 * file (lib/db caches its connection), so every scenario owns its account id.
 * Dates are derived HERE from the clock, never by the module under test — a
 * check that asks catchUpRange what catchUpRange should return agrees with
 * itself. The clock is FROZEN per test at NOW (Date only; timers stay real),
 * so a run that straddles IST midnight can no longer put this file's dates and
 * the route's `today` on two different days.
 *
 * v4.3.0 FIX WAVE 1 adds, through the same real routes: R42 (a catch-up does
 * not restate the purchase the last pull's snapshot stored, and the stamp is
 * the pre-read instant), R19 (a notice that cannot be saved stops the pull
 * before it commits), R27 (nothing new still moves the stamp) and R10 (a merge
 * carries the kept notice to the target).
 *
 * v4.3.0 FIX WAVE 2 adds R43 (a same-day re-pull replaces today's earlier
 * snapshot in place when the match is unambiguous, and asks when it is not)
 * and R42b (a SELL of a held lot is not a cross-source duplicate of it).
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let brokerRoute: typeof import("@/app/api/import/broker/route");
let fileRoute: typeof import("@/app/api/import/route");
let job: typeof import("@/lib/jobs/auto-pull");
let bc: typeof import("@/components/import/broker-connect");
let ic: typeof import("@/components/import/import-client");

const C5_PULL = 41;
const C5_FILE = 42;
const C6_ROUTE = 43;
const C6_AUTO = 44;
const C5_AUTO = 45;
const R42_ACC = 46;
const R19_ACC = 47;
const R27_ROUTE = 48;
const R27_AUTO = 49;
const R10_X = 50;
const R10_Y = 51;
const R19_AUTO = 52;
const R42_AUTO = 53;
const R43_ROUTE = 54;
const R43_AUTO = 55;
const R43_PAIR = 56;
const R42B_ROUTE = 57;
const R42B_AUTO = 58;
const R43_ANGEL = 59;
const P11_RANGE = 60;
const P11_PAGE = 61;
const P11_PAGE_NN = 62;
const P11_AUTO_C = 63;
const P11_AUTO_N = 64;
const P15_LEGACY = 65;
const CLIENT = "1000000009";
const ENROLLED = { pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP", totpAckVersion: 1 };
const ROOT = path.resolve(__dirname, "..");

beforeAll(async () => {
  t = await openTempDb("fix-wave-c-import", { seed: true });
  brokerRoute = await import("@/app/api/import/broker/route");
  fileRoute = await import("@/app/api/import/route");
  job = await import("@/lib/jobs/auto-pull");
  bc = await import("@/components/import/broker-connect");
  ic = await import("@/components/import/import-client");
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: C5_PULL, name: "C5 pull", isDefault: false },
      { id: C5_FILE, name: "C5 file", isDefault: false },
      { id: C6_ROUTE, name: "C6 route", isDefault: false },
      { id: C6_AUTO, name: "C6 auto", isDefault: false },
      { id: C5_AUTO, name: "C5 auto", isDefault: false },
      { id: R42_ACC, name: "R42", isDefault: false },
      { id: R19_ACC, name: "R19", isDefault: false },
      { id: R27_ROUTE, name: "R27 route", isDefault: false },
      { id: R27_AUTO, name: "R27 auto", isDefault: false },
      { id: R10_X, name: "R10 X", isDefault: false },
      { id: R10_Y, name: "R10 Y", isDefault: false },
      { id: R19_AUTO, name: "R19 auto", isDefault: false },
      { id: R42_AUTO, name: "R42 auto", isDefault: false },
      { id: R43_ROUTE, name: "R43 route", isDefault: false },
      { id: R43_AUTO, name: "R43 auto", isDefault: false },
      { id: R43_PAIR, name: "R43 pair", isDefault: false },
      { id: R42B_ROUTE, name: "R42b route", isDefault: false },
      { id: R42B_AUTO, name: "R42b auto", isDefault: false },
      { id: R43_ANGEL, name: "R43 angel", isDefault: false },
      { id: P11_RANGE, name: "P11 range", isDefault: false },
      { id: P11_PAGE, name: "P11 page", isDefault: false },
      { id: P11_PAGE_NN, name: "P11 page nothing new", isDefault: false },
      { id: P11_AUTO_C, name: "P11 auto commit", isDefault: false },
      { id: P11_AUTO_N, name: "P11 auto nothing new", isDefault: false },
      { id: P15_LEGACY, name: "P15 legacy", isDefault: false },
    ])
    .run();
});
afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});
/** 23:59:59 IST on 10 Sep — one second before IST midnight, the worst instant
 *  for the old real-clock derivation. Frozen per test, restored after it. */
const NOW = new Date("2026-09-10T18:29:59.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── dates, from the frozen clock (IST = UTC + 5:30) ──────────────────────────
const DAY = 86_400_000;
/** The IST calendar day `offset` days from now. */
const istDay = (offset = 0) => new Date(Date.now() + 5.5 * 3_600_000 + offset * DAY).toISOString().slice(0, 10);
/** 10:30 IST on that day — safely inside it in both zones. */
const stampOn = (offset: number) => `${istDay(offset)}T05:00:00.000Z`;

const alive = () =>
  ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** A Dhan row as the save route would leave it (plaintext reads through readSecret — the compatibility path). */
function addDhan(accountId: number, lastPullAt: string | null, authJson: Record<string, unknown> | null = null) {
  t.sqlite
    .prepare(
      "INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, ?, ?)",
    )
    .run(accountId, CLIENT, alive(), authJson ? JSON.stringify(authJson) : null, lastPullAt);
}

interface Fill {
  id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  at: string;
}

/** api.dhan.co: page 0 of the history answers `fills`, every other page answers [].
 *  /v2/positions answers `book.positions` (default []); with `book.advanceMs` it
 *  moves the frozen clock on while it answers, so a stamp taken AFTER the read
 *  differs from one taken before it (R42). `onlyAfterHistory` (a path prefix)
 *  limits that to the /positions read that follows THAT history walk — one
 *  connection's pull in a sweep that also pulls others. `everyPage` (P11)
 *  answers `fills` on EVERY history page, so the walk stops at the 50-page cap. */
function stubDhan(
  fills: Fill[],
  book: { positions?: Record<string, unknown>[]; advanceMs?: number; onlyAfterHistory?: string; everyPage?: boolean } = {},
): string[] {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    const prev = paths[paths.length - 1] ?? "";
    paths.push(u.pathname);
    if (u.pathname === "/v2/positions") {
      if (book.advanceMs && (!book.onlyAfterHistory || prev.startsWith(book.onlyAfterHistory))) {
        vi.setSystemTime(Date.now() + book.advanceMs);
      }
      return new Response(JSON.stringify(book.positions ?? []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body =
      u.host === "auth.dhan.co"
        ? { accessToken: alive() }
        : (book.everyPage ? /^\/v2\/trades\// : /^\/v2\/trades\/[\d-]+\/[\d-]+\/0$/).test(u.pathname)
          ? fills.map((f) => ({
              exchangeTradeId: f.id,
              orderId: `O-${f.id}`,
              transactionType: f.side,
              exchangeSegment: "NSE_EQ",
              productType: "CNC",
              tradingSymbol: "TCS",
              tradedQuantity: f.qty,
              tradedPrice: f.price,
              exchangeTime: f.at,
            }))
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return paths;
}

function post(body: unknown): Promise<Response> {
  return brokerRoute.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

interface ConnLite {
  broker: string;
  accountId: number;
  lastPullAt: string | null;
  unfetched?: { from: string; to: string; reason: string; fact: string; remedy: string | null }[];
  catchUpFrom?: string | null;
}

/**
 * P15 / P16 (fix wave 2): GET lists a kept span WITH the pull's own sentences.
 * The range-cap span a pull keeps when the last stamp was 10:30 IST on day -120
 * — the words of lib/import/api/dhan.ts toParsedFile, typed out here from the
 * clock, never asked of it.
 */
const RANGE_CAP_120 = () => ({
  from: istDay(-120),
  to: istDay(-91),
  reason: "range-cap",
  // RANGE-CAP COPY (wave 2F, as N6): the kept fact names the pull by its IST day. Before: "so this one started at ${istDay(-90)}".
  // L2 (wave 2G): re-pinned. Before: "The last pull ran on <day>"; after: "The pull before it ran on <day>" — the kept line sat under the card's newer "last pull" stamp and contradicted it.
  fact: `Not fetched: fills from ${istDay(-120)} to ${istDay(-91)}. The pull before it ran on ${istDay(-120)}, and a pull reads at most 90 days of Dhan's trade history, so the pull on ${istDay(0)} started at ${istDay(-90)}. Fills on ${istDay(-120)} after 10:30 IST were not fetched; a tradebook for ${istDay(-120)} would repeat the fills already imported from it.`,
  remedy: `To bring the rest in, import a Dhan tradebook for ${istDay(-119)} to ${istDay(-91)}.`,
});

/** The connection row exactly as the card receives it — through GET. */
async function connOf(accountId: number): Promise<ConnLite> {
  selectAccount(accountId);
  const json = (await (await brokerRoute.GET()).json()) as { connections: ConnLite[] };
  const c = json.connections.find((x) => x.broker === "dhan" && x.accountId === accountId);
  expect(c, `no Dhan connection listed for account ${accountId}`).toBeDefined();
  return c!;
}

const rowsOf = (accountId: number) =>
  t.sqlite.prepare("SELECT id, is_open, buy_qty, sell_qty FROM trades WHERE account_id = ?").all(accountId) as {
    id: number;
    is_open: number;
    buy_qty: number;
    sell_qty: number;
  }[];

// ===========================================================================
// C-5 · broker pull
// ===========================================================================

describe("C-5 · a Dhan pull whose SELL meets a held lot says what v4.2.0 said — preview AND commit (auto-close off)", () => {
  it("opens the lot (pull #1 commits a BUY)", async () => {
    addDhan(C5_PULL, stampOn(-4));
    stubDhan([{ id: "C5-B", side: "BUY", qty: 100, price: 100, at: `${istDay(-3)} 09:30:00` }]);
    const res = await post({ action: "pull", broker: "dhan", accountId: C5_PULL, mode: "commit" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { added: number } }).result.added).toBe(1);
    expect(rowsOf(C5_PULL).map((r) => r.is_open)).toEqual([1]);
    // Put the stamp back before the sell, so the next pull reaches it.
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(stampOn(-4), C5_PULL);
  });

  it("Preview pull: the response carries no close plan, and the card prints v4.2.0's line", async () => {
    stubDhan([{ id: "C5-S", side: "SELL", qty: 100, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const res = await post({ action: "pull", broker: "dhan", accountId: C5_PULL, mode: "preview" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect("autoClose" in json.preview, "the server sends no plan").toBe(false);

    // v4.2.0's own expression (broker-connect.tsx at v4.2.0), not the composer's.
    const warn = ((json.warnings ?? []) as string[]).join(" ");
    expect(bc.pullResultMessage("preview", json)).toBe(`Preview: 1 normalized trade. ${warn}`.trim());
    // A preview writes nothing.
    expect(rowsOf(C5_PULL).map((r) => r.is_open)).toEqual([1]);
  });

  it("Pull & commit: the SELL is added as its own row, and no sentence claims a close", async () => {
    stubDhan([{ id: "C5-S", side: "SELL", qty: 100, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const res = await post({ action: "pull", broker: "dhan", accountId: C5_PULL, mode: "commit" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.added).toBe(1);
    expect((json.result.warnings as string[]).some((w) => /closed by this/.test(w))).toBe(false);

    const text = bc.pullResultMessage("commit", json);
    expect(text.startsWith("Committed — 1 added, 0 duplicates skipped.")).toBe(true);
    expect(text).not.toMatch(/closed by this/);
    // …and it is true: the held lot is still open, and the sale is a second open row.
    expect(rowsOf(C5_PULL).map((r) => r.is_open)).toEqual([1, 1]);
  });
});

// ===========================================================================
// C-5 · file import
// ===========================================================================

const GTR_HEAD = [
  "Global transction report,From 01-07-2026 to 29-07-2026",
  "Name,TESTUSER",
  "UCC,TEST0001A",
  "Mobile,9000000000",
  "Email ID,testuser@example.com",
  "",
  "Date,Scrip Name,Exchange,Bill No.,Buy Qty.,Buy Value,Sell Qty.,Sell Value,Brokerage,GST,STT,SEBI Fees,Stamp Duty,Txn. Charges,Oth. Charges,Gross Amount",
];
const gtr = (row: string) => `${[...GTR_HEAD, row].join("\n")}\n`;
const BUY_ROW = '"01 Jul 2026 00:00:00","Test Scrip 91","NSE","7000001","10","1000.00","0","0.00","0.00","0.00","1.00","0.00","0.00","0.00","0.00","-1001.00"';
const SELL_ROW = '"02 Jul 2026 00:00:00","Test Scrip 91","NSE","7000002","0","0.00","10","1200.00","0.00","0.00","1.00","0.00","0.00","0.00","0.00","1199.00"';

function postFile(csv: string, mode: "preview" | "commit"): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([csv], "Dhan_GlobalTransction_Report.csv", { type: "text/csv" }));
  fd.append("mode", mode);
  fd.append("accountId", String(C5_FILE));
  return fileRoute.POST(new Request("http://local/api/import", { method: "POST", body: fd }));
}

describe("C-5 · a file whose SELL meets a held lot: no plan, no close, the sale lands (auto-close off)", () => {
  it("the file route answers with no close plan, and the commit card's lines claim no close", async () => {
    selectAccount(C5_FILE);
    const opened = await postFile(gtr(BUY_ROW), "commit");
    expect(opened.status).toBe(200);
    expect(rowsOf(C5_FILE).map((r) => r.is_open)).toEqual([1]);

    const pre = await postFile(gtr(SELL_ROW), "preview");
    expect(pre.status).toBe(200);
    const pj = await pre.json();
    expect("autoClose" in pj.preview, "the server sends no plan").toBe(false);

    const res = await postFile(gtr(SELL_ROW), "commit");
    expect(res.status).toBe(200);
    const json = await res.json();
    const lines = ic.commitResultNotes(json.result);
    expect(lines.some((w) => /closed by this/.test(w))).toBe(false);
    // The held lot stays open, and the unpaired sale is its own open row.
    expect(rowsOf(C5_FILE).map((r) => r.is_open)).toEqual([1, 1]);
  });

  it("the commit card renders commitResultNotes, and the file preview renders no close plan", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/import/import-client.tsx"), "utf8").replace(/\r\n/g, "\n");
    const card = src.slice(src.indexOf("{committed && ("), src.indexOf("View trades →"));
    expect(card).toContain('data-testid="commit-warnings"');
    expect(card).toContain("commitResultNotes(committed)");
    expect(src).not.toContain("autoClosePlanNote");
    expect(src).not.toContain('data-testid="preview-auto-close"');
    // The committed state keeps the commit's sentences instead of dropping them.
    expect(src).toMatch(/useState<\{[^}]*warnings\?: string\[\][^}]*\} \| null>\(null\)/);
  });
});

// ===========================================================================
// C-6 · the manual pull
// ===========================================================================

describe("C-6 · a clamped Dhan pull is said plainly, kept, and cleared only by the user", () => {
  const LAST = () => istDay(-120);
  const FLOOR = () => istDay(-90);
  const GAP_END = () => istDay(-91);
  const fill: Fill = { id: "C6-B", side: "BUY", qty: 5, price: 200, at: `${istDay(-5)} 10:00:00` };

  it("Preview pull names the unfetched dates and the remedy, asks Dhan for no more than the cap, and keeps nothing yet", async () => {
    addDhan(C6_ROUTE, stampOn(-120));
    const paths = stubDhan([fill]);
    const res = await post({ action: "pull", broker: "dhan", accountId: C6_ROUTE, mode: "preview" });
    expect(res.status).toBe(200);
    const json = await res.json();
    // No new Dhan traffic: the same clamped window, page 0 then the empty page 1.
    expect(paths.filter((p) => p.startsWith("/v2/trades/"))).toEqual([
      `/v2/trades/${FLOOR()}/${istDay(0)}/0`,
      `/v2/trades/${FLOOR()}/${istDay(0)}/1`,
    ]);
    const said = (json.warnings as string[]).find((w) => w.startsWith("Not fetched:"));
    expect(said, "the preview is silent about the clamp").toBeDefined();
    expect(said).toContain(`fills from ${LAST()} to ${GAP_END()}`);
    // F-L1-3a (fix wave 1): the remedy starts the day AFTER the last pull's
    // own day — that day is stated as a fact, never named as one to import.
    expect(said).toContain(`import a Dhan tradebook for ${istDay(-119)} to ${GAP_END()}`);
    expect(said).not.toContain(`tradebook for ${LAST()} to`);

    // A preview moves nothing: no kept notice, and the gap line says the pull will not reach back.
    const conn = await connOf(C6_ROUTE);
    expect(conn.unfetched).toEqual([]);
    expect(conn.catchUpFrom).toBe(FLOOR());
    expect(bc.pullGapNotice(conn.lastPullAt, new Date(), conn.catchUpFrom)).toMatch(
      /the next pull fetches from .+; fills before that are not fetched\.$/,
    );
  });

  it("Pull & commit keeps the span: lastPullAt moves on, and the card still lists the dates it never read", async () => {
    stubDhan([fill]);
    const res = await post({ action: "pull", broker: "dhan", accountId: C6_ROUTE, mode: "commit" });
    expect(res.status).toBe(200);
    const json = await res.json();
    const said = (json.warnings as string[]).find((w) => w.startsWith(`Not fetched: fills from ${LAST()} to ${GAP_END()}.`));
    expect(said).toBeDefined();

    const conn = await connOf(C6_ROUTE);
    expect(Date.parse(conn.lastPullAt!)).toBeGreaterThan(Date.now() - 60_000);
    // THE assertion (red on revert): the span outlives the stamp that used to erase it.
    // P15 / P16: with the pull's sentences (was {from, to, reason} only).
    expect(conn.unfetched).toEqual([RANGE_CAP_120()]);
    expect(bc.pullGapNotice(conn.lastPullAt, new Date(), conn.catchUpFrom)).toBeNull();
    // P15 / P16: the card's line IS the pull's warning (was toContain "Import a Dhan tradebook for").
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toBe(said);
  });

  it("a later pull does not clear it; a clear naming another span changes nothing; the explicit clear does", async () => {
    stubDhan([]);
    const later = await post({ action: "pull", broker: "dhan", accountId: C6_ROUTE, mode: "commit" });
    expect(later.status).toBe(200);
    expect((await connOf(C6_ROUTE)).unfetched).toHaveLength(1);

    const wrong = await post({
      action: "clear-unfetched",
      broker: "dhan",
      accountId: C6_ROUTE,
      from: LAST(),
      to: istDay(-1),
      reason: "range-cap",
    });
    expect(wrong.status).toBe(404);
    expect((await connOf(C6_ROUTE)).unfetched).toHaveLength(1);

    const cleared = await post({
      action: "clear-unfetched",
      broker: "dhan",
      accountId: C6_ROUTE,
      from: LAST(),
      to: GAP_END(),
      reason: "range-cap",
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).ok).toBe(true);
    expect((await connOf(C6_ROUTE)).unfetched).toEqual([]);

    // Append-only: the record and its clear are two rows; neither was rewritten.
    const trail = t.sqlite
      .prepare(
        "SELECT action, json_extract(after_json, '$.clearedAt') AS cleared FROM audit_log WHERE json_extract(after_json, '$.notice') = 'dhan-unfetched' AND json_extract(after_json, '$.accountId') = ? ORDER BY id",
      )
      .all(C6_ROUTE) as { action: string; cleared: string | null }[];
    expect(trail.map((r) => r.action)).toEqual(["create", "update"]);
    expect(trail[0]!.cleared).toBeNull();
    expect(trail[1]!.cleared).not.toBeNull();
  });
});

// ===========================================================================
// C-6 · the scheduled auto-pull
// ===========================================================================

describe("C-6 · a clamp in the background auto-pull is recorded through the same store", () => {
  it("the sweep's line says it, and the card lists the same span the manual pull would", async () => {
    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    addDhan(C6_AUTO, stampOn(-120), { pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP", totpAckVersion: 1 });
    stubDhan([{ id: "A6-B", side: "BUY", qty: 3, price: 50, at: `${istDay(-5)} 10:00:00` }]);

    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    const mine = out.summary.find((e) => e.broker === "dhan" && e.accountId === C6_AUTO);
    expect(mine?.status).toBe("imported");
    expect(mine?.detail).toContain(`fills from ${istDay(-120)} to ${istDay(-91)} not fetched`);
    // An ordinary new row still reads as it always did: "+1 trade (…)".
    expect(mine?.detail.startsWith("+1 trade (fills from")).toBe(true);
    expect(out.line).toContain("not fetched");

    // THE assertion (red on revert): the background commit is not silent either.
    const conn = await connOf(C6_AUTO);
    expect(conn.unfetched).toEqual([RANGE_CAP_120()]); // P15 / P16: with the pull's sentences
  });
});

// ===========================================================================
// C-5 · the scheduled auto-pull's "+N trades"
// ===========================================================================

/**
 * The sweep line counts the rows the commit ADDED — the manual pull's "N
 * added". With auto-close SWITCHED OFF for 4.3.0 (owner ruling 2026-09-11,
 * 06-ANSWERS "v4.3.0 release-level-audit rulings", row 1) a SELL of a held lot
 * is written as its own row, so the line reads "+1 trade", as v4.2.0's did, and
 * names no close (R18's clause is gone with it).
 */
describe("C-5 · the auto-pull line says what the commit did: a SELL of a held lot is +1 trade", () => {
  it("a SELL of the held lot reads '+1 trade' and names no close", async () => {
    addDhan(C5_AUTO, stampOn(-4), { pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP", totpAckVersion: 1 });
    stubDhan([{ id: "A5-B", side: "BUY", qty: 100, price: 100, at: `${istDay(-3)} 09:30:00` }]);
    const opened = await post({ action: "pull", broker: "dhan", accountId: C5_AUTO, mode: "commit" });
    expect(opened.status).toBe(200);
    expect(rowsOf(C5_AUTO).map((r) => r.is_open)).toEqual([1]);
    // Put the stamp back so the sweep's catch-up window reaches the sell.
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(stampOn(-4), C5_AUTO);

    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    stubDhan([{ id: "A5-S", side: "SELL", qty: 100, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    const mine = out.summary.find((e) => e.broker === "dhan" && e.accountId === C5_AUTO);
    expect(mine?.status).toBe("imported");
    // THE assertion: the count is what the commit wrote, and no close is named.
    expect(mine?.detail).toBe("+1 trade");
    expect(out.line).toContain("Dhan +1 trade");
    expect(out.line).not.toMatch(/closed/);
    // …and it is true: one row was added, and the held one is still open.
    const rows = rowsOf(C5_AUTO);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.is_open)).toEqual([1, 1]);
  });
});

// ===========================================================================
// v4.3.0 fix wave 1 — R42, R19, R27, R10 through the real route and sweep
// ===========================================================================

const lastPullAtOf = (accountId: number) =>
  (t.sqlite.prepare("SELECT last_pull_at AS v FROM broker_connections WHERE account_id = ? AND broker = 'dhan'").get(accountId) as {
    v: string | null;
  }).v;

const buyQtyOf = (accountId: number) =>
  (t.sqlite.prepare("SELECT COALESCE(SUM(buy_qty), 0) AS s FROM trades WHERE account_id = ?").get(accountId) as { s: number }).s;

const noticeRowsOf = (accountId: number) =>
  (t.sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE json_extract(after_json, '$.notice') = 'dhan-unfetched' AND json_extract(after_json, '$.accountId') = ?",
    )
    .get(accountId) as { n: number }).n;

const commitPull = (accountId: number) => post({ action: "pull", broker: "dhan", accountId, mode: "commit" });

/** Today's /positions book holding 100 TCS bought today (no sale). */
const TCS_LONG_100 = {
  tradingSymbol: "TCS",
  positionType: "LONG",
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  buyAvg: 100,
  buyQty: 100,
  sellAvg: 0,
  sellQty: 0,
  netQty: 100,
};

describe("R42 · a catch-up does not restate the purchase the last pull's snapshot stored", () => {
  it("the sweep passes the same cutoff: SUM(buy_qty) stays 100 when its history repeats the stored purchase", async () => {
    const D3 = istDay(-3);
    const D1 = istDay(-1);
    addDhan(R42_AUTO, null, ENROLLED);
    vi.setSystemTime(new Date(`${D3}T13:00:00.000Z`)); // pull 1 ON day -3, 18:30 IST
    stubDhan([], { positions: [TCS_LONG_100] });
    expect((await commitPull(R42_AUTO)).status).toBe(200);

    vi.setSystemTime(NOW);
    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    stubDhan([
      { id: "R42A-B", side: "BUY", qty: 100, price: 100, at: `${D3} 10:00:00` },
      { id: "R42A-S", side: "SELL", qty: 40, price: 120, at: `${D1} 14:00:00` },
    ]);
    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    expect(out.summary.find((e) => e.accountId === R42_AUTO)?.status).toBe("imported");
    // THE assertion: 200 when the sweep restates the purchase.
    expect(buyQtyOf(R42_AUTO)).toBe(100);
  });

  it("pull 1 commits /positions' BUY 100; pull 2's history repeats it beside a SELL 40 — SUM(buy_qty) stays 100, stamped at the pre-read instant", async () => {
    const D3 = istDay(-3);
    const D1 = istDay(-1);
    addDhan(R42_ACC, null); // never pulled: pull 1 reads today's book only

    // Pull 1 runs ON day -3, at 18:30 IST. /positions moves the clock 5 minutes
    // while it answers, so a post-commit stamp would read 18:35.
    const T1 = new Date(`${D3}T13:00:00.000Z`);
    vi.setSystemTime(T1);
    stubDhan([], { advanceMs: 5 * 60_000, positions: [TCS_LONG_100] });
    const first = await commitPull(R42_ACC);
    expect(first.status).toBe(200);
    expect(rowsOf(R42_ACC).map((r) => [r.buy_qty, r.is_open])).toEqual([[100, 1]]);
    // THE stamp assertion: the instant BEFORE /v2/positions was read.
    expect(lastPullAtOf(R42_ACC)).toBe(T1.toISOString());

    // Pull 2, today: the history window re-reads day -3 (inclusive) and serves
    // the same purchase as a fill, plus a later partial sale.
    vi.setSystemTime(NOW);
    stubDhan([
      { id: "R42-B", side: "BUY", qty: 100, price: 100, at: `${D3} 10:00:00` },
      { id: "R42-S", side: "SELL", qty: 40, price: 120, at: `${D1} 14:00:00` },
    ]);
    const second = await commitPull(R42_ACC);
    expect(second.status).toBe(200);
    // THE assertion: the purchase is in the book once (200 when it is restated).
    expect(buyQtyOf(R42_ACC)).toBe(100);
    expect(rowsOf(R42_ACC).map((r) => [r.buy_qty, r.sell_qty])).toEqual([
      [100, 0],
      [0, 40],
    ]);
  });
});

describe("R19 · a notice that cannot be saved stops the pull before it commits", () => {
  it("with audit_log refusing inserts, Pull & commit errors, commits nothing and leaves the stamp; then the span is kept once and the fill lands once", async () => {
    const OLD = stampOn(-120);
    addDhan(R19_ACC, OLD);
    const fills: Fill[] = [{ id: "R19-B", side: "BUY", qty: 5, price: 200, at: `${istDay(-5)} 10:00:00` }];
    stubDhan(fills);
    t.sqlite.exec("CREATE TRIGGER zz_r19 BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'x'); END");
    try {
      const refused = await commitPull(R19_ACC);
      expect(refused.status).toBe(500);
      const json = await refused.json();
      expect(json.ok).toBe(false);
      expect(json.message).toMatch(/could not be saved.*Nothing was committed/);
      // THE assertions: nothing committed, and the stamp did not move past the dates.
      expect(rowsOf(R19_ACC)).toEqual([]);
      expect(lastPullAtOf(R19_ACC)).toBe(OLD);
    } finally {
      t.sqlite.exec("DROP TRIGGER IF EXISTS zz_r19");
    }

    stubDhan(fills);
    expect((await commitPull(R19_ACC)).status).toBe(200);
    expect((await connOf(R19_ACC)).unfetched).toEqual([RANGE_CAP_120()]); // P15 / P16: with the pull's sentences
    expect(rowsOf(R19_ACC).map((r) => r.buy_qty)).toEqual([5]);
    expect(noticeRowsOf(R19_ACC)).toBe(1);

    // The same window again (stamp put back): the writer is idempotent, so the
    // span that is already outstanding is not written a second time.
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(OLD, R19_ACC);
    stubDhan(fills);
    expect((await commitPull(R19_ACC)).status).toBe(409); // nothing new
    expect(noticeRowsOf(R19_ACC)).toBe(1);
    expect(rowsOf(R19_ACC).map((r) => r.buy_qty)).toEqual([5]);
  });

  it("auto-pull: with audit_log refusing inserts the sweep reports an error, commits nothing and leaves the stamp", async () => {
    const OLD = stampOn(-120);
    addDhan(R19_AUTO, OLD, ENROLLED);
    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    stubDhan([{ id: "R19-A", side: "BUY", qty: 4, price: 150, at: `${istDay(-5)} 10:00:00` }]);
    t.sqlite.exec("CREATE TRIGGER zz_r19a BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'x'); END");
    let out: Awaited<ReturnType<typeof job.runAutoPull>>;
    try {
      out = await job.runAutoPull(new Date()); // the REAL pullOne
    } finally {
      t.sqlite.exec("DROP TRIGGER IF EXISTS zz_r19a");
    }
    const mine = out.summary.find((e) => e.broker === "dhan" && e.accountId === R19_AUTO);
    expect(mine?.status).toBe("error");
    expect(mine?.detail).toMatch(/could not be saved.*nothing was committed/);
    // THE assertions: nothing committed, and the stamp did not move past the dates.
    expect(rowsOf(R19_AUTO)).toEqual([]);
    expect(lastPullAtOf(R19_AUTO)).toBe(OLD);
  });
});

describe("R27 · a pull that finds nothing new still moves lastPullAt", () => {
  const fill = (id: string): Fill => ({ id, side: "BUY", qty: 7, price: 100, at: `${istDay(-2)} 10:00:00` });

  it("route: the 409 nothingNew answer, AND the stamp moved to this pull's instant", async () => {
    addDhan(R27_ROUTE, stampOn(-5));
    stubDhan([fill("R27-R")]);
    expect((await commitPull(R27_ROUTE)).status).toBe(200);
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(stampOn(-5), R27_ROUTE);

    // /positions moves the clock 5 minutes while it answers: the stamp must be
    // the instant BEFORE that read (R42), not a clock taken afterwards.
    stubDhan([fill("R27-R")], { advanceMs: 5 * 60_000 });
    const res = await commitPull(R27_ROUTE);
    expect(res.status).toBe(409);
    expect((await res.json()).nothingNew).toBe(true);
    // THE assertion (old stamp on revert).
    expect(lastPullAtOf(R27_ROUTE)).toBe(NOW.toISOString());
  });

  it("auto-pull: 'nothingNew', and the stamp moved", async () => {
    addDhan(R27_AUTO, stampOn(-5), ENROLLED);
    stubDhan([fill("R27-A")]);
    expect((await commitPull(R27_AUTO)).status).toBe(200);
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(stampOn(-5), R27_AUTO);

    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    // Only the /positions read after THIS connection's window moves the clock
    // (another connection with an older stamp may walk history in the sweep).
    stubDhan([fill("R27-A")], { advanceMs: 5 * 60_000, onlyAfterHistory: `/v2/trades/${istDay(-5)}/` });
    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    const mine = out.summary.find((e) => e.broker === "dhan" && e.accountId === R27_AUTO);
    expect(mine?.status).toBe("nothingNew");
    // THE assertion (old stamp on revert).
    expect(lastPullAtOf(R27_AUTO)).toBe(NOW.toISOString());
  });
});

describe("R10 · an account merge carries the kept notice to the target", () => {
  it("a clamped commit in X keeps a span; merging X into Y lists it on Y's Dhan row", async () => {
    addDhan(R10_X, stampOn(-120));
    stubDhan([{ id: "R10-B", side: "BUY", qty: 2, price: 300, at: `${istDay(-5)} 10:00:00` }]);
    expect((await commitPull(R10_X)).status).toBe(200);
    // P15 / P16: the carried span keeps the SOURCE pull's sentences, not the merge's summary.
    const SPAN = [RANGE_CAP_120()];
    expect((await connOf(R10_X)).unfetched).toEqual(SPAN);

    const del = await import("@/lib/queries/account-delete");
    const res = del.deleteAccount({ accountId: R10_X, mode: "merge", targetId: R10_Y, connections: "move" });
    expect(res.ok, res.message).toBe(true);
    // THE assertion (empty on revert): the notice followed the book.
    expect((await connOf(R10_Y)).unfetched).toEqual(SPAN);
  });
});

// ===========================================================================
// v4.3.0 fix wave 2 — R43 (same-day re-pull) and R42b (side-aware cross-source)
// ===========================================================================

/** Today's /positions book: the same 100 TCS, bought and sold today. */
const TCS_CLOSED_100 = { ...TCS_LONG_100, positionType: "CLOSED", sellAvg: 110, sellQty: 100, netQty: 0, realizedProfit: 1000 };

const fullRowsOf = (accountId: number) =>
  t.sqlite
    .prepare(
      "SELECT id, is_open, buy_qty, sell_qty, buy_date, sell_date, acquisition, import_batch_id, dedup_hash FROM trades WHERE account_id = ? ORDER BY id",
    )
    .all(accountId) as {
    id: number;
    is_open: number;
    buy_qty: number;
    sell_qty: number;
    buy_date: string | null;
    sell_date: string | null;
    acquisition: string | null;
    import_batch_id: number;
    dedup_hash: string;
  }[];

const UPDATED = "1 position updated from today's earlier pull";

describe("R43 · a same-day Dhan re-pull replaces today's earlier snapshot in place", () => {
  it("route: pull 1 /positions BUY 100 (open); pull 2 the same frozen IST day BUY 100 / SELL 100 — one row, closed, the same id, and the card says so", async () => {
    addDhan(R43_ROUTE, null);
    stubDhan([], { positions: [TCS_LONG_100] });
    expect((await commitPull(R43_ROUTE)).status).toBe(200);
    const [first] = fullRowsOf(R43_ROUTE);
    expect(first).toMatchObject({ is_open: 1, buy_qty: 100, sell_qty: 0 });

    stubDhan([], { positions: [TCS_CLOSED_100] });
    const pre = await post({ action: "pull", broker: "dhan", accountId: R43_ROUTE, mode: "preview" });
    const summary = (await pre.json()).preview.summary;
    expect.soft([summary.newCount, summary.dupCount, summary.supersededCount]).toEqual([0, 0, 1]);

    const res = await commitPull(R43_ROUTE);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect.soft(json.result.warnings).toContain(`${UPDATED}.`);
    expect.soft(bc.pullResultMessage("commit", json)).toContain(`${UPDATED}.`);
    // THE assertion (two rows on revert).
    const rows = fullRowsOf(R43_ROUTE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first!.id,
      is_open: 0,
      buy_qty: 100,
      sell_qty: 100,
      sell_date: istDay(0),
      import_batch_id: first!.import_batch_id,
    });
    expect(rows[0]!.dedup_hash).not.toBe(first!.dedup_hash);

    // A third pull of the same book is an ordinary duplicate.
    stubDhan([], { positions: [TCS_CLOSED_100] });
    const again = await commitPull(R43_ROUTE);
    expect(again.status).toBe(409);
    expect((await again.json()).nothingNew).toBe(true);
  });

  it("auto-pull: the sweep replaces the morning row too, and its line says what the commit did", async () => {
    addDhan(R43_AUTO, null, ENROLLED);
    stubDhan([], { positions: [TCS_LONG_100] });
    expect((await commitPull(R43_AUTO)).status).toBe(200);
    const [first] = fullRowsOf(R43_AUTO);

    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    stubDhan([], { positions: [TCS_CLOSED_100] });
    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    const mine = out.summary.find((e) => e.broker === "dhan" && e.accountId === R43_AUTO);
    expect.soft(mine?.status).toBe("imported");
    expect.soft(mine?.detail).toBe(UPDATED);
    // THE assertion (two rows on revert).
    expect(fullRowsOf(R43_AUTO).map((r) => [r.id, r.is_open, r.sell_qty])).toEqual([[first!.id, 0, 100]]);
  });

  /** One NIFTY call, as Dhan states it on /positions, in `productType`. */
  const niftyCe = (productType: string, buyQty: number, buyAvg: number, sellQty = 0, sellAvg = 0) => ({
    tradingSymbol: "NIFTY-Sep2026-24000-CE",
    exchangeSegment: "NSE_FNO",
    drvExpiryDate: "2026-09-29 14:30:00",
    drvOptionType: "CALL",
    drvStrikePrice: 24000,
    positionType: buyQty === sellQty ? "CLOSED" : "LONG",
    productType,
    buyAvg,
    buyQty,
    sellAvg,
    sellQty,
    netQty: buyQty - sellQty,
  });

  const PAIR_EVENING = () => [niftyCe("MARGIN", 150, 90), niftyCe("INTRADAY", 75, 100, 75, 120)];
  let pairBefore: ReturnType<typeof fullRowsOf> = [];

  it("an INTRADAY + MARGIN pair of one NIFTY CE shares the key: NOT replaced — the route answers 409 needsForce and both rows stay as they were", async () => {
    addDhan(R43_PAIR, null, ENROLLED);
    // MARGIN first, so the row a changed INTRADAY position meets FIRST is the
    // other product's (a partial overlap) — the report must still ask.
    stubDhan([], { positions: [niftyCe("MARGIN", 150, 90), niftyCe("INTRADAY", 75, 100)] });
    expect((await commitPull(R43_PAIR)).status).toBe(200);
    const before = fullRowsOf(R43_PAIR);
    expect(before.map((r) => [r.buy_qty, r.sell_qty, r.is_open])).toEqual([
      [150, 0, 1],
      [75, 0, 1],
    ]);

    // The INTRADAY position was closed by the evening; the MARGIN one is unchanged.
    stubDhan([], { positions: PAIR_EVENING() });
    const res = await commitPull(R43_PAIR);
    // THE assertions (200 and a third row on revert).
    expect(res.status).toBe(409);
    expect((await res.json()).needsForce).toBe(true);
    expect(fullRowsOf(R43_PAIR)).toEqual(before);
    pairBefore = before;
  });

  it("…and the sweep answers 'collision' for the same evening book, writing nothing", async () => {
    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    stubDhan([], { positions: PAIR_EVENING() });
    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    // THE assertions ('imported' and a third row on revert).
    expect(out.summary.find((e) => e.broker === "dhan" && e.accountId === R43_PAIR)?.status).toBe("collision");
    expect(pairBefore).toHaveLength(2);
    expect(fullRowsOf(R43_PAIR)).toEqual(pairBefore);
  });

  it("Angel One (QS-AO): the route passes the snapshot identity for its pull too — pull 2 the same day replaces the open BUY", async () => {
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, 'angelone', 'key', '', ?)")
      .run(R43_ANGEL, JSON.stringify({ clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" }));
    const stubAngel = (fills: Record<string, unknown>[]) =>
      vi.stubGlobal("fetch", async (url: string) => {
        const data = String(url).includes("loginByPassword") ? { jwtToken: "jwt" } : fills;
        return new Response(JSON.stringify({ status: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
      });
    const fill = (side: "BUY" | "SELL", price: number, time: string) => ({
      tradingsymbol: "TCS-EQ",
      exchange: "NSE",
      producttype: "DELIVERY",
      transactiontype: side,
      fillsize: 10,
      fillprice: price,
      filltime: time,
    });
    const pull = () => post({ action: "pull", broker: "angelone", accountId: R43_ANGEL, mode: "commit" });

    stubAngel([fill("BUY", 100, "10:00:00")]);
    expect((await pull()).status).toBe(200);
    const [first] = fullRowsOf(R43_ANGEL);
    stubAngel([fill("BUY", 100, "10:00:00"), fill("SELL", 110, "14:00:00")]);
    const res = await pull();
    expect(res.status).toBe(200);
    expect((await res.json()).result.warnings).toContain(`${UPDATED}.`);
    // THE assertion (two rows on revert of the route's option).
    expect(fullRowsOf(R43_ANGEL).map((r) => [r.id, r.is_open, r.buy_qty, r.sell_qty])).toEqual([[first!.id, 0, 10, 10]]);
  });
});

describe("R42b · a SELL of a held lot is not a cross-source duplicate of it (side-aware, Q-LOOP)", () => {
  const D3 = () => istDay(-3);
  const D2 = () => istDay(-2);
  /** Pull 1 ON day -3 at 18:30 IST: today's book then was 100 TCS bought. */
  async function holdLotFromDay3(accountId: number, auth: Record<string, unknown> | null) {
    addDhan(accountId, null, auth);
    vi.setSystemTime(new Date(`${D3()}T13:00:00.000Z`));
    stubDhan([], { positions: [TCS_LONG_100] });
    expect((await commitPull(accountId)).status).toBe(200);
    vi.setSystemTime(NOW);
    return fullRowsOf(accountId);
  }
  /** History for the catch-up: the day -3 buy (at or before the stamp, so `after` drops it) and a day -2 SELL 100. */
  const history = (tag: string): Fill[] => [
    { id: `${tag}-B`, side: "BUY", qty: 100, price: 100, at: `${D3()} 10:00:00` },
    { id: `${tag}-S`, side: "SELL", qty: 100, price: 120, at: `${D2()} 14:00:00` },
  ];

  it("route: no 409 — the sale commits as its own row (basis unknown, dated), the lot is unchanged, and lastPullAt is the cutoff", async () => {
    const [lot] = await holdLotFromDay3(R42B_ROUTE, null);
    const saleDay = D2(); // read before /positions moves the frozen clock past IST midnight
    stubDhan(history("R42B"), { advanceMs: 5 * 60_000 });
    const res = await commitPull(R42B_ROUTE);
    // THE assertions (409 same-quantity, stamp unmoved, on revert).
    expect.soft(res.status).toBe(200);
    expect.soft(lastPullAtOf(R42B_ROUTE)).toBe(NOW.toISOString());
    const rows = fullRowsOf(R42B_ROUTE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(lot);
    expect(rows[1]).toMatchObject({ buy_qty: 0, sell_qty: 100, is_open: 1, acquisition: "unknown", sell_date: saleDay });
  });

  it("auto-pull: '+1 trade', and the stamp moves", async () => {
    const [lot] = await holdLotFromDay3(R42B_AUTO, ENROLLED);
    const stamped = lastPullAtOf(R42B_AUTO);
    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    stubDhan(history("R42BA"));
    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    const mine = out.summary.find((e) => e.broker === "dhan" && e.accountId === R42B_AUTO);
    // THE assertions ('collision' and the stamp unmoved, on revert).
    expect.soft(mine?.status).toBe("imported");
    expect.soft(mine?.detail).toBe("+1 trade");
    expect(lastPullAtOf(R42B_AUTO)).not.toBe(stamped);
    expect(lastPullAtOf(R42B_AUTO)).toBe(NOW.toISOString());
    const rows = fullRowsOf(R42B_AUTO);
    expect(rows[0]).toEqual(lot);
    expect(rows.map((r) => [r.buy_qty, r.sell_qty, r.acquisition])).toEqual([
      [100, 0, null],
      [0, 100, "unknown"],
    ]);
  });
});

// ===========================================================================
// v4.3.0 fix wave 2 — P11 (a span kept before a commit that then throws) and
// P15's legacy row, through the real route, sweep and GET
// ===========================================================================

/** The commit refuses every trade row — the TEST makes it throw; the product has no hook for it. */
const refuseTrades = (name: string) =>
  t.sqlite.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON trades BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`);
const dropTrigger = (name: string) => t.sqlite.exec(`DROP TRIGGER IF EXISTS ${name}`);
const openOf = async (accountId: number, reason: string) =>
  (await connOf(accountId)).unfetched!.filter((s) => s.reason === reason).map((s) => [s.from, s.to]);

describe("P11 · a span kept before a commit that throws is superseded on the retry, and an untruncated read clears a page-cap span", () => {
  it("range-cap: the commit throws after the span was kept; the retry the NEXT day leaves ONE outstanding range-cap span, with the new `to`", async () => {
    const OLD = stampOn(-120);
    const [LAST, TO_NOW, TO_NEXT_DAY] = [istDay(-120), istDay(-91), istDay(-90)];
    addDhan(P11_RANGE, OLD);
    const fills: Fill[] = [{ id: "P11R-B", side: "BUY", qty: 5, price: 200, at: `${istDay(-5)} 10:00:00` }];
    stubDhan(fills);
    refuseTrades("zz_p11r");
    try {
      const refused = await commitPull(P11_RANGE);
      expect(refused.status).toBe(422);
      expect(rowsOf(P11_RANGE)).toEqual([]);
      expect(lastPullAtOf(P11_RANGE)).toBe(OLD);
    } finally {
      dropTrigger("zz_p11r");
    }
    // R19 kept the span before the commit, and it stays (the dates are still unread).
    expect(await openOf(P11_RANGE, "range-cap")).toEqual([[LAST, TO_NOW]]);

    // The retry runs a day later: the floor moved, so the span's `to` did.
    vi.setSystemTime(NOW.getTime() + DAY);
    stubDhan(fills);
    expect((await commitPull(P11_RANGE)).status).toBe(200);
    // THE assertion (two overlapping spans on revert).
    expect(await openOf(P11_RANGE, "range-cap")).toEqual([[LAST, TO_NEXT_DAY]]);
    // Append-only: the old record, its clear, and the new record.
    const trail = t.sqlite
      .prepare(
        "SELECT action, json_extract(after_json, '$.to') AS too, json_extract(after_json, '$.clearedAt') AS cleared FROM audit_log WHERE json_extract(after_json, '$.notice') = 'dhan-unfetched' AND json_extract(after_json, '$.accountId') = ? ORDER BY id",
      )
      .all(P11_RANGE) as { action: string; too: string; cleared: string | null }[];
    expect(trail.map((r) => [r.action, r.too, r.cleared == null])).toEqual([
      ["create", TO_NOW, true],
      ["update", TO_NOW, false],
      ["create", TO_NEXT_DAY, true],
    ]);
  });

  it("page-cap, commit path: a truncated pull whose commit throws keeps the span; the same-window UNTRUNCATED retry commits and clears it", async () => {
    const OLD = stampOn(-4);
    addDhan(P11_PAGE, OLD);
    // One fill on every page: the walk never meets an empty page and stops at the cap.
    const fills: Fill[] = [{ id: "P11P-B", side: "BUY", qty: 5, price: 200, at: `${istDay(-2)} 10:00:00` }];
    stubDhan(fills, { everyPage: true, positions: [TCS_LONG_100] });
    refuseTrades("zz_p11p");
    try {
      expect((await commitPull(P11_PAGE)).status).toBe(422);
      expect(lastPullAtOf(P11_PAGE)).toBe(OLD);
    } finally {
      dropTrigger("zz_p11p");
    }
    expect(await openOf(P11_PAGE, "page-cap")).toEqual([[istDay(-4), istDay(-1)]]);

    stubDhan([], { positions: [TCS_LONG_100] }); // page 0 is empty: the walk is NOT truncated
    expect((await commitPull(P11_PAGE)).status).toBe(200);
    expect(rowsOf(P11_PAGE).map((r) => r.buy_qty)).toEqual([100]);
    // THE assertion (the span still listed on revert).
    expect(await openOf(P11_PAGE, "page-cap")).toEqual([]);
  });

  it("page-cap, nothing-new path: the untruncated re-read that finds nothing new clears the span with the stamp", async () => {
    const OLD = stampOn(-4);
    addDhan(P11_PAGE_NN, OLD);
    stubDhan([{ id: "P11N-B", side: "BUY", qty: 5, price: 200, at: `${istDay(-2)} 10:00:00` }], { everyPage: true, positions: [TCS_LONG_100] });
    expect((await commitPull(P11_PAGE_NN)).status).toBe(200);
    expect(await openOf(P11_PAGE_NN, "page-cap")).toEqual([[istDay(-4), istDay(-1)]]);
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(OLD, P11_PAGE_NN);

    stubDhan([], { positions: [TCS_LONG_100] });
    const again = await commitPull(P11_PAGE_NN);
    expect(again.status).toBe(409);
    expect((await again.json()).nothingNew).toBe(true);
    // THE assertion (the span still listed on revert).
    expect(await openOf(P11_PAGE_NN, "page-cap")).toEqual([]);
  });

  it("auto-pull: the sweep clears a covered page-cap span on its commit path AND on its nothing-new path", async () => {
    const OLD = stampOn(-4);
    // C: a truncated pull whose commit threw — nothing stored, span kept.
    const truncating: Fill[] = [{ id: "P11A-B", side: "BUY", qty: 5, price: 200, at: `${istDay(-2)} 10:00:00` }];
    addDhan(P11_AUTO_C, OLD, ENROLLED);
    stubDhan(truncating, { everyPage: true, positions: [TCS_LONG_100] });
    refuseTrades("zz_p11a");
    try {
      expect((await commitPull(P11_AUTO_C)).status).toBe(422);
    } finally {
      dropTrigger("zz_p11a");
    }
    // N: a truncated pull that committed today's book; its stamp put back.
    addDhan(P11_AUTO_N, OLD, ENROLLED);
    stubDhan(truncating, { everyPage: true, positions: [TCS_LONG_100] });
    expect((await commitPull(P11_AUTO_N)).status).toBe(200);
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(OLD, P11_AUTO_N);
    for (const acc of [P11_AUTO_C, P11_AUTO_N]) expect(await openOf(acc, "page-cap")).toEqual([[istDay(-4), istDay(-1)]]);

    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    stubDhan([], { positions: [TCS_LONG_100] }); // untruncated for every connection in the sweep
    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    expect(out.summary.find((e) => e.accountId === P11_AUTO_C)?.status).toBe("imported");
    expect(out.summary.find((e) => e.accountId === P11_AUTO_N)?.status).toBe("nothingNew");
    // THE assertions (the span still listed on revert of either path).
    expect(await openOf(P11_AUTO_C, "page-cap")).toEqual([]);
    expect(await openOf(P11_AUTO_N, "page-cap")).toEqual([]);
  });
});

describe("P15 · a span kept before the sentences were stored reads its audit row's own summary", () => {
  it("GET sends the stored summary as `fact` with no remedy, and the card prints exactly that — never a re-derived line", async () => {
    addDhan(P15_LEGACY, stampOn(-1));
    const SUMMARY = `Not fetched: fills from ${istDay(-150)} to ${istDay(-121)}. (as a v4.3.0 fix-wave-1 build kept it)`;
    t.db
      .insert(t.schema.auditLog)
      .values({
        entity: "settings",
        entityId: null,
        action: "create",
        summary: SUMMARY,
        afterJson: {
          notice: "dhan-unfetched",
          broker: "dhan",
          accountId: P15_LEGACY,
          from: istDay(-150),
          to: istDay(-121),
          reason: "range-cap",
          clearedAt: null,
        },
        source: "import",
      })
      .run();
    const conn = await connOf(P15_LEGACY);
    // THE assertion (a fact the card cannot print, on revert).
    expect(conn.unfetched).toEqual([{ from: istDay(-150), to: istDay(-121), reason: "range-cap", fact: SUMMARY, remedy: null }]);
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toBe(SUMMARY);
  });
});
