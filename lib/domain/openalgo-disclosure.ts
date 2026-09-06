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
 */
export const OPENALGO_DISCLOSURE_VERSION = "2";

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
      "One OpenAlgo instance is connected to one broker account. Vyuha then asks that instance for your executed trades over a normal web request to your own machine — the same shape as the Zerodha, Dhan, Angel One and Upstox pulls Vyuha already does directly.",
  },
  {
    title: "Why it is worth the trouble",
    body:
      "Vyuha has direct API pulls for Zerodha, Dhan, Angel One and Upstox only. Through OpenAlgo, Groww, Paytm Money and Kotak also get a same-day pull, with no broker-specific code. Sahi has no OpenAlgo plugin and stays on file import.",
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
 * the SAME instance: the pull is one request the user presses, this one repeats
 * every few seconds on its own while a screen is open. The dialog renders it
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
    title: "It asks every 1 to 5 seconds, while the Live Desk is open",
    body:
      // Interval: `clampRefreshSeconds()` lib/quotes/openalgo.ts:59-71
      // (REFRESH_SECONDS_MIN/MAX/DEFAULT + `clampRefreshSeconds()`; 1–5 s,
      // default 3); the poll is a `setInterval` started by `subscribe()`
      // (lib/quotes/openalgo.ts:419, `const timer = setInterval(() => void
      // poll(), periodMs)`) and cleared when the desk's stream closes
      // (:420-427, `const stop: Unsubscribe` → `clearInterval(timer)` on the
      // `signal` abort). Ceiling: RATE_LIMIT_PER_SECOND = 10 (:64), enforced
      // by `createRateGuard()` (:290-300, whose `take(now)` returns false past
      // the limit), which REFUSES rather than queues.
      "You set the interval on the slider in Settings → Live feed; anything outside 1 to 5 seconds is clamped to it in code. The requests start when the Live Desk opens and stop when it closes or when its tab goes to the background — nothing polls in the background — and Vyuha refuses more than 10 requests a second to your bridge whatever the slider says.",
  },
  {
    title: "Each request carries your symbols, and nothing about your book",
    body:
      // The body is exactly `{ apikey, symbols: [{ symbol, exchange }] }` —
      // built at lib/quotes/openalgo.ts:357-361 (`snapshot()`: the
      // `keys.slice(0, …).map((k) => ({ symbol, exchange }))` through
      // `post(gate.creds, "multiquotes", { symbols }, signal)`) and serialised
      // at :325 (`post()` body: `JSON.stringify({ apikey: creds.apiKey,
      // ...extra })`). The key list is the OPEN positions of the selected
      // account and nothing else — `openPositionKeys()` in
      // app/api/live/stream/route.ts, whose `if (!t.isOpen) continue` is the
      // `is_open` predicate, capped at `MAX_KEYS` (500) in that same file.
      // Identifiers, not line numbers: both moved in this wave. No quantity,
      // no average price, no stop, no P&L, no account id is in the body —
      // those columns are never read on this path.
      "One request holds your OpenAlgo API key and a list of the trading symbols and exchanges of the positions your book has open — at most 500 of them. Your quantities, entry prices, stops, P&L and account names are not in it: the bridge is told which scrips to price, never how much of them you hold or what you paid.",
  },
  {
    title: "A /funds request when the feed is checked, and when the desk connects",
    body:
      // `health()` posts to `/funds` once per call — lib/quotes/openalgo.ts:450
      // (`await post(gate.creds, "funds", {})`) — and reads nothing out of the
      // answer except that it arrived, plus the round-trip in ms (:459-460,
      // `const latencyMs = Math.max(0, now() - started)` and the `{ ok: true,
      // state: "ok", latencyMs, … }` it returns). The same probe the import
      // path's save step uses.
      //
      // It is called from THREE places, not one: the connection check
      // (`provider.health()` in app/api/live/feed/route.ts) and the desk's
      // stream door (`provider.health()` in app/api/live/stream/route.ts, run
      // on every open and every reconnect) and the desk's server render
      // (`provider.health()` in components/live/load-desk.ts). The earlier wording said "once when
      // the feed is checked", which read as once per install.
      //
      // OPENALGO_DISCLOSURE_VERSION stays "2": same host, same key, nothing new
      // sent and nothing new kept — a wider statement of WHEN an already-
      // disclosed request is made is not a new risk (see the rule above :25-28).
      "Checking the connection calls OpenAlgo's /funds endpoint once, and the desk does the same each time it opens and each time its price stream reconnects. It is the cheapest call that proves both the address and the API key are right. It is the same bridge and the same key the prices come from, and nothing further is sent. Vyuha keeps nothing from the answer — no balance is stored or shown — only that the bridge replied, and how many milliseconds it took.",
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
      "By default the feed talks to your own OpenAlgo at http://127.0.0.1:5000 — this machine talking to itself, so no symbol leaves it. If you enter another address, that list of symbols travels to that machine every few seconds while the desk is open. Vyuha adds no other host for prices, and no market-data provider of its own.",
  },
  {
    title: "Prices refresh on screen only — ticks are never written",
    body:
      // `subscribe()` writes nothing anywhere (lib/quotes/openalgo.ts:392-428,
      // `subscribe(keys, onTick, signal)` — its `poll()` only calls `onTick`);
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
      // `OPENALGO_DISCLOSURE_VERSION` STAYS "2". Under the rule at :25-28 the
      // bump is for a materially different RISK: this is a local write rule
      // about which row of the user's own table wins, on the machine the app
      // already runs on. No new host is contacted, nothing new is sent to the
      // bridge and nothing new is kept from it — so re-prompting every install
      // would be teaching them to click through a disclosure that has not
      // changed in any way that concerns them.
      "Ticks are never written to your journal. One mark per position per day is saved — from the last price of the session, or from the price when you press Save today's mark, whichever comes first. Vyuha writes the close-of-session one itself: the desk reconnects its price stream once at 15:31 IST while it is open and the mark is written then, or the next time you open the desk that day. A price you type yourself is that day's mark: the automatic close-of-session mark does not overwrite it, and typing after the close replaces the automatic one; only the Auto-MTM bhavcopy job, if you keep it on, replaces it with the exchange close after 7 pm IST. Whether a mark already exists is decided per symbol per IST day, so a second account's open positions get their own mark on the same day. On a weekend the button refuses — there is no session to close; exchange holidays are not modelled in this version. Every figure derived from that mark is dated to the day it belongs to.",
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
      // (:412-414, the bare `} catch {` in `poll()` whose only content is the
      // comment "one failed poll is not the end of the subscription", closing
      // into `} finally {`), so the last price stays, labelled with its
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
      "OpenAlgo's own documented response shows a filled trade with quantity 0. Vyuha recovers the size from trade value ÷ average price, counts every repair and tells you the count — and refuses any row it cannot recover rather than importing a zero-size trade. Check repaired sizes against your contract note before you commit.",
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
