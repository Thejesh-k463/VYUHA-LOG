import "server-only";
import { cache } from "react";
import { getTaxTrades } from "./trades";
import { getIposComputed } from "./ipos";
import type { TaxTrade } from "@/lib/analytics/tax";
import { sectionOn } from "@/lib/analytics/statute";
import {
  classifyGain,
  classifyTerm,
  type CapitalGainsTrade,
} from "@/lib/analytics/capital-gains";

/**
 * The shared input set for the Tax Summary page AND the on-demand ITR export
 * route. One builder, two consumers, so the page's badge/count and the
 * exported file can never disagree about which trades classify into which
 * schedule.
 *
 * Why this exists: the page used to build the full ITR-shaped per-trade array
 * (one row per closed trade — 21.5k on the perf tier) and pass it as props to
 * the client `ExportButtons`, which serialised ~4.8 MB of never-rendered rows
 * into the RSC payload of every visit. The rows are now fetched by
 * `/api/tax-itr` only when Export is actually clicked (the `/cash` ledger
 * export pattern). The construction below is moved VERBATIM from
 * `app/reports/tax/page.tsx` — same order (closed trades, then exited IPOs),
 * same field mapping, so every derived figure is bit-identical.
 *
 * `getTaxTrades` is a pure column projection of the whole book — the closed
 * filter stays HERE in JS (not in SQL) because an added WHERE clause was
 * measured to reorder rows tying on (sell_date, created_at), which would
 * shuffle the export's row order and float-summation order.
 */
export const getTaxBase = cache(() => {
  const trades = getTaxTrades();
  const closedTrades = trades.filter((t) => !t.isOpen);

  // Exited IPOs are equity-delivery capital gains but live OUTSIDE the trades
  // table — fold them into BOTH the raw scaffold and the set-off engine so the
  // Tax Summary is complete. Acquisition date = allotment (fallback listing/applied).
  const exitedIpos = getIposComputed().rows.filter((r) => r.realised);
  const ipoTaxRows: TaxTrade[] = exitedIpos.map((r) => ({
    segment: "eq_delivery",
    instrumentType: "equity",
    buyDate: r.allotmentDate ?? r.listingDate ?? r.appliedDate ?? null,
    sellDate: r.exitDate ?? null,
    grossPnl: r.grossPnl,
    netPnl: r.netPnl,
    buyValue: r.investedAllotted,
    sellValue: (r.exitPrice ?? 0) * r.allottedQty,
    chargesTotal: r.charges,
    isOpen: false,
  }));

  // IND-1 + IND-2 inputs. Grandfathering uses the per-trade FMV (per-share ×
  // qty → same total units as buyValue/sellValue).
  const cgTrades: CapitalGainsTrade[] = [
    ...closedTrades.map((t) => ({
      segment: t.segment,
      buyDate: t.buyDate,
      sellDate: t.sellDate,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      netPnl: t.netPnl,
      fmv31Jan2018: t.fmv31Jan2018 != null && t.buyQty > 0 ? t.fmv31Jan2018 * t.buyQty : null,
    })),
    ...ipoTaxRows.map((r) => ({
      segment: r.segment,
      buyDate: r.buyDate,
      sellDate: r.sellDate,
      buyValue: r.buyValue,
      sellValue: r.sellValue,
      netPnl: r.netPnl,
    })),
  ];

  return { trades, closedTrades, exitedIpos, ipoTaxRows, cgTrades };
});

/** How many rows the ITR export will contain — the page's disabled state. */
export function countItrRows(): number {
  const { cgTrades } = getTaxBase();
  return cgTrades.reduce((n, t) => (classifyGain(t) ? n + 1 : n), 0);
}

/**
 * ITR-schedule-shaped per-trade rows (closed equity + F&O + exited IPOs) —
 * built on demand for `/api/tax-itr`, never during a page render.
 */
export function getItrExportRows() {
  const { closedTrades, exitedIpos, cgTrades } = getTaxBase();
  return cgTrades
    .map((t, i) => {
      const g = classifyGain(t);
      if (!g) return null;
      const isIpo = i >= closedTrades.length;
      return {
        scrip: isIpo ? `${exitedIpos[i - closedTrades.length].name} (IPO)` : closedTrades[i].symbol,
        acquired: t.buyDate ?? "",
        sold: t.sellDate ?? "",
        cost: t.buyValue,
        consideration: t.sellValue,
        netGain: t.netPnl,
        term: t.segment === "eq_delivery" || t.segment === "eq_mtf" ? classifyTerm(t.buyDate, t.sellDate) : "",
        // Cited under the Act that governed the year of the sale, not today's.
        head:
          g.bucket === "stcg"
            ? `STCG (${sectionOn(t.sellDate, "stcgEquity")})`
            : g.bucket === "ltcg"
              ? `LTCG (${sectionOn(t.sellDate, "ltcgEquity")})`
              : g.bucket === "speculative"
                ? "Speculative business"
                : "Non-speculative business (F&O)",
        taxableGain: g.taxableGain,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);
}
export type ItrExportRow = ReturnType<typeof getItrExportRows>[number];
