import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/* ─────────────────────────────────────────────────────────────────────────────
 * SEAM TESTS — the v4.2 FIX WAVE 3 (C-1 … C-11).
 *
 * FIVE builders, DISJOINT file sets. A disjoint wave cannot produce an edit
 * conflict; it also guarantees nobody ran the two halves of a crossing value
 * together. Every test below BUILDS the value where its producer builds it (the
 * real page against one real temp database, the real adapter with only the
 * BROKER injected, the real route handler, the shipped markdown off disk),
 * hands it across exactly as the product does (a React prop, a JSON response
 * body, an HTTP request body), and asserts the CONSUMER'S OUTPUT — the rupee
 * figure in the cell, the sentence on the health line, the bytes on the wire.
 *
 * NOTHING ON EITHER SIDE OF A SEAM IS MOCKED. Two substitutions appear and
 * neither is a side of a seam:
 *   • F2/F6 inject `loginImpl` / spy on `fetch` — that is the BROKER, the far
 *     side of the network, not the far side of the seam.
 *   • F4 mocks `@/lib/quotes/types` — the RELEASE FLAG, which is the input the
 *     whole C-6 seam is a function of. Both halves (the real route + registry
 *     and the real card) are re-imported under the flag this build cannot
 *     otherwise show.
 *
 * OWNERSHIP (disjoint, by builder):
 *   E1  app/risk/page.tsx, lib/analytics/settlement.ts,
 *       components/risk/expiry-obligations.tsx
 *   E2  lib/quotes/angelone.ts, lib/quotes/upstox.ts, lib/quotes/registry.ts
 *   E3  components/settings/live-feed-card.tsx
 *   E4  lib/domain/live-feed-disclosure.ts, lib/domain/help-content.ts,
 *       docs/client/PRIVACY.md, docs/client/README.md, README.md
 *   E5  tests/account-isolation.test.ts, tests/seams-v42-fix2.test.ts
 *
 * ── THE CROSSING VALUES ──────────────────────────────────────────────────────
 *
 * id | crossing value                   | producer (file:line)                                   | consumer (file:line)                                      | unit / shape                | tests
 * ---|----------------------------------|--------------------------------------------------------|-----------------------------------------------------------|-----------------------------|------
 * F1 | the refused-login CEILING        | E4 lib/domain/live-feed-disclosure.ts:214 sheet body    | E2 lib/quotes/angelone.ts:140 ANGELONE_MAX_LOGIN_ATTEMPTS  | a number WORD ↔ an integer  | F1a
 *    | the three CREDENTIAL nouns       | E4 live-feed-disclosure.ts:214 sign-in item             | E2 angelone.ts:147 ANGELONE_LOGIN_CAPPED_REASON            | bytes (nouns + breadcrumb)  | F1b
 * F2 | the CAPPED state                 | E2 angelone.ts:589 session() → :819 health()            | lib/live/connect-prompt.ts:90 showConnectPrompt            | health.state string         | F2a
 *    |                                  |                                                        | E3 live-feed-card.tsx:414 feedHealthText                   | one sentence on the card    |
 * F3 | the settlement REFERENCE price   | E1 app/risk/page.tsx:306 refPrice (cash → close →      | E1 lib/analytics/settlement.ts:210 computeSettlement       | ₹ per share, or null        | F3a
 *    |   (null = unknown, never 0)      |   side-aware entry, each via nonZero)                   |   → SettlementObligation.notional (₹, or null)            |                             | F3b
 *    | notional / unknownNotionalCount  | E1 settlement.ts:321-327 summary                        | E1 components/risk/expiry-obligations.tsx:179 cell, :51 note| ₹ cell text / "n unknown"  | F3a,b
 * F4 | the WITHHELD blockedReason       | lib/quotes/registry.ts:271 withheldFeedReason →         | E3 live-feed-card.tsx:380 feedBlockControl → KEEP_EOD_CTA  | JSON string → a control     | F4a
 *    |                                  |   app/api/live/feed/route.ts:287 GET `feed`            | E3 live-feed-card.tsx:414 feedHealthText(blockedReason)    |                             |
 *    | the provider POST's own answer   | route.ts:375 `feed: await resolveLiveFeed()`           | E3 live-feed-card.tsx:628 foldWriteResult (health → null)  | JSON → "Checking the feed…" | F4b
 * F5 | the B-5 v2 FALLBACK CLAUSE       | E3 live-feed-card.tsx:120,199 equityOnly               | E2 angelone.ts:838 health().reason tail                    | bytes, one clause           | F5a
 *    |                                  |                                                        | E2 upstox.ts:581 health().reason tail                      |                             |
 * F6 | the FOUR things a sign-in sends  | E4 docs/client/PRIVACY.md item 3 ¶2                     | lib/import/api/angelone.ts:101 angelOneLogin request       | JSON body + X-PrivateKey    | F6a
 *
 * Crossing 5 of the brief (the B-5 v2 sentence on the card ×2, both sheets and
 * help ×2) is ALREADY pinned by tests/seams-v42-fix2.test.ts S2a–S2c, and the
 * Angel One health tail by S2d. NOT duplicated here. What fix2 does NOT do is
 * derive the clause FROM THE CARD (it pins two independent literals) and it
 * never runs the UPSTOX adapter at all — F5a adds exactly that and nothing else.
 *
 * ONE temp database for the whole file (`lib/db` caches its connection on
 * `globalThis` — AGENTS.md). Everything server-only is imported DYNAMICALLY
 * inside `beforeAll`, after the helper has set `VYUHA_DB_PATH`.
 * ────────────────────────────────────────────────────────────────────────── */

/* PURE modules — none of these reaches lib/db, so a static import is safe. */
import {
  ANGELONE_FEED_COPY,
  FEED_CHECKING,
  KEEP_EOD_CTA,
  PROVIDERS,
  UPSTOX_FEED_COPY,
  feedBlockControl,
  feedBlockState,
  feedHealthText,
  foldWriteResult,
  type FeedResponse,
  type FeedState,
} from "@/components/settings/live-feed-card";
import { ExpiryObligations } from "@/components/risk/expiry-obligations";
import { ANGELONE_FEED_ITEMS, withFeedAck } from "@/lib/domain/live-feed-disclosure";
import { showConnectPrompt } from "@/lib/live/connect-prompt";
import { todayIstIso } from "@/lib/domain/trading-day";
import {
  DEFAULT_SETTLEMENT_RATES,
  computeSettlement,
  type SettlementInput,
  type SettlementSummary,
} from "@/lib/analytics/settlement";
import type { AngelOneHealth } from "@/lib/quotes/angelone";
import type { UpstoxHealth } from "@/lib/quotes/upstox";

let t: TempDb;
let riskPage: () => unknown;
let angelone: typeof import("@/lib/quotes/angelone");
let upstox: typeof import("@/lib/quotes/upstox");
let registry: typeof import("@/lib/quotes/registry");
let route: typeof import("@/app/api/live/feed/route");
let importApi: typeof import("@/lib/import/api/angelone");
let settlement: SettlementSummary;

/* ── THE BOOK, and the IST DAY it is read on ─────────────────────────────── */

const ACCOUNT = 1;
/** A short stock future whose UNDERLYING has a cash mark on record. */
const KNOWN_ID = 931;
/** The same shape with NO cash mark, NO close and NO recorded entry price. */
const UNKNOWN_ID = 932;

const KNOWN_TRADINGSYMBOL = "FUT SBIN 24 SEP 2026";
const UNKNOWN_TRADINGSYMBOL = "FUT LT 24 SEP 2026";
/** ₹ per share, cash segment — what the exchange settles a stock future at. */
const SBIN_CASH = 1400;
/** The CONTRACT's own mark. A-1 precedence for P&L; the WRONG reference here. */
const SBIN_FUT_MARK = 1450;
const QTY = 500;
/** ₹ delivery value the panel must print: the CASH mark × 500. */
const KNOWN_NOTIONAL = SBIN_CASH * QTY; // 700,000
/** What the pre-wave contract-mark rung would have printed instead. */
const CONTRACT_NOTIONAL = SBIN_FUT_MARK * QTY; // 725,000

/**
 * 18:30–24:00 UTC — the IST day boundary. `todayIstIso()` must already be
 * tomorrow here, and every `dte` on the panel is counted from THAT day. A
 * settlement window computed off the UTC date is a day early on every row
 * between 18:30 and midnight, which is exactly when an Indian user has the
 * desk open on expiry eve.
 */
const AT_IST_BOUNDARY = new Date("2026-09-08T19:00:00.000Z");
const TODAY_IST = "2026-09-09";
const EXPIRY = "2026-09-14";
const EXPECTED_DTE = 5;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function setFeed(provider: string, ack: string | null) {
  t.db.update(t.schema.settings).set({ liveFeedProvider: provider, liveFeedAckJson: ack }).run();
  registry.resetLiveFeedProviderCache();
}

function saveAngelOneConnection() {
  t.db.delete(t.schema.brokerConnections).run();
  t.db
    .insert(t.schema.brokerConnections)
    .values({
      accountId: ACCOUNT,
      broker: "angelone",
      apiKey: "seam-fix3-api-key",
      accessToken: "",
      authJson: JSON.stringify({ clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" }),
    })
    .run();
}

const REQ = { host: "127.0.0.1:3011" };
function feedGet(mod = route): Promise<Response> {
  return mod.GET(new Request("http://127.0.0.1:3011/api/live/feed", { headers: REQ }));
}
function feedPost(body: unknown, mod = route): Promise<Response> {
  return mod.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { ...REQ, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/* ── the element tree, read the way the browser would read the DOM ───────── */

interface Elem {
  type: unknown;
  key: string | null;
  props: Record<string, unknown>;
}
const isElem = (n: unknown): n is Elem =>
  !!n && typeof n === "object" && "props" in (n as object) && typeof (n as Elem).props === "object";

/** Every string/number leaf of a React element tree, in order. */
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
  if (isElem(node)) flattenText(node.props.children, out);
  return out;
}

/** Depth-first walk over children, returning the first element `pick` accepts. */
function findElem(node: unknown, pick: (e: Elem) => boolean): Elem | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElem(n, pick);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElem(node)) return null;
  if (pick(node)) return node;
  return findElem(node.props.children, pick);
}

/** Collect every `props[key]` in a React element tree (the page is never rendered). */
function collectProps(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const n of node) collectProps(n, key, out);
    return out;
  }
  if (!isElem(node)) return out;
  if (key in node.props) out.push(node.props[key]);
  collectProps(node.props.children, key, out);
  return out;
}

/** The eight `<td>` texts of the obligations row for one trade id. */
function panelRowCells(id: number): string[] {
  const tree = ExpiryObligations({ summary: settlement });
  const tr = findElem(tree, (e) => e.type === "tr" && e.key === String(id));
  expect(tr, `no obligations row rendered for trade ${id}`).not.toBeNull();
  const cells = tr!.props.children;
  expect(Array.isArray(cells)).toBe(true);
  return (cells as unknown[]).map((td) => flattenText(td).join(""));
}

/** One `<Stat>` tile of ANY summary, INVOKED — the tile's own rendered text,
 *  note included. */
function statTextOf(summary: SettlementSummary, label: string): string {
  const tree = ExpiryObligations({ summary });
  const stat = findElem(tree, (e) => typeof e.type === "function" && e.props.label === label);
  expect(stat, `no Stat tile labelled ${label}`).not.toBeNull();
  const rendered = (stat!.type as (p: Record<string, unknown>) => unknown)(stat!.props);
  return flattenText(rendered).join(" ");
}

/** One `<Stat>` tile of the PAGE's summary. */
function panelStatText(label: string): string {
  return statTextOf(settlement, label);
}

/** Every text leaf the panel renders for a summary, joined — the footer included. */
function panelTextOf(summary: SettlementSummary): string {
  return flattenText(ExpiryObligations({ summary })).join(" ");
}

const REPO = process.cwd();
const readDoc = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const plain = (md: string) =>
  md
    .replace(/^>\s?/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

beforeAll(async () => {
  t = await openTempDb("seams-v42-fix3", { seed: true });
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  angelone = await import("@/lib/quotes/angelone");
  upstox = await import("@/lib/quotes/upstox");
  registry = await import("@/lib/quotes/registry");
  route = await import("@/app/api/live/feed/route");
  importApi = await import("@/lib/import/api/angelone");

  t.db
    .update(t.schema.settings)
    .set({ equityCapital: 1_000_000, activeCapital: 1_000_000, selectedAccountId: ACCOUNT })
    .run();

  t.db
    .insert(t.schema.trades)
    .values([
      // SOLD to open, never covered — so `avgBuyPrice` is 0 and the side-aware
      // entry is the SELL price. Its underlying has a cash mark; its contract
      // has a mark of its own, and that one is the wrong reference here.
      tradeRow({
        id: KNOWN_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        exchange: "NFO",
        symbol: "SBIN",
        tradingsymbol: KNOWN_TRADINGSYMBOL,
        expiry: EXPIRY,
        buyQty: 0,
        sellQty: QTY,
        avgBuyPrice: 0,
        avgSellPrice: 1410,
        closingPrice: null,
        sellDate: "2026-09-01",
        isOpen: true,
      }),
      // THE OTHER SIGN, and nothing on record to price it: a LONG future on a
      // symbol with no cash mark, no recorded close and an opening price the
      // import never carried. This is the row `nonZero` exists for — pre-wave
      // it priced at ₹0 and asked the user for ₹0 of delivery funds.
      tradeRow({
        id: UNKNOWN_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        exchange: "NFO",
        symbol: "LT",
        tradingsymbol: UNKNOWN_TRADINGSYMBOL,
        expiry: EXPIRY,
        buyQty: QTY,
        sellQty: 0,
        avgBuyPrice: 0,
        avgSellPrice: 0,
        closingPrice: null,
        buyDate: "2026-09-01",
        isOpen: true,
      }),
    ])
    .run();

  // `mtm_prices` is keyed on `symbol`, and `getSpotMap()` skips any row whose
  // tradingsymbol starts with "FUT "/"OPT " — so the two rows below are the
  // CASH mark and the CONTRACT mark, exactly as a bhavcopy + a desk save leave
  // them. LT gets neither.
  t.db
    .insert(t.schema.mtmPrices)
    .values([
      { symbol: "SBIN", tradingsymbol: "SBIN", price: SBIN_CASH, asOfDate: "2026-09-08" },
      {
        symbol: KNOWN_TRADINGSYMBOL,
        tradingsymbol: KNOWN_TRADINGSYMBOL,
        price: SBIN_FUT_MARK,
        asOfDate: "2026-09-08",
      },
    ])
    .run();

  // The page is read ON the IST day boundary — only `Date` is faked, so the
  // SQLite calls and the promises below behave exactly as they do in anger.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT_IST_BOUNDARY);
  try {
    expect(todayIstIso()).toBe(TODAY_IST);
    settlement = collectProps(riskPage(), "summary").find(
      (s): s is SettlementSummary => !!s && typeof s === "object" && "obligations" in (s as object),
    )!;
  } finally {
    vi.useRealTimers();
  }
});

afterAll(() => {
  t?.cleanup();
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F1 — E4 WROTE THE CEILING IN WORDS; E2 WROTE IT AS AN INTEGER.
 *
 * The consent sheet is the statement the user's acceptance is recorded
 * against: "Vyuha tries at most three times and then stops". The adapter is
 * what performs it. Nobody ran the sentence and the constant together, and a
 * later tuning of either one ("make it 5") leaves the other lying to a user who
 * has already consented to the sentence.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The one sheet item that states the sign-in and its ceiling. */
const SIGN_IN_ITEM = ANGELONE_FEED_ITEMS.find((i) => i.body.includes("Vyuha signs in to apiconnect.angelone.in"))!;
const NUMBER_WORDS: Record<string, number> = {
  once: 1,
  twice: 2,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

describe("F1 — the ceiling on the consent sheet IS the adapter's constant", () => {
  it("F1a  the number word the sheet states parses to ANGELONE_MAX_LOGIN_ATTEMPTS", () => {
    // Derived from the SHEET, never restated: a test that pinned "three" twice
    // would agree with itself while the two files disagreed.
    const stated = /tries at most (\w+) times/.exec(SIGN_IN_ITEM.body)?.[1];
    expect(stated, `no "tries at most … times" clause on the Angel One sheet`).toBeTypeOf("string");
    expect(NUMBER_WORDS[stated!.toLowerCase()]).toBe(angelone.ANGELONE_MAX_LOGIN_ATTEMPTS);
    // …and the sentence the capped adapter hands the user counts the same way.
    const inReason = /refused the login (\w+) times/.exec(angelone.ANGELONE_LOGIN_CAPPED_REASON)?.[1];
    expect(NUMBER_WORDS[String(inReason).toLowerCase()]).toBe(angelone.ANGELONE_MAX_LOGIN_ATTEMPTS);
  });

  it("F1b  the capped sentence names the credentials the sheet names, and the same breadcrumb", () => {
    // The sheet says WHAT is sent; the capped reason says WHAT TO RE-SAVE.
    // Those must be the same three nouns, or the user re-saves the wrong thing.
    for (const noun of ["client code", "PIN", "TOTP secret"]) {
      expect(SIGN_IN_ITEM.body, `the sheet does not name "${noun}"`).toContain(noun);
      expect(angelone.ANGELONE_LOGIN_CAPPED_REASON, `the capped reason does not name "${noun}"`).toContain(noun);
    }
    // One breadcrumb, and it is the screen that actually holds them.
    expect(SIGN_IN_ITEM.body).toContain("Import → Connect broker");
    expect(angelone.ANGELONE_LOGIN_CAPPED_REASON).toContain("under Import → Connect broker.");
    // The SECRET itself is never sent — the sheet's hardest sentence, and the
    // capped reason must not undercut it by asking for it back as a "code".
    expect(SIGN_IN_ITEM.body).toContain("the secret itself is never sent");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F2 — THE CAPPED STATE, END TO END: adapter → desk prompt → Settings card.
 *
 * E2 invented a state no consumer had ever seen. `health().state` is what the
 * desk's once-a-day connect prompt keys on and what the Settings card turns
 * into a sentence, and both were written before this state existed. Only the
 * BROKER is injected — the gate, the credentials, the counter and the clock are
 * the real adapter reading the real database.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("F2 — three refused logins reach the desk prompt and the card", () => {
  it("F2a  the cap stops the credential going out, and the card prints that sentence, not Feed OK", async () => {
    selectAccount(ACCOUNT);
    saveAngelOneConnection();
    setFeed("angelone", withFeedAck(null, "angelone"));

    let clock = AT_IST_BOUNDARY.getTime();
    let attempts = 0;
    const provider = angelone.createAngelOneProvider({
      now: () => clock,
      sleep: async () => {},
      loginImpl: async () => {
        attempts += 1;
        throw new Error("Invalid totp");
      },
    });

    // FOUR polls, each a full minute after the last — so the 60 s stamp can
    // never be what stops the fourth one.
    const errors: string[] = [];
    for (let i = 0; i < 4; i++) {
      try {
        await provider.snapshot([{ symbol: "SBIN", exchange: "NSE", tradingsymbol: "SBIN" }]);
        errors.push("<no error>");
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
      clock += angelone.ANGELONE_LOGIN_RETRY_MS + 1000;
    }

    // THE POINT OF THE RULING: the fourth poll sent nothing at all. Before the
    // cap a wrong PIN went to Angel One every 60 s for as long as the desk ran.
    expect(attempts).toBe(angelone.ANGELONE_MAX_LOGIN_ATTEMPTS);
    expect(errors[2]).toBe(angelone.ANGELONE_LOGIN_CAPPED_REASON);
    expect(errors[3]).toBe(angelone.ANGELONE_LOGIN_CAPPED_REASON);

    // The adapter's OWN health shape — `state` is the field both consumers key on.
    const health = (await provider.health()) as AngelOneHealth;
    expect(health.state).toBe("unreachable");
    expect(health.ok).toBe(false);
    expect(health.reason).toBe(angelone.ANGELONE_LOGIN_CAPPED_REASON);

    // CONSUMER 1 — the desk's once-a-day prompt. `unreachable` is one of the
    // exactly two states it opens on; a capped instance must reach the user.
    expect(showConnectPrompt({ providerId: "angelone", healthState: health.state }, null)).toBe(true);

    // CONSUMER 2 — the Settings card's health line, from the same object the
    // route publishes verbatim.
    const line = feedHealthText({
      health: { ok: health.ok, latencyMs: null, reason: health.reason ?? "" },
      blocked: false,
    });
    expect(line).toBe(`Not live — ${angelone.ANGELONE_LOGIN_CAPPED_REASON}`);
    expect(line).not.toContain("Feed OK");
    expect(line).toContain("re-save the client code, PIN and TOTP secret");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F3 — /risk → computeSettlement → the obligations panel, on ONE book.
 *
 * Three files, one number. The page decides WHICH price is the settlement
 * reference and whether it is knowable; `computeSettlement` turns it into a ₹
 * obligation or into `null`; the panel is what a human reads. A `?? 0` on any
 * one of the three prints "₹0 to take delivery" over a position that will
 * certainly devolve — the panel's purpose, inverted.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("F3 — the settlement reference survives the page → analytics → panel", () => {
  it("F3a  a short future with a cash mark on record settles at the CASH mark, and the panel prints it", () => {
    const o = settlement.obligations.find((x) => x.id === KNOWN_ID)!;
    expect(o.kind).toBe("stock_future");
    expect(o.settles).toBe("yes");
    expect(o.side).toBe("short");
    expect(o.netQty).toBe(QTY);
    // Counted from the IST day, at 19:00 UTC — a UTC-dated window is a day out.
    expect(o.dte).toBe(EXPECTED_DTE);
    // ₹ delivery value = the UNDERLYING's cash mark × qty, NOT the contract's
    // own mark (that is A-1's rung, and it is the wrong reference here).
    expect(o.notional).toBe(KNOWN_NOTIONAL);
    expect(o.notional).not.toBe(CONTRACT_NOTIONAL);
    expect(o.physicalStt).toBeGreaterThan(0);
    // SHORT: squaring it off is a BUY, and futures STT is charged on the SELL
    // leg only — so there is no exit STT to set against the delivery STT, and
    // the whole physicalStt is the jump (owner ruling M-1, wave 4). This pin
    // used to assert `toBeGreaterThan(0)`, which asserted the side-blind bug.
    expect(o.exitStt).toBe(0);
    expect(o.sttJump).toBe(o.physicalStt);

    // THE CONSUMER'S OUTPUT — the two rupee cells a user actually reads.
    const cells = panelRowCells(KNOWN_ID);
    expect(cells[5]).toBe("₹7,00,000");
    expect(cells[6]).toMatch(/^₹[\d,]+$/);
    expect(cells[4]).toContain("Give delivery (sell)");
    expect(settlement.notionalAtRisk).toBe(KNOWN_NOTIONAL);
  });

  it("F3b  no cash mark, no close, no recorded entry: the row prints an em dash and the tile says 1 unknown", () => {
    const o = settlement.obligations.find((x) => x.id === UNKNOWN_ID)!;
    expect(o.settles).toBe("yes"); // it WILL devolve — that is why it must be said
    expect(o.side).toBe("long"); // the other sign, and the one that needs CASH
    expect(o.deliveryAction).toBe("Take delivery (buy)");
    expect(o.notional).toBeNull();
    expect(o.physicalStt).toBeNull();
    expect(o.exitStt).toBeNull();
    expect(settlement.unknownNotionalCount).toBe(1);

    const cells = panelRowCells(UNKNOWN_ID);
    // "—", never "₹0": a zero here reads as "nothing to fund".
    expect(cells[5]).toBe("—");
    expect(cells[6]).toBe("—");
    expect(cells.join(" ")).not.toContain("₹0");
    // The obligation cell says the fact instead of naming a rupee figure.
    expect(cells[4]).toContain("settlement value unknown (no underlying price on record)");
    expect(cells[4]).not.toContain("₹");

    // …and the TOTALS say they excluded one, on the same tiles. `fundsNeeded`
    // is ₹0 here BECAUSE the only delivery-taking row is the unknown one — a
    // silently short total reads as "nothing to fund".
    expect(settlement.fundsNeeded).toBe(0);
    const tile = panelStatText("Notional at risk");
    expect(tile).toContain("1 unknown");
    expect(panelStatText("Funds to take delivery")).toContain("1 unknown");
  });

  /**
   * THE INVARIANT: a tile whose total EXCLUDED something says so on the tile
   * itself (ruling C-1) — and the STT tile is one of the three that must.
   *
   * `physicalSttTotal` is built by the same reduce as `notionalAtRisk`
   * (`s + (o.physicalStt ?? 0)`), over every SETTLING row, so on any book it
   * excludes exactly the rows `unknownNotionalCount` counts. It therefore
   * carries the same "n unknown" note its two neighbours carry. A silently
   * short total reads as the whole obligation.
   *
   * (The Funds tile is the ONE tile with a narrower base — it sums
   * take-delivery rows only, so it carries its own `unknownFundsCount`. See
   * the M-2 block below.)
   */
  it("F3c  the STT tile states the same exclusion its two neighbours state", () => {
    expect(settlement.physicalSttTotal).toBeGreaterThan(0);
    expect(panelStatText("STT on physical settlement")).toContain("1 unknown");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * v4.2 FIX WAVE 4 — the same panel, two things it stated that were not true.
 *
 * M-2  the Funds tile borrowed the OTHER tiles' exclusion count.
 * P-1  the footer named a repealed statutory rate, and called it editable.
 *
 * Both are read the way a human reads them: the tile's own rendered text and
 * the panel's own footer, off the REAL component, against a summary the REAL
 * engine built.
 * ══════════════════════════════════════════════════════════════════════════ */
const futInput = (over: Partial<SettlementInput> & { id: number }): SettlementInput => ({
  symbol: "WIPRO",
  tradingsymbol: "FUT WIPRO 24 SEP 2026",
  segment: "future",
  optionType: null,
  strike: null,
  expiry: EXPIRY,
  netQty: 300,
  side: "short",
  refPrice: null,
  ...over,
});

/** A book whose ONLY unknown-value row delivers SHARES, not cash. */
const shortUnknownBook = () =>
  computeSettlement(
    [
      futInput({ id: 1 }), // short, no reference price → unknown notional
      futInput({
        id: 2,
        symbol: "RELIANCE",
        tradingsymbol: "FUT RELIANCE 24 SEP 2026",
        side: "long",
        netQty: 500,
        refPrice: 1400, // → ₹7,00,000 of delivery funds, fully known
      }),
    ],
    DEFAULT_SETTLEMENT_RATES,
    TODAY_IST,
  );

describe("M-2 the Funds tile counts only the rows ITS OWN total left out", () => {
  it("a SHORT unknown future notes nothing on the Funds tile, and 1 unknown on the other two", () => {
    const s = shortUnknownBook();
    // The engine's two counts have parted company, and that is the fix.
    expect(s.unknownNotionalCount).toBe(1);
    expect(s.unknownFundsCount).toBe(0);
    expect(s.fundsNeeded).toBe(700000); // the long row, whole and known

    const funds = statTextOf(s, "Funds to take delivery");
    expect(funds).not.toContain("unknown");
    // WRONG (pre-M-2): "Funds to take delivery ₹7L · 1 unknown" — a caveat
    // about a row that delivers shares, on the tile that counts cash.
    expect(statTextOf(s, "Notional at risk")).toContain("1 unknown");
    expect(statTextOf(s, "STT on physical settlement")).toContain("1 unknown");
  });

  it("CONTROL: a LONG unknown future DOES note the Funds tile — that total is genuinely short", () => {
    const s = computeSettlement([futInput({ id: 3, side: "long" })], DEFAULT_SETTLEMENT_RATES, TODAY_IST);
    expect(s.unknownFundsCount).toBe(1);
    expect(statTextOf(s, "Funds to take delivery")).toContain("1 unknown");
  });
});

describe("P-1 the footer states the rate the panel actually computed", () => {
  /** 0.0015 → "0.15" — the same rendering the component must derive. */
  const pct = (frac: number) => String(Number((frac * 100).toFixed(4)));

  it("names the exercise-STT rate in force (0.15%), never the repealed 0.125%", () => {
    const text = panelTextOf(shortUnknownBook());
    // Derived from the CONSTANT the page spreads into computeSettlement, so a
    // future statutory change moves both together or fails here.
    expect(pct(DEFAULT_SETTLEMENT_RATES.exerciseSttPct)).toBe("0.15");
    expect(text).toContain(`${pct(DEFAULT_SETTLEMENT_RATES.exerciseSttPct)}% of intrinsic`);
    expect(text).not.toContain("0.125");
  });

  it("the rate word is RENDERED from the constant, not written down beside it", () => {
    const src = readDoc("components/risk/expiry-obligations.tsx");
    expect(src).toContain("DEFAULT_SETTLEMENT_RATES.exerciseSttPct");
    // A literal is what drifted: the constant moved to 0.15% on 1-Apr-2026 and
    // the sentence stayed at 0.125% for five months.
    expect(src).not.toContain("0.125");
    expect(src).not.toContain("0.15%");
  });

  it("says which rates come from charge config and which one does not", () => {
    const text = plain(panelTextOf(shortUnknownBook()));
    // FALSE before P-1: "Statutory rates are editable in charge config" — the
    // exercise rate is a named constant by ruling (DECISIONS 2026-08-12).
    expect(text).not.toContain("Statutory rates are editable in charge config");
    expect(text).toContain("charge config");
    expect(text.toLowerCase()).toContain("not editable");
  });

  it("stays computed-and-neutral: no recommendation verbs anywhere on the panel", () => {
    const text = panelTextOf(shortUnknownBook()).toLowerCase();
    for (const word of ["recommend", "you should", "we suggest", "consider "]) {
      expect(text, `the panel must not say "${word}"`).not.toContain(word);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F4 — A WITHHELD STORED PROVIDER: the route's sentence, the card's one
 * control, and the write that clears it.
 *
 * `liveFeedProvider` travels in a backup envelope; the release flag does not.
 * The route has said "this build does not offer …" since fix wave 2 — and the
 * card had nothing to click. E3 added the control and the re-ask; both are
 * driven here by the REAL route against the real database.
 * ══════════════════════════════════════════════════════════════════════════ */
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
    registry.resetLiveFeedProviderCache();
  }
}

describe("F4 — the withheld pick states its own reason and offers the one control that clears it", () => {
  it("F4a  the GET's blockedReason IS the registry's sentence, and the card answers with Keep end-of-day prices", async () => {
    selectAccount(ACCOUNT);
    setFeed("angelone", withFeedAck(null, "angelone"));

    await withAngelOneWithheld(async ({ offRoute, offRegistry, offCard }) => {
      const body = (await (await feedGet(offRoute)).json()) as { feed: FeedState };
      expect(body.feed.stored).toBe("angelone");
      expect(body.feed.effective).toBe("eod");
      // Producer and consumer, byte for byte — the route publishes the
      // registry's sentence and the card is handed exactly that string.
      expect(body.feed.blockedReason).toBe(offRegistry.withheldFeedReason("angelone"));
      expect(body.feed.blockedReason).toBe(
        "This build does not offer the Angel One feed; the desk stays on end-of-day prices.",
      );

      const offered = offCard.PROVIDERS.map((p) => p.id);
      expect(offered).not.toContain("angelone");
      const block = offCard.feedBlockState(body.feed, offered)!;
      // B-8 keeps the sheet button withheld…
      expect(block.reviewProvider).toBeNull();
      // …and C-6 is the way out that leaves: ONE control, not none.
      expect(offCard.feedBlockControl(body.feed, block, offered)).toEqual({ kind: "keep-eod" });
      expect(offCard.KEEP_EOD_CTA).toBe("Keep end-of-day prices");

      // The health line beside it says WHY, not "the feed you picked is
      // blocked" — which would invite a fix this build does not have.
      const line = offCard.feedHealthText({
        health: { ok: true, latencyMs: 2, reason: "end-of-day" },
        blocked: true,
        blockedReason: block.reason,
      });
      expect(line).toBe(body.feed.blockedReason);
      expect(line).not.toContain("the feed you picked is blocked");
    });

    // THE OTHER SIDE OF THE SAME SWITCH: on a build that DOES offer Angel One
    // the control is the sheet button, and never the end-of-day escape.
    const offeredNow = PROVIDERS.map((p) => p.id);
    expect(offeredNow).toContain("angelone");
    const shipped: FeedState = { stored: "angelone", effective: "eod", refreshSeconds: 3, blockedReason: "x" };
    expect(feedBlockControl(shipped, feedBlockState(shipped, offeredNow), offeredNow)).toEqual({
      kind: "review",
      provider: "angelone",
    });
  });

  it("F4b  the control's own write clears the block and blanks the health line until the GET answers", async () => {
    selectAccount(ACCOUNT);
    setFeed("angelone", withFeedAck(null, "angelone"));

    await withAngelOneWithheld(async ({ offRoute, offCard }) => {
      // What the card is holding when the button is clicked: the real GET body.
      const before = (await (await feedGet(offRoute)).json()) as FeedResponse;
      expect(offCard.feedBlockState(before.feed)).not.toBeNull();
      expect(before.health).not.toBeNull();

      // The click — `pick("eod")`, which is the ordinary provider write.
      const res = await feedPost({ action: "provider", provider: "eod" }, offRoute);
      expect(res.status).toBe(200);
      const posted = (await res.json()) as { ok: boolean; feed?: FeedResponse["feed"] };
      expect(posted.ok).toBe(true);
      expect(posted.feed?.stored).toBe("eod");

      // THE FOLD (C-7): the POST carries no health, so the card must not keep
      // the one it had — it describes the feed that used to run.
      const after = offCard.foldWriteResult(before, posted)!;
      expect(offCard.feedBlockState(after.feed)).toBeNull();
      expect(after.health).toBeNull();
      expect(offCard.feedHealthText({ health: after.health, blocked: false })).toBe(offCard.FEED_CHECKING);

      // …and the re-ask is what ends "Checking the feed…" — the real GET again.
      const refreshed = (await (await feedGet(offRoute)).json()) as FeedResponse;
      expect(refreshed.feed?.stored).toBe("eod");
      expect(refreshed.feed?.blockedReason).toBeUndefined();
      expect(refreshed.health).not.toBeNull();
      const settled = offCard.feedHealthText({
        health: refreshed.health,
        blocked: offCard.feedBlockState(refreshed.feed) !== null,
      });
      // The GET has ANSWERED — whatever end-of-day's own verdict is, the card
      // is no longer describing a feed it has not probed.
      expect(settled).not.toBe(offCard.FEED_CHECKING);
      expect(settled).toMatch(/^(Feed OK|Not live — )/);
      expect(settled).not.toContain("does not offer");
    });
    // The shared card exports the same two names this file imported statically.
    expect(FEED_CHECKING).toBe("Checking the feed…");
    expect(KEEP_EOD_CTA).toBe("Keep end-of-day prices");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F5 — ONE CLAUSE, THREE FILES. E3 reworded the card's footnote (C-11) and E2
 * reworded both adapters' health tails. The Settings card prints BOTH at once —
 * the footnote under the radio and the adapter's `health.reason` under it — so
 * on a book holding a derivative they are two sentences about one row.
 *
 * fix2 S2d pins the Angel One tail against a LITERAL and never runs Upstox.
 * Here the clause is DERIVED FROM THE CARD and both adapters are run.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("F5 — both adapters end their health sentence on the card's own clause", () => {
  it("F5a  the clause is derived from the card's footnote and both adapters finish on it", async () => {
    // The card's sentence, minus its own opening and its trailing "and says so
    // on the row." — what is left is the promise about the row's price.
    const clause = ANGELONE_FEED_COPY.equityOnly.replace(/^.*?: /, "").replace(/, and says so on the row\.$/, ".");
    expect(clause).toBe("each shows the position's recorded close, or a dash when no close is recorded.");
    expect(UPSTOX_FEED_COPY.equityOnly).toBe(ANGELONE_FEED_COPY.equityOnly);

    selectAccount(ACCOUNT);
    // ANGEL ONE — real gate, real database, only the broker injected.
    saveAngelOneConnection();
    t.db.update(t.schema.settings).set({ liveFeedAckJson: withFeedAck(null, "angelone") }).run();
    const angel = angelone.createAngelOneProvider({
      loginImpl: async () => ({ jwtToken: "seam-fix3-jwt" }),
      sleep: async () => {},
    });
    // One DERIVATIVE key: `angelCashKey()` refuses it, no token is ever sent,
    // and health() has to say what the row shows instead.
    await angel.snapshot([{ symbol: "SBIN", exchange: "NFO", tradingsymbol: KNOWN_TRADINGSYMBOL }]);
    const angelReason = ((await angel.health()) as AngelOneHealth).reason ?? "";
    expect(angelReason).toContain("not priced by this feed");
    expect(angelReason.trimEnd().endsWith(clause), `angel health = ${JSON.stringify(angelReason)}`).toBe(true);

    // UPSTOX — the same book, the same seam, the adapter fix2 never ran.
    t.db.delete(t.schema.brokerConnections).run();
    t.db
      .insert(t.schema.brokerConnections)
      .values({ accountId: ACCOUNT, broker: "upstox", apiKey: "seam-fix3-analytics-token", accessToken: "" })
      .run();
    t.db
      .update(t.schema.settings)
      .set({ liveFeedAckJson: withFeedAck(withFeedAck(null, "angelone"), "upstox") })
      .run();
    const ups = upstox.createUpstoxProvider();
    // A derivative key has no cash instrument key, so no request is made and
    // the plan is all `skippedDerivatives` — the health sentence's own case.
    await ups.snapshot([{ symbol: "SBIN", exchange: "NFO", tradingsymbol: KNOWN_TRADINGSYMBOL }]);
    const upsReason = ((await ups.health()) as UpstoxHealth).reason ?? "";
    expect(upsReason).toContain("not priced by this feed");
    expect(upsReason.trimEnd().endsWith(clause), `upstox health = ${JSON.stringify(upsReason)}`).toBe(true);

    // The clause the wave retired, on either adapter, would be a promise of a
    // number nothing prints.
    for (const reason of [angelReason, upsReason]) {
      expect(reason.toLowerCase()).not.toContain("its entry price when no close is recorded");
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F6 — THE SHIPPED DOCUMENT vs THE BYTES ON THE WIRE.
 *
 * PRIVACY.md is the client-ZIP surface: it is what a buyer reads, and it now
 * states that a sign-in sends FOUR things and that the TOTP SECRET is not one
 * of them. The producer of that claim is `angelOneLogin()`. Only `fetch` is
 * replaced — the network, not a side of the seam — and the request it was
 * handed is inspected exactly as Angel One would receive it.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("F6 — PRIVACY item 3 names the four things the login actually sends", () => {
  it("F6a  four fields go, the secret stays, and the document names the same four", async () => {
    const privacy = plain(readDoc("docs/client/PRIVACY.md"));
    const claim = /Each sign-in sends four things:[^.]*\.[^.]*\./.exec(privacy)?.[0];
    expect(claim, "PRIVACY.md item 3 no longer states what a sign-in sends").toBeTypeOf("string");

    const SECRET = "JBSWY3DPEHPK3PXP";
    let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent = {
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ status: true, data: { jwtToken: "wire-jwt" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      await importApi.angelOneLogin({
        apiKey: "APP-KEY-1",
        clientCode: "C1",
        pin: "1234",
        totpSecret: SECRET,
      });
    } finally {
      spy.mockRestore();
    }
    expect(sent).not.toBeNull();
    const wire = sent!;

    // ONE host, the one both documents name.
    expect(wire.url.startsWith("https://apiconnect.angelone.in/")).toBe(true);
    expect(privacy).toContain("apiconnect.angelone.in");

    // THE FOUR THINGS, as the request carries them:
    expect(wire.body.clientcode).toBe("C1"); // 1 the client code
    expect(wire.body.password).toBe("1234"); // 2 the PIN
    expect(String(wire.body.totp)).toMatch(/^\d{6}$/); // 3 a code minted at call time
    expect(wire.headers["X-PrivateKey"]).toBe("APP-KEY-1"); // 4 the SmartAPI app key
    expect(Object.keys(wire.body).sort()).toEqual(["clientcode", "password", "totp"]);

    // …and the fifth thing that must NOT go: the base32 secret, anywhere.
    const whole = `${wire.url} ${JSON.stringify(wire.headers)} ${JSON.stringify(wire.body)}`;
    expect(whole).not.toContain(SECRET);

    // The document names those four and disclaims the fifth, in its own words.
    for (const noun of ["the client code", "the PIN", "the one-time code derived from the TOTP secret", "the SmartAPI app key"]) {
      expect(claim!, `PRIVACY.md item 3 does not name "${noun}"`).toContain(noun);
    }
    expect(claim!).toContain("the secret itself is never sent");
  });
});
