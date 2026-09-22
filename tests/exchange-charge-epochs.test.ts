import { describe, expect, it } from "vitest";
import { buildChargeConfigSeed } from "@/lib/db/seed-data";
import { findRates, seedRatesMap } from "@/lib/engine/rates";

/**
 * C-8 (v4.3.0; owner ruling "fix all confirmed in 4.3.0, rates only"): the
 * exchange transaction charge and NSE IPFT, EFFECTIVE-DATED.
 *
 * Every figure below is typed by hand from the circulars cited in
 * lib/db/seed-data.ts, NOT read back from the seed, so the seed cannot agree
 * with itself. Fractions of traded value (of premium for options), each side.
 *
 * The per-crore TOTAL (txn + IPFT) is pinned beside each rate because IPFT is a
 * separate line in NSE's circulars: from 1 Mar 2026 the charge is Rs 306.99 and
 * IPFT Rs 0.01 (cash 307/crore). FA73061 folded the IPFT increase back into the
 * charge, so each NSE total is UNCHANGED across 1 Mar 2026 (307 / 183 / 3,553).
 * Carrying the 1 Apr 2023 → 1 Mar 2026 IPFT (Rs 10 cash/futures, Rs 50 options)
 * into the new window, or dropping it from the old one, moves a total and turns
 * this red.
 */

type SeedRow = ReturnType<typeof buildChargeConfigSeed>[number];
type Class = {
  name: string;
  match: (r: SeedRow) => boolean;
  keys: number;
  /** Epoch starts of every key in the class: the union of its STT and exchange boundaries. */
  froms: string[];
  txn: number[];
  ipft: number[];
  /** Rs per crore, txn + IPFT, per epoch. */
  perCrore: number[];
};

const EQ = ["eq_delivery", "eq_mtf", "eq_intraday"];
/**
 * Equity delivery and MTF keys are also split at the delivery STT boundary
 * (QS-EQ2012; FATAX20990: 0.125% → 0.1% both sides from 2012-07-01); the
 * exchange charge does not move there, and intraday STT did not move.
 */
const DELIVERY = ["eq_delivery", "eq_mtf"];
/**
 * NSE F&O keys are also split at R1's STT boundaries (the exchange charge does
 * not move there): futures on 2013-06-01 (FATAX23500), options on 2016-06-01
 * (FATAX32385). BSE options gain 2016-06-01 and 2023-04-01 (FATAX56235) the same way.
 */
const NSE_FUT = ["1970-01-01", "2013-06-01", "2023-04-01", "2024-04-01", "2024-10-01", "2026-03-01", "2026-04-01"];
const NSE_OPT = ["1970-01-01", "2016-06-01", "2023-04-01", "2024-04-01", "2024-10-01", "2026-03-01", "2026-04-01"];

const CLASSES: Class[] = [
  {
    name: "NSE cash, delivery and MTF",
    match: (r) => r.exchange === "NSE" && DELIVERY.includes(r.segment),
    keys: 20,
    froms: ["1970-01-01", "2012-07-01", "2023-04-01", "2024-04-01", "2024-10-01", "2026-03-01"],
    txn: [0.0000345, 0.0000345, 0.0000325, 0.0000322, 0.0000297, 0.000030699],
    ipft: [0.000000001, 0.000000001, 0.000001, 0.000001, 0.000001, 0.000000001],
    perCrore: [345.01, 345.01, 335, 332, 307, 307],
  },
  {
    name: "NSE cash, intraday",
    match: (r) => r.exchange === "NSE" && EQ.includes(r.segment) && !DELIVERY.includes(r.segment),
    keys: 10,
    froms: ["1970-01-01", "2023-04-01", "2024-04-01", "2024-10-01", "2026-03-01"],
    txn: [0.0000345, 0.0000325, 0.0000322, 0.0000297, 0.000030699],
    ipft: [0.000000001, 0.000001, 0.000001, 0.000001, 0.000000001],
    perCrore: [345.01, 335, 332, 307, 307],
  },
  {
    name: "NSE futures",
    match: (r) => r.exchange === "NSE" && r.segment === "future",
    keys: 10,
    froms: NSE_FUT,
    txn: [0.00002, 0.00002, 0.000019, 0.0000188, 0.0000173, 0.000018299, 0.000018299],
    ipft: [0.000000001, 0.000000001, 0.000001, 0.000001, 0.000001, 0.000000001, 0.000000001],
    perCrore: [200.01, 200.01, 200, 198, 183, 183, 183],
  },
  {
    name: "NSE options (index and stock, of premium)",
    match: (r) => r.exchange === "NSE" && (r.segment === "index_option" || r.segment === "stock_option"),
    keys: 20,
    froms: NSE_OPT,
    txn: [0.00053, 0.00053, 0.0005, 0.000495, 0.0003503, 0.000355299, 0.000355299],
    ipft: [0.000000001, 0.000000001, 0.000005, 0.000005, 0.000005, 0.000000001, 0.000000001],
    perCrore: [5300.01, 5300.01, 5050, 5000, 3553, 3553, 3553],
  },
  {
    name: "BSE cash (Group A / B / non-exclusive), delivery and MTF",
    match: (r) => r.exchange === "BSE" && DELIVERY.includes(r.segment),
    keys: 20,
    froms: ["1970-01-01", "2012-07-01", "2022-12-01"],
    txn: [0.0000345, 0.0000345, 0.0000375],
    ipft: [0, 0, 0],
    perCrore: [345, 345, 375],
  },
  {
    name: "BSE cash (Group A / B / non-exclusive), intraday",
    match: (r) => r.exchange === "BSE" && EQ.includes(r.segment) && !DELIVERY.includes(r.segment),
    keys: 10,
    froms: ["1970-01-01", "2022-12-01"],
    txn: [0.0000345, 0.0000375],
    ipft: [0, 0],
    perCrore: [345, 375],
  },
  {
    name: "BSE stock options (of premium)",
    match: (r) => r.exchange === "BSE" && r.segment === "stock_option",
    keys: 10,
    froms: ["1970-01-01", "2016-06-01", "2022-05-02", "2023-04-01", "2024-10-01", "2026-04-01"],
    txn: [0, 0, 0.00005, 0.00005, 0.00005, 0.00005],
    ipft: [0, 0, 0, 0, 0, 0],
    perCrore: [0, 0, 500, 500, 500, 500],
  },
  {
    name: "BSE index options (Sensex/Bankex, of premium)",
    match: (r) => r.exchange === "BSE" && r.segment === "index_option",
    keys: 10,
    froms: ["1970-01-01", "2016-06-01", "2022-05-02", "2023-04-01", "2023-11-01", "2024-05-13", "2024-10-01", "2026-04-01"],
    txn: [0, 0, 0.00005, 0.00005, 0.000375, 0.000495, 0.000325, 0.000325],
    ipft: [0, 0, 0, 0, 0, 0, 0, 0],
    perCrore: [0, 0, 500, 500, 3750, 4950, 3250, 3250],
  },
  /**
   * v4.5.0 wave 3a (ruling R90): the ETF STT RATE ROWS. They are not segments a
   * trade carries — `ratesForTrade` reads sttPct/sttSide off them and nothing
   * else — so every exchange/IPFT figure below is 0 BY CONSTRUCTION, and that is
   * the point of pinning them here: a future edit that starts putting a real
   * exchange charge on an etf_* row would silently double-charge, because the
   * trade's own product row already carries it.
   *
   * `etf_equity` is delivery-like: it inherits the equity-delivery schedule
   * (1970 and 2012-07-01) and gains 2013-06-01, the Finance Act 2013 insertion
   * of Sl. 2A in s.98. `etf_other` appears in NO row of the s.98 table, so it is
   * one flat 1970 row at 0.
   *
   * 10 broker-plans × 2 exchanges = 20 keys each.
   */
  {
    name: "ETF STT rate rows, equity-oriented (delivery-like, + the 2013 s.98 row 2A)",
    match: (r) => String(r.segment) === "etf_equity",
    keys: 20,
    froms: ["1970-01-01", "2012-07-01", "2013-06-01"],
    txn: [0, 0, 0],
    ipft: [0, 0, 0],
    perCrore: [0, 0, 0],
  },
  {
    name: "ETF STT rate rows, non-equity-oriented (one flat row, no STT at all)",
    match: (r) => String(r.segment) === "etf_other",
    keys: 20,
    froms: ["1970-01-01"],
    txn: [0],
    ipft: [0],
    perCrore: [0],
  },
  {
    name: "MCX commodity futures (unchanged, no history)",
    match: (r) => r.exchange === "MCX" && r.segment === "commodity_future",
    keys: 10,
    froms: ["1970-01-01"],
    txn: [0.000021],
    ipft: [0],
    perCrore: [210],
  },
  {
    name: "MCX commodity options (unchanged, no history)",
    match: (r) => r.exchange === "MCX" && r.segment === "commodity_option",
    keys: 10,
    froms: ["1970-01-01"],
    txn: [0.000418],
    ipft: [0],
    perCrore: [4180],
  },
];

/** Statutory sell-side STT on `on` — typed from the NSE FATAX circulars (R1), not read from the seed. */
function sttOn(segment: string, on: string): number {
  // FATAX20990 rows 1 & 2: "0.125 per cent" till 30.06.2012 (start unverified), "0.1 per cent" from 01.07.2012
  if (segment === "eq_delivery" || segment === "eq_mtf") return on < "2012-07-01" ? 0.00125 : 0.001;
  if (segment === "eq_intraday") return 0.00025;
  // Wave 3a. The ETF rate rows, typed from the statute, not read from the seed:
  // an equity-oriented unit was charged the equity-share delivery schedule until
  // Finance Act 2013 inserted s.98 Sl. 2A (0.001%, seller, delivery-based) on
  // 2013-06-01; a non-equity-oriented unit is in no row of the table at all.
  if (segment === "etf_equity") return on < "2012-07-01" ? 0.00125 : on < "2013-06-01" ? 0.001 : 0.00001;
  if (segment === "etf_other") return 0;
  if (segment === "future") {
    // FATAX23500 (0.017% till 31.05.2013; start unverified), 23500, 56235, 63809, 73524
    if (on < "2013-06-01") return 0.00017;
    if (on < "2023-04-01") return 0.0001;
    if (on < "2024-10-01") return 0.000125;
    return on < "2026-04-01" ? 0.0002 : 0.0005;
  }
  if (segment === "index_option" || segment === "stock_option") {
    // FATAX27711 (0.017%; start unverified), 32385, 56235, 63809, 73524
    if (on < "2016-06-01") return 0.00017;
    if (on < "2023-04-01") return 0.0005;
    if (on < "2024-10-01") return 0.000625;
    return on < "2026-04-01" ? 0.001 : 0.0015;
  }
  if (segment === "commodity_future") return 0.0001;
  return 0.0005; // commodity_option
}

const seed = buildChargeConfigSeed();
const byKey = new Map<string, SeedRow[]>();
for (const r of seed) {
  const k = `${r.broker}/${r.plan}/${r.segment}/${r.exchange}`;
  byKey.set(k, [...(byKey.get(k) ?? []), r]);
}
const from = (r: SeedRow) => r.effectiveFrom ?? "1970-01-01";
const oldestFirst = (rows: SeedRow[]) => [...rows].sort((a, b) => from(a).localeCompare(from(b)));
const keysOf = (c: Class) => [...byKey.entries()].filter(([, rows]) => c.match(rows[0]));
const perCrore = (r: SeedRow) => Math.round((r.exchangeTxnPct + r.ipftPct) * 1e7 * 100) / 100;
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

describe("the seed's exchange-charge epochs", () => {
  it("the classes partition all 170 keys and 700 rows", () => {
    expect(CLASSES.reduce((a, c) => a + keysOf(c).length, 0)).toBe(byKey.size);
    // Re-pinned 2026-09-22 (v4.5.0 wave U): 117 → 130 keys, 558 → 620 rows. Upstox Plus is the
    // second PAID PLAN in the seed (Kotak Neo's was the first), and `emit` gives a plan the same
    // 13 (segment, exchange) combos and the same epoch split as its broker's default rows — so
    // +13 keys, one per combo, and +62 rows, exactly the row count `upstox|default` already had.
    // Every new key lands in an existing class (the first assertion above), and each class's own
    // `keys` count gained precisely the Upstox combos it covers: NSE cash delivery+MTF and NSE
    // options and BSE cash delivery+MTF +2 each, the other seven +1. Measured, not copied.
    // Re-pinned 2026-09-22 (v4.5.0 wave 3a, ruling R90): 130 → 170 keys, 620 → 700 rows. The seed
    // gained the two ETF STT RATE ROWS under every broker-plan and both exchanges:
    //   10 broker-plans (8 brokers + kotakneo|pro + upstox|plus) × 2 exchanges × 2 rate segments
    //   = 40 keys; × (etf_equity 3 epochs + etf_other 1 epoch) = 80 rows.
    // The CLASSES table gains both as classes rather than excluding them (they must be partitioned
    // like everything else, or a wrong exchange charge on an etf_* row would go unpinned).
    expect(byKey.size).toBe(170);
    expect(seed).toHaveLength(700);
  });

  it.each(CLASSES)("$name: windows, transaction charge, IPFT and the per-crore total on every key", (c) => {
    const keys = keysOf(c);
    expect(keys).toHaveLength(c.keys);
    const windows = c.froms.map((f, i) => [f, c.froms[i + 1] ?? null]);
    for (const [k, rows] of keys) {
      const asc = oldestFirst(rows);
      expect(asc.map((r) => [from(r), r.effectiveTo ?? null]), k).toEqual(windows);
      expect(asc.map((r) => r.exchangeTxnPct), k).toEqual(c.txn);
      expect(asc.map((r) => r.ipftPct), k).toEqual(c.ipft);
      expect(asc.map(perCrore), k).toEqual(c.perCrore);
    }
  });

  it("across a key's epochs only STT, the exchange charge and IPFT change, and exactly one epoch is open", () => {
    const rest = (r: SeedRow) => {
      const o: Record<string, unknown> = { ...r };
      for (const c of ["sttPct", "sttSide", "exchangeTxnPct", "ipftPct", "effectiveFrom", "effectiveTo"]) delete o[c];
      return o;
    };
    for (const [k, rows] of byKey) {
      expect(rows.filter((r) => r.effectiveTo == null), k).toHaveLength(1);
      for (const r of rows) expect(rest(r), `${k} ${from(r)}`).toEqual(rest(rows[0]));
    }
  });
});

describe("findRates on the day before and the day of every boundary", () => {
  const map = seedRatesMap();

  it.each(CLASSES)("$name", (c) => {
    let checked = 0;
    for (const [k, rows] of keysOf(c)) {
      const { broker, plan, segment, exchange } = rows[0];
      // A date long before any verified boundary takes the EARLIEST verified schedule (owner ruling).
      const probes: [string, number][] = [["2000-01-03", 0]];
      for (let i = 1; i < c.froms.length; i++) probes.push([dayBefore(c.froms[i]), i - 1], [c.froms[i], i]);
      for (const [on, epoch] of probes) {
        const hit = findRates(map, broker, segment, exchange, on, plan);
        expect(hit.exchangeTxnPct, `${k} on ${on}`).toBe(c.txn[epoch]);
        expect(hit.ipftPct, `${k} on ${on}`).toBe(c.ipft[epoch]);
        expect(hit.sttPct, `${k} on ${on}`).toBe(sttOn(segment, on));
        checked++;
      }
    }
    expect(checked).toBe(c.keys * (1 + 2 * (c.froms.length - 1)));
  });
});
