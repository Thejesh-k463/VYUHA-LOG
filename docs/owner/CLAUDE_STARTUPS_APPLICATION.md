# Claude for Startups — application record (2026-10-07)

Plan page (decision page, owner steps, spend plan): https://claude.ai/artifact/PFHxf1vCVRgBisqFHPNdFS
Program: https://claude.com/programs/startups · Form: https://platform.claude.com/offers/startups-application
Nothing has been submitted. Owner executes the steps; this file is the repo record.

## Decisions (reversible, recorded so they are not re-asked)
- Apply NOW as **Vyuha** under a Vyuha domain; do not wait for the house brand (BRAND-NAMING = NO NAME).
  Rejected: wait for brand; apply as MARKET SENTINEL (no public site, one key); apply as PLATFORM (not public).
  Console org is a label — rename when the house brand lands. Credits/Team attach to the org.
- Domain: `vyuhatrade.in` (fallbacks `getvyuha.in`, `vyuhadesk.in`). Modifier .in per B15, ₹0 premium per B06.
  RDAP 2026-10-07: vyuha.in / vyuha.com / vyuha.co.in registered; the candidates above had no record.
- Email: `founder@vyuhatrade.in` on Zoho Mail Free (send + receive). Cloudflare Email Routing is the fallback.
- Website: GitHub Pages custom domain. Pages serves `docs/` on main → the CNAME file is `docs/CNAME`.
- After acceptance: new API key in the Vyuha org → SENTINEL `.env` → restart; revoke the Gmail-org key.
- Claude Team: claim on the domain-email org (new to Team). Measure one Premium seat for a week before touching Max.

## Program facts (official FAQ, read 2026-10-07)
$1,000 API credits (expire 6 months after grant; first-party API only) · 1 year Claude Team, up to 5 Premium
seats, orgs new to Team only · higher rate limits · Startup Stack offers (Gamma 25%, ClickHouse $5K, Firecrawl…)
· Applied AI office hours every other week · eligibility: founded in last 5 years OR funded in last 2; bootstrapped
OK; Console account + company email matching the website domain + short description · decision in minutes or
2–3 business days · up to $100K extra only via a partner VC.

## Paste text
**Company / website:** Vyuha · https://vyuhatrade.in

**What are you building, and how does Claude fit?**
Vyuha builds software for Indian retail traders that records and explains, and never advises. Three products ship today. Vyuha is a local-first Windows trade journal that imports six brokers' exports, computes exact statutory charges and an ITR pack on the trader's own machine, and has issued paid licences since August 2026. MARKET SENTINEL is a market-intelligence bot that posts results, management guidance, insider and bulk-deal activity and surveillance changes to the buyer's own Telegram, running on their own machine. GAMMA-UNWIND is F&O open-interest automation with a local dashboard, shipping to clients. We are unifying them into one desk for Indian markets with an AI coach.

Claude is already in production. MARKET SENTINEL uses Claude Haiku 4.5 to read NSE concall transcripts and filing PDFs and extract management guidance as verbatim quotes; every extracted line must pass a quote-verification gate against the source document before it reaches a user. Next, the unified desk's coach uses Claude for natural-language questions over the trader's own SQLite journal, plain-language explanations of charges and tax, and proposed journal fixes that the user approves before anything changes. AI use is disclosed to users, every output is observation-only, and user data stays on the user's machine or in India.

Founded 2026. Bootstrapped, single founder-developer. The credits fund moving guidance extraction to Sonnet for accuracy and building the coach's evaluation harness.

## Never write
Win rates / returns / signal accuracy (SEBI posture) · macOS as sold · revenue beyond the licence ledger
(`node scripts/license-list.mjs`) · internal study/candidate/exit names or spec versions.

## Sources outside the repo
claude.com/programs/startups (FAQ) · TechCrunch 2026-10-06 · anthropic.com/legal/aup (finance = high-risk:
disclosure + human review) · Security Boulevard 2026-08 and creditforstartups.com (tips; their tier figures are
the OLD program).
