/**
 * TAX LEVERS — what the journal can COMPUTE, and where it must stop.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── The line this module is built on ──────────────────────────────────────
 *
 * Every candidate lever was classified three ways, and the classification IS
 * the design:
 *
 *   (A) DETERMINISTIC — computable exactly from executed-trade data. Compute it
 *       and show it.
 *   (B) NEEDS EXTERNAL FACTS — salary, other capital assets, prior returns,
 *       residential status. Blank it and SAY what is missing (invariant 6).
 *   (C) ADVICE — would be a recommendation rather than a computation. State the
 *       rule and its source; never the recommendation.
 *
 * Only (A) lives in this file. (B) appears as named caveats below. (C) is
 * enforced by absence: there is deliberately no function here that selects a
 * scrip to sell, ranks "opportunities", or estimates a liability.
 *
 * ── Three things that must never be said, and why ─────────────────────────
 *
 * 1. "Sell X to save tax." Naming a security and prompting a transaction is
 *    outside the SEBI (Investment Advisers) Regulations 2013 reg. 4 exemption
 *    for general comments on trends "without specifying particular securities".
 * 2. "Wait 30 days before buying back." India has NO wash-sale rule. Inventing a
 *    holding period teaches the user false law — this is worse than silence.
 * 3. "This is safe" / "the department will not question it." An assurance about
 *    a scrutiny outcome is not a computation.
 *
 * What IS safe, and is what this module does: report what happened, report what
 * the statute says, and let the user and their CA decide.
 */

import { DELIVERY_SEGMENTS, FNO_SEGMENTS, SPECULATIVE_SEGMENT } from "./turnover";
import { section, type SectionKey } from "./statute";

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 86400000;
const LONG_TERM_DAYS = 365;

// ---------------------------------------------------------------------------
// (B) — the facts a journal cannot know. Stated, never guessed.
// ---------------------------------------------------------------------------

/**
 * The single most common wrong number in this category across the market: every
 * competitor's harvesting screen applies the long-term exemption per ACCOUNT.
 * The threshold is per PERSON per tax year across all qualifying gains.
 */
export const LTCG_THRESHOLD_CAVEAT =
  "The long-term exemption threshold is per PERSON per tax year, across every qualifying gain you have — including equity or funds held with another broker, a registrar, or on another platform. Vyuha can only see what you have imported here, so treat any threshold figure on this screen as an upper bound on the headroom you actually have.";

export const LIABILITY_CAVEAT =
  "Vyuha does not compute what you owe. That needs your salary, other heads of income, other capital assets, brought-forward losses from earlier returns, your residential status and your regime election — none of which are in a trade book. What is below is what your trades did, and what the statute says about it.";

export const NO_WASH_SALE_CAVEAT =
  "India has no wash-sale rule: nothing in the Act imposes a waiting period between selling at a loss and buying back. Any journal telling you to wait a fixed number of days is inventing a rule. What does exist is the ordinary question of whether a sale was genuine — an on-exchange sale at market price, where you actually bore the risk of the price moving, is a real transfer.";

// ---------------------------------------------------------------------------
// (A1) — STT is deductible on one head and forfeited on another
// ---------------------------------------------------------------------------

export interface LeverTrade {
  segment: string;
  buyDate: string | null;
  sellDate: string | null;
  netPnl: number;
  chargesTotal: number;
  /** STT/CTT component of chargesTotal. */
  sttCtt: number;
  isOpen: boolean;
}

export interface SttSplit {
  /** STT/CTT on business-head legs — an allowable expense. */
  deductible: number;
  /** STT on capital-gains legs — expressly NOT deductible. */
  forfeited: number;
  total: number;
  deductibleTrades: number;
  forfeitedTrades: number;
  /** Citations for the year, so the two halves can be checked. */
  deductibleSection: string;
  forfeitedSection: string;
}

/**
 * The same rupee of STT is an allowable business expense on an F&O or intraday
 * leg and a forfeited cost on a delivery leg. Exact, computable, and shown by
 * nobody — most reports net STT into one "charges" figure and lose the split.
 */
export function sttSplit(trades: LeverTrade[], fy: string): SttSplit {
  let deductible = 0;
  let forfeited = 0;
  let deductibleTrades = 0;
  let forfeitedTrades = 0;

  for (const t of trades) {
    if (t.isOpen) continue;
    const isBusiness = t.segment === SPECULATIVE_SEGMENT || FNO_SEGMENTS.has(t.segment);
    if (isBusiness) {
      deductible += t.sttCtt;
      deductibleTrades++;
    } else if (DELIVERY_SEGMENTS.has(t.segment)) {
      forfeited += t.sttCtt;
      forfeitedTrades++;
    }
  }

  return {
    deductible: r2(deductible),
    forfeited: r2(forfeited),
    total: r2(deductible + forfeited),
    deductibleTrades,
    forfeitedTrades,
    deductibleSection: section(fy, "sttBusinessExpense" as SectionKey),
    forfeitedSection: section(fy, "sttNotDeductibleCg" as SectionKey),
  };
}

// ---------------------------------------------------------------------------
// (A2) — how long until an open lot becomes long-term
// ---------------------------------------------------------------------------

export interface OpenLot {
  id: number;
  symbol: string;
  segment: string;
  buyDate: string | null;
  /** Unrealised P&L at the current mark; may be negative. */
  unrealised: number;
}

export interface LtcgRunwayRow {
  id: number;
  symbol: string;
  buyDate: string;
  daysHeld: number;
  /** Days until the 12-month line. 0 once already long-term. */
  daysToLongTerm: number;
  alreadyLongTerm: boolean;
  unrealised: number;
}

export interface LtcgRunway {
  rows: LtcgRunwayRow[];
  /** Lots crossing within the window the caller asked about. */
  crossingSoon: number;
  /** Open delivery lots with no buy date — cannot be aged. Reported, not hidden. */
  undated: number;
}

/**
 * Days to the long-term line for each open delivery lot.
 *
 * This is pure date arithmetic on the user's own positions, so it is squarely
 * (A). It states a FACT — "this lot turns long-term in 12 days" — and stops
 * there. It does not say "hold it", because whether to hold a position for a tax
 * reason is an investment decision, and one that can cost far more in price risk
 * than it saves in tax.
 */
export function ltcgRunway(lots: OpenLot[], today: string, soonDays = 30): LtcgRunway {
  const rows: LtcgRunwayRow[] = [];
  let undated = 0;
  const now = new Date(today + "T00:00:00").getTime();

  for (const l of lots) {
    if (!DELIVERY_SEGMENTS.has(l.segment)) continue; // only capital assets age
    if (!l.buyDate) {
      undated++;
      continue;
    }
    const daysHeld = Math.floor((now - new Date(l.buyDate + "T00:00:00").getTime()) / DAY_MS);
    const daysToLongTerm = Math.max(0, LONG_TERM_DAYS - daysHeld);
    rows.push({
      id: l.id,
      symbol: l.symbol,
      buyDate: l.buyDate,
      daysHeld,
      daysToLongTerm,
      alreadyLongTerm: daysHeld >= LONG_TERM_DAYS,
      unrealised: r2(l.unrealised),
    });
  }

  rows.sort((a, b) => a.daysToLongTerm - b.daysToLongTerm || b.unrealised - a.unrealised);
  return {
    rows,
    crossingSoon: rows.filter((r) => !r.alreadyLongTerm && r.daysToLongTerm <= soonDays).length,
    undated,
  };
}

// ---------------------------------------------------------------------------
// (A3) — the set-off asymmetry, which is where the real money usually is
// ---------------------------------------------------------------------------

export interface SetOffPosition {
  /** Non-speculative business result for the year (F&O). */
  fnoBusiness: number;
  /** Speculative business result (intraday equity). */
  speculative: number;
  /** Realised capital gains for the year, both terms combined. */
  capitalGains: number;
}

export interface SetOffFinding {
  /** The statutory point, always stated. */
  rule: string;
  /** What this particular book makes of it, or null when nothing applies. */
  finding: string | null;
  /** Rupees of loss that could meet gains THIS year under the in-year rule. */
  absorbableNow: number;
}

/**
 * The asymmetry every harvesting screen in the market misses, because they are
 * all equity-holdings-only.
 *
 * A CURRENT-YEAR business loss can be set off against income under any other
 * head INCLUDING capital gains — but never against salary. Once CARRIED FORWARD
 * it can only ever meet business income again. So the same rupee of F&O loss is
 * frequently worth more used this year than banked, and that is a fact about the
 * statute, not a recommendation about what to trade.
 *
 * Speculative loss is quarantined in both directions: it meets speculative
 * profit only, in-year and forward.
 */
export function setOffAsymmetry(p: SetOffPosition, fy: string): SetOffFinding {
  const interHead = section(fy, "interHeadSetOff");
  const cfBusiness = section(fy, "cfBusinessLoss");
  const speculationLoss = section(fy, "speculationLoss");

  const rule = `A current-year non-speculative business loss (F&O) can be set off against other heads including capital gains (${interHead}) — but NEVER against salary. Once carried forward it can only meet business income (${cfBusiness}), for eight years. A speculative loss (intraday) meets speculative profit only, in-year and forward, for four (${speculationLoss}).`;

  const fnoLoss = p.fnoBusiness < 0 ? -p.fnoBusiness : 0;
  const absorbableNow = r2(Math.min(fnoLoss, Math.max(0, p.capitalGains)));

  let finding: string | null = null;
  if (fnoLoss > 0 && p.capitalGains > 0) {
    finding = `You have an F&O loss of ₹${r2(fnoLoss).toLocaleString("en-IN")} and realised capital gains of ₹${r2(p.capitalGains).toLocaleString("en-IN")} in ${fy}. Up to ₹${absorbableNow.toLocaleString("en-IN")} of that loss can meet those gains in THIS year's return; carried forward instead, it could only ever meet future business income.`;
  } else if (fnoLoss > 0) {
    finding = `Your F&O loss of ₹${r2(fnoLoss).toLocaleString("en-IN")} has no capital gains to meet in ${fy}. Carried forward it can only be set off against business income, so it needs a return filed by the due date to survive at all.`;
  } else if (p.speculative < 0) {
    finding = `Your intraday loss of ₹${r2(-p.speculative).toLocaleString("en-IN")} is speculative and is quarantined: it cannot meet F&O profit, capital gains or salary in any year — only speculative profit, and only for four years.`;
  }

  return { rule, finding, absorbableNow };
}

/**
 * Whether the book carries anything this surface can speak to at all. Used to
 * decide between rendering the levers and rendering nothing — an empty tax
 * planner full of zeroes invites a user to read meaning into them.
 */
export function hasLeverContent(s: SttSplit, r: LtcgRunway, f: SetOffFinding): boolean {
  return s.total > 0 || r.rows.length > 0 || f.finding != null;
}
