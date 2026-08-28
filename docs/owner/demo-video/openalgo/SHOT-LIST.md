# OpenAlgo setup video — shot list (manual recording)

Owner-only · 2026-08-28. This video is recorded BY HAND with the OBS kit
(`../03-setup-recording.ps1`, same profile and hotkeys) because it spans three
surfaces — a terminal, OpenAlgo's web UI and Vyuha — and two of them hold real
credentials, which the automated recorder must never touch.

**Companion document:** `docs/OPENALGO_SETUP.md` — the video is that guide,
performed. Narration: `NARRATION.md` beside this file.

## BEFORE ANYTHING: what must never be readable on camera

- The broker API key/secret lines of the `.env` — blur in the edit, or type
  them OFF camera and show the file with those two values already replaced by
  `●●●` (keep `REDIRECT_URL` visible; it is not a secret).
- The broker login itself (client id / PIN / TOTP) — cut the take, log in off
  camera, resume on the logged-in dashboard.
- The OpenAlgo API key may be shown PARTIALLY (its own page masks it) — never
  paste it visibly into Vyuha; Vyuha masks the field, which is fine to show.
- Use a DEMO Vyuha (`npm run demo -- --fresh`) for the Vyuha half? NO — the
  OpenAlgo tab needs the disclosure accepted and a live instance, so this one
  video uses the real app on a THROWAWAY account created for the shoot.
  Nothing of the real book may appear: stay on the throwaway account.

## SHOT A · What this is · ~20 s
OpenAlgo's public site/docs page open. Slow scroll of the broker list.

## SHOT B · The .env · ~40 s
The instance folder in Explorer → open `.env` in Notepad → the three broker
lines visible with secrets already masked → REDIRECT_URL and the port lines
get a beat of stillness each.

## SHOT C · First start and login · ~30 s
Terminal: start the instance. Hold on the console banner (it prints the real
address/port — the narration points at it). Browser: the logged-in dashboard
with the broker name + Live Mode chip. (Login itself happened off camera.)

## SHOT D · The sanity check · ~20 s
OpenAlgo → Tradebook. Today's fills visible. Still for 4 s — this is the
"if it is not here, Vyuha cannot see it either" moment.

## SHOT E · The API key · ~15 s
OpenAlgo → API Key page (masked). Click Copy.

## SHOT F · Vyuha: the disclosure · ~40 s
Vyuha → Settings → Integrations (advanced) → flip the switch → the disclosure
dialog. SLOW scroll through the whole text — this shot is the trust-builder;
the narration reads the key lines while they are on screen. Accept.

## SHOT G · Add the instance · ~30 s
Import → OpenAlgo (self-hosted) → key pasted (masked), host typed, broker
picked → Add instance → the saved instance row appears.

## SHOT H · Preview, then commit · ~40 s
Preview pull → the message with trade count. Pull & commit → committed line →
Trades page on the throwaway account showing the imported book.

## SHOT I · Re-pull honesty · ~20 s
Pull & commit again → the "already in your journal" dialog listing the trades
→ OK. (The duplicate protections are a selling point — show them.)

Total footage ≈ 4½ minutes → edits to ~4.
