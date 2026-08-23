# Publish copy — titles, descriptions, posts

Owner-only · 2026-08-23. Every block is paste-ready. None makes an outcome
claim; `tests/no-outcome-claims-in-demo-copy.test.ts` scans this file and fails
on any of the banned phrases, so a future edit cannot quietly add one.

---

## YouTube — long cut (`vyuha-demo-v1.mp4`)

**Title**
```
Vyuha — a trade journal that tells you what trading actually cost you
```

**Description**
```
Vyuha is a trade journal for Indian retail traders that runs entirely on your own computer. No account, no cloud, no telemetry.

What it does:
• Imports your broker's file — six brokers recognised automatically (Zerodha, Dhan, Groww, Angel One, Upstox, Paytm Money); any other CSV through a column mapper that asks once
• Recomputes every charge from your own rate card and shows it next to the broker's figure before anything is saved
• Pairs every fill into the trade you actually made — same-day netting first, then FIFO; scaled-in positions keep their ladder
• Answers the questions a P&L can't: when you're actually good vs just busy, which setup earns by expectancy, which broken rule costs the most, what you're exposed to right now
• Builds the tax pack — ITR schedules, advance-tax dates, harvesting — and leaves a cell blank rather than write a zero it can't justify
• Nine skins, light or dark. One SQLite file you can back up, move, or export any time.

The core journal is free forever. A licence unlocks the analytics layer.

Every fresh install starts with a 7-day full trial. No sign-up, no card.
→ https://thejesh-k463.github.io/VYUHA-LOG/

Windows. Built by one person. Vyuha is a record-keeping and analytics tool, not investment advice.
```

**Tags**
```
trade journal, trading journal india, zerodha, dhan, groww, angel one, upstox, paytm money, STT, brokerage charges, ITR, capital gains, offline, local-first
```

---

## YouTube — 60-second cut (`vyuha-demo-60s.mp4`)

**Title**
```
What your broker actually charged you — Vyuha, in 60 seconds
```

**Description**
```
A trade journal for Indian retail traders that recomputes every charge from your own rate card and shows it against the broker's — before anything is saved. Runs entirely on your computer.

7-day full trial, no sign-up, no card → https://thejesh-k463.github.io/VYUHA-LOG/

Not investment advice. Windows.
```

---

## X / Twitter — native video upload, 60-second cut

```
Your broker told you your P&L.

It didn't tell you what it actually cost you to get there.

Vyuha recomputes every charge from your own rate card and shows it next to the broker's figure — before a single trade is saved. Runs entirely on your machine.

7-day trial, no card → thejesh-k463.github.io/VYUHA-LOG
```

*(One post. No thread. Video attached natively — a link-only post is buried.)*

---

## LinkedIn — native video upload, 60-second cut

```
I built a trade journal for Indian retail traders, and the one thing it does that nothing else does is this: it recomputes every charge — brokerage, STT, exchange, SEBI, stamp, GST — from your own rate card, and shows it next to what the broker actually billed. Before anything is saved.

Six brokers are recognised on sight. Everything runs on your own computer: no account, no cloud, nothing uploaded.

It is a record-keeping tool. It will not tell you what to buy, and it does not claim to make you a better trader — it shows you what your trading cost and where the money went. That turned out to be the thing I wanted and couldn't find.

Seven-day full trial, no sign-up, no card: https://thejesh-k463.github.io/VYUHA-LOG/

Windows only for now.
```

---

## WhatsApp — to a prospect, with `vyuha-demo-60s-wa.mp4` attached

```
Made a short video of Vyuha — 60 seconds. The part worth watching is at 0:15: it recomputes every charge from your rate card and shows it against what the broker billed, before anything is saved.

Runs fully on your own PC. 7-day full trial, no card. Link: thejesh-k463.github.io/VYUHA-LOG

Happy to answer anything.
```

---

## Banned phrases — this file is tested against them

The test fails if any of these appear anywhere above, case-insensitive:

`improve your trading` · `become profitable` · `make money` · `win rate` · `win-rate` · `accuracy` · `guaranteed` · `returns` · `profits` (as a promise) · `beat the market` · `edge over` · `tips` · `calls` · `recommendation` · `AI-powered` · `macOS` · `Mac` · `TradingView` · `Pine Script` · `indicator` · `OpenAlgo`

If you want to add copy here, keep it inside the rule: describe what the
software **does**, never what the user will **get**.
