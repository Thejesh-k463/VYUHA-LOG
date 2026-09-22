import "server-only";
import { cache } from "react";
import { getTaxTrades } from "./trades";
// TAX-IPO-LINK is CAP-IPO-LINK: ONE implementation of the counted-once rule,
// beside the IPO reads it is about (wave 2L). It used to be defined here as
// well, and the two copies drifted into reading the link differently.
import { getIposComputed, ipoIdsCountedThroughTrades } from "./ipos";
import { resolveTaxScope } from "./tax-scope";
import type { TaxTrade } from "@/lib/analytics/tax";
import { sectionOn } from "@/lib/analytics/statute";
import {
  classifyGain,
  type CapitalGainsTrade,
} from "@/lib/analytics/capital-gains";
import { assetClassFor, type CgAssetClass } from "@/lib/analytics/cg-heads";

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
export const getTaxBase = cache((personParam?: string | null) => {
  // v4.5.0 wave TP — TAX PERSON, not account (owner ruling T1). The scope is
  // resolved ONCE here and threaded into every read this base makes, so the
  // trades and the IPOs can never come from two different scopes. An empty
  // accountIds (All accounts with more than one person) yields an EMPTY base:
  // the page shows a person picker and no figure, never a merged total across
  // two tax persons (invariant 6).
  const scope = resolveTaxScope(personParam);
  const trades = getTaxTrades(scope.accountIds);
  const closedTrades = trades.filter((t) => !t.isOpen);

  // Exited IPOs are equity-delivery capital gains but live OUTSIDE the trades
  // table — fold them into BOTH the raw scaffold and the set-off engine so the
  // Tax Summary is complete. Acquisition date = allotment (fallback listing/applied).
  // TAX-IPO-LINK: an exited IPO whose linked holding is one of the closed trades
  // above is realised THROUGH that trade (the exit saved on /ipos closed it) —
  // folding it in too filed one gain twice in taxByFy, set-off and the ITR export.
  const throughTrade = ipoIdsCountedThroughTrades(new Set(closedTrades.map((t) => t.id)), scope.accountIds);
  const exitedIpos = getIposComputed(scope.accountIds).rows.filter((r) => r.realised && !throughTrade.has(r.id));
  const ipoTaxRows: TaxTrade[] = exitedIpos.map((r) => ({
    segment: "eq_delivery",
    // An IPO allotment is an equity SHARE by construction — the /ipos surface
    // only ever holds a mainboard or SME share issue, never a fund unit.
    assetClass: "share" as CgAssetClass,
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
      // v4.5.0 — THE one place a stored row becomes a classified capital-gains
      // trade. `assetClass` is required and resolved here from the ISIN first
      // and the symbol second, so nothing downstream has to guess and nothing
      // downstream is allowed to default it to "share".
      assetClass: assetClassFor({ segment: t.segment, isin: t.isin, symbol: t.symbol }),
      buyDate: t.buyDate,
      sellDate: t.sellDate,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      netPnl: t.netPnl,
      sttCtt: t.sttCtt,
      mtfInterest: t.mtfInterest,
      pledgeCharges: t.pledgeCharges,
      fmv31Jan2018: t.fmv31Jan2018 != null && t.buyQty > 0 ? t.fmv31Jan2018 * t.buyQty : null,
    })),
    ...ipoTaxRows.map((r) => ({
      segment: r.segment,
      assetClass: r.assetClass,
      buyDate: r.buyDate,
      sellDate: r.sellDate,
      buyValue: r.buyValue,
      sellValue: r.sellValue,
      netPnl: r.netPnl,
    })),
  ];

  /**
   * The closed trades re-shaped for the pure per-FY modules, carrying the
   * resolved `assetClass` and the three non-deductible charge lines. Pages read
   * THIS, never `closedTrades` directly, so one row cannot be classified two
   * ways on two screens.
   */
  const taxRows: TaxTrade[] = closedTrades.map((t) => ({
    segment: t.segment,
    assetClass: assetClassFor({ segment: t.segment, isin: t.isin, symbol: t.symbol }),
    instrumentType: t.instrumentType,
    buyDate: t.buyDate,
    sellDate: t.sellDate,
    grossPnl: t.grossPnl,
    netPnl: t.netPnl,
    buyValue: t.buyValue,
    sellValue: t.sellValue,
    chargesTotal: t.chargesTotal,
    sttCtt: t.sttCtt,
    mtfInterest: t.mtfInterest,
    pledgeCharges: t.pledgeCharges,
    isOpen: false,
  }));

  return { trades, closedTrades, exitedIpos, ipoTaxRows, cgTrades, taxRows, scope };
});

/** How many rows the ITR export will contain — the page's disabled state. */
export function countItrRows(personParam?: string | null): number {
  const { cgTrades } = getTaxBase(personParam);
  return cgTrades.reduce((n, t) => (classifyGain(t) ? n + 1 : n), 0);
}

/**
 * The head label for one classified row, cited under the Act that governed the
 * SALE, not today's. A blank head prints the word BLANK-equivalent — an empty
 * string — rather than a plausible section number (invariant 6).
 */
function headLabel(g: NonNullable<ReturnType<typeof classifyGain>>, sellDate: string | null): string {
  switch (g.bucket) {
    case "stcg111A":
      return `STCG (${sectionOn(sellDate, "stcgEquity")})`;
    case "stcgOther":
      return g.head?.head === "stcgDeemedSmf"
        ? `STCG deemed (${sectionOn(sellDate, "stcgDeemedSmf")})`
        : "STCG at slab rates";
    case "ltcg112A":
      return g.head?.head === "ltcgExempt1038"
        ? `LTCG exempt (${sectionOn(sellDate, "ltcgExempt1038")})`
        : `LTCG (${sectionOn(sellDate, "ltcgEquity")})`;
    case "ltcg112":
      return `LTCG (${sectionOn(sellDate, "ltcgOther")})`;
    case "cgUndetermined":
      return "";
    case "speculative":
      return "Speculative business";
    default:
      return "Non-speculative business (F&O)";
  }
}

/**
 * ITR-schedule-shaped per-trade rows (closed equity + F&O + exited IPOs) —
 * built on demand for `/api/tax-itr`, never during a page render.
 */
export function getItrExportRows(personParam?: string | null) {
  const { closedTrades, exitedIpos, cgTrades } = getTaxBase(personParam);
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
        // v4.5.0 — the TERM comes from the resolved head, which knows the
        // calendar-month rule AND the 36-month band for a listed non-equity
        // unit. A head the journal cannot determine has NO term: blank, never
        // the conservative "ST" the 365-day copy used to print as if measured.
        term: g.head?.term ?? "",
        /** The §G1 cell, so the export names WHICH band it priced from. */
        cell: g.head?.cell ?? "",
        // Cited under the Act that governed the year of the sale, not today's.
        head: headLabel(g, t.sellDate),
        /** Blank means "this journal states no head", and the reason says why. */
        headBlankReason: g.bucket === "cgUndetermined" ? (g.head?.reasons ?? []).join(" ") : "",
        /** ₹ added back into `taxableGain` because they are not deductible. */
        sttAddedBack: g.addedBackStt,
        mtfNotDeducted: g.addedBackMtf,
        taxableGain: g.taxableGain,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);
}
export type ItrExportRow = ReturnType<typeof getItrExportRows>[number];
