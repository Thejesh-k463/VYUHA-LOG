import { describe, expect, it } from "vitest";
import { resolveMtfMargin, mtfBundleIsStale, MTF_BUNDLE_AS_OF } from "@/lib/risk/mtf-margins";
import { mtfDrift } from "@/lib/risk/mtf-drift";
import { capitalBlocked, marginKey, DEFAULT_MTF_OWN_MARGIN_PCT, type MarginRates } from "@/lib/risk/margin";
import bundle from "@/lib/data/mtf-margins.json";

// ─── bundle contract ────────────────────────────────────────────────────────

describe("bundled mtf-margins.json", () => {
  const b = bundle as { asOf: string; brokers: Record<string, { coverage: string; count: number; stocks: Record<string, { m: number }> }> };

  it("carries an as-of date and every app broker", () => {
    expect(b.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const broker of ["dhan", "zerodha", "groww", "angelone", "upstox", "kotakneo", "paytm", "sahi"]) {
      expect(b.brokers[broker], broker).toBeDefined();
    }
  });

  it("all seven MTF brokers are complete four-digit lists; margins are sane own-%", () => {
    for (const broker of ["dhan", "zerodha", "upstox", "kotakneo", "paytm", "angelone", "groww"]) {
      expect(b.brokers[broker].coverage, broker).toBe("complete");
      expect(b.brokers[broker].count, broker).toBeGreaterThan(1000);
    }
    for (const [broker, v] of Object.entries(b.brokers)) {
      for (const [sym, s] of Object.entries(v.stocks)) {
        expect(s.m, `${broker}:${sym}`).toBeGreaterThan(0);
        expect(s.m, `${broker}:${sym}`).toBeLessThanOrEqual(100);
      }
    }
  });

  it("approved-but-unfunded rows ship at 100% own margin, never a fake funding number", () => {
    const kotak = b.brokers.kotakneo as unknown as { count: number; fundedCount: number; stocks: Record<string, { m: number; f: 0 | 1 }> };
    expect(kotak.fundedCount).toBeLessThan(kotak.count); // Kotak approves more than it funds
    for (const [sym, s] of Object.entries(kotak.stocks)) {
      if (s.f === 0) expect(s.m, `kotakneo:${sym} unfunded`).toBe(100);
    }
  });

  it("declares honesty about what it doesn't have", () => {
    expect(b.brokers.sahi.coverage).toBe("no-mtf");
    expect(b.brokers.sahi.count).toBe(0);
  });
});

// ─── resolution chain ───────────────────────────────────────────────────────

describe("resolveMtfMargin", () => {
  it("bundled stock list resolves a real Zerodha scrip", () => {
    const r = resolveMtfMargin("zerodha", "ABB");
    expect(r.source).toBe("stock-list");
    expect(r.pct).toBeGreaterThan(0);
    expect(r.asOf).toBe(MTF_BUNDLE_AS_OF);
  });

  it("an uploaded override beats the bundled list", () => {
    const overrides = new Map([["ABB", { pct: 42, asOf: "2026-08-01" }]]);
    const r = resolveMtfMargin("zerodha", "ABB", overrides);
    expect(r).toMatchObject({ pct: 42, source: "upload", asOf: "2026-08-01" });
  });

  it("every broker's list now answers per-stock — Angel and Dhan included", () => {
    // These two were rule-only until the owner's workbook supplied real lists.
    for (const broker of ["angelone", "dhan", "upstox", "groww", "kotakneo"]) {
      const r = resolveMtfMargin(broker, "RELIANCE");
      expect(r.source, broker).toBe("stock-list");
      expect(r.pct, broker).toBeGreaterThan(0);
    }
  });

  it("unknown stock on a complete list → margin-config, then the 25% default", () => {
    const cfg = resolveMtfMargin("zerodha", "NOTALISTEDSTOCK", null, 30);
    expect(cfg).toMatchObject({ pct: 30, source: "margin-config" });
    const dflt = resolveMtfMargin("upstox", "NOTALISTEDSTOCK", null, null);
    expect(dflt).toMatchObject({ pct: DEFAULT_MTF_OWN_MARGIN_PCT, source: "default" });
    // A no-MTF broker has no list and no rule — the chain still answers.
    const sahi = resolveMtfMargin("sahi", "RELIANCE", null, null);
    expect(sahi).toMatchObject({ pct: DEFAULT_MTF_OWN_MARGIN_PCT, source: "default" });
  });
});

// ─── staleness ──────────────────────────────────────────────────────────────

describe("mtfBundleIsStale", () => {
  it("fresh within 60 days, stale after", () => {
    expect(mtfBundleIsStale("2026-08-10", "2026-08-07")).toBe(false);
    expect(mtfBundleIsStale("2026-11-01", "2026-08-07")).toBe(true);
  });
});

// ─── engine precedence ──────────────────────────────────────────────────────

describe("capitalBlocked with per-stock MTF margin", () => {
  const rates: MarginRates = new Map([[marginKey("zerodha", "eq_mtf"), 20]]);
  const base = {
    id: 1, symbol: "ABB", bucket: "equity", broker: "zerodha", segment: "eq_mtf",
    side: "long" as const, qty: 100, entry: 500, mtm: 550, strike: null, optionType: null,
  };

  it("per-stock % beats the broker-level rate", () => {
    const r = capitalBlocked({ ...base, mtfStockPct: 45 }, rates);
    expect(r.margin).toBe(0.45 * 100 * 500);
    expect(r.basis).toContain("(stock list)");
    expect(r.missingRate).toBeNull();
  });

  it("without a per-stock %, the broker rate holds", () => {
    const r = capitalBlocked(base, rates);
    expect(r.margin).toBe(0.2 * 100 * 500);
  });
});

// ─── drift ──────────────────────────────────────────────────────────────────

describe("mtfDrift", () => {
  const resolve = (broker: string, symbol: string) =>
    ({ pct: symbol === "RISER" ? 40 : 25, source: "stock-list" as const, asOf: "2026-08-07", coverage: "complete", note: null });

  it("flags a requirement that rose, with the honest top-up figure", () => {
    const rows = mtfDrift(
      [
        { id: 1, symbol: "RISER", broker: "zerodha", buyValue: 100000, mtfFundedAmount: 75000 }, // entered at 25% own
        { id: 2, symbol: "STEADY", broker: "zerodha", buyValue: 100000, mtfFundedAmount: 75000 }, // still 25
      ],
      resolve,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, storedOwnPct: 25, currentPct: 40, deltaPct: 15, topUpAtCurrent: 15000 });
  });

  it("never reports malformed rows (fully-funded impossibilities) or sub-threshold noise", () => {
    const rows = mtfDrift(
      [
        { id: 3, symbol: "STEADY", broker: "zerodha", buyValue: 100000, mtfFundedAmount: 100000 }, // own = 0 — malformed
        { id: 4, symbol: "STEADY", broker: "zerodha", buyValue: 100000, mtfFundedAmount: 74500 }, // 25.5% vs 25 — noise
      ],
      resolve,
    );
    expect(rows).toHaveLength(0);
  });
});
