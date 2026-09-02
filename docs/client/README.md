# Welcome to Vyuha

A fully local, offline trade journal for Indian retail traders. There is no
account, no cloud, and no telemetry — nothing about your trades leaves your
computer unless you switch on a feature that sends it, and each one says so
before you can.

## Built by one person, shaped by the people who use it

There are plenty of trade journals now, and AI has made it easy for anyone to
build another. Vyuha is different in what it does — and in where it runs.

- **It works offline.** Everything happens on your machine. Unprompted, the app
  touches the internet exactly once: a check for updates at launch. Anything
  else — the end-of-day price download, broker pulls, the Telegram digest — is
  off until you switch it on.
- **It takes behaviour as seriously as P&L.** When you exit, how long you hold,
  whether you moved a stop after entry — the parts of a trade a profit column
  cannot hold.
- **It goes deep on Indian tax.** Head-wise segregation, set-off and
  carry-forward, the return's own schedule codes — cited under the Act that
  governed each year.
- **And it has begun on option strategy.** Payoff at expiry, Greeks across the
  book, premium capture, roll chains.

That last one is a start, not a finished article — and saying so is the point.

**The promise.** As the user base grows, the app grows with it, and what you ask
for shapes the roadmap and the architecture rather than a backlog nobody reads.
If a request is feasible, it gets built. And where a group of traders — or a
single trader — needs something specific, a tuned build is on the table.

You don't get that from software with a support queue.

## New in v3.7.1

| Upgrade | What it gives you |
|---|---|
| **The Trade Review Desk** | A new **Review** screen (Pro/lifetime, after the 7-day trial) that answers "which trades have I not read back yet, and how did I actually trade this week?". A queue of every closed trade carrying no review stamp — windowed, and always saying "showing N of M" rather than presenting a slice as the whole. Each row opens the same journal dialog the Trades screen uses; saving stamps the trade, and a trade with nothing to add can be stamped directly and reopened later. **The queue does not start from zero on upgrade:** closed trades you have already journalled — carrying a note, an exit trigger or mistake tags — are stamped as reviewed the first time this version opens your database, dated by the last time that row was touched rather than by today. So a journalled book opens with a non-zero "Reviewed n of m" and a shorter queue, instead of hundreds of rows of work you had already done; a trade nobody annotated stays in the queue, which is the point. |
| **A Sunday ritual that closes one week** | Complete an ISO week with a note: what closed, what it netted and cost, the widest expectancy gaps by mistake tag, best and worst by R, and why positions were closed. Completing a week stores the score that was on screen at that moment beside the score recomputed today. It is in-app only — the ritual sends no reminder, by Telegram or anything else. |
| **A discipline score you can check line by line — and your numbers will move** | The weekly discipline score is now the **Process Score**: five equal-weight components — planned (SL or target recorded) · risk-cap (loss within its own risk) · daily-stop (day net within your stop) · rules-followed (a playbook, and no rule broken) · reviewed — each printed as **"n of m · pct"** with its own coverage, so the arithmetic sits beside the number. Two deliberate changes move figures on upgrade: **(1)** a week with fewer than **10 closed trades no longer scores** — it shows "—", says what was short, and is **excluded from averages** instead of entering them as a zero. On a representative five-week fixture the honest average is **80 where v3.6 printed 32**, because three un-scoreable weeks were being averaged in as zeros; averages now state their coverage ("across 7 scoring weeks of 12"). **(2)** a per-trade cap or daily stop **you never configured** is no longer substituted with ₹9,500 / ₹25,000 — those components refuse rather than judge your losses against a limit you never set. |
| **First-run setup, in four skippable steps** | A fresh install now opens a wizard: account and optional starting capital → get your trades in → optional Telegram → done. **Capital stays optional** — skip it and every report that needs a base still shows "—" and points you at Settings rather than inventing one. "Run setup again" lives in Settings. If you already have a book, you will never see it. |
| **Advance tax measured against dated challans** | Record what you actually paid — date, amount, and optionally the BSR code and challan serial — on the Advance Tax report. Each instalment is then judged against what had been paid **by its own due date**, replacing a single cumulative figure that treated a March payment as though it had been available in June. The safe harbour is decided by date, and anything paid after 31 March is named **self-assessment tax, not advance tax**. The ITR pack gains a **"Taxes paid (advance tax)"** table and export in the return's own Schedule IT shape — blank, never 0, where it cannot derive a value. **Record no challans and no computed figure changes.** |
| **Capital now resolves per account on eight more screens** | Both trackers, the risk cockpit, the monthly report, the target tracker, cash openings, the pre-trade concentration limit and the dashboard's total-capital tile. This is not only a multi-account fix: **it corrects single-account books too.** Compounding realised P&L writes the account's own row, so those eight screens had been reading the pre-compound figure while Settings and the performance page showed the compounded one. |
| **Lenses opens in about half the time** | 1718/1557 ms → **920/901 ms** on a seeded 25,000-trade book, with 94% less data crossing the wire. **Not one figure on the page moved** — every group, total and rate is still computed over your whole book. |
| **A failed Telegram digest is remembered** | The note that a digest could not be sent is now durable and visible from **every** screen rather than only the dashboard, quotes the job's own reason, and clears on the next successful send. It also carries an opt-in button that asks *this device's* system for a notification. That is a request, not a promise: a system notification has not been proven on a built installer, so the note itself stays the record either way. |
| **A week-start fix** | The week bucketer emitted the **Sunday** rather than the Monday in any timezone east of UTC — which is every Indian user. Weekly rows may re-label by one day on upgrade; the trades inside each week are unchanged. |

## New in v3.6.0

| Upgrade | What it gives you |
|---|---|
| **A sidebar arranged around how you work — and yours to change** | Screens now live in nine groups (Import, Tax and Back Office are new), each showing its most-used screens with the rest one click behind "N more…". Choose which screens stay visible per group — by drag or by checkbox — reorder anything, and Reset brings the default back. The screen you are on is never hidden from you. |
| **Expected-capital goals** | Set a ₹ or % target per capital bucket, with an optional date. Progress, gap and your trailing run-rate are measured from your own realised record — never a projection — and a % goal with no capital on file shows "—" and points you at Settings rather than inventing a base. |
| **Dhan connects once, with PIN + TOTP** | Instead of pasting a new access token every day, Dhan can now store your client ID, PIN and TOTP secret (encrypted, on your machine) and mint the day's token itself — the sign-in call goes only to Dhan's own endpoint. Storing these makes Vyuha a second factor for your Dhan account, and the consent screen says so before you agree. The paste-a-token path remains. |
| **Zerodha's official session exchange** | Log in via Zerodha's own page once a day, paste the request token, and Vyuha completes Kite's documented session exchange itself — no more manufacturing an access token by hand. |
| **Auto-pull on launch — opt-in** | Once a day, at launch, Vyuha can pull your saved broker connections for you. Off by default; anything the manual flow would stop and ask about still stops and asks, and nothing is ever committed silently. |
| **Telegram end-of-day digest — opt-in, and honest about what it is** | Your day's own recorded numbers, sent to a Telegram bot you create yourself. This is the one feature that uploads anything, so it sits behind a disclosure that says plainly the content transits Telegram's servers — off by default, with a test-alert button so you know it works before the market close does. |
| **Brought-forward losses, finally enterable** | Losses from years before your journal starts can now be recorded per year and head, and the tax timeline, ITR pack and loss ledger honour them — including the year each vintage expires. |

## New in v3.5.1

| Upgrade | What it gives you |
|---|---|
| **Zerodha's tax P&L imports natively — with the broker's own charges** | The `taxpnl-…` workbook Console produces (the one with entry AND exit timestamps and every charge per trade) used to fall to the manual column mapper. It now imports directly, and reconciles against Zerodha's own summary: realised profit matched **exactly** on two real financial years, charges to the paisa on one and within Zerodha's own ₹187 exits-only gap on the other. Per-trade charges are stored as the broker's stated figures — Vyuha does not out-argue a broker about money it actually levied. F&O contract names (NIFTY2540323750CE) now classify as options with strike, type and weekly expiry read from the symbol. |
| **Vyuha Intelligence — a second brain that never invents a number** | A deterministic insight engine now runs behind Arjun's Eye and the Lenses popups. Every insight is descriptive (it tells you what your record shows, never what to do), refuses to exist below its sample floor ("below ~20 trades this would be noise"), and carries its coverage with the claim ("SL recorded on 12 of 40 losers"). It runs entirely offline and computes nothing an LLM could hallucinate — that is the design, not a limitation. |
| **Arjun's Eye becomes the five-tab Trade Craft cockpit** | **Winners vs losers** answers the question that decides careers — do you win big and lose small? — with your win-rate × payoff position plotted against the breakeven curve, and your R-multiples split honestly into stop-derived vs default-cap series. **Stop-losses** classifies every losing exit against the stop you recorded (held / slipped past / exited early, with slippage in ₹ and R). **Trailing stops** compares TSL trades against the rest and mines your edit history for stops that were moved after entry. **Exits** shows your exit-time clock, holding times and order fragmentation. Each tab states what it needs when your book hasn't recorded it — the tabs sharpen as you tag. |
| **Turnover, both ways — because your broker's report disagrees with the guidance** | Zerodha's tax report computes F&O turnover as differences only; the current ICAI guidance adds option premium. On a real book the two differed **6.5–8.7×** — enough to land on opposite sides of the ₹10 Cr audit line. The ITR Pack now shows both figures, labelled, with an audit read on each and a warning when they disagree: that table is exactly what to put in front of your CA. |
| **Tax tools you can steer** | The Harvest page gains a what-if simulator — tick lots (nothing is ever pre-selected, and nothing is ranked) and watch tax saved, offsets and carry-forward recompute. A carry-forward **loss ledger** shows every surviving loss vintage with the year it expires. Advance tax gains the s.425(4) relief inputs, a presumptive-scheme toggle, remembered inputs, and a one-line link from harvestable losses to your next instalment. |
| **Every card explains itself** | Click any KPI on Performance or Scaling for what the ratio means, its formula, how it is commonly read (stated as a heuristic, not a law), and its honest caveats — including which of the two max-drawdown conventions each figure uses and why "Expectancy" here is rupees per trade, not R. |
| **The session plan does the typing for you** | Import a watchlist from a txt, CSV, Excel or PDF file (PDF candidates always ask for confirmation). Symbols are resolved through your aliases and ISINs — which also fixed a quiet bug where an aliased symbol was scored as "traded outside the watchlist". Each planned symbol shows your own history with it: trades, net, win rate, last traded, and whether your book has an expiry coming. |
| **No screen computes on money you never told it about** | On a fresh install, nine surfaces used to assume ₹17 lakh of capital and compute returns, risk heat and utilisation on it. Every one of them now says "—  · set your capital in Settings" instead, risk shows "unrated" rather than a made-up grade, and pre-trade limit checks report "not evaluated" rather than silently passing. A permanent test fails the build if a made-up capital figure ever returns. |
| **Exit triggers can finally be recorded** | Both the trade editor and the journal drawer now ask *what got you out* — a curated list or your own words — feeding the Exits analytics that were waiting for the data. |
| **Honest labels, small but real** | "Extra STT if held" is now "STT on physical settlement" (the old figure mixed a futures delta with options absolutes); the Console P&L import says up front that its rows carry no dates; trackers show "most recent 60 of N" instead of presenting a slice as the count; scaling verdicts stopped crediting every ladder one brokerage of phantom improvement. |

## New in v3.4.0

| Upgrade | What it gives you |
|---|---|
| **Five slow screens now open in about a second** | On a 25,000-trade book: Option Strategies ~6.0s → ~1.0s, Options Seller Journal ~5.8s → ~1.1s, the Equity tracker ~3.2s → ~0.9s, Portfolio Risk ~2.5s → ~1.3s, Lenses ~2.1s → ~1.3s. **No number on any of those screens changed** — every total and rate is still worked out over your whole book. Vyuha simply stopped drawing thousands of rows you were never looking at. |
| **When a list is shortened, it tells you** | Long tables now show a window with a "Showing 150 of 3,460 — show 150 more" button, and the capped panels on Portfolio Risk say "Showing the first 100 of N, most urgent first". A shortened list that looks complete is worse than a slow one, so Vyuha will not do that quietly. |
| **Payoff diagrams draw as you scroll to them** | Option Strategies was drawing every payoff chart at once — 626 of them on a large book — for a page that shows about two at a time. |
| **The Trades table is deliberately unchanged** | It is the one screen still slower than we would like on a very large book. Fixing it means changing the order trades come back in, which can shift a tax total by a paisa and change which rows appear first. That is not something to slip into a speed change, so it gets its own release and its own before-and-after check. |
| **Update signatures are checked against the actual file** | The release check used to confirm a signature came from the right key. It now also confirms the signature matches the installer bytes you actually download — the exact failure that once shipped an update no installed copy would accept. |

## New in v3.3.0

| Upgrade | What it gives you |
|---|---|
| **India's income-tax law changed, and Vyuha changed with it** | The Income-tax Act, 1961 was repealed and the Income-tax Act, 2025 came into force on 1 April 2026. Almost every section number you have seen on a tax report — 111A, 112A, 44AB, 234C — belongs to the old Act. Vyuha now cites the Act that governed **each year**: a 2024-25 pack still says S.111A, and a 2026-27 pack says s.196, with the governing Act named on the report. Your figures do not move; the law they point at is finally right. |
| **A turnover figure that had been wrong for three years** | The tax-audit turnover for F&O must include the premium you received on options you sold. That rule was removed from the ICAI guidance in 2022 and **put back in 2023** — and the older answer is still what most of the internet tells you. Vyuha was using the older one, and it is the number that decides whether you are told an audit applies. If you sell options, your turnover figure may now be substantially larger, and it is the correct one. Vyuha also shows which guidance it followed, because this is professional guidance rather than statute. |
| **The Tax Summary and the ITR Pack now agree** | They were computing turnover two different ways, so the same year could show two different figures on two screens. One calculation now feeds both. |
| **Advance tax stops charging interest the law does not** | If you paid at least 12% by 15 June, or 36% by 15 September, no deferment interest arises at all — even though the instalment asks for more. Vyuha now applies that, shows the shortfall anyway (you still owe it), and marks the row "short · no interest" so it does not look like a mistake. There is no such tolerance for December or March, and it says so. |
| **What you realised each month, by head** | Split the way your return splits it. It is deliberately not called a monthly tax bill: set-off, the long-term exemption and the slab rates are all worked out for the whole year, so no single month has a tax figure of its own. |
| **Months as units of work** | The monthly grid could only ever show one percentage per box. Now you also get trades, win rate, net, charges, cost drag and your best and worst trade of each month — with a month-on-month column that stays blank when you did not trade the month before, rather than inventing a trend. |
| **Three things your own trades can prove about your tax** | Which losses can meet gains **this** year instead of only future business income; how much of your STT was deductible because it sat on an intraday or F&O leg and how much was simply lost on a delivery leg; and how many days each open holding has before it turns long-term. Vyuha will not tell you which share to sell, will not estimate what you owe, and will never tell you to wait a number of days before buying back — India has no wash-sale rule, and any tool that gives you a waiting period is inventing one. |

## New in v3.2.0

| Upgrade | What it gives you |
|---|---|
| **Charges priced at the rate that applied on the day** | Statutory rates change. STT on futures and options was raised on 1 April 2026, and until now Vyuha priced your whole history at today's rate. It now keeps a dated history per rate and prices each trade at the one that actually applied to it. Your existing numbers do not move on upgrade — and if no rate is on file for a date, Vyuha says so instead of quietly using a nearby one. |
| **Every win rate now comes with a confidence interval** | A 68% win rate on 15 trades sounds convincing; its real range is about 42%–86%. Vyuha now shows that range, and when a setup is not yet distinguishable from your own overall rate it says so. Nothing is hidden — it is your record — but you will no longer be pointed at an edge that is really a coin toss. |
| **Segment depth: the five books inside your book** | Equity Intraday, Delivery, MTF, Options (Index) and Options (Stock) are five different businesses with different taxes, different holding costs and different settlement. Seeing them apart tells you which one is paying for the others — something a single overall number cannot. |
| **The exit half of the journal** | Which market session you exit in, how long you actually hold a position, how many orders it took to build, and **why** you closed it — crossed with how much of the available move that exit caught. |
| **Stops that moved after entry** | Your journal keeps the final stop, so a trade whose stop was widened three times used to look the same as one you left alone. Now you can see the difference it made. |

## New in v3.1.1

| Upgrade | What it gives you |
|---|---|
| **Your import now shows its working** | A broker tradebook lists every execution; Vyuha groups them into positions, which is what you actually traded. It now says both numbers — *"7,544 executions → 804 positions (82 open, 72 opening sells without buy history)"* — on the preview, on the result after importing, and in the Recent imports table. Previously only the position count appeared, which looked like rows had gone missing when nothing had. |
| **Blank P&L cells now explain themselves** | If you sold shares you bought before the file's start date, the file contains no purchase price for them — so Vyuha shows "—" instead of inventing a number. The import result now tells you how many rows this affects and that setting the buy price on them fills in the P&L. |
| **Fixed: a false "please report this file" warning** | Large, entirely correct imports could show a scary pairing warning caused by fractions of a paisa of rounding across thousands of rows. The check now allows for that rounding while still catching a genuinely mis-paired trade. |
| **SME and BSE-only stocks now show their real names** | Some brokers (Paytm Money in particular) list stocks by numeric code rather than ticker. Vyuha now bundles the full list of listed equities from NSE, NSE Emerge and BSE — **5,671 securities** — so those codes turn into names you recognise, including SME stocks that previously stayed as numbers. Instruments you upload yourself still take priority. |

## New in v3.1.0

| Upgrade | What it gives you |
|---|---|
| **Delete an account — or merge it into another** | Every account in Settings now has a Delete button. You choose what happens: delete everything the account owns, or **merge its trades into another account** you pick — and, separately, whether its broker connections are deleted or moved along with a merge. Before anything happens, a preview computed from your actual data shows exactly how many trades, ledger entries, IPOs, imports, sessions and capital records are affected, plus any trades the merge target already has (those are skipped and counted, never silently dropped). Nothing is armed until you type the account's name back. |
| **Deleted accounts are recoverable — with one honest exception** | Deletion takes a snapshot first, so the account and its trades, ledger, IPOs, import history, sessions and capital history can all be brought back from **Backup & Restore → Deleted items** — restoring recreates the account itself. The exception, stated in the dialog before you confirm: broker API credentials are never written to snapshots, so a deleted connection must be re-entered. |
| **Merges keep your books honest** | Every trade keeps its legs, attachments and ledger links, and the capital-compounding marker moves with arithmetic that can never count the same realised P&L twice. |
| **Import Help cards are now full guides** | Each broker card in Import Help opens as a pop-up guide with bigger text and step-by-step OpenAlgo setup for that broker — Dhan and Upstox verified against live instances; Groww, Paytm Money, Kotak, Angel One and Zerodha documented. Your client package now includes two new files: **OPENALGO_SETUP_GUIDE.html** and **OPENALGO_SETUP_GUIDE.docx** — a complete multi-broker OpenAlgo manual covering install, running one instance per broker, the daily login, each broker's settings, and troubleshooting from real testing. |

## New in v3.0.0

| Upgrade | What it gives you |
|---|---|
| **Every account's connections, visible from All accounts** | The Import view in "All accounts" now lists every connected broker API and every OpenAlgo instance, each labelled with the account it belongs to — previously only the first account's connections showed. Saving a new connection asks which account it is for (the same picker file imports use), and **Pull & commit always books into that connection's own account**, so a pull can never land trades in the wrong book. |
| **Import Help — a new sidebar tab that answers "which file do I download?"** | One card per broker: which of its exports Vyuha imports, where to find each on the broker's own site (locations noted as of Aug 2026), and the full setup path for each live connection — Kite's daily token, Dhan's 24-hour token, Angel One's TOTP secret, Upstox's Analytics token and static-IP step — plus cards for OpenAlgo and the column mapper. No more hunting through broker menus or asking us which export to use. |
| **Big journals got much faster** | Measured on a 25,000-trade book: Cash & Ledger opens in under a second (it used to take ~27 s), corporate actions and the dashboard are quicker, and every screen now shows a loading skeleton immediately instead of a blank pause. A handful of the heaviest screens on books that size are next in line for the same treatment. |

## New in v2.99.104

| Upgrade | What it gives you |
|---|---|
| **Upstox connects natively — with a token that lasts a year** | The fourth live broker connection, and the easiest of them all: paste Upstox's **Analytics token** once (account.upstox.com → Apps → Analytics) and it works for a year. It is read-only by design — it cannot place orders, even in principle. One extra one-time step: register your current IPv4 address under Apps → Static IPs; Upstox answers only from that address, and the connection screen explains this. |
| **Your Upstox F&O books correctly from day one** | Options import as the contracts they are — strike, expiry, exchange — verified against a live trade book on 2026-08-28, with MTF recognised as MTF. |
| **A pull that adds nothing now tells you clearly** | If every trade in a pull is already in your journal, Vyuha shows exactly which trades matched and confirms the journal is unchanged — instead of a one-line note that was easy to miss. |

## New in v2.99.103

| Upgrade | What it gives you |
|---|---|
| **Angel One API pulls now book your F&O correctly** | Options and futures pulled through the Angel One connection used to be filed as equity — wrong charges, wrong segment, invisible to the options analytics. They now import as the contracts they are, named from the facts Angel One itself states. Verified against a real contract note: every trade, price and fill time matched the broker's own annexure. |
| **Angel One MTF trades are recognised as MTF** | A margin-funded trade pulled through the API now carries the MTF product, so MTF interest tracking sees it. |
| **Symbols line up across sources** | `HFCL-EQ` from the Angel One API and `HFCL` from any file are now the same symbol in your journal. |

## New in v2.99.102

| Upgrade | What it gives you |
|---|---|
| **Dhan API pulls now book your F&O correctly** | Options and futures pulled through the Dhan connection used to be filed as equity — wrong charges, wrong segment, invisible to the options analytics. They now import as the contracts they are, with strike, expiry and option type read from what Dhan itself states. Verified against a real contract note: every contract matched to the 4th decimal and STT to the paisa. |
| **Open positions arrive already valued** | A Dhan pull now carries the broker's own current price for each open position, so unrealised P&L shows immediately — no more "no current price" prompts for freshly pulled positions. And wherever a holding still needs a price, you can now type it right there in the panel. |
| **You cannot double-import a day by accident** | If a pull looks like trades already in your journal (for example, the same day imported earlier from a file), Vyuha now stops before committing and shows you exactly which rows collide — nothing is committed until you explicitly say so. The same contract traded at two different brokers still imports as two trades, as it should. |
| **Portfolio Risk shows rupees, not just percentages** | Open P&L and each position's running impact now display the ₹ figure beside the %. |

## New in v2.99.101

- **Booking an exit on a fully closed staged position now explains itself.** Previously the
  quantity shortcuts appeared to do nothing and the browser blocked every quantity with
  "Value must be 0." — with no hint why. The dialog now tells you the position is fully closed
  and what to do instead: **Add entry** to re-open it, or remove the exit leg that was booked
  wrongly and book the exit that actually happened.

## New in v2.99.100

| Upgrade | What it gives you |
|---|---|
| **Imports stay fast however much history you have** | The engine that turns your broker's fills into the trades you actually made was doing far more work than it needed to once one symbol carried a lot of history — the cost grew with the *square* of the open positions, so a book you had traded for months got slower and slower to import. It is now proportional, and the difference is not small: a 50,000-fill book on a single symbol went from **775 ms to 63 ms**. If you trade one instrument heavily, this is the release you want. |
| **Nothing about your trades changed** | This was purely about speed. The same fills pair into the same positions, with the same dates, quantities and P&L — verified against your broker's own statement, not only against our own tests. |

## New in v2.99.99

| Upgrade | What it gives you |
|---|---|
| **Angel One's live pull works again** | If your Angel One API pull said the saved credentials could not be read, it now works. Angel One is the only broker that never asks you for an access token — it mints the day's login code from your TOTP secret — and the check guarding the pull was demanding that token anyway, so it refused before ever reaching Angel One. It had been doing that on every version from **v2.99.80** up to and including v2.99.98. Nothing about your saved credentials was wrong and nothing needs re-entering: install this build and press **Pull** again. |
| **Zerodha, Dhan and file imports were never affected** | This was only ever the Angel One live-pull path. Every file import, every other broker and every report behaved exactly as documented throughout. |
| **In-app text that had drifted now matches the app** | The Help Desk said eight brokers are auto-detected (six have parsers) and that MTF is never read from a file — Angel One's tax P&L states MTF quantity outright, and Vyuha believes it rather than guessing. The Dashboard's empty state said five brokers. The column mapper still described plain FIFO after the pairing engine moved to same-day-netting-first. All four now say what actually happens. |

## New in v2.99.98

| Upgrade | What it gives you |
|---|---|
| **Zerodha and Paytm Money tradebooks import as the trades you actually made** | Each fill is now paired **per scrip and day**: a buy and a sell on the same day net into one intraday trade first, and the rest match oldest-first (FIFO). A three-month tradebook no longer collapses into one row per symbol, and every position carries its real entry and exit dates. Shares you sold that were bought *before* the export window appear as **opening sells** with the P&L left blank until you supply the purchase price — never booked as a 100% gain. The import summary says "N fills → M positions". |
| **Zerodha fill times** | Entry and exit times are read from the tradebook's *Order Execution Time*, so the time-of-day views fill in for Zerodha imports. |
| **Paytm Money: product, charges and symbols from the broker's own numbers** | Paytm's tradebook says `EQ` for everything, so delivery vs intraday is derived from the STT and stamp duty Paytm itself levied each day; its six stated charge components travel with every trade; and the numeric scrip code Paytm exports is resolved to the ticker through the ISIN (your Instruments list — upload NSE's `EQUITY_L.csv` / SME list — or the bundled NSE index list). When nothing resolves, the code is kept and the row says so. Verified against a real 414-execution export and Paytm's own realised-P&L statement: 47 of 52 scrips agree to within ₹25. |
| **Upstox trade report and realised P&L are recognised** | By the legal name in the first cell of the report, header on the 11th / 22nd row. Trade time, buy/sell dates, Total PL and the Speculation/Short Term/Long Term split are mapped. The sample had no trade rows, so value handling is unverified until one does — the import says so. |
| **Same-day-first pairing everywhere** | The Dhan transaction report, Groww order history and the column mapper use the same pairing engine, so they inherit the same-day netting rule. |

## New in v2.99.97

| Upgrade | What it gives you |
|---|---|
| **Tint intensity — how much of the skin's colour the screen wears** | Settings → Appearance has a **Tint intensity** slider (0–100, default 50) with **Subtle / Balanced / Vivid** presets and −/+ buttons that step by 10. It tints the canvas, sidebar, cards, borders and header band toward the skin's hue. Every skin keeps its text readable at any setting, including 100 — the curves were tuned so no combination drops below the contrast the app has always held. |
| **Panel style — Flat, Soft, Luxe or Glow** | Choose how cards sit on the page: no shadow, a soft lift, the default Luxe depth, or a coloured glow in the skin's hue. (Terminal + Glow deliberately falls back to a flat shadow — a glow on a monochrome skin just smears.) |
| **Build your own skin** | A ninth skin, **Custom**: seven colours (accent, analytics, money, sidebar, cards, borders, canvas), each for dark and light. Pick **Start from <skin>** to seed it from any built-in skin, then change what you like. Every colour shows a small readability badge — it warns, it never blocks. Your custom colours are saved with the form, and only while Custom is the selected skin. |
| **Wallpaper** | Put a PNG, JPEG or WebP (up to 12 MB) behind the app, with an opacity slider and a theme-aware scrim so text stays readable on both themes. It never prints. The image lives in your data folder **outside backups** — the Backup screen says so — so re-add it on a new machine. |
| **The Buy buttons answer inside the desktop app** | Every "Get Pro / Get Lifetime" button now opens a small dialog with the WhatsApp number **+91 73936 73714**, the pre-filled message, **Copy number** / **Copy message** buttons, an *Open WhatsApp* link (for when you are in a browser) and the offline note. Previously the desktop app swallowed the click silently. Settings → License plan pills open the plan card in a popup. |
| **Reinstalling over a running copy no longer errors** | Upgrading from v2.99.96 could show "Error opening file for writing … node.exe" if the app's server was still running from an earlier crash or in-app update. Clicking *Ignore* was always harmless (the file was identical), but from v2.99.97 the installer and the app stop that server first — and only *ours*, never any other Node process on your PC. |

## New in v2.99.96

| Upgrade | What it gives you |
|---|---|
| **The Trades table shows what you actually put in** | New **Qty** and **Invested** columns. On an MTF row, Invested shows **your own contribution %** and the **broker-funded amount** beside it; when the funding has not been resolved yet it says so ("funding not yet resolved") rather than guessing. **Entry price** and **Exit price** replace the old Buy value / Sell value columns — an open trade shows "—" for the side that has not happened yet, never ₹0. |
| **The Options Seller Journal explains its numbers** | Every KPI card now opens a breakdown, the same way the Dashboard cards do, and there is an outcome-mix bar (expired worthless / squared off / assigned / rolled / unclassified) plus section headers so the page reads top to bottom. |
| **Eight skins, and each one tints the whole screen** | Settings → Appearance now offers **Luxe, Terminal, Tape, Sapphire, Aurora, Lime, Rose, Ember**. Ice and Royal are retired — they were only telling by their buttons — and a saved Ice or Royal choice becomes Sapphire automatically. Every coloured skin now tints the canvas, cards and borders subtly in its own hue instead of only recolouring the accents. |
| **No more background terminal window** | The desktop app used to open a second, blank console window behind the main one. It no longer does. Its server log now goes to `%APPDATA%\in.vyuha.tradejournal\logs\sidecar.log` — that is the file to send if you are ever asked for a log. |
| **Faster on big books** | Lens grouping no longer slows down disproportionately as the journal grows; the backup page counts rows without reading them; an encrypted restore derives its key once instead of twice; and the licence check no longer writes to the database on every Pro screen you open. |

## New in v2.99.95

| Upgrade | What it gives you |
|---|---|
| **Launch pricing, shown honestly** | The list prices are **₹13,000/yr** (Pro — Annual) and **₹35,999** (Journal — Lifetime). Until the launch offer ends you pay **₹9,999/yr (23% off)** or **₹29,999 (16% off)** — the struck-out figures are the real prices these become, not decoration, and the savings percentages are computed from the numbers and floored, never rounded up (lifetime's true 16.67% displays as 16, not 17). Lifetime is now the recommended plan. |
| **How Vyuha compares, on the pricing page** | A factual table of seven other trade journals — pricing, where your data lives, Indian broker support, statutory charges — every cell read from public pages on 2026-08-15, with "not stated" wherever a claim could not be verified. |
| **Lifetime carries the roadmap** | Lifetime includes every future upgrade at no extra cost — exciting, useful features are on the roadmap. |
| **This deck caught up with the product** | The getting-started deck now names all six brokers, the column mapper and the three broker-API pulls, lists the full Pro screen set (Lenses included), and carries the SmartScreen note next to the install steps. |
| **The refreshed mark, everywhere** | The landing page, brochure and this deck now carry the current Vyuha mark — the older flat tile is retired. |
| **Windows-only, said plainly** | This package sells and supports the Windows desktop app. |
| **The refund policy states its edges** | A closing note now says refunds beyond the two named exceptions are at the owner's discretion, and that verified tampering or replication of Vyuha forfeits them. |

## New in v2.99.94

| Upgrade | What it gives you |
|---|---|
| **Your annual licence warns you before it lapses** | There was no warning at all — the key worked, and then one morning the Pro screens were locked. From 30 days out you now get a dated countdown and a renew link on every Pro screen, with nothing withheld while it counts down. If you do let it lapse, your journal is untouched: trades, imports, backups and exports keep working exactly as on a free copy. |
| **Your paperwork is in the download** | A refund policy, terms of use and a privacy statement now ship alongside the installer, so the copy you hold matches the version you bought. |
| **Straight answers about PDF and tax** | Opening a broker PDF extracts its text for you to enter by hand — it never imported trades, and we no longer list it as though it did. No GST is charged on these sales, so the "inclusive of taxes" line is gone. |
| **A download link, not an email attachment** | The installer is around 35 MB, which is too large to email. You get a private link — which is what was always actually sent. |

## New in v2.99.93

> **Take a fresh backup after updating.** One of the fixes below repairs what
> goes *into* a backup, so it can only protect files saved from this version on.

| Upgrade | What it gives you |
|---|---|
| **Your screenshot thumbnails survive a restore** | Thumbnails were saved beside each screenshot without a record of their own, so a backup never captured them — and restoring rebuilt the folder and removed them. Screenshots came back; every preview came back blank. This also happened during the automatic backup Vyuha takes before a database upgrade, so it could occur without you restoring anything deliberately. |
| **Deleting a large account works** | "Delete everything in this account" failed outright above roughly 32,000 trades — the database refuses that many values in one statement. It now deletes in batches, and a 2,000-trade delete does a fraction of the database work it used to. |
| **A staged position can't be left half-updated** | Rebuilding a tranche ladder wrote each tranche and then the headline figures separately. An interruption between them left the two disagreeing, with nothing on screen to show for it. It is now a single all-or-nothing write. |
| **Import preview stops looking like it hung** | On a 25,000-trade book, previewing a 5,000-row import took about 8 seconds with the app frozen throughout. Now roughly 20 ms. |
| **Data Quality opens instantly again** | If your traded symbols had no price marks — an F&O book against equity-only bhavcopy data — the page took about 10 seconds every time. Now under a third of a second. Prices written with different capitalisation are also no longer treated as different symbols, which could report a fresh price as stale. |

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
| **Clear pricing, in the app** | Two plans, stated plainly where you need them: **Pro — Annual ₹9,999/yr** (recommended then; Lifetime is now the recommended plan) and **Journal — Lifetime ₹29,999**. The free tier remains free forever — recording trades, every importer, backups. Prices shown in-app carry the date they were set, and the WhatsApp message quotes exactly what you saw. |

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
| **Help Desk** | Every screen described — what it answers, its honesty rules, and what it deliberately won't do — searchable, with a direct link to each. |
| **Delete, honestly** | Select trades to delete, remove an imported file (you choose whether its trades go too), or clear by date/broker/segment. Every delete shows exactly what will go before it goes, and the audit log keeps the full record. |
| **Import overlap warning** | Importing a P&L export after a transaction report used to record the same trades twice. The preview now names the overlapping rows and the file they came from, before anything commits. |
| **My Default Settings** | Your first configuration is saved as a baseline. Change anything freely — one click brings preferences and rate tables back. Your licence, trial and data are never touched. |
| **Dismissible warnings** | Advisory panels can be dismissed and stay hidden until the situation they describe actually changes. |

## Also in v2.98

| Workspace | What it gives you |
|---|---|
| **ITR Pack → Schedules** | Your figures in the return's own item codes — Schedule CG (A3 short-term, B4 long-term), Schedule BP and Schedule CFL — with the form indicated (ITR-2 or ITR-3). STT is handled correctly per head: excluded from capital-gains deductions, allowed as a business expense against intraday and F&O. Since v3.3.0 the statutory sections quoted alongside these follow the Act in force for each year. |
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

### Brokers with no API of their own — OpenAlgo (optional)

Groww, Paytm Money and Kotak offer no trade-book API, but they can still pull
same-day fills into Vyuha through **OpenAlgo** — an open-source bridge you run
on your own computer. It is **off by default** behind an in-app disclosure,
because it means running one more program that holds a broker credential: your
broker login goes into **your own OpenAlgo instance, never into Vyuha**, the
data flows only from your broker to your machine, and Vyuha's pull is read-only
and goes through the same preview → charges → duplicate-check pipeline as every
file import. The **Import Help** tab has step-by-step cards for setting it up.

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
