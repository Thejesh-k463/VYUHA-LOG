# Selling Your 2 Pine Script Indicators (Invite-Only, Source Hidden)

**Goal:** monetize two TradingView indicators while keeping the Pine source **hidden** and
controlling **who** can use them. You confirmed you have a **paid TradingView plan** — invite-only
publishing is available to you.

TradingView gives you exactly one built-in mechanism for "hide source + sell access":
**Invite-only scripts.** The code is compiled and hidden; only users you grant get access.

---

## How the three publish modes compare

| Mode | Source visible? | Who can use it | Sellable? |
|---|---|---|---|
| Open-source | Yes (full code) | Everyone | No |
| **Protected** | **No** | Everyone (free) | No (free to all) |
| **Invite-only** | **No** | **Only people you approve** | **Yes — this is the one** |

Use **Invite-only** for both indicators.

## Step-by-step: publish an indicator as invite-only

Do this for **each** of your two indicators.

1. Open the indicator in the **Pine Editor** on TradingView.
2. Make sure it **compiles cleanly** and the first line declares a clear title, e.g.
   `indicator("Vyuha Momentum Pro", overlay=true)`. This title is what buyers see.
3. Click **Publish script** (top-right of the Pine Editor).
4. In the publish dialog:
   - Write a **title**, a **description** (what it does, how to read it, on which timeframes/markets),
     and add a **chart snapshot** that looks clean and professional.
   - Under **visibility / access**, choose **Invite-only**.
   - Add **tags** and a **category** so it's discoverable.
   - ⚠️ **Do not** paste the source or reveal the logic in the description — invite-only hides the
     code automatically, but don't undermine it by explaining the exact formula.
5. **Publish.** The script now lives on your TradingView profile as invite-only. Nobody can see the
   code, and nobody can add it to their chart until **you grant** them access.

## Step-by-step: grant / revoke access after a sale

1. Go to the published script's page → **Manage access** (pencil / "Add/remove access").
2. Enter the buyer's **TradingView username** → **Add**. They get access within a minute.
3. To handle a refund / expiry, come back and **Remove** the username.

> For a **lifetime** SKU, grant once and leave it. For a **rental/subscription** SKU, you (or a
> tool — see below) grant on payment and revoke when the term lapses.

## Connecting it to your Razorpay checkout (fulfilment)

TradingView access is granted by **TradingView username**, not email — so your checkout must
**collect the buyer's TradingView username**.

**Manual (launch with this — zero build):**
1. Razorpay Payment Page for "Indicators bundle" with a **custom field: TradingView username**.
2. On payment, Razorpay emails you the order + username.
3. You **Add** the username on both scripts' Manage-access pages. Send a "you're in" email.
   → Fine up to a few dozen sales/week.

**Semi-automated (scale later):**
- Razorpay **webhook** (`payment.captured`) → your small server/Apps Script records buyer + TV
  username in a sheet and emails you a one-click checklist.
- TradingView has **no official public API** for granting invite-only access. Full automation means
  either (a) an unofficial/CI browser-automation script against your own account (fragile, against
  TV ToS if abused — do so at your own risk and only for your own scripts), or (b) keep the grant
  manual and only automate the *record-keeping + reminders*. **Recommended: keep the grant manual,
  automate everything around it.** The grant itself takes 15 seconds.

## Protecting the logic beyond invite-only

Invite-only already hides the source. To make the *logic* harder to reverse-engineer from behaviour:
- Don't publish the exact formula, lengths, or thresholds in the description.
- If you expose inputs, keep the truly proprietary constants **non-editable** (hard-coded), exposing
  only cosmetic inputs.
- Consider a light **server-gated** variant only if you later go pro: compute nothing secret client
  side. (Overkill for launch — skip.)

## Packaging the two indicators for the bundle

- Give them a **family name** that matches the app ("Vyuha …") so the Toolkit feels cohesive.
- One TradingView **profile** hosts both; link that profile from the landing page.
- Sell **both together** inside the Toolkit, and also offer an **"Indicators only"** SKU (see
  `MONETIZATION_PLAN.md` pricing) as a cheaper entry point that upsells to the app.

## Mandatory disclaimers (put on the script description AND the landing page)

> *For educational and informational purposes only. Not investment advice and not a
> buy/sell recommendation. Past performance does not guarantee future results. Trading in
> securities/derivatives carries risk of loss. Not a SEBI-registered research analyst service.*

Avoid **any** accuracy %, win-rate, or "guaranteed"/"assured returns" language — that is exactly
what invites SEBI scrutiny (see `MONETIZATION_PLAN.md` §5).

## Quick checklist

- [ ] Both indicators compile cleanly with clear titles.
- [ ] Both published **invite-only** (source hidden), with clean chart snapshots + descriptions.
- [ ] Razorpay page collects **TradingView username** (custom field).
- [ ] Fulfilment SOP written: on payment → add username to both scripts → send welcome email.
- [ ] Refund/expiry SOP: remove username.
- [ ] Disclaimers on both script descriptions and the landing page.
