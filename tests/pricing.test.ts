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
  upgradeCredit,
} from "@/lib/domain/pricing";
import {
  buyUrlFor,
  BUY_URL,
  LICENSE_ENFORCEMENT,
  WHATSAPP_NUMBER,
  buyMessageText,
  formatWhatsAppNumber,
} from "@/lib/license";

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

describe("annual → lifetime upgrade — one sentence, one formula, every surface", () => {
  // Owner decision 2026-08-15: full credit within the year. The sentence the
  // buyer reads must be the same on the pricing screen (module), the landing
  // page and the brochure, and it must describe what upgradeCredit() computes.
  const UPGRADE_COPY =
    "Upgrade to lifetime any time before your year ends — what you paid for the year comes off the lifetime price";

  it("the module carries the sentence and no older phrasing", () => {
    const annual = skuById("annual");
    expect(annual.includes).toContain(UPGRADE_COPY);
    expect(annual.includes.join(" ")).not.toContain("counts toward");
  });

  it("the landing page and the brochure carry it verbatim, and the indicators FAQ is gone", () => {
    const landing = fs.readFileSync(path.join(process.cwd(), "docs", "sales", "landing-page.html"), "utf8");
    expect(landing).toContain(UPGRADE_COPY);
    expect(landing).not.toContain("counts toward it");
    expect(landing).not.toContain("Do the indicators tell me what to buy?");
    const brochure = fs.readFileSync(path.join(process.cwd(), "docs", "sales", "brochure.html"), "utf8");
    expect(brochure).toContain("Upgrade to lifetime any time before your year ends");
    expect(brochure).not.toMatch(/INDICATORS|Indicators band|indicator names/);
    const standalone = path.join(process.cwd(), "docs", "sales", "landing-page.standalone.html");
    if (fs.existsSync(standalone)) {
      expect(fs.readFileSync(standalone, "utf8"), "run: npm run landing:build").toContain(UPGRADE_COPY);
    }
  });

  it("upgradeCredit: due = lifetime − paid, never negative, at today's prices ₹20,000", () => {
    const life = skuById("lifetime").amountInr;
    const year = skuById("annual").amountInr;
    expect(upgradeCredit({ lifetime: life, paidForYear: year })).toEqual({ credit: year, due: life - year });
    expect(upgradeCredit({ lifetime: 29999, paidForYear: 9999 }).due).toBe(20000);
    expect(upgradeCredit({ lifetime: 100, paidForYear: 500 })).toEqual({ credit: 100, due: 0 });
    expect(() => upgradeCredit({ lifetime: 0, paidForYear: 1 })).toThrow();
    expect(() => upgradeCredit({ lifetime: 100, paidForYear: -1 })).toThrow();
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

describe("the buy step is a dialog, never a bare target=_blank anchor", () => {
  /**
   * In the Tauri desktop webview (WebView2, no opener/shell plugin) an
   * external `target="_blank"` anchor does NOTHING — every "Get Vyuha Pro" /
   * "Get {plan}" / "Renew" CTA was such an anchor, so a desktop buyer clicked
   * Get and nothing happened. 2026-08-15: every CTA opens BuyDialog, which
   * shows the number and the message to copy; the wa.me anchor survives only
   * INSIDE the dialog as the browser-case shortcut. String-level guard.
   */
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  const CTA_SURFACES = [
    "components/system/pricing-table.tsx",
    "components/system/pro-gate.tsx",
    "components/settings/license-card.tsx",
  ];
  // A JSX anchor whose href is a buy link and which opens a new tab.
  const BARE_BUY_ANCHOR = /<a\s[^>]*href=\{(?:BUY_URL|buyUrlFor\([^)]*\))\}[^>]*target="_blank"/;

  it("no CTA surface renders a bare buy anchor; each renders BuyDialog", () => {
    for (const rel of CTA_SURFACES) {
      const src = read(rel);
      expect(src, `${rel} still has a target=_blank buy anchor`).not.toMatch(BARE_BUY_ANCHOR);
      expect(src, `${rel} does not render <BuyDialog`).toContain("<BuyDialog");
    }
  });

  it("buy-dialog.tsx keeps exactly one wa.me anchor, inside the dialog, and is a client component", () => {
    const src = read("components/system/buy-dialog.tsx");
    expect(src.startsWith('"use client"')).toBe(true);
    const anchors = src.match(/<a\s[^>]*target="_blank"/g) ?? [];
    expect(anchors, "one secondary Open WhatsApp anchor").toHaveLength(1);
    expect(src.indexOf("<DialogContent")).toBeLessThan(src.indexOf('target="_blank"'));
    // No window.open() race before the dialog — in the webview it no-ops.
    expect(src).not.toContain("window.open(");
    // The number and the message are shown via the pure helpers, and the copy
    // buttons plus the offline reassurance are present.
    expect(src).toContain("formatWhatsAppNumber(");
    expect(src).toContain("buyMessageText(");
    expect(src).toContain("Copy number");
    expect(src).toContain("Copy message");
    expect(src).toContain("Vyuha is fully offline");
  });

  it("the number reads as +91 XXXXX XXXXX and carries exactly WHATSAPP_NUMBER's digits", () => {
    expect(formatWhatsAppNumber("917393673714")).toBe("+91 73936 73714");
    const shown = formatWhatsAppNumber();
    expect(shown).toMatch(/^\+91 \d{5} \d{5}$/);
    expect(shown.replace(/\D/g, "")).toBe(WHATSAPP_NUMBER);
    // Non-Indian or oddly-sized numbers still render, just unformatted.
    expect(formatWhatsAppNumber("4471234567")).toBe("+4471234567");
    expect(formatWhatsAppNumber("")).toBe("");
  });

  it("the copyable message is byte-identical to what the wa.me link carries", () => {
    for (const skuId of [undefined, "lifetime", "annual"] as const) {
      const url = new URL(buyUrlFor(skuId));
      expect(url.searchParams.get("text")).toBe(buyMessageText(skuId));
    }
    expect(buyMessageText("lifetime")).toContain("₹29,999");
  });

  it("the compact pills are buttons that open the plan's card, not inert spans", () => {
    const src = read("components/system/pricing-table.tsx");
    expect(src).toContain("Show plan details");
    expect(src).toContain("<DialogTrigger asChild>");
    // One card body for both the grid and the popup — they cannot drift.
    expect(src.match(/<SkuCardBody /g) ?? []).toHaveLength(2);
    // Server-renderable: pro-gate.tsx (a server component) imports it.
    expect(src.startsWith('"use client"')).toBe(false);
  });
});
