import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";

/**
 * v3.5.0 — Arjun's Eye becomes the Trade Craft cockpit. Source guards in the
 * style of render-windowing.test.ts: each one pins a wiring decision that
 * nothing else would fail on if a refactor undid it. What proves the maths is
 * tests/{sl-analysis,win-loss,exit-behaviour,stop-migration,cockpit-rules}.
 */

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const PAGE = "app/arjuns-eye/page.tsx";
const TAB_FILES = [
  "components/trade-craft/stop-loss-tab.tsx",
  "components/trade-craft/trailing-tab.tsx",
  "components/trade-craft/win-loss-tab.tsx",
  "components/trade-craft/exits-tab.tsx",
  "components/trade-craft/win-loss-charts.tsx",
];

describe("the Trade Craft page keeps its structural wiring", () => {
  const src = read(PAGE);

  it("stays Pro-gated and force-dynamic", () => {
    expect(src).toContain("<ProGate>");
    expect(src).toContain('export const dynamic = "force-dynamic"');
  });

  it("reads through the ARJUN_FIELDS projection, not the whole-row getTrades()", () => {
    expect(src).toContain("getArjunTrades");
    expect(src, "page is back on the 74-column full-row read").not.toMatch(/\bgetTrades\(\)/);
  });

  it("renders all five tabs through the shell", () => {
    expect(src).toContain("TabShell");
    for (const label of ["Cockpit", "Stop-losses", "Trailing stops", "Winners vs losers", "Exits"]) {
      expect(src, `tab "${label}" went missing`).toContain(`label: "${label}"`);
    }
  });

  it("runs the cockpit registry WITH trade rows, rendered through InsightList", () => {
    // cockpitReport's internal findings() passes trades: [] and the two
    // trade-level rules refuse; this surface must run the registry itself.
    expect(src).toContain("runRules(COCKPIT_RULES");
    expect(src).toContain("trades: measurable");
    expect(src).toContain("<InsightList");
    expect(src, "the local FindingCard is back").not.toContain("FindingCard");
  });

  it("scopes the unscoped audit read by intersecting with the page's own trade ids", () => {
    expect(src).toContain("getTradeStopEditEntries");
    expect(src).toContain("directionByTrade");
  });

  it("never guesses a direction for a flat row — fully-closed trades stay OUT of the direction map", () => {
    // sellQty === buyQty says the trade is fully closed, not that it was long;
    // guessing "long" inverted widen/tighten for every flat short (F3).
    expect(src).toContain("if (t.sellQty !== t.buyQty) directionByTrade.set");
    expect(src, "the flat-row long guess is back").not.toContain(
      "trades.map((t) => [t.id, t.sellQty > t.buyQty",
    );
    // The dropped edits are surfaced, not silently vanished.
    expect(src).toContain("excludedNoDirection={mined.noDirection}");
  });
});

describe("the tab shell derives, persists, and never syncs state", () => {
  const src = read("components/trade-craft/tab-shell.tsx");

  it("persists the active tab through the shared storage hook", () => {
    expect(src).toContain('"vyuha-arjun-tab"');
    expect(src).toContain("useStoredValue");
    expect(src).toContain("writeStored");
  });

  it("holds no React state at all — the stored value IS the state", () => {
    // The repo rule is "never silence set-state-in-effect — derive instead";
    // this shell goes further and has nothing to sync in the first place.
    expect(src).not.toContain("useState");
    expect(src).not.toContain("useEffect");
  });
});

describe("the honesty framing survives refactors", () => {
  it("the stop-loss tab leads with coverage — 'SL recorded on N of M losers' is the first line", () => {
    const src = read("components/trade-craft/stop-loss-tab.tsx");
    const coverage = src.indexOf("SL recorded on");
    const classification = src.indexOf("against the stop");
    expect(coverage).toBeGreaterThan(0);
    expect(classification).toBeGreaterThan(0);
    expect(coverage, "coverage line no longer renders before the classification").toBeLessThan(classification);
  });

  it("the R histogram series stay labelled by PROVENANCE, with the cap explainer", () => {
    const charts = read("components/trade-craft/win-loss-charts.tsx");
    expect(charts).toContain('"plan-derived R"');
    expect(charts).toContain('"default-cap R"');
    const tab = read("components/trade-craft/win-loss-tab.tsx");
    // The default-cap series must be explained as P&L over the per-trade cap,
    // never presented as plan adherence.
    expect(tab).toContain("₹9,500");
    expect(tab).toMatch(/not[\s\S]{0,60}plan\s+adherence/i);
    // The deep-loss gap renders next to its plan-R coverage (invariant 6).
    expect(tab).toContain("planLossCoverage.recorded");
    expect(tab).toContain("planLossCoverage.total");
  });

  it("every exits card states its exclusion counts", () => {
    const src = read("components/trade-craft/exits-tab.tsx");
    for (const field of ["withoutTime", "offHours", "unmeasurable", "unanswered"]) {
      expect(src, `exits tab stopped rendering ${field}`).toContain(field);
    }
  });

  it("no tab copy uses prescriptive language — the insight contract's bar, applied to the prose", () => {
    for (const f of TAB_FILES) {
      expect(read(f), `${f} contains prescriptive language`).not.toMatch(PRESCRIPTIVE_LANGUAGE);
    }
  });

  it("charts stay recharts with theme tokens — no canvas chart on a surface that can reach paper", () => {
    const src = read("components/trade-craft/win-loss-charts.tsx");
    expect(src).toContain('from "recharts"');
    expect(src, "lightweight-charts rasterises draw-time colours and prints dark on paper").not.toContain("lightweight-charts");
  });
});

describe("the ARJUN_FIELDS projection", () => {
  const src = read("lib/queries/trades.ts");

  it("exists, and getArjunTrades selects through it", () => {
    expect(src).toContain("ARJUN_FIELDS");
    const body = src.slice(src.indexOf("export const getArjunTrades"), src.indexOf("export const getArjunTrades") + 300);
    expect(body).toContain("scopedBookRows(ARJUN_FIELDS)");
  });

  it("carries every column the five tabs read", () => {
    const block = src.slice(src.indexOf("const ARJUN_FIELDS"), src.indexOf("export type ArjunTrade"));
    for (const col of [
      "slPlanned", "trailingSl", "targetPlanned", "riskAmount",
      "setupTag", "playbookId", "buyOrderCount", "sellOrderCount", "exitTrigger",
      "entryTime", "exitTime", "avgBuyPrice", "avgSellPrice",
    ]) {
      expect(block, `ARJUN_FIELDS lost "${col}"`).toContain(`"${col}"`);
    }
  });

  it("adds no WHERE of its own — scopedBookRows is the whole story", () => {
    // The tie-order trap (DECISIONS.md 2026-08-29): a projection may add
    // COLUMNS but never a WHERE/ORDER change. scopedBookRows guarantees both;
    // the guard is that getArjunTrades does not bypass it.
    const body = src.slice(src.indexOf("export const getArjunTrades"), src.indexOf("export const getArjunTrades") + 300);
    expect(body).not.toContain("db.select");
    expect(body).not.toContain(".where(");
  });
});
