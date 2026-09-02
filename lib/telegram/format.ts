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
