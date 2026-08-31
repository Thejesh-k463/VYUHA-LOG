/**
 * TAX-AUDIT TURNOVER FOR DERIVATIVES AND INTRADAY — one method, in one place.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * Turnover was computed THREE different ways in three modules, and two of them
 * were on screen at the same time on different pages:
 *
 *   tax.ts:65            |gross P&L| + option sell premium  (matched current ICAI)
 *   itr.ts:131           |gross P&L|                        (superseded 2022 method)
 *   itr-schedule.ts:161  |NET P&L|                          (wrong under every edition —
 *                                                            net is after charges)
 *
 * itr.ts's figure was the one fed to `auditVerdict`, so the audit threshold was
 * being tested against a number that omits option premium entirely. For an
 * options seller, premium can exceed |P&L| by orders of magnitude, so this could
 * report "audit generally NOT required" on a book well over the line.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * ICAI Guidance Note on Tax Audit, ELEVENTH edition (2026), para 5.11(b):
 *
 *   (i)   "The total of favourable and unfavourable differences in case of
 *         squared off transactions shall be taken as turnover."
 *   (ii)  "Premium received on sale of options is also to be included in
 *         turnover. However, where the premium received is included for
 *         determining net profit for transactions, then such net profit should
 *         not be separately included."
 *   (iii) "In respect of any reverse trades entered, the difference thereon,
 *         should also form part of the turnover."
 *   (iv)  An open position counts in the year it is ACTUALLY SQUARED OFF.
 *   (v)   On delivery-based settlement of a derivative, the difference between
 *         trade price and settlement price is turnover.
 *
 * We implement (i)+(iii) as the sum of |gross P&L| over closed positions — gross,
 * because a "difference" is the trade difference, before charges — and (ii) as
 * the option sell-side premium added once. The proviso in (ii) bars adding the
 * NET PROFIT again on top of the premium; it does not bar the difference, which
 * (i) requires. We add the difference and the premium, and never the net profit.
 * (iv) falls out of skipping open rows.
 *
 * ── THE TRAP — read this before "fixing" anything here ────────────────────
 *
 * Option premium was REMOVED from turnover in the 8th edition (2022) and
 * REINSTATED in the 9th (2023), then carried unchanged through the 10th (2025)
 * and the 11th (2026). The widely repeated "turnover is absolute profit only,
 * premium never counts" is the 2022 position and has been WRONG SINCE 2023.
 *
 * A web search still returns the superseded answer confidently, across several
 * otherwise reputable sources. It was checked here against the Guidance Note
 * PDFs themselves (9th, 10th and 11th editions) on 2026-08-31. If you are about
 * to remove the premium term, read the PDF first — not a blog.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * The Guidance Note is ICAI PROFESSIONAL GUIDANCE, NOT STATUTE. Neither the
 * Income-tax Act, 2025 nor the Income-tax Rules, 2026 prescribes a derivatives
 * turnover method, and the 11th edition's own Preface calls itself the
 * CONCLUDING edition under the 1961 Act — so there is currently no ICAI turnover
 * guidance mapped to s.63. Carrying para 5.11(b) forward is PRACTICE, not
 * authority. That is why `TURNOVER_BASIS` exists and is shown to the user rather
 * than buried here.
 *
 * Limitation stated rather than hidden: 5.11(b)(v) physical settlement of stock
 * derivatives is not modelled separately. A physically-settled position converts
 * to a delivery leg, and the difference is already carried in that leg's gross
 * P&L, so it is counted — but not identified as settlement-derived.
 */

/** Non-speculative business under s.66(33) of the Income-tax Act, 2025. */
export const FNO_SEGMENTS: ReadonlySet<string> = new Set([
  "index_option",
  "stock_option",
  "commodity_option",
  "commodity_future",
  "future",
]);

/** The subset of the above whose SELL side carries premium — para 5.11(b)(ii). */
export const OPTION_SEGMENTS: ReadonlySet<string> = new Set([
  "index_option",
  "stock_option",
  "commodity_option",
]);

/** Capital gains, not business income. */
export const DELIVERY_SEGMENTS: ReadonlySet<string> = new Set(["eq_delivery", "eq_mtf"]);

/** Speculative business under s.66(31) — settled otherwise than by delivery. */
export const SPECULATIVE_SEGMENT = "eq_intraday";

/**
 * The one sentence the UI must show beside any turnover figure. Turnover is not
 * a statutory quantity for derivatives; the user is entitled to know whose
 * method produced the number that decides whether they need an audit.
 */
export const TURNOVER_BASIS =
  "Basis: ICAI Guidance Note on Tax Audit, 11th edition (2026), para 5.11(b) — the sum of favourable and unfavourable differences, plus premium received on the sale of options. This is ICAI guidance, not statute: neither the Income-tax Act, 2025 nor the Rules prescribe a turnover method for derivatives. Your CA may use a different basis; ask which your filing history uses.";

export interface TurnoverTrade {
  segment: string;
  /** Pre-charge trade difference. A "difference" under 5.11(b)(i) is gross. */
  grossPnl: number;
  /** Sell-side consideration. For an option leg this is the premium received. */
  sellValue: number;
  isOpen: boolean;
}

export interface TurnoverBreakdown {
  /** Σ |gross P&L| over closed positions — para 5.11(b)(i) and (iii). */
  differences: number;
  /** Σ option sell-side premium — para 5.11(b)(ii). Zero outside options. */
  optionPremium: number;
  /** differences + optionPremium. The figure the audit threshold is tested against. */
  total: number;
  /** Closed positions counted. */
  trades: number;
  /** Open positions excluded — they count in the year they are squared off, 5.11(b)(iv). */
  openExcluded: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One trade's contribution to turnover, for callers that accumulate per row.
 *
 * Returns 0 for an open position rather than a partial figure: under
 * 5.11(b)(iv) an unsquared position has no turnover yet, and returning a
 * fraction of one would be an invented number.
 */
export function turnoverContribution(t: TurnoverTrade): number {
  if (t.isOpen) return 0;
  const difference = Math.abs(t.grossPnl);
  // Premium is a consideration, never negative. A worthless expiry sells for 0.
  const premium = OPTION_SEGMENTS.has(t.segment) ? Math.max(0, t.sellValue) : 0;
  return difference + premium;
}

/**
 * Turnover with its workings, for a set of trades already filtered to ONE head.
 *
 * The components are returned separately because a user asked to accept an audit
 * verdict deserves to see which half of the number drove it — an options seller
 * whose turnover is 98% premium is in a very different position from one whose
 * turnover is all realised differences.
 */
export function turnoverOf(trades: TurnoverTrade[]): TurnoverBreakdown {
  let differences = 0;
  let optionPremium = 0;
  let count = 0;
  let openExcluded = 0;

  for (const t of trades) {
    if (t.isOpen) {
      openExcluded++;
      continue;
    }
    count++;
    differences += Math.abs(t.grossPnl);
    if (OPTION_SEGMENTS.has(t.segment)) optionPremium += Math.max(0, t.sellValue);
  }

  const d = r2(differences);
  const p = r2(optionPremium);
  return { differences: d, optionPremium: p, total: r2(d + p), trades: count, openExcluded };
}
