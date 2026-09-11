import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/* ─────────────────────────────────────────────────────────────────────────────
 * SEAM TESTS — the v4.2 FIX WAVE 4 (M-1, M-2, C-1, P-1, P-3, D-1, U-1).
 *
 * FOUR builders plus the orchestrator, DISJOINT file sets. A disjoint wave
 * cannot produce an edit conflict; it also guarantees that nobody ran the two
 * halves of a crossing value together. Every test below BUILDS the value where
 * its producer builds it (the real page against one real temp database, the
 * real adapter reading the real gate with only the BROKER injected, the real
 * route handler, the shipped markdown off disk), hands it across exactly as the
 * product does (a React prop, a JSON response body, a memo key) and asserts the
 * CONSUMER'S OUTPUT — the rupee figure in the cell, the note under the tile,
 * the sentence on the health line, the instance the registry hands back.
 *
 * NOTHING ON EITHER SIDE OF A SEAM IS MOCKED. Two substitutions appear and
 * neither is a side of a seam: `loginImpl`/`quoteImpl`/`searchImpl` are the
 * BROKER — the far side of the network, not the far side of the seam — and the
 * clock is an argument the adapter already takes.
 *
 * OWNERSHIP (disjoint, by builder):
 *   A  lib/analytics/settlement.ts, components/risk/expiry-obligations.tsx,
 *      app/risk/page.tsx, app/page.tsx, lib/jobs/auto-mtm.ts
 *   B  lib/quotes/angelone.ts
 *   C  components/settings/live-feed-card.tsx
 *   D  lib/domain/live-feed-disclosure.ts, lib/domain/help-content.ts,
 *      docs/client/PRIVACY.md, README.md, docs/client/README.md,
 *      lib/quotes/registry.ts (comments), tests/readme-claims.test.ts
 *   O  lib/quotes/angelone.ts ANGELONE_CAPABILITIES.egressDescription
 *
 * ── THE CROSSING VALUES ──────────────────────────────────────────────────────
 *
 * id | crossing value                        | producer (file:line)                                        | consumer (file:line)                                          | unit / shape                  | test
 * ---|---------------------------------------|-------------------------------------------------------------|---------------------------------------------------------------|-------------------------------|-----
 * S1 | the SESSION-INVALIDATION ceiling      | D live-feed-disclosure.ts:171 sheet body ("three times in a  | B angelone.ts:207 ANGELONE_MAX_SESSION_INVALIDATIONS           | a number WORD ↔ an integer    | S1a
 *    |                                       |   row"), docs/client/PRIVACY.md item 3                       |                                                               |                               |
 *    | what RESETS that count                | D live-feed-disclosure.ts:171 ("a priced answer")            | B angelone.ts:855 `if (out.size > 0)` in snapshot()            | a WORD ↔ a map size           | S1b
 * S2 | the CAPPED health object              | B angelone.ts:975 health() → state/ok/reason                 | app/api/live/feed/route.ts:266 healthLine() field names        | JSON on the wire              | S2a
 *    |                                       |                                                             | C live-feed-card.tsx:401 feedHealthText / :329 feedBlockState  | one sentence on the card      |
 *    |                                       |                                                             | lib/live/connect-prompt.ts showConnectPrompt(healthState)      | the desk's once-a-day prompt  |
 * S3 | the FIVE sign-in triggers             | registry.ts:451 liveFeedInstanceKey() fields                 | D live-feed-disclosure.ts:171 sheet trigger clause             | a gesture ↔ a clause          | S3a
 *    | "switch the selected account"         | D sheet / PRIVACY #3 / help-content ×3 / both READMEs        | O angelone.ts:237 ANGELONE_CAPABILITIES.egressDescription      | one substring, six surfaces   | S3b
 *    |                                       |                                                             | C live-feed-card.tsx:194 ANGELONE_FEED_COPY.blurb              | the Settings row's own list   | S3c
 * S4 | futExitSttPct + the position's SIDE   | A app/risk/page.tsx:332 sttFromConfig("future", …) + :288    | A settlement.ts:254 exitStt (side-aware, M-1)                  | ₹ (rupees, rounded)           | S4a
 *    |                                       |   side                                                      | → A expiry-obligations.tsx:207 the "STT if held" cell          |                               |
 *    | unknownFundsCount                     | A settlement.ts:364 (take-delivery rows only)                | A expiry-obligations.tsx:70 unknownFundsNote → the Funds tile  | "n unknown", or nothing       | S4b
 * S5 | AutoMtmOutcome (breaches included)    | A lib/jobs/auto-mtm.ts:208 runAutoMtm()                      | app/api/mtm/auto/route.ts:14 `{ ok: true, ...outcome }`        | JSON body                     | S5a
 * S6 | exerciseSttPct                        | A settlement.ts:94 DEFAULT_SETTLEMENT_RATES → page:324       | A expiry-obligations.tsx:236 pctText() in the footer           | a fraction ↔ a percent word   | S6a
 *    | deliverySttPct / futExitSttPct        | charge_config rows → A page:325,332 sttFromConfig()          | A expiry-obligations.tsx:240 "read from your charge config"    | a rate ↔ a claim about it     | S6b
 *
 * ALREADY PINNED ELSEWHERE, AND NOT DUPLICATED HERE:
 *   • the REFUSED-login ceiling word ↔ ANGELONE_MAX_LOGIN_ATTEMPTS — F1a of
 *     tests/seams-v42-fix3.test.ts. S1a is its sibling for the OTHER ceiling,
 *     which no test reads off the sheet at all.
 *   • the banner scope (`scanBreachesForSelectedAccount()` on both pages) —
 *     tests/breach-scan-scope.test.ts, whole file. S5a adds only the seam that
 *     file does not cross: the EOD outcome's trip through its route.
 *   • the invalidation cap's own arithmetic — tests/quotes-angelone.test.ts.
 *     S1b does not re-count it; it asks whether the SHEET'S WORD for the reset
 *     is the rule the adapter keeps.
 *
 * ONE temp database for the whole file (`lib/db` caches its connection on
 * `globalThis` — AGENTS.md). Everything server-only is imported DYNAMICALLY
 * inside `beforeAll`, after the helper has set `VYUHA_DB_PATH`.
 * ────────────────────────────────────────────────────────────────────────── */

/* PURE modules — none of these reaches lib/db, so a static import is safe. */
import { ExpiryObligations } from "@/components/risk/expiry-obligations";
import {
  ANGELONE_FEED_COPY,
  feedBlockState,
  feedHealthText,
  type FeedState,
} from "@/components/settings/live-feed-card";
import { ANGELONE_FEED_ITEMS, withFeedAck } from "@/lib/domain/live-feed-disclosure";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { showConnectPrompt } from "@/lib/live/connect-prompt";
import { latestBhavcopyDate, todayIstIso } from "@/lib/domain/trading-day";
import { DEFAULT_SETTLEMENT_RATES, type SettlementSummary } from "@/lib/analytics/settlement";
import type { AngelOneHealth, AngelQuoteData } from "@/lib/quotes/angelone";
import type { QuoteKey, QuoteProvider } from "@/lib/quotes/types";

let t: TempDb;
let riskPage: () => unknown;
let angelone: typeof import("@/lib/quotes/angelone");
let registry: typeof import("@/lib/quotes/registry");
let feedRoute: typeof import("@/app/api/live/feed/route");
let autoMtmRoute: typeof import("@/app/api/mtm/auto/route");
let settlement: SettlementSummary;

/* ── THE BOOK, and the IST DAY it is read on ─────────────────────────────── */

const ACCOUNT = 1;
const SECOND_ACCOUNT = 2;

/** A SHORT future with a cash mark on record — M-1's zero-exit-STT case. */
const SHORT_KNOWN = 941;
/** A LONG future with a cash mark — M-1's sell-side-rate case, the other sign. */
const LONG_KNOWN = 942;
/** A SHORT future nothing can price — M-2's give-delivery unknown. */
const SHORT_UNKNOWN = 943;
/** An ITM long call — the ONE row whose STT carries BOTH footer rates: delivery
 *  STT on the strike value (charge config) plus exercise STT on intrinsic. */
const ITM_OPTION = 944;

const SBIN_CASH = 1400;
const SBIN_QTY = 500;
const RELIANCE_CASH = 1500;
const RELIANCE_QTY = 200;
const TCS_SPOT = 3200;
const TCS_STRIKE = 3000;
const TCS_QTY = 150;

/**
 * The two rates the page resolves from `charge_config` (invariant 3), written
 * into this database at values NO default carries — so a page that stopped
 * reading the config and fell back to `DEFAULT_SETTLEMENT_RATES` (0.001 /
 * 0.0005) fails here instead of passing on a coincidence.
 */
const CONFIG_DELIVERY_STT = 0.0012;
const CONFIG_FUT_EXIT_STT = 0.0009;

/** What the panel must print, in rupees, if every hop keeps the rate and side.
 *  STT rounds to the RUPEE (invariant 3), which is also what saves these from
 *  the binary-float tail: 0.0012 × 700,000 is 839.9999999999999 in IEEE-754. */
const SHORT_NOTIONAL = SBIN_CASH * SBIN_QTY; // 700,000
const LONG_NOTIONAL = RELIANCE_CASH * RELIANCE_QTY; // 300,000
const OPTION_NOTIONAL = TCS_STRIKE * TCS_QTY; // 450,000
const SHORT_DELIVERY_STT = Math.round(CONFIG_DELIVERY_STT * SHORT_NOTIONAL); // 840
const LONG_DELIVERY_STT = Math.round(CONFIG_DELIVERY_STT * LONG_NOTIONAL); // 360
const LONG_EXIT_STT = Math.round(CONFIG_FUT_EXIT_STT * LONG_NOTIONAL); // 270
const OPTION_INTRINSIC = TCS_SPOT - TCS_STRIKE; // 200 per share
const OPTION_EXERCISE_STT = Math.round(
  DEFAULT_SETTLEMENT_RATES.exerciseSttPct * OPTION_INTRINSIC * TCS_QTY,
); // 45
/** R78: a physically settled option carries delivery STT on the strike value,
 *  at the charge-config rate, on both sides — and the long also pays exercise
 *  STT. Each rounds to the rupee on its own. */
const OPTION_DELIVERY_STT = Math.round(CONFIG_DELIVERY_STT * OPTION_NOTIONAL); // 540
const OPTION_STT = OPTION_DELIVERY_STT + OPTION_EXERCISE_STT; // 585

/**
 * 18:30–24:00 UTC — the IST day boundary. `todayIstIso()` is already tomorrow
 * here, and every `dte` on the panel is counted from THAT day; a window
 * computed off the UTC date is a day early on every row between 18:30 and
 * midnight, which is exactly when an Indian desk is open on expiry eve.
 */
const AT_IST_BOUNDARY = new Date("2026-09-08T19:00:00.000Z");
const TODAY_IST = "2026-09-09";
const EXPIRY = "2026-09-24";

/* ── the Angel One credentials this database holds, and nothing else ─────── */

const CLIENT_CODE = "S4SEAM01";
const PIN = "9137";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const API_KEY = "seam-fix4-api-key";
/** Every secret value in the row, for the "no credential in the sentence" pin. */
const CREDENTIAL_VALUES = [CLIENT_CODE, PIN, TOTP_SECRET, API_KEY];

const SBIN_TOKEN = "3045";
const PRICED_ROW = {
  exchange: "NSE",
  tradingSymbol: "SBIN-EQ",
  symbolToken: SBIN_TOKEN,
  ltp: 1005.9,
  close: 1016.1,
};
/** What an app key with no market-data entitlement answers to every quote. */
const notEntitled = (): never => {
  throw new Error("Angel One quote: HTTP 401");
};

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
  registry.resetLiveFeedProviderCache();
}

function setFeed(provider: string, ack: string | null) {
  t.db.update(t.schema.settings).set({ liveFeedProvider: provider, liveFeedAckJson: ack }).run();
  registry.resetLiveFeedProviderCache();
}

function saveAngelOneConnection(accountId = ACCOUNT, updatedAt = "2026-09-08T09:00:00.000Z") {
  t.db.delete(t.schema.brokerConnections).run();
  t.db
    .insert(t.schema.brokerConnections)
    .values({
      accountId,
      broker: "angelone",
      apiKey: API_KEY,
      accessToken: "",
      authJson: JSON.stringify({ clientCode: CLIENT_CODE, pin: PIN, totpSecret: TOTP_SECRET }),
      updatedAt,
    })
    .run();
  registry.resetLiveFeedProviderCache();
}

/* ── the ADAPTER RIG: the real gate, the real token cache, a fake broker ─── */

interface Rig {
  provider: QuoteProvider;
  readonly logins: number;
  /** Poll n times at the fastest tier; a poll that throws contributes its text. */
  poll(n: number): Promise<string[]>;
}

/**
 * The REAL Angel One provider — real gate (this database), real token cache
 * (the `angelone_instrument_tokens` row seeded below), real session, counter
 * and clock arithmetic. Injected: the login call, the quote call and the scrip
 * search, which are the BROKER, and the clock, which is already a parameter.
 */
function rig(opts: {
  respond?: (n: number) => AngelQuoteData | null;
  login?: () => Promise<{ jwtToken: string }>;
  /**
   * Milliseconds between polls. The default is the fastest cadence tier; a
   * test about REFUSED logins must use more than `ANGELONE_LOGIN_RETRY_MS`, or
   * the 60 s stamp — not the attempt cap — is what stops the second poll.
   */
  everyMs?: number;
}): Rig {
  let clock = AT_IST_BOUNDARY.getTime();
  const state = { logins: 0, quotes: 0 };
  const provider = angelone.createAngelOneProvider({
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    loginImpl: async () => {
      state.logins += 1;
      return opts.login ? opts.login() : { jwtToken: `jwt-${state.logins}` };
    },
    quoteImpl: async () => {
      state.quotes += 1;
      return opts.respond ? opts.respond(state.quotes) : { fetched: [], unfetched: [] };
    },
    searchImpl: async () => [],
  });
  const key: QuoteKey = { symbol: "SBIN", exchange: "NSE" };
  return {
    provider,
    get logins() {
      return state.logins;
    },
    async poll(n: number) {
      const out: string[] = [];
      for (let i = 0; i < n; i += 1) {
        try {
          await provider.snapshot([key]);
          out.push("<no error>");
        } catch (e) {
          out.push(e instanceof Error ? e.message : String(e));
        }
        clock += opts.everyMs ?? 3000;
      }
      return out;
    },
  };
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

/** One `<Stat>` tile of the PAGE's summary, INVOKED — its own text, note included. */
function panelStatText(label: string): string {
  const tree = ExpiryObligations({ summary: settlement });
  const stat = findElem(tree, (e) => typeof e.type === "function" && e.props.label === label);
  expect(stat, `no Stat tile labelled ${label}`).not.toBeNull();
  const rendered = (stat!.type as (p: Record<string, unknown>) => unknown)(stat!.props);
  return flattenText(rendered).join(" ");
}

/** Every text leaf the panel renders for the page's summary — the footer included. */
const panelText = () => flattenText(ExpiryObligations({ summary: settlement })).join(" ");

const REPO = process.cwd();
const readDoc = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
/** Markdown as a reader reads it: no quote marks, no bold, one space per gap. */
const plain = (md: string) =>
  md
    .replace(/^>\s?/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

const REQ = { host: "127.0.0.1:3011" };
const feedGet = () =>
  feedRoute.GET(new Request("http://127.0.0.1:3011/api/live/feed", { headers: REQ }));

beforeAll(async () => {
  t = await openTempDb("seams-v42-fix4", { seed: true });
  // The dev/e2e override outranks the stored pick; nothing in this file may
  // read a provider the operator's shell chose.
  delete process.env.VYUHA_QUOTE_PROVIDER;

  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  angelone = await import("@/lib/quotes/angelone");
  registry = await import("@/lib/quotes/registry");
  feedRoute = await import("@/app/api/live/feed/route");
  autoMtmRoute = await import("@/app/api/mtm/auto/route");

  t.db
    .update(t.schema.settings)
    .set({ equityCapital: 1_000_000, activeCapital: 1_000_000, selectedAccountId: ACCOUNT })
    .run();
  // A SECOND live account, so that 0 is genuinely the aggregate VIEW and not a
  // single-account book resolved to its one account (`getSelectedAccountId`).
  t.db.insert(t.schema.accounts).values({ id: SECOND_ACCOUNT, name: "Swing", isDefault: false }).run();

  // THE RATES THE PAGE MUST READ (invariant 3), at values no default carries.
  t.sqlite
    .prepare("UPDATE charge_config SET stt_pct = ? WHERE segment = 'future' AND effective_to IS NULL")
    .run(CONFIG_FUT_EXIT_STT);
  t.sqlite
    .prepare("UPDATE charge_config SET stt_pct = ? WHERE segment = 'eq_delivery' AND effective_to IS NULL")
    .run(CONFIG_DELIVERY_STT);

  t.db
    .insert(t.schema.trades)
    .values([
      // SOLD to open, never covered: squaring it off is a BUY, which futures
      // STT does not touch — exitStt 0, and the jump is the whole delivery STT.
      tradeRow({
        id: SHORT_KNOWN,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        exchange: "NFO",
        symbol: "SBIN",
        tradingsymbol: "FUT SBIN 24 SEP 2026",
        expiry: EXPIRY,
        buyQty: 0,
        sellQty: SBIN_QTY,
        avgBuyPrice: 0,
        avgSellPrice: 1410,
        closingPrice: null,
        sellDate: "2026-09-01",
        isOpen: true,
      }),
      // THE OTHER SIGN, priced the same way: squaring it off IS a sell, so it
      // costs the charge_config sell-side rate on the notional.
      tradeRow({
        id: LONG_KNOWN,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        exchange: "NFO",
        symbol: "RELIANCE",
        tradingsymbol: "FUT RELIANCE 24 SEP 2026",
        expiry: EXPIRY,
        buyQty: RELIANCE_QTY,
        sellQty: 0,
        avgBuyPrice: 1490,
        avgSellPrice: 0,
        closingPrice: null,
        buyDate: "2026-09-01",
        isOpen: true,
      }),
      // Nothing on record to price it, and it DELIVERS SHARES: the row the
      // Funds tile never wanted and the other two tiles genuinely left out.
      tradeRow({
        id: SHORT_UNKNOWN,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        exchange: "NFO",
        symbol: "LT",
        tradingsymbol: "FUT LT 24 SEP 2026",
        expiry: EXPIRY,
        buyQty: 0,
        sellQty: 300,
        avgBuyPrice: 0,
        avgSellPrice: 0,
        closingPrice: null,
        sellDate: "2026-09-01",
        isOpen: true,
      }),
      // An ITM long call — the only row whose STT is delivery STT on the strike
      // value PLUS the exercise rate, both of which the footer names in words.
      tradeRow({
        id: ITM_OPTION,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "stock_option",
        instrumentType: "option",
        exchange: "NFO",
        symbol: "TCS",
        tradingsymbol: "OPT TCS 24 SEP 2026 3000 CE",
        optionType: "CE",
        strike: TCS_STRIKE,
        expiry: EXPIRY,
        buyQty: TCS_QTY,
        sellQty: 0,
        avgBuyPrice: 210,
        avgSellPrice: 0,
        closingPrice: null,
        buyDate: "2026-09-01",
        isOpen: true,
      }),
    ])
    .run();

  // `mtm_prices` is keyed on `symbol`, and `getSpotMap()` skips any row whose
  // tradingsymbol starts with "FUT "/"OPT " — so these are the CASH marks, as a
  // bhavcopy leaves them. LT gets none.
  t.db
    .insert(t.schema.mtmPrices)
    .values([
      { symbol: "SBIN", tradingsymbol: "SBIN", price: SBIN_CASH, asOfDate: "2026-09-08" },
      { symbol: "RELIANCE", tradingsymbol: "RELIANCE", price: RELIANCE_CASH, asOfDate: "2026-09-08" },
      { symbol: "TCS", tradingsymbol: "TCS", price: TCS_SPOT, asOfDate: "2026-09-08" },
    ])
    .run();

  // The token the REAL DB-backed cache answers with, so no scrip search runs.
  t.db
    .insert(t.schema.angeloneInstrumentTokens)
    .values({ exchange: "NSE", symbol: "SBIN", tradingsymbol: "SBIN-EQ", token: SBIN_TOKEN })
    .run();

  // The page is read ON the IST day boundary — only `Date` is faked, so the
  // SQLite calls behave exactly as they do in anger.
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
 * S1 — D WROTE THE SECOND CEILING IN WORDS; B WROTE IT AS AN INTEGER AND AS A
 * MAP SIZE.
 *
 * The consent sheet is the statement the user's acceptance is recorded
 * against. Fix wave 3's F1a pinned the REFUSED-login ceiling; this wave added a
 * second ceiling and a reset condition, and both were written twice — once in
 * English on the sheet and in PRIVACY.md, once in TypeScript in the adapter.
 * Nobody ran the sentence and the code together.
 *
 * RED ON EITHER SIDE: revert lib/domain/live-feed-disclosure.ts and the sheet
 * carries no "signs in at most … times in a row" clause at all (S1a's first
 * assertion); revert lib/quotes/angelone.ts and the count the sheet promises is
 * not the count the adapter keeps (S1b: the fifth poll still signs in).
 * ══════════════════════════════════════════════════════════════════════════ */

/** The one sheet item that states the sign-in, its triggers and both ceilings. */
const SIGN_IN_ITEM = ANGELONE_FEED_ITEMS.find((i) =>
  i.body.includes("Vyuha signs in to apiconnect.angelone.in"),
)!;

const NUMBER_WORDS: Record<string, number> = { once: 1, twice: 2, two: 2, three: 3, four: 4, five: 5 };

describe("S1 — the sheet's SECOND ceiling is the adapter's constant, and its reset word is the adapter's rule", () => {
  it("S1a  the invalidation ceiling the sheet and PRIVACY state parses to ANGELONE_MAX_SESSION_INVALIDATIONS", () => {
    // Derived from the SHEET, never restated: a test that wrote "three" twice
    // would agree with itself while the two files disagreed. The refused-login
    // ceiling is F1a's in tests/seams-v42-fix3.test.ts and is not re-asserted.
    const stated = /signs in at most (\w+) times in a row/.exec(SIGN_IN_ITEM.body)?.[1];
    expect(stated, "no invalidation-ceiling clause on the Angel One sheet").toBeTypeOf("string");
    expect(NUMBER_WORDS[stated!.toLowerCase()]).toBe(angelone.ANGELONE_MAX_SESSION_INVALIDATIONS);

    // The SHIPPED DOCUMENT says it in the same words, and it is the surface a
    // buyer reads before the app is ever opened.
    const privacy = plain(readDoc("docs/client/PRIVACY.md"));
    const inDoc = /signs in at most (\w+) times in a row/.exec(privacy)?.[1];
    expect(inDoc, "PRIVACY.md item 3 does not state the second ceiling").toBeTypeOf("string");
    expect(NUMBER_WORDS[String(inDoc).toLowerCase()]).toBe(angelone.ANGELONE_MAX_SESSION_INVALIDATIONS);

    // …and the sentence the capped adapter hands the user counts the same way.
    const inReason = /session invalid (\w+) times in a row/.exec(
      angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON,
    )?.[1];
    expect(NUMBER_WORDS[String(inReason).toLowerCase()]).toBe(angelone.ANGELONE_MAX_SESSION_INVALIDATIONS);
  });

  it("S1b  the sheet's reset word is 'priced', and an answer with no price does not reset the adapter's count", async () => {
    // The WORD, from the sheet — the promise the user accepted.
    const resetWord = /without a (\w+) answer in between/.exec(SIGN_IN_ITEM.body)?.[1];
    expect(resetWord, "the sheet no longer says what resets the count").toBe("priced");

    selectAccount(ACCOUNT);
    saveAngelOneConnection();
    setFeed("angelone", withFeedAck(null, "angelone"));

    // RUN A — the middle answer ARRIVES but carries no price (all `unfetched`).
    // By the sheet's word that is not a reset, so the third invalidation is
    // reached and the FIFTH poll sends nothing at all.
    const unpriced = rig({
      respond: (n) => (n === 2 ? { fetched: [], unfetched: [{ symbolToken: SBIN_TOKEN }] } : notEntitled()),
    });
    const a = await unpriced.poll(5);
    expect(a[4], `an unpriced answer must not reset the count — polls: ${JSON.stringify(a)}`).toBe(
      angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON,
    );
    expect(unpriced.logins, "one sign-in per session, and none after the cap").toBe(
      angelone.ANGELONE_MAX_SESSION_INVALIDATIONS,
    );

    // RUN B — the same shape with a PRICED middle answer. That one IS the
    // sheet's reset, so the cap arrives a full poll later.
    const priced = rig({
      respond: (n) => (n === 2 ? { fetched: [PRICED_ROW], unfetched: [] } : notEntitled()),
    });
    const b = await priced.poll(5);
    expect(b[4], `a priced answer must reset the count — polls: ${JSON.stringify(b)}`).not.toBe(
      angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON,
    );
    expect((await priced.poll(1))[0]).toBe(angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S2 — THE CAPPED HEALTH OBJECT, END TO END: adapter → the route's field names
 * → the Settings card's sentence and the desk's connect prompt.
 *
 * B invented a state no consumer had ever seen, and gave it the SAME shape as
 * the C-2 cap so that every consumer written for that one keeps working. Both
 * cap objects here are built by REAL provider instances against the real gate
 * and the real database; the only substitution is the broker.
 *
 * The route cannot be driven INTO the capped state — `health()` makes no
 * request and `GET` runs no poll — so the wire is crossed the other way: the
 * capped object is projected through the FIELD NAMES a real GET publishes, and
 * the card is handed the result. Drop `reason` from healthLine() and the card
 * prints "Not live — undefined" here.
 *
 * RED ON EITHER SIDE: revert angelone.ts and health() returns the stale
 * `lastError` ("Vyuha signs in again on the next poll") instead of the capped
 * sentence; revert live-feed-card.tsx's `feedHealthText` and the line is no
 * longer the sentence at all.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S2 — the invalidation cap reaches the card and the connect prompt in the C-2 cap's shape", () => {
  it("S2a  the capped health crosses the route's own health fields into one sentence on the card", async () => {
    selectAccount(ACCOUNT);
    saveAngelOneConnection();
    setFeed("angelone", withFeedAck(null, "angelone"));

    // THE CAP, reached by the real adapter on the real gate.
    const capped = rig({ respond: notEntitled });
    await capped.poll(3);
    const health = (await capped.provider.health()) as AngelOneHealth;
    expect(health.state).toBe("unreachable");
    expect(health.ok).toBe(false);
    expect(health.reason).toBe(angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON);

    // THE SAME SHAPE AS THE C-2 CAP — a second real instance, refused three
    // times, so the two capped states are compared rather than described.
    const refused = rig({
      // A MINUTE APART, so the C-2 attempt cap is what stops the fourth poll
      // and not the 60 s retry stamp.
      everyMs: angelone.ANGELONE_LOGIN_RETRY_MS + 1000,
      login: async () => {
        throw new Error("Angel One login: Invalid totp");
      },
    });
    await refused.poll(4);
    const refusedHealth = (await refused.provider.health()) as AngelOneHealth;
    expect({ ok: health.ok, state: health.state }).toEqual({
      ok: refusedHealth.ok,
      state: refusedHealth.state,
    });
    expect(refusedHealth.reason).toBe(angelone.ANGELONE_LOGIN_CAPPED_REASON);

    // THE WIRE — the field names the ROUTE actually publishes, taken from a
    // real GET against this database rather than written down here.
    const body = (await (await feedGet()).json()) as {
      feed: FeedState;
      health: Record<string, unknown>;
    };
    expect(body.feed.stored).toBe("angelone");
    expect(body.feed.effective).toBe("angelone");
    const src = health as unknown as Record<string, unknown>;
    const wire = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.keys(body.health).filter((k) => k in src).map((k) => [k, src[k]]))),
    ) as { ok?: boolean; state?: string; reason?: string; latencyMs?: number | null };
    expect(wire.state, "the route publishes no `state` for the card to key on").toBe("unreachable");

    // CONSUMER 1 — the Settings card's health line, off the wire shape.
    const line = feedHealthText({
      health: { ok: wire.ok!, latencyMs: wire.latencyMs ?? null, reason: wire.reason! },
      blocked: feedBlockState(body.feed) !== null,
    });
    expect(line).toBe(`Not live — ${angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON}`);
    expect(line).not.toContain("Feed OK");
    expect(line).not.toContain("signs in again on the next poll");
    // The stored pick still IS the effective one — a capped feed is not a
    // blocked pick, and the card must not offer a consent sheet for it.
    expect(feedBlockState(body.feed)).toBeNull();

    // CONSUMER 2 — the desk's once-a-day connect prompt keys on `state`.
    expect(showConnectPrompt({ providerId: "angelone", healthState: wire.state! }, null)).toBe(true);

    // The sentence names the SCREEN, and carries no value out of the vault.
    expect(line).toContain("Import → Connect broker");
    for (const secret of CREDENTIAL_VALUES) {
      expect(line, `the health line carries a stored credential value (${secret})`).not.toContain(secret);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S3 — THE TRIGGER LIST IS THE MEMO KEY'S FIELDS.
 *
 * `liveFeedInstanceKey()` decides WHICH Angel One instance a caller gets, and a
 * new instance signs in again on its next poll. So every user gesture that
 * changes that key is a sign-in the sheet must name — which is why D-1 added
 * the account switch to five copy surfaces this wave. The producer here is the
 * REAL registry against the real database: the gesture is performed, and the
 * instance identity is what says whether it is a trigger.
 *
 * RED ON EITHER SIDE: revert lib/quotes/registry.ts to before the account
 * entered the key and S3a's "a switched account is a new instance" fails;
 * revert lib/domain/live-feed-disclosure.ts and the clause it looks for is gone.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S3 — every gesture that rebuilds the Angel One instance is named on the sheet", () => {
  it("S3a  switching the selected account builds a NEW instance, and the sheet names that trigger", async () => {
    selectAccount(ACCOUNT);
    saveAngelOneConnection(ACCOUNT);
    setFeed("angelone", withFeedAck(null, "angelone"));

    const first = await registry.getLiveFeedProvider();
    expect(first.id).toBe("angelone");
    // MEMOISED (A-2): a second caller on the same key gets the same session,
    // which is what makes "at most once a day while Vyuha stays open" true.
    expect(await registry.getLiveFeedProvider()).toBe(first);

    // THE GESTURE — the account picker, including to and from "All accounts".
    t.db.update(t.schema.settings).set({ selectedAccountId: SECOND_ACCOUNT }).run();
    const onSwing = await registry.getLiveFeedProvider();
    expect(onSwing, "a switched account reused the other book's session").not.toBe(first);
    t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
    const onAll = await registry.getLiveFeedProvider();
    expect(onAll, "the All-accounts view reused the previous account's session").not.toBe(onSwing);

    // …and the sheet says so, in the words every other surface uses.
    expect(SIGN_IN_ITEM.body).toContain("when you switch the selected account, including to or from All accounts");

    // THE OTHER TWO GESTURES WITH A CLAUSE OF THEIR OWN: re-saving the
    // credentials (a new `updated_at` and a new ciphertext digest) and
    // accepting the disclosure, which is what starts the feed at all.
    t.db.update(t.schema.settings).set({ selectedAccountId: ACCOUNT }).run();
    const before = await registry.getLiveFeedProvider();
    saveAngelOneConnection(ACCOUNT, "2026-09-08T11:22:33.000Z");
    const afterResave = await registry.getLiveFeedProvider();
    expect(afterResave, "a re-saved credential kept the session minted from the old one").not.toBe(before);
    expect(SIGN_IN_ITEM.body).toContain("when you re-save the credentials");

    // The OTHER broker's acknowledgement, written WITHOUT `setFeed()` (whose
    // cache reset would decide the outcome by itself): since fix wave 5 the
    // Angel One key carries only ITS OWN ack entry (ruling S-2), so adding the
    // Upstox entry changes neither the key nor the instance — it is not a
    // trigger, and the sheet rightly does not name it.
    const keyBefore = await registry.liveFeedInstanceKey("angelone", 3);
    expect(keyBefore, "the Angel One key no longer carries its own ack entry").toContain("ack:1");
    t.db.update(t.schema.settings).set({ liveFeedAckJson: withFeedAck(withFeedAck(null, "upstox"), "angelone") }).run();
    expect(await registry.liveFeedInstanceKey("angelone", 3), "the Upstox acknowledgement re-keyed Angel One (S-2)").toBe(keyBefore);
    expect(await registry.getLiveFeedProvider(), "the Upstox acknowledgement rebuilt the Angel One instance (S-2)").toBe(afterResave);
    // The refresh slider is NOT in the Angel One key since fix wave 5 (ruling
    // S-2: the key is per provider and carries only what that adapter reads);
    // the card renders a derived cadence line INSTEAD of the slider under an
    // Angel One pick (ruling 4.2-4), so it needs no clause either way.
  });

  it("S3b  the sheet, PRIVACY, help ×3, both READMEs and the egress sentence all name the account switch", () => {
    const CLAUSE = "switch the selected account";
    // THE COPY SURFACES — each read from its own file, as shipped.
    expect(SIGN_IN_ITEM.body).toContain(CLAUSE);
    expect(plain(readDoc("docs/client/PRIVACY.md"))).toContain(CLAUSE);
    expect(plain(readDoc("README.md"))).toContain(CLAUSE);
    expect(plain(readDoc("docs/client/README.md"))).toContain(CLAUSE);

    // HELP — every entry that enumerates the trigger list, found by the trigger
    // it has always named rather than by an index into the array.
    const triggerEntries = HELP_ENTRIES.flatMap((e) => e.body).filter((b) =>
      b.includes("5 AM IST session flush"),
    );
    expect(triggerEntries.length, "no help entry enumerates the sign-in triggers").toBeGreaterThan(0);
    for (const body of triggerEntries) {
      expect(body, "a help entry lists the triggers without the account switch").toContain(CLAUSE);
    }

    // THE EGRESS SENTENCE — the capability block the egress guard holds to the
    // sheet. It says the same fact in the registry's own voice.
    expect(angelone.ANGELONE_CAPABILITIES.egressDescription).toContain("selected account is switched");
    // …and it carries the second ceiling too, which is the other thing this
    // wave taught the adapter to do.
    expect(angelone.ANGELONE_CAPABILITIES.egressDescription).toContain(
      "three sessions in a row that Angel One calls invalid",
    );
  });

  /**
   * THE SETTINGS ROW'S OWN TRIGGER LIST.
   *
   * `ANGELONE_FEED_COPY.blurb` is the sentence under the Angel One radio — the
   * screen where the feed is chosen, read BEFORE the sheet is opened. It
   * enumerates the same triggers as the sheet ("at most once a day while it
   * stays open — again after a relaunch, after Angel One's 5 AM IST session
   * flush, or when you re-save the credentials"), and D-1 added a fifth trigger
   * to every other surface. The registry's own header states the rule this test
   * applies: a field in the memo key without a clause under-states the egress.
   */
  it("S3c  the Settings card's Angel One row enumerates the same sign-in triggers as the sheet", () => {
    expect(ANGELONE_FEED_COPY.blurb).toContain("5 AM IST session flush");
    expect(ANGELONE_FEED_COPY.blurb).toContain("switch the selected account");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S4 — /risk → charge_config → computeSettlement → the obligations panel, on
 * ONE book carrying BOTH SIGNS and an unpriceable row.
 *
 * The page decides the rates and the side; the engine turns them into ₹ and
 * into a count; the panel is what a human reads. M-1 charged a SHORT an exit
 * STT it will never pay — shrinking the very jump this panel warns about — and
 * M-2 hung the other tiles' exclusion count on the Funds tile, printing a
 * caveat about a row that needs no cash at all.
 *
 * RED ON EITHER SIDE: revert lib/analytics/settlement.ts and the short's
 * `exitStt` is ₹840 instead of ₹0 while `unknownFundsCount` does not exist;
 * revert components/risk/expiry-obligations.tsx and the Funds tile carries
 * "1 unknown" again.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S4 — the page's rate and the position's side reach the panel", () => {
  const obligation = (id: number) => settlement.obligations.find((o) => o.id === id)!;

  it("S4a  squaring off a long costs the charge-config sell rate; a short's jump is the WHOLE delivery STT", () => {
    const short = obligation(SHORT_KNOWN);
    expect(short.side).toBe("short");
    expect(short.deliveryAction).toBe("Give delivery (sell)");
    expect(short.notional).toBe(SHORT_NOTIONAL);
    // The rate came from charge_config, not from the pure default.
    expect(short.physicalStt).toBe(SHORT_DELIVERY_STT);
    // M-1: futures STT is levied on the SELL leg, and squaring off a short is a
    // BUY. Pre-wave this was ₹630 (0.0009 × 700,000) and the jump was ₹210 —
    // a quarter of the real penalty.
    expect(short.exitStt).toBe(0);
    expect(short.sttJump).toBe(short.physicalStt);

    const long = obligation(LONG_KNOWN);
    expect(long.side).toBe("long");
    expect(long.deliveryAction).toBe("Take delivery (buy)");
    expect(long.notional).toBe(LONG_NOTIONAL);
    expect(long.physicalStt).toBe(LONG_DELIVERY_STT);
    // The other sign, and the one that DOES pay an exit STT.
    expect(long.exitStt).toBe(LONG_EXIT_STT);
    expect(long.sttJump).toBe(LONG_DELIVERY_STT - LONG_EXIT_STT);

    // THE CONSUMER'S OUTPUT — the two rupee cells a user reads on each row.
    expect(panelRowCells(SHORT_KNOWN)[5]).toBe("₹7,00,000");
    expect(panelRowCells(SHORT_KNOWN)[6]).toBe("₹840");
    expect(panelRowCells(LONG_KNOWN)[5]).toBe("₹3,00,000");
    expect(panelRowCells(LONG_KNOWN)[6]).toBe("₹360");
  });

  it("S4b  the unpriceable SHORT notes the two tiles that excluded it and leaves the Funds tile alone", () => {
    const unknown = obligation(SHORT_UNKNOWN);
    expect(unknown.settles).toBe("yes"); // it WILL devolve — that is why it is listed
    expect(unknown.deliveryAction).toBe("Give delivery (sell)");
    expect(unknown.notional).toBeNull();

    // The engine's two counts have parted company, and that is the fix.
    expect(settlement.unknownNotionalCount).toBe(1);
    expect(settlement.unknownFundsCount).toBe(0);
    // Whole and known: the long future plus the ITM call, and nothing missing.
    expect(settlement.fundsNeeded).toBe(LONG_NOTIONAL + OPTION_NOTIONAL);
    expect(settlement.notionalAtRisk).toBe(SHORT_NOTIONAL + LONG_NOTIONAL + OPTION_NOTIONAL);

    // THE TILES, rendered. WRONG pre-M-2: "Funds to take delivery ₹7.5L ·
    // 1 unknown" — a caveat about a row that delivers shares, on the tile that
    // counts cash.
    expect(panelStatText("Funds to take delivery")).not.toContain("unknown");
    expect(panelStatText("Notional at risk")).toContain("1 unknown");
    expect(panelStatText("STT on physical settlement")).toContain("1 unknown");

    // …and the row itself says the fact rather than naming ₹0.
    const cells = panelRowCells(SHORT_UNKNOWN);
    expect(cells[5]).toBe("—");
    expect(cells[6]).toBe("—");
    expect(cells.join(" ")).not.toContain("₹0");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S5 — THE EOD JOB'S OUTCOME, ACROSS ITS ROUTE.
 *
 * `scanBreaches()` stayed unscoped for the EOD job, which is right — it prices
 * every account from one bhavcopy — and tests/breach-scan-scope.test.ts pins
 * that and both page banners. What that file does not cross is the seam the
 * outcome actually travels: `POST /api/mtm/auto` spreads the job's own object
 * into its JSON, and `components/system/auto-mtm-runner.tsx` reads `ran` and
 * `reason` off it. This runs the REAL route against this database on the path
 * that touches no network: auto-MTM enabled, today's bhavcopy already applied.
 *
 * ONE-SIDED, AND SAID SO. Reverting lib/jobs/auto-mtm.ts reddens this file
 * (the pages no longer import `scanBreachesForSelectedAccount`), but not this
 * assertion: neither the outcome's shape nor the route changed this wave, so
 * nothing wave-new crosses here. It is a CONTRACT PIN over the one seam
 * tests/breach-scan-scope.test.ts does not reach, and it records what the grep
 * found: `outcome.breaches` — an unscoped scan of every account's open
 * positions, other books' symbols included — is serialised by this route and
 * read by nobody. `components/system/auto-mtm-runner.tsx:26` uses `ran` and
 * `reason` and drops the rest.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S5 — the auto-MTM route publishes the job's own outcome, field for field", () => {
  it("S5a  every field of AutoMtmOutcome survives the route, and the runner's two are correct", async () => {
    const target = latestBhavcopyDate(new Date());
    t.db.update(t.schema.settings).set({ autoMtmEnabled: true, lastAutoMtmDate: target }).run();

    const res = await autoMtmRoute.POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // THE SHAPE — the job's whole outcome, spread, plus the route's own `ok`.
    expect(Object.keys(body).sort()).toEqual(
      ["breaches", "date", "equityHeld", "ok", "priced", "ran", "reason"].sort(),
    );
    // THE TWO FIELDS THE RUNNER READS. `ran` false is the silent path — the
    // runner renders nothing at all, which is the design.
    expect(body.ran).toBe(false);
    expect(body.reason).toBe(`Already applied the ${target} bhavcopy.`);
    expect(body.date).toBe(target);
    // The breach payload is present and EMPTY on a run that did not happen —
    // never null, which the client's `d?.ran` path would still swallow but the
    // next reader of `breaches` would not.
    expect(body.breaches).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * S6 — THE FOOTER NAMES THE RATES THE PANEL COMPUTED WITH.
 *
 * P-1: for five months after the Finance Act 2026 moved `exerciseSttPct` to
 * 0.15%, the footer went on naming the repealed 0.125% while the panel computed
 * with the new one — a literal beside a constant. The footer now derives the
 * word, and it also says WHICH rates come from charge config. Both claims are
 * checked against the numbers this book's rows actually carry.
 *
 * RED ON EITHER SIDE (measured): revert components/risk/expiry-obligations.tsx
 * and the footer says 0.125% while the option row still prints ₹45 — S6a fails
 * on `expected 0.125 to be 0.15` and S6b loses the charge-config sentence.
 * Revert lib/analytics/settlement.ts and the ENGINE half goes with it (S4a:
 * `expected 630 to be +0`). app/risk/page.tsx is the third participant and its
 * settlement block did not change this wave — its two changed lines are the
 * breach-banner scope, which S5 and tests/breach-scan-scope.test.ts cover.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("S6 — the footer's rates are the rates the rows were computed with", () => {
  it("S6a  the two rates the footer prints reproduce the ITM option's own STT cell", () => {
    const option = settlement.obligations.find((o) => o.id === ITM_OPTION)!;
    expect(option.kind).toBe("stock_option");
    expect(option.moneyness).toBe("ITM");
    expect(option.intrinsicPerUnit).toBe(OPTION_INTRINSIC);
    expect(option.notional).toBe(OPTION_NOTIONAL);
    // R78: 540 (0.12% × 4,50,000) + 45 (0.15% × 200 × 150). It was ₹45 — the
    // exercise term alone, under a footer saying delivery STT was included.
    expect(option.physicalStt).toBe(OPTION_STT); // ₹585
    expect(option.physicalStt).not.toBe(OPTION_EXERCISE_STT);

    // THE WORDS ON THE FOOTER, parsed — never restated.
    const text = panelText();
    const exercise = /(\d+(?:\.\d+)?)% of intrinsic/.exec(text)?.[1];
    const delivery = /(\d+(?:\.\d+)?)% of the strike value/.exec(text)?.[1];
    expect(exercise, "the panel footer no longer names an exercise-STT rate").toBeTypeOf("string");
    expect(delivery, "the panel footer no longer names the delivery-STT rate on an option").toBeTypeOf("string");
    // The exercise word is the constant the page spread into computeSettlement;
    // the delivery word is the charge-config rate the page read (0.12% here —
    // no default carries it, so a footer printing the default fails).
    expect(Number(exercise)).toBe(DEFAULT_SETTLEMENT_RATES.exerciseSttPct * 100);
    expect(Number(delivery) / 100).toBeCloseTo(CONFIG_DELIVERY_STT, 10);
    // …and, read as rates, they reproduce the rupee figure on the row. A footer
    // naming the repealed 0.125% would compute 540 + 37 against a printed 585.
    expect(
      Math.round((Number(delivery) / 100) * OPTION_NOTIONAL) +
        Math.round((Number(exercise) / 100) * OPTION_INTRINSIC * TCS_QTY),
    ).toBe(option.physicalStt);
    expect(panelRowCells(ITM_OPTION)[6]).toBe("₹585");
    expect(text).not.toContain("0.125");
  });

  it("S6b  the two rates the footer attributes to charge config are the ones the page read from it", () => {
    const text = plain(panelText());
    // The footer's claim, in its own words.
    expect(text).toContain("Delivery STT and the futures square-off STT are read from your charge config");
    expect(text.toLowerCase()).toContain("not editable");
    // FALSE before P-1: it claimed every statutory rate was editable there,
    // and the exercise rate is a named constant by ruling.
    expect(text).not.toContain("Statutory rates are editable in charge config");

    // THE CLAIM, CHECKED. Both rates are read back out of charge_config and
    // must be the ones the obligations were priced with — not the pure
    // defaults, which this database deliberately does not carry.
    const configRate = (segment: string) =>
      (
        t.sqlite
          .prepare("SELECT stt_pct AS pct FROM charge_config WHERE segment = ? AND effective_to IS NULL LIMIT 1")
          .get(segment) as { pct: number }
      ).pct;
    const delivery = configRate("eq_delivery");
    const futExit = configRate("future");
    expect(delivery).not.toBe(DEFAULT_SETTLEMENT_RATES.deliverySttPct);
    expect(futExit).not.toBe(DEFAULT_SETTLEMENT_RATES.futExitSttPct);

    const long = settlement.obligations.find((o) => o.id === LONG_KNOWN)!;
    expect(long.physicalStt).toBe(Math.round(delivery * long.notional!));
    expect(long.exitStt).toBe(Math.round(futExit * long.notional!));
  });

  /**
   * R77/R78: the footer states WHO pays which STT, as facts — and in the same
   * substance as the Options Help Desk's sentence (R49): a physically settled
   * stock option carries delivery STT on both sides; exercise STT falls on the
   * long who exercises, never on the assigned writer; index options settle in
   * cash with no delivery STT. It said the reverse by omission before: one
   * "plus exercise STT" for every ITM option, whichever side it was on.
   */
  it("S6c  the footer says who pays which STT, and advises nothing", () => {
    const text = plain(panelText());
    const footer = text.slice(text.indexOf("Indian single-stock"));
    expect(footer.length, "the footer paragraph is missing").toBeGreaterThan(100);
    expect(footer).toMatch(/Delivery STT is charged on both sides/);
    // flattenText joins JSX leaves with a space, so the parenthesis may carry one.
    expect(footer).toMatch(/Exercise STT \(\s*[\d.]+% of intrinsic value\s*\) is paid only by a long whose option is exercised, not by the assigned writer/);
    expect(footer).toContain("Index options settle in cash with no delivery STT");
    // The old blanket "plus exercise STT" on every ITM stock option is gone.
    expect(footer).not.toMatch(/delivery-STT charge on the whole notional, plus exercise STT/);
    // SEBI copy: a fact about a levy, never an instruction about a position.
    expect(footer).not.toMatch(/\b(recommend\w*|suggest\w*|should|consider|advis\w*)\b/i);
  });
});
