# Welcome to Vyuha

A fully local, offline trade journal for Indian retail traders. Your data never
leaves your computer — there is no account, no cloud, and no telemetry.

## New in v2.99.92

| Upgrade | What it gives you |
|---|---|
| **This is the Windows build of v2.99.91** | v2.99.91 never shipped a Windows installer — our build for it failed after the Mac builds had already gone out. Nothing about the app changed since; everything listed under v2.99.91 below arrives here. If you are on Windows, this is the version to install. |

## New in v2.99.91

| Upgrade | What it gives you |
|---|---|
| **Straight talk about the one network call** | Vyuha has always asked GitHub at launch whether a newer signed release exists. Some of our own wording implied that was optional — it is not, so we fixed the wording rather than the app. It is download-only, sends nothing about you or your trades, skips silently when you are offline, and is the only thing Vyuha contacts unless *you* switch on the bhavcopy download or connect a broker. |
| **A licence problem now warns you first** | If a licence ever has to be withdrawn — a refund, a chargeback, a key posted publicly — the Pro screens show a dated countdown for a grace period *before* anything stops, with a message explaining why. You will never find a screen simply dead. |
| **A locked screen now tells you why** | If a Pro screen is ever locked, it now shows the actual reason — a key registered to a different computer, a licence this machine cannot read, or a message from us — instead of always saying "your annual license has expired". Fewer support round-trips to find out what happened. |
| **Your journal is never the hostage** | Whatever happens to a licence, your trades, imports, backups and exports keep working exactly as they do on a free copy. That has always been the rule and it does not change here. |

## New in v2.99.90

| Upgrade | What it gives you |
|---|---|
| **Angel One connects itself** | Angel One joins Zerodha and Dhan for live API pulls (Import → Connect broker) — and unlike the other two, nothing expires on you. Enter the SmartAPI key, client code, PIN and your TOTP *secret* once; each pull mints the day's login code itself. One click after market close brings in the day's fills through the same preview → charges → de-duplication pipeline as a file import. SmartAPI is free. |
| **The connection cannot trade** | The Angel One integration can log in and read your trade book — nothing else. There is no order, transfer or modification capability in it at all, and the test suite pins that. |
| **Mistakes are caught when you make them** | Pasting the 6-digit authenticator code where the TOTP *secret* belongs is refused at save with an explanation — not discovered tomorrow as a cryptic login failure. |

## New in v2.99.80

| Upgrade | What it gives you |
|---|---|
| **Your secrets are encrypted at rest** | Your licence key and any broker API credentials are now stored encrypted, with a key bound to this machine and your Windows user profile. The database file alone — copied, synced, or shared — carries nothing usable. |
| **Backups carry no credentials** | A backup file holds your journal, never your keys: broker credentials and the licence are left out, and a restored journal simply asks you to re-connect. Sharing a backup no longer means sharing a credential. |
| **On a new computer, it asks — never breaks** | Move to a new machine and Vyuha plainly asks you to re-paste the licence key from your purchase email and re-connect brokers. Your journal itself opens untouched. |

## New in v2.99.77

| Upgrade | What it gives you |
|---|---|
| **Multi-account edges sealed** | Every write now lands in exactly the account you are looking at: session plans can no longer drift across accounts from a stale tab, IPOs added in the All-accounts view go where you'd expect, and archiving your selected account moves you to a live one instead of stranding the screen. |
| **IPO exit charges use your rate card** | Exited IPOs are now priced by the same charges engine as every other delivery sell — from the editable rate config, not fixed numbers — so a budget change reaches them too. |
| **Deleting a playbook keeps its word** | "Its trades fall back to Untagged" is now literally what happens, and the confirmation tells you how many trades and session plans were touched. |

## New in v2.99.76

| Upgrade | What it gives you |
|---|---|
| **Clear pricing, in the app** | Two plans, stated plainly where you need them: **Pro — Annual ₹9,999/yr** (recommended) and **Journal — Lifetime ₹29,999**. The free tier remains free forever — recording trades, every importer, backups. Prices shown in-app carry the date they were set, and the WhatsApp message quotes exactly what you saw. |

## New in v2.99.75

| Upgrade | What it gives you |
|---|---|
| **Six brokers recognised automatically** | Paytm Money joins Dhan, Groww, Zerodha, Angel One and Upstox — its tradebook imports with the broker's own charge figures, per execution. Angel One's tax P&L (with its explicit MTF quantities) and Groww's order history now import too. And recognition got stricter: a file has to prove which broker it came from before Vyuha reads it as that broker, so the wrong broker's rates can never be applied by accident. |
| **Deleting is no longer forever** | Every delete first saves a snapshot of exactly what is being removed — trades, staged entries, chart screenshots and all. Put it back any time from Backup & Restore → Deleted items. You can also delete by date range, by import file, by broker, or exactly what the table is showing — always with a preview of the precise set and count first. |
| **Lenses — your book, six ways** | A new screen that regroups the same trades by month, broker, trade type, import file, setup or outcome. When an import looks wrong, one click shows exactly what that file produced, in isolation — and you can delete just that group from right there. |
| **A back button that knows where it goes** | The header grows a back control whenever there is an in-app screen to return to, labelled with where it will take you. Alt+← and the mouse's back button work too. |
| **Prices, in the app** | What a licence costs is now shown where you'd need it — no more asking on WhatsApp just to learn the number. |

## New in v2.99.30

| Upgrade | What it gives you |
|---|---|
| **Import from any broker** | Six brokers are recognised automatically (Paytm Money joined in v2.99.75). For every other one — Kotak Neo, Sahi, or one that launches next year — drop the CSV or XLSX and Vyuha asks you to match the columns once, then remembers it for that broker. Nothing is guessed: a layout Vyuha doesn't know produces a question, never a trade with the quantity in the price column. |
| **A new look** | A darker, calmer canvas; panels with depth instead of flat fills; and a colour language you can rely on — teal is something you can click, gold is money leaving your account, violet is a statistic about your trading. |
| **A new mark** | Three arcs in those same three colours around the व, with a ₹ coin. You'll see it on the installer, the taskbar or dock, the browser tab, and the cards you share. |
| **Readable tables** | Company names, brokers and segments now use a proper text face instead of the monospaced one meant for digits — far easier to scan. Your numbers stay monospaced, so the columns still line up. |
| **Faster updates** | The desktop build no longer does its work twice, so new versions reach you sooner. |

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
| **Transaction / tradebook** (recommended) | Everything. Real dates, product type, and — for Zerodha/Angel One/Upstox/Paytm Money — execution times, which unlock the time-of-day analysis in Arjun's Eye. Paytm Money's tradebook also carries the broker's own per-trade charges, which Vyuha stores as the truth. |
| **Dhan Global Transaction Report** | Real dates and per-row broker charges. Delivery vs intraday is read from the charge rates themselves. No fill times (the column is a settlement stamp). |
| **Angel One Tax P&L** | Intraday, delivery, buyback, F&O — with the broker's own charges per row, and the only export that states **MTF quantity** directly, so funded positions tag themselves. |
| **Groww Order History** | Every executed order with dates and times. It has no price column (Vyuha derives price from value ÷ quantity, and says so) and no charges (estimated from Groww's rate card). |
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
%APPDATA%\in.vyuha.tradejournal\vyuha.sqlite
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
