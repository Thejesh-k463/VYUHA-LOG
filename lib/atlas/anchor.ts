/**
 * A10 — the daily anchor.
 *
 * The anchor is the LATEST MODAL last-bar session across the universe, ties
 * broken towards the later date. It is deliberately NOT `max(date)`: one
 * symbol that refreshed early collapses the whole breadth cross-section onto
 * a session almost nothing else has, and every count then quietly shrinks.
 *
 * Symbols ahead of the anchor are TRUNCATED to it (they keep participating,
 * their later bars are ignored); symbols behind it are EXCLUDED as stale.
 * Both counts are published — that is the first of the four things the
 * staleness ledger owes the user (04 section 4.4).
 */
import type { Bar, IsoDate, Series } from "./types";

export interface StaleSymbol {
  symbol: string;
  lastSeen: IsoDate;
  sessionsBehind: number;
}

export interface AnchorAlignment {
  anchor: IsoDate | null;
  /** Series truncated to the anchor, ascending by symbol. */
  aligned: Series[];
  /** Symbols that had bars AFTER the anchor and were cut back to it. */
  truncated: string[];
  /** Symbols whose last bar predates the anchor. */
  stale: StaleSymbol[];
  /** Symbols on the anchor after alignment. */
  coverage: number;
  /** Symbols considered (aligned + stale). */
  total: number;
}

/** Every distinct session date in the universe, ascending. */
export function sessionCalendar(series: Series[]): IsoDate[] {
  const set = new Set<IsoDate>();
  for (const s of series) for (const b of s.bars) set.add(b.date);
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The latest modal last-bar date. Ties go to the LATER date, so a fresh
 * session that already covers as many symbols as the previous one wins.
 */
export function modalAnchor(series: Series[]): IsoDate | null {
  const counts = new Map<IsoDate, number>();
  for (const s of series) {
    const last = s.bars.at(-1);
    if (!last) continue;
    counts.set(last.date, (counts.get(last.date) ?? 0) + 1);
  }
  let best: IsoDate | null = null;
  let bestCount = 0;
  for (const [date, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && date > best)) {
      best = date;
      bestCount = count;
    }
  }
  return best;
}

/** Truncate everything to the anchor and split the universe into aligned vs stale. */
export function alignToAnchor(series: Series[], anchor: IsoDate | null): AnchorAlignment {
  if (anchor === null) {
    return { anchor: null, aligned: [], truncated: [], stale: [], coverage: 0, total: series.length };
  }
  const calendar = sessionCalendar(series);
  const indexOf = new Map<IsoDate, number>();
  calendar.forEach((d, i) => indexOf.set(d, i));
  const anchorIndex = indexOf.get(anchor) ?? calendar.length - 1;

  const aligned: Series[] = [];
  const truncated: string[] = [];
  const stale: StaleSymbol[] = [];

  for (const s of series) {
    const last = s.bars.at(-1);
    if (!last) continue;
    if (last.date > anchor) {
      const bars: Bar[] = s.bars.filter((b) => b.date <= anchor);
      const newLast: Bar | undefined = bars.at(-1);
      if (newLast && newLast.date === anchor) {
        truncated.push(s.symbol);
        aligned.push({ symbol: s.symbol, bars });
        continue;
      }
      // Ahead of the anchor but with no bar ON it: still stale for this session.
      const lastSeen = newLast?.date ?? last.date;
      stale.push({ symbol: s.symbol, lastSeen, sessionsBehind: sessionsBetween(indexOf, lastSeen, anchorIndex) });
      continue;
    }
    if (last.date === anchor) {
      aligned.push(s);
      continue;
    }
    stale.push({
      symbol: s.symbol,
      lastSeen: last.date,
      sessionsBehind: sessionsBetween(indexOf, last.date, anchorIndex),
    });
  }

  aligned.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  truncated.sort();
  stale.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { anchor, aligned, truncated, stale, coverage: aligned.length, total: aligned.length + stale.length };
}

function sessionsBetween(indexOf: Map<IsoDate, number>, from: IsoDate, anchorIndex: number): number {
  const i = indexOf.get(from);
  return i === undefined ? 0 : anchorIndex - i;
}

/** Bars up to and including `date` — the replay primitive used by A11. */
export function truncateTo(series: Series[], date: IsoDate): Series[] {
  const out: Series[] = [];
  for (const s of series) {
    const bars = s.bars.filter((b) => b.date <= date);
    if (bars.length > 0) out.push({ symbol: s.symbol, bars });
  }
  return out;
}
