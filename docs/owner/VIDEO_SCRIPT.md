# Demo video — script, shot list and rules

> **Superseded 2026-08-23 by `docs/owner/demo-video/`** — the executable kit: narration per shot, a shot list pinned to `nav-config.ts` by test, an importable OBS profile, a setup script, an end card and publish copy scanned for outcome claims. The claim rules below are unchanged and still binding; the shot order and tool guidance are replaced.

Owner-only. Written 2026-08-21 against **v2.99.100**. Not client-facing.

Plan: **record the long walkthrough once**, then cut the 90-second version from
the same footage. One recording session, consistent visuals, two deliverables.

---

## 0. Before you press record

```bash
npm run demo
```

Serves the app on <http://localhost:3214> against a **throwaway database** in
your temp folder, seeded from the committed test fixtures through the real
import pipeline. Your live journal is never opened — verified: after a full
demo run, `data/vyuha.sqlite` had an unchanged modification time.

`npm run demo -- --fresh` rebuilds the demo book from scratch. Plain
`npm run demo` reuses it, which is what you want between takes.

### Things that must never reach the recording

| Never on camera | Why |
|---|---|
| **Import → Connect broker with credentials filled in** | API key, client code, PIN and TOTP secret. The demo book has no connections so the screen renders empty — that is the shot you want. This is the same reason `broker-connect.png` is hand-taken and excluded from the screenshot script. |
| **Your real journal** | Use the demo server. Do not "just quickly" switch to your own book to show something. |
| **A licence key, or Settings → License with a real key active** | Key IDs identify a buyer. |
| **macOS, or any Mac reference** | macOS is not sold (owner decision 2026-08-15). |
| **TradingView, Pine Script, "indicators"** | Invite-only, not part of this product. |
| **OpenAlgo** | Ships switched off and undocumented until a live pull is reconciled against a contract note. Do not enable it for the camera. |
| **Any return, win-rate or accuracy claim** | SEBI posture. See §4. |

### OBS settings that avoid the usual mistakes

- **Base and output resolution 1920×1080**, 30 fps. Do not record at 4K and
  downscale; text goes soft.
- Capture the **browser window**, not the full desktop — no taskbar, no
  notifications, no other tabs.
- Put the browser in a clean window: no bookmarks bar, no extensions visible.
  A fresh profile is easiest.
- **Turn off notifications** (Windows Focus Assist) before the first take.
- Record system audio **off**, mic **on**, one track. Fix levels in Audacity
  afterwards rather than fighting them live.
- Move the mouse **slowly and deliberately**. Fast cursor movement is the
  single clearest tell of an amateur software demo.

---

## 1. The long walkthrough (target 6–8 minutes)

Record it in the order below. Pause between sections — the silence gives you
clean cut points, and you can re-take one section without redoing the lot.

### Section A — the problem (45 s, no screen yet or dashboard idle)

> Most trading journals tell you what your profit and loss was. Your broker
> already told you that. What they don't tell you is what it actually cost you
> to get there, or which of your own habits is quietly taking the money back.
>
> Vyuha is a trade journal for Indian retail traders that runs entirely on your
> own computer. No account, no cloud, no telemetry. I built it because I wanted
> those answers for myself.

### Section B — import (90 s) · screen: **Journal → Import**

Drag `tests/fixtures/dhan-gtr.csv` onto the dropzone. Let the preview render.

> Drop a broker file in and Vyuha works out whose it is. Six brokers are
> recognised automatically — Zerodha, Dhan, Groww, Angel One, Upstox and Paytm
> Money — and it identifies them by what's inside the file, not the filename.
>
> Here's the part that matters. It doesn't take the broker's charge figures on
> faith. It recomputes every charge — brokerage, STT, exchange fees, SEBI
> turnover, stamp duty, GST — from your own rate card, and shows you its number
> against theirs before anything is saved.

Point at the charge reconciliation panel. Then commit.

> If your broker's file doesn't match a layout it knows, it asks you which
> column is which — once — and then remembers. It will never guess. A file it
> can't read produces a question, not a trade with the quantity in the price
> field.

### Section C — the trades table (60 s) · screen: **Trades**

> Every fill is paired into the trade you actually made. Buys and sells on the
> same day net off first, then oldest lot first. If you sold something you
> bought before this file starts, it says so and leaves the P&L blank rather
> than booking the whole sale as profit.

Open one trade. Show the leg detail.

> Scaled into a position across several days? The ladder is preserved, so you
> see the shape of how you actually built it — not one blended average.

### Section D — the analytics (2 min) · screens as listed

Move through these, roughly 20 seconds each. Say what the screen answers, not
what it contains.

| Screen | The question it answers |
|---|---|
| **Arjun's Eye** | "When am I actually good, and when am I just busy?" |
| **Reports → Edge / Setups** | "Which of my setups earns, by expectancy — not by feel" |
| **Reports → Discipline** | "Which broken rule costs me the most" |
| **Lenses** | "Group my book any way I like and see the edge per group" |
| **Reports → Charges & MTF Leak** | "Where the money actually goes" |
| **Risk** | "What am I exposed to right now" |
| **Options Seller Journal** | "IV, days to expiry, hedge, expiry outcome" |

### Section E — tax (45 s) · screen: **Reports → Tax Summary**, then ITR

> Come March, the tax pack is already built: tax summary with grandfathering
> and set-off, an ITR schedule export your CA can read, advance-tax instalment
> dates, harvesting, and a reconcile against the AIS JSON from the portal.
>
> Where it can't derive a number honestly, it leaves the cell blank instead of
> writing a zero.

### Section F — it's yours (45 s) · screen: **Settings → Appearance**, then Backup

> Nine skins, light and dark, tint and panel style — because you're going to
> look at this a lot.
>
> And your data is a single file on your machine. Back it up, move it to a new
> computer, export it to CSV whenever you like. The core journal — recording
> your trades, all six importers, the dashboard, backups — is free forever. A
> licence unlocks the analytics layer. Whatever happens to a licence, your own
> record of your own trading keeps working.

### Section G — close (20 s)

> Every fresh install starts with a seven-day full trial. No signup, no card.
> Link below.

---

## 2. The 90-second cut

Assemble from the footage above. Nothing new to record.

| Time | Source | Note |
|---|---|---|
| 0:00–0:12 | Section A, second half | Hook. Cut the first sentence, start on "What they don't tell you". |
| 0:12–0:40 | Section B | Import + the charge reconciliation panel. **This is the differentiator — give it the most time.** |
| 0:40–0:55 | Section C | One trade opening, showing the ladder. |
| 0:55–1:15 | Section D | Fast montage: Arjun's Eye → Edge → Discipline → Charges. No narration over it except one line. |
| 1:15–1:25 | Section F | "single file on your machine, core journal free forever" |
| 1:25–1:30 | Section G | Trial + link. |

---

## 3. Free toolchain

| Job | Tool |
|---|---|
| Screen recording | **OBS Studio** — free, no watermark, no time limit |
| Quick capture | Windows **Xbox Game Bar** (`Win+G`) for rough takes |
| Editing | **Shotcut** (gentler) or **Kdenlive** |
| Editing, heavier | **DaVinci Resolve** free tier |
| Voice cleanup | **Audacity** — noise reduction, then normalise to about −16 LUFS |

Record the narration **separately** from the screen capture and lay it over in
the edit. Trying to talk and drive at once is what makes demos ramble, and it
means a fluffed line costs you one sentence rather than one take.

---

## 4. Claims you may and may not make

Binding, not stylistic — `MONETIZATION_PLAN.md` §5 and
`PINE_SCRIPT_INVITE_ONLY.md` §Disclaimers.

**Safe**, because each is a property of the software:

- "Recomputes every charge from your own rate card"
- "Runs entirely on your computer — no account, no cloud, no telemetry"
- "Six brokers auto-detected; any other CSV through the column mapper"
- "Three live broker API pulls — Zerodha Kite, Dhan, Angel One SmartAPI"
- "The core journal is free forever"
- "Seven-day full trial, no signup, no card"

**Never** — these are outcome claims and they are the ones that attract
regulatory attention:

- Anything about returns, profit or "how much you'll make"
- Any win-rate or accuracy figure
- "Improves your trading" / "makes you profitable"
- Any suggestion this is advice, a recommendation, or a tip service

If a line feels persuasive because it implies a result, cut it. The product's
actual pitch is that it tells you the truth about costs — lead with that.

---

## 5. What to re-record when the UI changes

The screenshots in `docs/screenshots/` are regenerated by
`scripts/retake-screenshots.mjs`. This video is not. If you change the
dashboard, the trades table or the import flow materially, Sections B, C and D
are the ones that go stale — re-record those and re-cut, rather than reshooting
everything.
