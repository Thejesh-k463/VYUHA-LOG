# Claude for Startups — application record (2026-10-07)

Plan page (decision page, owner steps, spend plan): https://claude.ai/artifact/PFHxf1vCVRgBisqFHPNdFS
Program: https://claude.com/programs/startups · Form: https://platform.claude.com/offers/startups-application
Nothing has been submitted. Owner executes the steps; this file is the repo record.

## Decisions (reversible, recorded so they are not re-asked)
- **Identity (2026-10-07 evening):** apply ONCE, as one company, platform-first. The form says **Vyuha** because it is the
  only name with a site + matching email today; the description leads with the all-in-one desk that teaches by explaining
  the trader's own record, uses Vyuha / MARKET SENTINEL / GAMMA-UNWIND as shipped proof, and lays out Claude now (SENTINEL) /
  next (Vyuha Intelligence narration adapter, STATE backlog item 4) / then (desk coach + Learn layer, D64/D68/D69/D71, E01-E03).
  Rejected: Vyuha-only journal pitch (undersells); PLATFORM-only (no name/site/users, weakest under the AUP finance rule and
  SEBI's 2025 educator guidance); SENTINEL as applicant (no site). Education is worded as explanation of definitions and of
  the user's own record, never advice. The org is renamed + a domain added when the house brand lands; never a second org.
- Landing page gets `founder@vyuhatrade.in` in the footer and one "Also from Vyuha" line naming MARKET SENTINEL and
  GAMMA-UNWIND, observation-only wording, no numbers.
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
Vyuha is building one desk for Indian retail traders that teaches finance by explaining the trader's own record, and never advises. Three products ship today and are being unified into that desk. Vyuha is a local-first Windows trade journal: six brokers' exports in, statutory charges computed to the rupee, an ITR pack, and an Intelligence lens that states plain-language observations about the trader's own journal; paid licences since August 2026. MARKET SENTINEL posts results, management guidance, insider and bulk-deal activity and surveillance changes to the buyer's own Telegram, running on their own machine. GAMMA-UNWIND is F&O open-interest automation with a local dashboard, shipping to clients.

Claude is already in production. MARKET SENTINEL uses Claude Haiku 4.5 to read NSE concall transcripts and filing PDFs and extract management guidance as verbatim quotes; every line must pass a quote-verification gate against the source document before a user sees it. Next, Vyuha's Intelligence lens gets a Claude narration adapter over its existing fact contract, so each sentence a trader reads is tied to the fact it came from. Then the unified desk's coach and learn layer: questions over the trader's own data answered with the SQL and rows shown, "explain this number", a glossary and concept cards drafted from exchange and SEBI definitions with citations and reviewed by a human, and practice drills on market data at least three months old. Every AI write is a proposal the user approves, and no prompt or model ships until an evaluation suite passes, including prompts that ask when to buy a stock, which must be refused. AI use is disclosed, every output is an observation with its source shown, and user data stays on the user's machine or in India.

Founded 2026. Bootstrapped, single founder-developer. The credits move guidance extraction to Sonnet for accuracy and fund the Vyuha adapter and the evaluation suites.

## Never write
Win rates / returns / signal accuracy (SEBI posture) · macOS as sold · revenue beyond the licence ledger
(`node scripts/license-list.mjs`) · internal study/candidate/exit names or spec versions.

## Sources outside the repo
claude.com/programs/startups (FAQ) · TechCrunch 2026-10-06 · anthropic.com/legal/aup (finance = high-risk:
disclosure + human review) · Security Boulevard 2026-08 and creditforstartups.com (tips; their tier figures are
the OLD program).
