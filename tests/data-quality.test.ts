import { describe, expect, it } from "vitest";
import { assessDataQuality, type QualityTrade, type QualityInputs, type QualityReport } from "@/lib/analytics/data-quality";

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
