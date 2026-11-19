# Vyuha — Installation & Getting-Started Guide

**Every warrior had a charioteer. Yours keeps count.**

**Vyuha** is a trading journal for the Indian market — desktop or web, the trader chooses. This guide covers **Vyuha Desktop**, which runs **on your own
computer**. No account, and nothing about you or
your trades is uploaded by the desktop app unless you switch on a feature that sends it.

- **Platform:** Windows 10 / 11 (64-bit), or macOS 10.15 or later on a Mac with Apple silicon or an
  Intel processor — **one licence, the same price** on either. Each has its own client package (below).
- **Disk:** ~200 MB
- **Internet:** not needed to use Vyuha Desktop. At launch it makes one download-only check to GitHub (is there a newer signed release, and is this licence still valid) which sends nothing about you and skips silently when offline; everything else is optional — the opt-in bhavcopy download and any broker API pull you start yourself.

---

## 1. Download & install (2 minutes)

**Which package is mine?** There is one client package per kind of computer, and one licence covers all three:

| Your computer | Package | Installer inside it |
|---|---|---|
| Windows PC (Windows 10 or 11, 64-bit) | `Vyuha_x.x.x_Windows-x64_Client_Package.zip` | `Vyuha_x.x.x_Windows-x64-Setup.exe` |
| Mac with Apple silicon | `Vyuha_x.x.x_macOS-Apple-Silicon_Client_Package.zip` | `Vyuha_x.x.x_macOS-Apple-Silicon.dmg` |
| Mac with an Intel processor | `Vyuha_x.x.x_macOS-Intel_Client_Package.zip` | `Vyuha_x.x.x_macOS-Intel.dmg` |

On a Mac, open the Apple menu → **About This Mac**: "Chip: Apple M…" (M1, M2, M3, M4 …) means
Apple-Silicon; "Processor: … Intel …" means Intel.

### On Windows

1. Download the **Windows-x64** package from the private link in your purchase email (the installer
   is around 35 MB — too large to attach to an email) and unzip it.
2. Double-click **`Vyuha_x.x.x_Windows-x64-Setup.exe`**.
3. **Windows SmartScreen may warn you** ("Windows protected your PC"). This is normal for a new
   independent app that isn't yet code-signed — it is **not** a virus warning.
   → Click **More info** → **Run anyway**.
4. Follow the installer. Vyuha installs and adds a Start-menu shortcut.
5. Launch **Vyuha**. It opens as a normal desktop window. From v2.99.96 **no black terminal /
   console window should appear** behind it — if you are ever asked for a log, it is at
   `%APPDATA%\in.vyuha.tradejournal\logs\sidecar.log`.
   From v2.99.97, reinstalling over a copy that is still running no longer shows
   "Error opening file for writing … node.exe" — the installer stops Vyuha's own server first
   (and only Vyuha's; no other Node process on your PC is touched). If you see that message on an
   older version, **Ignore** is safe: the file it could not replace is identical.

### On a Mac

1. Download the **macOS-Apple-Silicon** or **macOS-Intel** package (see the table above) from the
   private link in your purchase email and unzip it. Vyuha needs **macOS 10.15 or later**.
2. Open **`Vyuha_x.x.x_macOS-Apple-Silicon.dmg`** (or `…_macOS-Intel.dmg`) and drag **Vyuha** into
   **Applications**.
3. Open Vyuha from Applications. **The Mac app is not signed or notarised by Apple**, so the first
   time you open it macOS says it cannot verify the developer. That is expected — it is not a virus
   warning. Open **System Settings → Privacy & Security**, scroll to the message about Vyuha and
   click **Open Anyway** (on macOS 14 and earlier, Control-click the app → **Open** also works).
   You are asked once.
4. Vyuha opens as a normal window. Your journal lives in
   `~/Library/Application Support/in.vyuha.tradejournal` (the log is in its `logs` folder).
5. **Removing Vyuha from a Mac:** drag Vyuha from Applications to the Bin. That removes the app
   only — the data folder above stays until you delete it yourself, so back up first (section 7)
   if you mean to delete it.

The licence is the same on both: a machine-bound key moved from a Windows PC to a Mac (or back)
asks for the new computer's Machine ID, exactly as a move between two PCs does. App updates are
signed with Vyuha's update key and checked before they install, on macOS as on Windows.

> Your data lives in a local database file on your computer. Nothing is uploaded anywhere.

## 2. Your 7-day trial, and activating a license

**Every fresh install starts a 7-day full-Pro trial** — no signup, no card, no server call.
The clock starts the first time *you* open the app, not when the installer was built. The core
journal — recording closed trades, imports, the dashboard, staged positions, playbooks and
backups — is **free forever**; the trial covers the Pro analytics, plus live open-position
tracking with SL/target. Whatever you record during the trial stays yours: when it ends, every
trade is still readable, editable and exportable without a key.

When you buy:

1. Go to **Settings → License**.
2. Paste the **license key** from your purchase email (one line, starts with `VYUHA-`).
3. Click **Activate**. You'll see **"Licensed to <your email>"**, your SKU, and a **Key ID** like
   `A1B2-C3D4-E5`.
4. Activation is **serverless** — verified on your machine against a signature. Your key is never sent
   anywhere and nothing about you is transmitted. (Vyuha still makes the one download-only launch
   check described at the top. A licence withdrawn after a refund or chargeback stops working
   through that check, and only after a dated warning period shown in the app.)

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
   (P&L CSV and the Global Transaction Report), **Groww** (stocks P&L and order history),
   **Angel One** (tradebook, P&L, and the tax P&L), **Upstox** (tradebook or P&L),
   **Paytm Money** (tradebook), **Fyers** (tradebook, plus its Realised P&L as the broker's own
   figures — the filename must contain "fyers", or the file goes to the column mapper) and
   **Nuvama** (the P&L report, with the charges Nuvama billed). Fyers and Nuvama equity rows are
   unverified and import with a warning. A broker **PDF** can be opened too, but it only extracts the
   text for you to enter by hand — it does not import trades. Live **API pulls** work for
   Zerodha, Dhan, Upstox and Angel One (Import → Connect broker) — Angel One runs unattended from your
   TOTP secret, and all API credentials are stored encrypted, bound to this machine, and sent
   nowhere except the broker itself. Since v4.7.0 **Fyers, Kotak Neo and Nuvama** can be pulled
   from the same screen — today's trades only, and *documented, not yet verified with a real
   account*, so check those pulls against your contract note. Any other broker's CSV/XLSX
   imports through the column mapper — Vyuha asks once and remembers.
   *Setting up a broker API? **BROKER_API_SETUP_GUIDE.html** in this package walks through each
   broker's own form, field by field — including Angel One's Redirect URL and Static IP boxes.*
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
| **Surveillance** | Upload NSE's daily files (fo_secban.csv / REG_IND — ban, ASM, GSM, ESM) or paste any list → alerts on your holdings |

## 6. Auto-MTM & market data (optional, opt-in)

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

When a new version ships, on Windows download the new `Vyuha_x.x.x_Windows-x64-Setup.exe` and run it
over your existing install; on a Mac, open the new DMG and drag Vyuha into Applications, replacing the
old copy. Your local data is preserved (and a backup is taken automatically before any
database migration).

**Upgrading from v4.7.x to v4.8.0 on Windows — nothing is asked of you, during the install or after
it.** The v4.8.0 installer runs the v4.7.0 uninstaller once before it installs, and that one is
the *guarded* uninstaller: if its "Delete the application data" checkbox appears, ticking it still
erases the whole data folder, but not before your journal database and licence key have been named
and copied to `Documents\Vyuha-backup-<date>`, and Cancel leaves everything exactly as it is. On a
Mac there is no uninstaller step: drag the new copy into Applications, replacing the old one; if
macOS asks again whether to open it, use the **Open Anyway** step in section 1. No disclosure
changed in this release, so nothing is re-read afterwards.

**Migrations on first launch of v4.8.0.** **One** database upgrade, applied behind the same
automatic `backups\pre-migrate-<timestamp>.sqlite` copy described below: **0081** adds one empty
column to the Edge Clinic's cache — derived data that is never part of a backup and is filled by
the next compute. No money figure already stored on a trade moves. **Take your own backup first,
as always.** Upgrading from **v4.6.x** applies **0079 to 0081** in order, and the notes for that step — the
four disclosures re-read once after the update, currency refused at import, the stream and the
alerts — are under "New in v4.7.0" in the README.

**What changes with no switch to set.** **A second pull on the same day that restates a sale an
earlier pull already closed against an older position now stops** at the duplicate dialog instead
of adding the sale beside it: it names what closed the position (today's earlier pull, an earlier
pull today, or a Data Quality join you made today) and the steps that record the new total — in
Trades, Un-close the position (or undo the Data Quality join), delete the sale row that brings
back, then pull again. Nothing is committed until you choose; committing anyway records the pull's
figure beside the sale already counted, so the day is counted twice, and the dialog says so. This
covers the OpenAlgo pull now too. **Imports and pulls close more positions:** when two of your
sources for one broker write a contract two ways — a weekly option by the exchange's compact name
and by its date, or a share with and without its series suffix — the two now match exactly and
the sale closes the position. A **month-level** pair — a compact *monthly* or a future against a
dated name — is **never closed on its own**: both rows stay, the import says so, and **Data
Quality lists the pair with both names and a tick** for you to confirm. **On your first launch,
Data Quality's count can rise**, because positions already split under two names in your book are
listed there to join one at a time; nothing is rewritten. A Data Quality join can now be undone
from Trades (the row's menu → **Undo Data Quality join**). **The Clinic recomputes once per
account** after the update (the engine moved to c4.0), and each setup's Detail then carries a
**decay card** where a cell has 60 or more trades with an R. **A currency derivative typed by hand
is refused** when you create it (existing currency rows stay editable, closable and deletable), and
an NCDEX row in the column mapper or a Nuvama report is refused and named instead of failing the
whole file. The Live Desk's **Positions** tab shows the **largest 150** positions with a "Show 150
more" button; its totals still read the whole book. The bundled market data (ISINs, industries
and cap bands, index membership, ETFs) is refreshed as of **5 October 2026**; the market calendar
still ends on **31 December 2026**, so Telegram alerts, where you switched them on, still stop
after that day until an update bundles the 2027 holiday list.

**One thing that happens on its own at first launch, and nothing to switch on.** The desktop
rate-card refresh had failed on every launch since v3.2.0; 4.3.0 repairs the F&O STT rates for
dates before 1 April 2026 on first launch, adds the STT rates in force before 1 October 2024, dates
the NSE and BSE exchange transaction charges and NSE's investor-protection fee by the exchanges'
own circulars, and corrects today's NSE transaction charges and the BSE stock-option charge;
charges already stored on trades are not rewritten. It writes only Vyuha's own rate table, and
never a rate you edited yourself. It runs again on every later launch and finds nothing left to
change. One other thing happens by itself: a trade whose note carries one of your recorded signals
in full is read into the new Signal book, and a note it cannot read in full is left exactly as it
is. Nothing else is switched on by the update: Option Strategies, the Signal book and the Options
Help Desk are there when you open them, and every Live Desk source stays exactly as you had set it.
One thing changes in how imports land, with no switch: the next Dhan pull after a gap also reads
the days it missed, up to 90 of them, and names on the Dhan tab any days it could not read.

**Upgrading from v3.9.x to v4.0.0 — nothing is asked of you.** The v4.0.0 installer runs the
v3.9.1 uninstaller once before it installs, and that one is the *guarded* uninstaller. If its
"Delete the application data" checkbox appears, ticking it still erases the whole data folder,
but not before Vyuha has named your journal database and your licence key and copied
`vyuha.sqlite`, your attachments and the pre-migration backups it took for you to
`Documents\Vyuha-backup-<date>` — and Cancel stops the uninstaller with everything left exactly
as it is. So the "leave the box unticked" caution below is only for people coming from **v3.7.1
or earlier**, whose uninstaller has no backup step at all.

**Migrations on first launch.** v4.0.0 applies four database upgrades (0064-0067: the Live Desk's
risk and stop columns, the Market Atlas daily tables, the end-of-day bar backfill ledger, and the
live-price feed's settings). Before it applies any of them it writes a full copy of your database to
`backups\pre-migrate-<timestamp>.sqlite` inside your data folder, keeping the ten most recent.
If your schema is already current, no migration runs and no backup is taken.

**Upgrading from v3.7.1 to v3.8.0 — one thing to know.** The installer runs the *previous*
version's uninstaller once before it installs, and the v3.7.1 uninstaller has no backup step of
its own. When its "Delete the application data" checkbox appears, **leave it UNTICKED** and
continue — ticking it erases the whole data folder, journal and licence key together. From
v3.8.0 onward the uninstaller protects your data as described below. If you want a
belt-and-braces copy first, export a backup from Backup & Restore inside the app — but the
in-app backup carries your journal and **not** your licence key, so keep the key email too.
Leaving that checkbox unticked is what keeps the key.

**Uninstalling.** The uninstaller offers a "Delete the application data" checkbox — at
uninstall, and mid-upgrade if you choose to uninstall the old version first. Ticking it erases
the whole data folder: journal, licence key and attachments. Before it runs, Vyuha copies your
journal database and licence key (both live in `vyuha.sqlite`), the pre-migration backups it
took for you and your attachments to `Documents\Vyuha-backup-<date>` and asks you to confirm;
Cancel keeps everything in place, and if that copy cannot be made — a full disk, or a
files-on-demand placeholder OneDrive will not hydrate — the uninstall stops with nothing
removed. Leave the box unticked to keep the data where it is.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| SmartScreen blocks the installer | **More info → Run anyway** (unsigned app, expected) |
| macOS says it cannot verify the developer | **System Settings → Privacy & Security → Open Anyway** (the Mac app is not signed or notarised by Apple — expected) |
| Antivirus flags the new .exe | Whitelist it — false positive common for new unsigned binaries |
| Numbers look wrong | Check **Settings → charge config** matches your broker's real rates |
| F&O shows as equity after import | Re-tag in **Journal → Trades** (segment/strike/expiry/CE-PE) |
| Import didn't detect my broker | Eight brokers auto-detect (Zerodha, Dhan, Groww, Angel One, Upstox, Paytm Money, Fyers, Nuvama) — a Fyers file only when its filename contains "fyers"; any other CSV/XLSX goes through the column mapper — Vyuha asks what the columns mean rather than refusing |
| Lost everything after a reset | **System → Backup & Restore → Restore** your last export |

## 10. Support

Reply to your purchase email, or reach the support handle listed on the product page. Include your
Vyuha version (the installer filename carries it in full — `Vyuha_4.8.0_Windows-x64-Setup.exe` or `Vyuha_4.8.0_macOS-Apple-Silicon.dmg` — and Windows **Settings → Apps → Installed apps** lists it; the sidebar footer shows the release line, `Vyuha Desktop · v4.8`) and, if the
problem is licence-related, your **Key ID** from **Settings → License** — never the key itself.

---

*Vyuha is a record-keeping and analytics tool. It does not provide investment advice. All tax
figures are informational — verify with a qualified professional before filing.*
