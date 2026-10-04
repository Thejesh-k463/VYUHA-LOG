// TELEGRAM ALERT PLAN (PURE — no DB, no fetch). Which breaches get a message
// THIS run, and whether the day's one summary line is due (v4.7.0 C5, design
// D5/D6, rulings Q18-d and Q18-i).
//
//   • A receipt is the unit: (trade id, symbol, kind, IST day). One already on
//     file today means that breach was sent today — no same-day re-arm, even if
//     the stop is edited afterwards (Q18-d, literally). The symbol is part of
//     the unit because a restore can put a DIFFERENT trade under the same id
//     (review R6), and that trade's breach must not be silenced by the old one.
//   • At most `ALERT_DAILY_CAP` messages a day (Q18-i). Once the day's count
//     would pass it, every further breach that day is counted into ONE summary
//     line ("N more … open Vyuha"), sent at most once per IST day; after that
//     the day is quiet and Vyuha's own screens are the record.
//   • Order is `detectBreaches`' order — stops before targets, deepest first —
//     so the cap spends itself on what needs attention most.

import type { BreachKind } from "@/lib/risk/alerts";

/** The daily message ceiling (Q18-i). */
export const ALERT_DAILY_CAP = 20;

/** One breach, carrying what the message and the receipt need. */
export interface AlertCandidate {
  tradeId: number;
  /** The display symbol — the contract for a derivative. Part of the receipt key (R6). */
  symbol: string;
  kind: BreachKind;
  side: "long" | "short";
  level: number;
  mark: number;
  throughPct: number;
  accountId: number;
  accountName: string | null;
}

/** The receipt key — the same four fields as the table's UNIQUE index. */
export function receiptKey(tradeId: number, symbol: string, kind: BreachKind): string {
  return `${tradeId}|${symbol}|${kind}`;
}

export interface AlertPlanInput {
  breaches: readonly AlertCandidate[];
  /** `receiptKey`s already on file for today. */
  sentToday: ReadonlySet<string>;
  /** Today's receipts, counted (the cap's numerator). */
  sentCountToday: number;
  summarySentToday: boolean;
  cap?: number;
}

export interface AlertPlan {
  toSend: AlertCandidate[];
  /** Due breaches held back by the cap this run. */
  heldBack: number;
  /** The day's one summary, when it is due now. */
  summary: { count: number } | null;
}

export function planAlerts(input: AlertPlanInput): AlertPlan {
  const cap = input.cap ?? ALERT_DAILY_CAP;
  const due = input.breaches.filter((b) => !input.sentToday.has(receiptKey(b.tradeId, b.symbol, b.kind)));
  const room = Math.max(0, cap - input.sentCountToday);
  const toSend = due.slice(0, room);
  const heldBack = due.length - toSend.length;
  return {
    toSend,
    heldBack,
    summary: heldBack > 0 && !input.summarySentToday ? { count: heldBack } : null,
  };
}
