# OpenAlgo setup video — narration

Owner-only · 2026-08-28 · pairs with `SHOT-LIST.md` shots A–I. Clipchamp TTS,
English (India), 0.9×, one block per clip (`OA-x`). This narration NAMES
OpenAlgo — that is its purpose — but it makes no outcome claims, and it states
the risk honestly, because that framing IS the product's position.

---

## OA-A · What this is
Some brokers — Groww, Paytm Money, Kotak — give you no import API at all.
OpenAlgo fixes that. It is an open-source bridge that runs on your own
computer, speaks to more than thirty Indian brokers, and gives Vyuha one local
address to pull your fills from. Here is the whole setup, end to end.

## OA-B · The configuration
One OpenAlgo instance connects to one broker. Its configuration is three
lines: your broker's API key, and the address the instance runs on. Running a
second broker? Second instance, different port. The exact lines for every
broker are in OpenAlgo's own docs — and in Vyuha's setup guide, linked below.

## OA-C · Start and log in
Start it, and the console tells you exactly where it lives. Log in with your
broker — same credentials as the broker's own app. From here, the instance
keeps that session on your machine.

## OA-D · The sanity check
Before touching Vyuha, one check: OpenAlgo's own trade book. If today's fills
are here, you are ready. If they are not, Vyuha cannot see them either — this
page is the truth of what the bridge can serve.

## OA-E · The key
This key is OpenAlgo's — not your broker's. It is what Vyuha will hold, and
you can revoke it here any time, without touching your broker account.

## OA-F · The honest switch
In Vyuha, the integration is off until you turn it on — and this screen is
why. Your broker credentials live in OpenAlgo, not in Vyuha. The risk is
small, and it is stated plainly: you are running one more program that holds
a broker credential, on your own machine. The data only ever flows from your
broker to you — OpenAlgo is the medium, not a cloud. Read it, accept it, and
the acceptance goes into your own audit log.

## OA-G · Connect
The key, the address, and — this matters — which broker sits behind the
instance, because that is what prices the charges. Saving checks the
connection live: a typo fails now, with a message, not tomorrow.

## OA-H · Pull
Preview shows what would land, before anything is written. Commit runs the
same pipeline as every file import — charges from your rate card, duplicates
checked. Today's fills, in your journal, seconds after you are done trading.

## OA-I · Pull again — nothing doubles
And if you pull twice? Nothing doubles, and nothing is silent about it —
Vyuha shows you exactly which trades were already in the book. That is the
whole philosophy in one dialog.

---
Publish note: description links `docs/OPENALGO_SETUP.md` and states the
integration is optional and off by default.
