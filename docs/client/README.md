# Welcome to Vyuha

A fully local, offline trade journal for Indian retail traders. Your data never
leaves your computer — there is no account, no cloud, and no telemetry.

## New in v2.99.20

| Upgrade | What it gives you |
|---|---|
| **Equity only? F&O only?** | Settings → Workspace. Pick the book you actually trade and the other one's screens leave your sidebar and the Ctrl+K palette. Nothing is deleted, your totals still count everything, and switching back is one click. |
| **MTF shows the rate it is using** | The capital vs broker-funded split now appears only on MTF trades — not on delivery or intraday, where broker funding doesn't exist — and leads with the actual percentage for *your* stock on *your* broker's list. If the stock isn't on that list, it says so instead of guessing. |
| **Screenshots you can find** | Trades with a chart attached now show a paperclip and a count in the journal, so you can see at a glance which trades have evidence. The add-trade form tells you up front that you can attach one. |
| **Calendar you can open** | Click any day on the P&L calendar to see exactly that day's trades. Above it: your current and best green/red runs — counted in days you actually traded, so a weekend never breaks a streak — plus your best and worst days marked in place and each month's net in its header. |
| **Drag the sidebar** | Reordering is now a drag: hover any screen or group, grab the grip, and drop it where you want. The row glows and a line shows where it will land. |

## New in v2.99.9

| Upgrade | What it gives you |
|---|---|
| **MTF across all 7 brokers** | Every broker's real MTF list is bundled — 10,500+ stocks with each broker's actual margin requirement. Add an MTF trade and your capital vs broker-funded splits itself at that stock's real rate, editable both ways. |
| **Which broker funds it cheapest** | Broker Costs now prices *your* stocks across every broker's MTF list and highlights the cheapest margin — and tells you when a stock is approved but not actually funded. (Sahi offers no MTF delivery.) |
| **MTF drift check** | Portfolio Risk flags open MTF positions whose margin requirement has moved since you entered — with the top-up amount a re-margin would demand. |
| **Chart screenshots at entry** | Save a trade and attach your chart screenshots right there — they stay with the trade for review, fully offline. |
| **Export selected trades as PDF** | Tick trades in the journal → Export PDF → a clean report with full detail per trade. |
| **Your sidebar, your order** | Arrange screens and groups the way you work; Reset brings the default back. (Now a drag — see v2.99.20 above.) |

## New in v2.99.5

| Upgrade | What it gives you |
|---|---|
| **The व mark** | Vyuha's icon is now the Devanagari letter व hanging from its headline stroke, extended edge to edge like a price level. You'll see it on the installer, the taskbar or dock, the browser tab, and the stat cards you share. |
| **Tables you can read** | Row separators are actually visible now, table headers look like headers, and long option names no longer push your P&L columns off screen — the instrument stays pinned while you scroll sideways. |
| **Display density** | Settings → Preferences → Display density. Compact is the terminal look you know; Comfortable makes the whole interface a step larger. |
| **Light theme** | The teal used for links and buttons in the light theme is now dark enough to meet accessibility contrast standards. |

## New in v2.99

| Workspace | What it gives you |
|---|---|
| **macOS** | Vyuha now ships native builds for Apple silicon and Intel Macs, alongside Windows. Pick the build matching your Mac; first launch needs right-click → Open (the builds are not yet notarised). |
| **Help Desk** | Every screen described — what it answers, its honesty rules, and what it deliberately won't do — searchable, with a direct link to each. |
| **Delete, honestly** | Select trades to delete, remove an imported file (you choose whether its trades go too), or clear by date/broker/segment. Every delete shows exactly what will go before it goes, and the audit log keeps the full record. |
| **Import overlap warning** | Importing a P&L export after a transaction report used to record the same trades twice. The preview now names the overlapping rows and the file they came from, before anything commits. |
| **My Default Settings** | Your first configuration is saved as a baseline. Change anything freely — one click brings preferences and rate tables back. Your licence, trial and data are never touched. |
| **Dismissible warnings** | Advisory panels can be dismissed and stay hidden until the situation they describe actually changes. |

## Also in v2.98

| Workspace | What it gives you |
|---|---|
| **ITR Pack → Schedules** | Your figures in the return's own item codes — Schedule CG (A3 · 111A, B4 · 112A), Schedule BP and Schedule CFL — with the form indicated (ITR-2 or ITR-3). STT is handled correctly per head: excluded from capital-gains deductions, allowed as a business expense against intraday and F&O. |
| **Safer restore** | Restoring a backup no longer removes chart screenshots, and a restore that fails partway leaves your journal exactly as it was. |
| **Stronger backup passwords** | Encrypted backups use a much costlier key derivation. Files made with older versions still open. |
| **Clearer multi-account writes** | Adding or importing a trade while viewing all accounts now asks which account it belongs to. |

## Also in v2.97

| Workspace | What it gives you |
|---|---|
| **Data Quality** | A confidence score and direct fixes for incomplete basis, marks, stops, MTF, option, IPO, instrument, and attachment data. |
| **Sessions** | Plan the day before the open, then review trade count, cutoff, loss budget, watchlist, and playbook adherence after it. |
| **Rule Packs** | See which dated SEBI/broker assumptions power the radar, their sources, and when they need review. |
| **Scaling Quality** | Measure whether adds improved or harmed a staged position and replay fills over local EOD history. |
| **Options Journal** | Record IV, DTE, hedge status, expiry outcome, and adjustment families for seller-specific review. |
| **Accounts** | Keep separate broker/entity books or switch to an aggregate “All accounts” view. |
| **Backup & Restore** | Export the complete journal—including screenshots—optionally encrypted, and preview a restore before confirming. |

---

## Getting started

1. **Install** — run `Vyuha_x.y.z_x64-setup.exe`. Windows may warn about an
   unrecognised publisher; that is expected for an independently distributed
   app. Full walkthrough: [`INSTALLATION_GUIDE.md`](INSTALLATION_GUIDE.md).
2. **Activate** — Settings → License, paste the `VYUHA-…` key from your
   purchase email. You get a **7-day full trial** before a key is needed.
3. **Import your trades** — Import → pick the kind of file you have.
4. **Read the tour** — [`GETTING_STARTED_DECK.html`](GETTING_STARTED_DECK.html),
   openable in any browser.

---

## Which file should I import?

This is the single most useful thing to get right, because it decides how much
Vyuha can tell you.

| Your file | What Vyuha can do with it |
|---|---|
| **Transaction / tradebook** (recommended) | Everything. Real dates, product type, and — for Zerodha/Angel One/Upstox — execution times, which unlock the time-of-day analysis in Arjun's Eye. |
| **Dhan Global Transaction Report** | Real dates and per-row broker charges. Delivery vs intraday is read from the charge rates themselves. No fill times (the column is a settlement stamp). |
| **P&L statement** | Totals only. No dates and no product column, so Vyuha asks you once which rows were delivery vs MTF, and the equity curve cannot plot them. |
| **Ledger** (Cash & Ledger) | Your **real MTF interest**, which appears in no other file. |

### Why Vyuha asks about MTF

An MTF position carries exactly the same STT and stamp duty as a delivery
position, and the financing interest is posted to your **ledger**, not to the
contract note. So no Dhan file can tell them apart — Vyuha asks rather than
guesses. If you connect the **Dhan API** (Import → Connect broker), the broker
states it outright and you are never asked again.

---

## What Vyuha will and will not do

- It **warns; it never blocks.** You can add, edit or delete any trade at any
  time, including adding an entry to a position you have already closed. Vyuha
  will tell you the consequence and then do what you asked.
- It **never invents a number.** An open position with no mark price has no
  unrealised result, so it appears in neither "in gain" nor "in loss" — and the
  screen says so instead of quietly counting it as flat. A sale with no
  purchase on record is held out of your win rate rather than scored as a 100%
  winner.
- It **never places, closes, or changes an order.** Breach alerts say "check a
  live quote and review your plan". Auto-update asks before installing.

---

## Your data

Everything lives in one SQLite file on your machine:

```
%LOCALAPPDATA%\Vyuha\data\vyuha.sqlite
```

**Back it up** from Backup & Restore inside the app. The backup includes the complete
database plus screenshot attachments; set a password when the file will leave your machine.
You can still copy the SQLite file for a quick local snapshot.
Uninstalling does not delete it, and a new version migrates it in place after
taking its own pre-migration backup.

---

## Help

Questions, a broker file that will not import, or a licence problem — reply to
your purchase email or message the WhatsApp number on your invoice. Sending the
file that failed is the fastest route to a fix; it never leaves your machine
unless you attach it yourself.
