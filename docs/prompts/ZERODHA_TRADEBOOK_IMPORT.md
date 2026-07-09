# Build Prompt — Zerodha Tradebook Import (F&O-aware) Enhancement

**Paste this whole file as the opening message of a fresh Vyuha coding session.** It is
self-contained: it states what already exists, the exact gaps, the schema, the calculations, and
the acceptance criteria. Follow Vyuha's conventions (pure module → tests → wire; route-handler +
`fetch` + `router.refresh()`, never server actions).

---

## Context: what ALREADY exists (do not rebuild)

A Zerodha importer already ships at **`lib/import/parsers/zerodha.ts`** and is wired into the
import pipeline (`lib/import/detect.ts` → `app/import/page.tsx` → `components/import/import-client.tsx`
→ `lib/import/commit.ts`). It handles **two** Zerodha formats today:

1. **Tradebook** (granular, one row per execution) — detected by a `trade type` + `order id`
   header. Rows are aggregated per `tradingsymbol + product` into round-trips.
2. **Console P&L** (already aggregated) — mapped directly.

Both emit `NormalizedTrade[]` (shape in `lib/engine/types.ts`; see the parser for the fields).
The downstream pipeline already does: **classify segment → recompute charges from `charge_config`
→ dedup → insert**. `ParsedFile` / `ParseContext` are in `lib/import/types.ts`.

## The gaps to close (this task)

The current tradebook path has four concrete problems — all in `lib/import/parsers/zerodha.ts`
unless noted:

1. **F&O tradingsymbols are not parsed.** Zerodha F&O symbols like `NIFTY26JUN24500CE`,
   `BANKNIFTY2560549000PE`, `RELIANCE26JUN3000CE`, `NIFTY26JUNFUT` are passed through as opaque
   strings. The classifier then treats unrecognised names as **equity**, so F&O imports land
   mis-tagged (no segment / strike / expiry / CE-PE / lot size). This is the headline fix.
2. **Per-execution dates are collapsed.** The aggregator keeps only the *first* row's date for the
   whole group (`date: cDate >= 0 ? r[cDate] || null : null`), so `buyDate`/`sellDate` are wrong
   when legs executed on different days. Track the **earliest buy execution** and **latest sell
   execution** separately.
3. **No charge capture from the tradebook.** Zerodha tradebooks don't carry charges; the pipeline
   recomputes from `charge_config`, which is correct — **but** confirm F&O charges recompute
   correctly once the segment is tagged (STT on sell premium for options, etc.). No change may be
   needed here beyond #1 making the segment correct; verify.
4. **Dead code:** line ~148 computes `const gross = …` that is unused (ESLint warns). Remove or use it.

## Zerodha tradebook CSV — expected schema

Zerodha Console → Reports → **Tradebook** → download CSV. Columns (verify against a REAL export —
Zerodha changes headers; the parser already fuzzy-matches via `norm()` + `colFinder`):

```
symbol, isin, trade_date, exchange, segment, series, trade_type, auction,
quantity, price, trade_id, order_id, order_execution_time
```

- `trade_type` = `buy` | `sell`
- `exchange`/`segment` → NSE/BSE/MCX, and NFO/BFO/CDS for derivatives (`exchangeFrom()` already maps these)
- For F&O, the **instrument identity lives in the symbol string**, not separate columns — hence #1.
- `order_execution_time` is a timestamp; `trade_date` is the date. Prefer `trade_date`, fall back
  to the date part of `order_execution_time`.

> ⚠️ You MUST obtain one real Zerodha F&O tradebook sample before finalising the symbol grammar —
> the exact digit layout of expiry (weekly vs monthly) and strike varies. Ask the user to paste 3–5
> real F&O rows (they can redact quantities). Do not ship the grammar untested against real data.

## Zerodha F&O symbol grammar (to implement — verify against the sample)

Zerodha encodes F&O in the tradingsymbol. Typical patterns:

| Example | Meaning |
|---|---|
| `NIFTY26JUNFUT` | Index future, NIFTY, Jun-2026 monthly |
| `NIFTY26JUN24500CE` | Index option, monthly, strike 24500, Call |
| `NIFTY2560924500PE` | Index option, **weekly** (yy m dd = 26/… encoded), strike 24500, Put |
| `RELIANCE26JUN3000CE` | Stock option, monthly, strike 3000, Call |
| `CRUDEOIL26JUL5900CE` | Commodity option (MCX) |

Implement a pure parser, e.g. `lib/import/zerodha-symbol.ts`:

```ts
export interface ParsedFnoSymbol {
  underlying: string;          // "NIFTY", "RELIANCE"
  segment: "index_option" | "stock_option" | "commodity_option"
         | "future" | "commodity_future";
  optType: "CE" | "PE" | null; // null for futures
  strike: number | null;       // null for futures
  expiry: string;              // ISO yyyy-mm-dd
  isWeekly: boolean;
}
export function parseZerodhaFnoSymbol(sym: string, exchange: string): ParsedFnoSymbol | null;
```

Rules of thumb (confirm with the sample):
- Suffix `FUT` → future; suffix `CE`/`PE` → option (strike = the number immediately before it).
- Monthly = `YYMMM` (e.g. `26JUN`); weekly = `YYMDD` numeric (e.g. `26609`). Detect which by whether
  the 3 chars after the year are alphabetic (monthly month) or numeric (weekly).
- Index underlyings (`NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `SENSEX`, `BANKEX`) →
  `index_option`/`future`; MCX exchange → `commodity_*`; else `stock_option`.
- Resolve the month/expiry to the **actual expiry date** (last Thursday for monthly index/stock
  until SEBI's revised expiry calendar; weekly = the encoded date). Keep a small, documented
  helper; note the expiry-day rule may need a lookup table.

## Wiring the parsed F&O fields through

`NormalizedTrade` currently has **no** structured F&O fields. Two options — prefer (A):

**(A) Extend the normalized shape (clean).** Add optional fields to `NormalizedTrade`:
`underlying?`, `segmentHint?`, `optType?`, `strike?`, `expiry?`, `lotSize?`. Populate them in the
Zerodha tradebook path when `parseZerodhaFnoSymbol` returns non-null. Then extend
`lib/import/commit.ts` to write `segment`, `optionType` (`strike`, `expiry`, `lotSize`,
`instrumentType: "option"|"future"`) from these hints — mirroring what the manual F&O form already
persists (see `app/trades/actions.ts` / `commit.ts` `ManualJournalFields`). Lot size: look up from
the **instruments master** (`lib/queries/instruments.ts`) by underlying; fall back to null.

**(B) Minimal.** Only fix segment classification so F&O stops being tagged equity, and leave
strike/expiry to manual re-tagging. Faster but leaves the "lots/DTE" columns empty.

Keep the existing Console-P&L path unchanged except for reusing the symbol parser if a Console row
is a derivative.

## Calculations to get right

1. **Round-trip aggregation (already present, keep):** per `tradingsymbol + product`, sum
   `buyQty·price` and `sellQty·price`; `avgBuyPrice = buyVal/buyQty`, etc. **Fix dates** per gap #2.
2. **Open vs closed:** reuse the repo convention — `isOpen = buyQty !== sellQty`; a short-open F&O
   leg has `sellQty > buyQty` (see `lib/import/commit.ts`). Do **not** reintroduce `buyQty > sellQty`.
3. **Charges:** let the pipeline recompute from `charge_config` (do not trust broker charges here —
   tradebook has none). After #1 tags the segment, verify option STT (on sell-side premium),
   futures STT, exchange txn, GST, stamp, SEBI all recompute. Add a reconciliation warning if the
   recomputed total deviates > a small tolerance from any user-provided Console figure.
4. **Direction-aware entry price** for risk: entry = `avgSellPrice` for a short-open leg, else
   `avgBuyPrice` (mirror `commit.ts`).

## Tests (Vitest, pure modules only — no DB in unit tests)

Create `tests/zerodha-symbol.test.ts`:
- Parses monthly index option, weekly index option, stock option, index future, commodity option.
- Correct `segment`, `optType`, `strike`, `isWeekly`, and a sane `expiry`.
- Returns `null` for a plain equity symbol (`RELIANCE`, `INFY`).
Extend `tests/` for the tradebook aggregation date fix (earliest buy / latest sell) with a small
synthetic matrix (you can unit-test `parseZerodha` by passing `ctx.text`).

## Acceptance criteria

- [ ] A real Zerodha F&O tradebook imports with correct **segment, strike, expiry, CE/PE, lots**
      (verified against a real sample the user pastes).
- [ ] Multi-day legs get correct `buyDate` (earliest buy) and `sellDate` (latest sell).
- [ ] Plain equity/intraday/MTF tradebooks still import exactly as before (no regression).
- [ ] Charges recompute correctly for the newly-tagged F&O segments.
- [ ] Dead `gross` var removed; `npx tsc --noEmit`, `npx vitest run`, and `npx eslint .` are clean.
- [ ] Roadmap doc updated; the "verify F&O classification" warning is removed or narrowed.

## Guardrails

- Pure module first (`lib/import/zerodha-symbol.ts`), fully unit-tested, before touching the parser.
- Verify against **real** Zerodha data before claiming done — ask the user for a sample.
- Preserve the existing detect scores and Console-P&L behaviour.
- Follow `AGENTS.md`: read the relevant `node_modules/next/dist/docs/` guide before any Next.js code.
