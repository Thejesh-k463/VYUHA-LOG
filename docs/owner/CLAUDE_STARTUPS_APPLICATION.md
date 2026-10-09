# Claude for Startups — application record (2026-10-07)

Plan page (decision page, owner steps, spend plan): https://claude.ai/artifact/PFHxf1vCVRgBisqFHPNdFS
Program: https://claude.com/programs/startups · Form: https://platform.claude.com/offers/startups-application
DECLINED 2026-10-09; REAPPLY in progress (see STATUS block). This file is the repo record.

## STATUS 2026-10-09 — DECLINED (verification); fixing evidence, then REAPPLY (read this block first)

**Decline:** claudestartups@mail.anthropic.com, 09 Oct 00:52 IST, "Your application was not approved". Usual causes per the
mail: outside the founded-5y / funded-2y window, or "we couldn't verify it from the details in the application". Tips: work
email matching the domain, add the company website. July 2026 is inside the window, so the cause is VERIFICATION.
Evidence found 09 Oct (curl + RDAP + Fable research agent): (1) vyuhalens.com root was a 726-byte meta-refresh stub titled
"Vyuha — Trade Journal" with no company, founder or location; (2) domain registered 2026-10-07T16:53Z, ~2 h before applying (19:05Z);
(3) no third-party footprint (web search for VyuhaLens = nothing, no LinkedIn company page, no registry record); (4) the
website field may have been left empty (owner does not remember). No appeal process and no program mailbox are published;
replies to mail.anthropic.com reach no one. Support route if declined twice: Console -> initials -> Get help -> escalate.

**Fix (owner ruling 09 Oct: fix evidence, reapply as soon as it is ready, no fixed date):**
- Company site: `docs/index.html` (real VyuhaLens homepage + Organization JSON-LD), `docs/about.html`, `docs/contact.html`,
  `docs/privacy.html`, `docs/terms.html`, shared `docs/site.css`; landing-page footer links back. Public details approved by
  the owner: K. Thejeswar Reddy, Kadapa AP, +91 70131 61450, LinkedIn /in/k-thejeswar-reddy-81aa12116.
- Logo (owner pick "D — family", 09 Oct): `docs/brand/vyuhalens-logo.svg` + 600/300/180/32 PNG; the Vyuha ring closed
  with an ember arc, the व outline from `public/brand/vyuha-mark.svg` (never a text node). Favicon, og:image, nav, JSON-LD logo.
- Site publishing (owner ruling 09 Oct): Pages build_type = workflow; `.github/workflows/pages.yml` deploys an ALLOWLIST
  (company pages, brand/, sales/landing-page + brochure, screenshots/, CNAME). `docs/owner/`, DECISIONS, LEDGER etc. are no
  longer served on the domain; they stay on github.com because the repo stays public (the updater reads its Releases).
  A new public page must be added to the workflow's copy list AND its `paths:` filter.
- Owner: LinkedIn company page "VyuhaLens" (website = vyuhalens.com; 0-1 employees; Sole proprietorship; logo = the 300 PNG)
  + Founder role on the personal profile; then the company-page URL goes into the site footer and JSON-LD.
- Owner, optional: Udyam registration (free; Proprietary; NIC 62011) -> number in the site footer. Facts read 09 Oct from
  S.O. 2119(E) and the portal: one registration per enterprise (all of one PAN = one enterprise; more activities are ADDED,
  a future company/LLP files its own); no GST needed below the s.22 threshold; no fee, no renewal; keep ITR/GST details
  updated (para 8, else suspension); false declaration = MSMED s.27 penalty; cancel via "Update/Cancel Udyam Registration".
- Reapply from the SAME Console org with founder@vyuhalens.com, website https://vyuhalens.com, LinkedIn = company page.

**Reapply text — What are you building on Claude? (485 chars):**
> VyuhaLens (vyuhalens.com; founded July 2026, Kadapa, India) builds one desk for Indian retail traders that explains the trader's own record and never advises. Shipping: Vyuha trade journal (paid since Aug 2026), MARKET SENTINEL market-intelligence bot, GAMMA-UNWIND F&O automation. Claude in production: SENTINEL extracts management guidance from NSE filings as verbatim quotes, each gated against the source. Next: Claude narration of the Vyuha journal, then an eval-gated desk coach.

Support field: reuse the 471-char text below unchanged.

### First submission (2026-10-08) — history

Submitted 2026-10-08 ~00:35 IST from the Console org **VyuhaLens** (owner founder@vyuhalens.com). On-screen:
"Thanks for submitting! We'll review your application and email you with next steps." Decision mail goes to
founder@vyuhalens.com (mail.zoho.in). **Check Spam every time:** the Anthropic receipt (invoice+statements@mail.anthropic.com,
#2077-5605-2979, 08 Oct 10:08) was filed in Zoho Spam. Inbox + Spam read 08 Oct 14:15 IST: no decision mail yet (expected).
Everything below this block was built and VERIFIED on 2026-10-07/08:

| Item | State | Verified by |
|---|---|---|
| Domain `vyuhalens.com` | bought at Cloudflare Registrar, Cloudflare DNS, auto-renew | registrar panel; NS = abdullah/julissa.ns.cloudflare.com |
| Mailbox `founder@vyuhalens.com` | Zoho Mail Lite, 1 user, INR 826/yr, auto-renews 7 Oct 2027 | MX mx/mx2/mx3.zoho.in, SPF, DKIM zmail._domainkey all resolve |
| Website | https://vyuhalens.com = GitHub Pages (VYUHA-LOG docs/), HTTPS enforced, www -> root, old github.io -> 301 | curl 200, ssl_verify 0; commit a104373 |
| Landing page | footer founder@vyuhalens.com, (c) VyuhaLens, "Also from VyuhaLens" line (SENTINEL + GAMMA-UNWIND) | live page grep |
| Console org | VyuhaLens, Small or medium business, advice-to-consumers = No, under-18 = No; $5 credits bought 08 Oct (invoice SVDZ4DCF-0001, expire 9 Oct 2027), Visa on file, $500/mo limit; no invites yet | billing page |
| SENTINEL on the new org | workspace `Sentinel`, key `sentinel-prod`; LLM_API_KEY swapped in SENTINEL/bot/sentinel/.env; `/restart` 12:15 IST 08 Oct; bot online as @Tradesentina_bot; org spend $0.02 by 14:00 | Telegram online card; Console billing $4.99 |
| Haiku 5.5 | SENTINEL `guidance.model` -> `claude-haiku-5-5` + price row, UNCOMMITTED in SENTINEL/bot working tree (config.yaml); `llm.model` stays Haiku 4.5 because verdict/llm.py pins temperature=0 at 4 call sites (Haiku 5.5 400s on it) | git diff in SENTINEL/bot; no API 4xx in logs/sentinel.log since restart |
| Form | First/Last Thejeswar Reddy; Founder; India, Kadapa; Financial Services; founded July 2026; Not yet raised; no outside funding; AI spend 81-100%; LinkedIn given; email updates ticked | JS read-back before submit |

**Submitted texts (both fields are capped at 500 chars; the long paste text below was NOT used):**

What are you building on Claude? (490 chars)
> One desk for Indian retail traders that explains the trader's own record and never advises. Three products ship: Vyuha trade journal (paid since Aug 2026), MARKET SENTINEL intelligence bot, GAMMA-UNWIND F&O OI automation. Claude in production: SENTINEL extracts management guidance from NSE concall and filing PDFs as verbatim quotes, each gated against the source. Next: Claude narration of the Vyuha journal, then the desk's coach: SQL and rows shown, user-approved proposals, eval-gated.

Where do you want support from Anthropic? (471 chars)
> Applied AI office hours on the quote-verification gate behind MARKET SENTINEL's guidance extraction, and on the evaluation gate the desk's coach must pass before any prompt or model ships (text-to-SQL over the user's own data, user-approved proposals, refusal of advice prompts). API credits to move extraction from Haiku to Sonnet and to build the eval suites. Higher rate limits for the extraction pipeline. Claude Team for Claude Code, which builds all three products.

**Pending, in order (owner unless marked):**
0. Zoho -> Spam -> open the Anthropic receipt -> **Not Spam** (and allowlist `mail.anthropic.com` under Settings -> Anti-spam -> Allowed list), so the next decision mail (the reapply) lands in Inbox.
1. REAPPLY (see the STATUS block): site live (DONE 09 Oct, 82c4325) -> LinkedIn company page -> (optional) Udyam -> resubmit. Decision mail again to founder@ (check Spam). If accepted: Console -> Claude Startups page -> claim the $1,000 credits AND the Claude Team offer on the SAME org; note the grant date (credits expire 6 months later).
2. Console -> Settings -> Members -> invite thejesh463.git@gmail.com as **Developer** (not Admin).
3. DONE 08 Oct 12:15 (key swap + restart, usage confirmed). STILL OPEN: owner revokes the old key in the Gmail-org Console. SENTINEL session: ship the uncommitted config.yaml change via ship.py; remove the temperature=0 pins in verdict/llm.py so `llm.model` can follow to Haiku 5.5; watch quote-gate rejections / truncated JSON on guidance (Haiku 5.5 thinks by default; raise guidance.max_tokens or set effort low if seen).
4. Team seat trial: one week of Claude Code on founder@ Premium seat; read the usage card; only then decide Max.
5. Declined once (09 Oct) for verification — resubmitting the same texts unchanged is NOT the fix; see the STATUS block. If declined a second time: Console -> Get help -> escalate, citing the evidence URLs.
6. Separate decisions, NOT part of this record: website redesign (Vyuha session, Opus builder, reference-first per design memory, v4.7/v4.8 features from VYUHA-STATE); support-email migration (RECEIPT_TEMPLATE.md + feedback-form OWNER_EMAIL still say the Gmail); buy `vyuhalens.in` as a redirect; Learn-brief Q1-Q8 (PLATFORM W2-00).

Traps met on the way: Zoho "Forever Free" is NOT offered on the India DC (zoho.in) for new orgs -> Mail Lite; Cloudflare Registrar sells no .in; `gh api -f https_enforced=true` sends a string (422) -> use `-F`; Zoho's domain field shows a static `www.` prefix it strips itself.

## Decisions (reversible, recorded so they are not re-asked)
- (Superseded in naming: the org and form became **VyuhaLens** — see the Domain bullet; "Vyuha" below is the pre-domain wording.)
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
  website + email (`founder@vyuhalens.com`); `vyuhalens.in` NOT bought (open decision, Pending 6; not needed for the
  application). The program scores neither TLD; .com clears every later surface (Rainmatter, VCs, KYC). Buy the .com at
  Cloudflare Registrar (at cost, card; DNS included) or at the Indian UPI registrar. Org + form name **VyuhaLens**,
  product stays Vyuha. `vyuhalens.in` DROPPED: B08 bans "trade-". Rejected: FinanceVyuha (12 letters, breaks B02;
  "Finance" prefix reads as a content channel under SEBI's educator guidance); vyuha.app / vyuhahq.in / vyuhalabs.in /
  vyuhadesk.in (free, not chosen). Fallback if taken: `vyuhahq.com` + `vyuhahq.in`.
  RDAP + NS 2026-10-07 evening: vyuhalens .in/.com/.app/.co.in free; vyuha .in/.com/.co.in/.co/.io/.dev/.ai/.net registered.
- Email: `founder@vyuhalens.com` on Zoho Mail Lite (send + receive; Free is not offered on the India DC). Cloudflare Email Routing is the fallback.
- Cloudflare (checked 2026-10-07, cloudflare.com/tld-policies): Registrar sells .com/.app at cost, NOT .in, cards only.
  Use it for DNS of both domains (free); Email Routing is receive-only so Zoho keeps the mailbox; Pages not needed
  (GitHub Pages already deploys). Proxy OFF on the GitHub records until HTTPS is enforced.
- Website: GitHub Pages custom domain `vyuhalens.com`. Pages serves `docs/` on main → the CNAME file is `docs/CNAME`.
- DONE 08 Oct 12:15, before any decision: new API key in the VyuhaLens org → SENTINEL `.env` → restart. Still open: revoke the Gmail-org key.
- Claude Team: claim on the domain-email org (new to Team). Measure one Premium seat for a week before touching Max.

## Program facts (official FAQ, read 2026-10-07)
$1,000 API credits (expire 6 months after grant; first-party API only) · 1 year Claude Team, up to 5 Premium
seats, orgs new to Team only · higher rate limits · Startup Stack offers (Gamma 25%, ClickHouse $5K, Firecrawl…)
· Applied AI office hours every other week · eligibility: founded in last 5 years OR funded in last 2; bootstrapped
OK; Console account + company email matching the website domain + short description · decision in minutes or
2–3 business days · up to $100K extra only via a partner VC.

## Paste text — SUPERSEDED (never submitted; carries the retired "local-first" slogan and a stale model name). Use the STATUS block's reapply text.
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
