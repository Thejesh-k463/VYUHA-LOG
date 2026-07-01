// IND-11 — Expiry-day analytics + upcoming-expiry calendar (PURE, no DB/React).
//
// Indian retail F&O activity concentrates on expiry days. Without a paid calendar
// feed we derive the expiry calendar from the journal itself: the set of distinct
// expiry dates across all F&O trades ARE the market's expiry days. Closed F&O trades
// whose exit date falls on one of those dates are "expiry-day" trades. Open positions
// drive the upcoming-expiry list.

const FNO_SEGMENTS = new Set([
  "stock_option",
  "index_option",
  "future",
  "commodity_future",
  "commodity_option",
]);

const isFno = (segment: string) => FNO_SEGMENTS.has(segment);

export interface ExpiryTradeInput {
  segment: string;
  expiry: string | null;
  sellDate: string | null;
  isOpen: boolean;
  netPnl: number;
}

export interface ExpiryBucket {
  label: string;
  trades: number;
  net: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgPerTrade: number;
}

export interface UpcomingExpiry {
  date: string;
  dte: number;
  positions: number;
}

export interface ExpiryStats {
  expiryDates: string[]; // derived calendar (sorted)
  expiryDay: ExpiryBucket;
  nonExpiry: ExpiryBucket;
  concentrationPct: number; // expiry-day trades ÷ all closed F&O trades
  netEdgeExpiry: number; // expiry-day avg per trade − non-expiry avg per trade
  upcoming: UpcomingExpiry[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function daysBetween(a: string, b: string): number {
  const x = new Date(a + "T00:00:00").getTime();
  const y = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(x) || Number.isNaN(y)) return 0;
  return Math.round((y - x) / 86400000);
}

function bucket(label: string, trades: ExpiryTradeInput[]): ExpiryBucket {
  const net = trades.reduce((s, t) => s + t.netPnl, 0);
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const losses = trades.filter((t) => t.netPnl < 0).length;
  return {
    label,
    trades: trades.length,
    net: r2(net),
    wins,
    losses,
    winRatePct: trades.length ? r2((wins / trades.length) * 100) : 0,
    avgPerTrade: trades.length ? r2(net / trades.length) : 0,
  };
}

export function computeExpiryStats(
  trades: ExpiryTradeInput[],
  today: string = new Date().toISOString().slice(0, 10),
): ExpiryStats {
  const fno = trades.filter((t) => isFno(t.segment));
  const expirySet = new Set(fno.map((t) => t.expiry).filter((e): e is string => !!e));

  const closed = fno.filter((t) => !t.isOpen && t.sellDate);
  const onExpiry = closed.filter((t) => expirySet.has(t.sellDate!));
  const offExpiry = closed.filter((t) => !expirySet.has(t.sellDate!));

  const expiryDay = bucket("Expiry day", onExpiry);
  const nonExpiry = bucket("Other days", offExpiry);

  // Upcoming expiries from still-open F&O positions.
  const openByExpiry = new Map<string, number>();
  for (const t of fno) {
    if (t.isOpen && t.expiry && t.expiry >= today) {
      openByExpiry.set(t.expiry, (openByExpiry.get(t.expiry) ?? 0) + 1);
    }
  }
  const upcoming: UpcomingExpiry[] = [...openByExpiry.entries()]
    .map(([date, positions]) => ({ date, dte: daysBetween(today, date), positions }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    expiryDates: [...expirySet].sort(),
    expiryDay,
    nonExpiry,
    concentrationPct: closed.length ? r2((onExpiry.length / closed.length) * 100) : 0,
    netEdgeExpiry: r2(expiryDay.avgPerTrade - nonExpiry.avgPerTrade),
    upcoming,
  };
}
