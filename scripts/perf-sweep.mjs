/**
 * Browser-level route sweep — every sidebar route, timed and error-checked.
 *
 *   node scripts/perf-sweep.mjs [--base=http://127.0.0.1:3100] [--rounds=3]
 *                               [--budget-ms=1500] [--no-fail] [--any-db]
 *
 * Assumes a server is ALREADY running at --base (it never starts one):
 *
 *   npm run build
 *   Git Bash:    VYUHA_DB_PATH=data/perf.sqlite npx next start -p 3100
 *   PowerShell:  $env:VYUHA_DB_PATH="data/perf.sqlite"; npx next start -p 3100
 *
 * Before sweeping it fetches /trades and requires the "PERFSEED" marker trade
 * (stamped by scripts/seed-perf-db.mjs) in the response body — proof the
 * server is bound to the perf DB, not some other book. --any-db skips that
 * check for sweeping an arbitrary database.
 *
 * Visits every route in components/layout/nav-config.ts N rounds, timing
 * navigation → settled. "Settled" is the soak-accounts.mjs probe: network
 * idle plus the sidebar clock (a hydrated client component present on every
 * page), so the number includes hydration, not just document load. Console
 * errors and uncaught page errors are collected per route.
 *
 * Prints a per-route table (median / p95 / max ms, console-error count), then
 * a summary of routes breaching the budget (gated on MEDIAN — first visits
 * carry cold-cache noise the median absorbs) and routes with console errors.
 * Exit 1 on any breach or console error so it can gate; --no-fail to report only.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const BASE = arg("base", "http://127.0.0.1:3100").replace(/\/$/, "");
const ROUNDS = Number(arg("rounds", "3"));
const BUDGET = Number(arg("budget-ms", "1500"));
const NO_FAIL = process.argv.includes("--no-fail");
const ANY_DB = process.argv.includes("--any-db");

const printRunbook = () => {
  console.error(`    npm run build`);
  console.error(`    Git Bash:    VYUHA_DB_PATH=data/perf.sqlite npx next start -p 3100`);
  console.error(`    PowerShell:  $env:VYUHA_DB_PATH="data/perf.sqlite"; npx next start -p 3100`);
};

const quantile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** Every sidebar route. Import the real NAV_ITEMS via tsx; fall back to parsing hrefs. */
async function loadRoutes() {
  const navFile = path.join(ROOT, "components", "layout", "nav-config.ts");
  try {
    // tsx/cjs require hook — same mechanism as scripts/seed-perf-db.mjs (the
    // ESM register() trips node 22's require(esm) cycle guard on this repo).
    await import("tsx/cjs");
    const { createRequire } = await import("node:module");
    const mod = createRequire(import.meta.url)(navFile);
    const routes = mod.NAV_ITEMS.map((n) => ({ href: n.href, label: n.label }));
    if (routes.length > 0) return routes;
    throw new Error("NAV_ITEMS empty");
  } catch {
    const src = (await import("node:fs")).default.readFileSync(navFile, "utf8");
    const routes = [...src.matchAll(/\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((m) => ({
      href: m[1],
      label: m[2],
    }));
    if (routes.length === 0) throw new Error(`could not parse NAV_ITEMS from ${navFile}`);
    return routes;
  }
}

async function main() {
  const ping = await fetch(BASE + "/").catch(() => null);
  if (!ping) {
    console.error(`✗ no server responding at ${BASE} — start one first:`);
    printRunbook();
    process.exit(1);
  }

  // Marker check: the seeded perf DB tops date-sorted listings with a
  // "PERFSEED" trade (scripts/seed-perf-db.mjs). If /trades does not carry it,
  // the sweep would time a different book and every number would be noise.
  if (!ANY_DB) {
    const tradesBody = await fetch(BASE + "/trades").then((r) => r.text()).catch(() => "");
    if (!tradesBody.includes("PERFSEED")) {
      console.error(`✗ ${BASE}/trades has no "PERFSEED" marker — server is not running against the perf DB — measuring the wrong database.`);
      console.error(`  Seed it (node scripts/seed-perf-db.mjs), then start the server against it:`);
      printRunbook();
      console.error(`  Pass --any-db to deliberately sweep whatever database the server is bound to.`);
      process.exit(1);
    }
  }

  const routes = await loadRoutes();
  console.log(`sweeping ${routes.length} routes × ${ROUNDS} rounds at ${BASE} (budget ${BUDGET} ms/route median)\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  // Console/page errors are attributed to whichever route is being visited.
  const current = { errors: null };
  page.on("console", (msg) => {
    if (msg.type() === "error" && current.errors) current.errors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (current.errors) current.errors.push(`pageerror: ${err.message}`);
  });

  const stats = new Map(
    routes.map((r) => [r.href, { ...r, ms: [], errors: [], probeTimeouts: 0 }]),
  );

  for (let round = 0; round < ROUNDS; round++) {
    for (const route of routes) {
      const s = stats.get(route.href);
      current.errors = s.errors;
      const t0 = Date.now();
      try {
        await page.goto(BASE + route.href, { waitUntil: "load", timeout: 60_000 });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        // Hydration probe (see scripts/demo-video/soak-accounts.mjs): the
        // sidebar clock only renders client-side, on every page.
        await page
          .locator("aside")
          .getByText(/\d{2}:\d{2} IST/)
          .first()
          .waitFor({ timeout: 20_000 });
      } catch (e) {
        s.probeTimeouts++;
        s.errors.push(`settle failed (round ${round + 1}): ${String(e).split("\n")[0]}`);
      }
      s.ms.push(Date.now() - t0);
      current.errors = null;
    }
  }
  await browser.close();

  // ------------------------------------------------------------------ table
  const rows = [...stats.values()].map((s) => ({
    ...s,
    median: quantile(s.ms, 0.5),
    p95: quantile(s.ms, 0.95),
    max: Math.max(...s.ms),
  }));
  const w = Math.max(...rows.map((r) => r.href.length)) + 2;
  const num = (n) => String(n).padStart(7);
  console.log(`${"route".padEnd(w)}${num("median")}${num("p95")}${num("max")}   errors`);
  for (const r of rows) {
    const flag = r.median > BUDGET ? "  ← over budget" : "";
    console.log(`${r.href.padEnd(w)}${num(r.median)}${num(r.p95)}${num(r.max)}   ${r.errors.length || "-"}${flag}`);
  }

  // ---------------------------------------------------------------- summary
  const breaches = rows.filter((r) => r.median > BUDGET);
  const withErrors = rows.filter((r) => r.errors.length > 0);
  console.log(`\nvisits: ${rows.length * ROUNDS} · overall median ${quantile(rows.map((r) => r.median), 0.5)} ms · slowest median ${Math.max(...rows.map((r) => r.median))} ms`);
  if (breaches.length > 0) {
    console.log(`\n✗ ${breaches.length} route(s) over the ${BUDGET} ms budget:`);
    for (const r of breaches) console.log(`    ${r.href}  median ${r.median} ms (p95 ${r.p95}, max ${r.max})`);
  }
  if (withErrors.length > 0) {
    console.log(`\n✗ ${withErrors.length} route(s) with console/page errors:`);
    for (const r of withErrors) {
      console.log(`    ${r.href}  (${r.errors.length})`);
      for (const e of [...new Set(r.errors)].slice(0, 3)) console.log(`      · ${e.slice(0, 200)}`);
    }
  }
  if (breaches.length === 0 && withErrors.length === 0) {
    console.log(`✓ all ${rows.length} routes within budget, no console errors`);
  }

  const failed = breaches.length > 0 || withErrors.length > 0;
  if (failed && NO_FAIL) console.log("\n(--no-fail: reporting only, exit 0)");
  process.exit(failed && !NO_FAIL ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
