import { describe, expect, it } from "vitest";
import { applyTicks, mergeTicks, parseTickFrame, rowQuoteKey, type TickQuote, type TickableRow } from "@/lib/live/apply-ticks";
import { portfolioHeat, type HeatRow } from "@/lib/live/heat";
import { computeTrackerRow } from "@/lib/live/tracker-row";
import type { LivePosition, Mark } from "@/lib/live/types";
import { quoteKeyId } from "@/lib/quotes/types";

/**
 * `lib/live/apply-ticks.ts` — the in-memory half of the SSE consumer.
 *
 * Two classes of defect are what this file exists to catch:
 *
 *  1. A PRO FIGURE DERIVED FROM A FREE WIRE. The free payload nulls
 *     `riskAtStopP`, `riskAmountP`, `openRPpm` and `pctOfCapital` but still
 *     ships `effectiveStopP` (the user's own record). A tick handler that
 *     "recomputed everything" would hand a free reader the exact risk figure
 *     `load-desk.ts` had just stripped.
 *  2. ARITHMETIC THAT DRIFTS FROM THE SERVER'S. Every figure below is
 *     cross-checked against `computeTrackerRow()` given the same mark, so the
 *     desk cannot print one number before a tick and a different one after.
 *
 * Every fixture is INTEGER PAISE (invariant 1).
 */

const KEY = { symbol: "TCS", exchange: "NSE" as const, tradingsymbol: "TCS" };

const tick = (over: Partial<TickQuote> = {}): TickQuote => ({
  key: KEY,
  ltp: 320_000, // ₹3,200.00
  prevClose: 300_000,
  asOf: "2026-09-04T09:59:00.000Z",
  staleness: "delayed",
  ...over,
});

/** A Pro row: R was recorded at entry and the wire carries the risk figures. */
const proRow = (over: Partial<TickableRow> = {}): TickableRow => ({
  symbol: "TCS",
  tradingsymbol: "TCS",
  exchange: "NSE",
  side: "long",
  qty: 100,
  avgEntryP: 300_000,
  investedP: 30_000_000, // 100 × ₹3,000.00
  markP: 305_000,
  staleness: "eod",
  markAsOf: null,
  dayChangePpm: 1_000,
  unrealisedP: 500_000,
  unrealisedPctPpm: 16_666,
  effectiveStopP: 290_000,
  targetP: 340_000,
  distanceToStopP: 15_000,
  distanceToStopPpm: 49_180,
  distanceToTargetP: 35_000,
  distanceToTargetPpm: 114_754,
  distanceToStopAtrX100: 300,
  atrP3: 5_000_000, // ATR = 5000 paise
  riskAmountP: 1_000_000,
  openRPpm: 500_000,
  ...over,
});

/**
 * The SAME row as it leaves `load-desk.ts` for a FREE licence: the four Pro
 * fields nulled at the paywall boundary, the stop still present.
 */
const freeRow = (over: Partial<TickableRow> = {}): TickableRow =>
  proRow({ riskAmountP: null, openRPpm: null, ...over });

const mapOf = (...qs: TickQuote[]) => new Map(qs.map((q) => [quoteKeyId(q.key), q]));

describe("applyTicks — a free row gets its own record back, and nothing more", () => {
  it("re-marks the row and recomputes unrealised ₹ and %", () => {
    const [row] = applyTicks([freeRow()], mapOf(tick()));
    expect(row.markP).toBe(320_000);
    // 100 × ₹3,200 − ₹3,00,000 invested = ₹20,000.00 = 2,000,000 paise.
    expect(row.unrealisedP).toBe(2_000_000);
    expect(row.unrealisedPctPpm).toBe(66_666); // 2,000,000 / 30,000,000, truncated
  });

  it("NEVER derives a Pro figure the free wire lacks — open R stays null", () => {
    const [row] = applyTicks([freeRow()], mapOf(tick()));
    // `riskAmountP` is null on a free wire, so open R cannot be computed from
    // it — and must not be re-derived from `effectiveStopP`, which IS shipped.
    expect(row.openRPpm).toBeNull();
    expect(row.riskAmountP).toBeNull();
  });

  it("carries the staleness and the source time the provider stated", () => {
    const [row] = applyTicks([freeRow()], mapOf(tick({ staleness: "tick", asOf: "2026-09-04T10:01:02.000Z" })));
    expect(row.staleness).toBe("tick");
    expect(row.markAsOf).toBe("2026-09-04T10:01:02.000Z");
  });

  it("computes the day change from the provider's own previous close", () => {
    const [row] = applyTicks([freeRow()], mapOf(tick()));
    expect(row.dayChangePpm).toBe(66_666); // (320000 − 300000) / 300000
  });

  it("keeps the stored-sessions day change when the provider sends no previous close", () => {
    const [row] = applyTicks([freeRow()], mapOf(tick({ prevClose: null })));
    expect(row.dayChangePpm, "a missing prevClose must not blank a real figure").toBe(1_000);
  });
});

describe("applyTicks — a Pro row also moves open R", () => {
  it("recomputes open R from the FROZEN risk amount, never from today's stop", () => {
    const [row] = applyTicks([proRow()], mapOf(tick()));
    expect(row.openRPpm).toBe(2_000_000); // ₹20,000 / ₹10,000 = 2.0 R
  });

  it("agrees with computeTrackerRow given the same mark — one arithmetic, two places", () => {
    const position: LivePosition = {
      id: 1,
      accountId: 1,
      symbol: "TCS",
      tradingsymbol: "TCS",
      segment: "eq_delivery",
      instrumentType: "equity",
      side: "long",
      qty: 100,
      avgEntryP: 300_000,
      investedP: 30_000_000,
      entryDate: "2026-08-01",
      slPlannedP: 290_000,
      trailingSlP: null,
      targetPlannedP: 340_000,
      riskAmountP: 1_000_000,
      lotSize: 1,
      sector: "IT",
      sectorTier: "user",
    };
    const mark: Mark = { markP: 320_000, staleness: "delayed", asOf: "2026-09-04T09:59:00.000Z" };
    const server = computeTrackerRow(position, mark, { today: "2026-09-04", capitalP: null });
    const [client] = applyTicks([proRow({ atrP3: null, distanceToStopAtrX100: null })], mapOf(tick()));

    for (const f of [
      "markP",
      "staleness",
      "markAsOf",
      "unrealisedP",
      "unrealisedPctPpm",
      "distanceToStopP",
      "distanceToStopPpm",
      "distanceToTargetP",
      "distanceToTargetPpm",
      "distanceToStopAtrX100",
      "openRPpm",
    ] as const) {
      expect(client[f], `${f} drifted from the server's own arithmetic`).toEqual(server[f]);
    }
  });

  it("mirrors a short: the same tick is a loss on the other side", () => {
    const [row] = applyTicks([proRow({ side: "short" })], mapOf(tick()));
    expect(row.unrealisedP).toBe(-2_000_000);
    expect(row.distanceToStopP, "a short's stop sits ABOVE the mark").toBe(-30_000);
  });
});

describe("applyTicks — what a tick may NOT change", () => {
  it("leaves risk at stop and % of capital exactly as the wire sent them", () => {
    // Both are properties of the LEVEL, not of the mark (`tracker-row.ts`), so
    // a tick cannot move them — and on a free wire they are null BECAUSE of the
    // paywall, which is the second reason to carry them through untouched.
    const wire = { ...proRow(), riskAtStopP: 1_000_000, pctOfCapital: { ppm: 20_000, denominator: 50_000_000 } };
    const [row] = applyTicks([wire], mapOf(tick()));
    expect(row.riskAtStopP).toBe(1_000_000);
    expect(row.pctOfCapital).toEqual({ ppm: 20_000, denominator: 50_000_000 });
  });

  it("leaves portfolio heat invariant, which is why the client never recomputes it", () => {
    const wire = { ...proRow(), id: 1, riskAtStopP: 1_000_000, sector: "IT", sectorTier: "user" };
    const heatOf = (r: typeof wire): HeatRow => ({
      id: r.id,
      riskAtStopP: r.riskAtStopP,
      investedP: r.investedP,
      sector: r.sector,
      sectorTier: r.sectorTier,
    });
    const before = portfolioHeat([heatOf(wire)], 50_000_000, null);
    const [after] = applyTicks([wire], mapOf(tick()));
    expect(portfolioHeat([heatOf(after)], 50_000_000, null)).toEqual(before);
  });

  it("ignores a tick for a symbol this desk does not hold, and returns the row by identity", () => {
    const row = freeRow();
    const out = applyTicks([row], mapOf(tick({ key: { symbol: "INFY", exchange: "NSE", tradingsymbol: "INFY" } })));
    expect(out[0], "an untouched row must keep its identity so nothing re-measures").toBe(row);
  });

  it("refuses a price of zero or less — a mark of zero prints a −100 % position", () => {
    const row = freeRow();
    expect(applyTicks([row], mapOf(tick({ ltp: 0 })))[0]).toBe(row);
    expect(applyTicks([row], mapOf(tick({ ltp: -5 })))[0]).toBe(row);
  });

  it("returns the same array when there is nothing to apply", () => {
    const rows = [freeRow()];
    expect(applyTicks(rows, new Map())).toBe(rows);
  });

  it("tells two contracts of one underlying apart through the traded symbol", () => {
    const cash = freeRow();
    const option = freeRow({ tradingsymbol: "TCS26SEP3200CE", exchange: "NFO" });
    expect(rowQuoteKey(cash)).toBe("NSE:TCS");
    expect(rowQuoteKey(option)).toBe("NFO:TCS26SEP3200CE");
    const [c, o] = applyTicks([cash, option], mapOf(tick()));
    expect(c.markP).toBe(320_000);
    expect(o, "the cash tick must not price the contract").toBe(option);
  });
});

describe("parseTickFrame — an untrusted frame may cost one quote, never a throw", () => {
  it("reads the frame shape the SSE route sends", () => {
    const frame = {
      provider: "openalgo",
      quotes: [
        {
          key: { symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS" },
          ltp: 320_000,
          prevClose: 300_000,
          dayOpen: null,
          dayHigh: null,
          dayLow: null,
          volume: null,
          asOf: "2026-09-04T09:59:00.000Z",
          staleness: "delayed",
          source: "openalgo",
        },
      ],
    };
    expect(parseTickFrame(frame)).toEqual([
      {
        key: { symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS" },
        ltp: 320_000,
        prevClose: 300_000,
        asOf: "2026-09-04T09:59:00.000Z",
        staleness: "delayed",
      },
    ]);
  });

  it("drops a malformed quote and keeps the rest of the frame", () => {
    const good = { key: { symbol: "TCS", exchange: "NSE" }, ltp: 1, prevClose: null, asOf: "x", staleness: "tick" };
    const frame = {
      quotes: [
        { key: { symbol: "INFY", exchange: "MOON" }, ltp: 1, asOf: "x", staleness: "tick" },
        { key: { symbol: "WIPRO", exchange: "NSE" }, ltp: "cheap", asOf: "x", staleness: "tick" },
        { key: { symbol: "HDFCBANK", exchange: "NSE" }, ltp: 1, asOf: "x", staleness: "guess" },
        good,
      ],
    };
    expect(parseTickFrame(frame).map((q) => q.key.symbol)).toEqual(["TCS"]);
  });

  it("answers with an empty list for anything that is not a frame", () => {
    for (const raw of [null, undefined, 42, "tick", {}, { quotes: "none" }]) {
      expect(parseTickFrame(raw)).toEqual([]);
    }
  });
});

describe("mergeTicks — the newest price per key, and nothing forgotten", () => {
  it("supersedes an earlier quote and keeps a key that did not tick", () => {
    const infy = tick({ key: { symbol: "INFY", exchange: "NSE", tradingsymbol: "INFY" }, ltp: 150_000 });
    const first = mergeTicks(new Map(), [tick({ ltp: 310_000 }), infy]);
    const second = mergeTicks(first, [tick({ ltp: 320_000 })]);
    expect(second.get("NSE:TCS")?.ltp).toBe(320_000);
    expect(second.get("NSE:INFY")?.ltp, "a symbol that did not tick must keep its price").toBe(150_000);
  });

  it("returns the same map when the frame carried nothing", () => {
    const prev = mergeTicks(new Map(), [tick()]);
    expect(mergeTicks(prev, [])).toBe(prev);
  });
});
