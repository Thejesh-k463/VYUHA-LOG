# Changelog

All notable changes to Vyuha are tracked here. Versions are kept in sync across
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the sidebar
footer via `npm run bump-version <version>`.

## v1.40.0
- **P0.1 paise migration FINISHED** — all 17 ₹-amount columns on `trades` (values, P&L,
  full charge breakdown, risk amount) now stored as INTEGER paise (migrations `0016`/`0017`,
  data converted ×100 in place and verified sum-identical on all 252 trades). A Drizzle
  `customType` exposes rupees at runtime, so no call sites changed. Per-unit price/level
  columns (avg prices, SL/TSL/target, strike, FMV) stay REAL by design.
- **Margin/SPAN tracking** (P1.2 final slice) — pure `lib/risk/margin.ts` (7 tests): long
  options = premium paid; short options = rate% × notional (spot ?? strike); futures/intraday
  = rate% × current value; MTF/delivery = rate% × invested. New editable `margin_config`
  rate table (migration `0018`, seeded approximations) + "Margin estimate" panel with
  per-bucket utilisation gauges on /risk.
- **IND-5 AIS / Form 26AS reconciliation** — pure `lib/analytics/ais.ts` (8 tests): tolerant
  paste parser (dividend / sale SFT-18 / purchase SFT-17 / interest; FY labels or dates;
  ₹-grouped amounts) + reconciliation of AIS dividends (per company+FY, alias-resolved,
  incl. TDS) and per-FY sale/purchase consideration (trades + IPO allotments/exits) with
  matched / MISMATCH / not-in-journal / not-in-AIS statuses, tolerance max(₹10, 0.5%).
  New /reports/ais screen (nav "AIS Reconcile"), stateless `/api/ais`.
- **P2.1 broker-API auto-import (Kite slice)** — first `ApiImportSource` implementation:
  `lib/import/api/kite.ts` (5 tests) pulls today's executions from Zerodha Kite Connect,
  aggregates per symbol+product (earliest-buy/latest-sell dates, MIS→intraday, CNC→delivery,
  MTF→mtf hints) and feeds the unchanged preview→commit pipeline. "Connect broker" card on
  /import; credentials in new `broker_connections` table (migration `0020`, plaintext local,
  stated in UI; Kite tokens expire daily).
- **Trade attachments** (P2.4 completion) — chart screenshots per trade: `trade_attachments`
  table (migration `0019`) + files under `<data-dir>/attachments/`, upload/gallery/delete in
  the journal dialog, streaming via `/api/trades/attachments` (images only, 8 MB cap,
  path-confined, audited). Backup screen notes attachments are outside the JSON backup.
- **MAE/MFE per trade** — pure `lib/analytics/mae-mfe.ts` (5 tests) computes max adverse /
  favorable excursion + %-of-MFE captured from `price_history` EOD bars for closed dated
  trades; card with coverage badges on /reports/edge.
- **Discipline breach tile** (P1.4 follow-up) — `breachReport()` in discipline.ts (4 tests)
  rolls up `rule_violations` saved at entry time; "Entry-time limit breaches" card on
  /reports/discipline showing per-rule counts and closed net P&L.
- **Zero-dependency installer** — `build-desktop.mjs` now bundles the building machine's
  Node runtime (+ LICENSE) into `desktop-dist/node/`; the Tauri shell prefers the bundled
  binary and falls back to system `node` for older bundles. Target machines no longer need
  Node installed (cargo check verified; rebuild the installer to ship it).

## v1.10.0
- Option Greeks: Black-Scholes delta/gamma/theta/vega per open option position + a
  portfolio aggregator (`lib/analytics/greeks.ts`), scaled by quantity and signed for
  direction (short flips gamma/vega negative, theta positive). New `trades.implied_vol`
  column, settable per position via the risk-edit dialog; falls back to a flat 20%
  estimate when unset. New "Option Greeks" panel on Portfolio Risk.

## v1.9.0
- F&O trade entry upgrade: an Equity/F&O mode toggle in the manual trade form —
  Underlying, Option/Future, Strike, CE/PE, Direction (Buy/Sell), Expiry with a live
  DTE badge, Lot size, Lots, Entry/Exit premium, Strategy.
- Short (sell-to-open) position support fixed across the app: `isOpen` detection,
  the risk/exposure engine, the close/cover flow, and the pre-trade risk-edit routes
  were long-only; a written CE/PE was previously invisible to portfolio risk.
- Real sector data (via an external market-data lookup) populated for held positions,
  correcting earlier manual-entry mistakes in the instruments master.

## v1.8.0
- P1.3 market-data foundation: `instruments` security master (symbol/sector/ISIN/lot
  size) and `price_history` (EOD OHLC, built automatically from bhavcopy imports).
- Sector concentration panel on Portfolio Risk (HHI, top-sector %, classified %).

## v1.7.0
- P1.1 finished: time-weighted return (TWR) and benchmark alpha/beta vs an index
  (NIFTY), completing the performance analytics suite alongside the existing
  Sharpe/Sortino/Calmar/XIRR.
- P1.4 pre-trade limits engine: per-trade risk cap, daily-loss stop, max-open,
  max-trades/day, and concentration checks — live pass/warn/block before saving a
  trade, plus a what-if panel on Portfolio Risk.

## v1.6.0
- Version-sync-only bump (no feature).

## v1.5.0 and earlier
- Foundational build: money-as-paise core, cash/fund-flow ledger, append-only audit
  log, backup/restore, quant performance analytics (Sharpe/Sortino/Calmar/XIRR),
  option strategy recognition + payoff diagrams, physical-settlement tracker,
  F&O ban/ASM surveillance, tax-loss harvesting, advance-tax planner, broker-cost
  comparison, bhavcopy auto-MTM, symbol-alias map, and the trade calculator.
  See `docs/INSTITUTIONAL_GRADE_ROADMAP.md` for full detail on each.
