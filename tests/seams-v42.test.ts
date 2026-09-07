import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/* ─────────────────────────────────────────────────────────────────────────────
 * SEAM TESTS — v4.2 wave (Upstox live feed, exchange holidays).
 *
 * Four builders owned DISJOINT file sets, so nothing in the wave ran the two
 * halves of a crossing value together. Every test below builds the value where
 * its PRODUCER builds it (the real function, never a literal), hands it across
 * exactly as the product does (a JSON request body, a settings column, a React
 * prop, a QuoteKey), and asserts the CONSUMER'S OUTPUT.
 *
 * Ownership: A = lib/quotes/* + lib/domain/live-feed-disclosure.ts + schema
 *            B = components/settings/live-feed-card.tsx,
 *                components/system/feed-consent-dialog.tsx,
 *                app/api/live/feed/route.ts
 *            C = lib/domain/trading-day.ts, lib/live/*, lib/analytics/data-quality.ts,
 *                components/live/*
 *            D = docs/client/PRIVACY.md, tests/quotes-egress-guard.test.ts
 *            E = lib/backup-format.ts (CONCURRENT — not this wave's file)
 *
 * ── THE CROSSING VALUES ──────────────────────────────────────────────────────
 *
 * # | value                | producer (file:line)                         | consumer (file:line)                           | unit / shape             | test
 * --|----------------------|----------------------------------------------|------------------------------------------------|--------------------------|------
 * 1 | live_feed_ack_json   | B app/api/live/feed/route.ts:226 withFeedAck  | A lib/quotes/registry.ts:~205 liveFeedAckGate   | TEXT, JSON id→version    | S1
 * 2 | connected+ackCurrent | B route.ts:136 upstoxState/:152 upstoxRefusal | B live-feed-card.tsx:118 upstoxRowState        | two booleans             | S2
 * 3 | disclosure version   | A live-feed-disclosure.ts:47 VERSIONS.upstox  | B feed-consent-dialog.tsx:79 (rendered)        | string "1", strict ===   | S3
 * 4 | UPSTOX_FEED_ITEMS    | A live-feed-disclosure.ts:76                  | B feed-consent-dialog.tsx:83 (rendered <ul>)   | DisclosureItem[]         | S3
 * 5 | QuoteKey → sent?     | A lib/quotes/upstox.ts:262 planUpstoxKeys     | C components/live/desk-copy.ts:220             | instrumentType string    | S4
 * 6 | ISO IST date         | C trading-day.ts:71 isExchangeHoliday         | C market-hours.ts:54 / A persist-mark.ts:138 / | YYYY-MM-DD, IST day      | S5
 *   |                      |                                              | C stream-link.ts:157                           |                          |
 * 7 | egressDescription    | A lib/quotes/upstox.ts:102                    | D docs/client/PRIVACY.md item 3                | hostnames                | S6
 * 8 | CONNECTABLE ids      | C lib/live/connect-prompt.ts:71               | B live-feed-card.tsx:167 PROVIDERS             | provider id strings      | S7
 * 9 | settings column name | A lib/db/schema.ts:915 liveFeedAckJson        | E lib/backup-format.ts:86                      | drizzle key              | S8
 * 10| instrumentType       | A persist-mark.ts:235 isCashKey              | C data-quality.ts:64 unmarked_open             | "equity"|"option"|…      | S9
 *
 * ONE temp database for the whole file (lib/db caches its connection on
 * globalThis — AGENTS.md). Everything server-only is imported DYNAMICALLY
 * inside `beforeAll`, after the helper has set `VYUHA_DB_PATH`.
 * ────────────────────────────────────────────────────────────────────────── */

/* pure modules — safe to import statically, none of them reaches lib/db */
import {
  LIVE_FEED_DISCLOSURE_VERSIONS,
  UPSTOX_FEED_ITEMS,
  isFeedAckCurrent,
  parseFeedAcks,
  withFeedAck,
} from "@/lib/domain/live-feed-disclosure";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { FeedConsentDialog } from "@/components/system/feed-consent-dialog";
import {
  PROVIDERS,
  UPSTOX_FEED_COPY,
  upstoxRowState,
} from "@/components/settings/live-feed-card";
import { CONNECTABLE_PROVIDER_IDS, showConnectPrompt } from "@/lib/live/connect-prompt";
import { CONNECT_PROMPT_COPY, NOT_PRICED_BY_FEED, showsNotPricedByFeed } from "@/components/live/desk-copy";
import {
  NSE_HOLIDAY_YEAR,
  exchangeHolidayName,
  isExchangeHoliday,
  isTradingDayIst,
} from "@/lib/domain/trading-day";
import { isMarketOpenIst } from "@/lib/live/market-hours";
import { msUntilCloseReopen } from "@/lib/live/stream-link";
import { assessDataQuality } from "@/lib/analytics/data-quality";
// TYPE-ONLY: erased at compile time, so it does not bind the server-only
// module (or lib/db behind it) before openTempDb() sets VYUHA_DB_PATH.
import type { UpstoxGetter, UpstoxHealth } from "@/lib/quotes/upstox";
import { SETTINGS_MACHINE_COLUMNS, settingsMachineBlank } from "@/lib/backup-format";
import nseHolidays from "@/lib/data/nse-holidays.json";

let t: TempDb;
let route: typeof import("@/app/api/live/feed/route");
let registry: typeof import("@/lib/quotes/registry");
let upstox: typeof import("@/lib/quotes/upstox");
let angelTokens: typeof import("@/lib/quotes/angelone-tokens");
let persistMark: typeof import("@/lib/quotes/persist-mark");
let dataQualityQuery: typeof import("@/lib/queries/data-quality");

const ACCOUNT = 2;

/** The account whose book both halves of seam 4/9/10 are read from. */
const ROWS = [
  { symbol: "RELIANCE", tradingsymbol: "RELIANCE", exchange: "NSE", instrumentType: "equity" },
  { symbol: "TCS", tradingsymbol: "TCS", exchange: "NSE", instrumentType: "equity" },
  { symbol: "RELIANCE", tradingsymbol: "RELIANCE26SEP3000CE", exchange: "NFO", instrumentType: "option" },
  { symbol: "INFY", tradingsymbol: "INFY26SEPFUT", exchange: "NFO", instrumentType: "future" },
  // A CASH scrip no bundled ISIN source knows: the adapter cannot send it and
  // the desk does not label it — the third bucket seam 4 has to account for.
  { symbol: "ZZQQNOTLISTED", tradingsymbol: "ZZQQNOTLISTED", exchange: "NSE", instrumentType: "equity" },
] as const;

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
      // The wire really is a JSON string — the seam is crossed the way the card
      // crosses it, not by calling the handler's inner function.
      body: JSON.stringify(body),
    }),
  );
}

function get(): Promise<Response> {
  return route.GET(
    new Request("http://127.0.0.1:3011/api/live/feed", { headers: { host: "127.0.0.1:3011" } }),
  );
}

function ackColumn(): string | null {
  return t.db.select().from(t.schema.settings).limit(1).all()[0]?.liveFeedAckJson ?? null;
}

function setAck(value: string | null) {
  t.db.update(t.schema.settings).set({ liveFeedAckJson: value }).run();
}

function setProvider(value: string) {
  t.db.update(t.schema.settings).set({ liveFeedProvider: value }).run();
}

function connectUpstox(accountId = ACCOUNT) {
  t.db
    .insert(t.schema.brokerConnections)
    .values({ accountId, broker: "upstox", apiKey: "venc:test", accessToken: "venc:test" })
    .onConflictDoNothing()
    .run();
}

function disconnectUpstox() {
  t.db.delete(t.schema.brokerConnections).run();
}

beforeAll(async () => {
  t = await openTempDb("seams-v42", { seed: true });
  route = await import("@/app/api/live/feed/route");
  registry = await import("@/lib/quotes/registry");
  upstox = await import("@/lib/quotes/upstox");
  angelTokens = await import("@/lib/quotes/angelone-tokens");
  persistMark = await import("@/lib/quotes/persist-mark");
  dataQualityQuery = await import("@/lib/queries/data-quality");

  t.db.insert(t.schema.accounts).values([{ id: ACCOUNT, name: "Swing" }]).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: ACCOUNT }).run();
  t.db
    .insert(t.schema.trades)
    .values(
      ROWS.map((r) =>
        tradeRow({
          accountId: ACCOUNT,
          symbol: r.symbol,
          tradingsymbol: r.tradingsymbol,
          exchange: r.exchange,
          instrumentType: r.instrumentType,
          segment: r.exchange === "NFO" ? "fno_option" : "eq_delivery",
          isOpen: true,
          buyQty: 10,
          avgBuyPrice: 100,
          closingPrice: null,
        }),
      ),
    )
    .run();
});

afterAll(() => {
  vi.useRealTimers();
  t?.cleanup();
});

/* ═══════════════════ SEAM 1 — B's ack write ↔ A's registry ═══════════════════
 * The ONLY thing that connects them is the text in `settings.live_feed_ack_json`.
 * B writes it with `withFeedAck()`; A reads it with `isFeedAckCurrent()` (===).
 * Nothing else on either side names the shape, so a renamed key or a bare `true`
 * would leave both files green and the feed permanently on end-of-day prices.
 */
describe("S1 — the acknowledgement the route writes is the one resolveLiveFeed() reads", () => {
  it("no ack → POST refuses 409 and the feed resolves to end-of-day", async () => {
    setAck(null);
    setProvider("eod");
    connectUpstox();

    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(409);
    expect(ackColumn()).toBeNull();

    // The picker value the route refused to store is not the feed either way.
    setProvider("upstox");
    const feed = await registry.resolveLiveFeed();
    expect(feed.stored).toBe("upstox");
    expect(feed.effective).toBe("eod");
    expect(feed.blockedReason).toContain("has not been accepted on this machine");
  });

  it("POST ack → the column carries THIS build's version and the feed becomes upstox", async () => {
    setAck(null);
    setProvider("eod");

    const ack = await post({ action: "ack", provider: "upstox" });
    expect(ack.status).toBe(200);

    // The column, read back raw and parsed by the CONSUMER's own parser.
    const stored = ackColumn();
    expect(parseFeedAcks(stored)).toEqual({ upstox: LIVE_FEED_DISCLOSURE_VERSIONS.upstox });
    expect(isFeedAckCurrent(stored, "upstox")).toBe(true);

    const pick = await post({ action: "provider", provider: "upstox" });
    expect(pick.status).toBe(200);

    const feed = await registry.resolveLiveFeed();
    expect(feed.stored).toBe("upstox");
    expect(feed.effective).toBe("upstox");
    expect(feed.blockedReason).toBeUndefined();
  });

  it("a version that is not this build's — '0' — is no consent on either side", async () => {
    setAck(JSON.stringify({ upstox: "0" }));
    setProvider("upstox");

    expect(registry.liveFeedAckGate(ackColumn(), "upstox").allowed).toBe(false);
    const feed = await registry.resolveLiveFeed();
    expect(feed.stored).toBe("upstox");
    expect(feed.effective).toBe("eod");

    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      message: "Read what the Upstox feed does and accept it first — until then the desk stays on end-of-day prices.",
    });
  });

  it("accepting Upstox does not withdraw another provider's acceptance", async () => {
    setAck(JSON.stringify({ angelone: "1" }));
    await post({ action: "ack", provider: "upstox" });
    expect(parseFeedAcks(ackColumn())).toEqual({
      angelone: "1",
      upstox: LIVE_FEED_DISCLOSURE_VERSIONS.upstox,
    });
  });
});

/* ═══════════ SEAM 2 — the card's row state ↔ the route's refusal ═══════════
 * The card decides whether the radio is dead; the route decides whether the
 * pick is stored. They read the SAME two facts out of the SAME GET body. If
 * they disagree about WHICH half is missing, the user is told the wrong next
 * step — a dead radio saying "add Upstox" while the real blocker is the sheet.
 */
describe("S2 — the card and the route never disagree about which half is missing", () => {
  it("no connection → the card kills the row AND the route names the connection", async () => {
    disconnectUpstox();
    setAck(null);
    setProvider("eod");

    const body = (await (await get()).json()) as { upstox: { connected: boolean; ackCurrent: boolean } };
    expect(body.upstox).toEqual({ connected: false, ackCurrent: false, disclosureVersion: LIVE_FEED_DISCLOSURE_VERSIONS.upstox });

    const row = upstoxRowState(body.upstox);
    expect(row.disabled).toBe(true);
    expect(row.line).toBe(UPSTOX_FEED_COPY.notConnected);

    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("No Upstox connection is saved for this account");
    expect(t.db.select().from(t.schema.settings).limit(1).all()[0]?.liveFeedProvider).toBe("eod");
  });

  it("connected but unread → the row is ALIVE and the route refuses on the SHEET, not the connection", async () => {
    connectUpstox();
    setAck(null);

    const body = (await (await get()).json()) as { upstox: { connected: boolean; ackCurrent: boolean } };
    expect(body.upstox.connected).toBe(true);
    expect(body.upstox.ackCurrent).toBe(false);

    const row = upstoxRowState(body.upstox);
    // Alive, because the card's next step here is the consent sheet, not a
    // dead control telling the user to go and add a connection they have.
    expect(row.disabled).toBe(false);
    expect(row.line).toBe(UPSTOX_FEED_COPY.blurb);

    const message = (await (await post({ action: "provider", provider: "upstox" })).json()).message as string;
    expect(message).not.toContain("Import → Connect broker");
    expect(message).toContain("Read what the Upstox feed does");
  });

  it("every state the card renders ENABLED is stored by the route once the sheet is accepted", async () => {
    connectUpstox(); // no-op if the unique index already holds one
    await post({ action: "ack", provider: "upstox" });

    const body = (await (await get()).json()) as { upstox: { connected: boolean; ackCurrent: boolean } };
    expect(upstoxRowState(body.upstox).disabled).toBe(false);
    expect(body.upstox.ackCurrent).toBe(true);

    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(200);
    expect(t.db.select().from(t.schema.settings).limit(1).all()[0]?.liveFeedProvider).toBe("upstox");
  });

  it("the card offers exactly the ids the route will parse", async () => {
    const body = (await (await get()).json()) as { providers: { id: string }[] };
    expect(body.providers.map((p) => p.id).sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
  });
});

/* ══════ SEAM 3 — A's disclosure ↔ B's dialog ↔ the version B persists ══════
 * `FeedConsentDialog` knows no provider: the items and the version arrive as
 * PROPS. So "the sheet the user read is the statement the server stored" is a
 * property of the two halves together and of nothing either half can see. The
 * component is CALLED (it holds no hooks) and its element tree is walked —
 * the real output, not its source text.
 */
type AnyElement = { props?: Record<string, unknown> };

function walk(node: unknown, texts: string[], testids: string[]): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, texts, testids);
    return;
  }
  if (typeof node === "object" && "props" in (node as AnyElement)) {
    const props = ((node as AnyElement).props ?? {}) as Record<string, unknown>;
    const id = props["data-testid"];
    if (typeof id === "string") testids.push(id);
    walk(props.children, texts, testids);
  }
}

function renderConsentSheet() {
  const texts: string[] = [];
  const testids: string[] = [];
  walk(
    FeedConsentDialog({
      open: true,
      onOpenChange: () => {},
      onAccept: () => {},
      title: "Before Upstox prices your desk",
      version: LIVE_FEED_DISCLOSURE_VERSIONS.upstox,
      items: UPSTOX_FEED_ITEMS,
      testId: "upstox-feed-dialog",
    }),
    texts,
    testids,
  );
  // `text` separates sibling strings so a phrase cannot be assembled by
  // accident; `tight` is how the DOM concatenates them (`Disclosure v` and
  // `{version}` are one sentence split across two children).
  return { text: texts.join(" | "), tight: texts.join(""), testids };
}

describe("S3 — the sheet on screen is the statement the server stores", () => {
  it("renders every Upstox item and none of OpenAlgo's", () => {
    const { text, testids } = renderConsentSheet();
    expect(testids).toEqual(
      expect.arrayContaining(["upstox-feed-dialog", "upstox-feed-dialog-items", "upstox-feed-dialog-accept"]),
    );
    for (const item of UPSTOX_FEED_ITEMS) {
      expect(text).toContain(item.title);
      expect(text).toContain(item.body);
    }
    for (const item of OPENALGO_FEED_ITEMS) expect(text).not.toContain(item.body);
  });

  it("the version it shows is the version the route persists and the registry requires", async () => {
    setAck(null);
    await post({ action: "ack", provider: "upstox" });
    const persisted = parseFeedAcks(ackColumn()).upstox;

    // On screen …
    expect(renderConsentSheet().tight).toContain(`Disclosure v${persisted}`);
    // … in the column …
    expect(persisted).toBe(LIVE_FEED_DISCLOSURE_VERSIONS.upstox);
    // … and at the gate, which compares with ===.
    expect(registry.liveFeedAckGate(ackColumn(), "upstox").allowed).toBe(true);
  });

  it("a sheet accepted at any OTHER version is refused — the bump really re-asks", () => {
    const bumped = `${Number(LIVE_FEED_DISCLOSURE_VERSIONS.upstox) + 1}`;
    // The value a PREVIOUS build's dialog would have written, and the value a
    // FUTURE build's would: neither is this build's statement.
    for (const version of ["0", bumped, "true"]) {
      const stale = JSON.stringify({ upstox: version });
      expect(isFeedAckCurrent(stale, "upstox")).toBe(false);
      expect(registry.liveFeedAckGate(stale, "upstox").allowed).toBe(false);
      expect(
        registry.selectProviderId({
          liveFeedProvider: "upstox",
          openalgoEnabled: false,
          openalgoAckVersion: null,
          liveFeedAckJson: stale,
        }),
      ).toBe("eod");
    }
    // …and only the sheet's own version passes all three.
    const fresh = withFeedAck(null, "upstox");
    expect(
      registry.selectProviderId({
        liveFeedProvider: "upstox",
        openalgoEnabled: false,
        openalgoAckVersion: null,
        liveFeedAckJson: fresh,
      }),
    ).toBe("upstox");
  });
});

/* ═══════ SEAM 4 — what A's adapters refuse to send ↔ what C's desk labels ═══
 * Two files, two vocabularies for one fact: A classifies a QuoteKey
 * (exchange + tradingsymbol), C classifies the journal's `instrumentType`
 * string. Ruling 4.2-8 requires the two partitions to be the SAME partition.
 * The keys come out of `openPositionKeys()` — the real book, not literals.
 *
 * BOTH BROKER FEEDS CROSS THIS SEAM (fix A-10). `showsNotPricedByFeed()` labels
 * a row under `upstox` AND under `angelone`, so the partition has to hold for
 * each adapter separately — and the two adapters refuse on DIFFERENT grounds:
 * Upstox needs an ISIN and drops a cash scrip it has none for, while Angel One
 * resolves by name and instead reports that scrip as UNRESOLVED. This block ran
 * only the Upstox half until the v4.2 fix wave, so the label's second provider
 * was crossing an untested seam.
 */
describe("S4 — no row is both unsent and unexplained, none both sent and labelled", () => {
  it("the derivative rows the adapter drops are exactly the rows the desk labels", async () => {
    const keys = await persistMark.openPositionKeys();
    expect(keys).toHaveLength(ROWS.length);

    const plan = upstox.planUpstoxKeys(keys);
    const scripOf = (k: { exchange: string; symbol: string; tradingsymbol?: string }) =>
      `${k.exchange}:${(k.tradingsymbol ?? k.symbol).toUpperCase()}`;

    const droppedAsDerivative = new Set(plan.skippedDerivatives.map(scripOf));
    const sent = new Set([...plan.byInstrumentKey.values()].map(scripOf));

    // C's side, over the SAME rows, keyed on the journal's own instrument type.
    const labelled = new Set(
      ROWS.filter((r) => showsNotPricedByFeed("upstox", r.instrumentType)).map(
        (r) => `${r.exchange}:${r.tradingsymbol}`,
      ),
    );

    expect([...droppedAsDerivative].sort()).toEqual([...labelled].sort());
    expect([...droppedAsDerivative].sort()).toEqual(["NFO:INFY26SEPFUT", "NFO:RELIANCE26SEP3000CE"]);
    // Nothing sent is labelled, and nothing labelled is sent.
    for (const s of sent) expect(labelled.has(s)).toBe(false);
    for (const s of labelled) expect(sent.has(s)).toBe(false);
  });

  it("a cash key with no known ISIN is unsent, unlabelled, and COUNTED — never silently absent", async () => {
    const keys = await persistMark.openPositionKeys();
    const plan = upstox.planUpstoxKeys(keys);

    expect(plan.skippedNoIsin.map((k) => k.symbol)).toEqual(["ZZQQNOTLISTED"]);
    // The desk does NOT label it — the label is a claim about the instrument
    // kind, and this is an equity. So the only thing that accounts for it is
    // the adapter's own health line, which is where the count has to surface.
    expect(showsNotPricedByFeed("upstox", "equity")).toBe(false);

    const provider = upstox.createUpstoxProvider({
      readGate: async () => ({ state: "ready", creds: { accessToken: "t" } }),
      getImpl: (async () => ({})) as UpstoxGetter,
      isinOf: (s) => (s === "ZZQQNOTLISTED" ? null : "INE002A01018"),
    });
    await provider.snapshot(keys).catch(() => undefined);
    const health = (await provider.health()) as UpstoxHealth;
    expect(health.skippedNoIsin).toBe(1);
    expect(health.skippedDerivatives).toBe(2);
    expect(health.reason).toContain("3 position(s) are not priced by this feed");
  });

  it("the label is off for every other feed, so a labelled row is an Upstox or an Angel One row", () => {
    // The title used to say "can only be an Upstox row", which the desk copy
    // has not matched since `angelone` joined the label (fix A-10).
    for (const id of ["eod", "manual", "openalgo", "mock"]) {
      expect(showsNotPricedByFeed(id, "option")).toBe(false);
      expect(showsNotPricedByFeed(id, "future")).toBe(false);
    }
    for (const id of ["upstox", "angelone"]) {
      expect(showsNotPricedByFeed(id, "option")).toBe(true);
      expect(showsNotPricedByFeed(id, "future")).toBe(true);
      expect(showsNotPricedByFeed(id, "equity")).toBe(false);
      // A row nobody classified is not labelled — the label would be a claim.
      expect(showsNotPricedByFeed(id, null)).toBe(false);
    }
    expect(NOT_PRICED_BY_FEED).toBe("Not priced by this feed");
  });

  /* ── the same crossing, for Angel One's resolver (fix A-10) ─────────────── */

  it("the keys Angel One's resolver REFUSES are exactly the rows the desk labels", async () => {
    const keys = await persistMark.openPositionKeys();
    const scripOf = (k: { exchange: string; symbol: string; tradingsymbol?: string }) =>
      `${k.exchange}:${(k.tradingsymbol ?? k.symbol).toUpperCase()}`;

    // A's side: the resolver's own `skipped` set, from the real resolver, with
    // searchScrip answering for the two symbols Angel One knows and refusing
    // the one it does not. Nothing is injected about WHICH keys are skipped —
    // that decision is `angelCashKey()`'s, and it is the thing under test.
    const KNOWN: Record<string, { tradingsymbol: string; symboltoken: string }> = {
      RELIANCE: { tradingsymbol: "RELIANCE-EQ", symboltoken: "2885" },
      TCS: { tradingsymbol: "TCS-EQ", symboltoken: "11536" },
    };
    const resolver = angelTokens.createAngelTokenResolver({
      search: async (_creds, _jwt, exchange, searchscrip) => {
        const hit = KNOWN[searchscrip];
        return hit ? [{ exchange, ...hit }] : [];
      },
      cache: { async read() { return new Map(); }, async write() {} },
      now: () => Date.parse("2026-09-07T04:00:00Z"),
    });
    const out = await resolver.resolve(keys, {
      creds: { apiKey: "k", clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" },
      jwt: "jwt",
      budget: 10,
    });

    const refused = new Set(out.skipped.map(scripOf));
    const sent = new Set([...out.tokens.keys()]); // `${exchange}:${symbol}`

    // C's side, over the SAME rows, keyed on the journal's own instrument type.
    const labelled = new Set(
      ROWS.filter((r) => showsNotPricedByFeed("angelone", r.instrumentType)).map(
        (r) => `${r.exchange}:${r.tradingsymbol}`,
      ),
    );

    expect([...refused].sort()).toEqual([...labelled].sort());
    expect([...refused].sort()).toEqual(["NFO:INFY26SEPFUT", "NFO:RELIANCE26SEP3000CE"]);
    // Nothing sent is labelled, and nothing labelled is sent.
    for (const s of sent) expect(labelled.has(s)).toBe(false);
    for (const s of labelled) expect(sent.has(s)).toBe(false);

    // MCX and CDS are refused by the same rule, without a row in the book:
    // ruling 4.2-8 is equities on NSE/BSE, and everything else is never sent.
    for (const exchange of ["MCX", "CDS", "NFO", "BFO"] as const) {
      expect(angelTokens.angelCashKey({ symbol: "GOLD", exchange, tradingsymbol: "GOLD" })).toBeNull();
    }
  });

  it("a cash scrip with no ISIN is UNRESOLVED for Angel One, not skipped — and still unlabelled", async () => {
    const keys = await persistMark.openPositionKeys();
    const resolver = angelTokens.createAngelTokenResolver({
      // Angel One knows nothing about this ticker, which is the honest answer
      // for a symbol no exchange lists.
      search: async (_creds, _jwt, exchange, searchscrip) =>
        searchscrip === "ZZQQNOTLISTED" ? [] : [{ exchange, tradingsymbol: `${searchscrip}-EQ`, symboltoken: "11536" }],
      cache: { async read() { return new Map(); }, async write() {} },
      now: () => Date.parse("2026-09-07T04:00:00Z"),
    });
    const out = await resolver.resolve(keys, {
      creds: { apiKey: "k", clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" },
      jwt: "jwt",
      budget: 10,
    });

    // The two feeds disagree about this row ON PURPOSE, and both are right:
    // Upstox cannot build an instrument key without an ISIN, while Angel One
    // asks by name and gets told there is no such scrip.
    expect(upstox.planUpstoxKeys(keys).skippedNoIsin.map((k) => k.symbol)).toEqual(["ZZQQNOTLISTED"]);
    expect(out.skipped.map((k) => k.symbol)).not.toContain("ZZQQNOTLISTED");
    expect(out.unresolved).toContain("NSE:ZZQQNOTLISTED");
    expect(out.tokens.has("NSE:ZZQQNOTLISTED")).toBe(false);

    // …and NEITHER feed labels it, because the label is a claim about the
    // instrument KIND and this is an equity. The count is what accounts for
    // it, on the adapter's own health line.
    expect(showsNotPricedByFeed("angelone", "equity")).toBe(false);
    expect(showsNotPricedByFeed("upstox", "equity")).toBe(false);
  });

  it("the empty book sends nothing and asks nothing of Upstox", async () => {
    const plan = upstox.planUpstoxKeys([]);
    expect(plan.instrumentKeys).toEqual([]);
    expect(plan.skippedDerivatives).toEqual([]);
  });
});

/* ══════════ SEAM 5 — one holiday date, four consumers in three files ═══════
 * `isExchangeHoliday()` is C's; `isMarketOpenIst()` is C's; `msUntilCloseReopen`
 * is C's; the mark refusal is A's (`lib/quotes/persist-mark.ts`). The date
 * crossing them is an IST day, so every instant below is chosen in the
 * 18:30–24:00 UTC band where the UTC date and the IST date DISAGREE.
 */
/** Republic Day 2026 — a MONDAY, so the holiday is the only thing shutting it. */
const HOLIDAY = "2026-01-26";
/** A weekday in the covered year that the list does NOT carry. */
const OPEN_DAY = "2026-01-27"; // Tuesday
const MARK_DAY = "2026-02-03"; // Tuesday — kept apart so S9's write is its own

const at = (isoDate: string, utcTime: string) => new Date(`${isoDate}T${utcTime}Z`);
/** The instant one day BEFORE `isoDate` at `utcTime` — the IST-boundary case. */
function evening(isoDate: string, utcTime: string): Date {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return new Date(`${d.toISOString().slice(0, 10)}T${utcTime}Z`);
}

describe("S5 — a listed holiday is shut in every file that has an opinion", () => {
  it("the fixture really is the seam's input", () => {
    expect(NSE_HOLIDAY_YEAR).toBe(2026);
    expect(nseHolidays.trading_holidays.map((h) => h.date)).toContain(HOLIDAY);
    expect(new Date(`${HOLIDAY}T00:00:00Z`).getUTCDay()).toBe(1); // Monday
    expect(isExchangeHoliday(HOLIDAY)).toBe(true);
    expect(exchangeHolidayName(HOLIDAY)).toBe("Republic Day");
    expect(isExchangeHoliday(OPEN_DAY)).toBe(false);
    expect(new Date(`${OPEN_DAY}T00:00:00Z`).getUTCDay()).toBe(2);
  });

  it("10:00 IST on the holiday: shut, no reconnect armed, and the mark is refused past ignoreClock", async () => {
    const now = at(HOLIDAY, "04:30:00"); // 10:00 IST
    expect(isTradingDayIst(now)).toBe(false);
    expect(isMarketOpenIst(now)).toBe(false);
    expect(msUntilCloseReopen(now)).toBeNull();

    const quotes = quotesFor(await persistMark.openPositionKeys());
    const res = await persistMark.persistDailyMarks(quotes, { now, ignoreClock: true });
    expect(res).toMatchObject({ written: false, marked: 0, code: "holiday", date: HOLIDAY });
    expect(res.reason).toContain("The exchange was closed");
    expect(marksOn(HOLIDAY)).toHaveLength(0);
  });

  it("00:15 IST on the holiday — 18:45 UTC the DAY BEFORE — is already the holiday", async () => {
    const now = evening(HOLIDAY, "18:45:00");
    expect(now.toISOString().slice(0, 10)).not.toBe(HOLIDAY); // still yesterday in UTC
    expect(isTradingDayIst(now)).toBe(false);
    expect(msUntilCloseReopen(now)).toBeNull();

    const res = await persistMark.persistDailyMarks(quotesFor(await persistMark.openPositionKeys()), {
      now,
      ignoreClock: true,
    });
    expect(res.code).toBe("holiday");
    expect(res.date).toBe(HOLIDAY);
  });

  it("…and with NO injected clock either: the system clock crosses the same boundary", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(evening(HOLIDAY, "20:00:00")); // 01:30 IST on the holiday
      const res = await persistMark.persistDailyMarks(quotesFor(await persistMark.openPositionKeys()), {
        ignoreClock: true,
      });
      expect(res).toMatchObject({ written: false, code: "holiday", date: HOLIDAY });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unlisted weekday: all four agree the market is open and the mark may be written", async () => {
    const now = at(OPEN_DAY, "04:30:00"); // 10:00 IST
    expect(isExchangeHoliday(OPEN_DAY)).toBe(false);
    expect(isTradingDayIst(now)).toBe(true);
    expect(isMarketOpenIst(now)).toBe(true);
    expect(msUntilCloseReopen(now)).toBe((15 * 60 + 31 - 10 * 60) * 60_000);

    const res = await persistMark.persistDailyMarks(quotesFor(await persistMark.openPositionKeys()), {
      now,
      ignoreClock: true,
    });
    expect(res.code).toBeUndefined();
    expect(res.written).toBe(true);
    expect(marksOn(OPEN_DAY).length).toBeGreaterThan(0);
  });

  it("the holiday refusal is not the weekend refusal wearing a different name", async () => {
    // A Saturday still answers "weekend"; only a listed weekday answers "holiday".
    const saturday = new Date("2026-01-31T04:30:00Z");
    expect(persistMark.shouldPersistMark(saturday, null).code).toBe("weekend");
    expect(persistMark.shouldPersistMark(at(HOLIDAY, "04:30:00"), null).code).toBe("holiday");
  });
});

/* ═══════ SEAM 6 — A's declared egress ↔ D's PRIVACY sheet ↔ A's sheet ═══════
 * Three statements about ONE host, in three files owned by two builders. The
 * host set is READ OUT OF THE DOC, never listed here: a test carrying its own
 * copy of the answer stops being able to notice the doc changing.
 */
/**
 * The doc AS THE BUYER READS IT. HTML comments are stripped first: PRIVACY.md
 * carries a maintenance block that also names `api.upstox.com`, and a host
 * disclosed only to whoever edits the file is not disclosed at all — reading
 * the raw text would let the user-facing sentence be deleted with this guard
 * still green.
 */
const PRIVACY = fs
  .readFileSync(path.join(process.cwd(), "docs/client/PRIVACY.md"), "utf8")
  .replace(/<!--[\s\S]*?-->/g, " ");
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[?::1\]?|0\.0\.0\.0)$/;

function hostsIn(text: string): string[] {
  const found = text.match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi) ?? [];
  return [...new Set(found.map((h) => h.toLowerCase()))].filter((h) => !LOOPBACK.test(h));
}

describe("S6 — every host named anywhere in the Upstox feed is already in PRIVACY.md", () => {
  const disclosed = new Set(hostsIn(PRIVACY));

  it("the doc really names a host, so the set is not vacuously empty", () => {
    expect(disclosed.size).toBeGreaterThan(0);
    expect(disclosed.has("api.upstox.com")).toBe(true);
  });

  it("no capability in the registry names a host the doc does not", async () => {
    const offenders: string[] = [];
    for (const cap of registry.allProviderCapabilities()) {
      for (const host of hostsIn(cap.egressDescription)) if (!disclosed.has(host)) offenders.push(`${cap.id} → ${host}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the consent sheet names no host the capability does not", () => {
    const capHosts = new Set(hostsIn(upstox.UPSTOX_CAPABILITIES.egressDescription));
    const sheetHosts = hostsIn(UPSTOX_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" "));
    expect(sheetHosts.length).toBeGreaterThan(0);
    for (const host of sheetHosts) {
      expect(capHosts.has(host), `consent sheet names ${host}, capability does not`).toBe(true);
      expect(disclosed.has(host), `consent sheet names ${host}, PRIVACY.md does not`).toBe(true);
    }
  });

  it("the adapter's two paths hang off that one host and nothing else", () => {
    expect(upstox.UPSTOX_LTP_PATH.startsWith("/")).toBe(true);
    expect(upstox.UPSTOX_OHLC_PATH.startsWith("/")).toBe(true);
    expect(hostsIn(`${upstox.UPSTOX_LTP_PATH} ${upstox.UPSTOX_OHLC_PATH}`)).toEqual([]);
  });
});

/* ═══════ SEAM 7 — C's connect prompt ↔ B's picker ↔ the app route tree ═════ */
describe("S7 — the desk only prompts for a feed the picker offers and a screen that exists", () => {
  it("every connectable id is a provider the Settings card really renders", () => {
    const offered = new Set(PROVIDERS.map((p) => p.id));
    for (const id of CONNECTABLE_PROVIDER_IDS) expect(offered.has(id as never)).toBe(true);
  });

  it("a provider the card does not offer never raises the prompt", () => {
    // ANGEL ONE MOVED SIDES (ruling 4.2-9). It was written here as the
    // never-offered example while it was still un-connectable; it is now a
    // connectable broker feed with its own headline and CTA in the prompt, so
    // asserting `false` for it pinned the OPPOSITE of what the release ships.
    // `eod` is the honest never-offered id: it is a provider the card really
    // renders, and it is a stored bhavcopy — there is no connection to make.
    expect(showConnectPrompt({ providerId: "angelone", healthState: "no-key" }, null)).toBe(true);
    expect(showConnectPrompt({ providerId: "eod", healthState: "no-key" }, null)).toBe(false);
    expect(showConnectPrompt({ providerId: "manual", healthState: "no-key" }, null)).toBe(false);
    expect(showConnectPrompt({ providerId: "upstox", healthState: "no-key" }, null)).toBe(true);
    expect(showConnectPrompt({ providerId: "upstox", healthState: "unreachable" }, null)).toBe(true);
    expect(showConnectPrompt({ providerId: "upstox", healthState: "ok" }, null)).toBe(false);
  });

  it("the Upstox prompt's href is a route this build actually has", () => {
    const href = CONNECT_PROMPT_COPY.upstoxHref;
    expect(href.startsWith("/")).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "app", href.slice(1), "page.tsx"))).toBe(true);
  });

  it("the state the adapter reports for a missing token is one the prompt fires on", async () => {
    const provider = upstox.createUpstoxProvider({
      readGate: async () => ({ state: "no-key", reason: "No Upstox connection is saved for this account." }),
    });
    const health = (await provider.health()) as UpstoxHealth;
    expect(showConnectPrompt({ providerId: "upstox", healthState: health.state }, null)).toBe(true);
  });
});

/* ═══════ SEAM 8 — A's new settings column ↔ E's backup redaction list ══════
 * Migration 0069 states in its own header that this column "belongs in
 * SETTINGS_MACHINE_COLUMNS". Builder E owns that file and is landing it
 * concurrently; until it does, a restored backup grants a consent nobody on
 * this machine gave. Reported either way.
 */
describe("S8 — the consent column is machine state, so a backup can neither grant nor revoke it", () => {
  it("live_feed_ack_json is redacted from every dump", () => {
    expect(SETTINGS_MACHINE_COLUMNS as readonly string[]).toContain("liveFeedAckJson");
    expect(settingsMachineBlank("liveFeedAckJson")).toBeNull();
  });

  it("the column the list must name is the one the schema and the registry use", () => {
    // The drizzle KEY, proved against the real column: writing it and reading
    // it back through the registry's own select is what names it.
    setAck(withFeedAck(null, "upstox"));
    expect(isFeedAckCurrent(ackColumn(), "upstox")).toBe(true);
    expect(Object.keys(t.schema.settings)).toContain("liveFeedAckJson");
  });
});

/* ═══════ SEAM 9 — A's mark door ↔ C's data-quality check, on "equity" ══════
 * Both decide which open rows are the app's business to price, from the same
 * book. M1 uses `isCashKey(QuoteKey)`; the quality check uses
 * `instrumentType === "equity"`. If they disagree, the user gets a critical
 * issue that no door in the app can ever clear.
 */
function quotesFor(keys: Awaited<ReturnType<typeof persistMark.openPositionKeys>>) {
  // Built where A builds them — `quoteFromUpstox()` on a real payload shape,
  // so the paise conversion at the edge is the one under test too.
  return keys
    .map((key) =>
      upstox.quoteFromUpstox(
        key,
        { last_price: 1234.5, instrument_token: "NSE_EQ|INE002A01018", cp: 1200 },
        null,
        "2026-02-03T10:00:00.000Z",
      ),
    )
    .filter((q): q is NonNullable<typeof q> => q !== null);
}

function marksOn(date: string) {
  return t.db.select().from(t.schema.mtmPrices).all().filter((m) => m.asOfDate === date);
}

describe("S9 — the mark door and the quality check agree on which rows are equity", () => {
  it("a derivative with no mark is neither persisted by M1 nor counted as unmarked", async () => {
    const now = at(MARK_DAY, "10:30:00"); // 16:00 IST, after the close
    const quotes = quotesFor(await persistMark.openPositionKeys());
    expect(quotes).toHaveLength(ROWS.length); // every key produced a quote…

    const res = await persistMark.persistDailyMarks(quotes, { now });
    expect(res.written).toBe(true);

    // …but only the cash ones were written, at REAL RUPEES from paise.
    const written = marksOn(MARK_DAY);
    expect(written.map((m) => m.symbol).sort()).toEqual(["RELIANCE", "TCS", "ZZQQNOTLISTED"]);
    expect(written[0].price).toBe(1234.5);
    expect(written.some((m) => m.symbol === "INFY")).toBe(false);

    // C's side, over the same book through the real query.
    const report = dataQualityQuery.getDataQualityReport(new Date(`${MARK_DAY}T10:30:00Z`));
    const unmarked = report.issues.find((i) => i.code === "unmarked_open");
    // Every open row M1 could mark is marked; the two derivative rows are NOT
    // reported, because no door in this app could ever clear them.
    expect(unmarked).toBeUndefined();
  });

  it("the check really can fire — an unmarked EQUITY row is still critical", () => {
    const base = {
      acquisition: null,
      acquisitionPrice: null,
      closingPrice: null,
      slPlanned: 1,
      riskAmount: 1,
      segment: "eq_delivery",
      mtfFundedAmount: null,
      expiry: null,
      strike: null,
      optionType: null,
    };
    const report = assessDataQuality({
      trades: [
        { ...base, id: 1, isOpen: true, instrumentType: "equity", symbol: "TCS" },
        { ...base, id: 2, isOpen: true, instrumentType: "option", symbol: "NIFTY", segment: "fno_option" },
        { ...base, id: 3, isOpen: true, instrumentType: "future", symbol: "INFY", segment: "fno_future" },
      ],
      markedTradeIds: new Set(),
      knownSymbols: new Set(["TCS", "NIFTY", "INFY"]),
      ipoLinkedTradeIds: new Set(),
      staleMtmCount: 0,
      missingAttachmentFiles: 0,
    });
    const unmarked = report.issues.find((i) => i.code === "unmarked_open");
    expect(unmarked?.count).toBe(1);
    expect(unmarked?.ids).toEqual([1]);
  });
});
