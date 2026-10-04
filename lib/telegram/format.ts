// TELEGRAM EOD DIGEST FORMAT (PURE — no DB, no React, no fetch).
//
// Builds the HTML-parse-mode message body for the opt-in end-of-day digest
// (v3.6, owner decision #6). Everything in it is the user's OWN recorded data
// — counts, risk, capital, realised nets, plan-adherence facts — and the last
// line is always the pinned footer. Nothing here may look like advice.
//
// Telegram's HTML parse mode requires ONLY `<`, `>`, `&` to be escaped in
// text (quotes are fine), and caps a message at 4,096 characters. The digest
// is cap-aware: the positions list is truncated with a stated "+N more"
// rather than letting the API reject the whole message.
//
// The input is a plain serializable object on purpose: the server route/job
// assembles it from the existing queries and this module stays exhaustively
// unit-testable (AGENTS.md invariant 2).

import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { hhmmOf, istClock } from "@/lib/domain/market-calendar";

/** Telegram's hard per-message limit for text. */
export const TELEGRAM_MESSAGE_CAP = 4096;

/** Pinned last line — duplicated from TELEGRAM_DISCLOSURE.footer so this
 *  module stays dependency-free; the drift test pins the two together. */
export const DIGEST_FOOTER = "Your own recorded data. Not investment advice.";

export interface DigestPosition {
  /** Display symbol (tradingsymbol preferred — "M&M-FUT" must escape clean). */
  symbol: string;
  side: "long" | "short";
  qty: number;
}

export interface EodDigestInput {
  /** ISO date the digest covers (IST trading day). */
  date: string;
  /** Account scope label ("Primary", "All accounts") — shown when present. */
  accountLabel?: string | null;
  openPositions: DigestPosition[];
  /** Sum of recorded riskAmount over open positions; null when NONE recorded. */
  openRiskRupees: number | null;
  /** Open positions with no recorded risk — stated, never guessed at. */
  openRiskUnknownCount: number;
  /** Total capital. null/0 = UNKNOWN → the % line is OMITTED, never 0
   *  (invariant 6: never fabricate a denominator). */
  capitalTotal: number | null;
  /** Sum invested across open positions (qty × avg entry). */
  capitalDeployed: number | null;
  realisedToday: number;
  realisedWeek: number;
  realisedMonth: number;
  /** Plan-adherence facts — descriptive counts only. */
  closedToday: number;
  /** Closed in the last 7 days with no journal notes; null = not computed. */
  journalPendingCount: number | null;
}

/** Escape exactly what Telegram's HTML parse mode requires: & < > . */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ₹ with Indian grouping; two decimals only when the paise are real. */
export function inrDigest(n: number): string {
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const opts =
    Math.round(abs * 100) % 100 === 0
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `${sign}₹${abs.toLocaleString("en-IN", opts)}`;
}

function positionLine(p: DigestPosition): string {
  return `• ${escapeHtml(p.symbol)} ${p.side} ×${p.qty}`;
}

/**
 * The digest body. Deterministic, cap-aware: if the full positions list would
 * push past `cap`, the tail is dropped and "… +N more" states exactly what was
 * held back. Every other line always survives — the list is the only elastic
 * part, so the totals and the footer can never be truncated away.
 */
export function formatEodDigest(input: EodDigestInput, cap: number = TELEGRAM_MESSAGE_CAP): string {
  const longs = input.openPositions.filter((p) => p.side === "long").length;
  const shorts = input.openPositions.length - longs;

  const head: string[] = [];
  head.push(
    `<b>Vyuha EOD — ${escapeHtml(input.date)}</b>${input.accountLabel ? ` (${escapeHtml(input.accountLabel)})` : ""}`,
  );
  head.push(`Open positions: ${input.openPositions.length} (${longs} long / ${shorts} short)`);

  const tail: string[] = [];
  if (input.openRiskRupees != null) {
    // The % of capital appears ONLY when capital is known — an unknown
    // denominator is omitted, never rendered as 0 (invariant 6).
    const pct =
      input.capitalTotal != null && input.capitalTotal > 0
        ? ` (${((input.openRiskRupees / input.capitalTotal) * 100).toFixed(1)}% of capital)`
        : "";
    const unknown =
      input.openRiskUnknownCount > 0
        ? ` — ${input.openRiskUnknownCount} position${input.openRiskUnknownCount === 1 ? "" : "s"} without a recorded risk`
        : "";
    tail.push(`Open risk: ${inrDigest(input.openRiskRupees)}${pct}${unknown}`);
  } else if (input.openPositions.length > 0) {
    tail.push(`Open risk: not recorded on any open position`);
  }
  if (input.capitalDeployed != null) {
    tail.push(`Capital deployed: ${inrDigest(input.capitalDeployed)}`);
  }
  tail.push(
    `Realised net — today ${inrDigest(input.realisedToday)} · 7 days ${inrDigest(input.realisedWeek)} · month ${inrDigest(input.realisedMonth)}`,
  );
  const plan: string[] = [`${input.closedToday} closed today`];
  if (input.journalPendingCount != null) {
    plan.push(`${input.journalPendingCount} closed this week awaiting journal notes`);
  }
  tail.push(`Plan: ${plan.join(" · ")}`);
  tail.push("");
  tail.push(DIGEST_FOOTER);

  const fixedLen = [...head, ...tail].join("\n").length + 1; // +1 for the list's leading \n
  const lines = input.openPositions.map(positionLine);

  // Keep as many position lines as fit under the cap; state the rest.
  let shown = lines.length;
  const lenWith = (n: number): number => {
    const list = lines.slice(0, n);
    if (n < lines.length) list.push(`… +${lines.length - n} more`);
    return fixedLen + (list.length ? list.join("\n").length + 1 : 0);
  };
  while (shown > 0 && lenWith(shown) > cap) shown--;
  const list = lines.slice(0, shown);
  if (shown < lines.length) list.push(`… +${lines.length - shown} more`);

  return [...head, ...list, ...tail].join("\n");
}

/* ───────────────────── stop / target alerts (v4.7.0 C5) ───────────────────── */
//
// Design D8 + review R2/R9, owner answer TG5: LEVELS ONLY. Symbol · account
// (only when the install has more than one), the mark, the recorded level and
// its kind, how far through it the mark is, the IST time of THIS check, the
// feed's name, "Open Vyuha to review your plan.", the pinned footer. No
// quantity, no rupee figure, no risk number, and no transaction verb from
// /\b(buy|sell|book|exit|square|trail|hold|add|average)\b/i anywhere in the
// TEMPLATE — tests/telegram-alert-format.test.ts renders every kind × side ×
// account case and runs that regex and PRESCRIPTIVE_LANGUAGE over it. The
// user's own strings (symbol, account name) are ESCAPED, never scanned: an
// account called "Long hold" is the user's word, not Vyuha's advice (R9).
//
// "checked HH:MM IST", never "as of": the three live adapters stamp `asOf` with
// the time the answer ARRIVED, not a source time (R2), so the honest claim is
// when Vyuha looked.

/** The footer every alert ends on — the disclosure's own constant. */
export const ALERT_FOOTER: string = TELEGRAM_DISCLOSURE.footer;

/** The feed's short name in a message. */
const ALERT_FEED_LABELS: Record<string, string> = {
  openalgo: "OpenAlgo",
  upstox: "Upstox",
  angelone: "Angel One",
  mock: "the mock feed",
};

export function alertFeedLabel(providerId: string): string {
  return ALERT_FEED_LABELS[providerId] ?? providerId;
}

export interface AlertMessageInput {
  /** Display symbol — the contract for a derivative. */
  symbol: string;
  kind: "sl" | "tsl" | "target";
  side: "long" | "short";
  level: number;
  mark: number;
  throughPct: number;
  /** Shown only when `multiAccount`. */
  accountName: string | null;
  multiAccount: boolean;
  /** The instant of THIS check. */
  checkedAt: Date;
  providerId: string;
}

/** A per-unit price: Indian grouping, two decimals ("1,228.40"). */
export function alertPrice(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function depth(pct: number): string {
  if (!(pct > 0)) return "at the level";
  if (pct < 0.1) return "under 0.1%";
  return `${pct.toFixed(1)}%`;
}

const KIND_WORDS: Record<AlertMessageInput["kind"], string> = {
  sl: "is through your recorded stop",
  tsl: "is through your recorded trailing stop",
  target: "has reached your recorded target",
};

/** One alert, Telegram HTML parse mode. */
export function formatAlert(a: AlertMessageInput): string {
  const who = a.multiAccount && a.accountName ? ` · ${escapeHtml(a.accountName)}` : "";
  const at = hhmmOf(istClock(a.checkedAt).minutes);
  return [
    `<b>${escapeHtml(a.symbol)}</b>${who}: mark ${alertPrice(a.mark)} ${KIND_WORDS[a.kind]} ${alertPrice(a.level)} (${depth(a.throughPct)}) · checked ${at} IST via ${escapeHtml(alertFeedLabel(a.providerId))}. Open Vyuha to review your plan.`,
    "",
    ALERT_FOOTER,
  ].join("\n");
}

/** The day's one summary line, once the daily cap is spent (Q18-i). */
export function formatAlertSummary(count: number, cap: number): string {
  const n = Math.max(0, Math.floor(count));
  return [
    `<b>Vyuha</b>: ${n} more ${n === 1 ? "breach" : "breaches"} of your recorded levels today, past the daily limit of ${cap} alerts. Open Vyuha to review your plan.`,
    "",
    ALERT_FOOTER,
  ].join("\n");
}

/**
 * Split an already-formatted message on line boundaries into ≤cap chunks.
 * The digest itself never needs this (formatEodDigest is cap-aware), but a
 * caller composing something longer can use it rather than being rejected.
 */
export function chunkMessage(html: string, cap: number = TELEGRAM_MESSAGE_CAP): string[] {
  if (html.length <= cap) return [html];
  const out: string[] = [];
  let current = "";
  for (const line of html.split("\n")) {
    // A single pathological line longer than the cap is hard-split.
    const pieces = line.length > cap ? (line.match(new RegExp(`.{1,${cap}}`, "g")) ?? []) : [line];
    for (const piece of pieces) {
      if (current && current.length + 1 + piece.length > cap) {
        out.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) out.push(current);
  return out;
}
