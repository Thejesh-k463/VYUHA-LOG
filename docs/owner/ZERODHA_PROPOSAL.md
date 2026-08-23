# Zerodha — integration proposal (email + X/Twitter messages)

Owner-only. Drafted 2026-08-15, refreshed 2026-08-20 against v2.99.99. Every product claim below is taken from
`lib/domain/pricing-comparison.ts`, `docs/client/README.md` and the README; do not add
outcome, accuracy or returns language (SEBI posture — `MONETIZATION_PLAN.md` §5).

**What is being asked.** Today Vyuha reads Zerodha two ways, both user-driven: the Console
tradebook / P&L export (auto-detected parser) and a Kite Connect pull (the user's own API key
and access token, stored encrypted on their machine). Both work, but each puts the burden on
the trader — download a file, or register and pay for a Kite Connect app. The proposal is a
**consent-based, read-only data path from Zerodha to Vyuha** — an Account-Aggregator-style
flow (or a Zerodha partner/read-scope arrangement) where the trader approves once inside
their Zerodha login and Vyuha receives tradebook, P&L and charges directly, on the trader's
own machine. Nothing else about Vyuha changes: no cloud, no server, no data leaves the
user's computer.

Placeholders: `[[YOUR NAME]]`, `[[EMAIL]]`, `[[PHONE]]`. Landing page:
https://thejesh-k463.github.io/VYUHA-LOG/ · Repo: https://github.com/Thejesh-k463/VYUHA-LOG

---

## 0. Contact map — verified 2026-08-15 against Zerodha's own pages

Decoded from the Cloudflare-obfuscated addresses on zerodha.com; nothing here is guessed.

| Purpose | Contact | Source | Use it for |
|---|---|---|---|
| **Kite Connect partnerships / business** | **talk@rainmatter.com** | zerodha.com/products/api ("Are you a business? … Drop us an e-mail") | **Send the email in §1 here first.** Rainmatter is Zerodha's fintech arm; the API page routes business/platform partnerships to it |
| Rainmatter (funding + "financial APIs, industry networks") | https://rainmatter.com → "Apply now" Google Form; @Rainmatterin on X/LinkedIn | rainmatter.com | If the pitch also becomes an investment/incubation conversation |
| Kite Connect technical questions | https://kite.trade/forum/discussions | Zerodha support article "Kite connect API – FAQs" (no phone/ticket support for the API) | Sandbox / read-scope / token questions once someone engages |
| Kite Connect developer signup | https://developers.kite.trade/signup | zerodha.com/products/api | Register the Vyuha app (Personal free; Connect ₹500/mo) |
| Managing Director | Nithin Kamath — nithin.k@zerodha.com | zerodha.com/contact (Key management, published) | Only as a copy-line after the X mention, or if talk@ goes unanswered ~2 weeks |
| CFO | Nikhil Kamath — nikhil.k@zerodha.com | zerodha.com/contact | Same as above |
| Whole-Time Director (Varsity, education) | Karthik Rangappa — karthik_r@zerodha.com | zerodha.com/contact | Educational/creator angle only |
| CISO | Shravan B K — shravan.k@zerodha.com | zerodha.com/contact | Only if a security review of the consent flow is requested |
| Press | press@zerodha.com | zerodha.com/contact | Not for this proposal |
| Complaints / DP / support | complaints@zerodha.com, dp@zerodha.com, support@zerodha.com | zerodha.com/contact | Not for this proposal |
| Account Aggregator ecosystem | services@sahamati.org.in (Sahamati, AA common services) | sahamati.org.in | If the AA route is chosen: Vyuha would need an FIU/TSP arrangement; Zerodha is an FIU via Perfios AA and Onemoney AA (zerodha.com/tos/account-aggregator) |

Sequence: (1) email talk@rainmatter.com; (2) same day, the X thread in §2; (3) after ~10 working
days without reply, a short follow-up to talk@ with nithin.k@ in CC. Do not mass-mail the
management table — those addresses are published for regulatory contact, not partnerships.

## 1. Email — to Zerodha partnerships / Kite Connect team

**To:** talk@rainmatter.com — the address Zerodha's own Kite Connect page names for businesses
("Are you a business? … Let 16+ million clients of Zerodha seamlessly access your platform. Drop
us an e-mail at talk@rainmatter.com", zerodha.com/products/api, verified 2026-08-15). See §0 for the
full contact map.
**Subject options:**
- Vyuha × Zerodha — a consent-based, read-only journal integration (no cloud, data stays on the trader's PC)
- Proposal: an Account-Aggregator-style read path from Zerodha into a local-first trade journal
- Zerodha traders already import into Vyuha by hand — a proposal to make it one consent

> Dear Zerodha team,
>
> I am [[YOUR NAME]], the developer of **Vyuha**, a local-first trade journal for Indian
> retail traders. It runs as a Windows desktop application; the trader's record lives in a
> SQLite file on their own machine, there is no server, no account and no telemetry. The
> only network call the app makes is a download-only check for updates.
>
> Zerodha traders are already Vyuha's largest source of imports. Today they reach us two
> ways: by exporting the Console tradebook or P&L report and dropping it into the app (the
> Zerodha format is auto-detected — Vyuha requires the broker's own fingerprint before it
> will claim a file), or by connecting their own Kite Connect app, whose credentials Vyuha
> stores envelope-encrypted, DPAPI-wrapped on Windows. Both work; both make the trader do
> the plumbing.
>
> **The proposal.** A consent-based, read-only data path from Zerodha to Vyuha, in the
> spirit of the Account Aggregator framework: the trader approves once inside their Zerodha
> login, and Vyuha receives tradebook, realised P&L and the charge lines directly — on the
> trader's computer, not on any server of ours. Scope would be read-only (no orders, no
> funds), revocable by the trader in one click, and limited to what the Console exports
> already contain. If a partner arrangement on Kite Connect (a read-scope app that traders
> can authorise without registering as developers) is the practical route, we would take
> that gladly.
>
> **Why it is worth Zerodha's time.**
> - Vyuha computes statutory charges — STT/CTT, stamp duty, GST, exchange and SEBI charges —
>   from configurable rate tables rather than copying them, and lands within **0.69% of a
>   real broker report across 92 verified rows** (brokerage excluded, because it is not
>   derivable from the file). Traders reconcile against Zerodha's numbers; the integration
>   removes the copy-paste that makes them distrust both sides.
> - The core journal is free forever and never metered — no trade caps, no account caps.
>   Analytics are the paid part (₹9,999/yr or ₹29,999 once at launch pricing). Nothing in the
>   integration would be gated behind payment.
> - Zerodha's own reasoning about data staying with the customer matches ours exactly: the
>   data would move from Zerodha's systems to the customer's machine and nowhere else. We do
>   not want a copy.
> - The engineering is already there: `lib/import/api/kite.ts` normalises Kite trade data
>   into the same shape as file imports (weighted-average entry/exit, FIFO quantity, charge
>   lines), so a partner feed would reuse tested code, not new code.
>
> **What we would need from Zerodha.** A conversation about the right mechanism — AA-style
> consent, a Kite Connect read-scope partner app, or a signed Console export — and a
> sandbox account to test against. Vyuha would carry Zerodha's terms verbatim in the consent
> screen and publish exactly what fields are read.
>
> **About Vyuha (v2.99.99).** Six auto-detected broker formats (Zerodha, Dhan, Groww,
> Angel One, Upstox, Paytm Money) plus a column mapper for any CSV and direct API pulls
> from Kite, Dhan and Angel One SmartAPI (the last unattended, minting each day's login code
> from the enrolled TOTP secret); staged positions with per-tranche stops; an
> options-seller journal; a tax pack (ITR schedule export, AIS reconcile, advance tax); MTF
> margin lists for seven brokers (10,501 stocks); 1,932 unit tests across 132 files and 45
> Playwright flows in CI on every commit; an updater whose artifacts are cryptographically signed and verified on every install (the installer itself is deliberately NOT Authenticode-signed — no paid certificate; see CODE_SIGNING.md) and remote key
> revocation. Landing page: https://thejesh-k463.github.io/VYUHA-LOG/ · Source and
> release history: https://github.com/Thejesh-k463/VYUHA-LOG
>
> I would welcome twenty minutes with whoever owns Kite Connect partnerships or the Console
> data roadmap. Happy to demo on a call and to share the redacted reconciliation workbook
> behind the 0.69% figure.
>
> With regards,
> [[YOUR NAME]]
> Developer, Vyuha · [[EMAIL]] · [[PHONE]] · WhatsApp +91 73936 73714

---

## 2. X / Twitter — to @Nithin0dha and @nikhilkamathcio

Post publicly (a reply or a mention), then follow with a DM if they open DMs. Keep to one
image: `docs/screenshots/trades.png` or `dashboard.png` (synthetic data — never a real book).

**Tweet 1 (mention, ≤280 chars):**
> @Nithin0dha @nikhilkamathcio I built Vyuha — a local-first trade journal for Indian
> retail traders. No cloud, no account; the record stays on the trader's PC. Zerodha is
> already our biggest import. Proposal: a consent-based read-only feed from Zerodha, AA-style,
> so traders stop copy-pasting. https://thejesh-k463.github.io/VYUHA-LOG/

**Tweet 2 (thread reply):**
> Why it fits Zerodha's philosophy: statutory charges are computed from rate tables, not
> copied — within 0.69% of a real broker report across 92 rows. Core journal free forever,
> no caps. Data moves Zerodha → trader's machine and nowhere else. We don't want a copy.

**Tweet 3 (thread reply):**
> Ask: 20 minutes with whoever owns Kite Connect partnerships or the Console data roadmap.
> Read-only scope, revocable in one click, terms carried verbatim in the consent screen.
> Source + release history: https://github.com/Thejesh-k463/VYUHA-LOG

**DM version (if DMs are open, ~500 chars):**
> Hi — I'm [[YOUR NAME]], developer of Vyuha, a local-first Windows trade journal for Indian
> retail traders (no cloud, no server, no telemetry). Zerodha traders are our largest import
> source today, via Console exports or their own Kite Connect app. I'd like to propose a
> consent-based, read-only data path from Zerodha to Vyuha — AA-style or a Kite read-scope
> partner app — so the trader approves once and their tradebook, P&L and charges land on their
> own machine. Details + landing page: https://thejesh-k463.github.io/VYUHA-LOG/ — could you
> point me at the right person? Thank you.

---

## 3. What NOT to say

- No win-rate, accuracy, returns or "edge" claims — Vyuha is an analytical tool, not advice.
- Do not imply Zerodha endorsement, listing or partnership until it exists.
- Do not promise a delivery date for the integration; the mechanism is theirs to choose.
- Do not offer revenue share or referral terms in the first contact.
- macOS is not sold — say "Windows".

## 4. If they reply

Log the thread date and contact in this file; move the technical conversation to
`docs/BROKER_FORMATS.md` (Zerodha section) and, if a sandbox arrives, reconcile the first
feed against a contract note exactly as the Paytm rule requires (`VYUHA-STATE.md` §7).
