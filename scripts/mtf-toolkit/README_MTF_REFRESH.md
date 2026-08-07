# MTF Refresh Toolkit

Re-pulls the India MTF (Margin Trading Facility) approved-scrip lists from each
broker's own feed, validates them, stores a dated snapshot, reports what changed
since last run, and rebuilds the workbook.

## Files

| File | Purpose |
|---|---|
| `refresh_mtf.py` | The refresher. Standard library only, except `openpyxl` for the workbook. |
| `refresh_mtf.bat` | Windows wrapper — double-click or schedule. Logs to `logs\`. |

## Setup

```bat
pip install openpyxl
```

Drop the files in a folder of your choice. Everything else is created on first run:

```
<your folder>\
    refresh_mtf.py
    refresh_mtf.bat
    groww_accumulate.js       browser harvester for Groww
    input\                    YOU put two files here (see below)
    mtf_history.db            SQLite snapshot history
    raw\                      dated raw payloads, exactly as received
    output\                   workbook + CSVs + watchlists
    logs\                     one log per batch run
```

### The two local inputs

Five brokers refresh entirely online. Two need a file in `input\`:

| Broker | File | Where it comes from | How often |
|---|---|---|---|
| Angel One | `*SCRIPCATEGORY*.xlsx` | Angel back office | monthly |
| Groww | `groww_mtf*.csv` | `groww_accumulate.js` in your browser | when you want it fresh |

Newest matching file wins. **If either file is missing the run does not fail** —
that broker is skipped with a warning and the other five still refresh.

Paths live in the `CONFIG` block at the top of `refresh_mtf.py` if you want them elsewhere.

## Running

```bat
refresh_mtf.bat                           :: full refresh, all five brokers
refresh_mtf.bat --brokers dhan,kotakneo   :: subset
refresh_mtf.bat --history 30              :: last 30 snapshots, no network calls
refresh_mtf.bat --no-excel                :: data only, skip the workbook
refresh_mtf.bat --recalc                  :: cache formula values via LibreOffice
refresh_mtf.bat --min-move 0.5            :: only report margin moves >= 0.5pp
```

Broker keys: `dhan`, `zerodha`, `upstox`, `kotakneo`, `paytm`, `angelone`, `groww`.

### Harvesting Groww

Groww renders 100 rows per filter/sort view and no list API works, so the list
is swept in the browser:

1. Open `https://groww.in/stocks/mtf/list`, F12 → Console
2. Type `allow pasting`, Enter (once per site)
3. Paste `groww_accumulate.js` — it arms and auto-harvests every 2.5 seconds
4. Change filters and sorts. **Scroll each view top to bottom** — the table
   virtualises, so only rendered rows are captured
5. `DD()` downloads the CSV → drop it in `input\`

`DS()` prints the count, `DC()` clears the store. It persists in localStorage
and survives reloads, so you can stop and resume.

Two things that cost a lot of time to discover, worth not rediscovering:

- **The 100-row cap is per VIEW, not per account.** Each market-cap bucket,
  price-change band and indicator filter surfaces a different 100. Selecting
  *all four* market-cap buckets is identical to no filter — select one at a
  time. Small-cap and micro-cap views yield the most, because the default sort
  is by turnover and therefore all large caps.
- **Read the rendered table, not the page's embedded JSON.** The page ships a
  server-rendered JSON blob of the original default 100 which does NOT update
  when filters change. An earlier harvester read that blob and appeared stuck
  at 100 no matter what was swept.

The script accepts either shape: the DOM sweep (`slug,cells`) or the older JSON
sweep (`nseScriptCode,mtfHaircut,...`).

Or call Python directly: `py -3 refresh_mtf.py [same flags]`.

## Output

- `output\India_MTF_Stock_Lists.xlsx` — current workbook, overwritten each run
- `output\<date>_India_MTF_Stock_Lists.xlsx` — dated archive copy, kept
- `output\mtf_<broker>.csv`, `output\mtf_all_brokers.csv` — flat files for pipelines
- `output\watchlist_<broker>_funded.txt` — `NSE:SYMBOL` per line, funded scrips only,
  ready to paste into TradingView or Chartink
- `raw\<timestamp>_*` — the untouched payloads, so any figure stays traceable

## The change report

After the first run, each refresh prints what moved since the previous snapshot:

```
CHANGES vs 2026-08-06
  Dhan:
    added               1  RELIANCE
    removed             1  FAKEDELISTED
    margin hiked        2  MANALIPETC 50->100%, MVGJL 50->100%
    margin cut          0
    funding withdrawn   2  MANALIPETC, MVGJL
```

This is the part worth reading. A scrip leaving a list, or a margin hike on
something you hold, changes your position sizing and can trigger a shortfall —
`funding withdrawn` in particular means a scrip that was funded yesterday is now
at 100% margin.

## The validation gate

Nothing is written if a feed looks wrong. The script refuses on:

- fewer than 500 rows from any broker (truncated feed)
- duplicate ISINs or duplicate symbols
- blank symbols, or more than 5% of rows left without an ISIN after backfill
- margin outside 0–100, or a funding split not summing to 100
- published leverage disagreeing with 100 ÷ margin beyond that broker's
  rounding precision (Paytm publishes leverage to 1dp, so it gets a wider
  tolerance than the rest; Kotak's margin is derived from leverage and agrees
  by construction)
- **Upstox**: captured count not matching the API's own `totalRecords`
- **Kotak Neo**: fewer rows than 30 × (pages − 1)

Those last two matter most. Both brokers are paginated, so a silent partial
pull is the realistic failure mode — each exits 2 rather than writing a short
list.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | A broker feed could not be fetched |
| 2 | Validation failed — nothing written |
| 3 | Bad arguments, or `openpyxl` missing |

## Scheduling

Task Scheduler → new task → Action: `Start a program` → your `refresh_mtf.bat`.
Comment out the final `pause` line in the batch file first, or the task never
exits. Run it after market close, since Dhan restates its sheet intraday.

## Broker-specific quirks

**Kotak Neo** publishes leverage and a per-scrip exposure cap, but no margin
percentage and no ISIN. The margin column is derived as 100 ÷ leverage and
inherits Kotak's 2dp rounding, so it is accurate to roughly ±0.2pp — it is the
only inferred margin in the workbook, and its column header says so. ISINs are
backfilled by symbol from the other four brokers; a handful of Kotak-exclusive
names have none and fall back to a symbol key in the cross-broker sheet.

**Paytm Money** rounds published leverage to 1 decimal, so the leverage check
can differ from the published figure by up to 0.05x. The margin percentage is
exact.

**Angel One** publishes no per-scrip margin. The approved list is authoritative
(their own file), but the margin is modelled from NSE's official VaR file:

```
base   = VaR + 5 x ELM
margin = base            for non-F&O scrips
margin = 0.8513 x base   for F&O scrips
```

Calibrated against 17 readings from Angel's own Margin Calculator: MAE 0.008pp,
worst 0.07pp, four exact to the paisa. The F&O figure is a *constant*, not a
regression — the implied multiplier ranged 0.85117–0.85142 across 11 F&O
readings (sd 0.00006) — so there is no fitted range to extrapolate beyond.

**The VaR snapshot matters.** NSE publishes six intraday `C_VAR1` files per day.
The rate applied for a trading day is **snapshot 1 of that date** (identical to
snapshot 6 of the prior day). Using a later snapshot degrades accuracy about
eightfold, from 0.008pp to 0.061pp. The script always takes snapshot 1 and walks
back up to 8 days for weekends and holidays.

**Groww** publishes neither symbol nor ISIN on its list surface. Symbols are
resolved from the URL slug and company name against the other brokers, so
`fetch_groww` runs last and the script enforces that ordering. Rows are
de-duplicated on slug, then again on resolved symbol. Fund and ETF names are
never fuzzy-matched — near-identical passive-fund names collide (an FMCG ETF
onto a gold ETF) and would silently corrupt the mapping. Groww also gets a
looser missing-ISIN tolerance (20% vs 5%) because it lists many passive funds
no other broker in this set carries.

**Angel One and Groww are excluded from the cross-broker margin columns** — one
because its margin is modelled rather than broker-published, the other because
its list is swept view by view and is not provably exhaustive. Both get full
sheets of their own. Mixing either into the comparison would corrupt
`Brokers Offering` and `Best Margin`.

**Ties are compared at 2 decimal places.** Kotak Neo's margin is derived from a
2dp leverage figure and carries spurious extra decimals — on IXIGO it reads
38.7597 against 38.76 from three other brokers. Comparing raw would crown Kotak
sole winner on a 0.0003pp artifact and hide a genuine four-way tie.

**Text from broker feeds is sanitised before it reaches a cell.** One Groww slug
arrived as the literal string `#NAME?` from an upstream spreadsheet round-trip
and broke the workbook recalc; anything starting `=`, `+`, `@` or looking like a
spreadsheet error is neutralised.

**The `--min-move` threshold** exists because of Kotak. One tick of its 2dp
leverage moves the derived margin by roughly 0.15pp, which would otherwise fill
the change report with noise. The default of 0.25pp is below anything that
changes position sizing on a realistic ticket. Set `--min-move 0` to see every
move.

## Adding the remaining brokers

`FETCHERS` at the bottom of the fetcher block is a plain dict. To add Groww or
Angel One, write a function returning a list of `rec(...)` calls and register it:

```python
def fetch_groww(stamp):
    ...
    return [rec(symbol, isin, margin, broker_funding, leverage, category="..."), ...]

FETCHERS["groww"] = fetch_groww
DISPLAY["groww"]  = "Groww"
```

Validation, SQLite, diffing, CSVs, the workbook and the cross-broker sheet all
pick it up automatically — the cross-broker columns and summary formulas are
generated from whichever brokers are present. The blockers on each pending
broker are recorded in `PENDING_BROKERS` near the top of the file and surface on
the workbook's README sheet.

Both remaining brokers are login walls rather than technical puzzles: Groww's
screener API returns zero results without an authenticated session, and Angel
One's `/mtf-stocks-list` redirects to its customer login page. Sahi is listed
there too, but as excluded by design — it does not offer MTF at all.

## Caveats worth keeping in mind

- Endpoints are undocumented internal feeds, not published APIs. They can move
  without notice. If a fetch starts failing, the `CONFIG` block at the top is the
  only place to look.
- Formula cells carry no cached values until something computes them. Excel does
  this on open. If you read the workbook headlessly with pandas or
  `data_only=True`, either run with `--recalc` or read the CSVs instead.
- These lists are snapshots. Margins track exchange VAR + ELM plus broker RMS
  policy, and the published margin is a ceiling — surveillance flags, F&O ban
  periods and account-level caps can all reduce real leverage at order time.
