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
> Console P&L with 53 rows, and three Upstox reports that are **schema-only**
> (the account had no trades). Value-level behaviour is therefore VERIFIED for
> Paytm and Zerodha tradebooks and still INFERRED for Upstox. What the data
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
| Paytm Money Tradebook | `UCC` label in A1 + `Script` (sic) + `ETT` column |
| Paytm Money P&L | `UCC` in A1 + `Unrealized P/L Summary` / `Realized P/L Summary` |
| Angel One Tax P&L | `Angel One Limited` in `Summary!A1` |
| Angel One Ledger | `Angelone charge` column in the `Charges` sheet |
| Groww Stocks P&L | Sheets named `Trade Level` / `Scrip Level` |
| Groww Stocks Order History | `Unique Client Code` header — Groww-specific phrasing |
| Upstox trade report / realised P&L | `UPSTOX SECURITIES PRIVATE LIMITED` in A1 (the legal name), header 11 / 22 rows down |
| Paytm Money Equity P&L (`.xls`) | section titles `Unrealized P/L Summary (As on …)` / `Realized P/L Summary (From …)` — no parser, mapper |

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
  tradebook is paired FIFO and an unmatched sell is an *opening sell* with
  `basisUnknown`, never a 100% gain.
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
    table, then the bundled NSE index map) and otherwise keeps the code with a
    note telling the user to upload NSE's securities list.
  - `Product Type` is `EQ` on every row — the SEGMENT, not delivery/intraday.
    Product is derived per scrip-day from Paytm's own STT and stamp duty
    (`lib/import/product-signature.ts`).
  - STT and stamp duty for a scrip-day are **booked on one execution row** of
    that day (the last one), not spread per fill — e.g. four buys whose STT
    reads 0 / 0 / 0 / 1960.08, where 1960.08 = 0.1% of the day's total buy
    value. Sum per scrip-day before inferring product.
  - `Trade Time` is empty and `Trade Number` is `0` on every row; `Order
    Number` is a 16-digit id. Dates are `dd-mm-yyyy` strings.
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

---

## Upstox

Three real exports examined 2026-08-20 — **all schema-only** (the account had
no trades), so the layouts below are VERIFIED and every value behaviour is
INFERRED. Filenames name no broker: `trade_<from>_<to>_<code>.xlsx`,
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
`Wallet | TRADING` and **no column header at all** in the sample — nothing to
map; no parser claims it.

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

## Status (2026-08-20)

Second batch: `paytm-tradebook.ts` and `zerodha.ts` tradebook paths pair FIFO
via `lib/import/pair-legs.ts` (opening sells → `basisUnknown`, P&L blank);
`zerodha.ts` reads `Order Execution Time`; Paytm derives product from the
scrip-day charge signature and apportions its six stated charge components;
coded Paytm symbols resolve by ISIN at commit; `angelone-upstox.ts` fingerprints
Upstox on the A1 legal name and maps `Trade Time`, `Buy/Sell Date`,
`Buy/Sell Amt`, `Total PL`, `Speculation`. Seven more redacted fixtures in the
matrix test, plus a private block that replays the real files when present.

## Status (2026-08-12)

Parsers now keyed on the fingerprints above: `zerodha.ts` (Auction / `- Z`
heads required), `groww-orders.ts`, `angelone-taxpnl.ts`, `paytm-tradebook.ts`.
Redacted committable copies of every file here live in
`tests/fixtures/redacted/` (regenerate from `tests/fixtures/private/` with the
redaction script, then re-run the leak scan);
`tests/import-detection-matrix.test.ts` pins the routing and the cross-broker
refusal matrix. The Paytm P&L and Angel One ledger deliberately have NO
parser: the P&L belongs to the generic mapper, the ledger to the ledger route.

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
