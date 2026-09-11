import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assessDataQuality,
  crossAccountIssues,
  isPlainDuplicateCopy,
  NO_PLAIN_COPY_NOTE,
  type DuplicateConnectionGroup,
  type DuplicateTradeGroup,
  type QualityTrade,
  type QualityInputs,
  type QualityReport,
} from "@/lib/analytics/data-quality";
// PURE (no DB, no React), so a static import here cannot bind lib/db before
// openTempDb() sets VYUHA_DB_PATH.
import { withLotCloseNote } from "@/lib/import/close-open-lots";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

// The fix path is a server action; `revalidatePath` needs a request scope that
// a unit test does not have, and it is not what is under test here.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * B1 — the Data Quality Center's job is to say which numbers elsewhere in the
 * app cannot yet be trusted, and why.
 *
 * Two properties are worth pinning hard. First, severity is not decoration:
 * "critical" is reserved for gaps that change MONEY (an unknown cost basis
 * makes P&L, tax, expectancy and ROM all wrong), while a missing sector tag is
 * merely "info". Second, the score must be bounded and monotone — more gaps can
 * never raise it, and no single issue may swamp the whole score.
 */

const trade = (p: Partial<QualityTrade> = {}): QualityTrade => ({
  id: 1,
  isOpen: false,
  acquisition: null,
  acquisitionPrice: null,
  closingPrice: null,
  slPlanned: 90,
  riskAmount: 1000,
  segment: "eq_delivery",
  mtfFundedAmount: null,
  instrumentType: "equity",
  expiry: null,
  strike: null,
  optionType: null,
  symbol: "ABC",
  ...p,
});

const inputs = (p: Partial<QualityInputs> = {}): QualityInputs => ({
  trades: [],
  markedTradeIds: new Set(),
  knownSymbols: new Set(["ABC"]),
  ipoLinkedTradeIds: new Set(),
  staleMtmCount: 0,
  missingAttachmentFiles: 0,
  ...p,
});

const codes = (r: QualityReport) => r.issues.map((x) => x.code);
const find = (r: QualityReport, code: string) => r.issues.find((x) => x.code === code);

describe("data quality — a clean book", () => {
  it("scores complete records at 100 with no issues raised", () => {
    const r = assessDataQuality(inputs({ trades: [trade()] }));
    expect(r.score).toBe(100);
    expect(r.issues).toHaveLength(0);
    expect(r.affected).toBe(0);
    expect(r.checked).toBe(1);
  });

  it("scores an empty journal at 100 rather than 0", () => {
    // Nothing recorded is not the same as everything broken.
    const r = assessDataQuality(inputs());
    expect(r.score).toBe(100);
    expect(r.checked).toBe(0);
  });

  it("never raises an issue with a zero count", () => {
    const r = assessDataQuality(inputs({ trades: [trade()] }));
    for (const i of r.issues) expect(i.count).toBeGreaterThan(0);
  });
});

describe("data quality — critical gaps change money", () => {
  it("flags a sale with no acquisition cost as critical", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ acquisition: "unknown", acquisitionPrice: null })] }));
    expect(find(r, "unknown_basis")?.severity).toBe("critical");
    expect(find(r, "unknown_basis")?.count).toBe(1);
  });

  it("treats a zero or negative basis as unknown, not as a free acquisition", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ acquisition: "ipo", acquisitionPrice: 0 })] })), "unknown_basis")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ acquisition: "ipo", acquisitionPrice: -5 })] })), "unknown_basis")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ acquisition: "ipo", acquisitionPrice: 100 })] })), "unknown_basis")).toBeUndefined();
  });

  it("flags an open position with no mark as critical", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ id: 2, isOpen: true, closingPrice: null })] }));
    expect(find(r, "unmarked_open")?.severity).toBe("critical");
  });

  it("accepts a mark from either the trade's own close or the MTM table", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ isOpen: true, closingPrice: 105 })] })), "unmarked_open")).toBeUndefined();
    expect(find(assessDataQuality(inputs({ trades: [trade({ id: 7, isOpen: true })], markedTradeIds: new Set([7]) })), "unmarked_open")).toBeUndefined();
  });

  /**
   * v4.2 — AN ISSUE NOBODY CAN CLEAR IS NOT A DATA-QUALITY ISSUE.
   *
   * "Open positions without a mark" counted open FUTURES and OPTIONS and
   * pointed at /equity. A typed mark for a contract is refused there by design:
   * `mtm_prices` is keyed on the SYMBOL and `getMtmMap()` reads mtm[symbol]
   * first, so M1 (`lib/quotes/persist-mark.ts`) skips derivative rows rather
   * than pricing the cash position at the option's price. The result was a
   * permanent critical issue, a permanently depressed score, and a link to a
   * screen that could not fix it.
   */
  it("does not ask a DERIVATIVE for a mark it has no place to put", () => {
    const future = trade({ id: 11, isOpen: true, closingPrice: null, instrumentType: "future" });
    const option = trade({ id: 12, isOpen: true, closingPrice: null, instrumentType: "option", expiry: "2026-09-24", strike: 24000, optionType: "CE" });
    expect(find(assessDataQuality(inputs({ trades: [future] })), "unmarked_open")).toBeUndefined();
    expect(find(assessDataQuality(inputs({ trades: [option] })), "unmarked_open")).toBeUndefined();

    // …and an unmarked CASH position in the same book is still counted, alone.
    const cash = trade({ id: 13, isOpen: true, closingPrice: null });
    const both = find(assessDataQuality(inputs({ trades: [future, option, cash] })), "unmarked_open");
    expect(both?.count).toBe(1);
    expect(both?.ids).toEqual([13]);
    expect(both?.href).toBe("/equity");
  });

  it("does not ask a closed position for a mark", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ isOpen: false, closingPrice: null })] }));
    expect(find(r, "unmarked_open")).toBeUndefined();
  });
});

describe("data quality — warnings", () => {
  it("flags an open position missing either a stop or a risk amount", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ isOpen: true, closingPrice: 1, slPlanned: null })] })), "missing_stop")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ isOpen: true, closingPrice: 1, riskAmount: null })] })), "missing_stop")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ isOpen: true, closingPrice: 1 })] })), "missing_stop")).toBeUndefined();
  });

  it("asks MTF positions — and only MTF positions — for a funded principal", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ segment: "eq_mtf", mtfFundedAmount: null })] })), "mtf_funding")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ segment: "eq_delivery", mtfFundedAmount: null })] })), "mtf_funding")).toBeUndefined();
  });

  it("asks options for expiry, strike and CE/PE", () => {
    const complete = trade({ instrumentType: "option", expiry: "2026-08-27", strike: 24000, optionType: "CE" });
    expect(find(assessDataQuality(inputs({ trades: [complete] })), "option_contract")).toBeUndefined();
    expect(find(assessDataQuality(inputs({ trades: [{ ...complete, expiry: null }] })), "option_contract")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [{ ...complete, strike: null }] })), "option_contract")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [{ ...complete, optionType: null }] })), "option_contract")?.count).toBe(1);
  });

  it("does not ask an equity trade for option metadata", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ instrumentType: "equity" })] }));
    expect(find(r, "option_contract")).toBeUndefined();
  });

  it("flags an IPO holding that is not linked to an IPO record", () => {
    expect(find(assessDataQuality(inputs({ trades: [trade({ id: 3, acquisition: "ipo", acquisitionPrice: 100 })] })), "ipo_link")?.count).toBe(1);
    expect(find(assessDataQuality(inputs({ trades: [trade({ id: 3, acquisition: "ipo", acquisitionPrice: 100 })], ipoLinkedTradeIds: new Set([3]) })), "ipo_link")).toBeUndefined();
  });

  it("passes through externally-counted gaps", () => {
    const r = assessDataQuality(inputs({ staleMtmCount: 4, missingAttachmentFiles: 2 }));
    expect(find(r, "stale_mtm")?.count).toBe(4);
    expect(find(r, "stale_mtm")?.severity).toBe("info");
    expect(find(r, "missing_attachment")?.count).toBe(2);
    expect(find(r, "missing_attachment")?.severity).toBe("warning");
  });
});

describe("data quality — instrument master", () => {
  it("counts unknown SYMBOLS, not unknown trades", () => {
    // Twenty trades in one unlisted scrip is one gap to fix, not twenty.
    const trades = [1, 2, 3].map((id) => trade({ id, symbol: "MYSTERY" }));
    const r = assessDataQuality(inputs({ trades, knownSymbols: new Set(["ABC"]) }));
    expect(find(r, "instrument_master")?.count).toBe(1);
  });

  it("matches the instrument master case-insensitively", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ symbol: "abc" })], knownSymbols: new Set(["ABC"]) }));
    expect(find(r, "instrument_master")).toBeUndefined();
  });
});

describe("data quality — the score", () => {
  it("weights critical above warning above info for the same count", () => {
    const critical = assessDataQuality(inputs({ trades: [trade({ acquisition: "unknown" })] })).score;
    const warning = assessDataQuality(inputs({ trades: [trade({ segment: "eq_mtf" })] })).score;
    const info = assessDataQuality(inputs({ staleMtmCount: 1 })).score;
    expect(critical).toBeLessThan(warning);
    expect(warning).toBeLessThan(info);
    expect(info).toBeLessThan(100);
  });

  it("caps any single issue's penalty so one gap cannot swamp the score", () => {
    const many = Array.from({ length: 500 }, (_, i) => trade({ id: i + 1, acquisition: "unknown" }));
    const r = assessDataQuality(inputs({ trades: many }));
    expect(r.score).toBeGreaterThan(0);
  });

  it("never falls below 0 however broken the book is", () => {
    const wrecked = Array.from({ length: 200 }, (_, i) =>
      trade({ id: i + 1, isOpen: true, acquisition: "unknown", slPlanned: null, riskAmount: null, segment: "eq_mtf", instrumentType: "option", symbol: "NOPE" }),
    );
    const r = assessDataQuality(inputs({ trades: wrecked, knownSymbols: new Set(), staleMtmCount: 99, missingAttachmentFiles: 99 }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("is monotone — adding a broken trade never raises the score", () => {
    const clean = assessDataQuality(inputs({ trades: [trade()] }));
    const dirty = assessDataQuality(inputs({ trades: [trade(), trade({ id: 2, acquisition: "unknown" })] }));
    expect(dirty.score).toBeLessThanOrEqual(clean.score);
  });
});

describe("data quality — remediation", () => {
  it("gives every issue somewhere to go", () => {
    const r = assessDataQuality(
      inputs({
        trades: [trade({ id: 1, isOpen: true, acquisition: "unknown", slPlanned: null, segment: "eq_mtf", instrumentType: "option", symbol: "NOPE" })],
        knownSymbols: new Set(),
        staleMtmCount: 1,
        missingAttachmentFiles: 1,
      }),
    );
    expect(r.issues.length).toBeGreaterThan(5);
    for (const i of r.issues) {
      expect(i.href.startsWith("/")).toBe(true);
      expect(i.title.length).toBeGreaterThan(0);
      expect(i.detail.length).toBeGreaterThan(0);
    }
  });

  it("counts each affected trade once even when it fails several checks", () => {
    const r = assessDataQuality(inputs({ trades: [trade({ id: 42, isOpen: true, acquisition: "unknown", slPlanned: null, riskAmount: null })] }));
    expect(codes(r).length).toBeGreaterThan(1);
    expect(r.affected).toBe(1);
  });

  it("caps the id list it hands back so a huge book cannot bloat the payload", () => {
    const many = Array.from({ length: 300 }, (_, i) => trade({ id: i + 1, acquisition: "unknown" }));
    const r = assessDataQuality(inputs({ trades: many }));
    const issue = find(r, "unknown_basis")!;
    expect(issue.count).toBe(300); // the real number is still reported
    expect(issue.ids!.length).toBe(100); // only the list is truncated
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * B4 (v4.2.1) — the two CROSS-ACCOUNT issues, and the one-click fix.
 *
 * The dedup hash carries no account id (lib/import/dedup.ts) and the unique
 * index that enforces it is per account (`trades_account_broker_dedup_uq`), so
 * one broker record imported into two accounts is stored twice and the
 * All-accounts view sums both copies. Neither fact is visible to a
 * single-account read, which is why both are resolved outside the pure module
 * and handed in already grouped and already MASKED.
 * ═══════════════════════════════════════════════════════════════════════════ */

const connGroup = (p: Partial<DuplicateConnectionGroup> = {}): DuplicateConnectionGroup => ({
  broker: "dhan",
  brokerLabel: "Dhan",
  maskedIdentity: "110…••••",
  accounts: [
    { id: 1, name: "Primary" },
    { id: 2, name: "Swing" },
  ],
  ...p,
});

const tradeGroup = (p: Partial<DuplicateTradeGroup> = {}): DuplicateTradeGroup => ({
  broker: "dhan",
  brokerLabel: "Dhan",
  dedupHash: "a1b2c3d4e5f6a1b2c3d4",
  symbol: "TCS",
  qty: 10,
  buyDate: "2026-07-01",
  sellDate: "2026-07-09",
  rows: 2,
  ids: [11, 22],
  accounts: [
    { id: 1, name: "Primary", rows: 1, removable: true },
    { id: 2, name: "Swing", rows: 1, removable: true },
  ],
  ...p,
});

const dupTradeIssues = (r: QualityReport) => r.issues.filter((x) => x.code.startsWith("duplicate_trades:"));
const dupConnIssues = (r: QualityReport) => r.issues.filter((x) => x.code.startsWith("duplicate_connection:"));

describe("data quality — trades duplicated across accounts", () => {
  it("raises ONE issue for a (broker, dedupHash) group held in two accounts, naming both", () => {
    const r = assessDataQuality(inputs({ duplicateTradeGroups: [tradeGroup()] }));
    const dup = dupTradeIssues(r);

    // One issue per duplicated RECORD — the unit a user can act on.
    expect(dup).toHaveLength(1);
    // …carrying the ROW count (both copies), not the number of accounts.
    expect(dup[0].count).toBe(2);
    expect(dup[0].severity).toBe("critical");
    expect(dup[0].detail).toContain("Primary");
    expect(dup[0].detail).toContain("Swing");
    expect(dup[0].title).toContain("TCS");
    expect(dup[0].href).toBe("/data-quality#duplicates");
    expect(dup[0].ids).toEqual([11, 22]);
    expect(r.affected).toBe(2);
  });

  it("says nothing about a sole copy", () => {
    const sole = tradeGroup({ rows: 1, ids: [11], accounts: [{ id: 1, name: "Primary", rows: 1, removable: true }] });
    expect(dupTradeIssues(assessDataQuality(inputs({ duplicateTradeGroups: [sole] })))).toHaveLength(0);
    expect(dupTradeIssues(assessDataQuality(inputs({ duplicateTradeGroups: [] })))).toHaveLength(0);
    expect(dupTradeIssues(assessDataQuality(inputs()))).toHaveLength(0);
  });

  it("gives every group its own code, because the screen keys on it", () => {
    const r = assessDataQuality(
      inputs({
        duplicateTradeGroups: [
          tradeGroup(),
          tradeGroup({ dedupHash: "ffffffffffffffffffff", symbol: "INFY", ids: [33, 44] }),
        ],
      }),
    );
    const codes = dupTradeIssues(r).map((x) => x.code);
    expect(codes).toHaveLength(2);
    expect(new Set(codes).size).toBe(2);
  });

  it("counts a critical duplicate against the score", () => {
    const clean = assessDataQuality(inputs()).score;
    const dirty = assessDataQuality(inputs({ duplicateTradeGroups: [tradeGroup()] })).score;
    expect(dirty).toBeLessThan(clean);
  });
});

describe("data quality — one broker client connected in several accounts", () => {
  it("raises one issue per duplicated identity, naming the accounts and the count", () => {
    const r = assessDataQuality(inputs({ duplicateConnections: [connGroup()] }));
    const dup = dupConnIssues(r);

    expect(dup).toHaveLength(1);
    expect(dup[0].count).toBe(2); // accounts holding it
    expect(dup[0].severity).toBe("warning"); // nothing is wrong in the numbers YET
    expect(dup[0].title).toContain("2 accounts");
    expect(dup[0].detail).toContain("Primary");
    expect(dup[0].detail).toContain("Swing");
    expect(dup[0].href).toBe("/data-quality#duplicates");
  });

  it("shows only the masked identity it was handed", () => {
    const r = assessDataQuality(inputs({ duplicateConnections: [connGroup({ maskedIdentity: "110…••••" })] }));
    const text = JSON.stringify(dupConnIssues(r));
    expect(text).toContain("110…••••");
    expect(text).not.toContain("1100112233");
  });

  it("says nothing about a client in one account only", () => {
    const sole = connGroup({ accounts: [{ id: 1, name: "Primary" }] });
    expect(dupConnIssues(assessDataQuality(inputs({ duplicateConnections: [sole] })))).toHaveLength(0);
    expect(dupConnIssues(assessDataQuality(inputs()))).toHaveLength(0);
  });

  it("is exported on its own, so the screen can resolve the two without re-deriving the report", () => {
    const issues = crossAccountIssues({ duplicateConnections: [connGroup()], duplicateTradeGroups: [tradeGroup()] });
    expect(issues.map((x) => x.severity)).toEqual(["warning", "critical"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * M-5 (v4.3.0, ruling 2026-09-10) — REMOVING A COPY MUST NOT DELETE A MERGED
 * LOT.
 *
 * After R5's auto-close a row can be BOTH one account's copy of a record and
 * the row that closed a lot that account was holding: it keeps its own hash and
 * carries the consumed execution's hash as an alias. "Remove the copy in
 * <account>" on such a row is data loss. Only a PLAIN single-source row is
 * removable, and the rule is one function, read by the button and re-read by
 * the server action.
 * ═══════════════════════════════════════════════════════════════════════════ */

const HASH_A = "1".repeat(40);
const HASH_B = "2".repeat(40);

describe("isPlainDuplicateCopy — the removability rule, all three clauses", () => {
  it("passes a plain single-source row: own hash, no alias, no auto-close", () => {
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A], autoClosed: false }, HASH_A)).toBe(true);
  });

  it("refuses a row that joins the group only through an ALIAS — its own record is elsewhere", () => {
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A, HASH_B], autoClosed: true }, HASH_B)).toBe(false);
  });

  it("refuses a MERGED LOT even on its own hash — the row stands for two records", () => {
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A, HASH_B], autoClosed: true }, HASH_A)).toBe(false);
  });

  it("refuses a row the importer marked auto-closed even when no alias survived", () => {
    // Clause 3 is not clause 2: the alias derivation is best effort, the mark
    // is a fact the importer wrote.
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A], autoClosed: true }, HASH_A)).toBe(false);
  });

  it("refuses a row whose own hash is some other record entirely", () => {
    expect(isPlainDuplicateCopy({ identityHashes: [HASH_A], autoClosed: false }, HASH_B)).toBe(false);
  });
});

describe("the sentence a group with no plain copy carries", () => {
  it("states what the rows are and where the pull ends — and advises nothing (SEBI copy rule)", () => {
    expect(NO_PLAIN_COPY_NOTE).toMatch(/Import → Disconnect/);
    expect(NO_PLAIN_COPY_NOTE).toMatch(/closed a position/);
    expect(NO_PLAIN_COPY_NOTE).not.toMatch(/\b(recommend|recommended|should|must|consider|suggest)\b/i);
    expect(NO_PLAIN_COPY_NOTE).not.toMatch(/\b(buy|sell)\b/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The fix, against a real migrated database.
 *
 * ONE temp database, one per file (AGENTS.md): lib/db caches its connection on
 * globalThis, so the query modules are imported dynamically AFTER the helper
 * has set VYUHA_DB_PATH.
 * ═══════════════════════════════════════════════════════════════════════════ */

let t: TempDb;
let actions: typeof import("@/app/data-quality/actions");
let identity: typeof import("@/lib/import/broker-identity");

const PRIMARY = 1;
const SWING = 2;
const SHARED_HASH = "shared-dedup-hash";

beforeAll(async () => {
  t = await openTempDb("data-quality", { seed: true });
  actions = await import("@/app/data-quality/actions");
  identity = await import("@/lib/import/broker-identity");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
});

afterAll(() => t?.cleanup());

/** Both copies of ONE broker record, one per account — what a user gets by
 *  importing the same file into two accounts. */
function seedDuplicate(hash = SHARED_HASH) {
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({ accountId: PRIMARY, broker: "dhan", symbol: "TCS", tradingsymbol: "TCS", dedupHash: hash, buyQty: 10, sellQty: 10, buyDate: "2026-07-01", sellDate: "2026-07-09" }),
      tradeRow({ accountId: SWING, broker: "dhan", symbol: "TCS", tradingsymbol: "TCS", dedupHash: hash, buyQty: 10, sellQty: 10, buyDate: "2026-07-01", sellDate: "2026-07-09" }),
    ])
    .run();
}

const tradesIn = (accountId: number) =>
  t.db.select().from(t.schema.trades).all().filter((r) => r.accountId === accountId);

const deleteAudits = () =>
  t.db.select().from(t.schema.auditLog).all().filter((a) => a.entity === "trade" && a.action === "delete");

beforeEach(() => {
  t.db.delete(t.schema.trades).run();
  t.db.delete(t.schema.auditLog).run();
  // The All-accounts view is where a cross-account duplicate is visible.
  t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
});

describe("the duplicate scan reads every account", () => {
  it("groups the two copies and counts the rows per account", () => {
    seedDuplicate();
    const groups = identity.listDuplicateTradeGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toBe(2);
    expect(groups[0].symbol).toBe("TCS");
    expect(groups[0].dedupHash).toBe(SHARED_HASH);
    expect(groups[0].accounts).toEqual([
      { id: PRIMARY, name: "Primary", rows: 1, removable: true },
      { id: SWING, name: "Swing", rows: 1, removable: true },
    ]);
  });

  it("says nothing about a sole copy", () => {
    t.db.insert(t.schema.trades).values(tradeRow({ accountId: PRIMARY, broker: "dhan", dedupHash: "only-here" })).run();
    expect(identity.listDuplicateTradeGroups()).toEqual([]);
    expect(identity.findDuplicateTradeGroup("dhan", "only-here")).toBeNull();
  });
});

describe("removeDuplicateCopy — the copy in ONE named account", () => {
  it("deletes that account's rows, leaves the other, and audits each one", async () => {
    seedDuplicate();
    const doomed = tradesIn(SWING).map((r) => r.id);

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: SWING });

    expect(res.ok).toBe(true);
    expect(res.removed).toBe(1);
    expect(tradesIn(SWING)).toHaveLength(0);
    expect(tradesIn(PRIMARY)).toHaveLength(1);

    // One audit row per deleted trade, written by the existing delete path.
    const audits = deleteAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(doomed[0]);
    expect(audits[0].source).toBe("data-quality");
  });

  it("refuses account 0 — the aggregate view is a view, not a place", async () => {
    seedDuplicate();
    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: 0 });

    expect(res.ok).toBe(false);
    // The refusal must be ITS OWN — "that account holds no copy" would be true
    // of id 0 by accident, and the accident is not the rule (invariant 9).
    expect(res.message).toContain("All accounts is a view, not an account");
    expect(res.removed).toBe(0);
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(tradesIn(SWING)).toHaveLength(1);
    expect(deleteAudits()).toHaveLength(0);
  });

  it("refuses a group that is NOT duplicated across accounts, so a stale screen cannot delete the sole copy", async () => {
    t.db.insert(t.schema.trades).values(tradeRow({ accountId: PRIMARY, broker: "dhan", dedupHash: SHARED_HASH })).run();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: PRIMARY });

    expect(res.ok).toBe(false);
    expect(res.removed).toBe(0);
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(deleteAudits()).toHaveLength(0);
  });

  it("refuses an account that holds no copy of the record", async () => {
    seedDuplicate();
    t.db.insert(t.schema.accounts).values({ id: 3, name: "Options", isDefault: false }).onConflictDoNothing().run();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: 3 });

    expect(res.ok).toBe(false);
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(tradesIn(SWING)).toHaveLength(1);
  });

  it("removing the second copy leaves the first: the record survives once", async () => {
    seedDuplicate();
    expect((await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: SWING })).ok).toBe(true);

    const again = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: PRIMARY });
    expect(again.ok).toBe(false);
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(identity.listDuplicateTradeGroups()).toEqual([]);
  });

  it("says which view can remove it when another single account is selected", async () => {
    seedDuplicate();
    t.db.update(t.schema.settings).set({ selectedAccountId: PRIMARY }).run();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: SHARED_HASH, accountId: SWING });

    expect(res.ok).toBe(false);
    expect(res.message).toContain("Swing");
    expect(tradesIn(SWING)).toHaveLength(1);
  });
});

/* ── M-5, against the database: the merged lot and the plain copy ─────────── */

/**
 * Primary bought TCS in one import and sold it in a later one, so the sale was
 * auto-closed into the lot: ONE row, born with the buy file's hash (`HASH_A`),
 * carrying the sale's hash (`HASH_B`) as an alias. The same sale was also
 * imported on its own into Swing, where it sits as a plain single-source row
 * under `HASH_B`.
 *
 * `HASH_B` is therefore held in two accounts — and exactly one of the two rows
 * may go.
 */
function seedMergedLotAndPlainCopy() {
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        accountId: PRIMARY,
        broker: "dhan",
        symbol: "TCS",
        dedupHash: HASH_A,
        importNotes: withLotCloseNote(null, HASH_B),
        buyQty: 10,
        sellQty: 10,
        buyDate: "2026-07-01",
        sellDate: "2026-07-09",
      }),
      tradeRow({
        accountId: SWING,
        broker: "dhan",
        symbol: "TCS",
        dedupHash: HASH_B,
        importNotes: null,
        buyQty: 0,
        sellQty: 10,
        sellDate: "2026-07-09",
      }),
    ])
    .run();
}

describe("a cross-account duplicate whose other copy is a MERGED LOT", () => {
  it("is a group at all — the scan reads ALIAS hashes, not just own hashes", () => {
    seedMergedLotAndPlainCopy();
    const groups = identity.listDuplicateTradeGroups();

    // Grouping on own hashes alone finds nothing here: the two rows do not
    // share a `dedup_hash` at all.
    expect(groups).toHaveLength(1);
    expect(groups[0].dedupHash).toBe(HASH_B);
    expect(groups[0].accounts.map((a) => a.id)).toEqual([PRIMARY, SWING]);
  });

  it("offers ONLY the plain copy: the merged lot is never removable", () => {
    seedMergedLotAndPlainCopy();
    const group = identity.findDuplicateTradeGroup("dhan", HASH_B)!;

    expect(group.accounts.find((a) => a.id === PRIMARY)!.removable).toBe(false);
    expect(group.accounts.find((a) => a.id === SWING)!.removable).toBe(true);
    // The ids a fix would take, per account — the merged lot's is not among them.
    expect(identity.duplicateTradeIdsIn("dhan", HASH_B, PRIMARY)).toEqual([]);
    expect(identity.duplicateTradeIdsIn("dhan", HASH_B, SWING)).toHaveLength(1);
  });

  it("the ACTION refuses the merged lot even when asked for it directly, and deletes nothing", async () => {
    seedMergedLotAndPlainCopy();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: HASH_B, accountId: PRIMARY });

    expect(res.ok).toBe(false);
    expect(res.removed).toBe(0);
    expect(res.message).toContain("merged lot");
    expect(tradesIn(PRIMARY)).toHaveLength(1);
    expect(tradesIn(SWING)).toHaveLength(1);
    expect(deleteAudits()).toHaveLength(0);
  });

  it("removes the plain copy, and the merged lot survives with both its identities", async () => {
    seedMergedLotAndPlainCopy();

    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: HASH_B, accountId: SWING });

    expect(res.ok).toBe(true);
    expect(res.removed).toBe(1);
    expect(tradesIn(SWING)).toHaveLength(0);
    const lot = tradesIn(PRIMARY);
    expect(lot).toHaveLength(1);
    expect(lot[0].dedupHash).toBe(HASH_A);
    expect(lot[0].importNotes).toContain(HASH_B);
    expect(identity.listDuplicateTradeGroups()).toEqual([]);
  });
});

/* ── D2: a group is described by the record it IS, not by its first row ──── */

const HASH_C = "3".repeat(40);

/**
 * The same sale in two books — and the row that comes FIRST is not the record.
 *
 * Primary bought 100 INFY on 2026-09-01 and later sold 40, so the sale was
 * auto-closed into that lot: what is left in Primary is a 60-share REMAINDER,
 * born with the buy file's hash (`HASH_A`) and carrying the sale's hash
 * (`HASH_B`) as an alias. Swing imported that same 40-share sale on its own,
 * where it is a plain single-source row under `HASH_B`.
 *
 * The group is keyed on `HASH_B` — a 40-share sale dated 2026-09-05 — and the
 * remainder lot is its first row. The lot's quantity and dates belong to the
 * BUY, so a group described from `rows[0]` tells the user that "60 × INFY,
 * 2026-09-01" is held twice: a different execution entirely, reported as a
 * critical issue.
 */
function seedRemainderLotAndPlainSale() {
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        accountId: PRIMARY,
        broker: "dhan",
        symbol: "INFY",
        tradingsymbol: "INFY",
        dedupHash: HASH_A,
        importNotes: withLotCloseNote(null, HASH_B),
        buyQty: 60,
        sellQty: 0,
        buyDate: "2026-09-01",
        sellDate: null,
      }),
      tradeRow({
        accountId: SWING,
        broker: "dhan",
        symbol: "INFY",
        tradingsymbol: "INFY",
        dedupHash: HASH_B,
        importNotes: null,
        buyQty: 0,
        sellQty: 40,
        buyDate: null,
        sellDate: "2026-09-05",
      }),
    ])
    .run();
}

describe("what a cross-account duplicate group SAYS it is", () => {
  it("takes its facts from the row whose OWN identity is the group, not from the first row", () => {
    seedRemainderLotAndPlainSale();
    const group = identity.findDuplicateTradeGroup("dhan", HASH_B)!;

    // The remainder lot really is first in the group — the defect's precondition.
    expect(group.ids[0]).toBe(tradesIn(PRIMARY)[0].id);
    expect(group.symbol).toBe("INFY");
    expect({ qty: group.qty, buyDate: group.buyDate, sellDate: group.sellDate }).toEqual({
      qty: 40,
      buyDate: null,
      sellDate: "2026-09-05",
    });
  });

  it("the sentence the user reads names the sale, not the lot that survived it", () => {
    seedRemainderLotAndPlainSale();
    const [issue] = crossAccountIssues({ duplicateTradeGroups: identity.listDuplicateTradeGroups() });

    expect(issue.detail).toContain("(40 × INFY, 2026-09-05)");
    expect(issue.detail).not.toContain("60 × INFY");
    expect(issue.detail).not.toContain("2026-09-01");
  });

  /**
   * U-2 (round 2) — EVERY book merged the sale, so no row here describes it.
   *
   * Both accounts hold a lot the sale was folded into: one 60 bought on the
   * 1st, one 25 bought on the 2nd. The group is real (both books account for
   * that sale) but nothing in it states the sale's own quantity or dates, and
   * borrowing a merged lot's printed "60 × INFY, 2026-09-01" beside a sentence
   * saying each copy closed a position — a different execution entirely.
   */
  function seedTwoMergedLots() {
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({ accountId: PRIMARY, broker: "dhan", symbol: "INFY", tradingsymbol: "INFY", dedupHash: HASH_A, importNotes: withLotCloseNote(null, HASH_B), buyQty: 60, sellQty: 0, buyDate: "2026-09-01" }),
        tradeRow({ accountId: SWING, broker: "dhan", symbol: "INFY", tradingsymbol: "INFY", dedupHash: HASH_C, importNotes: withLotCloseNote(null, HASH_B), buyQty: 25, sellQty: 0, buyDate: "2026-09-02" }),
      ])
      .run();
  }

  it("reports the quantity as UNKNOWN when NO row's own identity is the group — it borrows no lot's", () => {
    seedTwoMergedLots();

    const group = identity.findDuplicateTradeGroup("dhan", HASH_B)!;
    // Still a real duplicate, still named and still linked — and still no delete.
    expect(group.symbol).toBe("INFY");
    expect(group.brokerLabel).toBeTruthy();
    expect(group.rows).toBe(2);
    expect(group.accounts.map((a) => a.removable)).toEqual([false, false]);
    // Invariant 6: nothing here states the sale's quantity or its dates.
    expect({ qty: group.qty, buyDate: group.buyDate, sellDate: group.sellDate }).toEqual({
      qty: null,
      buyDate: null,
      sellDate: null,
    });
  });

  it("and the sentence prints “—”, never a merged lot's 60 shares or its buy date", () => {
    seedTwoMergedLots();
    const [issue] = crossAccountIssues({ duplicateTradeGroups: identity.listDuplicateTradeGroups() });

    expect(issue.detail).toContain("(— × INFY)");
    expect(issue.detail).not.toContain("60 × INFY");
    expect(issue.detail).not.toContain("25 × INFY");
    expect(issue.detail).not.toContain("2026-09-01");
    expect(issue.detail).not.toContain("2026-09-02");
  });
});

/* ── the screen, pinned on its source (vitest has no DOM here) ───────────── */

describe("the DuplicateFix card", () => {
  const src = readFileSync(path.join(process.cwd(), "components", "quality", "duplicate-fix.tsx"), "utf8");

  it("M-5 — a button is rendered only for a REMOVABLE account", () => {
    // The span cap is CRLF-safe by margin: the gap is 398 chars on LF and 408 on the
    // Windows CI checkout — a 400 cap went red there (CI 34464285189) while green here.
    expect(src).toMatch(/\.filter\(\(a\) => a\.removable\)[\s\S]{0,800}?Remove the copy in \{a\.name\}/);
    // The unfiltered map is gone: every account no longer gets a button.
    expect(src).not.toMatch(/\{g\.accounts\.map\(\(a\) => \(\r?\n\s*<Button/);
  });

  it("M-5 — a group with no plain copy states why, and links to Import instead", () => {
    expect(src).toMatch(/g\.accounts\.some\(\(a\) => a\.removable\)/);
    expect(src).toMatch(/\{NO_PLAIN_COPY_NOTE\}/);
    expect(src).toMatch(/import \{ NO_PLAIN_COPY_NOTE \} from "@\/lib\/analytics\/data-quality"/);
    // The copy is not re-typed in JSX — one sentence, in the pure module.
    expect(src).not.toMatch(/No copy of this record stands alone/);
  });

  it("U-1 — `busy` is cleared in a finally, so a thrown action cannot brick the dialog", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    expect(code).toMatch(/} catch [\s\S]{0,200}?toast\.error\(/);
    expect(code).toMatch(/} finally \{\r?\n\s*setBusy\(false\);\r?\n\s*\}/);
    // …and never the bare unwound form that left it true for ever.
    expect(code).not.toMatch(/await removeDuplicateCopy\(\{[\s\S]*?\}\);\r?\n\s*setBusy\(false\);/);
  });

  it("U-1 (round 2) — the catch toasts a FIXED sentence, never the thrown message", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    // `removeDuplicateCopy` is a server action: a production build replaces a
    // server-side error's message with React's redaction boilerplate, so
    // `err.message` shows the user a paragraph about digests. The span cap is
    // CRLF-safe by margin (a 400-char cap went red on the Windows checkout,
    // CI 34464285189).
    expect(code).toMatch(/} catch [\s\S]{0,300}?toast\.error\("Nothing was removed\.[^"]*"\);/);
    expect(code).not.toMatch(/err instanceof Error/);
    // Nothing between `catch` and the toast reads a message off the throw.
    expect(code).not.toMatch(/} catch [\s\S]{0,300}?\.message/);
    // The action's own refusals still arrive as data, with their real sentence.
    expect(code).toMatch(/if \(res\.ok\) toast\.success\(res\.message\);\r?\n\s*else toast\.error\(res\.message\);/);
  });

  it("U-2 — a group with no stated quantity prints “—” rather than a borrowed one", () => {
    expect(src).toMatch(/qty \{g\.qty \?\? "—"\}/);
    expect(src).toMatch(/qty: number \| null;/);
  });

  it("R12 — closing the confirm returns focus to the button that opened it, never <body>", () => {
    // The dialog is opened from state, with no DialogTrigger, so Radix's own
    // restore focuses a null triggerRef and keyboard focus fell to <body>. The
    // opener is kept in a REF (no state, no effect) and focused from
    // onCloseAutoFocus, whose preventDefault skips Radix's own restore.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\r\n]*$/gm, "");
    expect(code).toMatch(/const openerRef = React\.useRef<HTMLButtonElement \| null>\(null\);/);
    expect(code).toMatch(/openerRef\.current = e\.currentTarget;\s*setTarget\(/);
    expect(code).toMatch(/onCloseAutoFocus=\{\(e\) => \{\s*e\.preventDefault\(\);\s*openerRef\.current\?\.focus\(\);/);
  });
});
