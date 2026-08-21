# Rainmatter "Application for Startups" — draft answers for Vyuha

Form: https://docs.google.com/forms/d/e/1FAIpQLSdVGWIbY6Zp-8Doxkx9c36Q651zpCg2oOcgrkf6y3Lrb7xw1A/viewform
(created inside Zerodha; read 2026-08-15; NOTHING was submitted). It records the Google account
that submits, requires a **pitch deck upload (PDF/PPT/video, ≤10 MB)**, and asks funding-round
questions. Every product number below is from `lib/domain/pricing-comparison.ts`, `docs/client/README.md`
and `README.md`; the commercial numbers marked `[[…]]` are yours to decide — do not let anyone
invent them. SEBI posture: no returns / accuracy-of-signals / win-rate claims (Vyuha is a
record-keeping and analytics tool, not advice).

| Field | Answer (paste) |
|---|---|
| Email | your Google account email (auto-recorded) |
| Name | [[YOUR FULL NAME]] |
| Phone | [[PHONE]] (WhatsApp +91 73936 73714 if that is the business line) |
| Name of your startup? | **Vyuha** — a local-first trade journal for Indian retail traders (https://thejesh-k463.github.io/VYUHA-LOG/) |

**What is the problem you are trying to solve? (3–4 sentences)**
> Indian retail traders have no honest place to keep their own record. Broker consoles show one
> broker's book, spreadsheets rot, and every journaling product on the market is a global,
> web-hosted subscription (≈₹12,600–31,600/yr) that does not know STT, stamp duty or GST and
> keeps the trader's data on someone else's server. So most traders never see *why* they lose:
> which setup, which hour, which broker's charges — and their tax season is a copy-paste exercise
> across contract notes. The two Indian entrants cap the free tier at a handful of trades and are
> web-hosted too.

**Describe your solution to the problem? (3–4 sentences)**
> Vyuha is a Windows desktop journal where the trader's record lives in a SQLite file on their
> own machine — no server, no account, no telemetry. It auto-detects six brokers' exports
> (Zerodha, Dhan, Groww, Angel One, Upstox, Paytm Money), maps any other CSV, and pulls
> directly from the Kite and Dhan APIs (Angel One SmartAPI's unattended pull is fixed and
> ships in the next release), then computes statutory charges from
> configurable rate tables — within 0.69% of a real broker report across 92 verified rows
> (brokerage excluded, because it is not derivable from the file). On top of that record sit
> staged positions with per-tranche stops, an options-seller journal, an ITR/AIS/advance-tax
> pack, MTF margin lists for seven brokers (10,501 stocks), risk cockpit and behaviour analytics
> — the core journal is free forever with no trade or account caps; the analytics are the paid
> part (₹9,999/yr or ₹29,999 once at launch pricing). Every report returns "—" rather than
> invent a number.

**If you have a product demo, provide link.**
> Landing page with screenshots and pricing: https://thejesh-k463.github.io/VYUHA-LOG/
> Installer (7-day full trial, no signup): https://github.com/Thejesh-k463/VYUHA-LOG/releases/latest
> [[Optional: a 2-minute screen recording — record the getting-started deck flow: install → import
> → mark → first review; upload to YouTube unlisted and paste the link]]

**Category:** Capital Markets *(secondary fit: WealthTech and Portfolio Management — pick Capital Markets)*

**Current progress of your product?**
> Advanced stage — shipping. 61 tagged releases; current v2.99.100 (Windows installer with a
> signed auto-updater channel and remote licence revocation — the installer itself is not
> Authenticode code-signed, a deliberate cost decision); 1,921 unit tests across 131 files and 45
> Playwright flows on
> every commit; 14 load tests to a 250k-trade book; per-buyer licensing, 7-day offline trial,
> free tier that never gates the user's own record. In use by early traders and SEBI-RA
> colleagues; first paid licences issued. Windows only today; the Mac build exists in CI but is not sold.

**Have you raised any external funding?**
> No. Bootstrapped and built by a single founder-developer. [[edit if not accurate]]

**Revenue stage:** Early revenue *(if ≥1 paid licence has been issued; else Pre-revenue)*

**Revenue run rate (in Rs):** [[e.g. "₹X annualised — N licences sold to date at ₹9,999/yr and
₹29,999 lifetime; launch pricing until 2027-01-01, list ₹13,000/₹35,999 after"]] — use the ledger
(`node scripts/license-list.mjs`) for N; never overstate.

**Burn rate/month (in Rs):** [[monthly revenue − monthly expenses; for a solo bootstrapped
product this is roughly −(tooling + hosting ≈ ₹0 + your time). State it plainly, e.g. "≈ −₹5,000/mo
(tooling, domain, signing) — no salaries yet"]]

**Current round size (in Rs):** [[decide: e.g. "Not raising a priced round today; seeking a
Rainmatter partnership (Kite Connect read-scope / consent-based feed) first, and open to a
₹25–50 lakh pre-seed to fund broker integrations, a Mac/Web build and creator-led distribution"]]

**Round structure — committed investors and soft commitments:** [[e.g. "None yet — this is the
first conversation"]]

**Valuation for the round (in Rs):** [[e.g. "To be discussed; no prior priced round"]]

**Upload a pitch deck** — REQUIRED. Build `docs/owner/RAINMATTER_DECK.pdf` (≤10 MB) with the
slides the form itself lists: Problem · Solution · Market (India's ~15 crore demat accounts,
~1 crore+ active F&O traders — cite SEBI/NSE numbers you verify) · Competition (the 7-row table
from `lib/domain/pricing-comparison.ts`) · Competitive advantages (local-first, charges engine
0.69%, free never-gated core, six-broker auto-detect, honesty positioning) · Product (8–10
screenshots from `docs/screenshots/`) · Traction (releases, tests, first licences, creator
outreach) · Business model (₹9,999/yr, ₹29,999 lifetime; WhatsApp checkout today, payment page
next; creators get review keys) · Basic forecast [[yours]] · The ask (partnership + optional
pre-seed) · Team. `docs/client/GETTING_STARTED_DECK.html` is a buyer walkthrough, not this deck.

## Hooks that make it land (use across the answers/deck)
- "Zerodha traders are already our largest import source — via Console exports and their own
  Kite Connect apps. We are asking to make that one consent." (ties to `ZERODHA_PROPOSAL.md`)
- "Data moves Zerodha → trader's machine and nowhere else. We do not want a copy."
- "Charges are computed, not copied — the trader can reconcile us against your contract note."
- "The core journal is free forever and never metered — the same reasoning as free equity delivery."

## What NOT to write
No win-rate/edge/returns claims; no "Zerodha partner" implication; no macOS as a sold platform;
no invented revenue or valuation — a blank `[[…]]` is better than a made-up number.
