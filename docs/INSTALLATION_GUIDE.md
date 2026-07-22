# Vyuha — Installation & Getting-Started Guide

**Vyuha** is a local-first trading journal for the Indian market. Everything runs **on your own
computer** — your trades never leave your machine. No account, no cloud, no internet required
after download.

- **Platform:** Windows 10 / 11 (64-bit)
- **Disk:** ~200 MB
- **Internet:** only needed to download the installer (and optionally to paste EOD/bhavcopy/VIX data)

---

## 1. Download & install (2 minutes)

1. Download **`Vyuha_x.x.x_x64-setup.exe`** from the link in your purchase email.
2. Double-click it.
3. **Windows SmartScreen may warn you** ("Windows protected your PC"). This is normal for a new
   independent app that isn't yet code-signed — it is **not** a virus warning.
   → Click **More info** → **Run anyway**.
4. Follow the installer. Vyuha installs and adds a Start-menu shortcut.
5. Launch **Vyuha**. It opens as a normal desktop window.

> Your data lives in a local database file on your PC. Nothing is uploaded anywhere.

## 2. Your 14-day trial, and activating a license

**Every fresh install starts a 14-day full-Pro trial** — no signup, no card, entirely offline.
The clock starts the first time *you* open the app, not when the installer was built. The core
journal (trades, imports, dashboard, playbooks, backups) is **free forever**; the trial covers the
Pro analytics.

When you buy:

1. Go to **Settings → License**.
2. Paste the **license key** from your purchase email (one line, starts with `VYUHA-`).
3. Click **Activate**. You'll see **"Licensed to <your email>"**, your SKU, and a **Key ID** like
   `A1B2-C3D4-E5`.
4. Activation is **offline** — verified on your machine against a signature. No internet needed,
   ever, and nothing about you is transmitted.

**Quote the Key ID, never the key, when contacting support.** The Key ID identifies your licence
without exposing the credential itself.

Lost your key? Reply to your purchase email — it can be reissued from your email address.

## 3. First-time setup (5 minutes)

Open **Settings** (bottom of the left sidebar) and set:

| Setting | What to enter |
|---|---|
| **Financial-year start month** | `4` (April) for India — leave as-is unless you know otherwise |
| **Equity capital** | Your capital allocated to the equity/investing bucket |
| **Active capital** | Your capital allocated to the active/F&O bucket |
| **Broker(s) & charges** | Your broker's brokerage/STT/GST rate card (under charge config) |

The charge config is what powers accurate net-P&L, tax, and broker-cost comparison. Set your real
broker rates once and every calculation downstream is correct.

## 4. Get your trades in

You have two paths — use either or both:

### A. Import a broker file (fastest)
1. Go to **Journal → Import**.
2. Drag in your broker export. Supported today: **Zerodha** (tradebook / Console P&L), **Dhan**
   (CSV), **Groww** (XLSX), **Angel One** and **Upstox** (tradebook *or* aggregated P&L export),
   and broker **PDF** statements.
   *Tradebook exports list every individual fill, so a position you scaled into arrives with its
   real entry ladder instead of one blended average — see Staged positions below.*
3. Vyuha auto-detects the broker, parses the trades, recomputes charges from your rate card, and
   shows a preview.
4. Review, then **Commit**. Duplicates are detected and skipped automatically.

> **F&O note:** after importing F&O, open **Journal → Trades** and confirm each derivative is
> tagged correctly (segment, strike, expiry, CE/PE). Broker symbol formats vary; re-tag anything
> that landed as plain equity. (A Zerodha F&O auto-parse enhancement is on the roadmap.)

### B. Add a trade manually
1. **Journal → Trades → Add trade.**
2. Toggle **Equity** or **F&O**.
   - **Equity:** symbol, buy/sell qty, prices, dates.
   - **F&O:** underlying, contract type, expiry (a live **DTE** badge appears), strike, CE/PE,
     Buy/Sell, lot size, lots, entry premium, and exit premium (leave blank for an open position).
3. The charge preview and pre-trade limit check update as you type. Save.

## 5. A 60-second tour of what you get

| Area | What it does |
|---|---|
| **Dashboard** | Combined P&L, equity curve, win rate, profit factor, daily P&L calendar |
| **Portfolio Risk** | Live exposure, open risk at stop, **Option Greeks** (with India VIX IV fallback), expiry/physical-settlement obligations, pre-trade limits, **SEBI compliance radar** (expiry-day margin rules, weekly-expiry regime, index position limits) |
| **Option Strategies** | Auto-recognises straddles/strangles/spreads and draws the payoff diagram |
| **Trades / Equity / Active** | Your journal, filterable, with F&O detail (DTE, lots, long/short) |
| **Staged positions** (Trades → the ⧉ layers button) | Build a position in **tranches**, each with its own stop; **book partial exits** (25/50/100%) and let the rest run. Exits price against your blended average; R stays anchored to your first entry. Warns when you're averaging down, or when an add has quietly pushed your risk above what you originally planned |
| **Clickable KPI cards** | Click any headline number — Net P&L, Open Risk @ SL, MTF funded — for a breakdown of what it's actually made of |
| **Playbooks → Preset library** | 25 battle-tested setups across 7 global trading ecosystems; filter, read the rules, add the ones you actually trade with one click |
| **Corporate Actions** | Apply splits/bonuses/dividends to open positions; dividend posts to the ledger with **TDS** |
| **Cash & Ledger** | Deposits, withdrawals, charges, dividends, margin penalties → true available capital |
| **Analytics → Tax Summary** | Capital-gains tax + set-off/carry-forward + dividend TDS (informational) |
| **Analytics → Advance Tax / Tax Harvest / Charges & MTF Leak / Broker Costs** | The money-and-tax toolkit |
| **Surveillance** | Paste the daily NSE/BSE F&O-ban / ASM-GSM list → alerts on your holdings |

## 6. Auto-MTM & market data (optional, still offline)

Vyuha never calls a paid feed. To value open positions or feed Greeks:
- **Portfolio Risk → Auto-MTM from bhavcopy** — paste the free NSE/BSE daily bhavcopy.
- **Portfolio Risk → India VIX** — paste NSE's India VIX history (used as the Greeks IV fallback).
- Or just type an MTM price in the bulk-update panel.

## 7. Back up your data (do this!)

Because everything is local, **you** own the backup.
- **System → Backup & Restore → Export** — saves a snapshot file. Store it somewhere safe
  (external drive / your own cloud).
- **Restore** re-imports a snapshot on a new machine or after a reset.
- The app also auto-creates a pre-migration backup whenever it updates.

## 8. Updating

When a new version ships, download the new `Vyuha_x.x.x_x64-setup.exe` and run it over your
existing install. Your local data is preserved (and a backup is taken automatically before any
database migration).

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| SmartScreen blocks the installer | **More info → Run anyway** (unsigned app, expected) |
| Antivirus flags the new .exe | Whitelist it — false positive common for new unsigned binaries |
| Numbers look wrong | Check **Settings → charge config** matches your broker's real rates |
| F&O shows as equity after import | Re-tag in **Journal → Trades** (segment/strike/expiry/CE-PE) |
| Import didn't detect my broker | Confirm it's Zerodha/Dhan/Groww/PDF; else add trades manually |
| Lost everything after a reset | **System → Backup & Restore → Restore** your last export |

## 10. Support

Reply to your purchase email, or reach the support handle listed on the product page. Include your
Vyuha version (shown at the bottom of the sidebar, e.g. `Local · Offline · v1.15`).

---

*Vyuha is a record-keeping and analytics tool. It does not provide investment advice. All tax
figures are informational — verify with a qualified professional before filing.*
