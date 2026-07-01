# Vyuha — Local Trade Journal (India)

[![CI](https://github.com/Thejesh-k463/VYUHA-LOG/actions/workflows/ci.yml/badge.svg)](https://github.com/Thejesh-k463/VYUHA-LOG/actions/workflows/ci.yml)

A single-user, **fully local, offline** trade journal + analytics cockpit for an
active Indian retail trader (Index/Stock options, Intraday equity, Equity
delivery, Equity MTF, MCX commodities) across **Dhan, Zerodha and Groww**.

No authentication, no cloud, no telemetry. All data lives in a local SQLite file
(`./data/vyuha.sqlite`).

> Built with Next.js (App Router) + TypeScript, Tailwind v4, Drizzle ORM over
> better-sqlite3, Recharts, TanStack Table. Ships as a Tauri desktop app.

## What's new

- **v1.3** — **IPO dashboard** (`/ipos`): record applications, allotment, listing &
  exit; P&L computed from applied→listing→exit with sell-charge estimate.
  **Capital compounding**: roll realised P&L (closed trades + exited IPOs) into the
  bucket capital on demand (double-count-safe via `pnl_rolled_in`); every risk %,
  allocation and target re-scales automatically. Plus manual capital edit.
- **v1.2** — **Portfolio Risk** cockpit (`/risk`): initial risk, open P&L, open
  risk @ SL, allocation, per-position trailing/original SL, target, R:R and a
  one-click **trail-to-breakeven**. Bulk MTM paste now also sets SL/TSL/target.
- **v1.1** — light theme, colorblind-safe colours, inline charge/risk editors.

---

## Quick start

```bash
cd vyuha
npm install
npm run setup     # = db:migrate + seed  (creates ./data/vyuha.sqlite)
npm run dev       # http://localhost:3000
```

That's it — open http://localhost:3000.

### All scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the app on localhost:3000 |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run db:generate` | Generate a Drizzle migration from `lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to `./data/vyuha.sqlite` |
| `npm run seed` | Seed `charge_config`, `risk_config`, `settings`, opening capital (idempotent) |
| `npm run setup` | `db:migrate` + `seed` in one go |
| `npm run db:studio` | Open Drizzle Studio to inspect the DB |
| `npm run test` | Run the Vitest unit suite (52 tests: engines, analytics, risk, imports, reports) |
| `npm run test:e2e` | Run the Playwright happy-path e2e (import Dhan CSV → dashboard) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run desktop:bundle` | Assemble `desktop-dist/` (standalone server + seeded template DB) |
| `npm run desktop:build` | Build the native desktop installer (Tauri) — needs Rust |
| `npm run desktop:icons` | Regenerate the app icon set from `src-tauri/icon-source.png` |

## Desktop app (Tauri)

Vyuha ships a **Tauri** desktop shell (`src-tauri/`). Because the app is a
full-stack Next.js server (server actions + `better-sqlite3`), it can't be a static
export — instead the desktop shell runs the Next **standalone** server as a Node
sidecar bound to `127.0.0.1`, then points the native WebView2 window at it.

```
src-tauri/                 # Rust shell: spawns the Node sidecar, opens the window
scripts/desktop-server.mjs # sidecar entry: seeds the app-data DB, starts the server
scripts/build-desktop.mjs  # assembles desktop-dist/ (standalone + seed template DB)
desktop-dist/              # bundled at build time as a Tauri resource ("server/")
```

**How it runs:** on launch the Rust shell spawns
`node desktop-server.mjs` with `VYUHA_DATA_DIR` set to the OS app-data dir
(e.g. `%APPDATA%/in.vyuha.tradejournal`). On first run the launcher copies the
bundled **seeded template** (`vyuha.seed.sqlite`, empty journal) there; subsequent
runs reuse it. The shell waits for the port, then loads the app; closing the window
stops the sidecar. Your data persists in app-data across reinstalls.

**Build the installer:**

```bash
# one-time prerequisites (Windows): Rust + WebView2 + MSVC C++ build tools
#   https://rustup.rs/   (WebView2 ships with Windows 11; MSVC via VS Build Tools)
npm run desktop:build
# → installer at src-tauri/target/release/bundle/
```

> Node.js must be installed on the target machine (the shell spawns the system
> `node`). For zero-dependency distribution, bundle a Node binary as a Tauri
> sidecar (`externalBin`) and point the launcher at it — left as a follow-up.

The entire runtime path (template seeding → standalone server → serving) is
verified under Node; only the final Rust compile requires the toolchain above.

## Where your data lives

- **Database:** `vyuha/data/vyuha.sqlite` (plus `-wal` / `-shm` sidecar files).
  This directory is git-ignored — it is never committed.
- To reset to a clean journal: stop the dev server, delete `vyuha/data/`, then
  run `npm run setup` again.

## Capital model (editable in Settings)

- **Total ₹17,00,000**, split into two buckets:
  - **Bucket A — EQUITY ₹13,00,000** — Equity Delivery + MTF.
  - **Bucket B — ACTIVE ₹4,00,000** — Index/Stock options + Intraday + Commodity.
- Go-live date defaults to **19 Jun 2026**; the journal starts **empty**.
- All risk math is computed against **bucket** capital, not total. An opening
  capital snapshot is stored per bucket on go-live and kept in sync when you edit
  capital in Settings.

## How rates & rules are configured

Nothing statutory is hard-coded. The charges engine reads only from the
`charge_config` table (keyed by **broker × segment × exchange**), seeded from the
FY2026-27 rates in the build brief §5. Risk limits live in `risk_config`
(global / per-bucket / per-segment), seeded from §6.

- **Settings → Risk rules / Charge rates** has inline editors for every
  `risk_config` rule and every `charge_config` rate row. You can also use Drizzle
  Studio (`npm run db:studio`) or edit `lib/db/seed-data.ts` and re-run `npm run seed`.
- Core Settings (capital, go-live, theme, FY, colorblind-safe colours, default
  order counts) are editable on the same page.

> Note on options STT: the brief's FY2026-27 rate (0.15% of premium on sell) runs
> higher than the rate in force when the sample files were generated — visible as a
> ~5% delta in Dhan reconciliation. Change `sttPct` for the option segments in the
> charge-rate editor (e.g. to 0.001) if you want to match an earlier period.

## How to import

Go to **Import**, drop a broker file (Dhan P&L CSV, Groww XLSX, Zerodha
CSV/XLSX, PDF). The app auto-detects the broker/format, shows a preview with a
charge **reconciliation panel** (computed vs broker-reported), and commits on
confirm. Re-importing the same file is **de-duplicated** (0 dupes). Or add trades
by hand in **Trades → Add trade** (auto-classified, live charge preview).

After import, re-tag any rows (MTF / intraday / segment) in **Trades** — those
overrides persist and re-apply automatically on the next re-import.

## Extensibility seams (for v1-out-of-scope features)

These interfaces let the out-of-scope features drop in later without touching the
pipeline:

- **`ImportSource`** (`lib/import/types.ts`) — file parsers implement the `"file"`
  variant; a future **broker-API puller** implements the `"api"` variant
  (`fetchTrades()`), and the rest of the pipeline (classify → charges → dedup → DB)
  is unchanged. New file parsers register in `lib/import/detect.ts`.
- **`PriceSource`** (`lib/seams/price-source.ts`) — v1 ships only manual/EOD MTM
  (bulk paste in the Position Trackers). A live/EOD feed implements `getQuotes()`
  and the trackers consume it unchanged.
- **MTF interest accrual** (`lib/jobs/mtf-accrual.ts`) runs on app open (Equity
  Tracker render) and recomputes accrued interest for open MTF positions; it is
  idempotent.

## Project layout

```
vyuha/
  app/                     # App Router pages (dashboard, settings, trackers, reports…)
  components/
    ui/                    # shadcn-style primitives (button, card, input…)
    layout/                # sidebar, page header, nav config
  lib/
    db/                    # schema.ts, client, migrate, seed, seed-data (rates)
    domain/                # constants (brokers, segments, underlyings)
    engine/                # pure classification + charges engines (+ rates)
    import/                # parsers, detect, dedup, commit pipeline
    analytics/             # metrics, positions, charges-report, discipline, tax
    risk/                  # position-size / lot / daily-stop / MTF calculators
    jobs/                  # MTF interest accrual
    seams/                 # PriceSource interface
    queries/               # server-only DB read helpers
    format.ts, utils.ts    # INR formatting, cn()
  drizzle/                 # generated SQL migrations
  tests/, e2e/             # Vitest unit tests + Playwright e2e
  data/                    # local SQLite (git-ignored)
```

## Build phases

1. **Foundation** ✅ — scaffold, theme, schema + migrations + seed, editable settings.
2. **Engines** ✅ — classification + charges engines, fully unit-tested; reconcile to sample files.
3. **Imports + manual entry** ✅ — Dhan/Groww/Zerodha/PDF parsers, dedup, overrides.
4. **Trackers + Dashboard** ✅ — position & target trackers, dashboard KPIs/charts/heatmap, exports.
5. **Upgrades + scaffolds** ✅ — charges/MTF-leak report, edge analytics, discipline scorecard, tax scaffold, MTF accrual, rate/risk editors, PriceSource/ImportSource seams.

## Known limitations

- Broker **P&L files lack segment / MTF flag / per-trade dates** — equity rows
  default to delivery and must be re-tagged (MTF / intraday) until tradebook or
  auto-import is added. Classification overrides persist across re-imports.
- **Dhan CSV + Groww XLSX parsers are validated** against real sample files. The
  **Zerodha and PDF parsers are built to the documented spec but not yet validated**
  against real samples — Zerodha uses resilient header-mapping (equity solid; F&O
  symbols may need re-tagging), and PDF extracts text then routes to manual mapping.
- **Brokerage & MTF interest can't be derived from scrip-aggregated P&L** (order
  counts / financing days are hidden) — the reconciliation panel surfaces these
  deltas. Statutory charges (STT, exchange, stamp, SEBI) reconcile within ~5%.
- Money is stored as floating-point rupees; the charges engine applies statutory
  rounding (STT/CTT and stamp to the nearest rupee). Reconciliation against
  broker totals is checked within a small tolerance.
- No live price feeds / auto-MTM, no broker-API auto-import, no multi-user/auth,
  no cloud sync, no tax e-filing (interfaces are left as seams).
