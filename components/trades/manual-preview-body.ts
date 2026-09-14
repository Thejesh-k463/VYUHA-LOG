/**
 * The body the manual Add-trade form POSTs to /api/charges/preview.
 *
 * PURE and browser-safe: no "use client", no server import, no React. The form
 * imports it; tests/charges-preview-date.test.ts runs it against the real route
 * and the real save.
 *
 * v4.3.0 P6: the form always holds the ENTRY in its buyQty/avgBuyPrice state
 * and the EXIT in sellQty/avgSellPrice, but createManualTrade
 * (app/trades/actions.ts) files a written (sell-direction) F&O trade's entry on
 * the SELL side and its exit on the BUY side. The preview used to send the
 * form's sides as they stood, so it charged STT on the exit premium and showed
 * a winning short as a loss: sell 75 @ 300 on 2024-09-30, bought back 75 @ 200
 * on 2024-10-03 (Zerodha NSE index option) saved 83.37 / +7416.63 and previewed
 * 79.37 / −7579.37; the open short saved 50.9 and previewed 37.9.
 *
 * This maps entry/exit onto buy/sell EXACTLY as createManualTrade does —
 * quantities, values (rounded to the paisa), gross, and the R56 dates — so the
 * figure shown before Save is the figure the save stores.
 */

export interface ManualPreviewInput {
  broker: string;
  tradingsymbol: string;
  productHint: string | null;
  segment: string | null;
  exchange: string | null;
  /** The form's hidden `direction` input: "sell" only for a written F&O trade. */
  direction: "buy" | "sell";
  /** An open trade has no exit leg yet (createManualTrade ignores it). */
  open: boolean;
  entryQty: number;
  entryPrice: number;
  entryDate: string | null;
  exitQty: number;
  exitPrice: number;
  exitDate: string | null;
  /** MTF only; ignored server-side unless the classified segment is eq_mtf. */
  ownCapitalUsed: number | null;
  daysHeld: number;
}

export interface ManualPreviewBody {
  broker: string;
  tradingsymbol: string;
  productHint: string | null;
  segment: string | null;
  exchange: string | null;
  buyValue: number;
  sellValue: number;
  buyQty: number;
  sellQty: number;
  grossPnl: number;
  ownCapitalUsed: number | null;
  daysHeld: number;
  isOpen: boolean;
  buyDate: string | null;
  sellDate: string | null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function buildManualPreviewBody(i: ManualPreviewInput): ManualPreviewBody {
  // createManualTrade: an open trade's exit leg is zero and undated.
  const exitQty = i.open ? 0 : i.exitQty;
  const exitPrice = i.open ? 0 : i.exitPrice;
  const exitDate = i.open ? null : i.exitDate;

  const short = i.direction === "sell";
  const buyQty = short ? exitQty : i.entryQty;
  const avgBuyPrice = short ? exitPrice : i.entryPrice;
  const buyDate = short ? exitDate : i.entryDate;
  const sellQty = short ? i.entryQty : exitQty;
  const avgSellPrice = short ? i.entryPrice : exitPrice;
  const sellDate = short ? i.entryDate : exitDate;

  const buyValue = round2(buyQty * avgBuyPrice);
  const sellValue = round2(sellQty * avgSellPrice);

  return {
    broker: i.broker,
    tradingsymbol: i.tradingsymbol,
    productHint: i.productHint,
    segment: i.segment,
    exchange: i.exchange,
    buyValue,
    sellValue,
    buyQty,
    sellQty,
    grossPnl: sellQty > 0 && buyQty > 0 ? round2(sellValue - buyValue) : 0,
    // daysHeld is forced 0 for an open position: interest can't have accrued
    // before the daily accrual job runs from T+1.
    ownCapitalUsed: i.ownCapitalUsed,
    daysHeld: i.open ? 0 : i.daysHeld,
    isOpen: i.open,
    // Priced at the dates the save stores (R56): the sell date, else the buy date.
    buyDate,
    sellDate,
  };
}
