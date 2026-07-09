# Growth Engine & Content Bot — Task Plan (X / Twitter, compliance-first)

## Read this first — what changed and why

Your original ask was a bot that **auto-tweets *at* handles with >500 followers who tweet about
stocks**. I won't build that version, and you shouldn't want it: automated mass-mentioning of
strangers is **platform manipulation / spam** under X's Rules and the Developer Agreement. It
reliably gets both the **API app and the account suspended** — fast — and it burns your brand and
your product's credibility on day one. It also can't be done well with the API anyway (mention
spam is exactly what X's anti-spam ML targets).

**Same goal, compliant design.** This plan splits into two engines:

1. **Content Engine** — schedules and posts *your own* content to *your own* account (100% allowed).
2. **Audience-Research Engine** — *finds and ranks* relevant finance accounts into a list so **you
   engage them manually and genuinely** (allowed; the automation stops before any outreach action).

The line you must not cross: **automation may inform and schedule; a human performs any interaction
with another user's content (reply, quote, mention, DM, follow).**

---

## Engine 1 — Content Engine (your account, automated)

### What it does
- Maintains a content calendar of tweets/threads about Vyuha + the indicators.
- Auto-generates drafts (tax-season hooks, feature spotlights, "leak of the week", chart tips).
- Schedules and posts them to **your** handle at optimal times.
- Optionally auto-posts a pre-approved thread when you ship a new app version.

### Stack
- **X API v2** (Free or Basic tier) with **your own** app + OAuth for **your** account only.
  - Free tier allows a limited number of posts/month — enough to start; upgrade to Basic if needed.
- A tiny scheduler: a cron (or a `ScheduleWakeup`/CronCreate routine, or GitHub Actions cron) that
  reads the next queued post from a store (SQLite / a Google Sheet / a JSON file) and calls
  `POST /2/tweets`.
- **Draft generation** with an LLM: feed it your feature list + a tone guide → produce 10 drafts →
  **you approve** into the queue. Keep a human approval gate; never post ungated generated text.

### Task breakdown
1. Create an X developer account + app; store keys in a secrets file (never commit).
2. OAuth 2.0 user-context auth for your handle; verify a manual test tweet via API.
3. Content store schema: `id, body, media_path, scheduled_for, status(draft|approved|posted), thread_parent`.
4. Draft generator: prompt template + your feature bank → drafts land as `status=draft`.
5. Approval step: a simple CLI/sheet toggle to mark `approved`.
6. Scheduler job: every N minutes, post the next `approved` whose time has passed; mark `posted`.
7. Thread support: chain replies via `in_reply_to_tweet_id`.
8. Media: attach chart images/screenshots (upload via media endpoint).
9. Logging + rate-limit backoff.

### Content pillars (fill the queue)
- **Tax season** (Jan–Jul): "STCG vs LTCG after 23-Jul-2024", "F&O is business income — here's the
  set-off", "dividend TDS above ₹5,000" — each ending in a soft CTA to the free calculator.
- **Leak of the week:** a real (anonymised) cost/margin-penalty/MTF leak example.
- **Feature spotlights:** 20-second screen clips (Greeks panel, payoff diagram, tax timeline).
- **Privacy angle:** "your journal shouldn't live on someone's server."
- **Indicator education** (careful — no accuracy/return claims; educational framing only).

## Engine 2 — Audience-Research Engine (list-building only, no auto-outreach)

### What it does
- Builds a **ranked list** of relevant finance accounts to engage **manually**.
- **Stops before any action** — it never replies, mentions, DMs, or follows automatically.

### Stack & method
- X API v2 search/user-lookup **within your tier's limits** (Free/Basic are tight — expect to work
  in small batches, or supplement with manual list-building from finance hashtags/lists).
- Pipeline: seed queries (cashtags like `$NIFTY`, `#optionstrading`, `#nifty50`, "F&O", "intraday")
  → collect authors → hydrate profiles → filter (followers > 500, India-relevant bio/timeframe,
  active recently) → **score** (relevance × recency × engagement) → export CSV.
- Output columns: `handle, followers, bio, last_active, sample_tweet, why_relevant, score`.

### How you use the list (the human part)
- Open the CSV, pick the top N, and **genuinely engage**: a real reply that adds value, a thoughtful
  quote-tweet, a follow. No copy-paste, no product link spraying. This is relationship-building, and
  it's what actually converts in fintwit.
- Optionally: identify 5–10 accounts/week for a **real DM** offering a free Toolkit license in
  exchange for honest feedback (influencer seeding) — sent by you, personally.

### Task breakdown
1. Seed-query config (cashtags/hashtags/keywords).
2. Collector within rate limits (batch + cache; respect 429 backoff).
3. Profile hydrate + filter (>500 followers, India signals, recent activity).
4. Scoring function (pure, testable): relevance + recency + engagement.
5. CSV export + a simple "engaged? / outcome" column you fill in manually.
6. **Explicit non-goal in code + README: no automated replies/mentions/DMs/follows.**

## Guardrails (bake these in)
- One account, your own; user-context auth only.
- Never auto-@mention or auto-DM non-consenting users.
- Respect rate limits with backoff; cache to avoid re-pulling.
- Keep an approval gate on all generated content.
- Secrets in env/secret store, never committed.
- Disclaimers on promotional posts; no accuracy/return claims on indicators (SEBI — see
  `MONETIZATION_PLAN.md` §5).

## Suggested build order
1. Engine 1 (content scheduler + your-account posting) — immediate, safe, drives launch.
2. Content queue filled with the tax-season + leak pillars.
3. Engine 2 (research → ranked CSV) — feeds your manual daily engagement habit.
4. Measure: track link clicks (UTM on the landing URL) → checkout starts → sales; double down on
   what converts.

## Non-negotiable
If you still want literal auto-mentions of strangers, that's a spam bot — I won't build it, and it
will get your account and product banned. The plan above reaches the same audience the durable way.
