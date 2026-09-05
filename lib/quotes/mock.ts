/**
 * MockProvider — a deterministic seeded walk, and the ONLY provider vitest and
 * e2e ever see (03D §1.2). No DB, no network, no wall clock unless you let it
 * have one: `now` and `schedule` are injectable so a test can drive ticks with
 * fake timers and assert exact prices.
 *
 * Determinism is the whole point: two providers built with the same seed emit
 * the same series for the same keys, so a chart snapshot or an SSE frame can
 * be asserted byte for byte.
 */
import {
  quoteKeyId,
  type ProviderCapabilities,
  type ProviderHealth,
  type Quote,
  type QuoteKey,
  type QuoteMap,
  type QuoteProvider,
  type TickListener,
  type Unsubscribe,
} from "./types";

export interface MockProviderOptions {
  /** Same seed ⇒ same prices. */
  seed?: number;
  /** Milliseconds between emitted ticks while subscribed. */
  intervalMs?: number;
  /** Injected clock — only used to stamp `asOf`. */
  now?: () => number;
  /** Injected scheduler; returns its own cancel. Default: setInterval. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  id: "mock",
  label: "Mock feed (testing only)",
  streaming: true,
  maxSubscriptions: 500,
  minSnapshotIntervalMs: 0,
  depth: 0,
  segments: ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"],
  staleness: "tick",
  requiresDailyAuth: false,
  egressDescription: "None. Prices are generated inside this process; nothing leaves the machine.",
};

/** FNV-1a, 32-bit. Gives each symbol its own reproducible starting price. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, seedable, and stable across Node versions. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface WalkState {
  key: QuoteKey;
  rng: () => number;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
}

export function createMockProvider(opts: MockProviderOptions = {}): QuoteProvider {
  const seed = opts.seed ?? 20260905;
  const intervalMs = opts.intervalMs ?? 1000;
  const now = opts.now ?? (() => Date.now());
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    });

  const walks = new Map<string, WalkState>();

  function walkFor(key: QuoteKey): WalkState {
    const id = quoteKeyId(key);
    const existing = walks.get(id);
    if (existing) return existing;
    const h = hashString(id);
    // ₹100.00 … ₹5,000.00 in paise, so every symbol has its own level.
    const base = 10_000 + (h % 490_000);
    const state: WalkState = {
      key,
      rng: mulberry32((seed ^ h) >>> 0),
      ltp: base,
      open: base,
      high: base,
      low: base,
      prevClose: base,
      volume: 1_000 + (h % 9_000),
    };
    walks.set(id, state);
    return state;
  }

  function step(state: WalkState): void {
    // ±0.25 % of the opening level per tick, in whole paise.
    const span = Math.max(1, Math.round(state.open * 0.0025));
    const delta = Math.round((state.rng() - 0.5) * 2 * span);
    state.ltp = Math.max(100, state.ltp + delta);
    state.high = Math.max(state.high, state.ltp);
    state.low = Math.min(state.low, state.ltp);
    state.volume += Math.round(state.rng() * 500);
  }

  function quoteOf(state: WalkState): Quote {
    return {
      key: state.key,
      ltp: state.ltp,
      prevClose: state.prevClose,
      dayOpen: state.open,
      dayHigh: state.high,
      dayLow: state.low,
      volume: state.volume,
      asOf: new Date(now()).toISOString(),
      staleness: "tick",
      source: "mock",
    };
  }

  return {
    id: "mock",
    capabilities: MOCK_CAPABILITIES,

    async snapshot(keys: readonly QuoteKey[]): Promise<QuoteMap> {
      const out: QuoteMap = new Map();
      for (const key of keys.slice(0, MOCK_CAPABILITIES.maxSubscriptions)) {
        out.set(quoteKeyId(key), quoteOf(walkFor(key)));
      }
      return out;
    },

    subscribe(keys: readonly QuoteKey[], onTick: TickListener, signal?: AbortSignal): Unsubscribe {
      const wanted = keys.slice(0, MOCK_CAPABILITIES.maxSubscriptions);
      if (wanted.length === 0 || signal?.aborted) return () => {};
      const cancel = schedule(() => {
        for (const key of wanted) {
          const state = walkFor(key);
          step(state);
          onTick(quoteOf(state));
        }
      }, intervalMs);
      let stopped = false;
      const stop: Unsubscribe = () => {
        if (stopped) return; // idempotent — the route calls it on abort AND on cancel
        stopped = true;
        cancel();
        signal?.removeEventListener("abort", stop);
      };
      signal?.addEventListener("abort", stop);
      return stop;
    },

    async health(): Promise<ProviderHealth> {
      return { ok: true };
    },
  };
}
