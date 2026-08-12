# Broker export formats — verified column maps

Extracted 2026-08-12 from real exports using the project's own `xlsx` module
(`XLSX.read(buffer)`), so these layouts are what the parsers will actually see.

**Every layout below is VERIFIED against a real file.** Nothing here is inferred
from documentation. Where a file carried no data rows, that is stated — the
header is still verified, but value-level behaviour is not.

Source files live in `tests/fixtures/private/` (gitignored — they carry client
codes, PANs and names). This document deliberately contains **no identifiers**.

> ⚠️ **The samples are schema-only.** Of six files, only one contained a single
> data row. They are sufficient to fix detection and column mapping; they are
> NOT sufficient to verify that parsed values (prices, P&L, charges) are correct.
> That needs exports from an account with real activity.

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
