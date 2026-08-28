/**
 * Account-switching soak — the objective version of "it felt laggy".
 *
 *   npm run demo            (server up)
 *   node scripts/demo-video/soak-accounts.mjs [--rounds=30]
 *
 * Cycles the sidebar account selector through every account N times on a real
 * hydrated page, timing each switch from selectOption() to the dashboard
 * settling (network idle + hydration probe). Prints min / median / p95 / max
 * and flags drift: if switches get SLOWER as the run progresses (first-third
 * vs last-third medians), something is accumulating — which is exactly the
 * shape of the owner's "lag from the 3rd–4th navigation onwards" report
 * (VYUHA-STATE, 2026-08-27). A flat profile at any absolute speed is a
 * different (and smaller) problem than a rising one.
 */
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3214";
const ROUNDS = Number((process.argv.find((a) => a.startsWith("--rounds=")) ?? "").split("=")[1] || 30);

const q = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

async function main() {
  const ping = await fetch(BASE + "/").catch(() => null);
  if (!ping) { console.error(`✗ demo server not running on ${BASE}`); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 90_000 });
  await page.locator("aside").getByText(/\d{2}:\d{2} IST/).first().waitFor({ timeout: 30_000 });

  const sel = page.locator("aside select").first();
  const options = await sel.locator("option").allTextContents();
  console.log(`accounts in the switcher: ${options.join(" | ")}`);
  console.log(`rounds: ${ROUNDS} (each round switches through every account)\n`);

  const timings = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const label of options) {
      const t0 = Date.now();
      await sel.selectOption({ label });
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await page.locator("aside").getByText(/\d{2}:\d{2} IST/).first().waitFor({ timeout: 20_000 });
      timings.push({ round, label, ms: Date.now() - t0 });
    }
  }
  await browser.close();

  const ms = timings.map((t) => t.ms);
  const third = Math.floor(timings.length / 3);
  const firstThird = timings.slice(0, third).map((t) => t.ms);
  const lastThird = timings.slice(-third).map((t) => t.ms);
  const med = (a) => q(a, 0.5);

  console.log(`switches: ${ms.length}`);
  console.log(`min ${Math.min(...ms)} ms · median ${med(ms)} ms · p95 ${q(ms, 0.95)} ms · max ${Math.max(...ms)} ms`);
  console.log(`first-third median ${med(firstThird)} ms · last-third median ${med(lastThird)} ms`);
  const drift = med(lastThird) / Math.max(1, med(firstThird));
  console.log(`drift ratio (later ÷ earlier): ${drift.toFixed(2)}${drift > 1.3 ? "  ← RISING: something accumulates" : "  (flat — no accumulation)"}`);
  const worst = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log("slowest 5:", worst.map((w) => `${w.label}@r${w.round}=${w.ms}ms`).join("  "));
}

main().catch((e) => { console.error(e); process.exit(1); });
