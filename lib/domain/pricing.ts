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
// A price baked into a build goes stale on the user's disk, and this app
// promises never to phone home. Three mitigations, none of which hide the
// number: every rendered price carries "as of <date>"; the WhatsApp buy
// message EMBEDS the quoted price, so the seller sees at first contact what
// the buyer was shown and can honour or correct it; and past
// PRICING_STALE_AFTER_DAYS the caption switches to "confirm the current
// price" — the number itself never disappears, because a hidden price is the
// exact funnel leak this module exists to fix.
//
// Zero imports — this file is read by client components through lib/license.ts
// and must stay browser-safe (see AGENTS.md on `npm run verify`).

export type PricingSkuId = "lifetime" | "annual";

export interface PricingSku {
  id: PricingSkuId;
  /** The sku minted into signed keys by scripts/license-issue.mjs. */
  licenseSku: "app" | "toolkit";
  name: string;
  /** Whole rupees. */
  amountInr: number;
  /** Struck-through anchor price, where one is advertised. */
  wasInr?: number;
  term: "lifetime" | "annual";
  /** Exactly one SKU carries this — the visually recommended offer. */
  featured?: true;
  /** One line under the amount: what kind of payment this is. */
  blurb: string;
  /** The ✓ bullets, kept in step with the landing page's own list. */
  includes: readonly string[];
}

/** The date these numbers were last confirmed against the landing page. */
export const PRICING_AS_OF = "2026-08-12";

/** After this many days, rendered prices say "confirm before paying". */
export const PRICING_STALE_AFTER_DAYS = 120;

// Repriced 2026-08-12 (owner decision, same day as the first in-app pricing
// shipped): two SKUs, clean numbers, no strike-through anchor and no scarcity
// framing — at a premium price the credibility is the pitch. The TradingView
// indicators bundle came OFF the pricing surfaces entirely; indicators remain
// a WhatsApp conversation. Annual is the featured entry; lifetime sits above
// it as the commitment offer.
export const PRICING: readonly PricingSku[] = [
  {
    id: "annual",
    licenseSku: "app",
    name: "Pro — Annual",
    amountInr: 9999,
    term: "annual",
    featured: true,
    blurb: "per year · renews with a fresh key",
    includes: [
      "The full Vyuha desktop app",
      "Every Pro analytics screen — risk, edge, discipline, options, full tax pack",
      "All broker importers and free updates through the year",
      "Upgrade to lifetime any time — the year you paid counts toward it",
    ],
  },
  {
    id: "lifetime",
    licenseSku: "app",
    name: "Journal — Lifetime",
    amountInr: 29999,
    term: "lifetime",
    blurb: "one-time · lifetime licence",
    includes: [
      "Everything in Pro, forever — no renewal, ever",
      "Every Pro analytics screen, all broker importers",
      "Free updates for the life of the product",
      "Priority support on WhatsApp",
    ],
  },
];

export function skuById(id: PricingSkuId): PricingSku {
  const sku = PRICING.find((s) => s.id === id);
  if (!sku) throw new Error(`unknown pricing sku: ${id}`);
  return sku;
}

export function featuredSku(): PricingSku {
  return PRICING.find((s) => s.featured) ?? PRICING[0];
}

/** ₹1,499 / ₹499⁄yr — en-IN grouping, matching the landing page exactly. */
export function formatInr(amount: number): string {
  return `₹${amount.toLocaleString("en-IN")}`;
}

export function priceLabel(sku: PricingSku): string {
  return sku.term === "annual" ? `${formatInr(sku.amountInr)}/yr` : formatInr(sku.amountInr);
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
  return `Hi, I'd like the Vyuha ${sku.name} (${priceLabel(sku)}, price shown in-app as of ${PRICING_AS_OF})`;
}
