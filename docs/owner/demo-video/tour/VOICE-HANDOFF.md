# Voice handoff — the ONLY human (or Cowork) step left

Owner-only · 2026-08-28. The tour assembles itself: `record.mjs` films the
takes, `assemble.mjs` builds the master with lower-thirds and end card burned
in. The one thing a machine on this repo cannot legally produce is the VOICE —
the licensed TTS lives inside Clipchamp. This document gets those 13 audio
files made, by you or by Claude Cowork, in ~20 minutes.

## What must come out of this step

A folder (e.g. `Desktop\vyuha-voice\`) containing **13 files**:

    T-0.mp4  T-1.mp4  T-2.mp4 … T-12.mp4

Each file = ONE narration block from `NARRATION.md`, spoken by Clipchamp's
Text-to-Speech (**English (India)**, female, speed **0.9×**), exported as a
tiny mp4 (Clipchamp always exports mp4; the assembler reads the audio out of
it — video content is irrelevant, black is fine).

Then one command produces the finished video:

    node scripts/demo-video/assemble.mjs --voice="C:\Users\theje\Desktop\vyuha-voice"

Optional music bed: export any ONE Clipchamp stock instrumental the same way
(a project containing only the music track) as `music.mp4` and add
`--music="...\music.mp4"` — the assembler ducks it to background level.

## The Clipchamp loop (identical 13 times)

1. Open Clipchamp (Windows 11 built-in) → **Create a new video** (once).
2. **Record & create → Text to speech**.
3. Paste ONE block from `tour/NARRATION.md` (the text under the `T-n` heading,
   not the heading itself). Language **English**, voice **English (India)**
   (pick the female voice; keep the SAME voice for all 13), speed **0.9×** →
   **Save**. The clip lands in the media bin — drag it onto the timeline.
4. **Export → 480p** (audio quality is unaffected; small file, fast).
5. Rename the download to `T-0.mp4` … `T-12.mp4` and move it into the folder.
6. Delete the clip from the timeline and bin. Repeat from step 2.

Rules that matter:
- One block per file. Do not merge blocks — the assembler places each at its
  own timecode from `demo-takes/CUE-SHEET.md`.
- Same voice, same speed, all 13. A voice change mid-video reads as an error.
- Read nothing aloud yourself and add nothing to the text — the narration is
  under a CI guard for claims; the files must say exactly what it says.

## Paste-this prompt for Claude Cowork

> Open Clipchamp on this computer. I need 13 text-to-speech audio files made
> from the numbered blocks (T-0 through T-12) in the file
> `T:\Thejesh\CLAUDE-CODE\VYUHA-TRADE JOURNAL-V1\docs\owner\demo-video\tour\NARRATION.md`.
> For each block: use Record & create → Text to speech, paste only that
> block's paragraph text (never the heading or the italic timing line), set
> language English, voice English (India) — pick one female voice and use the
> SAME voice for all 13 — speed 0.9x, save it, drag the clip to the timeline,
> export at 480p, rename the exported file to the block's name (T-0.mp4,
> T-1.mp4, …), move it to a folder `vyuha-voice` on the Desktop, then remove
> the clip from the timeline and bin before the next block. Do not edit or
> reword any text. Do not add music or effects. When all 13 files exist, also
> export one Clipchamp stock instrumental track (calm, no vocals) the same way
> as music.mp4 into the same folder, then tell me the folder is ready. If any
> Clipchamp step looks different from what I described, pause and ask me
> instead of improvising.

When Cowork (or you) reports the folder ready, run the assemble command above
— `demo-takes/master-voiced.mp4` is the finished tour, ready to upload.
