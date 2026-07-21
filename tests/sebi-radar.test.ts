import { describe, expect, it } from "vitest";
import { sebiRadar, NET_INDEX_LIMIT, type RadarPosition } from "../lib/risk/sebi-radar";

const pos = (over: Partial<RadarPosition>): RadarPosition => ({
  id: 1,
  symbol: "NIFTY",
  segment: "index_option",
  side: "long",
  optionType: "CE",
  expiry: null,
  qty: 75,
  entry: 100,
  mtm: 100,
  exchange: "NSE",
  ...over,
});

const TODAY = "2026-07-30";
const ids = (r: ReturnType<typeof sebiRadar>) => r.items.map((i) => i.id);

describe("sebiRadar — expiry-day rules", () => {
  it("flags the +2% ELM only for SHORT options expiring today", () => {
    const r = sebiRadar([pos({ side: "short", expiry: TODAY })], TODAY);
    const elm = r.items.find((i) => i.id === "expiry-elm")!;
    expect(elm.level).toBe("action");
    expect(elm.title).toMatch(/\+2% ELM/);
    expect(elm.positions).toEqual(["NIFTY"]);
  });

  it("does NOT flag ELM for long options or for a different expiry date", () => {
    expect(ids(sebiRadar([pos({ side: "long", expiry: TODAY })], TODAY))).not.toContain("expiry-elm");
    expect(ids(sebiRadar([pos({ side: "short", expiry: "2026-08-27" })], TODAY))).not.toContain("expiry-elm");
  });

  it("warns about calendar-spread benefit for anything expiring today", () => {
    const r = sebiRadar([pos({ side: "long", expiry: TODAY })], TODAY);
    expect(ids(r)).toContain("expiry-calendar-spread");
  });
});

describe("sebiRadar — weekly expiry regime", () => {
  it("flags monthly-only indexes and tolerates OPT-prefixed tradingsymbols", () => {
    const r = sebiRadar([pos({ symbol: "OPT BANKNIFTY 30 Jul 2026 52000 CE" })], TODAY);
    const w = r.items.find((i) => i.id === "weekly-discontinued")!;
    expect(w.title).toMatch(/BANKNIFTY/);
    expect(w.level).toBe("info");
  });

  it("stays quiet for NIFTY, which kept its weeklies on NSE", () => {
    expect(ids(sebiRadar([pos({ symbol: "NIFTY" })], TODAY))).not.toContain("weekly-discontinued");
  });
});

describe("sebiRadar — position limits", () => {
  it("silent well under the limit, cautions past half, escalates past the limit", () => {
    expect(ids(sebiRadar([pos({ qty: 75, mtm: 100 })], TODAY))).not.toContain("position-limit");

    const half = sebiRadar([pos({ qty: 1, mtm: NET_INDEX_LIMIT * 0.6 })], TODAY);
    expect(half.items.find((i) => i.id === "position-limit")!.level).toBe("caution");

    const over = sebiRadar([pos({ qty: 1, mtm: NET_INDEX_LIMIT * 1.2 })], TODAY);
    expect(over.items.find((i) => i.id === "position-limit")!.level).toBe("action");
  });

  it("reports the crude notional it used", () => {
    const r = sebiRadar([pos({ qty: 100, mtm: 250 })], TODAY);
    expect(r.indexNotional).toBe(25000);
  });
});

describe("sebiRadar — standing reminders & ordering", () => {
  it("shows upfront-premium and contract-size only when F&O is held", () => {
    expect(ids(sebiRadar([pos({})], TODAY))).toEqual(expect.arrayContaining(["upfront-premium", "contract-size"]));
    const equityOnly = sebiRadar([pos({ segment: "eq_delivery", optionType: null })], TODAY);
    expect(equityOnly.items).toHaveLength(0);
  });

  it("sorts action → caution → info", () => {
    const r = sebiRadar(
      [pos({ side: "short", expiry: TODAY }), pos({ id: 2, symbol: "BANKNIFTY", expiry: "2026-08-27" })],
      TODAY,
    );
    const levels = r.items.map((i) => i.level);
    expect(levels).toEqual([...levels].sort((a, b) => ({ action: 0, caution: 1, info: 2 })[a] - ({ action: 0, caution: 1, info: 2 })[b]));
    expect(levels[0]).toBe("action");
  });

  it("ignores closed/zero-qty rows entirely", () => {
    expect(sebiRadar([pos({ qty: 0, side: "short", expiry: TODAY })], TODAY).items).toHaveLength(0);
  });
});
