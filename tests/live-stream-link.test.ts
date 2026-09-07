import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_REOPEN_JITTER_MS,
  LIVE_GRACE_MS,
  RECONNECT_BASE_MS,
  SOURCE_CONNECTING,
  LINK_IDLE,
  createStreamLink,
  linkStateFor,
  msUntilCloseReopen,
  streamKeyOf,
  type LinkState,
  type StreamSource,
} from "@/lib/live/stream-link";
import type { TickQuote } from "@/lib/live/apply-ticks";

/**
 * The Live Desk's SSE link, driven as BEHAVIOUR.
 *
 * WHY THIS FILE EXISTS. Backoff spacing, the hidden-tab release, the unmount
 * teardown and "stopped is terminal" were all asserted by SOURCE REGEX against
 * `tracker-client.tsx` — `expect(src).toMatch(/RECONNECT_BASE_MS \* 2 \*\* …/)`
 * is satisfied by a line that is never reached, and three of the six findings
 * this wave fixes were live under exactly those green regexes. The suite runs
 * in node with no DOM (`vitest.config.ts`), so the lifecycle was extracted to
 * `lib/live/stream-link.ts` with its browser edges injected, and every rule
 * below is now driven through a fake `EventSource` and fake timers.
 *
 * THE CLOCK IS PINNED IST, always. `msUntilCloseReopen` is a statement about
 * India's afternoon; a test that read the machine's clock would pass in
 * Bengaluru and fail on a CI box in UTC — which is the trap
 * `lib/domain/trading-day.ts` was written against.
 */

/** 2026-09-07 is a MONDAY. IST = UTC+5:30, so 15:29 IST is 09:59 UTC. */
const IST_1529 = "2026-09-07T09:59:00.000Z";
/** The same Monday at 16:00 IST — the session is over, nothing to schedule. */
const IST_1600 = "2026-09-07T10:30:00.000Z";
/** 2026-09-05 is a SATURDAY, 15:29 IST. */
const SAT_1529 = "2026-09-05T09:59:00.000Z";

/** ms from 15:29:00 to 15:31:00 IST. */
const TO_CLOSE_REOPEN = 2 * 60_000;

/** One quote in the shape `app/api/live/stream/route.ts` sends it. */
const QUOTE = {
  key: { symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS" },
  ltp: 250_000,
  prevClose: 249_000,
  asOf: "2026-09-07T09:59:00.000Z",
  staleness: "delayed",
};

/**
 * The three members of `EventSource` the link uses, and nothing else.
 *
 * `readyState` is settable here because the browser's own transition to CLOSED
 * is exactly what tells `onError` apart: a source the browser is still
 * retrying (CONNECTING) must NOT get a second backoff timer racing it.
 */
class FakeSource implements StreamSource {
  readyState = 1; // OPEN
  closed = 0;
  private readonly listeners = new Map<string, ((ev: Event) => void)[]>();

  addEventListener(type: string, listener: (ev: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.readyState = 2; // CLOSED
    this.closed += 1;
  }

  /** A named frame. `data` omitted = the spec's own connection-failure event. */
  emit(type: string, data?: unknown): void {
    const ev = (data === undefined ? {} : { data: JSON.stringify(data) }) as unknown as Event;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

function harness(at: string, opts: { hidden?: boolean; random?: number } = {}) {
  vi.setSystemTime(new Date(at));
  const sources: FakeSource[] = [];
  const states: LinkState[] = [];
  const batches: TickQuote[][] = [];
  const paints: (() => void)[] = [];
  let hidden = opts.hidden ?? false;

  const link = createStreamLink<ReturnType<typeof setTimeout>>({
    createSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    isHidden: () => hidden,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
    schedulePaint: (fn) => {
      paints.push(fn);
      return paints.length;
    },
    cancelPaint: () => {},
    random: () => opts.random ?? 0,
    onState: (s) => states.push(s),
    onQuotes: (q) => batches.push(q),
  });

  return {
    link,
    sources,
    states,
    batches,
    paint: () => {
      for (const fn of paints.splice(0, paints.length)) fn();
    },
    phase: () => states.at(-1)?.phase ?? null,
    last: () => states.at(-1) ?? null,
    setHidden: (v: boolean) => {
      hidden = v;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ────────────────────────── F9 — the lifecycle ────────────────────────── */

describe("the link's lifecycle, driven rather than grepped (F9)", () => {
  it("backs off 2 s, 4 s, 8 s on a source the browser has given up on", () => {
    const h = harness(IST_1600); // past 15:31 — no close-of-session timer in play
    h.link.open();
    expect(h.sources).toHaveLength(1);

    for (const [step, delay] of [
      [0, RECONNECT_BASE_MS],
      [1, RECONNECT_BASE_MS * 2],
      [2, RECONNECT_BASE_MS * 4],
    ] as const) {
      const dead = h.sources[step];
      dead.readyState = 2; // CLOSED
      dead.emit("error");
      expect(dead.closed, "the link must close the source it gave up on").toBe(1);
      expect(h.phase()).toBe("reconnecting");
      vi.advanceTimersByTime(delay - 1);
      expect(h.sources, `reconnected before ${delay} ms`).toHaveLength(step + 1);
      vi.advanceTimersByTime(1);
      expect(h.sources, `no reconnect at ${delay} ms`).toHaveLength(step + 2);
    }
  });

  it("leaves a source the browser is STILL retrying alone — no second timer", () => {
    const h = harness(IST_1600);
    h.link.open();
    const s = h.sources[0];
    s.emit("snapshot", { quotes: [QUOTE] });
    // Past the heartbeat window, so the strip is allowed to say "Reconnecting…".
    vi.advanceTimersByTime(LIVE_GRACE_MS + 1);
    s.readyState = SOURCE_CONNECTING;
    s.emit("error");
    expect(h.phase()).toBe("reconnecting");
    expect(s.closed, "the browser's own retry was cancelled").toBe(0);
    expect(vi.getTimerCount(), "a second timer would double the reconnect rate").toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(h.sources).toHaveLength(1);
  });

  it("holds no stream while the tab is hidden, and opens one when it comes back", () => {
    const h = harness(IST_1600, { hidden: true });
    h.link.open();
    expect(h.sources, "a hidden tab must hold no stream").toHaveLength(0);
    h.setHidden(false);
    h.link.open();
    expect(h.sources).toHaveLength(1);

    h.link.close();
    expect(h.sources[0].closed).toBe(1);
    h.link.pause();
    expect(h.phase()).toBe("paused");
  });

  it("leaves nothing running on unmount — no source, no timer", () => {
    const h = harness(IST_1529);
    h.link.open();
    h.sources[0].readyState = 2;
    h.sources[0].emit("error"); // arms the backoff timer
    expect(vi.getTimerCount(), "the backoff and close-of-session timers are pending").toBeGreaterThan(0);

    h.link.destroy();
    expect(h.sources[0].closed).toBeGreaterThan(0);
    expect(vi.getTimerCount(), "a timer outliving the desk re-opens a stream nobody is looking at").toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(h.sources, "a destroyed link re-opened itself").toHaveLength(1);
  });
});

/* ───────────────── F6 — what the link may call "Live" ───────────────── */

describe("the phase is a claim about the pipe, and it is earned (F6)", () => {
  it("a heartbeat-only link is CONNECTED, never live", () => {
    const h = harness(IST_1600);
    h.link.open();
    h.sources[0].emit("heartbeat", { t: 1 });
    expect(h.phase(), "the route heartbeats without ever subscribing outside 09:00–15:40").toBe("connected");

    h.sources[0].emit("snapshot", { quotes: [QUOTE] });
    expect(h.phase()).toBe("live");
    h.paint();
    expect(h.batches.flat()).toHaveLength(1);

    // …and once a quote HAS arrived, the heartbeat is what keeps it live.
    h.sources[0].emit("heartbeat", { t: 2 });
    expect(h.phase()).toBe("live");
  });

  /**
   * G4 — THE AFTER-HOURS SNAPSHOT DELIVERS ITS QUOTES AND IS STILL NOT LIVE.
   *
   * The route snapshots unconditionally, so outside 09:00–15:40 it ships the
   * bridge's last prints beside `marketOpen: false` and never subscribes. Two
   * things are true of that frame at once, and the strip's copy has to survive
   * both: the phase is `connected` (nothing is streaming), AND the quotes it
   * carried DID reach the rows — `onFrame` pushes them before it reads
   * `marketOpen`. That is why `LIVE_STREAM_COPY.connected` states the absence
   * of a STREAM and no longer said "no prices yet", which was printed beside
   * the prices that same frame had just delivered.
   */
  it("an after-hours snapshot is CONNECTED and still hands its quotes to the rows", () => {
    const h = harness(IST_1600);
    h.link.open();
    h.sources[0].emit("snapshot", { marketOpen: false, quotes: [QUOTE] });

    expect(h.phase(), "no subscription is running, so nothing is streaming").toBe("connected");
    h.paint();
    expect(h.batches.flat(), "the frame's quotes were dropped on the floor").toHaveLength(1);
    expect(h.batches.flat()[0].ltp).toBe(QUOTE.ltp);
    h.link.destroy();
  });

  it("a stopped feed stays stopped, however long the route keeps heartbeating", () => {
    const h = harness(IST_1600);
    h.link.open();
    h.sources[0].emit("error", { message: "OpenAlgo is not answering." });
    expect(h.last()).toMatchObject({ phase: "stopped", reason: "OpenAlgo is not answering." });

    for (let i = 0; i < 3; i += 1) h.sources[0].emit("heartbeat", { t: i });
    expect(h.phase(), "a heartbeat overwrote the provider's own verdict").toBe("stopped");
    expect(h.last()?.reason).toBe("OpenAlgo is not answering.");
    // It refreshes HOW OLD the last frame is, and nothing else.
    expect(h.last()?.at).toBe(Date.now());
  });

  it("a NEW connection is the one thing that clears it", () => {
    const h = harness(IST_1600);
    h.link.open();
    h.sources[0].emit("error", { message: "OpenAlgo is not answering." });
    expect(h.phase()).toBe("stopped");
    h.link.open();
    expect(h.phase()).toBe("idle");
  });
});

/* ────────────── F3 — the close-of-session reconnect (owner-ruled) ────────────── */

describe("an open desk re-establishes its stream once, just after the close (F3)", () => {
  it("says how long until 15:31 IST, and null once it has passed", () => {
    expect(msUntilCloseReopen(new Date(IST_1529))).toBe(TO_CLOSE_REOPEN);
    expect(msUntilCloseReopen(new Date("2026-09-07T10:01:00.000Z")), "15:31:00 exactly").toBeNull();
    expect(msUntilCloseReopen(new Date(IST_1600))).toBeNull();
    expect(msUntilCloseReopen(new Date(SAT_1529)), "no session closes on a Saturday").toBeNull();
    // …nor on a listed exchange holiday (F1, v4.2). 2026-10-02 is a FRIDAY —
    // Gandhi Jayanti — so the weekday rule alone armed a reconnect for a mark
    // the server now refuses and a stream the route will not subscribe.
    expect(
      msUntilCloseReopen(new Date("2026-10-02T09:59:00.000Z")),
      "no session closes on an exchange holiday",
    ).toBeNull();
    // The weekday either side of it is untouched: 2026-10-01 at 15:29 IST.
    expect(msUntilCloseReopen(new Date("2026-10-01T09:59:00.000Z"))).toBe(TO_CLOSE_REOPEN);
    // 09:00 IST — the whole session away.
    expect(msUntilCloseReopen(new Date("2026-09-07T03:30:00.000Z"))).toBe((15 * 60 + 31 - 9 * 60) * 60_000);
  });

  it("mounted at 15:29, it closes and re-opens exactly once at 15:31", () => {
    const h = harness(IST_1529);
    h.link.open();
    expect(h.sources).toHaveLength(1);

    vi.advanceTimersByTime(TO_CLOSE_REOPEN - 1);
    expect(h.sources, "it reconnected before the close").toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sources, "the connect door never ran, so no close-of-session mark is written").toHaveLength(2);
    expect(h.sources[0].closed, "the old stream was left open").toBe(1);

    // ONCE per IST day: the rest of the afternoon adds nothing.
    vi.advanceTimersByTime(6 * 60 * 60_000);
    expect(h.sources).toHaveLength(2);
    h.link.destroy();
  });

  it("spreads the reconnect over 0–5 s, so every desk does not land on one boundary", () => {
    const h = harness(IST_1529, { random: 0.9 });
    h.link.open();
    vi.advanceTimersByTime(TO_CLOSE_REOPEN);
    expect(h.sources, "the jitter was not applied").toHaveLength(1);
    vi.advanceTimersByTime(CLOSE_REOPEN_JITTER_MS);
    expect(h.sources).toHaveLength(2);
    h.link.destroy();
  });

  it("mounted at 16:00 it schedules nothing — the connect door has already run", () => {
    const h = harness(IST_1600);
    h.link.open();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(h.sources).toHaveLength(1);
    h.link.destroy();
  });

  it("a hidden tab opens nothing at 15:31, and opens when it comes back", () => {
    const h = harness(IST_1529);
    h.link.open();
    h.setHidden(true);
    vi.advanceTimersByTime(TO_CLOSE_REOPEN);
    expect(h.sources, "a hidden tab must hold no stream, at 15:31 like any other minute").toHaveLength(1);
    h.setHidden(false);
    h.link.open();
    expect(h.sources).toHaveLength(2);
    h.link.destroy();
  });
});

/* ─────────── F4 — the stream's identity, so an account switch is seen ─────────── */

describe("the stream key names the account AND the book it subscribed to (F4)", () => {
  const row = (accountId: number, tradingsymbol: string, exchange = "NSE") => ({ accountId, tradingsymbol, exchange });

  it("changes when the selected account changes", () => {
    const rows = [row(1, "TCS"), row(1, "INFY")];
    expect(streamKeyOf(1, rows)).not.toBe(streamKeyOf(2, rows));
    expect(streamKeyOf(0, rows), "0 is the aggregate VIEW, and a different subscription").not.toBe(
      streamKeyOf(1, rows),
    );
  });

  it("changes when the aggregate view gains a position in another account", () => {
    // The id alone cannot see this: `selectedAccountId` is 0 on both sides.
    const before = streamKeyOf(0, [row(1, "TCS")]);
    const after = streamKeyOf(0, [row(1, "TCS"), row(2, "INFY")]);
    expect(after).not.toBe(before);
  });

  it("changes when the same account's symbols change, exchange included", () => {
    expect(streamKeyOf(1, [row(1, "TCS")])).not.toBe(streamKeyOf(1, [row(1, "INFY")]));
    expect(streamKeyOf(1, [row(1, "TCS", "NSE")])).not.toBe(streamKeyOf(1, [row(1, "TCS", "BSE")]));
  });

  /**
   * G3 — the strip must not keep the OLD stream's verdict across a switch.
   *
   * Two real links are driven here, one per account, exactly as the desk's
   * effect creates them: the first reports its state, the switch changes the
   * key, and what the strip shows is asked of `linkStateFor()` — the same pure
   * function `tracker-client.tsx` calls at render. Before the fix the desk
   * stored a bare `LinkState`, so the answer was the dead connection's.
   */
  it("drops the old stream's state the instant the key changes (G3)", () => {
    const KEY_A = streamKeyOf(1, [row(1, "TCS")]);
    const KEY_B = streamKeyOf(2, [row(2, "INFY")]);
    expect(KEY_A).not.toBe(KEY_B);

    // The desk's own state: whatever the live link last reported, and for whom.
    let stored = { key: KEY_A, state: LINK_IDLE };

    // Account A's stream, live with prices.
    const a = harness(IST_1600);
    a.link.open();
    a.sources[0].emit("snapshot", { quotes: [QUOTE] });
    stored = { key: KEY_A, state: a.last()! };
    expect(stored.state.phase).toBe("live");
    expect(linkStateFor(stored, KEY_A).phase, "its own stream's state is its own").toBe("live");

    // …the account switch. The desk stays MOUNTED and the effect re-runs; the
    // strip must not go on saying "Live · openalgo · N s" for a stream that
    // has been destroyed.
    expect(linkStateFor(stored, KEY_B)).toBe(LINK_IDLE);
    a.link.destroy();

    // Account B's stream reports, and only then does the strip say anything.
    const b = harness(IST_1600);
    b.link.open();
    b.sources[0].emit("heartbeat", { t: 1 });
    stored = { key: KEY_B, state: b.last()! };
    expect(linkStateFor(stored, KEY_B).phase).toBe("connected");
    b.link.destroy();
  });

  it("drops a TERMINAL verdict too — the old account's reason is not the new one's (G3)", () => {
    const KEY_A = streamKeyOf(1, [row(1, "TCS")]);
    const KEY_B = streamKeyOf(2, [row(2, "INFY")]);

    const a = harness(IST_1600);
    a.link.open();
    a.sources[0].emit("error", { message: "The bridge is not logged in for today." });
    const stored = { key: KEY_A, state: a.last()! };
    expect(stored.state).toMatchObject({ phase: "stopped", reason: "The bridge is not logged in for today." });

    // `stopped` is terminal for its OWN connection, and `open()` clears it
    // only on a link that has one — which the new stream's link does not, so
    // nothing but the key can answer this.
    const shown = linkStateFor(stored, KEY_B);
    expect(shown.phase, "the strip carried the old account's Feed stopped").toBe("idle");
    expect(shown.reason).toBeNull();
    a.link.destroy();
  });

  it("does NOT change when the same book arrives in a different order", () => {
    // The desk re-sorts on every tick (`unrealisedP` DESC), and the server's
    // own order is not a contract. A key that moved with it would tear the
    // stream down several times a second.
    expect(streamKeyOf(1, [row(1, "TCS"), row(1, "INFY")])).toBe(streamKeyOf(1, [row(1, "INFY"), row(1, "TCS")]));
    expect(streamKeyOf(1, [row(1, "TCS"), row(1, "TCS")])).toBe(streamKeyOf(1, [row(1, "TCS")]));
  });
});
