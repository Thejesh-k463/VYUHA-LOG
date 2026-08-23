# Demo video kit

Owner-only. Everything needed to record, voice, edit and publish the Vyuha
demo, generated 2026-08-23 against v2.99.100. Use the files in number order.

| File | What it is | When |
|---|---|---|
| `03-setup-recording.ps1` | One-time setup: installs OBS via winget, installs the `Vyuha Demo` OBS profile, creates the takes folder, prints the per-session manual steps. Idempotent. Run **elevated**. | Once |
| `obs-profile/Vyuha Demo/` | The OBS profile the script installs — 1080p canvas = output (no resample), 30 fps, mkv, x264 CRF 18, hotkeys Ctrl+Shift+F9/F10. Importable by hand via OBS → Profile → Import if you prefer. | Once |
| `02-SHOT-LIST.md` | What your hands do, eight shots, one take each. Every sidebar label is the exact string in `components/layout/nav-config.ts` — **pinned by `tests/demo-video-copy.test.ts`**, so a renamed screen breaks this file in CI, not in front of the camera. | Recording |
| `01-NARRATION.md` | The voice-over, one block per shot, for Clipchamp Text to Speech (English-India, 0.9×). Pasted one block at a time → eight `VO-n` clips. | Voice |
| `05-EDIT-SHEET.md` | Clipchamp timeline: clip order, the exact word each action lands on, the three lower-third overlays, audio rules, the 60-second cut, export settings. | Edit |
| `04-end-card.html` | The final 5-second card — fixed 1920×1080, brand mark embedded as an image (never a text व, per the AGENTS.md brand rule). Open, press F11, screenshot. | Edit |
| `06-PUBLISH-COPY.md` | YouTube titles/descriptions, X, LinkedIn, WhatsApp — paste-ready. **Scanned by the test for outcome claims** and the standing exclusions (macOS, indicators, OpenAlgo). | Publish |

The long-form guide with the reasoning behind every setting is the published
artifact *Vyuha Demo Video Guide*; this folder is the executable version of it.

## Why the copy is under test

`tests/demo-video-copy.test.ts` fails the build if `01-NARRATION.md` or
`06-PUBLISH-COPY.md` contains any of: *improve your trading · make money ·
win-rate · accuracy · guarantee · returns · beat the market · tips/calls ·
AI-powered · macOS · TradingView · Pine Script · indicator · OpenAlgo*. The
SEBI posture in `MONETIZATION_PLAN.md` §5 is binding, and a demo video is the
single most-watched claim the product will make. The rule is simple: describe
what the software **does**, never what the user will **get**.

## Three facts that shaped the kit (checked, not recalled)

- **OBS was not installed** on the build machine → the script installs it.
- **The display is 2194×1234**, not 16:9 → the guide says set 1920×1080 at 100 %
  before recording, and the profile makes canvas = output so nothing resamples.
- **ElevenLabs' free tier has no commercial licence** → the kit uses Clipchamp,
  built into Windows 11, whose TTS and stock media are licensed for commercial
  use. A sales video on an unlicensed voice is a problem you do not want.

## What must never appear on camera

Import → Connect broker with fields filled · the real journal · Settings →
License with a key active · macOS · indicators · OpenAlgo or the Integrations
switch on · any outcome claim · the desktop, taskbar or a notification.
`npm run demo -- --fresh` + Window Capture + Focus Assist handles all of it.
