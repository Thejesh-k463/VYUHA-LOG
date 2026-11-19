# VYUHA → store hand-off, 10 Nov 2026

For the session **"Payment gateway home redesign"**, which is building the KTR Khata Book store in
`T:\Thejesh\CODEX\MY-PAYMENT GATEWAY`. The VYUHA session wrote this, and every fact below was checked
in the VYUHA repo on `main` (pricing committed as `08e34e0` and `43a8322`, not pushed; the final pictures
are on disk, not yet committed). Nothing in the store repo was changed.

## 1. What changed in VYUHA today: the app now matches the store

Owner rulings, 10 Nov 2026: annual is ₹9,999; then "Use store's figures" for the higher prices;
"No date" on them; and "Remove the promise" of an annual → lifetime upgrade credit.

| Item | Before | Now (app = store) | Where in VYUHA |
|---|---|---|---|
| Annual price | ₹7,999/yr | **₹9,999/yr** | `TRADE-JOURNAL/lib/domain/pricing.ts` (`PRICING`, id `annual`) |
| Annual struck-through price | ₹13,000 from 1 Jan 2027 | **₹14,999**, no date | same, `wasInr` |
| Annual badge | 38% off | **33% off** (1 − 9,999/14,999 = 33.34%, floored) | `offerPct()` |
| Lifetime struck-through price | ₹35,999 from 1 Jan 2027 | **₹75,000**, no date | `wasInr` |
| Lifetime badge | 16% off | **60% off** (1 − 29,999/75,000 = 60.001%, floored) | `offerPct()` |
| Monthly | ₹999 first month, then ₹1,499/month, 33% off | unchanged | |
| Annual → lifetime upgrade credit | promised on the annual plan, landing page, brochure | **not offered**; every promise removed | annual `includes`, sales pages |
| "Prices as of" date shown in-app | 2026-09-18 | **2026-11-10** | `PRICING_AS_OF` |

The store's open follow-up, "the VYUHA app's Rs 7,999 annual price is to be corrected in the VYUHA
project" (store `docs/main-store/DECISIONS.md`, 10 Nov, batch D), is **done in code**. It reaches
buyers only with the next VYUHA installer: installed copies of v4.7.0 still show ₹7,999, the old
struck-through prices and the upgrade promise.

## 2. Nothing left to reconcile

The app and the store now agree on every price, every higher price, the support days, and on
offering no upgrade credit. The store needs no change for this; keep `vyuhaPlans` as it is.
On sale screens, "save" amounts follow from the figures: annual saves ₹5,000, lifetime ₹45,001.

## 3. Prices the store shows (store ruling, unchanged; the app now agrees)

| Plan | Price | Higher (planned future) price | Support | Licence key |
|---|---|---|---|---|
| Monthly | ₹999 | ₹1,499 | 30 days | one-month key, issued on request |
| Annual | ₹9,999 / year | ₹14,999 | 90 days | `license-issue.mjs <email> app --years 1` |
| Lifetime | ₹29,999 once | ₹75,000 | 90 days | `license-issue.mjs <email> app --lifetime` |

Keys are email-bound and verified offline in the app; nothing phones home. `TRADE-JOURNAL/docs/owner/LICENSE_OPERATIONS.md`
and `docs/main-store/VYUHA-ISSUER.md` (store repo) cover issuing them.

Honesty rules the app enforces, worth copying:
- Any "% off" is DERIVED from the two prices and floored, never typed by hand (33.34% shows as 33%, never rounded up).
- An introductory price is never shown without its next-period price beside it.
- A higher price is a real price the owner intends to charge, never an invented strike-through.

## 4. Screenshots: use `store-aurora-flat` (re-shot 10 Nov from a better demo book)

Owner, 10 Nov: "Use now, better book later", then "aurora theme and FLAT background". The FINAL set is:

`T:\Thejesh\CLAUDE-CODE\VYUHA\TRADE-JOURNAL\public\help\store-aurora-flat\` (same 8 file names as before,
so any reference already pointing at them keeps working; just copy the new files over).

How they were made, so the store can state it honestly:
- VYUHA v4.7.0, dark theme, Aurora skin, **Flat** panel style, **Tint intensity 0** (plain dark canvas,
  no purple wash; Aurora pink/violet stays on buttons, the active menu item and charts).
- 1440×900 webp, quality 80, not resized: make the store's own sizes (for example the 840-wide covers).
- **Demo data only**, in a throwaway database; never the owner's journal. No email or licence key on
  any page (the capture script refuses to save a page that shows one).
- The "Pro trial — 7 days left" strip is hidden at capture time only (owner's choice); the app is unchanged.

The demo book (built for these pictures):
- 30 real NSE large caps (RELIANCE, TCS, SBIN, TITAN, ...); every entry and exit is a real NSE open or
  close between 3 Aug and 9 Nov 2026, imported through the app's own import screen as a Dhan file.
- A modest, MIXED record (sales pictures, not performance claims): 70 closed trades, 31 wins / 39 losses
  (44.3%), net **+₹3,298** on ₹17 lakh capital (+0.34%), profit factor 1.05, max drawdown ₹13.4k;
  Aug/Sep/Oct positive, Nov −₹7,827.
- Stops on 67 of 70 trades, targets, 4 playbooks with rules, setup grades, emotion and mistake tags,
  review stamps: so Arjun's Eye, Edge Clinic (incl. Discipline / Process Score) and R figures show content.
- 4 open positions valued at the real 9 Nov close (Live Desk rows marked, none past stop or target).
- Market Atlas computed from a real 252-session NSE end-of-day backfill (public NSE files), as of 9 Nov.
- The "Getting started" card is dismissed, as a user would.

Do NOT use `store-terminal\` any more: it is the earlier set from the old "Test Scrip" demo book
(a losing record, unmarked positions).

| File | Page |
|---|---|
| `dashboard.webp` | Dashboard |
| `trades.webp` | Trades |
| `performance.webp` | Performance |
| `edge-clinic.webp` | Edge Clinic |
| `sizing-lab.webp` | Sizing Lab |
| `live-desk.webp` | Live Desk |
| `arjuns-eye.webp` | Arjun's Eye |
| `market-atlas.webp` | Market Atlas |

Wording guard for captions: the numbers in the pictures are a DEMO book. Never present them as a
user's result, a return, or a performance claim; "sample data" is the honest caption.

## 5. How VYUHA should be described (owner words, store DECISIONS batch C)

An advanced trading journal for novice to pro: several analytics, including behaviour analytics,
and it suggests improvements rather than only pointing out mistakes; more releases are planned.

Facts from the app that are safe to state:
- the core journal (trades, imports, dashboard, playbooks, backups) is free forever and never locked;
- the paid part is the analytics;
- a 7-day full Pro trial on a fresh install;
- Windows x64 desktop, data on the user's own machine.

## 6. What the store session still owns

- Promise no annual → lifetime upgrade credit anywhere (owner, 10 Nov; the app no longer does).
- Copy the chosen screenshot set into `public/assets/vyuha-app`, size it, and update every reference.
- Keep the store's product version at `4.7.0` until a new VYUHA release is tagged; the owner publishes releases.
