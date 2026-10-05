// OPENALGO DISCLOSURE (PURE — data + one gate rule, no DB, no React).
//
// The OpenAlgo integration is the first thing in Vyuha that asks the user to
// run a SECOND piece of software and hand IT their broker credentials. That is
// a bigger ask than any import path, so it is off until the user reads what it
// is, what it does and what it costs them, and accepts explicitly.
//
// Everything the user is shown lives here, versioned, for three reasons:
//
//   1. The Settings card, the disclosure dialog and the Import panel all read
//      the SAME sentences — copy that is written twice drifts, and a risk
//      statement that drifts is worse than none (the import dropzone hint had
//      exactly this bug: two literal strings, five parsers, one wrong number).
//   2. The SERVER can apply the same gate the UI applies (`openAlgoGate`), so
//      hiding a button is never the only thing standing between an unread
//      disclosure and a live pull.
//   3. Consent is recorded against a VERSION. If the risks materially change,
//      bump `OPENALGO_DISCLOSURE_VERSION` and every install re-prompts instead
//      of inheriting an acceptance of an older, different statement.
//
// Voice rule, same as the rest of the product: state the refusals as design.
// Nothing here may claim accuracy the adapter does not deliver — the pull
// computes statutory charges, it does not receive them, and it covers one day.

// The streaming port is written ONCE, beside the address rules that use it
// (v4.7.0 C7, review R6 d). That module is client-safe (no `server-only`, no DB)
// and the Import card already ships it; tests/openalgo-stream-copy.test.ts pins
// that no other file under lib/ app/ components/ writes the number itself.
import { OPENALGO_WS_PORT } from "@/lib/import/api/openalgo";

/**
 * Bump ONLY when the risk statement materially changes — a typo fix is not a
 * new disclosure, a new risk is. Bumping re-prompts every install that had
 * accepted an older version, and until they accept, the gate is closed.
 *
 * "1" → "2" (v4.1): the same instance the user consented to for IMPORTING
 * trades now also PRICES the Live Desk — a repeating request every 1–5 s
 * instead of one the user presses. That is a materially different statement
 * about what runs and when, so every install re-acknowledges. `isAckCurrent()`
 * compares with `===`, so a stored "1" is refused with no extra code.
 *
 * "2" → "3" (v4.2): a sentence the user ACCEPTED became false. Version 2 told
 * them the automatic close-of-session mark refuses at the weekend and that
 * "exchange holidays are not modelled in this version" — so on a weekday the
 * exchange was shut, the previous session's price was written under the closed
 * day's date. v4.2 refuses that write from the bundled NSE holiday list
 * (since v4.6.0 `lib/data/market-calendar.json` → `isExchangeHoliday()`), which the user sees
 * in their own stored marks. THE RULE, restated for this bump: bump when the
 * risk statement materially changes, OR when a sentence already accepted stops
 * being true about what the app writes. A typo fix is still not a bump.
 *
 * "4" (v4.6.0 W1): the accepted item said the desk writes the close-of-session
 * mark at 15:31 IST. Since SEBI's Closing Auction Session (2026-08-03) an F&O
 * stock's official close is struck by 15:35, so the write moved to 15:36 (owner
 * ruling K3) — a sentence already accepted stopped being true about WHEN the
 * app writes to the journal, which is this rule's second arm.
 *
 * "4" amended BEFORE release (v4.6.0 W8, 2026-09-25): the version read, the
 * sandbox / old-release / exchange refusals and the MCX no-repair rule were
 * written into "4" rather than a "5", because no install has accepted "4" yet
 * (v4.5.0 ships "3") — a second number would only re-prompt nobody twice.
 * Once v4.6.0 is published, "4" is frozen and the rule above applies again.
 *
 * "4" → "5" (v4.7.0 wave C5, owner answers TG1/TG2, DECISIONS 2026-10-04): the
 * accepted cadence item said the requests run only while the Live Desk is open
 * and that "nothing polls in the background". With Telegram stop/target alerts
 * on (Pro), the alert check asks this same bridge for the open positions'
 * prices about once a minute during market hours while Vyuha is open on ANY
 * page, minimised included — a sentence already accepted stopped being true
 * about WHEN requests are made, and every account's alertable symbols now go
 * through the one connection the desk last used (design review R1,
 * `peekLiveFeedProvider()` in lib/quotes/registry.ts). THIS bump also closes
 * the OpenAlgo IMPORT pull until the user re-accepts — the import route applies
 * the same `openAlgoGate` (app/api/import/broker/route.ts,
 * `currentOpenAlgoGate()`) — so the release notes say so.
 *
 * "5" AMENDED before release (v4.7.0 wave C7, owner answers 2026-10-05,
 * DECISIONS "owner answers before v4.7.0 wave C7"), never bumped to "6" — the
 * D-6 precedent above: no install accepts "5" before v4.7.0 ships, so a second
 * number would re-prompt nobody twice. What changed in the text: in market
 * hours the desk now holds ONE WebSocket to the bridge
 * (lib/quotes/openalgo-stream.ts) and polls only the symbols that socket has
 * not answered for (item 2); the socket carries the key once per connection
 * and the same symbols (item 3); and it goes to the same machine as the saved
 * address, on OpenAlgo's WS port or the instance's own WS address (item 5).
 * The "ticks are never written" item is unchanged and still true — the socket
 * module has no database access. Once v4.7.0 is published, "5" is frozen.
 */
export const OPENALGO_DISCLOSURE_VERSION = "5";

/** Where the user gets OpenAlgo. Shown as text, never auto-opened. */
export const OPENALGO_SITE = "https://openalgo.in";
export const OPENALGO_DOCS = "https://docs.openalgo.in";

/** The default a fresh install offers — the loopback address OpenAlgo binds. */
export const OPENALGO_DEFAULT_HOST = "http://127.0.0.1:5000";

export interface DisclosureItem {
  title: string;
  body: string;
}

/** What OpenAlgo IS. Plain, and explicit that Vyuha did not write it. */
export const OPENALGO_WHAT_IT_IS: DisclosureItem[] = [
  {
    title: "It is separate software, not part of Vyuha",
    body:
      "OpenAlgo is an open-source (AGPL-3.0) server built by a third party. You install it, run it and update it yourself, usually on this same computer. Vyuha is not affiliated with it, does not ship it, and cannot support it.",
  },
  {
    title: "It speaks to your broker so Vyuha does not have to",
    body:
      // Broker names below corrected 2026-09-02 (Upstox native landed v2.99.104).
      // A FACTUAL correction to stale context, not a change to what the user
      // consents to — so the disclosure version deliberately does NOT bump.
      // v4.7.0 C6: the direct pulls named in full — amended, not bumped: "5" is
      // unreleased (introduced in C5) and the D-6 precedent amends before release.
      "One OpenAlgo instance is connected to one broker account. Vyuha then asks that instance for your executed trades over a normal web request to your own machine — the same shape as the pulls Vyuha already does directly from Zerodha, Dhan, Angel One, Upstox, Fyers, Kotak Neo and Nuvama.",
  },
  {
    title: "Why it is worth the trouble",
    body:
      // v4.6.0 W9: Fyers and Nuvama named — a FACTUAL correction (two brokers
      // joined the list), not a change to what the user consents to, so the
      // disclosure version is amended, never bumped, until v4.6.0 ships (D-6).
      // v4.7.0 C6: Fyers, Kotak Neo and Nuvama gained direct pulls (documented, not
      // yet verified) — amended inside the unreleased "5" (D-6), never bumped.
      "Vyuha has direct API pulls for Zerodha, Dhan, Angel One and Upstox, and for Fyers, Kotak Neo and Nuvama (documented, not yet verified with a real account). Through OpenAlgo, Groww, Paytm Money, Kotak and Fyers also get a same-day pull, with no broker-specific code. Sahi has neither an API nor an OpenAlgo plugin and stays on file import; Nuvama has no OpenAlgo plugin.",
  },
];

/** What a pull actually DOES, so nobody expects a backfill. */
export const OPENALGO_WHAT_IT_DOES: DisclosureItem[] = [
  {
    title: "Pulls today's executed trades, on demand",
    body:
      "Nothing runs on a schedule and nothing happens until you press Preview or Pull. The trades go through the same classify → charges → de-duplicate → commit pipeline as a file import, so pulling twice cannot double a trade.",
  },
  {
    title: "Preview first, always",
    body:
      "Preview shows what would be imported without writing anything. Commit is a second, separate press.",
  },
  {
    title: "Vyuha stores only the OpenAlgo key and host",
    body:
      "Both are encrypted at rest with a key bound to this machine, and both are revocable from OpenAlgo's own settings without touching your broker account. Vyuha never holds a broker token for these pulls.",
  },
];

/**
 * THE LIVE PRICE FEED (disclosure v2, v4.1). Kept as its own array rather than
 * folded into WHAT_IT_DOES because it is a second, separately-switched use of
 * the SAME instance: the pull is one request the user presses, this one runs on
 * its own while a screen is open — since v4.7.0 C7 a price stream in market
 * hours, plus a poll at the slider interval for whatever the stream has not
 * priced. The dialog renders it
 * under its own heading for that reason.
 *
 * Every sentence below is checked against the code that performs it, and the
 * line is cited beside it. Nothing here may describe behaviour the adapter does
 * not have — that is the same rule the pull items were written under.
 */
export const OPENALGO_FEED_ITEMS: DisclosureItem[] = [
  {
    title: "Live prices are a second switch, not part of the pull",
    body:
      // The desk's source is chosen in Settings → Live feed; the OpenAlgo
      // option exists there only once THIS disclosure is accepted and the
      // integration is on — `readGateFromDb()` applies `openAlgoGate` before a
      // single request (lib/quotes/openalgo.ts:156-162, inside
      // `readGateFromDb()`: the `settings` select through
      // `const gate = openAlgoGate({...})` / `if (!gate.allowed) return
      // { state: "disabled", ... }`).
      "The Live Desk prices your open positions from the end-of-day bhavcopy, or from marks you type, until you pick the OpenAlgo bridge as its source in Settings → Live feed. That choice is yours and reversible, and it is offered only while this disclosure is accepted and the integration is on.",
  },
  {
    title:
      "During market hours it holds one price stream while the Live Desk is open, and asks at your interval only for what the stream has not priced — and, with Telegram alerts on, about once a minute",
    body:
      // v "5" AMENDED (C7, design D1/D6/D10, owner answers Q2–Q4):
      // • ONE streaming connection per bridge: `createOpenAlgoStream()` in
      //   lib/quotes/openalgo-stream.ts, held by the memoised provider and
      //   opened lazily by the first `subscribe()` (never by `snapshot()` or
      //   `health()`), never outside `isWithinLiveWindow()`.
      // • "no streamed price for 30 seconds" = `STREAM_QUIET_MS` (30_000) in
      //   that file — `isQuiet()`; the provider's `pump()` in
      //   lib/quotes/openalgo.ts asks `/multiquotes` for the quiet keys ONLY,
      //   and for none when every key is fresh. "every symbol while the stream
      //   is unavailable": a closed / refused / not-yet-open socket leaves every
      //   key quiet, so the same rule polls them all.
      // • the slider interval: `clampRefreshSeconds()` (REFRESH_SECONDS_MIN /
      //   MAX), the `setInterval(() => void pump(true), periodMs)` in
      //   `subscribe()`; the 10 req/s ceiling: `RATE_LIMIT_PER_SECOND` through
      //   `createRateGuard()`, which REFUSES rather than queues.
      // • "stop when it closes or when its tab goes to the background": the
      //   desk's SSE stream closes on a hidden tab (S5a in
      //   tests/seams-v41-fix.test.ts) and app/api/live/stream/route.ts
      //   unsubscribes on abort; the poll stops with the last subscription.
      // • "at the end of the live window": the stream route's own window-end
      //   unsubscribe (`msUntilLiveWindowEnd()` → `windowTimer` in
      //   app/api/live/stream/route.ts, owner answer Q4), the same calendar
      //   answer `isWithinLiveWindow()` gives (`liveWindowOn()` in
      //   lib/domain/market-calendar.ts — its end is the latest official-close
      //   availability, 15:45 IST on a normal day).
      // • "within 30 seconds of the desk closing": `STREAM_CLOSE_GRACE_MS`
      //   (30_000) — zero held keys closes the socket after that grace, so a
      //   reload inside it reuses the connection without a fresh sign-in.
      // • "outside the live window … asks for the last prices once each time it
      //   connects": the route's unconditional `provider.snapshot(keys)` before
      //   its `send("snapshot", …)`; it subscribes only when `marketOpen`.
      // The Telegram sentence is unchanged from C5 (its one REST `snapshot()`
      // per run never reads the stream — design D9).
      //
      // v "5" (C5): the desk's poll is unchanged — it still starts and stops
      // v "5" (C5): the desk's poll is unchanged — it still starts and stops
      // with the desk and pauses on a hidden tab (S5a in
      // tests/seams-v41-fix.test.ts holds the client to that). What is NEW is
      // the alert check (`runTelegramAlerts()` in lib/jobs/telegram-alerts.ts,
      // POSTed by components/system/telegram-alert-runner.tsx from the root
      // layout): Pro + Telegram on + alerts on only, market hours only, about
      // once a minute (15 s while on /live — "more often"), ONE `snapshot()`
      // per run through `peekLiveFeedProvider()`, which keeps the cached
      // instance — the connection the desk last used — whatever account each
      // tab has selected (design review R1). The runner does NOT pause on
      // `visibilitychange` (owner answer TG2), so "nothing polls in the
      // background" became false and is gone.
      // Interval: `clampRefreshSeconds()` lib/quotes/openalgo.ts:59-71
      // (REFRESH_SECONDS_MIN/MAX/DEFAULT + `clampRefreshSeconds()`; 1–5 s,
      // default 3); since C7 the fallback asking is `pump()` on `pumpTimer`,
      // a `setInterval` started by the first `subscribe()` in
      // lib/quotes/openalgo.ts (`pumpTimer = setInterval(() => void pump(true),
      // periodMs)`) and cleared when the last subscription stops (`const stop:
      // Unsubscribe` → `clearInterval(pumpTimer)` once `subs` is empty, run on
      // the desk's `signal` abort). Ceiling: `RATE_LIMIT_PER_SECOND` = 10 in
      // that file, enforced by `createRateGuard()` in lib/quotes/rate-guard.ts
      // (re-exported by the adapter; its `take(now)` returns false past the
      // limit), which REFUSES rather than queues.
      "During market hours, while the Live Desk is open, the desk holds one streaming connection to your bridge and receives prices as they change. A symbol with no streamed price for 30 seconds — and every symbol while the stream is unavailable — is asked for the old way, at the interval you set on the slider in Settings → Live feed; anything outside 1 to 5 seconds is clamped to it in code, and Vyuha refuses more than 10 requests a second to your bridge whatever the slider says. The stream and the asking start when the Live Desk opens and stop when it closes or when its tab goes to the background, and at the end of the live window (about 15:45 IST on a normal day); the streaming connection itself closes within 30 seconds of the desk closing. Outside the live window nothing streams and nothing repeats: the desk asks for the last prices once each time it connects. Only if you turn on Telegram stop/target alerts (Pro), Vyuha also asks the bridge for the prices of your open positions about once a minute during market hours while Vyuha is open on any screen, minimised included (more often while the Live Desk is open). With more than one account, every account's checked symbols go through one bridge connection: the one already open, which is the one the Live Desk last used, or else the selected account's.",
  },
  {
    title: "Each request, and the stream, carries your symbols and nothing about your book",
    body:
      // v "5" AMENDED (C7, review R10): THE STREAM'S MESSAGES. On every new
      // connection the socket sends `{ action: "authenticate", api_key }` once
      // (the `send({ action: "authenticate", … })` in the socket's open handler,
      // lib/quotes/openalgo-stream.ts) — once PER CONNECTION, so a reconnect
      // signs in again; then `sendSubscription()` sends `{ action: "subscribe" |
      // "unsubscribe", symbols: [{ symbol, exchange }], mode: STREAM_MODE,
      // request_id }` with the SAME symbol strings the REST body carries. The
      // key appears in no other frame, log line or `health()` answer. The key
      // list is still the route's `openPositionKeys()`.
      //
      // The body is exactly `{ apikey, symbols: [{ symbol, exchange }] }` —
      // built at lib/quotes/openalgo.ts:357-361 (`snapshot()`: the
      // `keys.slice(0, …).map((k) => ({ symbol, exchange }))` through
      // `post(gate.creds, "multiquotes", { symbols }, signal)`) and serialised
      // at :325 (`post()` body: `JSON.stringify({ apikey: creds.apiKey,
      // ...extra })`). The key list is the OPEN positions of the selected
      // account and nothing else — `openPositionKeys()` in
      // app/api/live/stream/route.ts calls `positionKeys()` in
      // lib/live/position-keys.ts (the ONE key builder since C5), whose
      // `if (!t.isOpen) continue` is the `is_open` predicate, capped at
      // `MAX_POSITION_KEYS` (500) in that same file.
      // Identifiers, not line numbers: both moved in this wave. No quantity,
      // no average price, no stop, no P&L, no account id is in the body —
      // those columns are never read on this path.
      // v "5" (C5): the alert check sends the SAME body shape through the same
      // `snapshot()`, but its key list is every account's open positions that
      // can alert right now (a recorded stop / trailing stop / target, their
      // market trading — design review R8), built by the shared key builder;
      // still no quantity, price paid, stop or account name in the request.
      "One request holds your OpenAlgo API key and a list of the trading symbols and exchanges of the positions your book has open — at most 500 of them. The stream carries the same two things: your API key once per connection, in the message that signs it in, and the same symbols and exchanges in the messages that start and stop each symbol's prices. Your quantities, entry prices, stops, P&L and account names are in neither: the bridge is told which scrips to price, never how much of them you hold or what you paid.",
  },
  {
    title: "A /funds request and a version read when the feed is checked, and when the desk connects",
    body:
      // `health()` posts to `/funds` once per call — lib/quotes/openalgo.ts:450
      // (`await post(gate.creds, "funds", {})`) — and reads nothing out of the
      // answer except that it arrived, plus the round-trip in ms (:459-460,
      // `const latencyMs = Math.max(0, now() - started)` and the `{ ok: true,
      // state: "ok", latencyMs, … }` it returns). Only the feed makes it —
      // saving an import connection makes no network call (W8 removed the
      // import adapter's unused `/funds` check; the old wording said otherwise).
      // W8 adds ONE keyless GET /auth/app-info after the probe
      // (`readOpenAlgoVersion` in lib/import/api/openalgo.ts), whose only use is
      // the "older than 2.0.2.6" warning (`openAlgoFeedVersionWarning`).
      //
      // It is called from THREE places, not one: the connection check
      // (`provider.health()` in app/api/live/feed/route.ts) and the desk's
      // stream door (`provider.health()` in app/api/live/stream/route.ts, run
      // on every open and every reconnect) and the desk's server render
      // (`provider.health()` in components/live/load-desk.ts). The earlier wording said "once when
      // the feed is checked", which read as once per install.
      //
      // This item never bumped the version on its own: when it was widened
      // (under v "2") it was the same host, same key, nothing new sent and
      // nothing new kept — a wider statement of WHEN an already-disclosed
      // request is made is not a new risk (the bump rule in the version history
      // at the top of this file). OPENALGO_DISCLOSURE_VERSION is "5" today, for
      // the reasons that history lists — none of them this item.
      "Checking the connection calls OpenAlgo's /funds endpoint once, and the desk does the same each time it opens and each time its price stream reconnects. It is the cheapest call that proves both the address and the API key are right. Right after it, Vyuha reads OpenAlgo's version from /auth/app-info — a request that carries nothing, not even the key — so it can warn you when the bridge is too old to pull trades from. It is the same bridge the prices come from, and nothing further is sent. Vyuha keeps nothing from either answer — no balance is stored or shown — only that the bridge replied, how many milliseconds it took, and whether its version is new enough.",
  },
  {
    title: "The address is this computer unless you change it",
    body:
      // Default host OPENALGO_DEFAULT_HOST above; locality decided by
      // `isLocalOpenAlgoHost()` (this file), and the poll goes to
      // `normalizeHost(creds.host)` — lib/quotes/openalgo.ts:317-320
      // (`post()`: `const base = normalizeHost(creds.host)` and the single
      // `doFetch(`${base}/api/v1/${path}`, …)` it feeds). No other host is
      // reachable from that file.
      // v "5" (C5): the second clause gained the alert cadence, and the
      // Telegram path is named as a SEPARATE egress with its own disclosure —
      // a Telegram alert carries a symbol and its price to Telegram's Bot API,
      // which only lib/telegram/send.ts dials, never this adapter.
      // v "5" AMENDED (C7, owner answer D2'): THE STREAM'S ADDRESS. Its only
      // source is `openAlgoStreamUrl(host, wsUrl)` in lib/import/api/openalgo.ts
      // (pinned as the socket constructor's ONLY url source by
      // tests/egress-guard.test.ts): the saved host's own HOSTNAME on
      // `OPENALGO_WS_PORT`, or the streaming address saved on the connection,
      // which `normalizeOpenAlgoStreamUrl()` refuses unless its hostname equals
      // the bridge's or both hosts are loopback (scheme ws: / wss: only, no user
      // name or password). Loopback is `isLocalOpenAlgoHost()` (this file):
      // localhost, 127.0.0.0/8 and ::1 are one machine, while a LAN IP against
      // 127.0.0.1 stays refused (v4.7.0 release audit UJ-6, review R9). The
      // save route answers 400 with that reason. So "the same machine" is
      // enforced at save time and re-checked at connect time. An `https://`
      // bridge with no saved streaming address gets no stream (polling only).
      // `ws://` carries no TLS, exactly like the default `http://` REST host.
      "By default the feed talks to your own OpenAlgo at http://127.0.0.1:5000 — this machine talking to itself, so no symbol leaves it. The price stream goes to the same machine as the address you saved: to OpenAlgo's streaming port " +
      `${OPENALGO_WS_PORT}` +
      ", unless you enter that instance's streaming address (WEBSOCKET_URL in its .env) on the connection, and Vyuha refuses a streaming address on any other machine. Like the http:// address, a ws:// stream is not encrypted. If you enter another address, that list of symbols travels to that machine while the desk is open — over the stream in market hours, and at your interval for what the stream has not priced — and about once a minute during market hours while Telegram alerts are on. Vyuha adds no other host for prices, and no market-data provider of its own. A Telegram alert, if you turn those on, is a separate path with its own disclosure.",
  },
  {
    title: "Prices refresh on screen only — ticks are never written",
    body:
      // v "5" AMENDED (C7): STILL TRUE WITH THE STREAM. lib/quotes/openalgo-stream.ts
      // imports no database module — a streamed frame becomes a `Quote` in
      // `quoteFromStreamFrame()` and goes to `onTick` and nowhere else — and
      // the provider's `pump()` (its REST fallback) only delivers to the same
      // listeners. tests/openalgo-stream-copy.test.ts pins the absence of a DB
      // import in the stream module.
      // `subscribe()` writes nothing anywhere (lib/quotes/openalgo.ts,
      // `subscribe(keys, onTick, signal, onEnd)` — its `pump()` only delivers);
      // the single write is `lib/quotes/persist-mark.ts`, one row per position
      // per IST day into `mtm_prices`, idempotent twice over (its header, and
      // `settings.last_live_mark_date`, migration 0067). Wording deliberately
      // agrees with LIVE_FEED_COPY.staleness in
      // components/settings/live-feed-card.tsx:55-56, which is pinned by
      // tests/live-feed-copy.test.ts — two statements of one behaviour must not
      // drift, so tests/openalgo-disclosure.test.ts holds them together.
      //
      // THE TYPED-MARK RULE (fix wave 3). The typed writers — the risk dialog
      // and the equity page — now REPLACE the day's row for that symbol, so a
      // price the user types is always that day's mark: typed before the close
      // the automatic 15:31 write leaves it alone, typed after it replaces the
      // automatic one, and one row per symbol per IST day stays the contract.
      // Until this wave no user surface said what happens when the two meet,
      // and the sentence added here is the SAME sentence on all seven surfaces
      // (README.md, docs/client/README.md, docs/client/PRIVACY.md, the setup
      // guide §9, lib/domain/help-content.ts, LIVE_FEED_COPY.staleness and
      // this item), pinned across all of them by tests/live-feed-copy.test.ts.
      //
      // `OPENALGO_DISCLOSURE_VERSION` STAYED "2" for the sentence above (the
      // typed-price precedence rule, v4.1 fix wave 2): a local write rule about
      // which row of the user's own table wins, no new host, nothing new sent
      // or kept — re-prompting for it would have been teaching users to click
      // through a disclosure that had not changed in any way that concerns
      // them.
      //
      // The HOLIDAY clause below is why it is "3" in v4.2. This item used to
      // say "exchange holidays are not modelled in this version", so a person
      // accepted a statement that a weekday the exchange was shut still got a
      // mark from the last price the bridge gave. That is no longer true —
      // `shouldPersistMark()` refuses it with code "holiday" — and a consent
      // sentence that has become false about what is written to the journal is
      // a new version, not a copy fix (see the constant's own note).
      "Ticks are never written to your journal. One mark per position per day is saved — from the last price of the session, or from the price when you press Save today's mark, whichever comes first. Vyuha writes the close-of-session one itself: each position's mark is written once that day's official close is in — from 15:31 IST for most stocks, from 15:36 IST for F&O stocks, whose close is struck in the closing auction — when the desk connects: it reconnects its price stream once at 15:36 IST while it is open, or the mark is written the next time you open the desk that day. A price you type yourself is that day's mark: the automatic close-of-session mark does not overwrite it, and typing after the close replaces the automatic one; any bhavcopy applied for that day — the Auto-MTM job if you have switched it on, a file you drop or paste yourself, or the history backfill — replaces it with the exchange close. Whether a mark already exists is decided per symbol per IST day, so a second account's open positions get their own mark on the same day. On a weekend the button refuses — there is no session to close (a special weekend session the exchange announces, such as the Budget-day Sunday, is a session); on an exchange holiday it refuses for the same reason, from the NSE holiday list bundled with this release, so the previous session's price is never stored under a day the market was shut. Every figure derived from that mark is dated to the day it belongs to.",
  },
  {
    title: "Your broker's API session expires every day",
    body:
      // Softened, ATTRIBUTABLE wording only (owner ruling 2026-09-06): no
      // circular naming a regulator exists in this tree, so the claim is about
      // the broker and nothing else — the same sentence
      // components/settings/live-feed-card.tsx:41-42 (`LIVE_FEED_COPY
      // .dailyReauth`) carries, and tests/live-feed-copy.test.ts:105 (the
      // `not.toMatch` regulator ban on `dailyReauth`) keeps out of it.
      // `capabilities.requiresDailyAuth` (lib/quotes/openalgo.ts:93, in
      // OPENALGO_CAPABILITIES) is the flag; a failed poll is swallowed
      // (the bare `} catch {` in `pump()` whose only content is the comment
      // "one failed poll is not the end of the subscription", closing into
      // `} finally {`), and an expired broker session sends the stream no
      // frames, so the last price stays, labelled with its
      // own date by `stalenessLabel()` (the `<Badge>` inside `StalenessChip`,
      // components/live/tracker-client.tsx — grep the name, that file moves).
      "The broker session behind OpenAlgo expires every day and has to be signed in again at OpenAlgo's own screen; that is the broker's rule, not Vyuha's. Until it is, prices stop arriving — the desk keeps the last mark it had, labelled with the date it belongs to, rather than blanking or guessing.",
  },
];

/**
 * The risks. Every one of these is a real, observed property — the quantity
 * item is OpenAlgo's own documented sample response, not a hypothetical.
 */
export const OPENALGO_RISKS: DisclosureItem[] = [
  {
    title: "Your broker credentials go into OpenAlgo, not Vyuha",
    body:
      "To use this you give OpenAlgo your broker's API access. That is a second program holding the keys to your trading account, and its security is not something Vyuha can vouch for. Read its documentation and decide for yourself.",
  },
  {
    title: "Sizes can arrive as zero, and are repaired",
    body:
      "OpenAlgo's own documented response shows a filled trade with quantity 0. Vyuha recovers the size from trade value ÷ average price, counts every repair and tells you the count — and refuses any row it cannot recover rather than importing a zero-size trade. On MCX the trade value is not quantity × price, so a zero-size MCX row is refused, never repaired. Check repaired sizes against your contract note before you commit.",
  },
  {
    // v4.6.0 W8 — added while "4" was still unreleased, so it rides in "4"
    // (see the version note): every v4.5.0 install re-accepts "4" once anyway.
    title: "Old OpenAlgo releases, Analyzer mode and unpriceable exchanges are refused",
    body:
      "Before each pull Vyuha reads OpenAlgo's version from /auth/app-info — a request that carries nothing, not even your key. A release older than 2.0.2.6 is refused for every broker: older ones reported Groww fills above ₹100 at one hundredth of their price and Zerodha MCX sizes in contracts, and carry security holes since fixed. A tradebook answered from Analyzer (sandbox) mode holds simulated fills and is refused whole. Rows on an exchange Vyuha has no charges for — NSE commodities (NCO), NCDEX — are refused and named, never filed under another exchange.",
  },
  {
    title: "Charges are computed here, not stated by the API",
    body:
      "The response carries no charge breakdown, so Vyuha's own engine computes the statutory charges. A file import that carries the broker's own figures — Paytm Money's tradebook, Dhan's transaction report — remains the more accurate source for costs.",
  },
  {
    title: "Today only — this is not a backfill",
    body:
      "The endpoint returns the current trading day. History comes from file imports; a day you forget to pull cannot be pulled later.",
  },
  {
    title: "If OpenAlgo is not running, the pull fails",
    body:
      "There is no queue and no retry. Vyuha says it could not reach the host and nothing is imported.",
  },
  {
    title: "A non-local host sends your trade data off this machine",
    body:
      "The default address is this computer, so nothing leaves it. If you point Vyuha at another machine, your trade data travels to that machine — Vyuha will say so beside the field, but it cannot stop you.",
  },
];

/** Non-negotiable, stated so the offer is not read as more than it is. */
export const OPENALGO_REFUSALS: string[] = [
  "Vyuha does not install, update, configure or support OpenAlgo.",
  "Vyuha never places, modifies or cancels an order — this reads your executed trades and nothing else.",
  "Turning this off leaves your journal exactly as it is; imported trades stay.",
];

/** True when a stored acknowledgement covers the CURRENT disclosure. */
export function isAckCurrent(ackVersion: string | null | undefined): boolean {
  return typeof ackVersion === "string" && ackVersion === OPENALGO_DISCLOSURE_VERSION;
}

export interface OpenAlgoGateState {
  enabled: boolean;
  ackVersion: string | null | undefined;
}

export interface OpenAlgoGateResult {
  allowed: boolean;
  /** Why not, in the user's words — safe to show or return as an API message. */
  reason?: string;
}

/**
 * THE gate. Both halves must hold: the switch is on AND the acceptance covers
 * the disclosure as it reads today.
 *
 * Requiring both is what makes a restored backup safe. Consent columns are
 * machine state (SETTINGS_MACHINE_COLUMNS), so a restore leaves this closed —
 * and if a future change ever let `enabled` travel, an unaccepted install
 * would still be refused here rather than pulling on someone else's consent.
 */
export function openAlgoGate(state: OpenAlgoGateState): OpenAlgoGateResult {
  if (!state.enabled) {
    return {
      allowed: false,
      reason: "The OpenAlgo integration is off. Turn it on in Settings → Integrations after reading what it does.",
    };
  }
  if (!isAckCurrent(state.ackVersion)) {
    return {
      allowed: false,
      reason:
        "The OpenAlgo disclosure has changed since you accepted it. Open Settings → Integrations and read it again to continue.",
    };
  }
  return { allowed: true };
}

/**
 * Is this host on this machine? Drives the warning beside the host field.
 *
 * Deliberately conservative: anything that is not plainly loopback counts as
 * remote, including a LAN IP. Over-warning costs a sentence; under-warning
 * would let "nothing leaves your computer" become false without anyone saying
 * so, and that promise is the product.
 */
export function isLocalOpenAlgoHost(host: string): boolean {
  const raw = String(host ?? "").trim();
  if (!raw) return false;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}
