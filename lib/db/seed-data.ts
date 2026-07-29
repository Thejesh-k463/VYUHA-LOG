import type { Broker, Exchange, Segment } from "../domain/constants";

/**
 * Canonical FY2026-27 (post 1-Apr-2026) rate table from the build brief §5.
 * Everything here is a fraction of turnover/premium (0.1% => 0.001) unless noted.
 * These values seed `charge_config`; the engine reads only from the DB at runtime.
 */

type ChargeSeedRow = {
  broker: Broker;
  segment: Segment;
  exchange: Exchange;
  brokerageFlat: number | null;
  brokeragePct: number;
  brokerageCap: number | null;
  brokerageFloor: number;
  sttPct: number;
  sttSide: "both" | "buy" | "sell" | "none";
  exchangeTxnPct: number;
  sebiPct: number;
  stampPct: number;
  ipftPct: number;
  gstPct: number;
  dpCharge: number;
  dpPct: number;
  dpGstApplicable: boolean;
  dpMinValue: number;
  mtfInterestAnnual: number;
  mtfRateUnknown: boolean;
  mtfTiers: { upTo: number | null; rate: number }[] | null;
  pledgeCharge: number;
  unpledgeCharge: number;
};

const SEBI_PCT = 0.000001; // 0.0001% = ₹10/crore, both sides
const IPFT_NSE_PCT = 0.000000001; // ~₹0.01/crore, NSE only, both sides
const GST = 0.18;

// --- STT / CTT by segment ---------------------------------------------------
function sttFor(segment: Segment): { pct: number; side: "both" | "sell" | "none" } {
  switch (segment) {
    case "eq_delivery":
    case "eq_mtf":
      return { pct: 0.001, side: "both" }; // 0.1% buy + sell
    case "eq_intraday":
      return { pct: 0.00025, side: "sell" }; // 0.025% sell
    case "future":
      return { pct: 0.0005, side: "sell" }; // 0.05% sell
    case "index_option":
    case "stock_option":
      return { pct: 0.0015, side: "sell" }; // 0.15% of premium on sell
    case "commodity_future":
      return { pct: 0.0001, side: "sell" }; // CTT 0.01% sell
    case "commodity_option":
      return { pct: 0.0005, side: "sell" }; // CTT 0.05% sell
  }
}

// --- Exchange transaction charges by segment + exchange ----------------------
function exchangeTxnFor(segment: Segment, exchange: Exchange): number {
  if (segment === "eq_delivery" || segment === "eq_mtf" || segment === "eq_intraday") {
    return exchange === "BSE" ? 0.0000375 : 0.0000297;
  }
  if (segment === "index_option" || segment === "stock_option") {
    return exchange === "BSE" ? 0.000325 : 0.0003503;
  }
  if (segment === "future") return 0.0000173;
  if (segment === "commodity_future") return 0.000021;
  if (segment === "commodity_option") return 0.000418;
  return 0;
}

// --- Stamp duty (BUY side) by segment ---------------------------------------
function stampFor(segment: Segment): number {
  switch (segment) {
    case "eq_delivery":
    case "eq_mtf":
      return 0.00015; // 0.015%
    case "eq_intraday":
      return 0.00003; // 0.003%
    case "future":
    case "commodity_future":
      return 0.00002; // 0.002%
    case "index_option":
    case "stock_option":
    case "commodity_option":
      return 0.00003; // 0.003%
  }
}

// --- Brokerage by broker + segment ------------------------------------------
function brokerageFor(
  broker: Broker,
  segment: Segment,
): { flat: number | null; pct: number; cap: number | null; floor: number } {
  const FLAT20 = { flat: 20, pct: 0, cap: null as number | null, floor: 0 };
  const ZERO = { flat: 0, pct: 0, cap: null as number | null, floor: 0 };

  if (broker === "zerodha") {
    switch (segment) {
      case "eq_delivery":
        return ZERO;
      case "eq_mtf":
        return { flat: null, pct: 0.003, cap: 20, floor: 0 }; // min(20, 0.3%)
      case "eq_intraday":
      case "future":
      case "commodity_future":
        return { flat: null, pct: 0.0003, cap: 20, floor: 0 }; // min(20, 0.03%)
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  if (broker === "dhan") {
    switch (segment) {
      case "eq_delivery":
        return ZERO;
      case "eq_mtf":
      case "eq_intraday":
        return { flat: null, pct: 0.0003, cap: 20, floor: 0 }; // min(20, 0.03%)
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  // Angel One — ₹20 or 0.1% (whichever lower) on delivery; flat ₹20 elsewhere.
  if (broker === "angelone") {
    switch (segment) {
      case "eq_delivery":
        return { flat: null, pct: 0.001, cap: 20, floor: 0 };
      case "eq_mtf":
      case "eq_intraday":
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  // Upstox — ₹20 or 0.1% (whichever lower) on delivery/intraday; flat ₹20 elsewhere.
  if (broker === "upstox") {
    switch (segment) {
      case "eq_delivery":
      case "eq_intraday":
      case "eq_mtf":
        return { flat: null, pct: 0.001, cap: 20, floor: 0 };
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  // Kotak Neo — "Trade Free Plan" (free, lifetime), the default a new account
  // gets. kotakneo.com/pricing: 0.20% delivery; intraday "₹10 or 0.05%,
  // whichever is LOWER" (a cap, not a floor); ₹10 F&O carry-forward.
  // MTF follows the delivery rate — MTF is a delivery product and Kotak
  // publishes no separate MTF brokerage.
  if (broker === "kotakneo") {
    switch (segment) {
      case "eq_delivery":
      case "eq_mtf":
        return { flat: null, pct: 0.002, cap: null, floor: 0 }; // 0.20%
      case "eq_intraday":
        return { flat: null, pct: 0.0005, cap: 10, floor: 0 }; // min(10, 0.05%)
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return { flat: 10, pct: 0, cap: null, floor: 0 };
    }
  }

  // Paytm Money — paytmmoney.com/stocks/pricing.
  // Delivery "2.5% or up to ₹20, whichever is lower"; intraday "0.05% or up to
  // ₹20, whichever is lower"; F&O up to ₹20/executed order.
  // MTF is billed at "0.1% of trade value OR current brokerage, whichever is
  // HIGHER" — a floor, not a cap, and 0.1% dominates at any real size.
  if (broker === "paytm") {
    switch (segment) {
      case "eq_delivery":
        return { flat: null, pct: 0.025, cap: 20, floor: 0 }; // min(20, 2.5%)
      case "eq_intraday":
        return { flat: null, pct: 0.0005, cap: 20, floor: 0 }; // min(20, 0.05%)
      case "eq_mtf":
        return { flat: null, pct: 0.001, cap: null, floor: 0 }; // 0.1%, uncapped
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return FLAT20;
    }
  }

  // Sahi — sahi.com/pricing. Flat ₹10/order across segments; equity (BOTH
  // delivery and intraday) is "₹10 or 0.05%, whichever is lower". Note that
  // delivery is NOT free here, unlike most discount brokers.
  if (broker === "sahi") {
    switch (segment) {
      case "eq_delivery":
      case "eq_intraday":
      case "eq_mtf":
        return { flat: null, pct: 0.0005, cap: 10, floor: 0 }; // min(10, 0.05%)
      case "future":
      case "commodity_future":
      case "index_option":
      case "stock_option":
      case "commodity_option":
        return { flat: 10, pct: 0, cap: null, floor: 0 };
    }
  }

  // groww
  switch (segment) {
    case "eq_delivery":
    case "eq_intraday":
      return { flat: null, pct: 0.001, cap: 20, floor: 5 }; // min(20, 0.1%) floored at 5
    case "eq_mtf":
      return { flat: null, pct: 0.001, cap: null, floor: 0 }; // 0.1%/order
    case "future":
    case "commodity_future":
    case "index_option":
    case "stock_option":
    case "commodity_option":
      return FLAT20;
  }
}

// --- DP charges (delivery + MTF sell, per scrip) by broker ------------------
function dpFor(broker: Broker): {
  dpCharge: number;
  dpPct?: number;
  dpGstApplicable: boolean;
  dpMinValue: number;
} {
  switch (broker) {
    case "zerodha":
      return { dpCharge: 15.34, dpGstApplicable: false, dpMinValue: 0 }; // incl GST
    case "dhan":
      return { dpCharge: 12.5, dpGstApplicable: true, dpMinValue: 0 };
    case "groww":
      return { dpCharge: 20.0, dpGstApplicable: true, dpMinValue: 100 }; // 3.5 + 16.5
    case "angelone":
      return { dpCharge: 20.0, dpGstApplicable: true, dpMinValue: 0 };
    case "upstox":
      return { dpCharge: 18.5, dpGstApplicable: true, dpMinValue: 0 };
    // Kotak Neo bills DP as a PERCENTAGE with a floor: 0.04% of the value
    // sold, minimum ₹20, per scrip per day on delivery/BTST sells. It is the
    // only broker here that does, which is why `dpPct` exists at all.
    case "kotakneo":
      return { dpCharge: 20, dpPct: 0.0004, dpGstApplicable: true, dpMinValue: 0 };
    // Paytm Money: ₹20 from 1 Feb 2025 (incl ₹3.50 CDSL), excluding GST.
    case "paytm":
      return { dpCharge: 20, dpGstApplicable: true, dpMinValue: 0 };
    // Sahi: ₹13.50 per company on SELL transactions.
    case "sahi":
      return { dpCharge: 13.5, dpGstApplicable: true, dpMinValue: 0 };
  }
}

// --- MTF interest by broker --------------------------------------------------
function mtfFor(broker: Broker): {
  mtfInterestAnnual: number;
  mtfRateUnknown?: boolean;
  mtfTiers: { upTo: number | null; rate: number }[] | null;
  pledgeCharge: number;
  unpledgeCharge: number;
} {
  switch (broker) {
    case "dhan":
      return {
        mtfInterestAnnual: 0, // tiered
        mtfTiers: [
          { upTo: 500000, rate: 0.1249 },
          { upTo: 1000000, rate: 0.1349 },
          { upTo: 2500000, rate: 0.1449 },
          { upTo: null, rate: 0.1549 },
        ],
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    case "zerodha":
      return {
        mtfInterestAnnual: 0.146, // 0.04%/day per Zerodha's own MTF calculator
        mtfTiers: null,
        pledgeCharge: 15, // ₹15 + GST per ISIN per pledge request (zerodha.com/calculators/mtf-calculator)
        unpledgeCharge: 15, // ₹15 + GST per unpledge request
      };
    case "groww":
      return {
        mtfInterestAnnual: 0.1495,
        mtfTiers: null,
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    case "angelone":
      return {
        mtfInterestAnnual: 0.1425,
        mtfTiers: null,
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    case "upstox":
      return {
        mtfInterestAnnual: 0.1495,
        mtfTiers: null,
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    // Kotak Neo publishes 9.69% p.a., but ONLY on the Trade Free Pro plan
    // (₹249/month). The free plan quotes no MTF rate at all, so this figure is
    // the best-case and a Pro subscriber's; the monthly fee is not modelled.
    case "kotakneo":
      return {
        mtfInterestAnnual: 0.0969,
        mtfTiers: null,
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    // Paytm Money publishes a TIERED book-size rate, and note it is not
    // monotonic — the middle band is the most expensive:
    //   up to ₹1L 7.99% · ₹1L–1Cr 9.99% · above ₹1Cr 8.99%
    case "paytm":
      return {
        mtfInterestAnnual: 0,
        mtfTiers: [
          { upTo: 100000, rate: 0.0799 },
          { upTo: 10000000, rate: 0.0999 },
          { upTo: null, rate: 0.0899 },
        ],
        pledgeCharge: 20,
        unpledgeCharge: 20,
      };
    // Sahi names margin funding as a revenue source but publishes NO rate.
    // Seeding a guess would make Sahi look artificially cheap in exactly the
    // comparison this report exists to answer. `eq_mtf` is therefore left out
    // of Sahi's seeded combos entirely (see COMBOS_BY_BROKER), so it reports
    // as UNPRICED rather than as free.
    case "sahi":
      return {
        mtfInterestAnnual: 0,
        // Sahi names margin funding as a revenue source but publishes NO rate.
        mtfRateUnknown: true,
        mtfTiers: null,
        pledgeCharge: 15, // ₹15 per transaction/ISIN + GST, from their pricing page
        unpledgeCharge: 15,
      };
  }
}

// Which (segment, exchange) combos to seed for each broker.
const COMBOS: { segment: Segment; exchanges: Exchange[] }[] = [
  { segment: "eq_delivery", exchanges: ["NSE", "BSE"] },
  { segment: "eq_mtf", exchanges: ["NSE", "BSE"] },
  { segment: "eq_intraday", exchanges: ["NSE", "BSE"] },
  { segment: "index_option", exchanges: ["NSE", "BSE"] },
  { segment: "stock_option", exchanges: ["NSE", "BSE"] },
  { segment: "future", exchanges: ["NSE"] },
  { segment: "commodity_future", exchanges: ["MCX"] },
  { segment: "commodity_option", exchanges: ["MCX"] },
];

const BROKER_LIST: Broker[] = [
  "dhan", "zerodha", "groww", "angelone", "upstox", "kotakneo", "paytm", "sahi",
];



export function buildChargeConfigSeed(): ChargeSeedRow[] {
  const rows: ChargeSeedRow[] = [];
  for (const broker of BROKER_LIST) {
    for (const { segment, exchanges } of COMBOS) {
      for (const exchange of exchanges) {
        const b = brokerageFor(broker, segment);
        const stt = sttFor(segment);
        const isDeliveryLike = segment === "eq_delivery" || segment === "eq_mtf";
        const isMtf = segment === "eq_mtf";
        const dp = isDeliveryLike ? dpFor(broker) : { dpCharge: 0, dpPct: 0, dpGstApplicable: false, dpMinValue: 0 };
        const mtf = isMtf
          ? mtfFor(broker)
          : { mtfInterestAnnual: 0, mtfRateUnknown: false, mtfTiers: null, pledgeCharge: 0, unpledgeCharge: 0 };

        rows.push({
          broker,
          segment,
          exchange,
          brokerageFlat: b.flat,
          brokeragePct: b.pct,
          brokerageCap: b.cap,
          brokerageFloor: b.floor,
          sttPct: stt.pct,
          sttSide: stt.side,
          exchangeTxnPct: exchangeTxnFor(segment, exchange),
          sebiPct: SEBI_PCT,
          stampPct: stampFor(segment),
          ipftPct: exchange === "NSE" ? IPFT_NSE_PCT : 0,
          gstPct: GST,
          dpCharge: dp.dpCharge,
          dpPct: dp.dpPct ?? 0,
          dpGstApplicable: dp.dpGstApplicable,
          dpMinValue: dp.dpMinValue,
          mtfInterestAnnual: mtf.mtfInterestAnnual,
          mtfRateUnknown: mtf.mtfRateUnknown ?? false,
          mtfTiers: mtf.mtfTiers,
          pledgeCharge: mtf.pledgeCharge,
          unpledgeCharge: mtf.unpledgeCharge,
        });
      }
    }
  }
  return rows;
}
