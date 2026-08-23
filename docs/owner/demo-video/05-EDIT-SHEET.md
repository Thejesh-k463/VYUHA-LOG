# Edit sheet — Clipchamp, timeline order, overlays, export

Owner-only · 2026-08-23. Do this once the eight takes are remuxed to `.mp4`
and the eight `VO-n` clips are generated.

## Timeline, in order

| # | Video clip | VO | Sync point — the word the action must land on | Overlay (lower third) |
|---|---|---|---|---|
| 1 | SHOT 1 | VO-1 | Hover on the charge row lands on **"rarely the number"** | `Your broker's charges vs. what it actually cost` |
| 2 | SHOT 2 | VO-2 | Footer `Local · Offline` visible on **"Nothing leaves your machine"** | — |
| 3 | SHOT 3 | VO-3 | File dropped on **"Drop your broker file in"** · reconciliation panel on **"recomputes every charge"** · Commit click on **"before anything is saved"** | `Six brokers auto-detected · any CSV via the column mapper` |
| 4 | SHOT 4 | VO-4 | Legs scrolling on **"The ladder is kept"** | — |
| 5a | Arjun's Eye | VO-5 | On **"When am I actually good"** | — |
| 5b | Edge / Setups | VO-5 | On **"Which setup earns"** | — |
| 5c | Discipline | VO-5 | On **"Which broken rule"** | — |
| 5d | Portfolio Risk | VO-5 | On **"what am I exposed to"** | — |
| 6 | SHOT 6 | VO-6 | ITR Pack on **"I T R schedules"** · blank cell on **"leaves the cell blank"** | — |
| 7 | SHOT 7 | VO-7 | Skin clicks on **"Nine skins"** · Backup & Restore on **"Back it up"** | `Core journal free forever · a licence unlocks the analytics` |
| 8 | SHOT 8 | VO-8 | Plan pills on **"seven-day full trial"** | — |
| 9 | `04-end-card.html` screenshot, 5 s | (none — silence, or the music tail) | — | — |

**Shot 5 is one VO over four clips.** Put VO-5 down once; cut the four takes to
land each screen on its sentence. Hard cuts, no transitions.

## Overlay style (set once, then duplicate)

- Text: **Inter Tight**, 600, 44 px, white `#EDE9E3`
- Band: lower third, full width, `#0C0F12` at 78 % opacity, 120 px tall, text vertically centred, 96 px left inset
- In/out: 0.25 s fade. Appears 0.5 s after the cut, leaves 0.5 s before the next.
- **Three overlays, no more.** A fourth is where it starts looking like a template.

## Audio

- **Detach and delete the OBS audio** on every video clip. Right-click → Detach audio → delete the audio clip. Only the VO remains.
- VO clips at **0 dB**. Do not normalise per clip — Clipchamp's TTS is already level.
- Music: **optional, default none.** If used: Clipchamp stock → search "ambient minimal" → something with no melody → **−24 dB**. Fade out under the end card. If you audition three and none feel obviously right, use none.
- Captions: **Captions → Auto captions** → English. Then read every line against `01-NARRATION.md` and fix the mis-hears (it will get "Vyuha", "P and L" and "I T R" wrong).

## Pace rules

- A shot may be **slowed to 0.8×** to fit its VO. Never sped up.
- If VO is longer than the footage: right-click the last frame → **Freeze frame**, extend. Do not stretch the voice.
- Total long cut: **2:00–2:10**. If it's over 2:20, cut shot 2 entirely before cutting anything else.

## The 60-second cut

Same project, **Save as** `vyuha-demo-60s`. Delete shots 2, 4, 6, 7 and their VO. Keep shots 1, 3, 5 (all four), 8, end card. Trim shot 3 to the drop + the reconciliation panel + Commit — lose the hold times. Target **0:58–1:02**.

## Export

| Output | Settings | Goes to |
|---|---|---|
| `vyuha-demo-v1.mp4` | 1080p, high quality | YouTube (unlisted), landing page embed |
| `vyuha-demo-60s.mp4` | 1080p | YouTube, X, LinkedIn native upload |
| `vyuha-demo-60s-wa.mp4` | **720p** | WhatsApp — it recompresses, so start smaller |

**Before publishing any of them:** watch once on a phone, muted. The captions must carry the story alone.

## Keep

The Clipchamp project and `vyuha-demo-takes-2026-08-23/`. Shots 3, 4 and 5 go stale first when the UI changes — re-record only those, re-align, re-export.
