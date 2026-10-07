# Claude for Startups — application record (2026-10-07)

Plan page (decision page, owner steps, spend plan): https://claude.ai/artifact/PFHxf1vCVRgBisqFHPNdFS
Program: https://claude.com/programs/startups · Form: https://platform.claude.com/offers/startups-application
SUBMITTED 2026-10-08 (see STATUS block). This file is the repo record.

## STATUS 2026-10-08 00:40 IST — SUBMITTED (read this block first; it outranks the rest of the file)

Submitted 2026-10-08 ~00:35 IST from the Console org **VyuhaLens** (owner founder@vyuhalens.com). On-screen:
"Thanks for submitting! We'll review your application and email you with next steps." Decision mail goes to
founder@vyuhalens.com (mail.zoho.in; check Spam once). Everything below this block was built and VERIFIED on 2026-10-07/08:

| Item | State | Verified by |
|---|---|---|
| Domain `vyuhalens.com` | bought at Cloudflare Registrar, Cloudflare DNS, auto-renew | registrar panel; NS = abdullah/julissa.ns.cloudflare.com |
| Mailbox `founder@vyuhalens.com` | Zoho Mail Lite, 1 user, INR 826/yr, auto-renews 7 Oct 2027 | MX mx/mx2/mx3.zoho.in, SPF, DKIM zmail._domainkey all resolve |
| Website | https://vyuhalens.com = GitHub Pages (VYUHA-LOG docs/), HTTPS enforced, www -> root, old github.io -> 301 | curl 200, ssl_verify 0; commit a104373 |
| Landing page | footer founder@vyuhalens.com, (c) VyuhaLens, "Also from VyuhaLens" line (SENTINEL + GAMMA-UNWIND) | live page grep |
| Console org | VyuhaLens, Small or medium business, no payment method, no invites, advice-to-consumers = No, under-18 = No | onboarding screens |
| Form | First/Last Thejeswar Reddy; Founder; India, Kadapa; Financial Services; founded July 2026; Not yet raised; no outside funding; AI spend 81-100%; LinkedIn given; email updates ticked | JS read-back before submit |

**Submitted texts (both fields are capped at 500 chars; the long paste text below was NOT used):**

What are you building on Claude? (490 chars)
> One desk for Indian retail traders that explains the trader's own record and never advises. Three products ship: Vyuha trade journal (paid since Aug 2026), MARKET SENTINEL intelligence bot, GAMMA-UNWIND F&O OI automation. Claude in production: SENTINEL extracts management guidance from NSE concall and filing PDFs as verbatim quotes, each gated against the source. Next: Claude narration of the Vyuha journal, then the desk's coach: SQL and rows shown, user-approved proposals, eval-gated.

Where do you want support from Anthropic? (471 chars)
> Applied AI office hours on the quote-verification gate behind MARKET SENTINEL's guidance extraction, and on the evaluation gate the desk's coach must pass before any prompt or model ships (text-to-SQL over the user's own data, user-approved proposals, refusal of advice prompts). API credits to move extraction from Haiku to Sonnet and to build the eval suites. Higher rate limits for the extraction pipeline. Claude Team for Claude Code, which builds all three products.

**Pending, in order (owner unless marked):**
1. Decision email -> if accepted: Console -> Claude Startups page -> claim the $1,000 credits AND the Claude Team offer on the SAME org; note the grant date (credits expire 6 months later).
2. Console -> Settings -> Members -> invite thejesh463.git@gmail.com as **Developer** (not Admin).
3. SENTINEL session: owner creates key `sentinel-prod` in the VyuhaLens org -> replace ANTHROPIC_API_KEY in SENTINEL .env -> restart with SENTINEL's own procedure (bot down briefly) -> confirm usage appears in the VyuhaLens org -> revoke the Gmail-org key.
4. Team seat trial: one week of Claude Code on founder@ Premium seat; read the usage card; only then decide Max.
5. If rejected: confirm site + email still resolve, resubmit the same texts; no appeal process published.
6. Separate decisions, NOT part of this record: website redesign (Vyuha session, Opus builder, reference-first per design memory, v4.7/v4.8 features from VYUHA-STATE); support-email migration (RECEIPT_TEMPLATE.md + feedback-form OWNER_EMAIL still say the Gmail); buy `vyuhalens.in` as a redirect; Learn-brief Q1-Q8 (PLATFORM W2-00).

Traps met on the way: Zoho "Forever Free" is NOT offered on the India DC (zoho.in) for new orgs -> Mail Lite; Cloudflare Registrar sells no .in; `gh api -f https_enforced=true` sends a string (422) -> use `-F`; Zoho's domain field shows a static `www.` prefix it strips itself.

## Decisions (reversible, recorded so they are not re-asked)
- **Identity (2026-10-07 evening):** apply ONCE, as one company, platform-first. The form says **Vyuha** because it is the
  only name with a site + matching email today; the description leads with the all-in-one desk that teaches by explaining
  the trader's own record, uses Vyuha / MARKET SENTINEL / GAMMA-UNWIND as shipped proof, and lays out Claude now (SENTINEL) /
  next (Vyuha Intelligence narration adapter, STATE backlog item 4) / then (desk coach + Learn layer, D64/D68/D69/D71, E01-E03).
  Rejected: Vyuha-only journal pitch (undersells); PLATFORM-only (no name/site/users, weakest under the AUP finance rule and
  SEBI's 2025 educator guidance); SENTINEL as applicant (no site). Education is worded as explanation of definitions and of
  the user's own record, never advice. The org is renamed + a domain added when the house brand lands; never a second org.
- Landing page gets `founder@vyuhalens.com` in the footer and one "Also from VyuhaLens" line naming MARKET SENTINEL and
  GAMMA-UNWIND, observation-only wording, no numbers.
- Apply NOW as **Vyuha** under a Vyuha domain; do not wait for the house brand (BRAND-NAMING = NO NAME).
  Rejected: wait for brand; apply as MARKET SENTINEL (no public site, one key); apply as PLATFORM (not public).
  Console org is a label — rename when the house brand lands. Credits/Team attach to the org.
- Domain (OWNER pick 2026-10-07 evening, PRIMARY = .com per owner "will go with Vyuhalens.com"): `vyuhalens.com` is the
  website + email (`founder@vyuhalens.com`); `vyuhalens.in` bought as a defensive redirect (not needed for the
  application). The program scores neither TLD; .com clears every later surface (Rainmatter, VCs, KYC). Buy the .com at
  Cloudflare Registrar (at cost, card; DNS included) or at the Indian UPI registrar. Org + form name **VyuhaLens**,
  product stays Vyuha. `vyuhalens.in` DROPPED: B08 bans "trade-". Rejected: FinanceVyuha (12 letters, breaks B02;
  "Finance" prefix reads as a content channel under SEBI's educator guidance); vyuha.app / vyuhahq.in / vyuhalabs.in /
  vyuhadesk.in (free, not chosen). Fallback if taken: `vyuhahq.com` + `vyuhahq.in`.
  RDAP + NS 2026-10-07 evening: vyuhalens .in/.com/.app/.co.in free; vyuha .in/.com/.co.in/.co/.io/.dev/.ai/.net registered.
- Email: `founder@vyuhalens.com` on Zoho Mail Free (send + receive). Cloudflare Email Routing is the fallback.
- Cloudflare (checked 2026-10-07, cloudflare.com/tld-policies): Registrar sells .com/.app at cost, NOT .in, cards only.
  Use it for DNS of both domains (free); Email Routing is receive-only so Zoho keeps the mailbox; Pages not needed
  (GitHub Pages already deploys). Proxy OFF on the GitHub records until HTTPS is enforced.
- Website: GitHub Pages custom domain `vyuhalens.com`. Pages serves `docs/` on main → the CNAME file is `docs/CNAME`.
- After acceptance: new API key in the Vyuha org → SENTINEL `.env` → restart; revoke the Gmail-org key.
- Claude Team: claim on the domain-email org (new to Team). Measure one Premium seat for a week before touching Max.

## Program facts (official FAQ, read 2026-10-07)
$1,000 API credits (expire 6 months after grant; first-party API only) · 1 year Claude Team, up to 5 Premium
seats, orgs new to Team only · higher rate limits · Startup Stack offers (Gamma 25%, ClickHouse $5K, Firecrawl…)
· Applied AI office hours every other week · eligibility: founded in last 5 years OR funded in last 2; bootstrapped
OK; Console account + company email matching the website domain + short description · decision in minutes or
2–3 business days · up to $100K extra only via a partner VC.

## Paste text
**Company / website:** VyuhaLens · https://vyuhalens.com

**What are you building, and how does Claude fit?**
VyuhaLens is building one desk for Indian retail traders that teaches finance by explaining the trader's own record, and never advises. Three products ship today and are being unified into that desk. Vyuha is a local-first Windows trade journal: six brokers' exports in, statutory charges computed to the rupee, an ITR pack, and an Intelligence lens that states plain-language observations about the trader's own journal; paid licences since August 2026. MARKET SENTINEL posts results, management guidance, insider and bulk-deal activity and surveillance changes to the buyer's own Telegram, running on their own machine. GAMMA-UNWIND is F&O open-interest automation with a local dashboard, shipping to clients. MARKET SENTINEL's intelligence already feeds Vyuha's desk, sector mapping and F&O views, and is being folded into Vyuha and the unified desk.

Claude is already in production. MARKET SENTINEL uses Claude Haiku 4.5 to read NSE concall transcripts and filing PDFs and extract management guidance as verbatim quotes; every line must pass a quote-verification gate against the source document before a user sees it. Next, Vyuha's Intelligence lens gets a Claude narration adapter over its existing fact contract, so each sentence a trader reads is tied to the fact it came from. Then the unified desk's coach and learn layer: questions over the trader's own data answered with the SQL and rows shown, "explain this number", a glossary and concept cards drafted from exchange and SEBI definitions with citations and reviewed by a human, and practice drills on market data at least three months old. Every AI write is a proposal the user approves, and no prompt or model ships until an evaluation suite passes, including prompts that ask when to buy a stock, which must be refused. AI use is disclosed, every output is an observation with its source shown, and user data stays on the user's machine or in India.

Founded 2026. Bootstrapped, single founder-developer. The credits move guidance extraction to Sonnet for accuracy and fund the Vyuha adapter and the evaluation suites.

## Never write
Win rates / returns / signal accuracy (SEBI posture) · macOS as sold · revenue beyond the licence ledger
(`node scripts/license-list.mjs`) · internal study/candidate/exit names or spec versions.

## Sources outside the repo
claude.com/programs/startups (FAQ) · TechCrunch 2026-10-06 · anthropic.com/legal/aup (finance = high-risk:
disclosure + human review) · Security Boulevard 2026-08 and creditforstartups.com (tips; their tier figures are
the OLD program).
