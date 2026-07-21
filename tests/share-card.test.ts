import { describe, expect, it } from "vitest";
import {
  buildShareCard,
  SHARE_METRICS,
  SHARE_WATERMARK,
  type ShareStats,
} from "../lib/analytics/share-card";

const stats: ShareStats = {
  netPnl: 125000,
  winRatePct: 58.3,
  profitFactor: 1.72,
  avgR: 0.42,
  trades: 96,
  expectancy: 1302,
  maxDrawdown: 48000,
  charges: 21000,
  bestTrade: 31000,
  worstTrade: -18000,
};

const find = (rows: ReturnType<typeof buildShareCard>, id: string) => rows.find((r) => r.id === id)!;

describe("buildShareCard — amounts mode", () => {
  it("formats ₹ with Indian units and signs the tone", () => {
    const rows = buildShareCard(stats, { metrics: ["netPnl", "bestTrade", "worstTrade"], privacy: "amounts" });
    expect(find(rows, "netPnl").display).toBe("₹1.25L");
    expect(find(rows, "netPnl").tone).toBe("profit");
    expect(find(rows, "worstTrade").display).toBe("−₹18.0K");
    expect(find(rows, "worstTrade").tone).toBe("loss");
  });

  it("always renders drawdown and charges as costs (negative)", () => {
    const rows = buildShareCard(stats, { metrics: ["maxDrawdown", "charges"], privacy: "amounts" });
    expect(find(rows, "maxDrawdown").display.startsWith("−")).toBe(true);
    expect(find(rows, "charges").tone).toBe("loss");
  });
});

describe("buildShareCard — ratio & count metrics are privacy-neutral", () => {
  it("renders identically regardless of privacy mode", () => {
    const metrics = ["winRate", "profitFactor", "avgR", "trades"] as const;
    const a = buildShareCard(stats, { metrics: [...metrics], privacy: "amounts" });
    const b = buildShareCard(stats, { metrics: [...metrics], privacy: "r" });
    expect(a.map((r) => r.display)).toEqual(b.map((r) => r.display));
    expect(find(a, "winRate").display).toBe("58.3%");
    expect(find(a, "avgR").display).toBe("0.42R");
    expect(find(a, "trades").display).toBe("96");
  });

  it("profit factor tones off 1.0 and handles ∞", () => {
    expect(find(buildShareCard(stats, { metrics: ["profitFactor"], privacy: "amounts" }), "profitFactor").tone).toBe("profit");
    const losing = buildShareCard({ ...stats, profitFactor: 0.6 }, { metrics: ["profitFactor"], privacy: "amounts" });
    expect(find(losing, "profitFactor").tone).toBe("loss");
    const perfect = buildShareCard({ ...stats, profitFactor: Infinity }, { metrics: ["profitFactor"], privacy: "amounts" });
    expect(find(perfect, "profitFactor").display).toBe("∞");
  });

  it("handles a null avgR without crashing", () => {
    const rows = buildShareCard({ ...stats, avgR: null }, { metrics: ["avgR"], privacy: "amounts" });
    expect(find(rows, "avgR").display).toBe("—");
  });
});

describe("buildShareCard — privacy modes", () => {
  it("percent mode converts ₹ against capital and labels it", () => {
    const rows = buildShareCard(stats, { metrics: ["netPnl"], privacy: "percent", capital: 1000000 });
    expect(find(rows, "netPnl").display).toBe("12.50%");
    expect(find(rows, "netPnl").label).toMatch(/% of capital/);
  });

  it("percent mode refuses to invent a denominator when capital is missing", () => {
    const rows = buildShareCard(stats, { metrics: ["netPnl"], privacy: "percent" });
    expect(find(rows, "netPnl").display).toBe("—");
  });

  it("r mode hides ₹ metrics rather than fabricating an R denominator", () => {
    const rows = buildShareCard(stats, { metrics: ["netPnl", "avgR"], privacy: "r" });
    expect(find(rows, "netPnl").display).toBe("hidden");
    expect(find(rows, "avgR").display).toBe("0.42R"); // already in R — still shown
  });
});

describe("share card integrity", () => {
  it("ignores unknown metric ids", () => {
    expect(buildShareCard(stats, { metrics: ["nope" as never], privacy: "amounts" })).toHaveLength(0);
  });

  it("watermark states self-reported and never claims broker verification", () => {
    expect(SHARE_WATERMARK).toMatch(/self-reported/i);
    expect(SHARE_WATERMARK).toMatch(/not broker-verified/i);
  });

  it("every declared metric is renderable", () => {
    const rows = buildShareCard(stats, { metrics: SHARE_METRICS.map((m) => m.id), privacy: "amounts" });
    expect(rows).toHaveLength(SHARE_METRICS.length);
    expect(rows.every((r) => r.display.length > 0)).toBe(true);
  });
});
