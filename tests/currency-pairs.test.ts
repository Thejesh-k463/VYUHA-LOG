import { describe, expect, it } from "vitest";
import { CURRENCY_PAIRS, isCurrencyPair } from "@/lib/domain/currency-pairs";

/**
 * v4.7.0 release audit (owner answers Q2 + Q4, design review R6): ONE list of the
 * currency-derivative underlyings Vyuha does not price, read by the Telegram
 * alert gate and the Kite / Zerodha importers. The match is the stored `symbol`,
 * EXACT after trim + upper-case — never a tradingsymbol prefix.
 *
 * WRONG looks like: a pair missing from the list (that pair alerts and is sent
 * to the feed), or a prefix match ("USDINR26OCTFUT", or a future equity ticker
 * that happens to start with a pair, silently refused).
 */
describe("currency pairs — one list, exact match", () => {
  it("is exactly the seven NSE/BSE currency-derivative underlyings the owner named", () => {
    expect([...CURRENCY_PAIRS].sort()).toEqual(["EURINR", "EURUSD", "GBPINR", "GBPUSD", "JPYINR", "USDINR", "USDJPY"]);
  });

  it("matches every listed pair, whatever its case or surrounding space", () => {
    for (const p of CURRENCY_PAIRS) {
      expect(isCurrencyPair(p), p).toBe(true);
      expect(isCurrencyPair(` ${p.toLowerCase()} `), p).toBe(true);
    }
  });

  it("never matches a tradingsymbol, a fragment, a stock or nothing", () => {
    for (const s of ["USDINR26OCTFUT", "USDINR26OCT84CE", "USD", "INR", "USDINRX", "XUSDINR", "RELIANCE", "NIFTY", "", "  "]) {
      expect(isCurrencyPair(s), s).toBe(false);
    }
    expect(isCurrencyPair(null)).toBe(false);
    expect(isCurrencyPair(undefined)).toBe(false);
  });
});
