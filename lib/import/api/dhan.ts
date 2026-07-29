/**
 * DhanHQ v2 API — the ONLY source that states MTF outright.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Every Dhan *file* is silent about margin funding. A P&L statement has no
 * product column at all; a Global Transaction Report has one implicitly, in the
 * charge rates — but MTF and delivery attract identical STT and stamp duty, and
 * financing interest is a LEDGER entry that never appears on a contract note.
 * So from files alone, "was this MTF?" is unanswerable and Vyuha has to ask.
 *
 * The API answers it. `GET /v2/positions` returns a `productType` enum whose
 * values are CNC, INTRADAY, MARGIN, **MTF**, CO and BO. That is a stated fact
 * from the broker's own books — no inference, no confirmation dialog.
 *
 * ── What it can and cannot cover ──────────────────────────────────────────
 *
 * `/v2/positions` is the CURRENT day's book plus carry-forward quantities, not
 * a historical tradebook. So this is the daily pull that keeps open MTF
 * positions honest; the long history still arrives by file. The same shape as
 * the Kite integration, deliberately — one seam, two brokers.
 *
 * `normalizeDhanPositions` is pure and unit-tested; the fetch wrapper is a thin
 * authenticated GET.
 */

import type { NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";

/** One row from GET /v2/positions (the fields we consume). */
export interface DhanPositionRow {
  dhanClientId?: string;
  tradingSymbol: string;
  securityId?: string;
  positionType: string; // LONG | SHORT | CLOSED
  exchangeSegment: string; // NSE_EQ | BSE_EQ | NSE_FNO | MCX_COMM | …
  productType: string; // CNC | INTRADAY | MARGIN | MTF | CO | BO
  buyAvg: number;
  buyQty: number;
  sellAvg: number;
  sellQty: number;
  netQty: number;
  realizedProfit?: number;
  unrealizedProfit?: number;
  drvExpiryDate?: string | null;
  drvOptionType?: string | null;
  drvStrikePrice?: number | null;
}

/** One row from GET /v2/holdings. */
export interface DhanHoldingRow {
  exchange: string;
  tradingSymbol: string;
  securityId?: string;
  isin?: string | null;
  totalQty: number;
  availableQty?: number;
  collateralQty?: number;
  avgCostPrice: number;
}

/**
 * Map Dhan's product type onto Vyuha's hint.
 *
 * MTF is the whole point of this integration — it is the one product no Dhan
 * file can express. MARGIN (the F&O/commodity carry-forward product) returns
 * null on purpose: the classifier reads the segment off the SYMBOL, and a hint
 * would only get in the way.
 */
export function productHintOf(productType: string): ProductHint {
  switch (String(productType).toUpperCase()) {
    case "MTF":
      return "mtf";
    case "CNC":
      return "delivery";
    case "INTRADAY":
    case "CO": // cover order — always intraday
    case "BO": // bracket order — always intraday
      return "intraday";
    default:
      return null; // MARGIN and anything new: let the symbol decide
  }
}

/** `NSE_EQ` → `NSE`. Null when the segment is unrecognised, so the classifier
 *  falls back to its own default rather than trusting a bad guess. */
export function exchangeOf(segment: string): Exchange | null {
  const s = String(segment).toUpperCase();
  if (s.startsWith("NSE")) return "NSE";
  if (s.startsWith("BSE")) return "BSE";
  if (s.startsWith("MCX")) return "MCX";
  return null;
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Turn today's positions into normalized trades.
 *
 * A position with `netQty === 0` was opened and closed today, so it is a
 * completed round trip; anything else is still open and is imported as such.
 * Gross P&L is taken from Dhan's own `realizedProfit` when it is present —
 * the broker's arithmetic beats ours — and derived from the legs otherwise.
 */
export function normalizeDhanPositions(rows: DhanPositionRow[], today: string): NormalizedTrade[] {
  const out: NormalizedTrade[] = [];

  for (const r of rows) {
    const buyQty = Number(r.buyQty) || 0;
    const sellQty = Number(r.sellQty) || 0;
    if (buyQty === 0 && sellQty === 0) continue; // nothing happened

    const buyValue = r2(buyQty * (Number(r.buyAvg) || 0));
    const sellValue = r2(sellQty * (Number(r.sellAvg) || 0));
    const closed = buyQty === sellQty && buyQty > 0;

    const gross =
      r.realizedProfit != null && Number.isFinite(Number(r.realizedProfit))
        ? r2(Number(r.realizedProfit))
        : closed
          ? r2(sellValue - buyValue)
          : 0;

    out.push({
      broker: "dhan",
      tradingsymbol: r.tradingSymbol,
      isin: null,
      buyQty,
      avgBuyPrice: r2(Number(r.buyAvg) || 0),
      buyValue,
      sellQty,
      avgSellPrice: r2(Number(r.sellAvg) || 0),
      sellValue,
      closingPrice: null,
      grossPnl: gross,
      unrealisedPnl: r2(Number(r.unrealizedProfit) || 0),
      // Positions are the CURRENT day's book, so today is the honest date.
      buyDate: buyQty > 0 ? today : null,
      sellDate: closed ? today : null,
      productHint: productHintOf(r.productType),
      exchangeHint: exchangeOf(r.exchangeSegment),
      sourceFile: "dhan-api",
      // The positions endpoint carries no fill times — only aggregates.
      entryTime: null,
      exitTime: null,
      importNotes:
        productHintOf(r.productType) === "mtf"
          ? ["Product stated by the Dhan API as MTF — not inferred."]
          : null,
    });
  }

  return out;
}

export interface DhanCredentials {
  /** Dhan client ID (stored in broker_connections.api_key). */
  clientId: string;
  /** The JWT access token from the Dhan developer console. */
  accessToken: string;
}

async function dhanGet<T>(path: string, creds: DhanCredentials): Promise<T> {
  const res = await fetch(`https://api.dhan.co/v2${path}`, {
    headers: {
      "Content-Type": "application/json",
      "access-token": creds.accessToken,
    },
    cache: "no-store",
  });

  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg =
      (json as { errorMessage?: string; message?: string } | null)?.errorMessage ??
      (json as { message?: string } | null)?.message ??
      `HTTP ${res.status}`;
    throw new Error(
      `Dhan API: ${msg}${
        res.status === 401 || res.status === 403
          ? " (access token expired or wrong? Dhan tokens are issued from web.dhan.co → DhanHQ Trading APIs and are valid for 24 hours by default.)"
          : ""
      }`,
    );
  }
  // Dhan returns a bare array on success for these endpoints.
  return json as T;
}

export async function fetchDhanPositions(creds: DhanCredentials): Promise<DhanPositionRow[]> {
  const data = await dhanGet<DhanPositionRow[] | null>("/positions", creds);
  return Array.isArray(data) ? data : [];
}

export async function fetchDhanHoldings(creds: DhanCredentials): Promise<DhanHoldingRow[]> {
  const data = await dhanGet<DhanHoldingRow[] | null>("/holdings", creds);
  return Array.isArray(data) ? data : [];
}

export function dhanImportSource(creds: DhanCredentials): ApiImportSource {
  return {
    id: "dhan-api",
    label: "Dhan API (today's positions, states MTF outright)",
    broker: "dhan",
    kind: "api",
    async fetchTrades() {
      const today = new Date().toISOString().slice(0, 10);
      return normalizeDhanPositions(await fetchDhanPositions(creds), today);
    },
  };
}

/** Wrap an API pull in the ParsedFile shape the preview/commit pipeline expects. */
export function toParsedFile(trades: NormalizedTrade[]): ParsedFile {
  const mtf = trades.filter((t) => t.productHint === "mtf").length;
  const warnings: string[] = [];

  if (trades.length === 0) {
    warnings.push(
      "Dhan returned no positions — /v2/positions covers the current trading day's book, so it is empty outside market hours with nothing carried forward.",
    );
  } else if (mtf > 0) {
    warnings.push(
      `${mtf} position${mtf === 1 ? " is" : "s are"} MTF according to Dhan itself. This is the one product no Dhan file can identify, so these need no confirmation.`,
    );
  } else {
    warnings.push(
      "No MTF positions in today's book. Product types here are stated by the broker, not inferred from charges.",
    );
  }

  return { sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings };
}
