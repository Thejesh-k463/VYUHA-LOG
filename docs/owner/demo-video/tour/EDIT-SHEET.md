# Tour edit sheet — Clipchamp assembly for the 10-minute walkthrough

Owner-only · 2026-08-28 · footage from `node scripts/demo-video/record.mjs`
(eleven `.webm` takes in `demo-takes/`), voice from `tour/NARRATION.md`
(thirteen `T-n` TTS clips), end card from `../04-end-card.html`.

## Timeline

| # | Video track | Voice track | Notes |
|---|---|---|---|
| 1 | `01-dashboard.webm` | **T-0** over the first ~18 s, then **T-1** | T-0 starts at 0:00 — the dashboard IS the cold open; no logo intro |
| 2 | `02-portfolio-risk.webm` | **T-2** | Let the Set-SL/TSL dialog moment play in SILENCE after T-2 ends |
| 3 | `03-accounts.webm` | **T-3** | The first account switch must land exactly on "Watch the switch" — nudge the clip, not the voice |
| 4 | `04-calculator-session.webm` | **T-4** | |
| 5 | `05-trades.webm` | **T-5** | The chart-attachment upload lands on "holds the evidence" |
| 6 | `06-arjuns-eye.webm` | **T-6** | |
| 7 | `07-lenses-delete.webm` | **T-7** | The delete-by-scope dialog plays after the voice line — silence again |
| 8 | `08-import.webm` | **T-8** | "shows its number beside the broker's" must land while the reconciliation panel is on screen |
| 9 | `09-charges-broker-costs.webm` | **T-9** | |
| 10 | `10-tax.webm` | **T-10** | If a blank ITR cell is visible, it lands on "leaves the cell blank" |
| 11 | `11-settings-backup.webm` | **T-11** | |
| 12 | End card (5 s still, F11 screenshot of `04-end-card.html`) | **T-12** | Fade video to the card, voice continues over it |

Trim rule: every take starts and ends with ~1 s of stillness — cut inside it.
If a take runs long against its block, speed the SCROLLING stretches to 1.25×
(never a click moment; a sped-up click reads as a glitch).

## Sound

- Music: one Clipchamp stock track, instrumental, low-key — duck to −18 dB under
  voice, −12 dB in the silent screen moments. No track changes mid-video.
- No sound effects. The product is the show.

## Lower-thirds (Clipchamp text, bottom-left, 3–4 s each)

1. Scene 1 · "Runs entirely on your computer — no cloud, no telemetry"
2. Scene 3 · "One book per account · aggregate view is read-only"
3. Scene 8 · "Charges recomputed from your rate card, before anything is saved"
4. Scene 9 · "Verified against brokers' signed contract notes"

## Export

1080p · 30 fps · highest quality Clipchamp offers. Filename
`vyuha-tour-v<version>.mp4`. Keep the takes folder — a future release re-films
single scenes with `--only=N` and only that clip gets swapped in the edit.
