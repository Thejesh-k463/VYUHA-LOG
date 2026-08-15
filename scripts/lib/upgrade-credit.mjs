// The upgrade arithmetic, reachable from a plain-node script.
//
// lib/domain/pricing.ts is the single source of truth for prices and it is
// TypeScript; no vendor script runs through tsx. So this module (a) reads the
// lifetime launch price OUT of pricing.ts with a deliberately narrow regex,
// failing loudly if the shape moves, and (b) mirrors `upgradeCredit()` from
// pricing.ts. tests/license-upgrade.test.ts pins both halves against the TS
// module, so a price change or a formula change in one place breaks the test
// rather than silently disagreeing on a quote.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function defaultPricingPath() {
  return path.join(root, "lib", "domain", "pricing.ts");
}

/**
 * The `amountInr` of the PRICING entry whose id is "lifetime". Matches only
 * `id: "lifetime"` followed (before the next `id:`) by `amountInr: <int>`.
 */
export function readLifetimeLaunchPrice(pricingPath = defaultPricingPath()) {
  const src = readFileSync(pricingPath, "utf8");
  const m = src.match(/id:\s*"lifetime"[^]*?amountInr:\s*(\d+)/);
  if (!m) throw new Error(`Could not find the lifetime amountInr in ${pricingPath} — has PRICING changed shape?`);
  const between = m[0];
  if (/id:\s*"(?!lifetime)/.test(between.slice(4))) {
    throw new Error(`Lifetime amountInr regex crossed into another SKU in ${pricingPath}`);
  }
  return Number(m[1]);
}

/** Mirror of lib/domain/pricing.ts#upgradeCredit — keep the two identical. */
export function upgradeDue(lifetimePrice, paidForYear) {
  if (!Number.isFinite(lifetimePrice) || lifetimePrice <= 0) throw new Error("lifetime price must be > 0");
  if (!Number.isFinite(paidForYear) || paidForYear < 0) throw new Error("paid amount must be >= 0");
  const credit = Math.min(paidForYear, lifetimePrice);
  return { credit, due: lifetimePrice - credit };
}
