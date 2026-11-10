# VYUHA → store hand-off, 10 Nov 2026

For the session **"Payment gateway home redesign"**, which is building the KTR Khata Book store in
`T:\Thejesh\CODEX\MY-PAYMENT GATEWAY`. The VYUHA session wrote this, and every fact below was checked
in the VYUHA repo on `main` (the price tests pass; the change is being committed, not pushed). Nothing in the store repo was changed.

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

## 4. New screenshots (replace the six teal files in `public/assets/vyuha-app`)

Owner batch A item 5: "either use Terminal or aurora flat". Both sets now exist, in VYUHA v4.7.0 with
demo data only. They were shot from a throwaway database seeded from `tests/fixtures/dhan-gtr.csv`, the
dark theme was forced, and no email or licence key appears in them (the capture script refused to save
any page showing one). Each file is a 1440×900 webp at quality 80.

Folders:
- `T:\Thejesh\CLAUDE-CODE\VYUHA\TRADE-JOURNAL\public\help\store-terminal\`: the "Terminal" skin (id `mono`), default panel style
- `T:\Thejesh\CLAUDE-CODE\VYUHA\TRADE-JOURNAL\public\help\store-aurora-flat\`: the Aurora skin with the Flat panel style

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

Limits of the demo data, so the page design does not lean on them:
- The demo book loses money: net P&L shows −₹39,701 and the win rate is 36%.
- Symbols read "Test Scrip 56" and similar.
- The Live Desk rows say "No mark stored for this position yet".
- The dashboard shows a "Getting started 3 of 5" card.

Crop around these, or ask the VYUHA session for a richer demo book; do NOT shoot the owner's real
journal. The images are not resized: make the store's own sizes (for example the 840-wide covers)
from these files.

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
