import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { AUTO_CLOSE_NOTE, CLOSED_BY_PREFIX, DEDUP_ALIAS_PREFIX } from "@/lib/import/close-open-lots";
// Type-only: the VALUE import lives in `ic`, loaded dynamically in beforeAll
// (a static import of a module that reaches lib/db would bind the connection
// before the temp-db helper has set VYUHA_DB_PATH).
import type * as ic2 from "@/components/import/import-client";

/**
 * v4.5.0 W2b — AUTO-CLOSE IS ON, and it is the CALLERS that say so.
 *
 * W2a shipped the FIFO applier behind `ImportWriteOptions.autoClose`, DEFAULT
 * FALSE, with no production caller; `tests/auto-close-off.test.ts` pins that
 * default and every v4.2.0 outcome that rests on it. W2b (owner ruling A1,
 * design review revision 13) turns it on at the three doors that write a book —
 * the file import, the manual broker pull and the scheduled auto-pull job —
 * and gives the two MANUAL doors one per-import escape hatch, "Keep sells as
 * separate rows", which is `keepSellsSeparate` on the wire and is inverted at
 * the caller into `autoClose`.
 *
 * This file is the red-on-revert pin for exactly that switch, end to end,
 * through the REAL routes, the REAL job and the REAL /trades projection:
 *
 *   1  the file route passes it       — revert ⇒ the preview carries no plan
 *   2  the broker route passes it     — revert ⇒ the pull leaves two open rows
 *   3  the job passes it              — revert ⇒ the line reads "+1 trade"
 *   4  the toggle INVERTS it          — ticked ⇒ two rows and no plan
 *   5  the result card's headline     — added 0 + closedWhole 1 ≠ "Imported 0"
 *   6  `closedBy` on the wire row     — only a row that SAYS it was auto-closed
 *   7  the LIBRARY default stays OFF  — referenced, not re-pinned (see below)
 *
 * (7) is `tests/auto-close-off.test.ts`: every case there calls
 * `commitParsedFile`/`previewParsedFile` with NO options and still describes
 * v4.2.0's outcome, and its "(iv)" block pins that the flip lives at the
 * callers and never in the library. Duplicating it here would be a second copy
 * of one rule; it is named instead.
 *
 * ONE temp database for the file (lib/db caches its connection on globalThis),
 * so every case owns its own account id. The only stub is `globalThis.fetch`.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let brokerRoute: typeof import("@/app/api/import/broker/route");
let fileRoute: typeof import("@/app/api/import/route");
let job: typeof import("@/lib/jobs/auto-pull");
let bc: typeof import("@/components/import/broker-connect");
let ic: typeof import("@/components/import/import-client");
let tradesPage: typeof import("@/lib/queries/trades-page");

const A_FILE = 71; // (1) the file route
const A_PULL = 72; // (2) the manual broker pull
const A_JOB = 73; //  (3) the scheduled sweep
const A_KEEP = 74; // (4) the toggle, ticked
const A_PROJ = 75; // (6) the /trades projection

const CLIENT = "1000000009";
const ENROLLED = { pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP", totpAckVersion: 1 };

beforeAll(async () => {
  t = await openTempDb("auto-close-on", { seed: true });
  brokerRoute = await import("@/app/api/import/broker/route");
  fileRoute = await import("@/app/api/import/route");
  job = await import("@/lib/jobs/auto-pull");
  bc = await import("@/components/import/broker-connect");
  ic = await import("@/components/import/import-client");
  tradesPage = await import("@/lib/queries/trades-page");
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: A_FILE, name: "W2b file", isDefault: false },
      { id: A_PULL, name: "W2b pull", isDefault: false },
      { id: A_JOB, name: "W2b job", isDefault: false },
      { id: A_KEEP, name: "W2b keep", isDefault: false },
      { id: A_PROJ, name: "W2b projection", isDefault: false },
    ])
    .run();
});

afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});

/** 23:59:59 IST on 10 Sep — frozen per test so no case straddles IST midnight. */
const NOW = new Date("2026-09-10T18:29:59.000Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const DAY = 86_400_000;
const istDay = (offset = 0) => new Date(Date.now() + 5.5 * 3_600_000 + offset * DAY).toISOString().slice(0, 10);
const stampOn = (offset: number) => `${istDay(offset)}T05:00:00.000Z`;

const alive = () =>
  ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

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

/** api.dhan.co: page 0 of the history answers `fills`; /v2/positions answers []. */
function stubDhan(fills: Fill[]): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/v2/positions") {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
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

const rowsOf = (accountId: number) =>
  t.sqlite.prepare("SELECT id, is_open, buy_qty, sell_qty FROM trades WHERE account_id = ? ORDER BY id").all(accountId) as {
    id: number;
    is_open: number;
    buy_qty: number;
    sell_qty: number;
  }[];

// ── the Dhan Global Transaction Report fixture (same shape as
//    tests/fix-wave-c-import.test.ts; the file NAME is the broker fingerprint) ──
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

/** POST the file route exactly as `components/import/import-client.tsx` does.
 *  `keep` appends the ONE form field the toggle sends; absent = unticked. */
function postFile(accountId: number, csv: string, mode: "preview" | "commit", keep = false): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([csv], "Dhan_GlobalTransction_Report.csv", { type: "text/csv" }));
  fd.append("mode", mode);
  fd.append("accountId", String(accountId));
  if (keep) fd.append("keepSellsSeparate", "true");
  return fileRoute.POST(new Request("http://local/api/import", { method: "POST", body: fd }));
}

// ===========================================================================
// (1) the FILE route flips it on
// ===========================================================================

describe("(1) the file import route asks for auto-close, so the preview states the close it would make", () => {
  it("a SELL of a lot this account already holds is PLANNED on the preview and CLOSED on the commit", async () => {
    selectAccount(A_FILE);
    expect((await postFile(A_FILE, gtr(BUY_ROW), "commit")).status).toBe(200);
    expect(rowsOf(A_FILE).map((r) => r.is_open)).toEqual([1]);

    // THE assertion (revert `writeOptions` in app/api/import/route.ts and the
    // server sends nothing at all here): the preview says what it would close,
    // BEFORE anything is written.
    const pj = await (await postFile(A_FILE, gtr(SELL_ROW), "preview")).json();
    expect("autoClose" in pj.preview, "the preview must state what it would close").toBe(true);
    expect(pj.preview.autoClose.closedWhole).toBe(1);
    expect(pj.preview.autoClose.closedAgainstStoredLot).toBe(1);
    // A preview writes nothing.
    expect(rowsOf(A_FILE).map((r) => r.is_open)).toEqual([1]);

    // And the commit does exactly what the preview said: one row, closed.
    const cj = await (await postFile(A_FILE, gtr(SELL_ROW), "commit")).json();
    expect(cj.result.autoClose.closedWhole).toBe(1);
    expect(cj.result.added).toBe(0);
    expect(rowsOf(A_FILE).map((r) => [r.buy_qty, r.sell_qty, r.is_open])).toEqual([[10, 10, 0]]);
    // The commit's own sentences reach the card (C-5's seam), and name the close.
    expect(ic.commitResultNotes(cj.result).some((w) => /closed against open positions this account already held/.test(w))).toBe(true);
  });
});

// ===========================================================================
// (2) the BROKER PULL route flips it on
// ===========================================================================

describe("(2) the manual broker pull asks for auto-close, so a pulled SELL closes the held lot", () => {
  it("pull #1 opens the lot; pull #2's SELL closes it in place instead of landing beside it", async () => {
    addDhan(A_PULL, stampOn(-4));
    stubDhan([{ id: "ON-B", side: "BUY", qty: 100, price: 100, at: `${istDay(-3)} 09:30:00` }]);
    expect((await post({ action: "pull", broker: "dhan", accountId: A_PULL, mode: "commit" })).status).toBe(200);
    expect(rowsOf(A_PULL).map((r) => r.is_open)).toEqual([1]);
    // Put the stamp back before the sell, so the next pull's window reaches it
    // (a pull that already ran today does no history walk at all).
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(stampOn(-4), A_PULL);

    stubDhan([{ id: "ON-S", side: "SELL", qty: 100, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const pv = await (await post({ action: "pull", broker: "dhan", accountId: A_PULL, mode: "preview" })).json();
    expect("autoClose" in pv.preview, "a preview pull states what it would close").toBe(true);
    expect(pv.preview.autoClose.closedWhole).toBe(1);

    stubDhan([{ id: "ON-S", side: "SELL", qty: 100, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const json = await (await post({ action: "pull", broker: "dhan", accountId: A_PULL, mode: "commit" })).json();
    // THE assertion (revert `writeOpts` in app/api/import/broker/route.ts and
    // this is [1, 1] — two open rows, the v4.2.0 outcome).
    expect(rowsOf(A_PULL).map((r) => [r.buy_qty, r.sell_qty, r.is_open])).toEqual([[100, 100, 0]]);
    expect(json.result.autoClose.closedWhole).toBe(1);
    // The card's line is the composer's, and it names the close rather than
    // claiming "0 added" about a book that moved.
    expect(bc.pullResultMessage("commit", json).startsWith("Committed — 0 added, 1 position closed, 0 duplicates skipped.")).toBe(true);
  });
});

// ===========================================================================
// (3) the SCHEDULED JOB has no toggle: always on
// ===========================================================================

describe("(3) the auto-pull sweep runs with auto-close ON and says so", () => {
  it("its line reads '1 position closed', never '+1 trade' and never '+0 trades'", async () => {
    addDhan(A_JOB, stampOn(-4), ENROLLED);
    stubDhan([{ id: "JB-B", side: "BUY", qty: 100, price: 100, at: `${istDay(-3)} 09:30:00` }]);
    expect((await post({ action: "pull", broker: "dhan", accountId: A_JOB, mode: "commit" })).status).toBe(200);
    expect(rowsOf(A_JOB).map((r) => r.is_open)).toEqual([1]);
    // Put the stamp back so the sweep's catch-up window reaches the sale.
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(stampOn(-4), A_JOB);

    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    stubDhan([{ id: "JB-S", side: "SELL", qty: 100, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const out = await job.runAutoPull(new Date());
    const mine = out.summary.find((e) => e.broker === "dhan" && e.accountId === A_JOB);
    expect(mine?.status).toBe("imported");
    // THE assertion (revert `autoClose: true` in lib/jobs/auto-pull.ts and this
    // reads "+1 trade", about a sale that landed as its own open row).
    expect(mine?.detail).toBe("1 position closed");
    expect(mine?.detail, "never '+0 trades' about a book that moved").not.toMatch(/\+0 trade/);
    expect(out.line).toContain("Dhan 1 position closed");
    expect(rowsOf(A_JOB).map((r) => [r.buy_qty, r.sell_qty, r.is_open])).toEqual([[100, 100, 0]]);
  });
});

// ===========================================================================
// (4) the per-import toggle INVERTS it
// ===========================================================================

describe("(4) `keepSellsSeparate` is the escape hatch: the same bytes, one extra field", () => {
  it("ticked, the preview plans nothing and the commit leaves two open rows", async () => {
    selectAccount(A_KEEP);
    expect((await postFile(A_KEEP, gtr(BUY_ROW), "commit", true)).status).toBe(200);
    const pj = await (await postFile(A_KEEP, gtr(SELL_ROW), "preview", true)).json();
    // THE assertion (revert the inversion — `autoClose: !keepSellsSeparate` —
    // and the plan appears here even though the user asked for separate rows).
    expect("autoClose" in pj.preview, "nothing is planned when the box is ticked").toBe(false);

    const cj = await (await postFile(A_KEEP, gtr(SELL_ROW), "commit", true)).json();
    expect(cj.result.added).toBe(1);
    expect(cj.result.autoClose ?? null, "no counters when auto-close did not run").toBeNull();
    expect(rowsOf(A_KEEP).map((r) => [r.buy_qty, r.sell_qty, r.is_open])).toEqual([
      [10, 0, 1],
      [0, 10, 1],
    ]);
    // The headline is the plain one: nothing was closed.
    expect(ic.importedHeadline(cj.result)).toBe("Imported 1 trade · 0 duplicates skipped.");
  });

  it("the pull route inverts the SAME field (a pull with the box ticked leaves the pair)", async () => {
    addDhan(A_KEEP, stampOn(-4));
    stubDhan([{ id: "KP-B", side: "BUY", qty: 50, price: 100, at: `${istDay(-3)} 09:30:00` }]);
    expect((await post({ action: "pull", broker: "dhan", accountId: A_KEEP, mode: "commit", keepSellsSeparate: true })).status).toBe(200);
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(stampOn(-4), A_KEEP);
    stubDhan([{ id: "KP-S", side: "SELL", qty: 50, price: 120, at: `${istDay(-2)} 14:00:00` }]);
    const json = await (await post({ action: "pull", broker: "dhan", accountId: A_KEEP, mode: "commit", keepSellsSeparate: true })).json();
    expect(json.result.added).toBe(1);
    expect(json.result.autoClose ?? null).toBeNull();
    // The TCS pair is beside the file case's rows; both TCS rows stay open.
    const tcs = t.sqlite
      .prepare("SELECT buy_qty, sell_qty, is_open FROM trades WHERE account_id = ? AND tradingsymbol = 'TCS' ORDER BY id")
      .all(A_KEEP) as { buy_qty: number; sell_qty: number; is_open: number }[];
    expect(tcs.map((r) => [r.buy_qty, r.sell_qty, r.is_open])).toEqual([
      [50, 0, 1],
      [0, 50, 1],
    ]);
  });
});

// ===========================================================================
// (5) the result card's HEADLINE — pure, no DB
// ===========================================================================

describe("(5) the import result headline never says 'Imported 0 trades' about a book that moved", () => {
  it("added 0 and one position closed reads as the close", () => {
    // `added` counts rows INSERTED, and a lot consumed whole is CONVERTED in
    // place — so this is the commonest auto-close outcome there is.
    expect(ic.importedHeadline({ added: 0, skipped: 0, autoClose: counters({ closedWhole: 1 }) })).toBe(
      "Closed 1 position you already held · 0 duplicates skipped.",
    );
    expect(ic.importedHeadline({ added: 0, skipped: 0, autoClose: counters({ closedWhole: 1 }) })).not.toMatch(/Imported 0/);
  });

  it("plurals, and the mixed case keeps both halves", () => {
    expect(ic.importedHeadline({ added: 0, skipped: 2, autoClose: counters({ closedWhole: 3 }) })).toBe(
      "Closed 3 positions you already held · 2 duplicates skipped.",
    );
    expect(ic.importedHeadline({ added: 4, skipped: 0, autoClose: counters({ closedWhole: 1 }) })).toBe(
      "Imported 4 trades · closed 1 position · 0 duplicates skipped.",
    );
  });

  it("with no close it is v4.2.0's line, character for character", () => {
    expect(ic.importedHeadline({ added: 1, skipped: 1 })).toBe("Imported 1 trade · 1 duplicate skipped.");
    expect(ic.importedHeadline({ added: 0, skipped: 0, autoClose: counters({}) })).toBe("Imported 0 trades · 0 duplicates skipped.");
  });
});

/** The full `AutoCloseCounters` shape with everything but the named field zero. */
function counters(over: Partial<ic2.CommitAutoClose>): ic2.CommitAutoClose {
  return {
    closedWhole: 0,
    reduced: 0,
    openedNew: 0,
    closedAgainstStoredLot: 0,
    closedAgainstThisFilesLot: 0,
    refusedNoDate: 0,
    refusedMonthOnly: 0,
    refusedHeldIdentity: 0,
    ...over,
  };
}

// ===========================================================================
// (6) `closedBy` on the wire row — the ONLY thing that offers "Un-close"
// ===========================================================================

const HASH_EXEC = "a".repeat(40);
const HASH_JOIN = "b".repeat(40);
const HASH_THREAD = "c".repeat(40);

describe("(6) /trades derives `closedBy` from the row's OWN words, and the notes stay off the wire", () => {
  beforeAll(() => {
    t.db
      .insert(t.schema.trades)
      .values([
        // A plain imported row: no notes at all.
        tradeRow({
          accountId: A_PROJ, symbol: "PLAIN", tradingsymbol: "PLAIN", isOpen: false,
          buyDate: "2026-07-01", sellDate: "2026-07-02", dedupHash: "d".repeat(40), importNotes: null,
        }),
        // A Data Quality stale-lot JOIN (R26): an alias and nothing else. It is
        // NOT an auto-close piece — it has its own door, and offering un-close
        // here would offer a button the server refuses.
        tradeRow({
          accountId: A_PROJ, symbol: "DQJOIN", tradingsymbol: "DQJOIN", isOpen: false,
          buyDate: "2026-07-03", sellDate: "2026-07-04", dedupHash: "e".repeat(40),
          importNotes: `${DEDUP_ALIAS_PREFIX}${HASH_JOIN}`,
        }),
        // A lot an import consumed WHOLE: converted in place, so it keeps its
        // own hash and holds the EXECUTION's as an alias (the one-holder rule).
        tradeRow({
          accountId: A_PROJ, symbol: "CONV", tradingsymbol: "CONV", isOpen: false,
          buyDate: "2026-07-05", sellDate: "2026-07-06", dedupHash: "f".repeat(40),
          importNotes: `${AUTO_CLOSE_NOTE} | ${DEDUP_ALIAS_PREFIX}${HASH_EXEC}`,
        }),
        // A leftover piece: no alias, only the `closed-by:` thread.
        tradeRow({
          accountId: A_PROJ, symbol: "LEFT", tradingsymbol: "LEFT", isOpen: true,
          buyDate: "2026-07-07", dedupHash: "9".repeat(40),
          importNotes: `${CLOSED_BY_PREFIX}${HASH_THREAD}`,
        }),
      ])
      .run();
  });

  const wire = () => {
    selectAccount(A_PROJ);
    const rows = tradesPage.getTradesPage(
      { q: "", broker: "", segment: "", bucket: "", view: "all", realised: false, basisUnknown: false, from: "", to: "" },
      null,
      1_000,
    ).rows;
    return new Map(rows.map((r) => [r.tradingsymbol, r]));
  };

  it("a plain row and a Data Quality join get NO un-close; a converted lot and a leftover name their execution", () => {
    const m = wire();
    // THE assertion (revert `toWireRow` in lib/queries/trades-page.ts and every
    // one of these is `undefined` — the button would never appear at all).
    expect(m.get("PLAIN")!.closedBy, "a row nothing closed").toBeNull();
    expect(m.get("DQJOIN")!.closedBy, "an alias of unknown provenance is not an auto-close piece").toBeNull();
    expect(m.get("CONV")!.closedBy, "a converted lot answers with the EXECUTION's hash, not its own").toBe(HASH_EXEC);
    expect(m.get("LEFT")!.closedBy, "the `closed-by:` thread wins").toBe(HASH_THREAD);
  });

  it("the two columns the derivation reads do NOT reach the wire row", () => {
    // They are selected so the derivation costs no second query, and dropped
    // again: `import_notes` is the widest free-text column in the table and has
    // no business crossing the RSC payload for every row on screen.
    for (const [sym, row] of wire()) {
      expect(Object.keys(row), `${sym} must not carry import_notes`).not.toContain("importNotes");
      expect(Object.keys(row), `${sym} must not carry dedup_hash`).not.toContain("dedupHash");
    }
  });
});

// ===========================================================================
// (8) v4.8.0 X1 D10 — PREVIEW = COMMIT on a row that SUPERSEDES today's earlier snapshot
// ===========================================================================

/**
 * PROBE-2 (X1-REVIEW-2026-10-05.md): the 11:00 sale lands with no lot; the
 * older buy arrives from a FILE; the 15:00 pull states 150. The preview skipped
 * the applier on the superseding row (`!snapshot.supersede.has(i)`) while the
 * commit ran it: 2a (lot 150) consumed the row whole and `continue`d past the
 * supersede, so the 11:00 row SURVIVED beside the close — 225 sold against the
 * broker's 150, preview net −64.43 against commit net 2903.39; 2b (lot 75) wrote
 * the remainder over the 11:00 row without its `closed-by:` / `exec-bill:` thread.
 * D10 (review: NOT conditional): the commit skips the applier exactly as the
 * preview does. End state: the sale restated in place, the lot open beside it,
 * listed in Data Quality.
 */
describe("(8) X1 D10 — a superseding row never runs the applier, in the commit as in the preview (PROBE-2a / 2b)", () => {
  let commit: typeof import("@/lib/import/commit");
  const A_2A = 76;
  const A_2B = 77;
  const DAY2 = "2026-09-15";
  const PULL = `angelone-api-${DAY2}`;
  const SYM = "NIFTY2692225000CE";
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const row = (over: Record<string, unknown>) =>
    ({
      broker: "angelone", isin: null, buyQty: 0, avgBuyPrice: 0, buyValue: 0, sellQty: 0, avgSellPrice: 0, sellValue: 0,
      closingPrice: null, grossPnl: 0, unrealisedPnl: 0, buyDate: null, sellDate: null, productHint: null, exchangeHint: "NSE",
      sourceFile: null, tradingsymbol: SYM, ...over,
    }) as unknown as import("@/lib/engine/types").NormalizedTrade;
  const sale = (qty: number) => row({ sellQty: qty, avgSellPrice: 140, sellValue: r2(qty * 140), sellDate: DAY2 });
  const file = (trades: unknown[], sourceId = "angelone-api") =>
    ({ sourceId, broker: "angelone", format: "api", trades, warnings: [] }) as unknown as import("@/lib/import/types").ParsedFile;
  const all = (acc: number) =>
    t.sqlite.prepare("SELECT id, tradingsymbol, is_open, buy_qty, sell_qty, import_notes FROM trades WHERE account_id = ? ORDER BY id").all(acc) as {
      id: number; tradingsymbol: string; is_open: number; buy_qty: number; sell_qty: number; import_notes: string | null;
    }[];

  beforeAll(async () => {
    commit = await import("@/lib/import/commit");
    t.db.insert(t.schema.accounts).values([{ id: A_2A, name: "X1 probe-2a" }, { id: A_2B, name: "X1 probe-2b" }]).run();
  });

  for (const [acc, lotQty, label] of [[A_2A, 150, "2a — a lot of 150: the row is consumed whole on HEAD"], [A_2B, 75, "2b — a lot of 75: a remainder is written over the 11:00 row on HEAD"]] as const) {
    it(`${label}; now the 11:00 row is restated in place and the lot stays open — preview = commit to the paisa`, () => {
      selectAccount(acc);
      const snap = { supersedeSnapshot: { fileName: PULL }, autoClose: true };
      // 11:00 — the sale, with no lot to close: an opening sell.
      expect(commit.commitParsedFile(file([sale(75)]), PULL, null, acc, snap).added).toBe(1);
      const eleven = all(acc)[0]!;
      // The older buy arrives from a FILE (a sale with an unknown basis is not a lot — it lands open).
      expect(commit.commitParsedFile(file([row({ buyQty: lotQty, avgBuyPrice: 120, buyValue: r2(lotQty * 120), buyDate: "2026-09-10" })], "angelone-tradebook"), "angelone-tradebook-prev.csv", null, acc, { autoClose: true }).added).toBe(1);
      expect(all(acc).map((r) => [r.buy_qty, r.sell_qty, r.is_open])).toEqual([[0, 75, 1], [lotQty, 0, 1]]);

      // 15:00 — the same pull states 150.
      const pre = commit.previewParsedFile(file([sale(150)]), null, acc, PULL, snap);
      expect(pre.summary.supersededCount).toBe(1);
      expect(pre.autoClose?.closedWhole, "the preview skips the applier on the superseding row").toBe(0);
      const res = commit.commitParsedFile(file([sale(150)]), PULL, null, acc, snap);
      // THE assertion (D10): on HEAD 3502995 the commit's `autoClose.closedWhole`
      // was 1 and its net 2903.39 (2a) / 1440.39 (2b) against the preview's −64.43.
      expect(res.autoClose?.closedWhole).toBe(0);
      expect(res.autoClose).toEqual(pre.autoClose);
      // NET: no close is realised on either side. The preview's row net is the
      // restated row's own bill (what the supersede stores on it); the commit's
      // `netPnl` counts ADDED rows only (R43: a superseded row is neither added
      // nor skipped), so it is 0 — on HEAD it carried the close's 2903.39 / 1440.39.
      expect(res.added).toBe(0);
      expect(r2(res.netPnl)).toBe(0);
      expect(res.warnings).toContain("1 position updated from today's earlier pull.");

      const after = all(acc);
      const storedNet = (t.sqlite.prepare("SELECT net_pnl_paise AS p FROM trades WHERE id = ?").get(eleven.id) as { p: number }).p / 100;
      expect(r2(pre.rows[0]!.netPnl), "the preview's row net is what the supersede stored on the row").toBe(r2(storedNet));
      expect(storedNet, "a sale alone realises nothing: its net is its own bill").toBeLessThan(0);
      expect(after.map((r) => [r.id, r.buy_qty, r.sell_qty, r.is_open])).toEqual([[eleven.id, 0, 150, 1], [after[1]!.id, lotQty, 0, 1]]);
      expect(after.reduce((s, r) => s + r.sell_qty, 0), "the broker sold 150").toBe(150);
      // 2b's second half: nothing of a close is written over the restated row.
      expect(after[0]!.import_notes ?? "").not.toMatch(/closed-by:|exec-bill:|exec-origin:/);
    });
  }
});

// ===========================================================================
// (7) the LIBRARY default — referenced, not duplicated
// ===========================================================================

describe("(7) the library default is still OFF", () => {
  it("is pinned in tests/auto-close-off.test.ts, and that file is present", async () => {
    // One rule, one owner. `commitParsedFile` with no options still leaves a
    // BUY and a SELL open — every case in that file says so, and its "(iv)"
    // block pins that the flip lives at the callers. This case exists so the
    // reference cannot rot away silently.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "auto-close-off.test.ts"), "utf8");
    expect(src).toContain("the LIBRARY default is OFF; W2b turns it on at the CALLERS");
  });
});
