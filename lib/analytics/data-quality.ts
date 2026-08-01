export type QualitySeverity = "critical" | "warning" | "info";

export interface QualityIssue {
  code: string;
  severity: QualitySeverity;
  title: string;
  detail: string;
  count: number;
  href: string;
  ids?: number[];
}

export interface QualityTrade {
  id: number;
  isOpen: boolean;
  acquisition: string | null;
  acquisitionPrice: number | null;
  closingPrice: number | null;
  slPlanned: number | null;
  riskAmount: number | null;
  segment: string;
  mtfFundedAmount: number | null;
  instrumentType: string;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
  symbol: string;
}

export interface QualityInputs {
  trades: QualityTrade[];
  markedTradeIds: Set<number>;
  knownSymbols: Set<string>;
  ipoLinkedTradeIds: Set<number>;
  staleMtmCount: number;
  missingAttachmentFiles: number;
}

export interface QualityReport {
  score: number;
  issues: QualityIssue[];
  affected: number;
  checked: number;
}

export function assessDataQuality(i: QualityInputs): QualityReport {
  const issues: QualityIssue[] = [];
  const add = (issue: QualityIssue, ids: number[] = []) => { if (issue.count > 0) issues.push({ ...issue, ids: ids.slice(0, 100) }); };

  const basis = i.trades.filter((t) => t.acquisition != null && (!t.acquisitionPrice || t.acquisitionPrice <= 0));
  add({ code: "unknown_basis", severity: "critical", title: "Unknown acquisition cost", detail: "These sales cannot produce trustworthy P&L, tax, expectancy, or ROM until their basis is confirmed.", count: basis.length, href: "/trades?basis=unknown" }, basis.map((t) => t.id));

  const unmarked = i.trades.filter((t) => t.isOpen && !(t.closingPrice && t.closingPrice > 0) && !i.markedTradeIds.has(t.id));
  add({ code: "unmarked_open", severity: "critical", title: "Open positions without a mark", detail: "Unrealised P&L and live risk are incomplete for these positions.", count: unmarked.length, href: "/equity" }, unmarked.map((t) => t.id));

  const unstopped = i.trades.filter((t) => t.isOpen && (t.slPlanned == null || t.riskAmount == null));
  add({ code: "missing_stop", severity: "warning", title: "Open positions without complete risk", detail: "Set both a stop and risk amount so limit, R and cockpit calculations reconcile.", count: unstopped.length, href: "/trades?view=open" }, unstopped.map((t) => t.id));

  const mtf = i.trades.filter((t) => t.segment === "eq_mtf" && (!t.mtfFundedAmount || t.mtfFundedAmount <= 0));
  add({ code: "mtf_funding", severity: "warning", title: "MTF positions without funded principal", detail: "Interest, leverage and own-capital return need the broker-funded amount.", count: mtf.length, href: "/equity?funding=mtf" }, mtf.map((t) => t.id));

  const options = i.trades.filter((t) => t.instrumentType === "option" && (!t.expiry || t.strike == null || !t.optionType));
  add({ code: "option_contract", severity: "warning", title: "Incomplete option contracts", detail: "Expiry, strike and CE/PE are required for Greeks, settlement and seller analytics.", count: options.length, href: "/trades" }, options.map((t) => t.id));

  const instrument = i.trades.filter((t) => !i.knownSymbols.has(t.symbol.toUpperCase()));
  add({ code: "instrument_master", severity: "info", title: "Symbols absent from instrument master", detail: "Sector, lot-size and concentration coverage may be incomplete.", count: new Set(instrument.map((t) => t.symbol)).size, href: "/instruments" }, instrument.map((t) => t.id));

  const ipo = i.trades.filter((t) => t.acquisition === "ipo" && !i.ipoLinkedTradeIds.has(t.id));
  add({ code: "ipo_link", severity: "warning", title: "IPO holdings not linked to an IPO record", detail: "Linking makes allotment basis, listing mark and exit flow from one source of truth.", count: ipo.length, href: "/ipos" }, ipo.map((t) => t.id));

  add({ code: "stale_mtm", severity: "info", title: "Stale MTM marks", detail: "Refresh or confirm prices before relying on unrealised P&L and breach alerts.", count: i.staleMtmCount, href: "/risk" });
  add({ code: "missing_attachment", severity: "warning", title: "Attachment records with missing files", detail: "The journal points to images that are no longer present on disk.", count: i.missingAttachmentFiles, href: "/backup" });

  const weight = { critical: 12, warning: 6, info: 2 } as const;
  const penalty = issues.reduce((s, x) => s + Math.min(30, x.count * weight[x.severity]), 0);
  return { score: Math.max(0, 100 - penalty), issues, affected: new Set(issues.flatMap((x) => x.ids ?? [])).size, checked: i.trades.length };
}
