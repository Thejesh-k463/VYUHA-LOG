# Vyuha — Monetization Plan (Trader's Toolkit)

**Model chosen:** one-time **Trader's Toolkit bundle** — the Vyuha desktop app (lifetime
license) + both TradingView indicators (invite-only). Indicators also sold standalone.
**Checkout:** Razorpay (UPI/cards) + your own landing page. **Delivery:** automated email
with license key + download link; indicator access granted via TradingView invite-only.

This document is the strategic spine. The other files in `docs/monetization/` and
`docs/prompts/` are the concrete deliverables it refers to.

---

## 1. Why this is sellable (the wedge)

Vyuha is not "a journal" — it's a **local-first, India-specific trading back-office**. Two
things competitors can't easily copy:

1. **Privacy / local-first** — trades never leave the user's machine (offline SQLite, no
   server). In India, where retail is wary of broker/data leaks, this is a headline, not a
   footnote. Lead every asset with it.
2. **Tax depth** — dual-regime capital gains + F&O business income + set-off/carry-forward +
   dividend TDS + advance-tax + harvesting. This is the recurring annual pain nothing on the
   retail market does well. Peaks **Jan–Jul** each year (advance-tax + filing season).

3. **Staged positions (v2.85)** — scale in across tranches with a stop on each, scale out in
   parts, per-leg R. Every competitor models a trade as one entry and one exit; professionals
   do not trade that way. This is the clearest "they actually trade" signal in the product and
   the easiest thing to demo in 30 seconds.

Supporting depth: F&O + Greeks, India VIX IV fallback, corporate actions, physical-settlement
traps, peak-margin leak, broker-cost comparison, SEBI reality-check, SEBI compliance radar,
five-broker import (incl. Angel One ≈15% of India's active accounts), clickable KPI drill-downs,
25-setup preset playbook library.

## 2. The offer & pricing (₹, India retail)

| SKU | What | Price (launch) | Price (list) | Tooling |
|---|---|---|---|---|
| **Trader's Toolkit** (hero) | App lifetime + both indicators (invite-only) | **₹4,999–7,999** | ₹9,999 | `license-issue.mjs <email> toolkit` |
| App only | Lifetime license | ₹1,499–2,999 | — | `license-issue.mjs <email> app` |
| Indicators only | Both, invite-only lifetime | ₹6,000–12,000 | — | TradingView invite-only |
| App annual — **✅ BUILT (v2.80)** | Recurring option; expiry is inside the signed key | ₹499–799/yr | — | `license-issue.mjs <email> app --years 1` |

Launch tactic: cap the launch price to the **first 100 buyers** ("founding traders"), collect
testimonials + Google reviews, then step to list price. Anchor the bundle against the sum of
standalone prices so it visibly saves money. Annual keys expire gracefully in-app (renewal
notice + grace trial → free) — safe to sell without support overhead.

## 3. Funnel

```
Free lead magnet ──▶ WhatsApp + email list ──▶ Content (X / YouTube) ──▶ Toolkit bundle
   │                                                                         │
   └─ "Tax-summary-only" free build, OR a free web capital-gains calculator  └─ Razorpay checkout
```

- **Lead magnet #1 — the installer itself (✅ BUILT, v2.80):** every fresh install starts a
  **14-day full-Pro trial** — offline, no signup, no card. The download link IS the funnel now:
  "try everything free for 14 days, journal stays free forever" converts better than any gated
  PDF. The in-app trial strip and post-trial upsell panel carry the buy link (`BUY_URL` in
  `lib/license.ts` — point it at the Razorpay page at launch).
- **Lead magnet #2:** a **free web capital-gains / F&O-tax calculator** (a stripped page of the
  tax engine) — ranks for search, shareable, demonstrates the exact depth people pay for. Gate
  the full report behind an email/WhatsApp opt-in.
- **Show, don't tell:** `docs/GETTING_STARTED_DECK.html` is a 13-slide visual walkthrough
  (install → import → journal → playbook loop → activate). Print it to PDF for WhatsApp
  broadcasts; the same slides double as a YouTube-short storyboard.
- **List:** WhatsApp (via a Business number / broadcast) converts far better than email in India.
- **Content:** see `GROWTH_ENGINE_PLAN.md` (compliant — no mass-mention spam).
- **Checkout:** Razorpay Payment Page or Payment Link → webhook → auto-deliver license + download.

## 4. Licensing layer — ✅ BUILT (v1.16+, tiering v2.80, vendor control v2.86)

The offline license gate exists, including the full tier machinery. Status:

### 4.0 Where the keys live

| What | Where | Ships to buyers? | If you lose it |
|---|---|---|---|
| **Vendor PRIVATE key** — mints every key | `license-private.pem` at the repo root, gitignored via `*.pem` | **Never** | You can't issue any more keys. **Back this up privately today.** |
| **Vendor PUBLIC key** — verifies keys | Baked into `lib/license.ts` (`LICENSE_PUBLIC_KEY_PEM`) | Yes, in every installer | Nothing — it's public by design |
| **The buyer's key** | The buyer's own machine, `settings.license_key` in their local SQLite | n/a | They re-paste it from your email |
| **Your sales ledger** | `license-ledger.jsonl` at the repo root, gitignored | **Never** | You lose the record of who bought what |

**Leaking the private key is the only catastrophic failure** — anyone holding it can mint
unlimited valid keys and you cannot tell their keys from yours. Rotating it (re-running
`license-keygen.mjs`) invalidates every key you have already sold, so treat it as permanent.
Back up `license-private.pem` **and** `license-ledger.jsonl` together, encrypted, off this machine.

### 4.1 Every key is already per-buyer

A key is not a shared unlock code. Each one is an Ed25519 signature over
`{ email, sku, issued, expires? }` — so the buyer's email is *inside* the key, cannot be edited
without breaking the signature, and is displayed in-app as "Licensed to <email>". Two buyers of
the same SKU on the same day get completely different keys.

1. **Key issuance (vendor side)** — one command per sale:
   `node scripts/license-issue.mjs <buyer-email> [toolkit|app|indicators] [--years 1 | --expires YYYY-MM-DD]`
   → prints the `VYUHA-…` key to stdout (pipe it straight into the delivery email) and appends a
   row to **`license-ledger.jsonl`**. No expiry flag = lifetime; `--years 1` mints the **annual
   SKU** (expiry is inside the signed payload). *(Future: a Razorpay `payment.captured` webhook
   that runs this script.)*
2. **Your sales ledger — ✅ BUILT (v2.86)**: `node scripts/license-list.mjs` shows every key you
   have issued — buyer, SKU, issue date, expiry, status. Filter by email, or run
   `--expiring 30` to find annual keys due for renewal (that list *is* your renewal campaign).
   Without this you have no record at all that a key exists: keys are **signed, not registered**,
   so nothing else in the system can answer "did this person actually buy?".
3. **Key IDs — ✅ BUILT (v2.86)**: every key has a short derived ID (`A1B2-C3D4-E5`,
   `sha256(key)` truncated). It shows in the buyer's **Settings → License** and in your ledger,
   so support threads quote the ID instead of pasting the key — which is a credential.
4. **Revocation — ✅ BUILT (v2.86)**: `node scripts/license-revoke.mjs <KEY-ID> "refunded"` adds
   the ID to `REVOKED_KEY_IDS` in `lib/license.ts`; that key then refuses to activate.
   **Read the limit honestly:** this is a *build-time* list in an offline app. A revoked key keeps
   working on machines already running an older build and only dies once the user installs a build
   released after the revocation. It stops a leaked key spreading to new installs; it is not a kill
   switch. Adding a real one means phoning home on launch — the one thing this product promises
   never to do.
2. **Offline validation in-app** — done. Signature verified against the public key baked into
   `lib/license.ts`; the stored key is re-verified on every read. Activation UI at
   **Settings → License**; shows "Licensed to <email>", expiry state, and trial countdown.
3. **Trial — ✅ BUILT (v2.80)**: every fresh install gets a **14-day full-Pro trial**, stamped
   offline on first open (`settings.trial_started_at`; the bundled template DB ships with it
   NULL so the clock starts at the user's first run, not the installer build). Expired annual
   keys fall back to any remaining trial days, then to free.
4. **Enforcement — ✅ BUILT (v2.80)**: every Pro screen sits behind `<ProGate>`
   (`components/system/pro-gate.tsx`), driven by the `PRO_FEATURES` registry in `lib/license.ts`
   (Portfolio Risk, Tax Summary, ITR Pack, Broker Costs). Currently **"banner" mode**: trial
   users see a countdown strip; unlicensed copies see an informational banner; nothing blocked.
   **To start charging: flip `LICENSE_ENFORCEMENT` to `"block"` in `lib/license.ts` and set
   `BUY_URL` to the live Razorpay/landing page** — the upsell panel then replaces Pro content
   after the trial. Product principle enforced in code: the core journal (trades, imports,
   dashboard, playbooks, backups) is NEVER gated — analytics are the product, the user's data
   is not. Anti-casual-sharing only, by design — the buyer email shown in-app is the real
   deterrent.
5. **Indicator access** — no build needed; TradingView invite-only handles access. See
   `PINE_SCRIPT_INVITE_ONLY.md`.

## 5. Legal / SEBI posture (read `PINE_SCRIPT_INVITE_ONLY.md` §Disclaimers too)

- Selling a **journal** (record-keeping tool) is clean.
- Selling **indicators that emit buy/sell signals** sits in SEBI's grey zone post the June-2024
  finfluencer crackdown / Research Analyst regulations. Stay on the safe side:
  - Position indicators as **educational/analytical tools, not advice.**
  - **No accuracy %, win-rate, or guaranteed-return claims** anywhere in marketing.
  - Prominent **"not investment advice / for educational purposes"** disclaimer on every asset
    (already embedded in the landing page and brochure).
  - If signals are the core pitch, get a **one-time opinion from a SEBI-aware professional.** This
    doc is not legal advice.

## 6. Deliverables index

| Ask | File |
|---|---|
| 1. Installation guide | `docs/INSTALLATION_GUIDE.md` |
| 2. Zerodha tradebook import prompt-doc | `docs/prompts/ZERODHA_TRADEBOOK_IMPORT.md` |
| 3. Hide Pine Script source (invite-only) | `docs/monetization/PINE_SCRIPT_INVITE_ONLY.md` |
| 4a. Sales landing page | `docs/monetization/landing-page.html` |
| 4b. One-page PDF brochure | `docs/monetization/brochure.html` (Print → Save as PDF) |
| 5. Compliant growth / content-bot plan | `docs/monetization/GROWTH_ENGINE_PLAN.md` |
| 6. **Getting-started slide deck (v2.80)** — install → import → journal → playbook loop → activate; visual-first, printable to PDF, doubles as demo-video storyboard | `docs/GETTING_STARTED_DECK.html` |
| 7. Public repo landing page with current screenshots | `README.md` |
| 8. **Vendor licence tooling (v2.86)** — issue / list / revoke | `scripts/license-{issue,list,revoke}.mjs` |
| 9. **Licence operations runbook (v2.86)** — sale → delivery → refund → renewal | `docs/monetization/LICENSE_OPERATIONS.md` |

## 7. Suggested launch sequence (2–4 weeks)

Everything technical is now BUILT — the sequence is pure go-to-market:

1. **Week 1** — publish the 2 indicators invite-only; stand up the Razorpay Payment Page;
   put up the landing page. **The only code changes left for launch day are two constants in
   `lib/license.ts`: `BUY_URL` → the Razorpay/landing page, and `LICENSE_ENFORCEMENT` →
   `"block"`.** (Do NOT flip enforcement before the payment page is live — trial-expired users
   would hit a dead buy link.)
2. **Week 2** — publish a GitHub release so the auto-updater ships the gated build; announce
   the 14-day-trial framing everywhere ("try everything free, journal free forever").
3. **Week 3–4** — content engine on your own X/YouTube (record the getting-started deck as a
   2-minute walkthrough); founding-trader launch (first 100 @ launch price); collect
   testimonials; iterate copy from checkout drop-off. Consider the annual SKU
   (`--years 1`) as the downsell on exit-intent.
4. **Ongoing** — run `node scripts/license-list.mjs --expiring 30` monthly; that output is your
   renewal outreach list. Back up `license-private.pem` + `license-ledger.jsonl` after every
   batch of sales. Full procedures in `LICENSE_OPERATIONS.md`.

### What changed since this plan was last revised (v2.82 → v2.85)

Demo-able additions worth putting in the sales assets, newest first:

- **v2.85 — Staged positions.** Scale in / scale out with a stop per tranche and per-leg R.
  The single best 30-second demo in the product; nothing else on the market does it.
- **v2.84 — Clickable KPI drill-downs** (16 cards) and a **browsable 25-setup playbook library**.
  Both are "wow" moments in a screen-share and cost nothing to show.
- **v2.82 — Angel One + Upstox import** (Angel One alone is ≈15% of India's active accounts —
  this widened the addressable market more than any other single change), **SEBI Compliance
  Radar**, and **shareable stat cards** (privacy-first: % of capital by default, watermarked
  "self-reported, not broker-verified").

None of these are gated today. Before flipping `LICENSE_ENFORCEMENT` to `"block"`, decide
deliberately whether staged positions belong in the free core or in Pro — see the note in
`LICENSE_OPERATIONS.md` §5.
