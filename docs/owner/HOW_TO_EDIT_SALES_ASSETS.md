# How to Edit the Sales Assets (Landing Page + Brochure)

`docs/sales/landing-page.html` and `docs/sales/brochure.html` are plain HTML files — no build
tooling needed to edit them, no `[[TOKEN]]` placeholders left to fill (those were retired with the
old bundle pricing). Prices, competitor cells and the "why it wins" numbers are **pinned by tests**,
so the safe way to change a number is to change it at its source and let the tests tell you what
else to touch.

> **Golden rule:** the app, the landing page and the brochure must quote the same numbers.
> `tests/pricing.test.ts` fails if they drift.

---

## 1. Where the facts come from

| What | Source of truth | Pinned by |
|---|---|---|
| SKU prices and anchors (₹9,999 / ₹13,000 · ₹29,999 / ₹35,999) | `lib/domain/pricing.ts` (`PRICING`) | `tests/pricing.test.ts` — every amount must appear inside a `<div class="amt">` on the landing page |
| The annual → lifetime upgrade sentence | `lib/domain/pricing.ts` (annual `includes`) | same test — must appear **verbatim** on the landing page, brochure and standalone |
| Competitor table, "Features vs cost" summary, hero "why it wins" strip | `lib/domain/pricing-comparison.ts` (`COMPETITORS`, `VYUHA_ROW`, `WHY_VYUHA`, `COMPARISON_AS_OF`) | owner review — re-read the module when you edit any of those cells |
| Feature copy (imports, skins, screens) | `docs/client/README.md` for the current release | `tests/no-indicators-in-client-docs.test.ts` forbids "indicator / TradingView / Pine" wording anywhere on the page |
| WhatsApp number / email | the comment block at the top of `landing-page.html` | — |

Rules that apply to every sentence: no returns, accuracy or win-rate promises (SEBI posture — it
is an analytical tool, not advice); Windows only (never advertise macOS on a selling surface);
"Not stated" in a competitor cell means exactly that.

## 2. Page map (landing-page.html)

In order: nav → hero (version pill, trust chips, "why it wins" strip, dashboard shot) → `#workflow`
(6 cards) → `#gallery` (10 screenshots) → `#why` (6 cards) → `#staged` (split) → `#tax` (split) →
`#skins` ("Make it yours", 7 thumbnails) → `#pricing` (2 plan cards → "Features vs cost" summary →
full comparison table) → "How you get it" (4 steps) → `#faq` → final CTA → footer (creators &
reviewers line, disclaimer).

### Screenshots used, and where

All live in `docs/screenshots/` (1440×900, synthetic data). Regenerate the whole set with
`node scripts/retake-screenshots.mjs` after a UI change; the page references them by relative
path, so a retake needs no HTML edit unless a file is renamed.

| Section | File(s) |
|---|---|
| Hero | `dashboard.png` |
| `#gallery` (in order) | `trades.png`, `staged-position.png`, `options-journal.png`, `risk.png`, `tax-pack.png`, `arjuns-eye.png`, `lenses.png`, `kpi-drilldown.png`, `edge-report.png`, `rom-report.png` |
| `#staged` | `staged-position.png` |
| `#tax` | `calculator.png` |
| `#skins` | `skin-lime.png`, `skin-rose.png`, `skin-ember.png`, `skin-sapphire.png`, `skin-aurora.png`, then `settings-appearance.png`, `custom-theme.png` |

19 distinct files; 20 `<img>` tags (`staged-position.png` appears twice). Gallery and skin figures open in a built-in click-to-enlarge
overlay (plain JS at the bottom of the file — no library). To add a screenshot, copy an existing
`<figure>` and keep the caption to one line naming the feature. Mind the standalone size (§4).

## 3. Editing checklist

- Change a price → edit `lib/domain/pricing.ts`, then the two `<div class="amt">` cells and the
  matching WhatsApp `?text=` links, then run the tests.
- Change a competitor cell → edit `lib/domain/pricing-comparison.ts` first, then the full table
  **and** the "Features vs cost" summary above it (its ranges — ≈ ₹12,600–31,600/yr global,
  ₹999–2,499/yr Indian, "≈ ₹47,000–95,000 over three years" — are derived from that module).
- Bump the version pill in the hero on every release.
- Never write the word "indicator(s)", "TradingView" or "Pine Script" in the page body — the
  invite-only indicators are not part of what is sold and the test fails on the bare word.
- Search for `macOS` / `Mac` before publishing — there must be none.

## 4. Build the emailable single file

```
npm run landing:build        # → docs/sales/landing-page.standalone.html
```

This inlines every screenshot as a data: URI. **The public page is https://thejesh-k463.github.io/VYUHA-LOG/ (GitHub Pages, source `main:/docs`, `docs/index.html` redirects to `sales/landing-page.html`); the standalone is the fallback you email when a link is not wanted** — it opens offline with no broken images. It is gitignored and
must be regenerated after every edit; `tests/pricing.test.ts` checks it (when present) for the
current prices, the upgrade sentence and the "download-only" network answer, so a stale twin
fails the suite instead of rotting silently again.

Size: at v2.99.97 it is ≈ 5.9 MB with 20 inlined images. Keep it under ~8 MB (mail attachment
comfort) — if you add screenshots and cross that, drop gallery figures rather than shrinking the
hero shot.

## 5. Brochure (`brochure.html`) → PDF

1. Open `brochure.html` in Chrome or Edge.
2. Ctrl + P → Destination **Save as PDF** · Paper **A4** · Margins **None** · **Background graphics ON**.
3. Save. Single-page A4, ready for WhatsApp / DMs / print.

The on-screen "sheet on a dark desk" backdrop is removed automatically in the PDF. The QR box
(`<div class="qr">`) takes an `<img>` pointing at a QR PNG placed next to the file once there is a
public URL to point it at.

## 6. Publish

**Already hosted (2026-08-15):** GitHub Pages serves the `main` branch's `/docs` folder, so
`https://thejesh-k463.github.io/VYUHA-LOG/` → `docs/index.html` (meta-refresh) →
`sales/landing-page.html`, with `../screenshots/` resolving naturally. Every push to `main`
redeploys within ~1 minute; check `gh api repos/Thejesh-k463/VYUHA-LOG/pages/builds/latest --jq .status`.
The page is a redirect, not a copy, so `tests/pricing.test.ts` keeps pinning the one source file.
Swap the footer/mailto address for a dedicated sales inbox before driving public traffic.

## 7. Verify before sending anything

```
npm run landing:build
npx vitest run tests/pricing.test.ts tests/no-indicators-in-client-docs.test.ts
```

Both must be green. Then open the standalone in a browser once and click a gallery tile — the
overlay should show the enlarged screenshot; Esc or a click closes it.

## 8. Common gotchas

- **A price test fails after a reprice** → the amount is missing from a `<div class="amt">` cell,
  or the standalone was not rebuilt.
- **Images don't show in the source HTML** → the file must be opened from `docs/sales/` so
  `../screenshots/` resolves; the standalone has no such dependency.
- **Colours/gradients missing in the brochure PDF** → turn ON "Background graphics".
