# Shot list — what your hands do, one take per shot

Owner-only · 2026-08-23 · v2.99.100. Read this on a second screen or a phone
while recording. Every navigation below is the **exact sidebar label** from
`components/layout/nav-config.ts`; a label that is not in the sidebar says
where it actually lives.

**Rhythm for every shot:** navigate to the start screen *first*, rest your
hands, press **Ctrl+Shift+F9**, wait one full second, do the shot, wait one
full second, press **Ctrl+Shift+F10**. The stillness at each end is what the
edit cuts on. Move the cursor like you are showing a friend — every click gets
a beat of stillness before and after.

**Before shot 1:** `npm run demo -- --fresh` is running and says DEMO READY;
the browser is on `http://localhost:3214` at 1920×1080 in a fresh profile;
Focus Assist is on; `tests\fixtures\zerodha-tradebook.csv` is on the Desktop.

**Folded groups (v3.6):** each sidebar group shows only its most-used screens
plus an "N more…" row. Before recording, click the "N more…" row under
*Analytics* and *Tax* once — the expansion persists for the whole session, so
every screen named below is one click away and no take shows you hunting.

---

## SHOT 1 · THE GAP  ·  ~15 s  ·  pairs with VO-1

| Step | Action | Hold |
|---|---|---|
| 1 | Start on **Dashboard** (sidebar group *Overview*). You will see the 7-day trial banner — that is correct, it is the real first-run experience; leave it. | 2 s |
| 2 | Sidebar → *Analytics* → **Charges & MTF Leak** | — |
| 3 | Let it render. Hover one row of the charge breakdown so the tooltip shows. | 4 s |

*The viewer must see the computed-vs-stated comparison before the narration finishes. If the report is sparse on the demo book, hover the biggest single charge line.*

---

## SHOT 2 · WHAT THIS IS  ·  ~10 s  ·  pairs with VO-2

| Step | Action | Hold |
|---|---|---|
| 1 | Sidebar → **Dashboard** | 2 s |
| 2 | Scroll down slowly — mouse wheel, one notch per second — through the equity curve and the calendar | ~5 s |
| 3 | Stop with the sidebar footer **`Local · Offline · v2.99`** visible | 2 s |

---

## SHOT 3 · IMPORT  ·  ~25 s  ·  pairs with VO-3  ·  **the differentiator**

| Step | Action | Hold |
|---|---|---|
| 1 | Sidebar → *Import* → **Import** | 2 s |
| 2 | The dropzone reads **"Drop a broker file"**. Drag `zerodha-tradebook.csv` from the Desktop onto it. Release. **Hands off the mouse.** | — |
| 3 | Let the preview render fully. Do not scroll yet. | 3 s |
| 4 | Scroll slowly to the **charge reconciliation panel** — computed vs the broker's stated figures. Hover a row. | 4 s |
| 5 | Click the button that reads **"Commit N new trades"**. | — |
| 6 | Hold on **"Imported N trades"**. | 2 s |

*If the button reads "0 new trades" the file was already imported — run `npm run demo -- --fresh` and re-take.*

---

## SHOT 4 · ONE TRADE  ·  ~15 s  ·  pairs with VO-4

| Step | Action | Hold |
|---|---|---|
| 1 | Sidebar → *Journal* → **Trades** | 2 s |
| 2 | Find a row whose Qty column shows it was scaled in (the demo book has several multi-tranche positions from the Dhan data). Click it. | — |
| 3 | The trade detail opens. Scroll slowly through the **legs / executions** so the ladder is visible. | 4 s |

*Pick the row before you start recording — know which one you are clicking.*

---

## SHOT 5 · THE QUESTIONS  ·  ~30 s  ·  pairs with VO-5  ·  four screens, one sentence each

Record these as **four separate takes** (5a–5d). The edit cuts between them hard.

| Take | Sidebar path | Hold |
|---|---|---|
| 5a | *Analytics* → **Arjun's Eye** | 6 s — let the charts draw, then still |
| 5b | *Analytics* → **Edge / Setups** | 6 s |
| 5c | *Analytics* → **Discipline** | 6 s |
| 5d | *Positions* → **Portfolio Risk** | 6 s |

*Nav label note: it is "Portfolio Risk" under Positions — not "Risk".*

---

## SHOT 6 · TAX  ·  ~13 s  ·  pairs with VO-6

| Step | Action | Hold |
|---|---|---|
| 1 | *Tax* → **Tax Summary** | 4 s |
| 2 | *Tax* → **ITR Pack (India)** | — |
| 3 | Scroll slowly. If a blank cell is visible (something the app could not derive), let the cursor rest near it. | 4 s |

---

## SHOT 7 · YOURS  ·  ~14 s  ·  pairs with VO-7

| Step | Action | Hold |
|---|---|---|
| 1 | *System* → **Settings** → the **Appearance** section | 2 s |
| 2 | Click through three skins slowly: **Luxe → Sapphire → Aurora**. One second on each. | 3 s |
| 3 | Click back to **Luxe** (the landing-page look) | 1 s |
| 4 | *System* → **Backup & Restore** | 3 s |

*Nav label note: it is "Backup & Restore" under System — not "Backup".*

---

## SHOT 8 · THE ASK  ·  ~8 s  ·  pairs with VO-8

Pricing is **not in the sidebar**. Reach it via Settings → License — the two plan pills (**Journal — Lifetime ₹29,999** · **Pro — Annual ₹9,999/yr**) open the plan card.

| Step | Action | Hold |
|---|---|---|
| 1 | *System* → **Settings** → scroll to the **License** card | 2 s |
| 2 | Hover the two plan pills so the struck-out list prices are visible | 4 s |
| 3 | Stop. Hands still. (The end card is added in the edit.) | 2 s |

*Do NOT click Activate, and the key field must be empty. Machine ID being visible is fine — it is a fingerprint, not a secret.*

---

## After the last take

1. OBS → **File → Remux Recordings** → convert every `.mkv` to `.mp4`.
2. **Ctrl+C** in the demo terminal.
3. If you changed the display to 1920×1080, set it back.
4. Copy the eight `.mp4` files into a folder named `vyuha-demo-takes-2026-08-23` — keep them; re-shoots later are per shot.

## If something goes wrong mid-take

Finish the take anyway, then re-take. Never stop recording mid-shot — a half take is worth nothing and a full take with a fumble can often be trimmed.
