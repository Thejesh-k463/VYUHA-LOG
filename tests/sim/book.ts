/**
 * A deterministic trading book — the GROUND TRUTH every broker writer renders
 * and every parser is then asked to recover.
 *
 * The point of simulation testing, as opposed to fixture testing, is that the
 * truth is known before the file exists. A fixture proves the parser does not
 * crash on a real layout; this proves it gets the NUMBERS back — every share,
 * every paisa, every date — and that the same book yields the same positions
 * whichever broker's format carried it.
 *
 * Shapes are chosen to exercise what the pairing engine and the product
 * signature actually branch on:
 *   - same-day buy + sell on one symbol  → intraday, netted first
 *   - buy today, sell days later         → delivery, FIFO across days
 *   - buy in several tranches, sell once → a lot queue that is consumed in order
 *   - sell with no prior buy             → opening sell, basis unknown
 *   - buy with no sell                   → open position
 *
 * Everything is integer paise internally; prices stay REAL per AGENTS.md
 * invariant 1 (levels are not money). Values are rounded to the paisa at the
 * point a broker would round them.
 */

export type Side = "buy" | "sell";

export interface Fill {
  seq: number;
  symbol: string;
  isin: string;
  exchange: "NSE" | "BSE";
  date: string; // yyyy-mm-dd
  time: string; // HH:MM:SS
  side: Side;
  qty: number;
  price: number;
  /** qty × price, rounded to the paisa. */
  value: number;
  /** True when the same scrip-day also carries the opposite side — intraday by the exchange's own netting. */
  intraday: boolean;
}

export interface Book {
  seed: number;
  fills: Fill[];
  symbols: { symbol: string; isin: string; exchange: "NSE" | "BSE"; code: string }[];
  /** Sum of buy qty / sell qty / buy value / sell value — what conservation is asserted against. */
  totals: { buyQty: number; sellQty: number; buyValue: number; sellValue: number; days: number };
}

/** Mulberry32 — small, seedable, good enough for deterministic fixtures. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Trading days only: skip Sat/Sun. */
function addTradingDays(from: Date, n: number): Date {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

export interface BookOptions {
  seed: number;
  /** Approximate number of fills to produce. */
  fills: number;
  /** Distinct symbols in the book. */
  symbols?: number;
  /** Share of symbols that start with an unseen holding, so their first sell is an OPENING sell. */
  openingSellShare?: number;
  /** First trading day. */
  start?: string;
}

/**
 * Generate a book. Per symbol, a small program of "episodes" runs forward in
 * time; each episode is one of the five shapes above. Fills are emitted with
 * realistic Indian-market times (09:15–15:30) and the scrip-day intraday flag
 * is computed after the fact from what the episode actually produced.
 */
export function makeBook(opts: BookOptions): Book {
  const rand = rng(opts.seed);
  const nSym = opts.symbols ?? Math.max(3, Math.min(40, Math.round(opts.fills / 25)));
  const openingShare = opts.openingSellShare ?? 0.2;
  const start = new Date((opts.start ?? "2026-04-01") + "T00:00:00Z");

  const symbols = Array.from({ length: nSym }, (_, i) => ({
    symbol: `SIM${String(i + 1).padStart(3, "0")}`,
    isin: `INE0SIM${String(i + 1).padStart(5, "0")}`,
    exchange: (rand() < 0.8 ? "NSE" : "BSE") as "NSE" | "BSE",
    code: String(900000 + i + 1), // Paytm-style numeric scrip code
  }));

  const fills: Fill[] = [];
  let seq = 1;
  const perSymbol = Math.max(4, Math.floor(opts.fills / nSym));

  const time = () => {
    // 09:15 to 15:29, minute resolution, seconds for realism.
    const mins = 9 * 60 + 15 + Math.floor(rand() * (6 * 60 + 14));
    const h = Math.floor(mins / 60), m = mins % 60, s = Math.floor(rand() * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  const price = (base: number) => r2(base * (0.97 + rand() * 0.06));

  for (const s of symbols) {
    let day = addTradingDays(start, Math.floor(rand() * 5));
    let base = 50 + rand() * 1950;
    let held = 0;
    const startsWithHolding = rand() < openingShare;
    let emitted = 0;

    const emit = (side: Side, qty: number, d: Date) => {
      const p = price(base);
      fills.push({ seq: seq++, symbol: s.symbol, isin: s.isin, exchange: s.exchange, date: isoDate(d), time: time(), side, qty, price: p, value: r2(qty * p), intraday: false });
      held += side === "buy" ? qty : -qty;
      emitted++;
    };

    // An opening-sell symbol sells from a holding the file never shows being bought.
    if (startsWithHolding) {
      emit("sell", 10 + Math.floor(rand() * 40), day);
      day = addTradingDays(day, 1 + Math.floor(rand() * 3));
    }

    while (emitted < perSymbol) {
      const shape = rand();
      if (shape < 0.3) {
        // Intraday round trip: buy and sell the same day.
        const q = 5 + Math.floor(rand() * 45);
        emit("buy", q, day);
        emit("sell", q, day);
      } else if (shape < 0.6) {
        // Delivery: buy, hold, sell later.
        const q = 5 + Math.floor(rand() * 45);
        emit("buy", q, day);
        day = addTradingDays(day, 2 + Math.floor(rand() * 10));
        emit("sell", q, day);
      } else if (shape < 0.85) {
        // Scale in over 2–4 tranches, sell out once.
        const n = 2 + Math.floor(rand() * 3);
        let total = 0;
        for (let i = 0; i < n; i++) {
          const q = 5 + Math.floor(rand() * 20);
          total += q;
          emit("buy", q, day);
          day = addTradingDays(day, 1 + Math.floor(rand() * 2));
        }
        day = addTradingDays(day, 1 + Math.floor(rand() * 5));
        emit("sell", total, day);
      } else {
        // Open position: buy, never sell in the window.
        emit("buy", 5 + Math.floor(rand() * 45), day);
      }
      day = addTradingDays(day, 1 + Math.floor(rand() * 4));
      base *= 0.98 + rand() * 0.04;
    }
    void held;
  }

  // Intraday flag from what actually landed on each scrip-day.
  const byDay = new Map<string, { b: boolean; s: boolean }>();
  for (const f of fills) {
    const k = `${f.symbol}|${f.date}`;
    const e = byDay.get(k) ?? { b: false, s: false };
    if (f.side === "buy") e.b = true; else e.s = true;
    byDay.set(k, e);
  }
  for (const f of fills) {
    const e = byDay.get(`${f.symbol}|${f.date}`)!;
    f.intraday = e.b && e.s;
  }

  // Chronological within the file, as every broker emits.
  fills.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.seq - b.seq);

  const totals = {
    buyQty: fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.qty, 0),
    sellQty: fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.qty, 0),
    buyValue: r2(fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.value, 0)),
    sellValue: r2(fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.value, 0)),
    days: new Set(fills.map((f) => f.date)).size,
  };
  return { seed: opts.seed, fills, symbols, totals };
}

/**
 * Statutory charges a broker would levy on one fill, at the rates the charges
 * engine also uses. These exist so writers can fill charge columns with numbers
 * that are internally consistent (GST really is 18% of brokerage + txn + SEBI),
 * which is what the product-signature code reads.
 */
export function charges(f: Fill) {
  const brokerage = r2(Math.min(20, f.value * 0.0003));
  const txn = r2(f.value * 0.0000322);
  const sebi = r2(f.value * 0.000001);
  const gst = r2((brokerage + txn + sebi) * 0.18);
  // STT: intraday 0.025% on the SELL only; delivery 0.1% on BOTH sides.
  const stt = f.intraday ? (f.side === "sell" ? Math.round(f.value * 0.00025) : 0) : Math.round(f.value * 0.001);
  // Stamp duty: on the BUY only; intraday 0.003%, delivery 0.015%.
  const stamp = f.side === "buy" ? Math.round(f.value * (f.intraday ? 0.00003 : 0.00015)) : 0;
  return { brokerage, txn, sebi, gst, stt, stamp, total: r2(brokerage + txn + sebi + gst + stt + stamp) };
}
