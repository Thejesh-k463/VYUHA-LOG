# How to Edit the Sales Assets (Landing Page + Brochure)

Both `landing-page.html` and `brochure.html` are plain HTML files with **`[[TOKEN]]`**
placeholders. You fill them in with a text editor — no coding needed. This guide lists every token,
what to put, and where it shows up, plus how to add images and export.

> **Golden rule:** use the **same values in both files** so your landing page and brochure match.

---

## 1. How to edit (2 minutes)

1. Open the file in any text editor (VS Code, Notepad++, even Notepad).
2. Use **Find & Replace** (Ctrl+H) for each token below — replace **all occurrences**.
3. Save. Double-click the file to preview in your browser.
4. Repeat for the second file.

> Tip: replace the token **including** the brackets. Search `[[PRICE_APP]]`, not `PRICE_APP`.

## 2. Token map — fill every one of these

| Token | Put this | Example | Landing | Brochure |
|---|---|---|---|---|
| `[[IND1]]` | Indicator #1 name | `Vyuha Momentum Pro` | ✅ | ✅ |
| `[[IND2]]` | Indicator #2 name | `Vyuha Trend Radar` | ✅ | ✅ |
| `[[PRICE_BUNDLE]]` | Toolkit launch price (number only, with commas) | `4,999` | ✅ | ✅ |
| `[[PRICE_LIST]]` | Struck-through "was" price (higher) | `9,999` | ✅ | ✅ |
| `[[PRICE_APP]]` | Journal-only price | `2,499` | ✅ | ✅ |
| `[[PRICE_IND]]` | Indicators-only price | `4,999` | ✅ | ✅ |
| `[[WHATSAPP]]` | Support link or number | `wa.me/9198XXXXXXXX` | ✅ | ✅ |
| `[[RZP_LINK]]` | Razorpay page for **bundle + app** | `razorpay.me/@vyuha` | ✅ | — |
| `[[RZP_INDICATORS]]` | Razorpay page for **indicators only** | `razorpay.me/@vyuha-ind` | ✅ | — |
| `[[TV_PROFILE]]` | Your TradingView profile URL | `tradingview.com/u/yourname` | ✅ | — |
| `[[LANDING_URL]]` | Your live landing-page URL (shown on the brochure CTA) | `vyuha.in` | — | ✅ |

> **Don't type `₹` inside price tokens** — the `₹` is already in the template right before each
> token. Just put the number (e.g. `4,999`). Keep prices short (a number, not a sentence) so the
> layout stays tight.

## 3. Text placeholders (not tokens) — replace these too

These are in **square brackets without the double-bracket** — search for them and replace:

| Placeholder | Where | Replace with |
|---|---|---|
| `[one-line]` (appears twice) | Indicators section, next to `[[IND1]]`/`[[IND2]]` | A short description of each indicator, e.g. *"spots momentum shifts on any timeframe"* |
| `[ QR to landing / Razorpay ]` | Brochure, bottom-left box | A QR image — see §4 |

## 4. Adding images (QR code + optional screenshots)

### QR code (brochure)
1. Generate a free QR for your `[[LANDING_URL]]` or Razorpay link (e.g. qr-code-generator.com).
2. Save the PNG next to the HTML file, e.g. `qr.png`.
3. In `brochure.html`, find the QR box:
   ```html
   <div class="qr">[ QR to landing / Razorpay ]</div>
   ```
   Replace the inner text with an image:
   ```html
   <div class="qr"><img src="qr.png" alt="Scan to buy" style="width:100%;height:100%;object-fit:contain;border-radius:6px"></div>
   ```

### Real app screenshot (optional, both files)
The hero shows a **stylised** dashboard (fake numbers `+₹2.4L / 58% / ₹22k` + a drawn equity
curve). It looks clean as-is. To use a **real** screenshot instead, replace the whole
`<div class="preview">…</div>` block with:
```html
<div class="preview" style="padding:0"><img src="dashboard.png" alt="Vyuha dashboard" style="width:100%;display:block;border-radius:14px"></div>
```
(Put `dashboard.png` next to the file.) Same idea for the indicators section if you want a real
chart instead of the drawn payoff diagram.

## 5. Pricing tips

- `[[PRICE_LIST]]` should be **higher** than `[[PRICE_BUNDLE]]` — it's the crossed-out "anchor" price.
- Keep the three prices sensible relative to each other (bundle ≈ app + a discount on indicators).
- See `MONETIZATION_PLAN.md §2` for suggested ₹ ranges.

## 6. Consistency checklist (do this before publishing)

- [ ] `[[IND1]]` and `[[IND2]]` are identical in both files.
- [ ] All four prices match in both files.
- [ ] `[[WHATSAPP]]` matches in both files.
- [ ] Landing links (`[[RZP_LINK]]`, `[[RZP_INDICATORS]]`, `[[TV_PROFILE]]`) are real, clickable URLs.
- [ ] Brochure `[[LANDING_URL]]` points to where the landing page is actually hosted.
- [ ] Both `[one-line]` descriptions written.
- [ ] QR image added to the brochure.
- [ ] No `[[` or `[one-line]` left anywhere — search each file for `[[` and `[one` to confirm.

## 7. Publish / export

### Landing page (`landing-page.html`)
Host it anywhere that serves a static file:
- **Fastest:** Netlify Drop (drag the file onto app.netlify.com/drop), Cloudflare Pages, or GitHub Pages.
- Point your domain (e.g. `vyuha.in`) at it.
- If you added images (`qr.png`, `dashboard.png`), upload them **alongside** the HTML.

### Brochure (`brochure.html`) → PDF
1. Open `brochure.html` in **Chrome or Edge**.
2. **Ctrl + P**.
3. Destination: **Save as PDF** · Paper size: **A4** · Margins: **None** · **Background graphics: ON**.
4. Save. You get a single-page A4 PDF ready for WhatsApp / DMs / print.

> The on-screen version shows the page as a centered "sheet" on a dark desk — that backdrop is
> automatically removed in the PDF, so the exported file is a clean edge-to-edge A4.

## 8. Common gotchas

- **A price looks cut off / wraps oddly** → your price text is too long. Use a short number like
  `4,999`, not a phrase.
- **Colours/gradients missing in the PDF** → turn ON "Background graphics" in the print dialog.
- **Images don't show** → the image file must sit in the **same folder** as the HTML, and the
  `src="…"` name must match exactly (case-sensitive on some hosts).
- **A `[[TOKEN]]` still shows on the live page** → you missed one; search the file for `[[`.
