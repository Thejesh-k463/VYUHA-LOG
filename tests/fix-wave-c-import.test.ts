import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 FIX WAVE C — C-5 and C-6, both halves at once.
 *
 * C-5: a SELL that auto-closes an open row FIFO (06-ANSWERS "v4.2.1 rulings"
 * item 4) was silent on screen. The commit's sentence (`result.warnings`,
 * lib/import/commit.ts) reached the response and no client read it; "Preview
 * pull" showed no close plan. Here the REAL broker route and the REAL file
 * route answer, and their JSON goes straight into the REAL client composers
 * (`pullResultMessage`, `autoClosePlanNote`, `commitResultNotes`) — the seam
 * the defect lived on.
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
 * itself.
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
const CLIENT = "1000000009";
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
    ])
    .run();
});
afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});
afterEach(() => vi.unstubAllGlobals());

// ── dates, from the clock (IST = UTC + 5:30) ─────────────────────────────────
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

/** api.dhan.co: page 0 of the history answers `fills`, every other page and /positions answer []. */
function stubDhan(fills: Fill[]): string[] {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    paths.push(u.pathname);
    const body =
      u.host === "auth.dhan.co"
        ? { accessToken: alive() }
        : /^\/v2\/trades\/[\d-]+\/[\d-]+\/0$/.test(u.pathname)
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
  unfetched?: { from: string; to: string; reason: string }[];
  catchUpFrom?: string | null;
}

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

describe("C-5 · a Dhan pull whose SELL closes a held lot says so — preview AND commit", () => {
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

  it("Preview pull: the response carries the close plan, and the card prints it in the file preview's words", async () => {
    stubDhan([{ id: "C5-S", side: "SELL", qty: 100, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const res = await post({ action: "pull", broker: "dhan", accountId: C5_PULL, mode: "preview" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preview.autoClose).toEqual({ closes: 1, positions: [{ symbol: "TCS", qty: 100 }] });

    const text = bc.pullResultMessage("preview", json);
    expect(text).toContain("Will close 1 open position already held in this account, oldest first (TCS 100).");
    // ONE composer for both screens: the file preview's sentence, not a copy of it.
    expect(text).toContain(ic.autoClosePlanNote(json.preview.autoClose)!);
    // A preview writes nothing.
    expect(rowsOf(C5_PULL).map((r) => r.is_open)).toEqual([1]);
  });

  it("Pull & commit: the response carries the commit's sentence, and the card prints it after the counts", async () => {
    stubDhan([{ id: "C5-S", side: "SELL", qty: 100, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const res = await post({ action: "pull", broker: "dhan", accountId: C5_PULL, mode: "commit" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.added).toBe(0);
    const closed = (json.result.warnings as string[]).find((w) => w.includes("was closed by this file"));
    expect(closed, "the route response dropped the commit's sentence").toMatch(
      /^1 open position in this account was closed by this file, oldest first \(TCS 100\)\./,
    );

    const text = bc.pullResultMessage("commit", json);
    expect(text.startsWith("Committed — 0 added, 0 duplicates skipped. ")).toBe(true);
    expect(text).toContain(closed!);
    // …and it is true: the one row closed in place.
    const rows = rowsOf(C5_PULL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ is_open: 0, buy_qty: 100, sell_qty: 100 });
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

describe("C-5 · a file whose SELL closes a held lot says so after the commit", () => {
  it("the file route's commit response carries the sentence, and the commit card lists it", async () => {
    selectAccount(C5_FILE);
    const opened = await postFile(gtr(BUY_ROW), "commit");
    expect(opened.status).toBe(200);
    expect(rowsOf(C5_FILE).map((r) => r.is_open)).toEqual([1]);

    const pre = await postFile(gtr(SELL_ROW), "preview");
    expect(pre.status).toBe(200);
    const pj = await pre.json();
    expect(pj.preview.autoClose.closes).toBe(1);
    expect(ic.autoClosePlanNote(pj.preview.autoClose)).toMatch(
      /^Will close 1 open position already held in this account, oldest first \(.+ 10\)\.$/,
    );

    const res = await postFile(gtr(SELL_ROW), "commit");
    expect(res.status).toBe(200);
    const json = await res.json();
    const lines = ic.commitResultNotes(json.result);
    expect(lines.some((w) => /^1 open position in this account was closed by this file, oldest first/.test(w))).toBe(true);
    expect(rowsOf(C5_FILE).map((r) => r.is_open)).toEqual([0]);
  });

  it("the commit card renders commitResultNotes, and the file preview renders autoClosePlanNote", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/import/import-client.tsx"), "utf8").replace(/\r\n/g, "\n");
    const card = src.slice(src.indexOf("{committed && ("), src.indexOf("View trades →"));
    expect(card).toContain('data-testid="commit-warnings"');
    expect(card).toContain("commitResultNotes(committed)");
    expect(src).toMatch(/data-testid="preview-auto-close"[^>]*>\s*\{autoClosePlanNote\(p\.autoClose\)\}/);
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
    expect(said).toContain(`import a Dhan tradebook for ${LAST()} to ${GAP_END()}`);

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
    expect((json.warnings as string[]).some((w) => w.startsWith(`Not fetched: fills from ${LAST()} to ${GAP_END()}.`))).toBe(true);

    const conn = await connOf(C6_ROUTE);
    expect(Date.parse(conn.lastPullAt!)).toBeGreaterThan(Date.now() - 60_000);
    // THE assertion (red on revert): the span outlives the stamp that used to erase it.
    expect(conn.unfetched).toEqual([{ from: LAST(), to: GAP_END(), reason: "range-cap" }]);
    expect(bc.pullGapNotice(conn.lastPullAt, new Date(), conn.catchUpFrom)).toBeNull();
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toContain("Import a Dhan tradebook for");
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
    expect(out.line).toContain("not fetched");

    // THE assertion (red on revert): the background commit is not silent either.
    const conn = await connOf(C6_AUTO);
    expect(conn.unfetched).toEqual([{ from: istDay(-120), to: istDay(-91), reason: "range-cap" }]);
  });
});
