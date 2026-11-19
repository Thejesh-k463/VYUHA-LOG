# VYUHA product page for the store: design plan (19 Nov 2026)

For the "Payment gateway home redesign" session (`T:\Thejesh\CODEX\MY-PAYMENT GATEWAY`, `apps/main-store`).
Planned on Fable in the VYUHA session; to be BUILT by an Opus 5.5 senior web designer in the store session.
Owner brief, 19 Nov: one web page for VYUHA, futuristic, with motion design, graphics and 3D animation;
NOT the Luxe, Sapphire or Lime looks or anything near them; base it on Aurora Flat with a little Terminal,
with custom colours, so the feature pictures make the page visually stunning.

This file is a plan, not a spec of the store's code. Before building, the designer reads the store's own
route for `/products/vyuha`, its `app/products/vyuha.ts` and its DECISIONS, and keeps every price, plan
name and legal line exactly as the store already states them. Nothing here changes a price.

## 1. The one idea

"Your trading, read like an instrument panel." The page is a dark flight deck that the visitor flies
through: one continuous 3D scene in the background (a formation of points that re-forms per section; "vyuha"
means formation), with the real product screens floating in front of it as lit glass panels. Motion always
explains something (a number counting to its value, a chart drawing itself, a panel tilting toward the
cursor); nothing moves only to decorate.

## 2. Palette: "Aurora Deck" (custom; proposals, tune against the screenshots)

Read the real Aurora and Terminal tokens in VYUHA's `app/globals.css` first and stay in their family.
Roles, with starting values:

| Role | Start value | Use | Never |
|---|---|---|---|
| Canvas | `#090B12` | page background, flat, no wash | gradients across the whole page |
| Panel | `#10131C` with a 1 px `#1E2333` border | cards, screenshot frames | drop shadows as decoration |
| Aurora accent | `#E24BD6` (fuchsia) to `#8B5CF6` (violet) | ONE primary button, active nav, the hero line, 3D highlights | body text, large fills |
| Terminal teal | `#35D0BA` | analytics marks, "live" dots, secondary links, code-like labels | buttons |
| Money gold | `#E8B84A` | rupee figures only | anything that is not money |
| Profit / loss | the app's own green and red, unchanged | figures inside screenshots and demo counters | brand elements |
| Text | `#E7E9F2` / muted `#8B91A7` | copy | pure white |

Rules: painted accent area stays under about 8% of any viewport (the owner's standing palette rule: add hues
by colour theory, cut painted area, a button never sits on its own hue). Fuchsia and teal are near
split-complements, gold is the single warm note. No sapphire blue, no lime, no champagne/"luxe" gold wash.
Type: one geometric sans for headings, the app's mono face for figures and small labels (tabular numbers).

## 3. Sections, in scroll order

1. **Hero.** Left: the claim in one line, one sentence under it, the primary button (to the plans) and a
   quiet secondary link ("See it work", scrolls). Right: the dashboard screenshot as a glass panel tilted
   about 8 degrees in 3D, lit by the accent, parallax on pointer move. Behind: the point formation, slowly
   rotating. A thin mono strip under the fold line: Windows and macOS (one licence), local database, 8 brokers imported.
2. **"What it reads" strip.** Four counters that count up once when seen (figures come from the product's
   own facts in the store data, never invented).
3. **Feature flight (the core).** A pinned, scroll-driven sequence: the formation re-forms and one screen
   comes forward per step, with a three-line caption and one mono figure. Steps, each using one image:
   Dashboard, Trades, Live Desk, Sizing Lab, Arjun's Eye, Edge Clinic, Market Atlas, Performance.
   On each step a single element of the screenshot is highlighted by an animated outline (for example the
   evidence grade on Edge Clinic), so the eye knows where to look.
4. **Honesty block.** Three plain cards: your data stays on your computer; charges and tax worked from
   real rate tables; evidence grades instead of promises. Terminal styling here (mono labels, teal rules),
   which is the "little bit of Terminal".
5. **Brokers.** The eight supported import sources as a quiet logo-free text grid (names only unless the
   store holds the right to a logo), with a line for "any other broker: the column mapper asks".
6. **Plans.** The store's existing plan component and prices, restyled to the palette. No date, no upgrade
   credit, and the struck-through figures called planned future prices, exactly as the store records.
7. **Questions + footer.** The store's own FAQ, refund and terms links.

## 4. Pictures

Use ONLY `T:\Thejesh\CLAUDE-CODE\VYUHA\TRADE-JOURNAL\public\help\store-aurora-flat\` (eight 1440x900 webp:
`dashboard`, `trades`, `live-desk`, `sizing-lab`, `arjuns-eye`, `edge-clinic`, `market-atlas`,
`performance`). `store-terminal\` is retired. They are a DEMO book: caption them "sample data"; never a
user's result, a return or a performance claim (hand-off: `docs/owner/STORE-HANDOFF-2026-11-10.md`).
Make the store's own sizes from these (a 2x and a 1x per slot, AVIF or WebP), never upscale. Frame each
in the Panel style with a 12 px radius and a 1 px border; no fake browser chrome, no device mock-ups.

## 5. Motion and 3D

- **One WebGL canvas** for the whole page (three.js through the store's React stack, or OGL if weight
  matters): about 2,000 to 4,000 instanced points with a soft accent glow, five or six target formations
  (grid, ring, wave, candles, constellation), morphing with scroll progress. No stock 3D models.
- **Scroll choreography** with one timeline library (GSAP ScrollTrigger or Motion's scroll API; pick the
  one already in the store, add at most one). Pin only section 3.
- **Screens as glass:** CSS 3D transforms on real `<img>` elements, not textures, so they stay sharp and
  selectable for assistive tech; a light sweep on entry, 200 to 400 ms eases, no bounce.
- **Micro:** counters, chart-line draw-ins as SVG stroke animation, the primary button's accent border
  travelling once on hover.
- **Budgets (hard):** largest contentful paint under 2.5 s on a mid laptop; the canvas loads AFTER first
  paint and is skipped on `prefers-reduced-motion`, on save-data, and on phones under about 6 GB of
  memory, where a static formation image stands in; total added JavaScript under about 180 KB gzipped;
  60 frames per second on integrated graphics, with the point count halved if a frame budget is missed
  twice; the canvas pauses when the tab is hidden or the section is off screen.
- **Accessibility:** every screenshot has real alt text; all copy is HTML, never in the canvas; contrast
  4.5:1 for text; keyboard order follows the scroll order; the pinned section is skippable.

## 6. Build order for the store session

1. Read the store's route, product data and DECISIONS; list what the page must keep (prices, plan
   names, legal copy, checkout wiring). Show the owner TWO hero frames in chat (dark, same layout,
   palette variants) and let him pick BEFORE building (his standing rule: previews in chat first).
2. Static page first: sections 1 to 7 with the pictures, the palette and no motion. Check it at 1440,
   1024 and 390 wide.
3. Add scroll choreography, then the canvas, then micro-motion. Measure after each layer against the
   budgets in section 5 and keep the numbers.
4. Verify in a real browser: reduced-motion path, keyboard path, a throttled laptop profile, and that
   checkout still starts from every plan button.

## 7. What this plan does not decide

The headline and all copy (the store session drafts, the owner approves), whether broker logos may be
shown, and the GAMMA page (out of scope here; the same scene and palette roles can be re-coloured for it).

## 8. Addendum, 20 Nov 2026: what changed after this plan (the store session reads this FIRST)

Written by the VYUHA session after v4.8.0 was tagged; the BUILD still belongs to the store session (the store repo is
another session's — this file is the hand-over). Facts below are checked against VYUHA's tree at tag `v4.8.0` (`5b5bfb2`).

1. **macOS is sold** (owner, 19 Nov: "Sold openly now", "Same licence + price"). Every place the page names a platform says
   **Windows 10/11 (64-bit) and macOS 11 or later (Apple silicon and Intel), one licence, one price** — not "macOS 10.15":
   the app bundles Node 22, which supports macOS 11+ only. The hero's mono strip (§3.1) becomes:
   `Windows + macOS · one licence · data on your computer · 8 brokers imported`.
2. **Three downloads, one per computer** (owner: "share mac package separately so that users will have clarity to download
   which one"). After purchase, and on any download link, the page offers exactly one of:
   `Vyuha_<ver>_Windows-x64_Client_Package.zip`, `Vyuha_<ver>_macOS-Apple-Silicon_Client_Package.zip`,
   `Vyuha_<ver>_macOS-Intel_Client_Package.zip` (names from VYUHA `scripts/lib/client-package.mjs`). Add a small
   **"Which one is mine?"** helper: Windows PC → Windows; Mac → Apple menu → About This Mac → "Chip: Apple M…" = Apple
   silicon, "Processor: Intel" = Intel. Where the browser exposes it, pre-select the likely one (`navigator.userAgentData`
   platform; Apple silicon cannot be told from Intel reliably in a browser — always show the helper, never guess silently).
3. **FAQ additions (store's own FAQ, §3.7), honest first-open lines**, copied from VYUHA's landing page:
   Windows — the installer is not code-signed yet; SmartScreen → More info → Run anyway.
   Mac — not notarised by Apple; the first open says macOS cannot verify the developer → System Settings → Privacy &
   Security → **Open Anyway** (macOS 14 and earlier: Control-click → Open). Owner-confirmed by his Mac users. Never say
   "notarised" or "signed by Apple".
4. **Brokers (§3.5):** the eight import sources by name — Angel One, Dhan, Fyers, Groww, Nuvama, Paytm Money, Upstox,
   Zerodha (VYUHA `lib/import/registry-meta.ts`) — plus "any other broker: the column mapper asks". Fyers and Nuvama
   EQUITY rows and the Fyers / Kotak Neo / Nuvama API pulls are not yet verified against a real account: do not list
   API pulls as a feature without that qualifier (VYUHA's landing says "not yet verified").
5. **New in v4.8.0, usable as a ninth feature-flight step or a caption (§3.3):** the Edge Clinic **decay card** ("For every
   ₹1,000 risked: ₹548 → ₹370" style — figures from the DEMO book only); the Live Desk Positions tab showing the largest
   150 with Show more; one contract written two ways by one broker's two sources closes as one. **No speed or percentage
   claims** (owner rule — the release carries none). No new screenshot exists for the decay card yet; the store session
   asks the VYUHA session for one (demo data, 1440×900, aurora-flat) rather than cropping a help shot.
6. **Prices unchanged** (VYUHA `lib/domain/pricing.ts` = the store: ₹999 monthly, ₹9,999 annual, ₹29,999 lifetime; the
   struck-through figures are planned future prices with no date; no upgrade credit).
