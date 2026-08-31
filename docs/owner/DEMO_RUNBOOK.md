# Live Demo Runbook — v3.5.0

Demo #1 failed on surprises, not on the product. This runbook exists so demo #2
runs on rails: what to prepare, what to show in what order, and what to say if
something looks wrong. Follow it top to bottom the day before, then keep the
"if it goes wrong" table open during the demo.

---

## The day before

1. **Machine prep**
   - Install the actual v3.5.0 release artifact (not a dev build) on the demo
     machine. If it was upgraded from v3.4.0, confirm the in-app update flow
     completed and the sidebar footer reads **v3.5**.
   - Settings → set **equity capital AND active capital**. On a fresh install
     every %-figure honestly reads "—  · set capital in Settings" — correct
     behaviour, wrong first impression on stage.
   - Activate the Pro licence. Half the demo (Arjun's Eye, lenses edge columns,
     tax pack) is Pro.
   - Name the account(s) properly — "All accounts" + "Account 1" on screen
     reads unfinished.
2. **Files on the desktop, in a folder named `demo-imports`**
   - A Zerodha **tax P&L** workbook (`taxpnl-*.xlsx`) — the hero import.
   - A Zerodha **tradebook** as the second import (shows dedup/append).
   - Optionally the Paytm tradebook (charges reconciliation story).
   - Nothing else in the folder. A stray file that routes to the column mapper
     mid-demo is an unforced error.
3. **Dry-run the exact click path below once, on the demo machine.** Not on
   the build machine — on the machine that will be on the projector.

## Import rules on stage

- Import **Zerodha or Paytm files only** — the formats with verified parsers
  and reconciliation stories.
- Do **not** demo the generic column mapper unless asked; if asked, present it
  as the honest fallback ("a question beats a confident wrong answer").
- Do **not** enter an IPO exit with a blank date on stage.
- After the taxpnl import, the summary line reads
  "N exit rows → M positions (grouped per symbol + entry day + exit day)".
  **Say it before anyone asks**: "632 rows become 206 positions because
  Zerodha writes one row per exchange execution — six 75-lot rows are one
  order. The journal counts trades the way the trader took them." This exact
  aggregation question is what sank demo #1.

## The walk (suggested order, ~12 minutes)

1. **Import** the taxpnl file → point at the warning strip: entry/exit
   timestamps, per-trade charges "stored as the broker's own figures".
2. **Trades** → open one options trade → the charges are Zerodha's own, to the
   paisa. One sentence: "we don't out-argue the broker about money it levied."
3. **Arjun's Eye** → the five Trade Craft tabs. Lead with **Winners vs
   losers** (the quadrant against the breakeven curve is the money shot),
   then **Stop-losses** — read the coverage line out loud: "SL recorded on 0 of
   N losers — the tab tells you what it needs; it never invents".
4. **Lenses** → drill into a month → click the Net P&L card → the popup with
   top winners/losers + a Vyuha Intelligence line.
5. **ITR Pack** → the two-basis turnover table. The line that lands:
   "Zerodha's own report and the ICAI method differ 6-8× on this same book —
   Vyuha is the only journal that shows you both and tells you to ask your CA
   which applies."
6. **Tax Harvest** → tick two lots in the what-if simulator, watch the tax
   saved recompute. Say "nothing is pre-selected — Vyuha never tells you what
   to sell; SEBI draws that line and so do we."
7. **Close on the promise**: offline, deterministic, describes your own
   record, tuned by user requests.

## If it goes wrong — say the honest thing

| Symptom | What it actually is | What to say |
|---|---|---|
| Import counts ≠ broker row count | Scrip-day aggregation (deliberate) | The one-order-many-executions line above |
| "—" where a % should be | Capital not set / data not recorded | "Vyuha refuses to invent a number — that dash is a feature" |
| A tab says "not enough data yet" | Sample floor refused an insight | "Below ~20 trades any claim would be noise; it says so instead" |
| Dates show "—" after a Console P&L import | That report states no dates | "The export has no dates; the tradebook or tax P&L does — never guessed" |
| Turnover looks huge vs broker | ICAI vs broker basis | Show the two-basis table — it IS the demo |
| Anything crashes | Unknown | Note it, move to the next surface, log it after. Do not debug on stage. |

## After the demo

- Write down every question you couldn't answer — those are v3.6 inputs (the
  owner's promise: features tuned by user requests).
- If a file failed to import, get a redacted copy — that's how Paytm and the
  tax P&L became first-class parsers.
