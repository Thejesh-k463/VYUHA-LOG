// OpenAlgo ApiImportSource — ONE adapter, SEVEN of Vyuha's eight brokers.
//
// WHY THIS EXISTS
// ---------------
// kite.ts, dhan.ts and angelone.ts are three hand-written pullers, each with
// its own auth ritual (Kite's daily token, Dhan's 24h token, Angel's TOTP
// login) and each covering exactly one broker. OpenAlgo (https://openalgo.in,
// AGPL-3.0, self-hosted) already normalises 35 Indian brokers behind ONE REST
// surface, and the user runs it on their own machine. So this file replaces
// "write a puller per broker" with "write a puller per PROTOCOL": Vyuha talks
// to 127.0.0.1:5000, OpenAlgo talks to the broker, and groww / upstox / paytm
// / kotakneo gain API auto-import for the first time with no code of their own.
//
// WHAT VYUHA NEVER SEES: the broker credential. OpenAlgo holds it. Vyuha
// stores an OpenAlgo API key and a host URL — both revocable from OpenAlgo's
// own UI without touching the broker account. That is strictly less credential
// exposure than the three native pullers, which hold live broker tokens.
//
// ── The two traps, both coded around ────────────────────────────────────────
//
// 1. `/tradebook` IS TODAY-ONLY, like Kite's /trades. Historical tradebooks
//    stay on the file path. This is the daily auto-pull, nothing more.
//
// 2. `quantity` CANNOT BE TRUSTED. OpenAlgo's own documented sample returns
//    `quantity: 0.0` with `average_price: 1180.1` and `trade_value: 1180.1` —
//    a quantity of zero on an executed trade, with the real size recoverable
//    only as trade_value ÷ average_price. The field is broker-plugin
//    dependent. A zero quantity silently imports a zero-size trade whose
//    charges and P&L are both zero and which no reconciliation would flag, so
//    the quantity is REPAIRED from trade_value when it arrives non-positive,
//    and every repair is counted and surfaced as a warning. Rows that cannot
//    be repaired are REFUSED, not guessed — same posture as the Angel One
//    puller's `refused`.
//
// Charges are not in the response and are not invented: the classify → charges
// → dedup → commit pipeline computes statutory charges as it does for every
// other source, and brokerage stays excluded from the accuracy claim.

import type { NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Broker, Exchange } from "@/lib/domain/constants";
import { COMMODITY_UNDERLYINGS, INDEX_UNDERLYINGS, BSE_INDEX_UNDERLYINGS } from "@/lib/domain/constants";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";

/** One executed trade from OpenAlgo POST /api/v1/tradebook. */
export interface OpenAlgoTradeRow {
  action: string; // BUY | SELL
  symbol: string;
  exchange: string; // NSE | BSE | NFO | BFO | CDS | BCD | MCX
  orderid?: string;
  product: string; // CNC | MIS | NRML | MTF
  quantity: number | string;
  average_price: number | string;
  /** Docs show TIME ONLY ("13:58:03"), but the Dhan plugin returns a full
   *  datetime ("2026-08-26 12:33:07" — verified against a real instance,
   *  2026-08-26). Either shape parses; the DATE is always the pull date. */
  timestamp?: string | null;
  trade_value?: number | string;
}

export interface OpenAlgoCredentials {
  /** OpenAlgo API key (Settings → API Key in the OpenAlgo UI). */
  apiKey: string;
  /** Base URL of the user's OpenAlgo instance, e.g. http://127.0.0.1:5000 */
  host: string;
  /** Which broker the OpenAlgo instance is connected to — the user knows,
   *  because they configured it. Drives per-broker brokerage in the charges
   *  engine, so it is required rather than guessed from the payload. */
  broker: Broker;
}

/**
 * Which of Vyuha's EIGHT brokers can sit behind an OpenAlgo instance.
 *
 * This table is the whole point of the adapter. The three native pullers cover
 * zerodha / dhan / angelone; this one covers SEVEN of the eight through the
 * same code path, so groww, upstox, paytm and kotakneo gain API auto-import
 * for the first time without a line of broker-specific code.
 *
 * `broker` is VYUHA's id and it is the load-bearing field: it selects the
 * charge profile, so it must be the real broker and never a near neighbour.
 * The adapter NEVER sends an OpenAlgo broker id anywhere — an OpenAlgo
 * instance is already bound to one broker account before Vyuha calls it.
 * `label` is how OpenAlgo names it in their own broker list, shown so the user
 * can match the dropdown to what they actually configured.
 *
 * `supported: false` is a statement about OpenAlgo's plugin list, not a limit
 * of this file. Flipping one flag is the entire cost of adding a broker the
 * day OpenAlgo ships its plugin.
 */
export interface OpenAlgoBrokerSupport {
  /** Vyuha's broker id — drives the charge profile. */
  broker: Broker;
  /** OpenAlgo's own name for it, so the user can match their setup. */
  label: string;
  supported: boolean;
  /** Why it is unsupported, or what still needs confirming. */
  note?: string;
}

export const OPENALGO_BROKERS: readonly OpenAlgoBrokerSupport[] = [
  { broker: "zerodha", label: "Zerodha", supported: true },
  { broker: "dhan", label: "Dhan", supported: true },
  { broker: "angelone", label: "AngelOne", supported: true },
  { broker: "upstox", label: "Upstox", supported: true },
  { broker: "groww", label: "Groww", supported: true },
  { broker: "paytm", label: "Paytm", supported: true },
  {
    broker: "kotakneo",
    label: "Kotak Securities",
    supported: true,
    note:
      "OpenAlgo lists this as 'Kotak Securities'. Confirm against a real pull that it is the Neo API and not the legacy one before trusting the product column.",
  },
  {
    broker: "sahi",
    label: "not available",
    supported: false,
    note:
      "OpenAlgo publishes no Sahi plugin. Sahi trades stay on the file-import path; nothing here can reach them.",
  },
] as const;

/** The dropdown the UI should render. Supported entries only. */
export function openAlgoBrokerOptions(): OpenAlgoBrokerSupport[] {
  return OPENALGO_BROKERS.filter((b) => b.supported);
}

// ── Multiple OpenAlgo instances ─────────────────────────────────────────────
//
// One OpenAlgo instance fronts ONE broker login, so a user with accounts at
// two brokers runs two instances on two ports (verified live 2026-08-26:
// Upstox on :5000 and Dhan on :5051 on the same machine). Each instance is a
// separate broker_connections row whose `broker` column is `openalgo:<broker>`
// — the underlying broker is the identity, because that is what selects the
// charge profile and what the user thinks of the connection as. One instance
// per underlying broker per account; the legacy id `openalgo` (single-instance
// era) is migrated to this form on read.

export const OPENALGO_ID_PREFIX = "openalgo";

/** `dhan` → `openalgo:dhan` — the broker_connections identity of an instance. */
export function openAlgoConnectionId(underlying: Broker): string {
  return `${OPENALGO_ID_PREFIX}:${underlying}`;
}

/** Anything stored or posted as an OpenAlgo connection — legacy `openalgo` or
 *  `openalgo:<broker>`. */
export function isOpenAlgoConnectionId(id: string): boolean {
  return id === OPENALGO_ID_PREFIX || id.startsWith(`${OPENALGO_ID_PREFIX}:`);
}

/** The underlying broker inside `openalgo:<broker>`, or null for the legacy
 *  bare `openalgo` (whose underlying lives only in its auth blob). */
export function openAlgoUnderlyingOf(id: string): string | null {
  if (!id.startsWith(`${OPENALGO_ID_PREFIX}:`)) return null;
  const rest = id.slice(OPENALGO_ID_PREFIX.length + 1);
  return rest || null;
}

/**
 * Refuse an unsupported broker AT CONSTRUCTION, with the reason.
 *
 * A pull that silently succeeded against the wrong charge profile would
 * produce numbers that look right and are not — precisely the failure the
 * 0.69% accuracy claim exists to rule out.
 */
export function assertOpenAlgoBroker(broker: Broker): void {
  const entry = OPENALGO_BROKERS.find((b) => b.broker === broker);
  if (!entry) {
    throw new Error(
      `${broker} is not a broker Vyuha knows. Expected one of: ${OPENALGO_BROKERS.map((b) => b.broker).join(", ")}.`,
    );
  }
  if (!entry.supported) {
    throw new Error(`OpenAlgo cannot connect to ${broker}. ${entry.note ?? ""}`.trim());
  }
}

const num = (v: unknown): number => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function productHintOf(product: string): ProductHint {
  const p = String(product ?? "").toUpperCase();
  if (p === "MIS") return "intraday";
  if (p === "CNC") return "delivery";
  if (p === "MTF") return "mtf";
  return null; // NRML (F&O / commodity) — the classifier decides from the symbol
}

function exchangeOf(exchange: string): Exchange | null {
  const e = String(exchange ?? "").toUpperCase();
  if (e === "NSE" || e === "NFO" || e === "CDS" || e === "NSE_INDEX") return "NSE";
  if (e === "BSE" || e === "BFO" || e === "BCD" || e === "BSE_INDEX") return "BSE";
  if (e === "MCX") return "MCX";
  return null;
}

/** "13:58:03" or "2026-08-26 12:33:07" → "13:58" / "12:33". Anything else →
 *  null, never a fabricated session. The datetime shape is what the Dhan
 *  plugin actually sends, against the docs' time-only sample. */
function hhmm(timestamp: string | null | undefined): string | null {
  const m = /(?:^|\s)(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(timestamp ?? "").trim());
  if (!m) return null;
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

const MON: Record<string, string> = {
  JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr", MAY: "May", JUN: "Jun",
  JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec",
};

const INDEX_SET = new Set<string>(INDEX_UNDERLYINGS);
const BSE_INDEX_SET = new Set<string>(BSE_INDEX_UNDERLYINGS);
const COMMODITY_SET = new Set<string>(COMMODITY_UNDERLYINGS);

/** A derivative exchange as OpenAlgo names it. Currency (CDS/BCD) is
 *  deliberately excluded — Vyuha has no currency segment vocabulary. */
function isDerivativeExchange(exchange: string): boolean {
  const e = String(exchange ?? "").toUpperCase();
  return e === "NFO" || e === "BFO" || e === "MCX";
}

/**
 * Canonicalise an OpenAlgo derivative symbol for the classifier.
 *
 * OpenAlgo's documented symbology is compact — `SENSEX27AUG2677400PE`,
 * `NIFTY29SEP26FUT` — which `parseInstrumentName` does not read, so every F&O
 * execution used to fall through to the equity branch and be charged equity
 * STT (the same defect the Dhan API adapter had; both found on the first real
 * F&O pull, 2026-08-26). The derivative FACT comes from the stated exchange
 * (NFO/BFO/MCX); only the contract details are parsed from the symbol, and a
 * symbol that will not parse keeps its raw name and is REPORTED, not guessed.
 *
 * Returns the canonical `OPT`/`FUT` name, or null for a non-derivative
 * exchange or an unparseable symbol.
 */
export function canonicalOpenAlgoSymbol(symbol: string, exchange: string): string | null {
  if (!isDerivativeExchange(exchange)) return null;
  const s = String(symbol ?? "").trim().toUpperCase();

  const opt = /^([A-Z][A-Z0-9&-]*?)(\d{2})([A-Z]{3})(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/.exec(s);
  if (opt) {
    const mon = MON[opt[3]!];
    if (mon) return `OPT ${opt[1]} ${opt[2]} ${mon} 20${opt[4]} ${opt[5]} ${opt[6]}`;
  }
  const fut = /^([A-Z][A-Z0-9&-]*?)(\d{2})([A-Z]{3})(\d{2})FUT$/.exec(s);
  if (fut) {
    const mon = MON[fut[3]!];
    if (mon) return `FUT ${fut[1]} ${fut[2]} ${mon} 20${fut[4]}`;
  }
  return null;
}

/**
 * Detect a symbol whose underlying contradicts its stated exchange — a silver
 * option on NFO, an index option on MCX. A real instance mis-symbolled a PIIND
 * call as `SILVERM23NOV26236750PE` on NFO (2026-08-26). Such a row is REFUSED
 * with a warning naming it: its identity is corrupt, so there is no honest
 * charge profile for it (the engine proved this — commodity_option on NSE has
 * no charge_config row and never will), and a trade booked under a wrong
 * identity is worse than an absent trade the warning tells the user to import
 * from the broker's own record.
 */
export function underlyingExchangeConflict(underlying: string, exchange: string): string | null {
  const e = String(exchange ?? "").toUpperCase();
  if (COMMODITY_SET.has(underlying) && (e === "NFO" || e === "BFO")) {
    return `${underlying} is a commodity underlying but arrived on ${e}`;
  }
  if ((INDEX_SET.has(underlying) || BSE_INDEX_SET.has(underlying)) && e === "MCX") {
    return `${underlying} is an index underlying but arrived on MCX`;
  }
  return null;
}

/**
 * Recover the executed quantity.
 *
 * Returns the quantity, or `null` when the row carries no recoverable size.
 * `trade_value ÷ average_price` is the fallback because OpenAlgo's own sample
 * response ships quantity 0 on a real fill. A near-integer result is snapped
 * (float division of ₹ amounts does not land exactly); a result that is not
 * near an integer is returned as-is so a genuinely fractional broker figure is
 * not silently rounded into a different trade.
 */
export function recoverQuantity(row: OpenAlgoTradeRow): { qty: number; repaired: boolean } | null {
  const stated = num(row.quantity);
  if (stated > 0) return { qty: stated, repaired: false };

  const value = num(row.trade_value);
  const price = num(row.average_price);
  if (!(value > 0) || !(price > 0)) return null;

  const derived = value / price;
  if (!(derived > 0) || !Number.isFinite(derived)) return null;
  const snapped = Math.round(derived);
  const qty = Math.abs(derived - snapped) < 0.01 && snapped > 0 ? snapped : derived;
  return { qty, repaired: true };
}

interface Agg {
  symbol: string;
  /** Canonical OPT/FUT name for a derivative, when the symbol parsed. */
  canonical: string | null;
  /** Identity is corrupt (underlying contradicts exchange) — never emitted. */
  suspect: boolean;
  /** Per-position caveats: unparseable F&O symbol, underlying/exchange conflict. */
  notes: string[];
  product: string;
  exchange: Exchange | null;
  buyQty: number;
  buyValue: number;
  sellQty: number;
  sellValue: number;
  entryTime: string | null;
  exitTime: string | null;
}

export interface OpenAlgoNormalizeResult {
  trades: NormalizedTrade[];
  /** Rows whose quantity had to be derived from trade_value ÷ average_price. */
  repaired: number;
  /** Rows dropped because no size was recoverable at all. */
  refused: number;
  /** Position-level caveats worth showing before a commit: an F&O symbol that
   *  would not parse, or an underlying that contradicts its exchange. */
  notes: string[];
}

/**
 * Aggregate executions into one NormalizedTrade per symbol+product.
 *
 * `tradeDate` is supplied by the caller (the pull date) because the endpoint
 * returns a TIME with no date — exactly the shape the Angel One puller already
 * handles. Both legs carry that same date, which is correct for a today-only
 * endpoint and is why this is a daily pull rather than a backfill.
 */
export function normalizeOpenAlgoTrades(
  rows: OpenAlgoTradeRow[],
  broker: Broker,
  tradeDate: string,
): OpenAlgoNormalizeResult {
  const groups = new Map<string, Agg>();
  let repaired = 0;
  let refused = 0;

  for (const row of rows ?? []) {
    if (!row || !row.symbol) {
      refused += 1;
      continue;
    }
    const size = recoverQuantity(row);
    if (!size) {
      refused += 1;
      continue;
    }
    if (size.repaired) repaired += 1;

    const price = num(row.average_price);
    if (!(price > 0)) {
      refused += 1;
      continue;
    }

    const key = `${row.symbol}|${String(row.product ?? "").toUpperCase()}`;
    let g = groups.get(key);
    if (!g) {
      const canonical = canonicalOpenAlgoSymbol(row.symbol, String(row.exchange ?? ""));
      const notes: string[] = [];
      let suspect = false;
      if (!canonical && isDerivativeExchange(String(row.exchange ?? ""))) {
        notes.push(
          `${row.symbol} arrived on ${String(row.exchange).toUpperCase()} (a derivative exchange) but does not parse as an option or future — imported with its raw name; check its segment and charges.`,
        );
      }
      if (canonical) {
        const conflict = underlyingExchangeConflict(canonical.split(" ")[1]!, String(row.exchange ?? ""));
        if (conflict) {
          suspect = true;
          notes.push(
            `REFUSED — suspect symbol ${row.symbol}: ${conflict}. OpenAlgo has mislabelled a real trade this way before, and a trade booked under a corrupt identity cannot be charged honestly. Import this trade from the broker's own API or file instead.`,
          );
        }
      }
      g = {
        symbol: row.symbol,
        canonical,
        suspect,
        notes,
        product: String(row.product ?? "").toUpperCase(),
        exchange: exchangeOf(row.exchange),
        buyQty: 0,
        buyValue: 0,
        sellQty: 0,
        sellValue: 0,
        entryTime: null,
        exitTime: null,
      } satisfies Agg;
    }

    const value = size.qty * price;
    const at = hhmm(row.timestamp);
    if (String(row.action ?? "").toUpperCase() === "BUY") {
      g.buyQty += size.qty;
      g.buyValue += value;
      if (at && (g.entryTime == null || at < g.entryTime)) g.entryTime = at;
    } else {
      g.sellQty += size.qty;
      g.sellValue += value;
      if (at && (g.exitTime == null || at > g.exitTime)) g.exitTime = at;
    }
    groups.set(key, g);
  }

  const trades = [...groups.values()].filter((g) => !g.suspect).map((g): NormalizedTrade => {
    const closedQty = Math.min(g.buyQty, g.sellQty);
    const gross =
      closedQty > 0 && g.buyQty > 0 && g.sellQty > 0
        ? r2((g.sellValue / g.sellQty - g.buyValue / g.buyQty) * closedQty)
        : 0;
    return {
      broker,
      tradingsymbol: g.canonical ?? g.symbol,
      isin: null,
      buyQty: g.buyQty,
      avgBuyPrice: g.buyQty > 0 ? r2(g.buyValue / g.buyQty) : 0,
      buyValue: r2(g.buyValue),
      sellQty: g.sellQty,
      avgSellPrice: g.sellQty > 0 ? r2(g.sellValue / g.sellQty) : 0,
      sellValue: r2(g.sellValue),
      closingPrice: null,
      grossPnl: gross,
      unrealisedPnl: 0,
      buyDate: g.buyQty > 0 ? tradeDate : null,
      sellDate: g.sellQty > 0 ? tradeDate : null,
      productHint: productHintOf(g.product),
      exchangeHint: g.exchange,
      sourceFile: "openalgo-api",
      entryTime: g.entryTime,
      exitTime: g.exitTime,
      importNotes: g.notes.length ? g.notes : null,
    };
  });

  const notes = [...groups.values()].flatMap((g) => g.notes);
  return { trades, repaired, refused, notes };
}

/** Normalise a user-typed host into a base URL, or throw with a usable message. */
export function normalizeHost(host: string): string {
  const raw = String(host ?? "").trim();
  if (!raw) throw new Error("OpenAlgo host is required, e.g. http://127.0.0.1:5000");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid OpenAlgo host: ${raw}. Expected something like http://127.0.0.1:5000`);
  }
  return `${url.protocol}//${url.host}`;
}

async function openAlgoPost<T>(
  creds: OpenAlgoCredentials,
  path: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const base = normalizeHost(creds.host);
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: creds.apiKey, ...extra }),
      cache: "no-store",
    });
  } catch (e) {
    // The single most common failure by far: OpenAlgo simply is not running.
    throw new Error(
      `Cannot reach OpenAlgo at ${base} (${(e as Error).message}). Start your OpenAlgo instance and confirm the host in Settings.`,
    );
  }

  const json = (await res.json().catch(() => null)) as
    | { status?: string; data?: unknown; message?: string }
    | null;

  if (res.status === 429) {
    throw new Error("OpenAlgo rate limit hit (429). The default is 50 requests/second — retry in a moment.");
  }
  if (!res.ok || !json || json.status !== "success") {
    const why = json?.message ?? `HTTP ${res.status}`;
    const hint =
      res.status === 403 || res.status === 401
        ? " (wrong API key? Copy it again from OpenAlgo → API Key.)"
        : "";
    throw new Error(`OpenAlgo /${path}: ${why}${hint}`);
  }
  return json.data as T;
}

/** POST /api/v1/tradebook — today's executed trades. */
export async function fetchOpenAlgoTradebook(creds: OpenAlgoCredentials): Promise<OpenAlgoTradeRow[]> {
  const data = await openAlgoPost<OpenAlgoTradeRow[]>(creds, "tradebook");
  return Array.isArray(data) ? data : [];
}

/**
 * Cheap credential check for the save step — proves the key AND the host in
 * one call, so a typo is caught at save rather than at tomorrow's pull.
 */
export async function verifyOpenAlgoConnection(creds: OpenAlgoCredentials): Promise<true> {
  assertOpenAlgoBroker(creds.broker);
  await openAlgoPost<unknown>(creds, "funds");
  return true;
}

export function openAlgoImportSource(creds: OpenAlgoCredentials): ApiImportSource {
  assertOpenAlgoBroker(creds.broker);
  return {
    id: "openalgo-api",
    label: "OpenAlgo (today's executions)",
    broker: creds.broker,
    kind: "api",
    async fetchTrades(opts: { from?: string; to?: string } = {}) {
      const date = opts.to ?? opts.from ?? new Date().toISOString().slice(0, 10);
      return normalizeOpenAlgoTrades(await fetchOpenAlgoTradebook(creds), creds.broker, date).trades;
    },
  };
}

/** Wrap an OpenAlgo pull in the ParsedFile shape preview/commit expects. */
export function toParsedFile(broker: Broker, result: OpenAlgoNormalizeResult): ParsedFile {
  const warnings: string[] = [];
  if (result.trades.length === 0) {
    warnings.push(
      "OpenAlgo returned no executions for today — /tradebook only covers the current trading day. Use the file import for older trades.",
    );
  }
  if (result.repaired > 0) {
    warnings.push(
      `${result.repaired} row${result.repaired === 1 ? "" : "s"} arrived with quantity 0 and had the size recovered from trade value ÷ average price. Check the sizes against your broker's contract note before committing.`,
    );
  }
  if (result.refused > 0) {
    warnings.push(
      `${result.refused} row${result.refused === 1 ? " was" : "s were"} skipped: no usable quantity or price. Nothing was guessed.`,
    );
  }
  warnings.push(...result.notes);
  return {
    sourceId: "openalgo-api",
    broker,
    format: "api",
    trades: result.trades,
    warnings,
  };
}
