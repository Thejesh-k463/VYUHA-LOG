import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import {
  LINK_IDLE,
  createStreamLink,
  linkStateFor,
  streamKeyOf,
  type KeyedLinkState,
  type LinkPhase,
  type LinkState,
  type StreamSource,
} from "@/lib/live/stream-link";
import { LIVE_STREAM_COPY } from "@/components/live/desk-copy";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { toPaise, type ProviderCapabilities, type Quote, type QuoteKey, type QuoteMap, type QuoteProvider } from "@/lib/quotes/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE v4.1.0 FIX-WAVE-3 SEAMS — the values handed between builder X (the code:
 * `lib/queries/mtm.ts` `writeTypedMark()`, its two call sites, `linkStateFor()`
 * in `lib/live/stream-link.ts`, the strip copy in `components/live/desk-copy.ts`
 * and the desk that derives from it) and builder Y (the docs and copy: one
 * sentence on seven surfaces, the CHANGELOG's wave-3 bullets), with BOTH REAL
 * HALVES running together.
 *
 * The two file sets are disjoint, which is what stops the builders clobbering
 * one file — and also what guarantees neither of them ran the two halves
 * together. Nothing below mocks either side of a seam: the only double is the
 * NETWORK (an OpenAlgo bridge that does not exist on this machine) and the
 * BROWSER TRANSPORT (`EventSource`, which the node suite has no DOM for). The
 * bridge double carries the SHIPPED `OPENALGO_CAPABILITIES` block, so
 * `providerMayAutoMark()` is asked the question production asks it, and the
 * writes it triggers are the real `catchUpDailyMark()` against a real migrated
 * database, reached through the REAL SSE route handler.
 *
 * ── THE SEAM TABLE ─────────────────────────────────────────────────────────
 *  # | crossing value                    | producer (file:line)                       | consumer (file:line)                        | unit / type              | test
 * ---|-----------------------------------|--------------------------------------------|---------------------------------------------|--------------------------|------
 *  1 | the typed mark `price`            | app/api/positions/risk/route.ts:70 (X)     | lib/queries/mtm.ts:12 `getMtmMap()`         | REAL RUPEES, not paise   | S1a
 *  2 | the same row, spot lens           | lib/queries/mtm.ts:62 `writeTypedMark()`   | lib/queries/mtm.ts:27 `getSpotMap()`        | rupees, cash rows only   | S1a
 *  3 | the same row, provider lens       | lib/queries/mtm.ts:71-74 (delete+insert)   | lib/quotes/manual.ts:79 `indexMarks()`      | rupees → PAISE at :106   | S1a
 *  4 | rows per (symbol, IST day)        | lib/queries/mtm.ts:70 (one transaction)    | lib/quotes/persist-mark.ts:240 held-row skip| row count, must be 1     | S1a/S1b
 *  5 | `asOfDate`                        | app/api/positions/risk/route.ts:74 IST day | lib/quotes/persist-mark.ts:196 `date`       | IST day, never the UTC one| S1b
 *  6 | the live door's second visit      | app/api/live/stream/route.ts:202 (X)       | mtm_prices, already holding a typed row     | marked count, 0          | S1a/S1b
 *  7 | "…not overwrite it at the close"  | lib/domain/openalgo-disclosure.ts:210 (Y)  | lib/quotes/persist-mark.ts:240 `if (held)`  | sentence ↔ behaviour     | S2a
 *  8 | "typing after the close replaces" | docs/client/PRIVACY.md:79 (Y)              | app/equity/actions.ts:74 `writeTypedMark()` | sentence ↔ behaviour     | S2b
 *  9 | `KeyedLinkState.key`              | components/live/tracker-client.tsx:423 (X) | lib/live/stream-link.ts:225 `linkStateFor()`| stream key, string       | S3a
 * 10 | the derived `LinkPhase`           | lib/live/stream-link.ts:226 (X)            | components/live/desk-copy.ts:120 `connected`| phase → strip line       | S3a/S3b
 * 11 | "not streaming"                   | components/live/desk-copy.ts:120 (X)       | CHANGELOG.md wave-3 bullet 2 (Y)            | phrase, verbatim         | S4a
 * 12 | the typed-mark sentence           | lib/domain/openalgo-disclosure.ts:210 (Y)  | CHANGELOG.md wave-3 bullet 1 (Y→X rule)     | sentence, verbatim       | S4a
 *
 * CLOCK. Every seam that carries a date runs on a pinned clock. S1a and S2a/S2b
 * run at FRIDAY 2026-09-04 16:00 IST (the automatic door's own window: a
 * weekday, past 15:30). S1b types its mark at 2026-09-03 19:00 UTC — which is
 * 00:30 IST on FRIDAY THE 4th, the IST day boundary — so a writer that dated
 * the row off the machine's UTC day would write 2026-09-03 and the live door's
 * 2026-09-04 row would then out-rank the user's number in every reader.
 * `toFake: ["Date"]` only: `catchUpDailyMark()` reaches the database through
 * REAL dynamic imports, and a fully faked timer set stalls the module loader
 * (the reason `tests/live-page.test.ts` gives). The SSE route's own intervals
 * therefore run on real timers, and every stream opened here is aborted.
 * ═══════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let mtm: typeof import("@/lib/queries/mtm");
let persist: typeof import("@/lib/quotes/persist-mark");
let riskRoute: typeof import("@/app/api/positions/risk/route");
let equity: typeof import("@/app/equity/actions");
let streamRoute: typeof import("@/app/api/live/stream/route");
let manual: typeof import("@/lib/quotes/manual");
let OPENALGO_CAPS: ProviderCapabilities;

/** The NETWORK, and only the network. */
const stub = vi.hoisted(() => ({ provider: null as QuoteProvider | null }));

vi.mock("@/lib/quotes/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quotes/registry")>();
  return {
    ...actual,
    getLiveFeedProvider: async () => stub.provider ?? (await actual.getLiveFeedProvider()),
  };
});

const ACCOUNT = 1;
/** Friday 2026-09-04, 16:00 IST — past the close, so the automatic door writes. */
const FRI_1600 = new Date("2026-09-04T10:30:00Z");
/** Thursday 2026-09-03, 19:00 UTC = FRIDAY 2026-09-04, 00:30 IST. The boundary. */
const IST_DAY_BOUNDARY = new Date("2026-09-03T19:00:00Z");
/** The IST day both writers must agree on at BOTH instants above. */
const DAY = "2026-09-04";

/** The sentence builder Y put on seven surfaces, verbatim (ASCII apostrophe). */
const SENTENCE =
  "A price you type yourself is that day's mark: the app does not overwrite it at the close, and typing after the close replaces the automatic one.";

let tcsId = 0;
let infyId = 0;

/* ── the bridge double: SHIPPED capabilities, a scripted network ──────────── */

function quoteOf(symbol: string, paise: number): Quote {
  return {
    key: { symbol, exchange: "NSE", tradingsymbol: symbol },
    ltp: paise,
    prevClose: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    asOf: "2026-09-04T10:00:00.000Z",
    staleness: "delayed",
    source: "openalgo",
  };
}

/** Prices in PAISE, keyed by symbol — the unit the wire carries. */
function bridge(prices: Record<string, number>): QuoteProvider & { asked: QuoteKey[][] } {
  const b = {
    id: "openalgo" as const,
    capabilities: OPENALGO_CAPS,
    asked: [] as QuoteKey[][],
    async snapshot(keys: readonly QuoteKey[]): Promise<QuoteMap> {
      b.asked.push([...keys]);
      const out: QuoteMap = new Map();
      for (const k of keys) {
        const ltp = prices[k.symbol];
        if (ltp === undefined) continue;
        const q = quoteOf(k.symbol, ltp);
        out.set(`${k.exchange}:${k.symbol}`, q);
      }
      return out;
    },
    subscribe: () => () => {},
    async health() {
      return { ok: true } as never;
    },
  };
  return b as unknown as QuoteProvider & { asked: QuoteKey[][] };
}

/* ── the SSE plumbing (the shape tests/seams-v41-fix2.test.ts uses) ───────── */

interface Drain {
  text: string;
  done: boolean;
}

function reading(res: Response): Drain {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const state: Drain = { text: "", done: false };
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        state.text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      /* the stream was cancelled — expected */
    }
    state.done = true;
  })();
  return state;
}

function frames(text: string, event: string): unknown[] {
  return [...text.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`, "g"))].map((m) => JSON.parse(m[1]) as unknown);
}

/**
 * ONE real connect of the REAL SSE route — the live door as the desk opens it,
 * torn down by the abort the browser sends when the desk goes away. Returns the
 * `snapshot` frame the route wrote, so the caller can assert on the wire too.
 */
async function liveDoorViaStreamRoute(): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  try {
    const drain = reading(
      await streamRoute.GET(
        new Request("http://127.0.0.1:3011/api/live/stream", {
          headers: { host: "127.0.0.1:3011" },
          signal: ac.signal,
        }),
      ),
    );
    for (let i = 0; i < 400; i++) {
      const got = frames(drain.text, "snapshot");
      if (got.length > 0) return got[0] as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error('no "snapshot" frame arrived');
  } finally {
    ac.abort();
  }
}

/** The risk dialog's own write path: the real route handler, a real Request. */
async function typedViaRiskDialog(tradeId: number, rupees: number) {
  const res = await riskRoute.POST(
    new Request("http://local/api/positions/risk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeId, mtmPrice: rupees }),
    }),
  );
  expect(res.status).toBe(200);
  return res;
}

/** The bulk MTM paste panel's own write path: the real server action. */
async function typedViaBulkPaste(symbol: string, rupees: number, asOf: string) {
  const form = new FormData();
  form.set("prices", `${symbol} ${rupees}`);
  form.set("asOf", asOf);
  return equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
}

/**
 * Every row of `mtm_prices` in ROWID order — the order every reader resolves a
 * tie in — as (symbol, price, asOfDate). `rowsFor()` narrows it to one symbol,
 * which is where a duplicate for a (symbol, day) shows up; `marks()` sorts by
 * symbol only so the whole table can be stated without depending on the order
 * the tracker happened to hand the bridge its keys.
 */
const rows = () =>
  t.db
    .select()
    .from(t.schema.mtmPrices)
    .all()
    .map((m) => [m.symbol, m.price, m.asOfDate] as const);

const rowsFor = (symbol: string) => rows().filter((m) => m[0] === symbol);

const marks = () => [...rows()].sort((a, b) => a[0].localeCompare(b[0]));

const stamp = () => t.db.select().from(t.schema.settings).limit(1).all()[0]?.lastLiveMarkDate ?? null;

function clearMarks() {
  t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
  t.sqlite.prepare("DELETE FROM mtm_prices").run();
}

/** Date-only fake clock: the module loader still runs on real timers. */
function pinDate(when: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(when);
}

/** What the REAL manual provider prints for a symbol, straight from the table. */
async function manualQuote(symbol: string): Promise<Quote | undefined> {
  const provider = manual.createManualProvider();
  const map = await provider.snapshot([{ symbol, exchange: "NSE", tradingsymbol: symbol }]);
  return [...map.values()][0];
}

/* ── docs ─────────────────────────────────────────────────────────────────── */

/** Line endings NORMALISED, and wraps collapsed: a seam is not a line break. */
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8").split("\r\n").join("\n");
const flat = (s: string) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

/** Both wave-3 bullets of the CHANGELOG, as one flat string. */
function changelogWave3(): string {
  const all = read("CHANGELOG.md");
  const first = all.indexOf("- **Fix wave 3 —");
  expect(first, "the CHANGELOG has no fix-wave-3 bullet").toBeGreaterThan(-1);
  const after = all.indexOf("\n\n- **", first + 1);
  const second = all.indexOf("- **Fix wave 3 —", first + 1);
  expect(second, "the CHANGELOG has only one fix-wave-3 bullet").toBeGreaterThan(first);
  const end = all.indexOf("\n\n- **", second + 1);
  return flat(all.slice(first, after === -1 ? undefined : after) + " " + all.slice(second, end === -1 ? undefined : end));
}

/** Disclosure item 6 of the FEED block — "Prices refresh on screen only". */
const feedItem6 = () => OPENALGO_FEED_ITEMS[5];

/* ── the browser transport double (NOT a side of any seam) ────────────────── */

class FakeSource implements StreamSource {
  readyState = 1; // OPEN
  private readonly listeners = new Map<string, ((ev: Event) => void)[]>();
  addEventListener(type: string, listener: (ev: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  close(): void {
    this.readyState = 2; // CLOSED
  }
  /** A named frame carrying the route's own JSON shape. */
  emit(type: string, data: unknown): void {
    const ev = { data: JSON.stringify(data) } as unknown as Event;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

/** A REAL `StreamLink` with every browser edge injected. */
function linkHarness() {
  const sources: FakeSource[] = [];
  const states: LinkState[] = [];
  const paints: (() => void)[] = [];
  const link = createStreamLink<ReturnType<typeof setTimeout>>({
    createSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    isHidden: () => false,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
    schedulePaint: (fn) => {
      paints.push(fn);
      return paints.length;
    },
    cancelPaint: () => {},
    random: () => 0,
    onState: (s) => states.push(s),
    onQuotes: () => {},
  });
  return { link, sources, states, last: () => states.at(-1)! };
}

/**
 * The strip line and the live-region announcement, exactly as
 * `components/live/tracker-client.tsx:503-520` derives them from a `LinkState`.
 * The two halves being crossed are `linkStateFor()` and `LIVE_STREAM_COPY`;
 * this is the desk's own ternary, and nothing else.
 */
function stripLine(link: LinkState, providerId: string, frameAgeS: number | null): string {
  return link.phase === "live" && frameAgeS !== null
    ? LIVE_STREAM_COPY.live(providerId, frameAgeS)
    : link.phase === "connected"
      ? LIVE_STREAM_COPY.connected(providerId)
      : link.phase === "reconnecting"
        ? LIVE_STREAM_COPY.reconnecting
        : link.phase === "paused"
          ? LIVE_STREAM_COPY.paused
          : link.phase === "stopped"
            ? LIVE_STREAM_COPY.stopped(link.reason ?? LIVE_STREAM_COPY.stoppedNoReason)
            : LIVE_STREAM_COPY.connecting;
}

const announceFor = (link: LinkState) => LIVE_STREAM_COPY.announce[link.phase as LinkPhase];

beforeAll(async () => {
  t = await openTempDb("seams-v41-fix3", { seed: true });
  mtm = await import("@/lib/queries/mtm");
  persist = await import("@/lib/quotes/persist-mark");
  riskRoute = await import("@/app/api/positions/risk/route");
  equity = await import("@/app/equity/actions");
  streamRoute = await import("@/app/api/live/stream/route");
  manual = await import("@/lib/quotes/manual");
  OPENALGO_CAPS = (await import("@/lib/quotes/openalgo")).OPENALGO_CAPABILITIES;

  // Warm the LAZY imports the mark path uses, so a Date-faked test never waits
  // on a module loader.
  await import("@/lib/queries/trades");
  await import("@/lib/db/schema");
  await import("@/lib/audit");
  await import("drizzle-orm");

  t.db.update(t.schema.settings).set({ selectedAccountId: ACCOUNT }).run();
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        accountId: ACCOUNT,
        symbol: "TCS",
        tradingsymbol: "TCS",
        isOpen: true,
        buyQty: 10,
        avgBuyPrice: 3000,
        buyDate: "2026-08-06",
        slPlanned: 2800,
      }),
      // A SHORT, with its stop ABOVE entry: the other sign through the same seam.
      tradeRow({
        accountId: ACCOUNT,
        symbol: "INFY",
        tradingsymbol: "INFY",
        isOpen: false,
        buyQty: 0,
        sellQty: 8,
        avgSellPrice: 1500,
        sellDate: "2026-08-06",
        slPlanned: 1600,
      }),
    ])
    .run();
  // `is_open` is the open predicate; the short is set open directly so the row
  // carries a sell leg with no buy leg (lib/analytics/positions.ts).
  t.sqlite.prepare("UPDATE trades SET is_open = 1 WHERE symbol = 'INFY'").run();
  const rows = t.db.select().from(t.schema.trades).all();
  tcsId = rows.find((r) => r.symbol === "TCS")!.id;
  infyId = rows.find((r) => r.symbol === "INFY")!.id;
});

afterAll(() => {
  vi.useRealTimers();
  t?.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
  stub.provider = null;
});

/* ═══ SEAM 1 (X↔X) · the typed row, the live door, and all three readers ═══ */

describe("SEAM 1 · what the user typed is what every reader of mtm_prices prints", () => {
  it("S1a: the live door writes 3120, the risk ROUTE types 3100 — one row, and getMtmMap/getSpotMap/the manual provider all say 3100", async () => {
    clearMarks();
    pinDate(FRI_1600);
    stub.provider = bridge({ TCS: 312_000, INFY: 149_900 });

    // THE LIVE DOOR, through the real SSE route: `catchUpDailyMark()` on the
    // snapshot the route already holds. PAISE on the wire, RUPEES in the table
    // — invariant 1's documented exception, converted exactly once at the
    // write edge.
    const snapshot = await liveDoorViaStreamRoute();
    expect((snapshot.quotes as Quote[]).map((q) => q.ltp).sort(), "the bridge priced both open positions").toEqual([
      149_900, 312_000,
    ]);
    expect(marks()).toEqual([
      ["INFY", 1499, DAY],
      ["TCS", 3120, DAY],
    ]);

    // …and then the user types a correction into the risk dialog at 16:00.
    await typedViaRiskDialog(tcsId, 3100);

    // THE USER-VISIBLE HALF FIRST, on all three readers. The finding was
    // invisible to the row count alone: the typed row WAS written, it was
    // simply never the one read, so the dialog said "Saved." and every figure
    // on screen went on printing the bridge's 3120.
    expect(mtm.getMtmMap().get("TCS"), "the map every position figure reads").toBe(3100);
    expect(mtm.getSpotMap().get("TCS"), "the spot lens used for option moneyness").toBe(3100);

    const q = await manualQuote("TCS");
    expect(q, "the manual provider found no mark for a symbol that has one").toBeTruthy();
    // The provider's wire unit is PAISE, converted from the row's rupees once.
    expect(q!.ltp).toBe(toPaise(3100));
    expect(q!.asOf.slice(0, 10), "the mark is dated to the IST day it belongs to").toBe(DAY);

    // …and ONE row for (TCS, the IST day), not two.
    expect(rowsFor("TCS")).toEqual([["TCS", 3100, DAY]]);
    // The short's automatic row is untouched by a write to another symbol.
    expect(rowsFor("INFY")).toEqual([["INFY", 1499, DAY]]);

    // THE LIVE DOOR AGAIN — every reconnect crosses it (the desk re-establishes
    // at 15:31 IST, and a reload opens a new stream). A DIFFERENT price on the
    // wire, so a rewrite would be visible.
    stub.provider = bridge({ TCS: 999_900, INFY: 999_900 });
    await liveDoorViaStreamRoute();
    expect(rowsFor("TCS"), "the second connect took the typed mark back").toEqual([["TCS", 3100, DAY]]);
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
  });

  it("S1b: typed FIRST at 00:30 IST — the same IST day the door marks at 16:00, and the door leaves it alone", async () => {
    clearMarks();
    // 2026-09-03 19:00 UTC. The UTC day is the 3rd; the IST day is the 4th.
    pinDate(IST_DAY_BOUNDARY);
    expect(new Date().getUTCDate(), "the machine's UTC day is the 3rd here").toBe(3);

    await typedViaRiskDialog(tcsId, 3100);
    await typedViaRiskDialog(infyId, 1490); // the SHORT, same door
    expect(marks(), "a typed mark dated off the UTC day would be a day behind the door's").toEqual([
      ["INFY", 1490, DAY],
      ["TCS", 3100, DAY],
    ]);

    // …and the automatic door, sixteen hours later on the same IST day.
    pinDate(FRI_1600);
    stub.provider = bridge({ TCS: 312_000, INFY: 149_900 });
    await liveDoorViaStreamRoute();

    expect(marks(), "the feed overwrote marks the user typed").toEqual([
      ["INFY", 1490, DAY],
      ["TCS", 3100, DAY],
    ]);
    expect(stamp(), "the banner is never dated on a day that wrote no row").toBeNull();
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
    expect(mtm.getMtmMap().get("INFY"), "the SHORT's typed mark, same rule").toBe(1490);
    expect((await manualQuote("INFY"))!.ltp).toBe(toPaise(1490));
  });
});

/* ═══ SEAM 2 (Y→X) · the sentence's two clauses, beside the two behaviours ══ */

describe("SEAM 2 · Y's sentence says what X's two doors do", () => {
  it('S2a: "the app does not overwrite it at the close" — disclosure item 6, and the live door skipping the held row', async () => {
    // Y'S HALF: the clause, verbatim, in the disclosure the install re-reads.
    expect(feedItem6().title).toBe("Prices refresh on screen only — ticks are never written");
    expect(flat(feedItem6().body), "disclosure item 6 no longer carries the typed-mark sentence").toContain(SENTENCE);
    expect(SENTENCE).toContain("the app does not overwrite it at the close");

    // X'S HALF: the real automatic door, over a row the user typed first.
    clearMarks();
    pinDate(FRI_1600);
    await typedViaRiskDialog(tcsId, 3100);

    const result = await persist.catchUpDailyMark(OPENALGO_CAPS, [quoteOf("TCS", 312_000)]);
    expect(result, "a streaming, non-mock provider must reach the door").not.toBeNull();
    expect(result!.written, "the automatic door overwrote a mark the user typed").toBe(false);
    expect(result!.marked).toBe(0);
    expect(result!.code).toBe("already-marked");
    expect(marks()).toEqual([["TCS", 3100, DAY]]);
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
  });

  it('S2b: "typing after the close replaces the automatic one" — PRIVACY item 3, and the equity page\'s paste', async () => {
    // Y'S HALF: the clause, verbatim, in the file a buyer reads.
    const privacy = flat(read("docs", "client", "PRIVACY.md"));
    expect(privacy, "PRIVACY.md no longer carries the typed-mark sentence").toContain(SENTENCE);
    expect(SENTENCE).toContain("typing after the close replaces the automatic one");

    // X'S HALF: the automatic row exists, and the OTHER typed door replaces it.
    clearMarks();
    pinDate(FRI_1600);
    stub.provider = bridge({ TCS: 312_000, INFY: 149_900 });
    await liveDoorViaStreamRoute();
    expect(rowsFor("TCS")).toEqual([["TCS", 3120, DAY]]);

    const pasted = await typedViaBulkPaste("TCS", 3100, DAY);
    expect(pasted.ok).toBe(true);
    expect(pasted.updated).toBe(1);

    expect(rowsFor("TCS"), "the pasted price queued behind the automatic row").toEqual([["TCS", 3100, DAY]]);
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
    expect((await manualQuote("TCS"))!.ltp).toBe(toPaise(3100));
  });
});

/* ═══ SEAM 3 (X→X) · the stored link state, through the strip's copy ═══════ */

describe("SEAM 3 · the strip prints the CURRENT stream's state, in the current words", () => {
  const KEY_A = streamKeyOf(1, [{ accountId: 1, exchange: "NSE", tradingsymbol: "TCS" }]);
  const KEY_B = streamKeyOf(2, [{ accountId: 2, exchange: "NSE", tradingsymbol: "INFY" }]);

  it("S3a: an after-hours snapshot reads 'not streaming' on its OWN key, and 'Connecting…' on the next account's", () => {
    expect(KEY_A).not.toBe(KEY_B);

    // A REAL link, driven with the route's own after-hours frame: quotes
    // delivered, nothing subscribed.
    const h = linkHarness();
    h.link.open();
    h.sources[0].emit("snapshot", {
      provider: "openalgo",
      marketOpen: false,
      quotes: [quoteOf("TCS", 312_000)],
    });
    const stored: KeyedLinkState = { key: KEY_A, state: h.last() };
    expect(stored.state.phase, "a snapshot with no subscription behind it is not live").toBe("connected");

    // ITS OWN STREAM: the strip states the absence of a STREAM, not of prices —
    // the frame that produced this phase carried prices.
    const own = stripLine(linkStateFor(stored, KEY_A), "openalgo", null);
    expect(own).toBe("Connected · openalgo · not streaming");
    expect(own).toContain("not streaming");
    expect(/\d/.test(own), "a connected-but-silent strip must carry no age").toBe(false);
    expect(announceFor(linkStateFor(stored, KEY_A))).toBe("Feed connected.");
    expect(/\d/.test(announceFor(linkStateFor(stored, KEY_A))), "the live region must not read a number").toBe(false);

    // THE ACCOUNT SWITCH: the desk stays mounted, the key changes, and the old
    // connection's verdict stops being the answer on the frame that renders it.
    expect(linkStateFor(stored, KEY_B)).toBe(LINK_IDLE);
    expect(stripLine(linkStateFor(stored, KEY_B), "openalgo", null)).toBe("Connecting…");
    expect(announceFor(linkStateFor(stored, KEY_B)), "idle announces nothing on a navigation").toBe("");
    h.link.destroy();
  });

  it("S3b: a LIVE line, with its age, is dropped whole across the switch", () => {
    const h = linkHarness();
    h.link.open();
    h.sources[0].emit("snapshot", { provider: "openalgo", quotes: [quoteOf("TCS", 312_000)] });
    h.sources[0].emit("tick", { provider: "openalgo", quotes: [quoteOf("TCS", 312_100)] });
    const stored: KeyedLinkState = { key: KEY_A, state: h.last() };
    expect(stored.state.phase).toBe("live");

    expect(stripLine(linkStateFor(stored, KEY_A), "openalgo", 3)).toBe("Live · openalgo · 3 s");
    expect(
      stripLine(linkStateFor(stored, KEY_B), "openalgo", 3),
      "the strip carried the destroyed stream's Live line into the new account",
    ).toBe("Connecting…");
    h.link.destroy();
  });

  it("S3c: a terminal verdict does not follow the switch either — the reason belonged to the old book", () => {
    const h = linkHarness();
    h.link.open();
    h.sources[0].emit("error", { provider: "openalgo", message: "The bridge is not logged in for today." });
    const stored: KeyedLinkState = { key: KEY_A, state: h.last() };
    expect(stripLine(linkStateFor(stored, KEY_A), "openalgo", null)).toBe(
      "Feed stopped — The bridge is not logged in for today.",
    );
    expect(
      stripLine(linkStateFor(stored, KEY_B), "openalgo", null),
      "the new account inherited the old one's Feed stopped",
    ).toBe("Connecting…");
    h.link.destroy();
  });
});

/* ═══ SEAM 4 (Y↔X) · the CHANGELOG describes the strings that shipped ══════ */

describe("SEAM 4 · the wave-3 bullets name the phrase and the rule the code carries", () => {
  it("S4a: the CHANGELOG's 'not streaming' is desk-copy's own phrase, and its rule is the disclosure's sentence", () => {
    const bullets = changelogWave3();

    // X'S HALF, DERIVED — never a literal: the phrase is whatever the strip
    // prints after the provider, so a reworded strip and an unchanged CHANGELOG
    // cannot both stand.
    const phrase = LIVE_STREAM_COPY.connected("openalgo").split(" · ").at(-1)!;
    expect(phrase).toBe("not streaming");
    expect(bullets, "the CHANGELOG names a strip phrase the code does not print").toContain(phrase);

    // Y'S HALF: the same sentence the seven surfaces carry, wraps collapsed.
    expect(bullets, "the CHANGELOG's typed-mark rule is not the sentence that shipped").toContain(SENTENCE);
    expect(flat(feedItem6().body)).toContain(SENTENCE);
    // …and the CHANGELOG's own account of the row rule, in the code's terms.
    expect(bullets).toContain("one row per symbol per IST day");
  });
});
