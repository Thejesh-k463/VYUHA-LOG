/**
 * The Live Desk's SSE link — one connection's whole lifecycle, with every
 * browser edge INJECTED.
 *
 * WHY IT IS NOT IN THE COMPONENT. The link is state machine, not markup:
 * backoff spacing, "a hidden tab holds no stream", "stopped is terminal for
 * this connection", and the once-a-day reconnect across 15:30 IST are all
 * claims about behaviour over TIME. The vitest suite runs in `node` with no
 * DOM (`vitest.config.ts` — `environment: "node"`), so with the lifecycle
 * inside `tracker-client.tsx` the only thing a test could hold to account was
 * the SOURCE TEXT of the effect, which is how three of these rules were
 * asserted by regex and none of them by behaviour. Here they are driven with a
 * fake `EventSource` and fake timers (`tests/live-stream-link.test.ts`).
 *
 * NO DOM AND NO REACT IN THIS FILE. `createSource`, `isHidden`, the timers,
 * the paint scheduler and the clock all arrive through `StreamLinkEnv`, so
 * `EventSource`, `document` and `requestAnimationFrame` are named exactly once
 * in the product — in the component that owns the effect. The state the link
 * reports travels OUT through `onState`, never through a `setState` this
 * module holds (AGENTS.md: no setState in an effect keyed on other state).
 *
 * PURE HELPERS ONLY: it reuses `parseTickFrame` (`apply-ticks.ts`) for the wire
 * and `toIst` (`lib/domain/trading-day.ts`) for India's clock rather than
 * re-deriving either — a second copy of the +5:30 offset is exactly what
 * `tests/today-clock.test.ts` exists to prevent.
 */

import { toIst } from "@/lib/domain/trading-day";
import { parseTickFrame, type TickQuote } from "./apply-ticks";

/** What the desk knows about the SSE pipe. Never a claim about the prices. */
export type LinkPhase = "idle" | "connected" | "live" | "reconnecting" | "paused" | "stopped";

export interface LinkState {
  phase: LinkPhase;
  /** The provider's own sentence, when it sent one. */
  reason: string | null;
  /** `now()` of the last frame. null when nothing has arrived. */
  at: number | null;
}

export const LINK_IDLE: LinkState = { phase: "idle", reason: null, at: null };
export const LINK_PAUSED: LinkState = { phase: "paused", reason: null, at: null };

/**
 * First reconnect delay, in ms, doubling to `RECONNECT_STEPS`.
 *
 * Only for a stream the browser has GIVEN UP on (`readyState === CLOSED`).
 * While it is still CONNECTING the browser is retrying on the route's own
 * jittered `retry:` hint (2000–3500 ms, deliberately not a fixed 1 s so a
 * sidecar restart does not bring every desk back on one boundary), and a second
 * timer racing it would double the reconnect rate against a bridge that is
 * already struggling.
 */
export const RECONNECT_BASE_MS = 2_000;
/** 2 s, 4 s, 8 s, 16 s, then 16 s for ever. */
export const RECONNECT_STEPS = 4;

/**
 * How long a frame keeps the strip reading "Live" across a routine
 * re-establish, in ms. It is `HEARTBEAT_MS` in `app/api/live/stream/route.ts`.
 *
 * An SSE connection is re-established all the time — a proxy drops an idle
 * stream, a sidecar restarts — and the browser does it silently on the route's
 * own `retry:` hint. Flashing "Reconnecting…" on each of those would make a
 * healthy desk look broken. The route promises a heartbeat every 25 s, so while
 * the last frame is YOUNGER than that the pipe has proved itself inside its own
 * contract; past it, nothing has, and the strip says so.
 */
export const LIVE_GRACE_MS = 25_000;

/**
 * `EventSource.CONNECTING`. The value is fixed at 0 by the WHATWG spec, and it
 * is written out here so a fake source in a test means the same thing the
 * browser does without importing a DOM global into a node suite.
 */
export const SOURCE_CONNECTING = 0;

/**
 * Minutes past IST midnight at which an open desk re-establishes its stream
 * once, so the server's connect door writes the close-of-session mark.
 *
 * 15:31, not 15:30: `MARKET_CLOSE_MINUTE` (market-hours.ts) is INCLUSIVE of
 * 15:30, so a reconnect at exactly the close would race the last minute of the
 * session it is trying to close. One minute past it, the session is over by
 * the same definition the rest of the app uses.
 */
export const CLOSE_REOPEN_MINUTE = 15 * 60 + 31;

/**
 * Spread, in ms, added to that instant (owner ruling: "15:31:00 IST plus 0–5 s
 * jitter, once per IST day"). Every desk in a household reconnecting on one
 * boundary is the same thundering herd the route's own `retry:` hint jitters
 * away from.
 */
export const CLOSE_REOPEN_JITTER_MS = 5_000;

/**
 * The slice of `EventSource` this link uses. A fake with these three members is
 * indistinguishable from the real object as far as this file is concerned.
 */
export interface StreamSource {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

/** Every browser edge, injected. `T` is whatever the host's timer handle is. */
export interface StreamLinkEnv<T> {
  /** Real: `() => new EventSource("/api/live/stream")`. */
  createSource: () => StreamSource;
  /** Real: `() => document.visibilityState === "hidden"`. */
  isHidden: () => boolean;
  /** Real: `Date.now`. Read for frame ages AND for the IST close-of-session. */
  now: () => number;
  setTimer: (fn: () => void, ms: number) => T;
  clearTimer: (id: T) => void;
  /** Real: `requestAnimationFrame` — one React commit per paint. */
  schedulePaint: (fn: () => void) => number;
  cancelPaint: (id: number) => void;
  /** Real: `Math.random`. Only the close-of-session jitter reads it. */
  random: () => number;
  onState: (state: LinkState) => void;
  onQuotes: (quotes: TickQuote[]) => void;
}

export interface StreamLink {
  /** Open (or re-open) the stream. A no-op while the tab is hidden. */
  open(): void;
  /** Drop the transport and both timers. Re-openable. */
  close(): void;
  /** Say the tab put the feed down, rather than letting it read as a fault. */
  pause(): void;
  /** Close for good — no timer that has already been queued can re-open it. */
  destroy(): void;
}

/**
 * ms from `now` until today's close-of-session reconnect, or null when that
 * instant has already passed (or it is a weekend, when no session closes).
 *
 * Returning null past the instant is what makes the reconnect happen ONCE per
 * IST day without any day-keyed state: the link re-arms on every open, and
 * after the reconnect the answer for the rest of the day is null. A desk left
 * open across IST midnight therefore does not re-arm until its next reconnect —
 * deliberate, because the alternative is a timer that must survive a day
 * boundary in a tab nobody is looking at.
 */
export function msUntilCloseReopen(now: Date): number | null {
  const ist = toIst(now);
  const weekday = ist.getUTCDay();
  if (weekday === 0 || weekday === 6) return null; // no session to close
  const msPastMidnight =
    ((ist.getUTCHours() * 60 + ist.getUTCMinutes()) * 60 + ist.getUTCSeconds()) * 1_000 + ist.getUTCMilliseconds();
  const target = CLOSE_REOPEN_MINUTE * 60_000;
  return msPastMidnight >= target ? null : target - msPastMidnight;
}

/**
 * The identity of the stream the desk should be holding.
 *
 * `GET /api/live/stream` resolves `getSelectedAccountId()` and captures its
 * quote-key set ONCE per request (route.ts), so a connection outlives neither
 * an account switch nor a change to what the book holds. The account switcher
 * calls `router.refresh()` and the desk stays MOUNTED (there is no `key` on
 * `<TrackerClient>` in `app/live/page.tsx`, and there must not be — a key would
 * drop every in-memory tick and the keyboard focus on each switch), so the
 * effect has to notice by itself. This string is what it notices with.
 *
 * It carries the selected account AND the key set, because those are two
 * different ways to end up subscribed to the wrong symbols: the id alone
 * misses a position opened in another account while the aggregate view
 * (`selectedAccountId === 0`, invariant 9's "0 is a view") is selected.
 */
export function streamKeyOf(
  selectedAccountId: number,
  rows: readonly { accountId: number; exchange: string; tradingsymbol: string }[],
): string {
  const keys = new Set<string>();
  for (const r of rows) keys.add(`${r.accountId}:${r.exchange}:${r.tradingsymbol.toUpperCase()}`);
  return `${selectedAccountId}|${[...keys].sort().join(",")}`;
}

/**
 * The link state as the desk STORES it: the state, and the stream key it was
 * reported for.
 *
 * `onState` is a fact about ONE connection, and the desk outlives connections
 * — `<TrackerClient>` stays mounted across an account switch on purpose. So
 * the state has to carry the identity of the stream that produced it, or the
 * desk cannot tell "this is my stream's state" from "this is the state of the
 * stream I just tore down".
 */
export interface KeyedLinkState {
  key: string;
  state: LinkState;
}

/**
 * PURE. What the strip should show for `streamKey`, given what was last stored.
 *
 * G3 — THE STRIP KEPT THE OLD STREAM'S VERDICT ACROSS AN ACCOUNT SWITCH. The
 * desk's effect destroys the old link and opens a new one when `streamKey`
 * changes, but the React state still held the DEAD connection's last report,
 * and `open()` emits `LINK_IDLE` only out of `stopped`/`paused` — so after a
 * switch the strip went on printing `Live · openalgo · N s` (or "Feed stopped
 * — <the old account's reason>") until the new connection's first frame
 * landed, which outside market hours is up to 25 s and on a hidden tab is
 * never.
 *
 * DERIVED, NOT RESET IN AN EFFECT. Writing `setLink(LINK_IDLE)` from the
 * effect keyed on `streamKey` is exactly the pattern AGENTS.md forbids (it
 * broke the Trades filter outright under the React Compiler), and it would
 * also repaint once with the stale label before correcting itself. Asking the
 * question at RENDER time has neither problem: the instant the key changes,
 * the old stream's state stops being the answer.
 *
 * The alternative considered and rejected: having `open()` emit `LINK_IDLE`
 * for every fresh link. It leaves one painted frame with the dead stream's
 * label (the effect runs after commit), and it cannot fire at all when
 * `open()` refuses because the tab is hidden — which is precisely when the
 * stale label would sit on screen longest.
 */
export function linkStateFor(stored: KeyedLinkState, streamKey: string): LinkState {
  return stored.key === streamKey ? stored.state : LINK_IDLE;
}

/**
 * One link: open it, and it reports its own state until it is destroyed.
 *
 * THE PHASE RULES, all four of which shipped wrong in the first consumer:
 *
 *  - A frame that carries QUOTES is the only thing that makes the link "live".
 *    The route heartbeats every 25 s whether or not it ever subscribed — it
 *    does not subscribe at all outside 09:00–15:40 — so a heartbeat treated as
 *    a live frame printed `Live · openalgo · 3 s` at 21:00 with no poll
 *    running behind it. Heartbeat-only is `connected`, which says the pipe is
 *    open and claims nothing about prices.
 *  - `stopped` is TERMINAL for the connection that reported it. The route keeps
 *    heartbeating after it sends a named `error` frame, and each of those
 *    heartbeats used to overwrite "Feed stopped — <the provider's reason>" with
 *    "Live". Only a NEW connection clears it.
 *  - A hidden tab holds no stream, so `open()` refuses while hidden.
 *  - A browser that is still CONNECTING is already retrying; only a source the
 *    browser has given up on gets this module's own backoff.
 */
export function createStreamLink<T>(env: StreamLinkEnv<T>): StreamLink {
  let source: StreamSource | null = null;
  let retry = 0;
  let retryTimer: T | undefined;
  let closeReopenTimer: T | undefined;
  let paint = 0;
  let destroyed = false;
  let state: LinkState = LINK_IDLE;
  /** Quotes waiting for the next paint. The route already coalesces to 250 ms. */
  const pending: TickQuote[] = [];

  const setState = (next: LinkState) => {
    state = next;
    env.onState(next);
  };

  const flush = () => {
    paint = 0;
    if (pending.length === 0) return;
    env.onQuotes(pending.splice(0, pending.length));
  };
  /** One React commit per animation frame, however many frames arrived in it. */
  const schedule = () => {
    if (paint === 0) paint = env.schedulePaint(flush);
  };

  const clearRetry = () => {
    if (retryTimer !== undefined) {
      env.clearTimer(retryTimer);
      retryTimer = undefined;
    }
  };
  const clearCloseReopen = () => {
    if (closeReopenTimer !== undefined) {
      env.clearTimer(closeReopenTimer);
      closeReopenTimer = undefined;
    }
  };

  /** Drop the transport only — the phase is the caller's to decide. */
  const closeSource = () => {
    clearRetry();
    if (paint !== 0) {
      env.cancelPaint(paint);
      paint = 0;
    }
    source?.close();
    source = null;
  };

  const onFrame = (ev: Event) => {
    const data = (ev as MessageEvent<string>).data;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return; // one unreadable frame costs one frame, never the stream
    }
    const quotes = parseTickFrame(raw);
    if (quotes.length > 0) {
      pending.push(...quotes);
      schedule();
    }
    retry = 0;
    const at = env.now();
    if (state.phase === "stopped") {
      // Terminal: the heartbeat refreshes how old the last frame is and does
      // not touch the verdict the provider already gave for this connection.
      setState({ ...state, at });
      return;
    }
    // A snapshot is honest about the clock: outside 09:00–15:40 the route ships
    // the bridge's last prints beside `marketOpen: false` and never subscribes,
    // so those quotes are marks, not a live pipe. "Live" is earned only by a
    // quote-bearing frame the route sent while it was subscribed.
    const marketShut =
      raw !== null && typeof raw === "object" && (raw as { marketOpen?: unknown }).marketOpen === false;
    if (quotes.length > 0 && !marketShut) {
      setState({ phase: "live", reason: null, at });
      return;
    }
    // Heartbeat-only. A link that HAS been live stays live inside its grace —
    // that is what the heartbeat is for — and one that never carried a quote
    // says only that it is connected.
    setState({ phase: state.phase === "live" ? "live" : "connected", reason: null, at });
  };

  function onError(ev: Event) {
    // TWO DIFFERENT EVENTS ARRIVE HERE, and telling them apart is the whole of
    // this handler. The route sends a NAMED `error` frame when a provider
    // refuses to subscribe, and the EventSource spec dispatches a server-named
    // "error" event on the object itself — indistinguishable from the
    // connection failure except that one carries `data`.
    if (typeof (ev as MessageEvent<string>).data === "string") {
      let reason: string | null = null;
      try {
        const body = JSON.parse((ev as MessageEvent<string>).data) as { message?: unknown };
        reason = typeof body.message === "string" ? body.message : null;
      } catch {
        reason = null;
      }
      setState({ phase: "stopped", reason, at: env.now() });
      return;
    }
    if (source !== null && source.readyState === SOURCE_CONNECTING) {
      // The browser is already retrying, on the route's own jittered `retry:`
      // hint. Say so; do not race it with a second timer — and do not say it at
      // all for a routine re-establish inside the heartbeat window.
      if (state.at !== null && env.now() - state.at < LIVE_GRACE_MS) return;
      setState({ phase: "reconnecting", reason: null, at: state.at });
      return;
    }
    closeSource();
    retry = Math.min(retry + 1, RECONNECT_STEPS);
    setState({ phase: "reconnecting", reason: null, at: state.at });
    retryTimer = env.setTimer(open, RECONNECT_BASE_MS * 2 ** (retry - 1));
  }

  /**
   * Arm the once-a-day close-of-session reconnect (F3, owner-ruled).
   *
   * The mark for the day is written by the SERVER's connect door
   * (`app/api/live/stream/route.ts` → `lib/quotes/persist-mark.ts`), which only
   * runs when a stream connects. A desk that sat open all afternoon therefore
   * never crossed that door after the close, and the close-of-session mark was
   * whatever the last connect happened to catch. Re-establishing the stream
   * once, just after 15:30 IST, is the whole mechanism: no client writes.
   */
  const armCloseReopen = () => {
    clearCloseReopen();
    const wait = msUntilCloseReopen(new Date(env.now()));
    if (wait === null) return;
    closeReopenTimer = env.setTimer(() => {
      closeReopenTimer = undefined;
      open();
    }, wait + Math.floor(env.random() * CLOSE_REOPEN_JITTER_MS));
  };

  function open() {
    if (destroyed || env.isHidden()) return;
    closeSource();
    // A NEW connection is not the old one's verdict — and it is the only thing
    // that clears either terminal phase.
    if (state.phase === "stopped" || state.phase === "paused") setState(LINK_IDLE);
    const next = env.createSource();
    source = next;
    next.addEventListener("snapshot", onFrame);
    next.addEventListener("tick", onFrame);
    next.addEventListener("heartbeat", onFrame);
    next.addEventListener("error", onError);
    armCloseReopen();
  }

  return {
    open,
    close: () => {
      closeSource();
      clearCloseReopen();
    },
    pause: () => setState(LINK_PAUSED),
    destroy: () => {
      destroyed = true;
      closeSource();
      clearCloseReopen();
    },
  };
}
