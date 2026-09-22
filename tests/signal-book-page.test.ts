import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PRO_FEATURES } from "@/lib/license";

/**
 * SOURCE PINS for the Signal book tab (v4.3.0).
 *
 * Three claims this release makes are true of the SOURCE, not of any value a
 * unit test can hold:
 *
 *   1. `parseSignal` is the ONLY reader of `signal_json` / `signalJson`. The
 *      envelope's whole protection — discard an alien `v`, null one bad field,
 *      never throw — is worth nothing if a second place does its own
 *      `JSON.parse` on the column. Every occurrence in the tree must sit in the
 *      named set below.
 *   2. The two pure modules import no database and no React (invariant 2), so
 *      they stay exhaustively unit-testable and browser-safe.
 *   3. /strategies is PARTIALLY gated: it must read the entitlement and must
 *      NOT carry a whole-page gate, or the free record goes behind the lock
 *      (invariant 7). `tests/pro-gating.test.ts` asserts that generically for
 *      every `partial` feature; this file pins the parts specific to the tab.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Every .ts/.tsx under the three shipped trees. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(path.relative(ROOT, full).replace(/\\/g, "/"));
    }
  };
  for (const d of ["lib", "app", "components"]) walk(path.join(ROOT, d));
  return out;
}

/** Where the column's NAME is allowed to appear at all. */
const ALLOWED = new Set([
  "lib/db/schema.ts",
  "lib/domain/slim-trade.ts",
  "lib/domain/signal.ts",
  "lib/queries/signals.ts",
  "lib/import/commit.ts",
  "lib/db/data-fixes.ts",
  "app/trades/actions.ts",
  "components/trades/signal-section.tsx",
  "components/trades/edit-trade-dialog.tsx",
]);

describe("the column has exactly one reader", () => {
  // Measured 423 ms under full-suite load, alone (2026-09-22, vitest
  // --reporter=verbose): a whole-tree source scan (lib/ app/ components/)
  // competing with every other worker; the timeout is raised, not the scan
  // loosened.
  it("no file outside the named set mentions signalJson / signal_json", () => {
    const strays = sourceFiles().filter((f) => !ALLOWED.has(f) && /signalJson|signal_json/.test(read(f)));
    expect(strays, `a second reader of the signal column: ${strays.join(", ")}`).toEqual([]);
  }, 20_000);

  it("only lib/domain/signal.ts parses the envelope — nothing else JSON.parses the column", () => {
    for (const f of ALLOWED) {
      if (f === "lib/domain/signal.ts") continue;
      const src = read(f);
      // Every other allowed file either carries the value verbatim or asks
      // lib/domain/signal.ts. None of them may open it.
      const lines = src.split(/\r?\n/).filter((l) => /signalJson|signal_json/.test(l) && /JSON\.parse/.test(l));
      expect(lines, `${f} opens the envelope itself`).toEqual([]);
    }
  });
});

describe("the two pure modules stay pure (invariant 2)", () => {
  it.each(["lib/domain/signal.ts", "lib/analytics/signal-book.ts"])("%s imports no DB and no React", (file) => {
    const src = read(file);
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec, `${file} must not reach the database`).not.toMatch(/lib\/db|better-sqlite3|drizzle|server-only|lib\/queries/);
      expect(spec, `${file} must not reach React`).not.toMatch(/^react/);
    }
  });

  it("the analytics module imports no chart library — this tab is tables only", () => {
    for (const f of ["lib/analytics/signal-book.ts", "components/strategies/signal-book.tsx"]) {
      expect(read(f)).not.toMatch(/lightweight-charts|recharts/);
    }
  });
});

describe("the tab's gating", () => {
  it("the page reads the entitlement, stays force-dynamic, and carries no whole-page gate", () => {
    const src = read("app/strategies/page.tsx");
    expect(src).toContain("getEntitlement");
    expect(src).toContain('export const dynamic = "force-dynamic"');
    // The guard at tests/pro-gating.test.ts reads the RAW source, so the
    // element's own name is deliberately not written here either.
    expect(src).not.toContain("<Pro" + "Gate>");
  });

  it("the analytics are withheld in the PAGE, before the payload — never in the client", () => {
    expect(read("app/strategies/page.tsx")).toContain("withholdSignalAnalytics(signalRows, pro)");
    // The tab wrapper and the panel take a node / already-withheld data; neither
    // may ask the entitlement itself, which would mean the figures were computed.
    for (const f of ["components/strategies/strategies-tabs.tsx", "components/strategies/signal-book.tsx"]) {
      expect(read(f), `${f} must not resolve the entitlement`).not.toContain("getEntitlement");
    }
  });

  it("the existing catalogue JSX still lives in the page, and its tab is force-mounted", () => {
    const src = read("app/strategies/page.tsx");
    // Ten test files scan THIS source for these three (render-windowing,
    // strategies-page); passing the body through a child would blind them.
    for (const token of ["LazyMount", "<PayoffChart", "StrategiesClient"]) expect(src).toContain(token);
    // Radix unmounts an inactive tab, and the shelf picker holds unsaved state.
    expect(read("components/strategies/strategies-tabs.tsx")).toContain("forceMount");
  });

  it("the licence label names the Signal book, and /strategies stays partial", () => {
    const f = PRO_FEATURES.find((x) => x.href === "/strategies")!;
    expect(f.partial).toBe(true);
    expect(f.label).toContain("Signal book");
  });

  it("lib/license.ts stays browser-safe — the label change added no import", () => {
    // AGENTS.md: client components import this module, so anything in its
    // import graph must stay bundleable — a `node:child_process` or a database
    // import here fails only at `next build`. `node:crypto` is long-standing and
    // bundles; the point of this pin is that extending the /strategies LABEL
    // pulled in nothing new.
    const imports = [...read("lib/license.ts").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) expect(spec).not.toMatch(/child_process|better-sqlite3|lib\/db|lib\/queries|server-only/);
  });
});
