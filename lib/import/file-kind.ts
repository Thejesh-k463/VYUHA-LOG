import type { ProductHint } from "@/lib/engine/types";

/**
 * Which KIND of broker file this is — the distinction that decides how much
 * Vyuha can actually know about your trades.
 *
 * ── Why this matters more than it looks ───────────────────────────────────
 *
 * A TRANSACTION file (tradebook) lists every execution with a product column
 * and a timestamp. From it, Vyuha knows whether a trade was delivery, MTF or
 * intraday, when in the session it happened, and how a position was scaled.
 *
 * A P&L file is a pre-aggregated summary. It has no product column and no
 * times — so "was this delivery or MTF?" is genuinely unanswerable from the
 * data. Charges, MTF interest and Return-on-Margin all hang off that answer.
 *
 * Rather than guess silently, the P&L import path asks once, up front.
 */
export type FileKind = "transactions" | "pnl";

/** Parser `format` strings that mean "one row per execution". */
const TRANSACTION_FORMATS = new Set(["tradebook", "console", "transactions"]);

/**
 * Classify a parsed file. Defaults to "pnl" for anything unrecognised,
 * because that is the conservative reading: it triggers the confirmation
 * step rather than assuming detail the file may not have.
 */
export function classifyFileKind(format: string): FileKind {
  return TRANSACTION_FORMATS.has(format.toLowerCase()) ? "transactions" : "pnl";
}

/** What each kind can and cannot tell you — shown in the UI, not decoration. */
export interface FileKindCapability {
  kind: FileKind;
  label: string;
  /** True when the file identifies delivery / MTF / intraday itself. */
  knowsProduct: boolean;
  /** True when the file carries execution timestamps. */
  knowsTime: boolean;
  /** True when individual fills survive, enabling staged-position ladders. */
  knowsFills: boolean;
}

/**
 * Formats that are transaction-level but carry a SETTLEMENT stamp rather than
 * a fill time. Dhan's Global Transaction Report reads `00:00:00` on every row,
 * so claiming it knows the time would push the whole book into a fabricated
 * pre-open session — the precise thing Arjun's Eye refuses to do.
 */
const NO_FILL_TIME_FORMATS = new Set(["transactions"]);

/**
 * Formats where the product is DERIVED from the charge signature rather than
 * stated outright. It is reliable for delivery vs intraday, but MTF is
 * indistinguishable from delivery, so the confirmation step is still needed —
 * just narrowed to the delivery rows.
 */
const DERIVED_PRODUCT_FORMATS = new Set(["transactions"]);

export function capabilityOf(kind: FileKind, format?: string): FileKindCapability {
  if (kind !== "transactions") {
    return { kind, label: "P&L Statement", knowsProduct: false, knowsTime: false, knowsFills: false };
  }
  const f = (format ?? "").toLowerCase();
  return {
    kind,
    label: "Transactions / Tradebook",
    knowsProduct: !DERIVED_PRODUCT_FORMATS.has(f),
    knowsTime: !NO_FILL_TIME_FORMATS.has(f),
    knowsFills: !NO_FILL_TIME_FORMATS.has(f),
  };
}

/** Product choices a user can apply to P&L rows that carry no product column. */
export const PRODUCT_CHOICES: { value: ProductHint; label: string; hint: string }[] = [
  { value: "delivery", label: "Equity Delivery", hint: "Paid in full, held overnight" },
  { value: "mtf", label: "Equity MTF", hint: "Broker-funded; interest accrues daily" },
  { value: "intraday", label: "Equity Intraday", hint: "Squared off the same day" },
];

/**
 * Best-effort product guess for a P&L row.
 *
 * Same-day buy and sell is reliably intraday — that inference is safe. MTF is
 * NOT inferable at all: an MTF position looks identical to a delivery position
 * in a P&L file, so it defaults to delivery and is flagged for the user.
 *
 * Delivery is the deliberate default because it is the SAFEST wrong answer:
 * it neither invents MTF interest that was never charged, nor applies
 * intraday leverage that was never granted.
 */
export function guessProduct(buyDate: string | null, sellDate: string | null): ProductHint {
  if (buyDate && sellDate && buyDate === sellDate) return "intraday";
  return "delivery";
}

/** Why a guess was made, for the UI to explain rather than assert. */
export function guessReason(product: ProductHint, buyDate: string | null, sellDate: string | null): string {
  if (product === "intraday" && buyDate && sellDate && buyDate === sellDate) {
    return "bought and sold the same day";
  }
  return "assumed — a P&L file cannot identify MTF";
}
