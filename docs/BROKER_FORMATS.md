# Broker export formats — verified column maps

Extracted 2026-08-12 from real exports using the project's own `xlsx` module
(`XLSX.read(buffer)`), so these layouts are what the parsers will actually see.

**Every layout below is VERIFIED against a real file.** Nothing here is inferred
from documentation. Where a file carried no data rows, that is stated — the
header is still verified, but value-level behaviour is not.

Source files live in `tests/fixtures/private/` (gitignored — they carry client
codes, PANs and names). This document deliberately contains **no identifiers**.

> ⚠️ **The 2026-08-12 samples are schema-only.** Of six files, only one contained a single
> data row. They are sufficient to fix detection and column mapping; they are
> NOT sufficient to verify that parsed values (prices, P&L, charges) are correct.
>
> **2026-08-20 — a second batch WITH data** (also in `tests/fixtures/private/`,
> redacted schema-only copies in `tests/fixtures/redacted/`): a Paytm Money
> tradebook with **414 executions** and its Equity P&L (`.xls`, 3 sheets, 124
> realised lots), a Zerodha Console tradebook with **1,554 fills** and a
> Console P&L with 53 rows, and three Upstox reports that were **schema-only**
> (that account had no trades). Value-level behaviour was therefore VERIFIED for
> Paytm and Zerodha tradebooks and INFERRED for Upstox.
>
> **2026-09-04 — Upstox is no longer schema-only.** `tests/golden-books.test.ts`
> now pins two POPULATED Upstox exports: a realised-P&L export whose single row is
> checked against Upstox's own stated figures (gross −1.05, net −4.28, charges
> 3.23, met to the paisa by the engine's estimate), and a trade report of 11
> executions → 4 positions committing net −271.90 (a trade report states neither
> P&L nor charges, so that one pins our own arithmetic, not the broker's). Upstox
> value behaviour is therefore VERIFIED for the realised-P&L export and pinned for
> the trade report; the Upstox ledger still has no parser. What the data
> changed is recorded per broker below and in DECISIONS.md 2026-08-20.

---

## The detection problem these solve

`AGENTS.md` requires: *a broker-named parser must see the broker's NAME before it
claims a file*. Filenames are unreliable (Groww's stock order history is called
`Stocks_Order_History_<code>_<from>_<to>.xlsx` and names no broker). So each
format needs an **in-content fingerprint**. Every file examined has one:

| Format | In-content fingerprint (use this, not the filename) |
|---|---|
| Zerodha Tradebook | `Auction` column — no other broker emits it. Plus `Trade ID` + `Order ID`. |
| Zerodha Console P&L | Charge account heads suffixed `- Z` (`Brokerage - Z`, `Central GST - Z`) |
| Zerodha Console tax P&L | `View Zerodha's guide…` preamble line + `Tradewise Exits` table (`Entry Date`/`Exit Date`/`Turnover`/`Profit`) on sheet 0, `- Z` heads on sheet 1 — detection must read ALL sheets |
| Paytm Money Tradebook | `UCC` label in A1 + `Script` (sic) + `ETT` column |
| Paytm Money P&L | `UCC` in A1 + `Unrealized P/L Summary` / `Realized P/L Summary` |
| Angel One Tax P&L | `Angel One Limited` in `Summary!A1` |
| Angel One Ledger | `Angelone charge` column in the `Charges` sheet |
| Groww Stocks P&L | Sheets named `Trade Level` / `Scrip Level` |
| Groww Stocks Order History | `Unique Client Code` header — Groww-specific phrasing |
| Upstox trade report / realised P&L | `UPSTOX SECURITIES PRIVATE LIMITED` in A1 (the legal name), header 11 / 22 rows down |
| Paytm Money Equity P&L (`.xls`) | section titles `Unrealized P/L Summary (As on …)` / `Realized P/L Summary (From …)` — no parser, mapper |
| Angel One Trades_History | NO name anywhere. Sheet `TradesAndCharges` + header with `Scrip/Contract`, `IPFT Charges`, `Order ID`, `Trade ID` together — a FORMAT fingerprint (2026-09-04) |
| Dhan P&L (`.xlsx`) | sheet named `Dhan_P&L` + the twelve-column `Scrip Name … Unrealised P&L %` header |
| Dhan Realised P&L (`.xls`) | segment-summary header `Segment | Buy Value | … | Net P&L` + the legal name `Raise Securities Private Limited` in the footer (the file never says "Dhan") |
| Dhan Ledger (CSV) | header `Posting Date, Posting reference, Description, Narration, Credit, Debit, Net Balance` — `Posting reference` is Dhan's phrasing |
| Dhan Dividend payout (CSV) | header `Date, Scrip Name, Dividend Per Share, Quantity, Dividend Paid` under a `Dividend payout report` title |

---

## Zerodha

### Tradebook (XLSX) — per execution
Single sheet `Sheet1`, header row 1, data from row 2.

```
Symbol | ISIN | Trade Date | Exchange | Segment | Series | Trade Type |
Auction | Quantity | Price | Trade ID | Order ID | Order Execution Time
```

- `Trade Type` is buy/sell. **No charge columns** — charges must come from the
  Console P&L or a contract note.
- **Console export variant (real, 2026-08-20, 1,554 fills):** an 8-row preamble —
  `Client ID` on row 1, `Tradebook for Equity from <from> to <to>` on row 5,
  header on row 9. `Trade Date` is a numeric Excel date serial (renders
  `2026-04-01`); `Order Execution Time` renders `2026-04-01 11:14:28` — the
  parser now reads fill TIMES from it. `Series` carries SME series (`SM`, `ST`,
  `M`, `MT`, `BE`, `B`, `X`, `A`, `T`) besides `EQ`. There is **no Product
  column** in this export. `Auction` is `false` throughout. Sell-only symbols
  are common (8 of 23 in the sample — holdings bought before the window), so the
  tradebook is paired SAME-DAY-FIRST then FIFO (see `lib/import/pair-legs.ts`) and
  an unmatched sell is an *opening sell* with `basisUnknown`, never a 100% gain.
- Sample had `!ref=A1:M3292` but only the header was non-empty: 3,291 formatted
  blank rows. A row-count check must ignore empty rows or it will claim 3,291 trades.

### Console P&L (XLSX) — aggregated
Single sheet. **Data begins at column B** (`!ref=B1:N91`) — a parser assuming
column A is off by one.

Preamble sections in column B: `Client ID`, `P&L Statement for Equity`, `Summary`,
`Charges`, `Other Credit & Debit`, `Realized P&L`, `Unrealized P&L`.

Charges block is `Account Head | Amount`. NINE heads carry the `- Z` suffix on
the real export (re-verified 2026-08-12 — stronger than first recorded):
`Brokerage - Z`, `Exchange Transaction Charges - Z`, `Clearing Charges - Z`,
`Central GST - Z`, `State GST - Z`, `Integrated GST - Z`,
`Securities Transaction Tax - Z`, `SEBI Turnover Fees - Z`, `Stamp Duty - Z`.
The detector requires ≥2 such heads anywhere in the sheet — they sit one per
ROW in the charges block, not in the trade-table header.

Trade table:
```
Symbol | ISIN | Quantity | Buy Value | Sell Value | Realized P&L |
Realized P&L Pct. | Previous Closing Price | Open Quantity |
Open Quantity Type | Open Value | Unrealized P&L | Unrealized P&L Pct.
```

**Column-A variant (real, 2026-08-20, 53 rows):** the sheet starts directly at
the charges block in column A (8 `- Z` heads — no `Brokerage - Z` — plus
`IPFT`), four blank rows, then the trade table with the header on row 14. Three
rows carry an ISIN in the `Symbol` cell with an empty ISIN and zero quantity
and values (delisted/merged scrips) — skipped, not imported as empty trades.
`Open Quantity` / `Unrealized P&L` describe holdings, not trades.

### Console tax P&L (`taxpnl-<client>-<fy>-Q1-Q4.xlsx`) — per EXIT, with full charges
**VERIFIED with two real F&O exports (2026-09-01: FY2024-25, 632 rows; FY2025-26,
59 rows).** Two sheets; **data begins at column B** on both.

- Sheet 0 `Tradewise Exits from <date>`: preamble (`View Zerodha's guide on
  using tax reports for filing.` — the in-content broker name — then
  `Client ID`/`Client Name`/`PAN`, the FY window line), then one or more
  SECTIONS: a single-cell label row (`F&O`, `Currency`, `Commodity`), its own
  header row, then data. Sections after the first can be empty (the FY24-25
  file carries empty Currency and Commodity sections with bare headers).
  ```
  Symbol | Entry Date | Exit Date | Quantity | Buy Value | Sell Value |
  Profit | Turnover | Brokerage | Exchange Transaction Charges | IPFT |
  SEBI Charges | CGST | SGST | IGST | Stamp Duty | STT
  ```
  Entry/Exit are FULL timestamps (`2025-04-02T09:29:49`). Symbols are compact
  NSE/BSE contract names (`NIFTY2540323750CE`) — see `parseCompactName` in
  `lib/engine/classify.ts`. `Profit` is GROSS (≡ Sell − Buy); Zerodha's
  `Turnover` ≡ |Profit| (differences-only basis, NO premium — 6.5–8.7× below
  the ICAI 11th-ed. figure on the same rows). Zerodha splits one order into a
  row per execution; the parser groups rows per symbol + entry day + exit day
  (the tradebook's scrip-day unit) and keeps each row as an execution pair.
- Sheet 1 `F&O`: realized-profit + turnover breakdown and a charges block with
  the `- Z` heads (`IPFT` unsuffixed) — the fingerprint sheet. Reconciliation
  on the real files: Σ Profit matches the stated realized profit EXACTLY both
  years; charges match to the paisa on FY25-26, and FY24-25's summary carries
  ₹187.31 the tradewise rows don't (entry-side charges of positions still open
  at FY end — the sheet lists exits).
- Detection trap this format exposed: the trade table and the fingerprint live
  on DIFFERENT sheets, so a first-sheet-only `toMatrix` scored it 0 and the
  file fell to the column mapper. Detection reads all sheets now.

---

## Paytm Money

### Tradebook (XLSX) — per execution, **with full charges**
`Sheet1`. Rows 1–4 are metadata (`UCC`, `Name`, `PAN Number`, `Period`).
Header on row 5.

```
Date | Script | ISIN | Exchange | Product Type | Type | Quantity | Price |
Brokerage | ETT | GST | STT | SEBI | Stamp Duty | Order Number |
Trade Number | Trade Time
```

- **The richest tradebook of the three brokers** — per-execution granularity *and*
  a complete per-trade charge breakdown. Zerodha's tradebook has neither.
- Column is `Script`, not `Symbol` or `Scrip`.
- **VERIFIED with 414 real executions (2026-08-20, export named `Tradebook_EQ.xlsx`):**
  - `Script` holds a **numeric scrip code** (six digits; BSE-code-like on BSE
    rows, Paytm's own id on NSE rows), **not a ticker**. `ISIN` is always
    filled — Vyuha resolves the symbol from the ISIN at commit (instruments
    table, then the bundled snapshots) and otherwise keeps the code.
  - **The code does NOT tell you the exchange, so never resolve by code —
    resolve by ISIN.** Re-measured on a second real export (7,544 executions,
    2026-08-30): 544xxx codes, which look like BSE codes, appear on NSE rows
    too (e.g. `544838` / XTRANET on NSE), and 30 of 215 distinct codes appear
    on BOTH exchanges. An ISIN identifies the security regardless of which
    venue the fill happened on, which is why the lookup is keyed on it.
  - **Coverage needs BOTH exchanges' lists.** Of that export's 215 distinct
    codes, the index-constituent map alone resolved 76; of the 139 misses, 69
    sat only on BSE rows. The bundled `lib/data/isin-symbols.json` (NSE main +
    NSE Emerge + BSE, 5,671 securities) resolves all 215.
  - `Product Type` is `EQ` on every row — the SEGMENT, not delivery/intraday.
    Product is derived per scrip-day from Paytm's own STT and stamp duty
    (`lib/import/product-signature.ts`).
  - STT and stamp duty for a scrip-day are **booked on one execution row** of
    that day (the last one), not spread per fill — e.g. four buys whose STT
    reads 0 / 0 / 0 / 1960.08, where 1960.08 = 0.1% of the day's total buy
    value. Sum per scrip-day before inferring product.
  - `Trade Time` is empty exactly on the rows whose `Trade Number` is `0`
    (1,856 of 7,544 in the 2026 export — every one of them), and carries an
    `HH:MM:SS` clock on the rest (5,688). The 414-row export of 2026-08-20 was
    ALL trade-number-0 rows, which is why this used to read "empty on every
    row". `Order Number` is a 16- or 19-digit id. Dates are `dd-mm-yyyy`.
  - **`Script` switches label mid-window.** The same security appears as a
    ticker (`HVAX`) in the early months and as a numeric BSE code from July
    2026 onward — 35 of the 281 ISINs in the 2026 export were seen under
    BOTH, and the file is numeric-only from July. Pairing by `Script` split
    such a security into two books: the ticker's buys were left "open" and
    the code's sells became "opening sells" with no cost basis.
  - **Pairing is by ISIN** (2026-09-04): fills group on `ISIN` (plus the
    stated product), `Script` only when a row has no ISIN. The displayed
    symbol is the first NON-numeric label seen for that ISIN anywhere in the
    file, else the code (which commit still resolves via ISIN). ISIN +
    Exchange was measured and rejected: the same security sold on BSE after
    being bought on NSE would again be two books (101 opening sells vs 38).
    The parser reports how many securities it saw under two labels; the
    import screen repeats it as "N securities appeared under two labels —
    paired by ISIN".
  - **Same-day round trips are NOT all intraday.** Of 83 in the 2026 export,
    34 are intraday by the charge signature (stamp duty between the two
    rates) and 49 are genuine CNC delivery — stamp 0.015% on the buy AND STT
    0.1% of buy **plus** sell. `corroborate()` therefore uses buy+sell as the
    delivery STT base for a two-sided row. A scrip-day whose stamp duty sits
    between the two rates is split by `splitMixedRow` into an intraday pair
    and a delivery remainder (quantities by the derived fraction, rounded to
    whole shares; values and charges pro-rata).
  - The word "Paytm" appears nowhere in the file; the `UCC` label and the
    `Script` + `ETT` header are the fingerprint, as before.

### P&L (XLSX) — two sections
`Sheet1`, `!ref=A2:I73`. Metadata rows, then:

`Unrealized P/L Summary (As on …)`
```
Scrip Name | ISIN | Quantity | Buy Average | Buy Value | Closing Price |
Present Value | Unrealized P&L | P&L%
```

`Realized P/L Summary`
```
Scrip Name | ISIN | Quantity | Buy Average | Buy Value | Sell Average |
Sell Value | Realized P&L
```
Terminated by a `Total` row.

### Equity P&L (`.xls`, 3 sheets) — the download Paytm serves today (real, 2026-08-20)
File `<UCC>_EquityP&L_<from>_<to>.xls` (BIFF), sheets
`Summary P&L | Realized P&L Detail | Unrealized Transactions`; each sheet has
`UCC`/`Name`/`PAN number`/`Period` label rows, dates are `dd-Mon-yyyy`.

- `Summary P&L` — the two sections above (`Unrealized P/L Summary (As on …)`
  with the 9-column header; `Realized P/L Summary (From … – …)` with the
  8-column header), each closed by a `Total` row.
- `Realized P&L Detail` — **one row per matched lot**:
  `Scrip Name | ISIN | Quantity | Buy Date | Buy Price | Buy Value | Sell Date |
  Sell Price | Sell Value | P&L Value`, `Total` row. Lots bought before the
  period appear with their original buy date. This is the broker-stated
  reference the tradebook is reconciled against (DECISIONS.md 2026-08-20).
- `Unrealized Transactions` — open lots:
  `Scrip Name | ISIN | Type | Quantity | Date | Price | Value`, `Total` row.

Still **no parser** (mapper): the tradebook is the import path; this file is a
reconciliation reference. The generic mapper reads the first sheet only.

---

## Angel One

### Tax P&L (XLSX) — 5 sheets
`Summary | Equity+Bonds+SGB Trade Details | Derivatives Trade Details | Non Trade Charges | Dividend Report`

`Summary!A1` contains `Angel One Limited …` — the fingerprint.

**`Equity+Bonds+SGB Trade Details`** — a summary block (rows 0–9), then several
independently-headed sub-tables. Each sub-table is preceded by its own title row,
so a parser must scan for section titles rather than assume one header:

| Section | Columns |
|---|---|
| `Intraday (Speculation)` | ISIN, Scrip Name, Qty, Transaction Date, Avg Buy Price, Buy Value, Avg Sell Price, Sell Value, Charges and Statutory, STT, Taxable P&L |
| `Delivery P&L` | ISIN, Scrip Name, Qty, Buy Date, Sell Date, Avg Buy Price, Buy Value, Avg Sell Price, Sell Value, Cost Of Acquisition, Charges and Statutory, STT, Net Profit/Loss, Long term taxable income, Short term taxable income, Purchase Type, Type of instrument |
| `Buyback Transactions` | as Delivery, with Buyback Date / Buyback Price / Buyback Value |
| `Transfer Transactions` | as Delivery, with Transfer Date / Transfer Price / Transfer Value |
| `Open Sell` | ISIN, Scrip Name, Quantity, Sell Date, Avg Sell Price, Sell Value, Charges and Statutory, STT |
| `Open Holdings as of 31…` | ISIN, Scrip Name, Quantity, Avg Buy Price, Buy Value, Charges and Statutory, STT, Closing rate, Turnover, Short term Unrealised P&L, Long term Unrealised P&L |
| `Qty Breakup` | ISIN, Scrip Name, Total Qty, **DP Qty, Pool Qty, CUSPA Qty, MTF Qty, Pledge Qty**, Long term quantity, Short term quantity |

> `Qty Breakup` carries an explicit **MTF Qty** column. Angel One is the only
> examined broker that states MTF quantity directly — Groww's parser has to warn
> and ask the user to re-tag. Worth using where available.

**`Derivatives Trade Details`**

| Section | Columns |
|---|---|
| `Futures` | Segment, Symbol Name, Expiry date, Qty, Buy Date, Sell date, Avg Buy Price, Buy Value, Avg Sell Price, Sell Value, Total Charges and Statutory, STT, Closing Price(31/03/…) ×2, Taxable P&L, Turnover |
| `Options` | Segment, Symbol Name, Expiry date, **Strike Price, Option Type**, Qty, Buy Date, Sell date, Avg Buy Price, Buy Value, Avg Sell Price, Sell Value, Total Charges and Statutory, STT, Taxable P&L, Turnover |

**`Non Trade Charges`** → `Charge | Posting Date | Debit Amount | Credit Amount`

**`Dividend Report`** → `ISIN | Scrip Name | Dividend Date | Qty | Dividend Rate | Dividend Amount`

### Ledger (`YourStatement_<code>.xlsx`) — 2 sheets

`Broking Ledger` → `Transaction | Date | Segment | Voucher | Debit | Credit | Running Balance`

`Charges`, day-wise, four independently-headed sections:
- DP Charges → `Scrip Name | ISIN | Date | Quantity sold | CDSL charge | Angelone charge | GST | Total charge`
- Pledge/Unpledge → as above plus `Pledge/Unpledge | Pledge/Unpledge type`
- CUSPA Sell-off → `Scrip Name | Date | Charges levied | GST | Total charge`
- Interest → `Type of Interest | Date | Interest applicable amount | Interest charges`

### Tradebook (`Trades_History_<code>.xlsx`) — per execution, **with per-row charges** (real, 2026-09-04)

One sheet, `TradesAndCharges`. The word "Angel" appears nowhere — not in the
filename, not in a cell — so this is the one Angel layout claimed on a FORMAT
fingerprint: the sheet name together with `Scrip/Contract`, `IPFT Charges`,
`Order ID` and `Trade ID` in the header. Rows 1–31 are a label/value preamble
(`ClientCode`, `DateOfDownload`, `StartDate`/`EndDate`, a `Charges Summary` —
`Total Trades`, `Total Charges`, `Total Trade Charges`, `Total Non Trade
Charges`, then each trade head and each non-trade head); the table titled
`TradeBook And Charges` starts at row 34:

`Scrip/Contract | Buy/Sell | Buy Price | Sell Price | Quantity | Brokerage | GST | STT | Sebi Tax | Exchange Turnover Charges | Stamp Duty | Other Charges | IPFT Charges | Order Type | Segment | Exchange | Order ID | Trade ID | Date`

What the parser does with it: `Order Type` (Intraday / Delivery) is the
product; `Segment` is `CAPITAL` or `FUTURES` × `Exchange` NSE/BSE; the price
sits in `Buy Price` or `Sell Price` by side; `Date` is an Excel date with no
clock (it renders `8/27/26 0:00` — m/d/yy — so it is read US-order, and no
fill time is invented). Charges are the broker's stated per-row figures and
are stored as such. **Rows with quantity 0 and no Trade ID are the flat
per-order F&O brokerage lines** (₹20 + GST): they are summed into their
contract's charges and never into its quantity — which is why the real file's
24 rows are 17 `Total Trades`. F&O contracts come as `OPTSTK ICICIBANK Sep 29
2026 1550.00 CE (BT)` / `BSXOPT SENSEX …` / `OPTIDX NIFTY …` and are rewritten
to the classifier's `OPT <SYM> <DD Mon YYYY> <STRIKE> <CE|PE>`. The file's own
`Total Charges` includes non-trade charges (DP, AMC); `Total Trade Charges` is
the figure the rows sum to (verified: 157.79 of 252.19).

**The Zerodha misclaim this exposed.** `detectZerodha` awarded its tradebook
score to any header carrying `Trade ID` + `Order ID`, and claimed this file
at 0.50 while the Angel parser scored 0. The pair now needs something Zerodha
actually writes — the `Auction` column, `Order Execution Time`, the "Tradebook
for Equity from …" preamble, or a name — before it counts.

---

## Upstox

Three real exports examined 2026-08-20 were **all schema-only** (that account had
no trades). A fourth and fifth, examined 2026-09-04, are POPULATED and pinned by
`tests/golden-books.test.ts` — a realised-P&L export checked against Upstox's own
stated figures (gross −1.05, net −4.28, charges 3.23, met to the paisa) and a trade
report of 11 executions → 4 positions committing net −271.90. So the layouts below
are VERIFIED, and value behaviour is VERIFIED for the realised-P&L export and pinned
(against our own arithmetic, not a broker statement) for the trade report; the ledger
still has no parser. Filenames name no broker: `trade_<from>_<to>_<code>.xlsx`,
`realizedPnL_EQ_<from>_To_<to>_<code>.xlsx`, `ledger_<from>_To_<to>_trading_<code>.xlsx`.
**Fingerprint: `UPSTOX SECURITIES PRIVATE LIMITED` in A1** (then `(Formerly …)`,
`Dealing Office …`, `UCC`/`Name`/… label rows, `Report Time Period`, `Generated On`).
Every sheet ends with a footer note (`From 19-Jul-2025, our Broking …`).

### Trade report — sheet `TRADE`, header on row 11
```
Date | Company | Amount | Exchange | Segment | Scrip Code | Instrument Type |
Strike Price | Expiry | Trade Num | Trade Time | Side | Quantity | Price
```
`Company` is the name column (used as the symbol); `Trade Time` is a separate
time column; `Instrument Type` / `Strike Price` / `Expiry` carry F&O — the
tradingsymbol grammar for those rows is unverified, so such rows are flagged.
No product column.

### Realised P&L — sheet `REALIZED_PNL`, header on row 22
Preceded by `Segment | EQ`, a `P&L Summary` block (`Gross P&L`, `Net P&L`) and a
`Charges` block (`TOTAL`), then `Realised P&L Details`:
```
Scrip Name | Scrip Code | Symbol | ISIN | Scrip Opt | Qty | Buy Date | Buy Rate |
Buy Amt | Sell Date | Sell Rate | Sell Amt | Days | Total PL | Short Term |
Long Term | Speculation | Turn Over
```
`Speculation` ≠ 0 → intraday; `Short Term`/`Long Term` ≠ 0 → delivery (derived).

### Ledger — sheet `LEDGER_V3`
The schema-only sample carries `Wallet | TRADING` and **no column header at
all** — nothing to map, so no parser claims THAT copy, by design. A populated
export does have the header row and is read by `upstox-ledger` (below).

---

## Groww

### Stocks — Order History (XLSX) — parsed by `lib/import/parsers/groww-orders.ts` (2026-08-12)
Single sheet `Sheet1`, one header row.

```
Name | Unique Client Code | Stock name | Symbol | ISIN | Type | Quantity |
Value | Exchange | Exchange Order Id | Execution date and time | Order status
```

Three traps:
1. **No price column.** Price must be derived as `Value / Quantity`.
2. **No charges at all.** Must be sourced from the Stocks P&L summary or a contract note.
3. **The word "Groww" appears nowhere** — not in a header, cell, or sheet name
   (`Sheet1`). Only `Unique Client Code` is distinctive.

### Stocks — P&L (XLSX) — supported
Sheets `Trade Level` (+ `Scrip Level`). Parsed by `lib/import/parsers/groww-xlsx.ts`.

---

## Dhan (real exports, 2026-09-04 — two accounts each)

Five files, one broker, and only ONE of them carries dates and a product. Every
Dhan detector stands down explicitly on the other four headers (a `Scrip
Name` column and a `Date` column are common to three of them), and none may
claim a file on the word "dhan" in the filename — that is exactly how the
ledger and the dividend report were being filed as a P&L until this batch.

### Global Transaction Report (CSV) — per bill, dates + product by signature

`Date | Scrip Name | Exchange | Bill No. | Buy Qty. | Buy Value | Sell Qty. | Sell Value | Brokerage | GST | STT | SEBI Fees | Stamp Duty | Txn. Charges | Oth. Charges | Gross Amount`
under a `Global transction report` (sic) title. The only Dhan file with dates.
Product is DERIVED from the charge signature (`dhan-gtr.ts`, `productDerived`).

### P&L (CSV **and** XLSX) — per scrip, no dates, no product

`Scrip Name | Buy Qty. | Avg. Buy Price | Buy Value | Sell Qty. | Avg. Sell Price | Sell Value | Closing Price | Realised P&L | Realised P&L % | Unrealised P&L | Unrealised P&L %`
after a `PnL report | From … to …` line. The `.xlsx` is the same table on a
sheet named `Dhan_P&L` (the marker — a workbook without it is not claimed);
its footer is four label/value ROWS (`Net P&L`, `Brokerage`, `Gross P&L`,
`Total Charges`) where the CSV writes one eight-cell line, and both land in
`reported`. F&O rows are `OPT …` / `FUT …` names among the equity rows with no
tag; the classifier reads the name. Verified: on both accounts the footer
holds Net = Gross − Total Charges to the paisa.

### Realised P&L Report (`.xls`) — per-segment charges, no dates, no product

Sheet `Realised P&L Report`, hundreds of merged ranges. Row 8 is the
segment summary — `Segment | Buy Value | Sell Value | Gross P&L | Brokerage |
Exch. Charges | SEBI Fees | GST | STT | Stamp Duty | Other Charges | Total
Charges | Net P&L` for `Equity` / `Futures and Options` / `Commodities` /
`Currency` — the ONLY Dhan file that breaks charges out by head, which makes
it the reconciliation reference (`reported.<segment>.<head>` plus totals).
Then one detail block per segment, each introduced by a title (`Equity
Segment`, `F&O Segment`, …) and its own header `Sr. | Security Name | ISIN |
Qty. | Avg. Buy Price | Buy Value | Avg. Sell Price | Sell Value | Realised
P&L | Realised P&L%` — found by TEXT (the equity block ran 19 rows on one
account, 157 on the other). Money is TEXT with thousands separators and a
trailing space; `-` means blank; ISIN is `-` on F&O; a `Generated on
dd-mm-yyyy` cell sits inside the equity data. The file never says "Dhan" —
the fingerprint is the legal name `Raise Securities Private Limited` in the
footer. Rows are closed lots (buy qty = sell qty); Currency rows are skipped
with a warning (no such segment). **Import EITHER the Global Transaction
Report OR this report for a window — never both.**

### Ledger (CSV) — the cash book

`Posting Date | Posting reference | Description | Narration | Credit | Debit | Net Balance`
on line 7 under `Ledger Statement,From … to …`. Two traps: the `OPENING
BALANCE` / `CLOSING BALANCE` rows are pinned at the TOP out of date order, and
on one account the opening row is dated **01-01-1970** (the epoch); the
opening figure sits in the CREDIT column with Net Balance at 0, and the footer
`Opening Balance,<v>,Closing Balance,<v>` restates it. Marker rows are never
emitted as entries, so the epoch can never become a window's start.
`Narration` is the readable text ("Money added to your Trading Account");
`Description` is the terse one ("Funds Deposited") — classification reads
both. Registered as `dhan-ledger` so the dropzone can name it; it imports on
the Cash & Ledger screen.

### Dividend payout (CSV)

`Date | Scrip Name | Dividend Per Share | Quantity | Dividend Paid` on line 7
under `Dividend payout report,From … to …`, dates as `dd-Mon-yy`, then
`Total Stocks Count,<n>,Total Dividend Earned,<₹>`. A cash file: it becomes
ledger rows of the dividend kind through the same Cash & Ledger door
(`parseDhanCashFile`), checked against its own stated total. Registered as
`dhan-dividend`.

All seven of these are BUILT as of 2026-09-04 — see the section below.

## Status (2026-09-05) — v3.9.0, built, audited (6 → fix → 3 → fix → 1 finders), release in progress 2026-09-05

Third batch: the owner's 29 real exports (two Dhan accounts, Paytm, Groww,
Zerodha, Upstox, Angel One), read in place and never copied into the repo;
27 redacted, still-populated copies now live in `tests/fixtures/redacted/`
under the three-row rule (every row kept, names/UCC/PAN replaced with fixed
tokens, ≥3 real rows per distinct case) and feed `tests/golden-books.test.ts`,
a release gate from v3.8.0 on: each file must route to its parser, produce an
EXACT position shape (closed / open / opening sells), tie to the broker's own
gross or net within tolerance, and conserve charges — then commit into a temp
DB and reproduce the same numbers. Frozen shapes: Paytm 7,544 → 693/62/38;
Zerodha tradebook 3,530 → 64/4/11; Zerodha tax P&L FY24-25 632 → 206/0/0,
FY25-26 59 → 26/0/0; Groww orders 952 → 466/1/16; Dhan P&L (account 1) →
1011/2/0. A golden row that goes to 0/0/0 is a stop-ship, never a re-pin.

What changed per broker:
- **Paytm** — `paytm-tradebook.ts` pairs on ISIN (see the tradebook section
  above), splits mixed scrip-days via `splitMixedRow`, uses buy+sell as the
  delivery STT base in `corroborate()`, and reports securities seen under two
  labels. Migration 0059 re-keys stored Paytm `dedupHash` values ISIN-first.
  The `Realized P&L Detail` sheet of the `.xls` still has NO parser (v3.9).
- **Dhan** — `dhan-gtr.ts` accepts both `dd Mon yyyy` and `dd-mm-yyyy HH:MM`
  (the 2026 export parsed to ZERO rows at a 0.98 score until this batch; an
  empty result on a detected GTR now warns with the unparsed sample). New
  parsers: Realised P&L `.xls` (`Raise Securities Private Limited` fingerprint,
  per-segment charge reference), P&L `.xlsx` (`Dhan_P&L` sheet), `dhan-ledger`
  and `dhan-dividend` as cash sources. Every Dhan detector stands down on the
  other Dhan headers, and none claims on the word "dhan" in a filename.
- **Angel One** — `Trades_History` tradebook parser on the `TradesAndCharges`
  format fingerprint; qty-0 per-order F&O brokerage lines fold into charges
  (Σ per-trade 157.76 vs stated 157.79 was the ₹0.03 leak the harness found).
- **Zerodha** — `detectZerodha` needs `Auction` / `Order Execution Time` /
  "Tradebook for" / a name before awarding the tradebook score; Console P&L
  and tax P&L `reported.charges` now carry the stated figure (FY24-25 ₹0.02
  column-vs-total rounding recorded).
- **Symbols** — `lib/data/isin-symbols.json` is 5,691 ISINs (NSE 2,568 + SME
  568 + BSE-only 2,555) carrying name, board, BSE code and series; the
  resolution chain gains a BSE-code lookup keyed on the code; `instruments-
  file.ts` reads today's SME list (`NAME_OF_COMPANY`, `ST` series).
- Workbook decode is memoised once per `ParseContext` (the ≤8-decode load
  bound had broken at 11 when the new detectors landed).

Still not built (as of 2026-09-04): the Paytm P&L parser, the Dhan MTF Report,
short-sell / cross-exchange pairing. (Everything else this line used to list —
Dhan DP charges, holdings and contract note, the Upstox and Angel One ledgers
and the Angel One P&L statement — shipped in v3.9; see "Reference and
enrichment sources" below.)

## Status (2026-08-20)

Second batch: `paytm-tradebook.ts` and `zerodha.ts` tradebook paths pair per
scrip-day via `lib/import/pair-legs.ts` — **same-day buys and sells net off first,
then oldest-lot FIFO, with inferred opening inventory seeded as the oldest lot**
(pure FIFO disagreed with Paytm's own statement on 52 of 60 scrips; DECISIONS
2026-08-20) (opening sells → `basisUnknown`, P&L blank);
`zerodha.ts` reads `Order Execution Time`; Paytm derives product from the
scrip-day charge signature and apportions its six stated charge components;
coded Paytm symbols resolve by ISIN at commit; `angelone-upstox.ts` fingerprints
Upstox on the A1 legal name and maps `Trade Time`, `Buy/Sell Date`,
`Buy/Sell Amt`, `Total PL`, `Speculation`. Seven more redacted fixtures in the
matrix test, plus a private block that replays the real files when present.

---

## Reference and enrichment sources (v3.9, 2026-09-04)

Seven formats that are **not books**. Six emit `reference` rows — figures the
broker states and Vyuha does not derive — and one emits `enrich` rows. None of
them creates a trade, and each says so in a warning of its own. The book for a
broker stays what it was: the tradebook or the Global Transaction Report.

They are registered sources all the same, so the dropzone can NAME the file
instead of misfiling it, and the import route lets a zero-trade parse commit
when it carries reference or enrichment rows (`app/api/import/route.ts`).

**Two of the seven name no broker anywhere**, and are the only format-only
claims in the repo: **Dhan DP Charges** and the **Angel One P&L statement**.
Both are owner-recorded exceptions to the AGENTS.md name rule, not precedents —
each is written up under its own heading below.

### Paytm Money — Realized P&L (`.xls`) → `paytm-realised-pnl`

Three sheets in a fixed order: `Summary P&L`, `Realized P&L Detail`,
`Unrealized Transactions`. **Fingerprint:** the detail sheet's header row —
`Scrip Name | ISIN | Quantity | Buy Date | Buy Price | Buy Value | Sell Date |
Sell Price | Sell Value | P&L Value`. Rows 0–3 of that sheet are UCC / Name /
PAN / Period — identity, read for nothing and emitted nowhere.

**Emits:** `reference` rows carrying what Vyuha cannot derive — Paytm's own
realised P&L per scrip and per FY, keyed by ISIN. **No trades:** this is Paytm's own lot-matching over the same
executions the Paytm tradebook already carries, so importing both would
double-count. **No charges:** the file states no brokerage, no STT, no GST — its
`P&L Value` is GROSS, and the parser says so in a warning rather than letting a
reconciliation read a gross figure as net. **Conservation:** the sheet's own
`Total` row is skipped as a row and used as a check — Σ P&L Value must equal it
to the paisa. Dates are `dd-MMM-yyyy`; a numeric day-first date whose day never
exceeds 12 is genuinely ambiguous and warns rather than guessing.

### Dhan — DP Charges (`dp-charges*.xls`) → `dhan-dp-charges`

One sheet, `DP Charges`. Title cell `DP Charges | From <d> to <d>`; header on
row 5: `Sr. | Date | ISIN | Security Name | … | Quantity | Buy/Sell | Type of
Transaction | | Charges` (columns 0,1,2,3,9,10,11,13 — the gaps are merge
padding), then one row per debit, a `Total <amount>` row and a
system-generated footer.

**Fingerprint — the FORMAT, because the file names no broker.** Nowhere in any
cell or sheet name does it say Dhan, or the legal entity. Owner ruling
(2026-09-04): the sheet must be called `DP Charges`, the title cell must say
`DP Charges`, and the header must be that exact eight-column set. The word
"dhan" in the filename adds a further 0.1. This is a deliberate exception to
the name rule and is recorded as such.

**The veto (2026-09-04).** Because the claim rests on format alone, a rival
broker shipping the same eight headers would be imported as Dhan and priced at
Dhan's rates. So the document's own letterhead, which cannot VOUCH for a broker
here, is allowed to VETO one: if a DIFFERENT known broker (zerodha / groww /
upstox / paytm / angel one) is named there, the score is 0 and the file falls
to the generic column mapper, which asks. The same veto guards the Angel One
P&L statement, the other format-only claim.

**The veto region — exactly three places, and no more (corrected 2026-09-04).**

1. the FILENAME;
2. every SHEET NAME in the workbook;
3. the TITLE / BANNER region — the rows **above** the header row (Dhan DP
   charges: above `Sr. | Date | ISIN | …`; Angel One P&L: above the 18-column
   and 16-column header rows on `Equity P&L` and `F&O P&L`).

The **data grid is never scanned**: no row at or below a header row takes part
in the veto. Scanning every cell was the first implementation and it was wrong
— PAYTM (One 97 Communications) and ANGELONE are LISTED COMPANIES the owner can
hold, so a Security Name of `ANGEL ONE LIMITED` or a Scrip Symbol of `PAYTM` is
the owner's own holding, not a rival's letterhead. It scored the owner's own
export 0 and dropped it into the hand-mapper. Both parsers pin this in tests:
the owner's file with a security named after each rival still scores ≥ 0.9, and
a rival's name in the title row still scores 0.

**Emits:** ledger rows (kind `charge`, amount negative — money out) for the
Cash & Ledger screen, AND `reference` rows of scope `charge` keyed by
(ISIN, date), aggregated per day with the fee types listed in `note`. **No
trades:** a DP charge is a fee on a delivery, not an execution.

**The door is the Cash & Ledger screen, and it accepts this file (v3.9.0).**
`app/api/import/ledger/route.ts` reads it through `detectDhanDpCharges`
alongside the Dhan ledger/dividend CSVs, the Upstox ledger and the Angel One
statement. Each printed debit lands as a `charge` entry under the WRITE
account; the file's own per-(ISIN, day) figures land in `broker_reference` in
the same transaction, with ONE audit entry for the batch. Until 2026-09-04 the
route listed Upstox and Angel One only, so the screen answered 422 to the very
file this parser told the user to bring there.

**Conservation:** Σ of the lines is checked against the file's own `Total` and
a disagreement becomes a warning, never an adjustment. The `Total` row is found
by the row's FIRST FILLED CELL (the real export prints the label in the `Type of
Transaction` column), so a security or transaction type containing the word
"Total" is still a data row; a file with TWO Total rows uses the LAST and says
so; a Total row with no figure warns that conservation is unchecked rather than
passing silently. The sheet's ~350 merged ranges are all cosmetic, and any data
row whose Charges cell falls inside a merge is reported for review rather than
silently read as 0.

### Dhan — Demat Holding summary (`Dhan_Demat_Holding_<dd-mm-yyyy>.xlsx`) → `dhan-holdings`

One sheet, `Dhan_Demat_Holding` — **the broker's name is in the SHEET NAME**,
which is the in-content fingerprint; the cells never say Dhan anywhere else.
Title row states `Holding summary | For dd-mm-yyyy`; header on row 6:
`Scrip Name | ISIN Code | Free Holding | Locked In | Safe Keep | MTF Pledge |
Margin Pledge | CUSA Pledge | Closing Price | Valuation`, then one row per
scrip and a `Valuation` / `Total Number of Securities` footer.

**Emits:** `reference` rows only, scope `holding`, keyed by ISIN and dated with
the statement date. `figures.qty` is the TOTAL in the demat account —
Free + Locked In + Safe Keep + MTF Pledge + Margin Pledge + CUSA Pledge,
because pledged and locked stock is still owned — with `freeQty` and
`mtfPledgeQty` carried separately and the formula repeated in each row's note.
**No trades and no ledger:** a holding is a position statement, and inventing
entries from it would double-count buys the tradebook already has.
**Conservation:** the statement date is read from the file's own `For` cell and
cross-checked against the filename's date — a disagreement warns, it is never a
silent pick; an ambiguous day-first date is refused rather than guessed.

### Dhan — Contract Note (`*_Contract_Note_Eqfo_signed.pdf`) → `dhan-contract-note`

The only Dhan document that states the TIME of every fill. `pdf-parse` renders
the annexure as one line per fill —
`<order no> <hh:mm:ss> <trade no> <hh:mm:ss> <description> <B|S> <qty> <price>
<net rate> <net amount> [remark]` — under a segment marker line
(`NCL-NSE-Equity-M`, `NSEFO`). Descriptions come as `SYMBOL-Company Name`
(equity) or `FUTSTK/OPTIDX <symbol> <expiry> [<strike> <CE|PE>] - NSE`
(derivative). The DERIVATIVE SUMMARY table above the annexure is **not** read:
it wraps mid-description and states WAP-after-brokerage rather than the traded
price.

**Fingerprint:** detection is synchronous and PDF text is compressed, so the
text cannot be read while ranking — what can be read is the raw bytes, and the
notes carry the broker's legal name (`Raise Securities` / `Moneylicious`)
uncompressed in the document metadata, alongside a `contract note` marker.
Scores 0.95 (1.00 with "dhan" in the filename) against the generic `pdf`
source's 0.90, so a Dhan note is claimed here and every other PDF still falls
to the generic text extractor. If a future note stops carrying the marker this
returns 0 and the user gets text plus a question, not a wrong answer.

**Emits:** `enrich` rows — fill time, instrument type and exchange, applied at
commit to trades the book ALREADY holds — plus `reference` rows for the note's
own charge totals. **It never creates a trade:** the Global Transaction Report
is the book, a note covers one day on one exchange pair, and importing it as
trades would double-book every execution the GTR carries with no dedup key
strong enough to notice. Unmatched enrichments are reported, not stored.

**How an enrichment is matched (rewritten 2026-09-04).** The first version
matched one row at a time on (symbol, date, side, qty) and matched ZERO of
1,161 real fills, for three structural reasons: a note prints one line per
FILL while the book holds the paired POSITION; a note names an equity by its
exchange ticker (`BBOX`) while the GTR names the company (`Black Box`); and a
note named a derivative by its bare underlying, so every option on a day
looked like one instrument. The rule now is:

- The parser emits the BOOK's own name in `symbol` — `OPT NIFTY 21 Apr 2026
  24200 CE`, `FUT WIPRO 28 Apr 2026`, rebuilt from the contract description in
  the grammar `lib/engine/classify.ts` parses — plus the ISIN (read from the
  note's own settlement summary, `INE676A01027 BBOX …`) and the company name
  from the description, for equity.
- At commit, fills are AGGREGATED per (identity, date, side) before anything is
  looked up: quantities summed, earliest fill for the entry, latest for the
  exit. Candidates are that account's trades for that BROKER on that date, read
  in `id asc` order, and each (trade, side) is claimed at most once per import.
- Identity resolves through the ISIN, then the note's names, then the bundled
  listing snapshot's ticker and registered name for that ISIN (`Black Box` in
  the book vs `Black Box Limited` in the registry).
- When a day's fills for one contract cover more than one position they are
  consumed as a CUMULATIVE PREFIX in time order, and the warning says that is
  an inference — the note states no position id.
- The commit reports three separate counts — `applied`, `already had times`,
  `unmatched` — with the top reasons for the misses. "Applied" used to include
  a row whose patch was empty, which made the number report the lookup rather
  than the write.

Measured on the owner's real paperwork (2026-09-04): 1,161 fills across three
notes aggregate to 58 contract-days, of which 57 match the Global Transaction
Report. The single miss is a scrip the report books under a short name the
note never prints (`NALCO` vs `NATIONALUM` / `National Aluminium Company
Limited`), and it is reported with that reason rather than force-matched.

### Upstox — Ledger (`ledger_<from>_To_<to>_<wallet>_<code>.xlsx`, sheet `LEDGER_V3`) → `upstox-ledger`

Banner rows `UPSTOX SECURITIES PRIVATE LIMITED` / `(Formerly EPX Uptech Private
Limited)` / dealing office, then a UCC / Name / PAN / Wallet label block, then
the header `Wallet | Trade Date | Settlement Date | Exchange | Segment | Type |
Narration | Debit | Credit | Closing Balance`, the data rows, and a `Total`
row.

**Fingerprint:** Upstox filenames name nobody (`ledger_…`, `trade_…`,
`realizedPnL_…`), so the claim is carried entirely by CONTENT — the
legal-entity banner (the same fingerprint `angelone-upstox.ts` uses) or the
sheet name `LEDGER_V3`. **The header row is mandatory**: the zero-data-row
sample in `tests/fixtures/redacted/upstox-ledger.xlsx` carries the banner but
no header, and is deliberately left to the column mapper — the detector claims
only what it can actually read.

**Emits:** ledger rows for the Cash & Ledger screen. **No trades.** Amounts are
formatted text (`Rs2,500.00`) with an EN DASH for "no value"; debit and credit
collapse into one signed rupee amount, money out negative, exactly as the Dhan
ledger does. **Conservation:** dates are asserted `dd-mm-yyyy`, not assumed —
a file whose second component exceeds 12 while no first component does is
month-first and is REFUSED; when every day in the window is ≤ 12 the question
is undetectable and the parser says so in a warning rather than pretending it
checked.

### Angel One — Account statement (`YourStatement_<code>.xlsx`) → `angelone-ledger`

Sheet `Broking Ledger`: a label block, a balance summary
(Opening / Closing Balance), a Funds Summary (Total Credit / Total Debit), then
`Transaction Details` and the header `Transaction | Date | Segment | Voucher |
Debit | Credit | Running Balance`. Sheet `Charges`: **four stacked tables** —
DP Charges, Pledge/Unpledge, CUSPA Sell-off, Interest — each located by its
TITLE TEXT and never by a fixed row index, because a table with rows pushes the
next one down.

**Fingerprint:** `Angelone charge` is a column header Angel One writes into its
own charges sheet and no other examined broker uses; that in-content name
carries the claim (0.9), and "Angel" in the filename adds 0.1 without ever
substituting for it.

**Emits:** ledger rows from the Broking Ledger, plus the charge tables as
`chargeRows` and as `reference` rows of scope `charge`. **No trades** — Angel's
book stays `Trades_History` (parser `angelone`). **The charge tables are
deliberately NOT ledger entries:** they are a breakdown of money the Broking
Ledger has already posted. In the verified export the DP table's single row
(₹23.60 = CDSL 3.50 + Angel 16.50 + GST 3.60) is the same rupees as the
ledger's `DP Charges` line, and the running balance chains through it exactly
once — posting both would debit the account twice, and the two rows even carry
different dates, so date+amount de-duplication would not catch it.

### Angel One — P&L statement (`ProfitLoss_Statement_<code>.xlsx`) → `angelone-pnl-statement`

Sheet `Equity P&L`: a label block, an `Equity P&L Summary` block, then two
stacked tables located by title text — `Delivery PnL` and `Intraday PnL`, both
18 columns (`Scrip Symbol | Company Name | Quantity | Avg Buy Price | Buy Value
| Avg Sell Price | Sell Value | Gross PnL | Brokerage | GST | Exchange Service
Tax | Turnover Tax | SEBI Charges | Stamp Duty | STT | Other Charges | IPFT
Charges | Net PnL`, the last column reading `Intraday PnL` on the second).
Sheet `F&O P&L`: one 16-column table; its `Buy price` / `Sell Price` are
TOTALS, not per-unit levels (verified 65 × 17.65 = 1147.25), so they map to
buyValue / sellValue.

**Fingerprint — the FORMAT, because the file names no broker.** No banner, no
column header, no disclaimer and no filename says Angel One. Owner ruling
(2026-09-04): both sheet names `Equity P&L` and `F&O P&L` present in one
workbook AND the two verified header rows found inside them, worth 0.9;
"Angel" or "ProfitLoss_Statement" in the filename adds 0.1. A deliberate
exception, recorded rather than generalised — and it scores 0 on Angel's own
tax P&L, which is a different file.

**Emits:** `reference` rows of the broker's stated P&L. **No trades:** the file
states P&L, not the executions that produced it. **What it cannot say:** there
is no ISIN column on either sheet, so every scrip reference is keyed by SYMBOL;
and there is no date column of any kind, so `asOf` is null on every row and the
FY comes from the statement's own `To Date`. Nothing is invented to fill either.

### Dhan MTF Report — no export exists

The Dhan MTF Report is a **web screen only**: it offers no download in any
format, verified by the owner on 2026-09-04. There is therefore no MTF file to
parse and no parser for one. Vyuha's MTF figures come from the files that do
exist — the Global Transaction Report and the Realised P&L for the positions,
and the ledger for MTF interest (the Dhan ledger's MTF interest postings are
already classified and totalled). Anything the MTF screen shows that those
three do not state is not in Vyuha.


### Dhan: the GTR is the BOOK, the Realised P&L is the REFERENCE

Both files describe the same trades and hash differently, so dedup cannot see
the overlap: whichever lands second books every position a second time. Rule
(v3.9.0, enforced in `commitParsedFile`): a source in `RECONCILE_SOURCE_IDS`
that also carries trades stores its figures always, and imports its trades only
when the account holds no trades for that broker from a non-reference source.

## Status (2026-08-12)

Parsers now keyed on the fingerprints above: `zerodha.ts` (Auction / `- Z`
heads required), `groww-orders.ts`, `angelone-taxpnl.ts`, `paytm-tradebook.ts`.
Redacted committable copies of every file here live in
`tests/fixtures/redacted/` (regenerate from `tests/fixtures/private/` with the
redaction script, then re-run the leak scan);
`tests/import-detection-matrix.test.ts` pins the routing and the cross-broker
refusal matrix. (The Paytm P&L and the Angel One ledger deliberately had NO
parser until v3.9; both gained one on 2026-09-04 as REFERENCE sources — see
"Reference and enrichment sources" above.)

## Why the Groww file imported as Zerodha (measured, now fixed)

For `Stocks_Order_History_<code>_<from>_<to>.xlsx`:

| Detector | Score | Reason |
|---|---|---|
| `detectGrowwXlsx` | **0.00** | filename matches neither `groww` nor `stocks_pnl`; no `Trade Level` / `Scrip Level` sheet |
| `detectZerodha` | **0.30** | filename adds 0; but `cells.includes("symbol") && cells.includes("isin")` adds 0.30 |

Zerodha wins on pure column *shape*, with no broker-name requirement — the exact
anti-pattern `AGENTS.md` documents for `angelone-upstox.ts` and the Kotak Neo
tradebook. The rule was applied there and never applied to `zerodha.ts`.

The generic column mapper should have taken this file. It did not, because a
broker-named parser returned a non-zero score for a file that names no broker.
