import { describe, expect, it } from "vitest";
import { ALERT_DAILY_CAP, planAlerts, receiptKey, type AlertCandidate } from "@/lib/telegram/alert-plan";

/**
 * The PURE alert plan (v4.7.0 C5, design D5/D6, rulings Q18-d / Q18-i): no
 * same-day re-arm, the 20-a-day cap, then ONE summary per IST day, in
 * `detectBreaches`' order.
 */

const c = (tradeId: number, kind: AlertCandidate["kind"] = "sl", symbol = `SYM${tradeId}`): AlertCandidate => ({
  tradeId,
  symbol,
  kind,
  side: "long",
  level: 100,
  mark: 99,
  throughPct: 1,
  accountId: 1,
  accountName: "Main",
});

describe("planAlerts", () => {
  it("the cap is 20 a day (Q18-i)", () => {
    expect(ALERT_DAILY_CAP).toBe(20);
  });

  it("sends every due breach under the cap, in the order given", () => {
    const p = planAlerts({ breaches: [c(1), c(2, "target")], sentToday: new Set(), sentCountToday: 0, summarySentToday: false });
    expect(p.toSend.map((x) => x.tradeId)).toEqual([1, 2]);
    expect(p).toMatchObject({ heldBack: 0, summary: null });
  });

  it("a receipt for today means no re-arm — even after the stop is edited (Q18-d)", () => {
    const p = planAlerts({
      breaches: [c(1), c(2)],
      sentToday: new Set([receiptKey(1, "SYM1", "sl")]),
      sentCountToday: 1,
      summarySentToday: false,
    });
    expect(p.toSend.map((x) => x.tradeId)).toEqual([2]);
  });

  it("the receipt is per kind and per SYMBOL — a different trade under a reused id still alerts (R6)", () => {
    const sent = new Set([receiptKey(1, "OLDCO", "sl")]);
    expect(planAlerts({ breaches: [c(1, "target", "OLDCO")], sentToday: sent, sentCountToday: 1, summarySentToday: false }).toSend).toHaveLength(1);
    expect(planAlerts({ breaches: [c(1, "sl", "NEWCO")], sentToday: sent, sentCountToday: 1, summarySentToday: false }).toSend).toHaveLength(1);
    expect(planAlerts({ breaches: [c(1, "sl", "OLDCO")], sentToday: sent, sentCountToday: 1, summarySentToday: false }).toSend).toHaveLength(0);
  });

  it("the 21st breach of the day becomes the ONE summary, never a 21st message", () => {
    const breaches = Array.from({ length: 23 }, (_, i) => c(i + 1));
    const p = planAlerts({ breaches, sentToday: new Set(), sentCountToday: 0, summarySentToday: false });
    expect(p.toSend).toHaveLength(20);
    expect(p.toSend.map((x) => x.tradeId)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(p).toMatchObject({ heldBack: 3, summary: { count: 3 } });
  });

  it("the cap counts what was ALREADY sent today", () => {
    const p = planAlerts({ breaches: [c(30), c(31)], sentToday: new Set(), sentCountToday: 19, summarySentToday: false });
    expect(p.toSend.map((x) => x.tradeId)).toEqual([30]);
    expect(p.summary).toEqual({ count: 1 });
  });

  it("once the summary is sent the day is quiet — no second summary, no 21st message", () => {
    const p = planAlerts({ breaches: [c(40)], sentToday: new Set(), sentCountToday: 20, summarySentToday: true });
    expect(p).toMatchObject({ toSend: [], heldBack: 1, summary: null });
  });
});
