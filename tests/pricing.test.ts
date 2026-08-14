import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PRICING,
  PRICING_AS_OF,
  formatInr,
  priceLabel,
  featuredSku,
  offerPct,
  skuById,
  pricingIsStale,
  buyMessageFor,
} from "@/lib/domain/pricing";
import { buyUrlFor, BUY_URL, LICENSE_ENFORCEMENT } from "@/lib/license";

/**
 * The prices the app shows are a claim the seller has to honour. Two things
 * keep the claim honest: the shape tests (one featured SKU, sane anchors),
 * and the ANTI-DRIFT test pinning every in-app amount to the landing page's
 * own price cells — the two surfaces a prospect can compare side by side.
 */

describe("shape", () => {
  it("SKU ids are unique and exactly one SKU is featured", () => {
    expect(new Set(PRICING.map((s) => s.id)).size).toBe(PRICING.length);
    expect(PRICING.filter((s) => s.featured)).toHaveLength(1);
  });

  it("amounts are positive whole rupees, and every anchor exceeds its price", () => {
    for (const s of PRICING) {
      expect(Number.isInteger(s.amountInr), s.id).toBe(true);
      expect(s.amountInr).toBeGreaterThan(0);
      if (s.wasInr != null) expect(s.wasInr).toBeGreaterThan(s.amountInr);
      expect(s.includes.length).toBeGreaterThan(0);
    }
  });

  it("every SKU maps to a licence sku the key issuer can mint", () => {
    for (const s of PRICING) expect(["app", "toolkit"]).toContain(s.licenseSku);
  });

  it("skuById throws on an unknown id rather than quoting nothing", () => {
    expect(() => skuById("nope" as never)).toThrow(/unknown/);
    // Launch offer 2026-08-15: Lifetime is now the featured (best value)
    // entry — the owner sells lifetime first. The anchors are the committed
    // 2027-01-01 list prices, not invented strike-throughs.
    expect(featuredSku().id).toBe("lifetime");
    expect(skuById("lifetime").amountInr).toBe(29999);
    expect(skuById("annual").amountInr).toBe(9999);
    expect(skuById("lifetime").wasInr).toBe(35999);
    expect(skuById("annual").wasInr).toBe(13000);
  });

  it("savings percentages are derived from the anchors, never hand-typed", () => {
    // The owner's requested "30% / 20%" labels did not survive division —
    // these are the honest figures, and they come out of offerPct() so a
    // displayed percentage can never disagree with the arithmetic. Floored:
    // lifetime's true 16.67% must display as 16, never round up to 17 —
    // a discount claim never overstates.
    expect(offerPct(skuById("annual"))).toBe(23);
    expect(offerPct(skuById("lifetime"))).toBe(16);
    expect(offerPct({ ...skuById("annual"), wasInr: undefined })).toBeNull();
  });
});

describe("anti-drift — the app and the landing page quote the same numbers", () => {
  // Extract only the <div class="amt"> blocks, not the whole document: the
  // page also contains ₹ strings that are NOT prices (an index-limit example),
  // and matching those would let a real price drift hide behind them.
  const html = fs.readFileSync(path.join(process.cwd(), "docs", "sales", "landing-page.html"), "utf8");
  const amtBlocks = [...html.matchAll(/<div class="amt">([\s\S]*?)<\/div>/g)].map((m) => m[1]);

  it("found the landing page's price cells at all", () => {
    expect(amtBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it("every in-app amount (and anchor) appears in a landing-page price cell", () => {
    const joined = amtBlocks.join(" ");
    for (const s of PRICING) {
      expect(joined, `${s.id}: ${formatInr(s.amountInr)} not on the landing page`).toContain(formatInr(s.amountInr));
      if (s.wasInr != null) {
        expect(joined, `${s.id} anchor ${formatInr(s.wasInr)} not on the landing page`).toContain(formatInr(s.wasInr));
      }
    }
  });
});

describe("staleness is a fact about a date, not a vibe", () => {
  it("flips only after the window", () => {
    expect(pricingIsStale("2026-08-12", new Date("2026-09-20T00:00:00Z"))).toBe(false);
    expect(pricingIsStale("2026-08-12", new Date("2027-01-20T00:00:00Z"))).toBe(true);
    expect(pricingIsStale("garbage", new Date("2026-08-12T00:00:00Z"))).toBe(true); // unreadable = assume stale
  });

  it("PRICING_AS_OF parses and is not in the future", () => {
    const t = new Date(`${PRICING_AS_OF}T00:00:00Z`).getTime();
    expect(Number.isFinite(t)).toBe(true);
    // The as-of value is a CALENDAR date with no timezone. Comparing its UTC
    // midnight straight against Date.now() rejected an honest same-day date
    // set on an IST morning (00:31 IST is still "yesterday" in UTC). Accept
    // any date that has begun somewhere on Earth (UTC+14) — a date that is
    // tomorrow everywhere is still post-dated and still fails.
    expect(t - 14 * 3_600_000).toBeLessThanOrEqual(Date.now());
  });
});

describe("the buy message carries the quote", () => {
  it("names the SKU, the price and the as-of date", () => {
    const msg = buyMessageFor(skuById("lifetime"));
    expect(msg).toContain("Journal — Lifetime");
    expect(msg).toContain("₹29,999");
    expect(msg).toContain(PRICING_AS_OF);
    // Annual quotes per-year, so nobody pays ₹9,999 expecting lifetime.
    expect(buyMessageFor(skuById("annual"))).toContain("₹9,999/yr");
  });

  it("buyUrlFor() with no SKU is byte-identical to the frozen BUY_URL", () => {
    // The refactor that introduced per-SKU links must not have moved the
    // default link — every existing call site still reads BUY_URL.
    expect(buyUrlFor()).toBe(BUY_URL);
  });

  it("per-SKU links stay on the same WhatsApp channel and embed the price", () => {
    const url = buyUrlFor("annual");
    expect(url).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(decodeURIComponent(url)).toContain("₹9,999/yr");
  });
});

describe("the emailable standalone landing page", () => {
  /**
   * `docs/sales/landing-page.standalone.html` is GENERATED from
   * landing-page.html by scripts/build-landing.mjs (npm run landing:build) and
   * is gitignored — so it exists on the seller's machine and not in CI, and
   * this block skips when it is absent.
   *
   * It is checked because it is the file actually EMAILED to a prospect, and
   * it silently rotted for four releases: it was still quoting ₹1,499 /
   * ₹4,999 / ₹499 and a retired SKU long after the v2.99.76 reprice, and still
   * carried the pre-v2.99.91 "no network activity" answer. landing-page.html
   * was pinned by the tests above the whole time; nothing looked at its
   * generated twin, because regenerating was a manual step nobody had written
   * down.
   */
  const standalone = path.join(process.cwd(), "docs", "sales", "landing-page.standalone.html");
  const exists = fs.existsSync(standalone);

  it.skipIf(!exists)("quotes the SAME prices as the pricing module — regenerate it if this fails", () => {
    const html = fs.readFileSync(standalone, "utf8");
    for (const sku of PRICING) {
      expect(
        html,
        `${sku.name} (${priceLabel(sku)}) is missing — run: npm run landing:build`,
      ).toContain(formatInr(sku.amountInr));
    }
  });

  it.skipIf(!exists)("carries no retired price and no superseded network claim", () => {
    const html = fs.readFileSync(standalone, "utf8");
    // The exact numbers it was stuck on, and the sentence v2.99.91 corrected.
    for (const dead of ["₹1,499", "₹4,999", "₹499/yr"]) {
      expect(html, `retired price ${dead} still present — run: npm run landing:build`).not.toContain(dead);
    }
    expect(html, "pre-v2.99.91 network answer — run: npm run landing:build").toContain("download-only");
  });
});

describe("launch configuration guard", () => {
  it("block enforcement never ships without a price to show", () => {
    // Same spirit as the dead-buy-link guard in tests/license.test.ts: a
    // blocking upsell panel with no price is the funnel leak this fixes.
    if (LICENSE_ENFORCEMENT === "block") {
      expect(PRICING.length).toBeGreaterThan(0);
      expect(priceLabel(featuredSku())).toMatch(/^₹/);
    }
  });
});
