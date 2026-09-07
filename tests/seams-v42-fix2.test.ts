import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/* ─────────────────────────────────────────────────────────────────────────────
 * SEAM TESTS — the v4.2 FIX WAVE 2 (B-1 … B-13).
 *
 * FIVE builders owned DISJOINT files. A disjoint wave cannot produce an edit
 * conflict; it also guarantees that nobody ran the two halves of a crossing
 * value together. Every test below BUILDS the value where its producer builds
 * it (the real function, the real page, the real route handler, against one
 * real temp database), hands it across exactly as the product does (a React
 * prop, a JSON response body, a `Map` keyed the way `mtm_prices` is keyed, a
 * markdown file read off disk), and asserts the CONSUMER'S OUTPUT — the mark in
 * paise, the notional in rupees, the sentence on the screen.
 *
 * NOTHING ON EITHER SIDE OF A SEAM IS MOCKED. Two substitutions appear and
 * neither is a side of a seam:
 *   • S4 mocks `@/lib/quotes/types` — the RELEASE FLAG, which is the input the
 *     whole B-8 seam is a function of. Both halves (the route's schema and the
 *     card's `feedBlockState`) are the real modules, re-imported under the flag
 *     this build cannot otherwise show.
 *   • S2d injects `loginImpl` into the Angel One adapter — that is the BROKER,
 *     the far side of the network, not the far side of the seam.
 *
 * OWNERSHIP (disjoint, by builder):
 *   C1  app/risk/page.tsx, lib/jobs/auto-mtm.ts, tests/derivative-mark-readers.test.ts
 *   C5  lib/queries/trades.ts, app/reports/performance/page.tsx
 *   C2  components/settings/live-feed-card.tsx, app/api/live/feed/route.ts,
 *       components/live/desk-copy.ts
 *   C3  lib/domain/live-feed-disclosure.ts, lib/domain/help-content.ts,
 *       docs/client/PRIVACY.md, docs/client/README.md, README.md
 *   C4  tests/angelone-api.test.ts, tests/account-isolation.test.ts,
 *       tests/seams-v42-fix.test.ts
 *   Orchestrator  tests/quotes-egress-guard.test.ts
 *
 * ── THE CROSSING VALUES ──────────────────────────────────────────────────────
 *
 * id | crossing value                | producer (file:line)                              | consumer (file:line)                                | unit / shape                | tests
 * ---|-------------------------------|---------------------------------------------------|-----------------------------------------------------|-----------------------------|-------
 * S1 | the STORED MARK of one row    | 8ae5dea lib/analytics/positions.ts:79 storedMarkFor | C1 app/risk/page.tsx:137 ExposureInput.mtm           | ₹ per unit (paise on desk)  | S1a–e
 *    |   (`mtm_prices`, keyed on     |   + lib/queries/mtm.ts:12 getMtmMap (KEY = symbol)  | C1 app/risk/page.tsx:298 settlement refPrice        |                             |
 *    |    `symbol`, so a derivative  |                                                     | C1 lib/jobs/auto-mtm.ts:164 scanBreaches           |                             |
 *    |    carries its UNDERLYING)    |                                                     | C5 app/reports/performance/page.tsx:170 px         |                             |
 *    |                               |                                                     | 8ae5dea components/live/load-desk.ts:343 markP     |                             |
 * S1b| PERFORMANCE_FIELDS projection | C5 lib/queries/trades.ts:153 (+instrumentType,      | C5 app/reports/performance/page.tsx:170            | column list → row shape     | S1d
 *    |                               |   +tradingsymbol)                                   |   `storedMarkFor(t, mtm)`                          |                             |
 * S2 | the B-5 SENTENCE              | C2 live-feed-card.tsx:116,181 `equityOnly`          | C3 live-feed-disclosure.ts:86,164 sheet item       | bytes, one literal          | S2a–c
 *    |                               |                                                     | C3 help-content.ts:57,65 /live body                |                             |
 *    |                               |                                                     | C3 README.md:59, docs/client/{README,PRIVACY}.md   | whitespace-normalised       |
 * S3 | the CADENCE NOUN ("scrip")    | C2 desk-copy.ts:326 angelOneCadenceLine            | C3 help-content.ts:65 tier line, both READMEs      | count + noun in a sentence  | S3a–b
 * S4 | ANGELONE_FEED_ENABLED         | lib/quotes/types.ts:104 (release flag)              | C2 route.ts:120 ACKABLE → ack enum                 | boolean → 400/200           | S4a–b
 *    |                               |                                                     | C2 live-feed-card.tsx:305 feedBlockState offeredIds|                             |
 *    |                               |                                                     | lib/quotes/registry.ts:246 selectProviderId        |                             |
 * S5 | the POST body's `feed`        | C2 route.ts:373 `feed: await resolveLiveFeed()`     | C2 live-feed-card.tsx:498 foldFeedResponse →       | JSON {stored,effective,…}   | S5a–b
 *    |                               |                                                     |   feedBlockState / feedHealthText                  |                             |
 * S6 | the egress PIN sentence       | Orchestrator quotes-egress-guard.test.ts:63         | C3 docs/client/PRIVACY.md item 3 ¶4                 | bytes, whitespace-normalised| S6a–b
 * S7 | the broker_connections reader | C2 route.ts, lib/quotes/registry.ts (new readers)   | C4 account-isolation.test.ts:343 OWNERS + exempt   | set of file paths           | S7a
 *
 * ONE temp database for the whole file (`lib/db` caches its connection on
 * `globalThis` — AGENTS.md). Everything server-only is imported DYNAMICALLY
 * inside `beforeAll`, after the helper has set `VYUHA_DB_PATH`.
 * ────────────────────────────────────────────────────────────────────────── */

/* PURE modules — none of these reaches lib/db, so a static import is safe. */
import {
  ANGELONE_CADENCE_NO_COUNT,
  angelOneCadenceLine,
} from "@/components/live/desk-copy";
import {
  ANGELONE_FEED_COPY,
  UPSTOX_FEED_COPY,
  PROVIDERS,
  feedBlockState,
  feedHealthText,
  foldFeedResponse,
  type FeedResponse,
  type FeedState,
} from "@/components/settings/live-feed-card";
import { ANGELONE_FEED_ITEMS, UPSTOX_FEED_ITEMS, withFeedAck } from "@/lib/domain/live-feed-disclosure";
import { HELP_ENTRIES } from "@/lib/domain/help-content";

let t: TempDb;
let riskPage: () => unknown;
let perfPage: () => unknown;
let computeExposure: typeof import("@/lib/analytics/exposure").computeExposure;
let scanBreaches: typeof import("@/lib/jobs/auto-mtm").scanBreaches;
let live: typeof import("@/components/live/load-desk");
let registry: typeof import("@/lib/quotes/registry");
let route: typeof import("@/app/api/live/feed/route");
let angelone: typeof import("@/lib/quotes/angelone");

/* ── THE ONE SEEDED BOOK every S1 reader is asked about ───────────────────── */
const ACCOUNT = 1;
const OPTION_ID = 901;
const EQUITY_ID = 902;
const FUTURE_ID = 903;
/** One CLOSED, DATED row, so /reports/performance has a realised day and renders. */
const CLOSED_ID = 904;
const CLOSED_NET_PNL = 500;

const OPT_TRADINGSYMBOL = "OPT NIFTY 25 JUN 2026 23500 CE";
const FUT_TRADINGSYMBOL = "FUT RELIANCE 24 SEP 2026";
/** The CASH spot of the index — the number an option premium must never wear. */
const NIFTY_SPOT = 23450;
/** The underlying's cash mark, and the contract's OWN recorded mark. */
const RELIANCE_SPOT = 1400;
const RELIANCE_FUT_MARK = 1450;
const TCS_CASH_MARK = 2100;

/** What EVERY reader must resolve for each row — the seam, in one table. */
const EXPECTED_MARK: Record<number, number> = {
  [OPTION_ID]: 130, //  its own recorded close (no contract mark stored)
  [EQUITY_ID]: TCS_CASH_MARK, // the cash mark, unchanged for equities
  [FUTURE_ID]: RELIANCE_FUT_MARK, // its OWN contract mark, not RELIANCE cash
};
/** What the pre-wave underlying-first rung resolved instead. */
const UNDERLYING_MARK: Record<number, number> = {
  [OPTION_ID]: NIFTY_SPOT,
  [EQUITY_ID]: TCS_CASH_MARK,
  [FUTURE_ID]: RELIANCE_SPOT,
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (n: number) => iso(new Date(Date.now() + n * 86400000));

/** Collect every `props[key]` in a React element tree (the page is never rendered). */
function collectProps(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const n of node) collectProps(n, key, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props) {
    if (key in props) out.push(props[key]);
    collectProps(props.children, key, out);
  }
  return out;
}

/** Concatenate every string/number leaf of a React element tree. */
function flattenText(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) flattenText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) flattenText(props.children, out);
  }
  return out;
}

type ExposureInput = Parameters<typeof computeExposure>[0][number];

let riskInputs: ExposureInput[];
let settlement: import("@/lib/analytics/settlement").SettlementSummary;
let perfText: string;
let perfCapital: number;
let deskRows: Awaited<ReturnType<typeof live.loadLiveDesk>>["rows"];

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function setFeed(provider: string, ack: string | null, openalgoEnabled = false) {
  t.db
    .update(t.schema.settings)
    .set({ liveFeedProvider: provider, liveFeedAckJson: ack, openalgoEnabled })
    .run();
  registry.resetLiveFeedProviderCache();
}

function get(): Promise<Response> {
  return route.GET(
    new Request("http://127.0.0.1:3011/api/live/feed", { headers: { host: "127.0.0.1:3011" } }),
  );
}

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** The GET body, as the Settings card's mount fetch reads it. */
interface FeedBody {
  feed: FeedState;
  health: { ok: boolean; state?: string; latencyMs: number | null; reason: string };
  lastLiveMarkDate: string | null;
}

/* ── markdown → one comparable line ───────────────────────────────────────── */
const REPO = process.cwd();
const readDoc = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
/** Blockquote markers, bold markers and every run of whitespace, removed. */
const plain = (md: string) =>
  md
    .replace(/^>\s?/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

beforeAll(async () => {
  t = await openTempDb("seams-v42-fix2", { seed: true });
  ({ computeExposure } = await import("@/lib/analytics/exposure"));
  ({ scanBreaches } = await import("@/lib/jobs/auto-mtm"));
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  perfPage = (await import("@/app/reports/performance/page")).default as () => unknown;
  live = await import("@/components/live/load-desk");
  registry = await import("@/lib/quotes/registry");
  route = await import("@/app/api/live/feed/route");
  angelone = await import("@/lib/quotes/angelone");

  t.db
    .update(t.schema.settings)
    .set({ equityCapital: 1_000_000, activeCapital: 1_000_000, selectedAccountId: ACCOUNT })
    .run();

  t.db
    .insert(t.schema.trades)
    .values([
      // An open index CALL. Its premium went 120 → 130; the index sits at 23,450.
      tradeRow({
        id: OPTION_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "index_option",
        instrumentType: "option",
        exchange: "NFO",
        symbol: "NIFTY",
        tradingsymbol: OPT_TRADINGSYMBOL,
        optionType: "CE",
        strike: 23500,
        expiry: plusDays(20),
        buyQty: 75,
        sellQty: 0,
        avgBuyPrice: 120,
        closingPrice: 130,
        targetPlanned: 150,
        buyDate: plusDays(-10),
        isOpen: true,
      }),
      // CONTROL — an equity row must still read its cash mark.
      tradeRow({
        id: EQUITY_ID,
        accountId: ACCOUNT,
        symbol: "TCS",
        tradingsymbol: "TCS",
        instrumentType: "equity",
        buyQty: 10,
        sellQty: 0,
        avgBuyPrice: 2000,
        closingPrice: 2010,
        targetPlanned: 2050,
        buyDate: plusDays(-10),
        isOpen: true,
      }),
      // A stock FUTURE with a mark of its own, recorded under its contract.
      tradeRow({
        id: FUTURE_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        exchange: "NFO",
        symbol: "RELIANCE",
        tradingsymbol: FUT_TRADINGSYMBOL,
        expiry: plusDays(10),
        buyQty: 500,
        sellQty: 0,
        avgBuyPrice: 1410,
        closingPrice: 1420,
        buyDate: plusDays(-10),
        isOpen: true,
      }),
      tradeRow({
        id: CLOSED_ID,
        accountId: ACCOUNT,
        symbol: "INFY",
        tradingsymbol: "INFY",
        buyQty: 10,
        sellQty: 10,
        avgBuyPrice: 1500,
        avgSellPrice: 1550,
        buyDate: plusDays(-30),
        sellDate: plusDays(-5),
        netPnl: CLOSED_NET_PNL,
        grossPnl: CLOSED_NET_PNL,
        isOpen: false,
      }),
    ])
    .run();

  // `mtm_prices` is keyed on `symbol`. THAT is the trap: a derivative trade
  // carries its UNDERLYING there, so the cash rows below are exactly what a
  // bulk paste or a bhavcopy leaves behind for NIFTY and RELIANCE.
  t.db
    .insert(t.schema.mtmPrices)
    .values([
      { symbol: "NIFTY", tradingsymbol: "NIFTY", price: NIFTY_SPOT, asOfDate: "2026-09-04" },
      { symbol: "TCS", tradingsymbol: "TCS", price: TCS_CASH_MARK, asOfDate: "2026-09-04" },
      { symbol: "RELIANCE", tradingsymbol: "RELIANCE", price: RELIANCE_SPOT, asOfDate: "2026-09-04" },
      // …and the future's OWN mark, keyed on its contract.
      {
        symbol: FUT_TRADINGSYMBOL,
        tradingsymbol: FUT_TRADINGSYMBOL,
        price: RELIANCE_FUT_MARK,
        asOfDate: "2026-09-04",
      },
    ])
    .run();

  // ── The FOUR readers, run once each against that one book ────────────────
  setFeed("manual", null);
  deskRows = (await live.loadLiveDesk({ pro: true })).rows;

  perfText = flattenText(perfPage()).join("");
  ({ totalCapital: perfCapital } = (await import("@/lib/queries/capital")).getBucketCapital());

  const tree = riskPage();
  riskInputs = collectProps(tree, "inputs")[0] as ExposureInput[];
  settlement = collectProps(tree, "summary").find(
    (s): s is import("@/lib/analytics/settlement").SettlementSummary =>
      !!s && typeof s === "object" && "obligations" in (s as object),
  )!;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  t?.cleanup();
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S1 — ONE stored mark, FOUR readers, one seeded book.
 *
 * C1 fixed /risk and the EOD breach job, C5 fixed the performance report, and
 * 8ae5dea had already fixed the desk. Three builders, three files, one rule
 * (`storedMarkFor`) — and no one ran the four together on a single book. If any
 * one of them keeps the underlying-first rung, the SAME position prints a
 * different number on a different screen, which is the failure the whole ruling
 * exists to stop.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S1 — the four readers of the stored mark agree on one book", () => {
  it("S1a  the Live Desk prices each row at the mark that row is entitled to", () => {
    const mark = (id: number) => deskRows.find((r) => r.id === id)?.markP;
    // Paise (invariant 1) — the desk is the only reader that converts.
    expect(mark(OPTION_ID)).toBe(EXPECTED_MARK[OPTION_ID] * 100);
    expect(mark(EQUITY_ID)).toBe(EXPECTED_MARK[EQUITY_ID] * 100);
    expect(mark(FUTURE_ID)).toBe(EXPECTED_MARK[FUTURE_ID] * 100);
    // …and never the underlying's cash price.
    expect(mark(OPTION_ID)).not.toBe(UNDERLYING_MARK[OPTION_ID] * 100);
    expect(mark(FUTURE_ID)).not.toBe(UNDERLYING_MARK[FUTURE_ID] * 100);

    // The OUTPUT, not the arrival: 500 × (₹1,450 − ₹1,410) = ₹20,000 on the
    // future, and the underlying's 1,400 would have printed a ₹5,000 LOSS on a
    // position that had gained — the sign, not merely the size.
    expect(deskRows.find((r) => r.id === FUTURE_ID)?.unrealisedP).toBe(2_000_000);
    expect(deskRows.find((r) => r.id === OPTION_ID)?.unrealisedP).toBe(75_000);
  });

  it("S1b  /risk hands computeExposure the same three marks, and the exposure it computes", () => {
    for (const id of [OPTION_ID, EQUITY_ID, FUTURE_ID]) {
      expect(riskInputs.find((p) => p.id === id)!.mtm, `ExposureInput.mtm for ${id}`).toBe(EXPECTED_MARK[id]);
    }
    expect(riskInputs.find((p) => p.id === OPTION_ID)!.mtm).not.toBe(NIFTY_SPOT);

    const exposure = computeExposure(riskInputs, 2_000_000);
    // (130 − 120) × 75 = ₹750. The underlying rung printed (23,450 − 120) × 75
    // = ₹17,49,750 — a number nothing in this book ever traded (invariant 6).
    expect(exposure.positions.find((p) => p.id === OPTION_ID)!.unrealised).toBe(750);
    expect(exposure.positions.find((p) => p.id === FUTURE_ID)!.unrealised).toBe(20_000);
    expect(exposure.positions.find((p) => p.id === EQUITY_ID)!.unrealised).toBe(1_000);

    // The SPOT rung is deliberately untouched: Black-Scholes needs the
    // underlying, and A-1 is about the PREMIUM.
    expect(riskInputs.find((p) => p.id === OPTION_ID)!.spot).toBe(NIFTY_SPOT);
  });

  it("S1c  /risk values the futures delivery obligation at the FUTURE's own mark", () => {
    const ob = settlement.obligations.find((o) => o.id === FUTURE_ID)!;
    expect(ob.kind).toBe("stock_future");
    // notional = refPrice × qty, and refPrice is the contract's mark.
    expect(ob.notional).toBe(RELIANCE_FUT_MARK * 500);
    expect(ob.notional).not.toBe(RELIANCE_SPOT * 500);
  });

  it("S1d  /reports/performance books the unrealised leg at those same three marks", () => {
    // C5's half of this seam is the PROJECTION: without `instrumentType` and
    // `tradingsymbol` in PERFORMANCE_FIELDS, `storedMarkFor()` on the page
    // cannot tell a contract from a share and cannot find the contract's mark.
    const unrealised =
      (EXPECTED_MARK[OPTION_ID] - 120) * 75 +
      (EXPECTED_MARK[EQUITY_ID] - 2000) * 10 +
      (EXPECTED_MARK[FUTURE_ID] - 1410) * 500; // 750 + 1,000 + 20,000 = 21,750
    const atUnderlying =
      (UNDERLYING_MARK[OPTION_ID] - 120) * 75 +
      (UNDERLYING_MARK[EQUITY_ID] - 2000) * 10 +
      (UNDERLYING_MARK[FUTURE_ID] - 1410) * 500; // 17,45,750

    // The page never puts the total in a prop: it flows into `terminalPaise`
    // and is STATED in the XIRR footnote. That sentence is the observable.
    const m = /over\s*₹\s*([\d,]+)\s*terminal value/.exec(perfText);
    expect(m, "no terminal-value figure in the rendered performance page").not.toBeNull();
    const stated = Number(m![1].replace(/,/g, ""));

    // The ledger is empty and exactly one trade is closed, so the unrealised
    // leg is the only unknown in the stated terminal value.
    expect(stated - perfCapital - CLOSED_NET_PNL).toBe(unrealised);
    expect(stated - perfCapital - CLOSED_NET_PNL).not.toBe(atUnderlying);
  });

  it("S1e  scanBreaches alerts on the row's own mark — and stays silent on the index spot", () => {
    // With the underlying rung the option's "mark" was 23,450 against a target
    // of 150, so every EOD run raised a breach on a premium that had not moved.
    expect(scanBreaches().find((b) => b.id === OPTION_ID)).toBeUndefined();

    // The CONTROL still fires: TCS at its cash mark 2,100 against target 2,050.
    const eq = scanBreaches().find((b) => b.id === EQUITY_ID)!;
    expect(eq.kind).toBe("target");
    expect(eq.mtm).toBe(TCS_CASH_MARK);

    // …and the number the job actually used, read off the message it writes.
    // A target of 1,440 is BETWEEN the underlying's 1,400 and the contract's
    // 1,450: the fixed rung breaches it, the underlying rung cannot.
    t.sqlite.prepare("UPDATE trades SET target_planned = ? WHERE id = ?").run(1440, FUTURE_ID);
    t.sqlite.prepare("UPDATE trades SET target_planned = ? WHERE id = ?").run(125, OPTION_ID);
    try {
      const fut = scanBreaches().find((b) => b.id === FUTURE_ID)!;
      expect(fut.mtm).toBe(RELIANCE_FUT_MARK);
      expect(fut.message).toContain("mark 1450 has reached your target 1440");

      const opt = scanBreaches().find((b) => b.id === OPTION_ID)!;
      expect(opt.mtm).toBe(EXPECTED_MARK[OPTION_ID]);
      expect(opt.message).toContain("NIFTY: mark 130 has reached your target 125");
      expect(opt.message).not.toContain("mark 23450");
    } finally {
      t.sqlite.prepare("UPDATE trades SET target_planned = NULL WHERE id = ?").run(FUTURE_ID);
      t.sqlite.prepare("UPDATE trades SET target_planned = ? WHERE id = ?").run(150, OPTION_ID);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S2 — the B-5 sentence, byte for byte, across four owners.
 *
 * C2 owns the two card strings, C3 owns the two consent sheets, the help entry
 * and three markdown files. The user reads them within a minute of each other —
 * the radio's footnote, the sheet they accept, and the PRIVACY item behind it —
 * so a paraphrase in any one of them is a different promise about the same row.
 * ══════════════════════════════════════════════════════════════════════════ */
const B5 = UPSTOX_FEED_COPY.equityOnly;
/**
 * The doc surfaces vary the sentence's FIRST LETTER (it follows "Equities this
 * release: " in README.md) and its terminal punctuation (README.md continues
 * "— under either broker source"). Everything between is compared byte for
 * byte, which is what "the same sentence" has to mean here.
 */
const B5_STEM = B5.slice(1).replace(/\.$/, "");
const OLD_B5 = ["last stored mark", "keep the mark already stored", "keeps the mark already stored"];

describe("S2 — the B-5 sentence is ONE literal on every surface that states it", () => {
  it("S2a  both card strings and both consent sheets carry the identical sentence", () => {
    expect(ANGELONE_FEED_COPY.equityOnly).toBe(B5);
    // The sheets prefix "Only equity positions are priced by this feed in this
    // release." and then state the SAME sentence — the acceptance and the
    // footnote under the radio cannot describe the row differently.
    const sheetItem = (items: typeof UPSTOX_FEED_ITEMS) =>
      items.find((i) => i.body.includes("Only equity positions are priced by this feed"))!;
    expect(sheetItem(UPSTOX_FEED_ITEMS).body).toContain(B5);
    expect(sheetItem(ANGELONE_FEED_ITEMS).body).toContain(B5);
    // The row's fallback is STATED, not implied: recorded close, then entry.
    expect(B5).toContain("the position's recorded close, or its entry price when no close is recorded");
  });

  it("S2b  the /live help entry states it for both broker sources", () => {
    const liveEntry = HELP_ENTRIES.find((e) => e.href === "/live")!;
    const upstoxPara = liveEntry.body.find((b) => b.includes("api.upstox.com"))!;
    const angelPara = liveEntry.body.find((b) => b.includes("apiconnect.angelone.in"))!;
    expect(upstoxPara).toContain(B5);
    expect(angelPara).toContain(B5);
  });

  it("S2c  all three shipped markdown files state it, and no surface keeps the old promise", () => {
    for (const rel of ["README.md", "docs/client/README.md", "docs/client/PRIVACY.md"]) {
      expect(plain(readDoc(rel)), `${rel} does not state the B-5 sentence`).toContain(B5_STEM);
    }
    // The phrase B-5 removed named a value nothing writes: no writer stores a
    // CONTRACT-keyed mark, so "the mark already stored" for a derivative does
    // not exist. It must be gone from every surface that states the rule.
    const surfaces: Record<string, string> = {
      "live-feed-card UPSTOX_FEED_COPY.equityOnly": UPSTOX_FEED_COPY.equityOnly,
      "live-feed-card ANGELONE_FEED_COPY.equityOnly": ANGELONE_FEED_COPY.equityOnly,
      "UPSTOX_FEED_ITEMS": UPSTOX_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" "),
      "ANGELONE_FEED_ITEMS": ANGELONE_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" "),
      "help /live": HELP_ENTRIES.find((e) => e.href === "/live")!.body.join(" "),
      "help /settings": HELP_ENTRIES.find((e) => e.href === "/settings")!.body.join(" "),
      "README.md": plain(readDoc("README.md")),
      "docs/client/README.md": plain(readDoc("docs/client/README.md")),
      "docs/client/PRIVACY.md": plain(readDoc("docs/client/PRIVACY.md")),
    };
    for (const [where, text] of Object.entries(surfaces)) {
      for (const old of OLD_B5) {
        expect(text.toLowerCase(), `${where} still promises "${old}"`).not.toContain(old);
      }
    }
  });

  it("S2d  DEFECT (B-5, unfixed): the Angel One adapter's own health sentence still promises it", async () => {
    // The SAME Settings card that prints the B-5 footnote prints the adapter's
    // `health.reason` under it (`feedHealthText` → `Not live — ${reason}`, and
    // the GET publishes `provider.health()` verbatim). So the two halves of
    // this seam are C2's card copy and B2's adapter sentence — and on a book
    // that holds a derivative the card states both promises at once.
    //
    // Only `loginImpl` is injected: that is the BROKER, the far side of the
    // network. The gate, the credentials, the resolver and the counters are the
    // real adapter reading the real database.
    selectAccount(ACCOUNT);
    t.db.delete(t.schema.brokerConnections).run();
    t.db
      .insert(t.schema.brokerConnections)
      .values({
        accountId: ACCOUNT,
        broker: "angelone",
        apiKey: "seam-api-key",
        accessToken: "",
        authJson: JSON.stringify({ clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" }),
      })
      .run();
    t.db.update(t.schema.settings).set({ liveFeedAckJson: withFeedAck(null, "angelone") }).run();

    const provider = angelone.createAngelOneProvider({
      loginImpl: async () => ({ jwtToken: "seam-jwt" }),
      sleep: async () => {},
    });
    // One DERIVATIVE key: `angelCashKey()` returns null for it, so it is
    // skipped, no token is ever sent, and `health()` describes what the row
    // shows instead.
    await provider.snapshot([{ symbol: "NIFTY", exchange: "NFO", tradingsymbol: OPT_TRADINGSYMBOL }]);
    const health = (await provider.health()) as { ok: boolean; reason: string };

    expect(health.reason).toContain("not priced by this feed");
    // ⛔ RED ON PURPOSE — a reported seam defect, not a fix.
    // lib/quotes/angelone.ts:750 still ends that sentence with "and keep their
    // last stored mark."; lib/quotes/upstox.ts:571 has the identical tail. The
    // right value is the B-5 wording every other surface now uses: "each shows
    // the position's recorded close, or its entry price when no close is
    // recorded". The wave's builder fixes it; this test is the proof it reaches
    // the screen.
    expect(health.reason.toLowerCase()).not.toContain("last stored mark");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S3 — the cadence NOUN. C2 changed the sentence, C3 changed the prose that
 * explains it; the count in both is the DEDUPED scrip count, never the row
 * count, so "positions" is a false statement about the user's book (B-6).
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S3 — the cadence line and the prose count the same thing", () => {
  it("S3a  angelOneCadenceLine(50) says scrips, and says the whole sentence", () => {
    expect(angelOneCadenceLine(50)).toBe(
      "Refreshes every 3 seconds — Angel One allows about one request a second, and your 50 open scrips take 1 call per refresh.",
    );
    // The singular is the same noun, and the tier edge is still the KEY count.
    expect(angelOneCadenceLine(1)).toContain("1 open scrip takes");
    expect(angelOneCadenceLine(51)).toContain("51 open scrips take 2 calls");
    expect(angelOneCadenceLine(50)).not.toContain("open positions");
  });

  it("S3b  the help tier line and both READMEs count scrips too", () => {
    const angelPara = HELP_ENTRIES.find((e) => e.href === "/live")!.body.find((b) =>
      b.includes("apiconnect.angelone.in"),
    )!;
    expect(angelPara).toContain("3 seconds up to 50 scrips");
    expect(angelPara).not.toContain("up to 50 open positions");

    expect(plain(readDoc("README.md"))).toContain("3 seconds up to 50 scrips");
    expect(plain(readDoc("docs/client/README.md"))).toContain("3 seconds up to 50 scrips");
  });

  it("S3c  DEFECT (B-6, unfixed): the countless sentence still says the interval comes from positions", () => {
    // Same surface, same card, same fact: the interval is arithmetic over the
    // deduped SCRIP count (`angelOneCadenceSeconds` is fed `openPositionKeys()`
    // on the card and the stream's own `symbols` on the desk). The no-count
    // branch states it is computed from "the positions this feed prices", which
    // is the very noun B-6 corrected one function below it.
    expect(ANGELONE_CADENCE_NO_COUNT).toContain("Angel One allows about one request a second");
    // ⛔ RED ON PURPOSE — components/live/desk-copy.ts:306.
    // WRONG: "Refreshes on an interval computed from the positions this feed prices"
    // RIGHT: "…computed from the scrips this feed prices" (B-6's own noun).
    expect(ANGELONE_CADENCE_NO_COUNT).not.toContain("positions this feed prices");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S4 — B-8: ONE release flag, three consumers that must agree about it.
 *
 * The flag is the only input that can show this seam, and this build has it
 * true in all three places, so the defect it fixes is invisible without it.
 * `vi.doMock` + `vi.resetModules()` re-imports the REAL route, the REAL
 * registry and the REAL card under the flag OFF; `lib/db` keeps its connection
 * on `globalThis`, so the re-imported graph reads the same temp database.
 * ══════════════════════════════════════════════════════════════════════════ */
/**
 * Run `fn` against the REAL route, registry and card, re-imported with the ONE
 * release flag off. `lib/db` caches its connection on `globalThis`, so the
 * re-imported graph reads the very same temp database this file seeded.
 */
async function withAngelOneWithheld(
  fn: (mods: {
    offRoute: typeof import("@/app/api/live/feed/route");
    offRegistry: typeof import("@/lib/quotes/registry");
    offCard: typeof import("@/components/settings/live-feed-card");
  }) => Promise<void>,
): Promise<void> {
  vi.doMock("@/lib/quotes/types", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/quotes/types")>()),
    ANGELONE_FEED_ENABLED: false,
  }));
  vi.resetModules();
  try {
    await fn({
      offRoute: await import("@/app/api/live/feed/route"),
      offRegistry: await import("@/lib/quotes/registry"),
      offCard: await import("@/components/settings/live-feed-card"),
    });
  } finally {
    vi.doUnmock("@/lib/quotes/types");
    vi.resetModules();
    // The beforeAll instances survive a reset; re-point the shared cache so no
    // later test is served a provider built under the mocked flag.
    registry.resetLiveFeedProviderCache();
  }
}

describe("S4 — a withheld provider is refused by the route, the picker and the card alike", () => {
  it("S4a  with ANGELONE_FEED_ENABLED true this build accepts the ack, offers the button and runs the feed", async () => {
    selectAccount(ACCOUNT);
    t.db.delete(t.schema.brokerConnections).run();
    setFeed("angelone", withFeedAck(null, "angelone"));

    // 1. the route's `ack` enum
    expect((await post({ action: "ack", provider: "angelone" })).status).toBe(200);
    // 2. the card's "Review and accept" control
    const offered = PROVIDERS.map((p) => p.id);
    expect(offered).toContain("angelone");
    expect(
      feedBlockState({ stored: "angelone", effective: "eod", refreshSeconds: 3, blockedReason: "x" }, offered)!
        .reviewProvider,
    ).toBe("angelone");
    // 3. the picker
    expect((await registry.resolveLiveFeed()).effective).toBe("angelone");
    expect(
      registry.selectProviderId({
        liveFeedProvider: "angelone",
        openalgoEnabled: false,
        openalgoAckVersion: null,
        liveFeedAckJson: withFeedAck(null, "angelone"),
      }),
    ).toBe("angelone");
  });

  it("S4b  with the flag OFF the route refuses the ack and the card withholds the button", async () => {
    selectAccount(ACCOUNT);
    // The B-8 scenario, exactly: the stored pick travels in a backup envelope,
    // the acknowledgement is machine state and does NOT — so the restored
    // install holds `liveFeedProvider = "angelone"` with no ack at all.
    setFeed("angelone", null);

    await withAngelOneWithheld(async ({ offRoute, offRegistry, offCard }) => {
      // 1. THE ROUTE — the ack action is narrowed by ACKABLE, so nothing is written.
      const res = await offRoute.POST(
        new Request("http://127.0.0.1:3011/api/live/feed", {
          method: "POST",
          headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
          body: JSON.stringify({ action: "ack", provider: "angelone" }),
        }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain("not offered in this build");
      // …and the upstox ack, which this build still offers, is untouched.
      const okRes = await offRoute.POST(
        new Request("http://127.0.0.1:3011/api/live/feed", {
          method: "POST",
          headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
          body: JSON.stringify({ action: "ack", provider: "upstox" }),
        }),
      );
      expect(okRes.status).toBe(200);

      // 2. THE PICKER — with no acknowledgement the withheld pick is not
      //    effective, which is what makes the card state a block at all.
      const feed = await offRegistry.resolveLiveFeed();
      expect(feed.stored).toBe("angelone");
      expect(feed.effective).toBe("eod");

      // 3. THE CARD — the block is still STATED (the pick really is not
      //    running, and the user is entitled to know), but the control that
      //    would open a withheld provider's sheet is gone. Before B-8 this
      //    button rendered, opened the sheet and recorded an acknowledgement
      //    for a feed with no radio.
      const offeredIds = offCard.PROVIDERS.map((p) => p.id);
      expect(offeredIds).not.toContain("angelone");
      const block = offCard.feedBlockState(feed as FeedState, offeredIds)!;
      expect(block.reason).toBe(feed.blockedReason);
      expect(block.reviewProvider).toBeNull();
      // The control IS offered for a provider this build still ships.
      expect(
        offCard.feedBlockState(
          { stored: "upstox", effective: "eod", refreshSeconds: 3, blockedReason: "x" },
          offeredIds,
        )!.reviewProvider,
      ).toBe("upstox");
    });
  });

  it("S4c  DEFECT (registry): with the flag OFF a CURRENT ack still makes the withheld feed effective", async () => {
    selectAccount(ACCOUNT);
    // The other half of the same state: someone who accepted the sheet on a
    // build that offered Angel One, then moved to a build that withholds it.
    // The ack column is untouched by the flag.
    setFeed("angelone", withFeedAck(null, "angelone"));

    await withAngelOneWithheld(async ({ offRegistry, offCard }) => {
      const feed = await offRegistry.resolveLiveFeed();
      const offeredIds = offCard.PROVIDERS.map((p) => p.id);

      // The card has no radio for it and — because stored === effective —
      // no block either, so this state is stated NOWHERE on the screen…
      expect(offeredIds).not.toContain("angelone");
      // …while the provider the desk actually builds is the PLANNED stub,
      // whose sentence names a source-file constant to a paying customer.
      const built = offRegistry.createProvider(feed.effective);
      const health = await built.health();

      // ⛔ RED ON PURPOSE — a reported seam defect, not a fix.
      // lib/quotes/registry.ts:246 `selectProviderId()`.
      //   WRONG: selectProviderId({liveFeedProvider:"angelone",
      //          liveFeedAckJson:'{"angelone":"1"}'}) === "angelone" with
      //          ANGELONE_FEED_ENABLED false, so resolveLiveFeed() answers
      //          {stored:"angelone", effective:"angelone"} and no blockedReason.
      //   RIGHT: "eod" (DEFAULT_PROVIDER_ID) — a withheld id must never be
      //          effective, exactly as `openalgo` collapses when its own
      //          constant is false. `resolveProviderId()` keeps `upstox` and
      //          `angelone` because they are in PLANNABLE_IDS, so they survive
      //          into ALL_IDS as PLANNED ids instead of being collapsed.
      //   The promise this breaks is written at lib/quotes/types.ts:74-82:
      //   "a stored `live_feed_provider = 'upstox'` collapses to the
      //   end-of-day default again." It does not.
      expect(feed.effective).toBe("eod");
      expect(offCard.feedBlockState(feed as FeedState, offeredIds)).not.toBeNull();
      expect(health.reason ?? "").not.toContain("ANGELONE_FEED_ENABLED");
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S5 — B-4: the write's OWN answer, folded into the card's state.
 *
 * The card is mounted unkeyed, so `router.refresh()` re-renders it with the
 * state it already had and nothing else ever corrects `status`. C2 made the
 * POST body the correction; the body is built by the REAL route out of
 * `resolveLiveFeed()`. Both halves run here — no fixture response anywhere.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S5 — the route's POST body clears the card's block without a second fetch", () => {
  it("S5a  Review and accept → ack → store: the block and the health line both go", async () => {
    selectAccount(ACCOUNT);
    t.db.delete(t.schema.brokerConnections).run();
    t.db
      .insert(t.schema.brokerConnections)
      .values({ accountId: ACCOUNT, broker: "angelone", apiKey: "k", accessToken: "", authJson: "{}" })
      .run();
    // Stored pick with NO acknowledgement — the blocked state, from the real
    // resolver, published by the real GET the card mounts with.
    setFeed("angelone", null);

    const prev = (await (await get()).json()) as unknown as FeedResponse & FeedBody;
    expect(prev.feed!.stored).toBe("angelone");
    expect(prev.feed!.effective).toBe("eod");
    const blockedBefore = feedBlockState(prev.feed as FeedState)!;
    expect(blockedBefore.reason).toContain("accept");
    expect(
      feedHealthText({ health: prev.health, blocked: true, lastLiveMarkDate: prev.lastLiveMarkDate }),
    ).toContain("blocked");

    // The card's own two POSTs, in the card's own order.
    const ackRes = await post({ action: "ack", provider: "angelone" });
    expect(ackRes.status).toBe(200);
    const afterAck = foldFeedResponse(prev, (await ackRes.json()) as never)!;
    // The ack body carries no `feed` key, and a missing key is "nothing new to
    // say", never "no longer true" — the verdict is unchanged by the fold.
    expect(afterAck.feed).toEqual(prev.feed);

    const storeRes = await post({ action: "provider", provider: "angelone" });
    expect(storeRes.status).toBe(200);
    const afterStore = foldFeedResponse(afterAck, (await storeRes.json()) as never)!;

    // THE CONSUMER'S OUTPUT: no block, and a health line that no longer says
    // the feed is blocked — without the page being reloaded or refetched.
    expect(afterStore.feed).toEqual({ stored: "angelone", effective: "angelone", refreshSeconds: 3 });
    expect(feedBlockState(afterStore.feed as FeedState)).toBeNull();
    expect(
      feedHealthText({
        health: prev.health,
        blocked: feedBlockState(afterStore.feed as FeedState) != null,
        lastLiveMarkDate: prev.lastLiveMarkDate,
      }),
    ).not.toContain("blocked");
  });

  it("S5b  the switch-away case: a blocked OpenAlgo pick, switched to end-of-day, stops saying it is blocked", async () => {
    selectAccount(ACCOUNT);
    // OpenAlgo picked, integration off — blocked by its own gate.
    setFeed("openalgo", null, false);

    const prev = (await (await get()).json()) as unknown as FeedResponse & FeedBody;
    expect(prev.feed!.stored).toBe("openalgo");
    expect(prev.feed!.effective).toBe("eod");
    expect(feedBlockState(prev.feed as FeedState)).not.toBeNull();

    const res = await post({ action: "provider", provider: "eod" });
    expect(res.status).toBe(200);
    const after = foldFeedResponse(prev, (await res.json()) as never)!;

    // The v4.1 regression this reproduces: the eod radio checked AND a block
    // still saying the pick is blocked, until the user reloaded the page.
    expect(after.feed!.stored).toBe("eod");
    expect(after.feed!.effective).toBe("eod");
    expect(feedBlockState(after.feed as FeedState)).toBeNull();
    expect(
      feedHealthText({ health: prev.health, blocked: false, lastLiveMarkDate: prev.lastLiveMarkDate }),
    ).not.toContain("blocked");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S6 — the egress PIN and the sheet it pins. The orchestrator shortened the
 * pin in `tests/quotes-egress-guard.test.ts`; C3 rewrote the paragraph it
 * points at, in the same wave, in a different file. The pin is read out of the
 * guard rather than restated, so a later edit to either side is caught.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S6 — PRIVACY item 3's Angel One paragraph still satisfies its own guard", () => {
  /** The prose of PRIVACY.md — the audit block is an HTML comment and is not it. */
  const privacyBody = () => readDoc("docs/client/PRIVACY.md").split("<!--")[0];
  const angelParagraph = () => {
    const body = privacyBody();
    const start = body.indexOf("Angel One can price the desk instead");
    const end = body.indexOf("Your credentials are encrypted at rest", start);
    expect(start, "item 3's Angel One paragraph is gone from PRIVACY.md").toBeGreaterThan(-1);
    expect(end, "the paragraph's end marker is gone from PRIVACY.md").toBeGreaterThan(start);
    return plain(body.slice(start, end));
  };

  it("S6a  the paragraph carries the guard's pin, the B-7 clause, and names the host exactly once", () => {
    const guard = readDoc("tests/quotes-egress-guard.test.ts");
    const pin = /"apiconnect\.angelone\.in":\s*"((?:[^"\\]|\\.)*)"/.exec(guard)?.[1];
    expect(pin, "the egress guard no longer pins a sentence for apiconnect.angelone.in").toBeTruthy();

    const para = angelParagraph();
    // The guard normalises the whole file the same way and asserts `includes`.
    expect(para).toContain(pin!);
    // B-7: the honest ceiling, not a calendar promise nothing enforces.
    expect(para).toContain(
      "at most once a day while it stays open, and again after a relaunch or when you re-save the credentials",
    );
    expect(para).not.toContain("signs in once a day to Angel One");
    // ONE naming of the host in this paragraph: the second reference is "that
    // same host", so a reader counts one endpoint, which is the claim.
    expect(para.match(/apiconnect\.angelone\.in/g)!.length).toBe(1);
  });

  it("S6b  the same pin still matches the file the guard actually reads, whitespace-normalised", () => {
    const guard = readDoc("tests/quotes-egress-guard.test.ts");
    const pin = /"apiconnect\.angelone\.in":\s*"((?:[^"\\]|\\.)*)"/.exec(guard)![1];
    // The guard's own normalisation, replicated (`PRIVACY_COVERED` is a test
    // constant and is not exported).
    const flat = readDoc("docs/client/PRIVACY.md").replace(/\s+/g, " ");
    expect(flat).toContain(pin);
    // …and the same for the Upstox pin, so the pair is proved together.
    const upstoxPin = /"api\.upstox\.com":\s*"((?:[^"\\]|\\.)*)"/.exec(guard)![1];
    expect(flat).toContain(upstoxPin);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S7 — a guard OF a guard. C4 declared eight owners of `broker_connections`
 * and two deliberate whole-database sweeps; C2 owns two of the eight. The
 * property is recomputed here from the filesystem, independently of C4's own
 * lists, so a ninth reader added by a later wave cannot pass by being declared.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S7 — every reader of broker_connections resolves an account, or is one of two named sweeps", () => {
  it("S7a  the exemption set is exactly {lib/jobs/auto-pull.ts, lib/vault.ts}", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel, out);
        else if (/\.tsx?$/.test(e.name)) out.push(rel);
      }
      return out;
    };
    const readers = ["lib", "app"]
      .flatMap((d) => walk(d))
      .filter((rel) => readDoc(rel).includes(".from(brokerConnections)"))
      .sort();

    // A floor: a sweep that finds nothing passes for the wrong reason.
    expect(readers.length, "no file selects broker_connections — has the table been renamed?").toBeGreaterThanOrEqual(9);
    // The two readers this wave's C2 file set added must be in the scan.
    expect(readers).toContain("app/api/live/feed/route.ts");
    expect(readers).toContain("lib/quotes/registry.ts");

    const unscoped = readers.filter((rel) => {
      const src = readDoc(rel);
      return !/getSelectedAccountId\(\)/.test(src) && !/getWriteAccountId\(/.test(src);
    });
    expect(unscoped).toEqual(["lib/jobs/auto-pull.ts", "lib/vault.ts"]);

    // …and every reader is named in the isolation guard, as an owner or as one
    // of those two sweeps. An undeclared reader is never scanned for invariant
    // 8, which is the hole B-9 closed and this recomputation keeps closed.
    const isolation = readDoc("tests/account-isolation.test.ts");
    for (const rel of readers) {
      expect(isolation, `${rel} reads broker_connections but is not named in the isolation guard`).toContain(
        `"${rel}"`,
      );
    }
  });
});
