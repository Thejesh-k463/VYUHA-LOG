# Welcome to Vyuha

A fully local, offline trade journal for Indian retail traders. Your data never
leaves your computer — there is no account, no cloud, and no telemetry.

---

## Getting started

1. **Install** — run `Vyuha_x.y.z_x64-setup.exe`. Windows may warn about an
   unrecognised publisher; that is expected for an independently distributed
   app. Full walkthrough: [`INSTALLATION_GUIDE.md`](INSTALLATION_GUIDE.md).
2. **Activate** — Settings → License, paste the `VYUHA-…` key from your
   purchase email. You get a **14-day full trial** before a key is needed.
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

**Back it up** from Backup & Restore inside the app, or just copy that file.
Uninstalling does not delete it, and a new version migrates it in place after
taking its own pre-migration backup.

---

## Help

Questions, a broker file that will not import, or a licence problem — reply to
your purchase email or message the WhatsApp number on your invoice. Sending the
file that failed is the fastest route to a fix; it never leaves your machine
unless you attach it yourself.
