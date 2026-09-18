// PRICING — the single source of truth for what Vyuha costs (PURE, zero imports).
//
// Until 2026-08-12 no price existed anywhere in the app. The block-mode upsell
// panel — the entire top of the funnel — listed features and said "Lifetime
// license" without ever answering *how much*; every prospect had to open a
// WhatsApp chat to find out. The numbers lived only in the sales assets, and
// two of those disagreed with each other.
//
// ── Where the numbers come from, and who wins ───────────────────────────────
//
// Seeded from docs/sales/landing-page.html — the page buyers actually see —
// which OVERRULES the recommendation ranges in docs/owner/MONETIZATION_PLAN.md
// (those are strategy, not shipped prices; the plan is annotated to say so).
// `tests/pricing.test.ts` pins each amount here to the landing page's own
// price cells, so the app and the sales copy cannot drift within a release.
// The owner intends to revise prices: change them HERE and on the landing
// page in the same commit — the test holds the two together.
//
// ── Staleness, honestly (this is an OFFLINE app) ────────────────────────────
//
// A price baked into a build goes stale on the user's disk, and there is no
// pricing endpoint to refresh it from — the only UNPROMPTED outbound call this
// app makes is the launch update/revocation download, which carries releases
// and revoked key ids and deliberately nothing else (everything else that
// touches the network — EOD prices, broker pulls and their opt-in launch
// auto-pull, the Telegram digest — is user-enabled, and none of it carries
// pricing either). Three mitigations, none of which hide the
// number: every rendered price carries "as of <date>"; the WhatsApp buy
// message EMBEDS the quoted price, so the seller sees at first contact what
// the buyer was shown and can honour or correct it; and past
// PRICING_STALE_AFTER_DAYS the caption switches to "confirm the current
// price" — the number itself never disappears, because a hidden price is the
// exact funnel leak this module exists to fix.
//
// Zero imports — this file is read by client components through lib/license.ts
// and must stay browser-safe (see AGENTS.md on `npm run verify`).

export type PricingSkuId = "lifetime" | "annual" | "monthly";

export interface PricingSku {
  id: PricingSkuId;
  /** The sku minted into signed keys by scripts/license-issue.mjs. */
  licenseSku: "app" | "toolkit";
  name: string;
  /** Whole rupees. */
  amountInr: number;
  /** Struck-through anchor price, where one is advertised. */
  wasInr?: number;
  /**
   * The price from the SECOND period on, where the first one is an
   * introductory price. Set only on `monthly` today; `renewalLabel()` turns it
   * into the one sentence every surface prints under the amount.
   */
  thenInr?: number;
  term: "lifetime" | "annual" | "monthly";
  /** Exactly one SKU carries this — the visually recommended offer. */
  featured?: true;
  /** One line under the amount: what kind of payment this is. */
  blurb: string;
  /** The ✓ bullets, kept in step with the landing page's own list. */
  includes: readonly string[];
}

/** The date these numbers were last confirmed against the landing page. */
export const PRICING_AS_OF = "2026-09-18";

/** After this many days, rendered prices say "confirm before paying". */
export const PRICING_STALE_AFTER_DAYS = 120;

// Repriced 2026-08-12 (owner decision): two SKUs, clean numbers. The
// TradingView indicators bundle came OFF the pricing surfaces entirely;
// indicators remain a WhatsApp conversation.
//
// Launch offer, 2026-08-15 (owner decision, recorded in docs/DECISIONS.md):
// the anchors below are the REAL list prices the owner has committed to
// charging from 2027-01-01 — ₹13,000/yr and ₹35,999 — not invented
// strike-throughs. The offer's end date is deliberately NOT rendered in-app
// (owner's call); it lives here and in the owner docs so the claim stays
// auditable. The savings percentages are DERIVED (offerPct), never hand-typed:
// 13,000→7,999 is 38%, 35,999→29,999 is 16% — the owner's requested "30%/20%"
// labels did not survive division and were corrected, not displayed.
// Lifetime is now the featured entry — the owner sells lifetime first.
//
// ── 2026-09-18 (owner ruling): a MONTHLY plan, given on request ─────────────
//
// "Introduce a monthly plan, given on the user's request, at ₹599 — a LAUNCH
// OFFER for the first month; ₹999 per month from the second month; highlight
// and show this." Yearly (₹7,999) and Lifetime (₹29,999) are unchanged.
//
// The anchor obeys the same honesty rule as the 2026-08-15 launch anchors: 999
// is the REAL price the buyer pays from month two, not an invented
// strike-through, so offerPct() derives 40% (1 − 599/999 = 40.04%, floored).
// `thenInr` exists so the second-month price is a FIELD every surface must
// render (renewalLabel), not a sentence one surface can forget.
//
// Two things deliberately NOT promised, because neither was ruled: there is no
// upgrade credit from monthly (upgradeCredit stays annual → lifetime only),
// and there is no auto-renewal or stored card — each month is a fresh key
// issued on request, which is exactly what the licence model already does.
// Monthly is NOT featured: lifetime stays the single featured card.
//
// ── 2026-09-18, the next session (owner): "MONTHLY PLAN CHANGE IT TO 999
// (original price from second month will be 1499)" ─────────────────────────
// ₹999 for the first month (launch offer), ₹1,499 per month from the second.
// Same honesty rule: 1,499 is the real month-two price, so offerPct() now
// derives 33% (1 − 999/1499 = 33.36%, floored). The ₹599 / ₹999 pair above
// is history; nothing else about the plan changed.
export const PRICING: readonly PricingSku[] = [
  {
    id: "lifetime",
    licenseSku: "app",
    name: "Journal — Lifetime",
    amountInr: 29999,
    wasInr: 35999,
    term: "lifetime",
    featured: true,
    blurb: "one-time · lifetime licence",
    includes: [
      "Everything in Pro, forever — no renewal, ever",
      "Every Pro analytics screen, all broker importers",
      "Every future upgrade at no extra cost — exciting, useful features on the roadmap",
      "Charges computed to the rupee, on your machine — nothing you enter ever leaves it",
      "Priority support on WhatsApp",
    ],
  },
  {
    id: "annual",
    licenseSku: "app",
    name: "Pro — Annual",
    // Repriced 2026-08-31 (owner decision): 9,999 → 7,999. The anchor is
    // unchanged, so offerPct() now derives 38% (13,000 → 7,999 is 38.46%,
    // floored). Lifetime deliberately untouched — the gap between the two is
    // the point, and the owner sells lifetime first.
    amountInr: 7999,
    wasInr: 13000,
    term: "annual",
    blurb: "per year · renews with a fresh key",
    includes: [
      "The full Vyuha desktop app",
      "Every Pro analytics screen — risk, edge, discipline, options, full tax pack",
      "The charges engine verified within 0.69% of a real broker report",
      "All broker importers and free updates through the year",
      "Upgrade to lifetime any time before your year ends — what you paid for the year comes off the lifetime price",
    ],
  },
  {
    id: "monthly",
    licenseSku: "app",
    name: "Pro — Monthly",
    amountInr: 999,
    wasInr: 1499,
    thenInr: 1499,
    term: "monthly",
    blurb: "first month · launch offer · then ₹1,499/month",
    includes: [
      "The full Vyuha desktop app",
      "Every Pro analytics screen",
      "All broker importers and updates while the plan is active",
      "Given on request — message us and a one-month key is issued; each month renews with a fresh key",
      "Move to Annual or Lifetime whenever you like",
    ],
  },
];

/**
 * Annual → Lifetime upgrade, owner decision 2026-08-15: FULL CREDIT within the
 * year. While the annual key is unexpired, the buyer owes the lifetime launch
 * price minus what they ACTUALLY paid for the year — not the list price, not a
 * pro-rata slice. An expired annual key gets no credit (sell lifetime at the
 * current price). Pure so scripts/license-upgrade.mjs and the receipt can be
 * pinned to the same arithmetic; `due` never goes below zero.
 */
export function upgradeCredit({ lifetime, paidForYear }: { lifetime: number; paidForYear: number }): {
  credit: number;
  due: number;
} {
  if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error("upgradeCredit: lifetime price must be > 0");
  if (!Number.isFinite(paidForYear) || paidForYear < 0) throw new Error("upgradeCredit: paidForYear must be >= 0");
  const credit = Math.min(paidForYear, lifetime);
  return { credit, due: lifetime - credit };
}

export function skuById(id: PricingSkuId): PricingSku {
  const sku = PRICING.find((s) => s.id === id);
  if (!sku) throw new Error(`unknown pricing sku: ${id}`);
  return sku;
}

export function featuredSku(): PricingSku {
  return PRICING.find((s) => s.featured) ?? PRICING[0];
}

/** ₹29,999 / ₹7,999 — en-IN grouping, matching the landing page exactly. */
export function formatInr(amount: number): string {
  return `₹${amount.toLocaleString("en-IN")}`;
}

/**
 * Launch-offer savings, DERIVED from the anchor so a displayed percentage can
 * never disagree with the arithmetic. Null when no anchor is advertised.
 * Floor, not round: 16.67% displayed as "17% off" overstates the discount,
 * and a discount claim must never overstate. Understating by <1% is fine.
 */
export function offerPct(sku: PricingSku): number | null {
  if (sku.wasInr == null || sku.wasInr <= sku.amountInr) return null;
  return Math.floor((1 - sku.amountInr / sku.wasInr) * 100);
}

export function priceLabel(sku: PricingSku): string {
  if (sku.term === "annual") return `${formatInr(sku.amountInr)}/yr`;
  if (sku.term === "monthly") return `${formatInr(sku.amountInr)}/mo`;
  return formatInr(sku.amountInr);
}

/**
 * "then ₹999/month from the second month" — the sentence an introductory price
 * may never be shown without. Null when the SKU has no second-period price, so
 * a surface renders it unconditionally and gets nothing for lifetime/annual.
 * The unit follows the TERM, so a future introductory annual reads "year".
 */
export function renewalLabel(sku: PricingSku): string | null {
  if (sku.thenInr == null) return null;
  const unit = sku.term === "annual" ? "year" : "month";
  return `then ${formatInr(sku.thenInr)}/${unit} from the second ${unit}`;
}

/**
 * True once this build's prices are old enough that quoting them without a
 * caveat would be dishonest. Pure so the boundary is testable.
 */
export function pricingIsStale(asOf: string, today: Date): boolean {
  const from = new Date(`${asOf}T00:00:00Z`).getTime();
  if (!Number.isFinite(from)) return true;
  return (today.getTime() - from) / 86_400_000 > PRICING_STALE_AFTER_DAYS;
}

/**
 * The pre-filled WhatsApp message for one SKU. It EMBEDS the quoted price and
 * the as-of date — the transaction is a conversation, not a checkout, so the
 * seller sees at first contact exactly what this build showed the buyer.
 */
export function buyMessageFor(sku: PricingSku): string {
  // An introductory price goes out with its second-period price attached: the
  // seller must see the same two numbers the buyer was shown.
  const then = sku.thenInr != null ? ` first month, then ${formatInr(sku.thenInr)}/month` : "";
  return `Hi, I'd like the Vyuha ${sku.name} (${priceLabel(sku)}${then}, price shown in-app as of ${PRICING_AS_OF})`;
}
