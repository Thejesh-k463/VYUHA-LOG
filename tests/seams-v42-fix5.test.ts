import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/* ─────────────────────────────────────────────────────────────────────────────
 * SEAM TESTS — the v4.2 FIX WAVE 5 (S-1, S-2, U-1, U-2, D-1).
 *
 * FOUR builders plus the orchestrator, DISJOINT file sets. A disjoint wave
 * cannot produce an edit conflict; it also guarantees that nobody ran the two
 * halves of a crossing value together. Every test below BUILDS the value where
 * its producer builds it (the real adapter over the real gate and the real
 * token cache with only the BROKER injected, the real registry against one real
 * temp database, the real route handler, the real page functions, the shipped
 * markdown off disk), hands it across exactly as the product does (a memo key,
 * a JSON response body, a React prop, a localStorage key) and asserts the
 * CONSUMER'S OUTPUT — the sentence on the health line, the instance the registry
 * hands back, the breach set under the banner, the record in the store.
 *
 * NOTHING ON EITHER SIDE OF A SEAM IS MOCKED. Three substitutions appear and
 * none of them is a side of a seam:
 *   • `loginImpl` / `quoteImpl` / `searchImpl` — the BROKER, i.e. the far side
 *     of the NETWORK, not the far side of the seam (the same substitution
 *     tests/seams-v42-fix4.test.ts makes);
 *   • `globalThis.fetch` in C3a — the same broker, one layer lower, because
 *     that test needs the instance the REGISTRY built and the registry's
 *     factory takes no injection points. Both halves of the seam (the memo and
 *     the adapter's counters) are the shipped ones;
 *   • the clock, which the adapter already takes as an argument.
 *
 * OWNERSHIP (disjoint, by builder):
 *   A  lib/quotes/angelone.ts                       S-1 + the D-1 constants
 *   B  lib/quotes/registry.ts                       S-2 (the key, per provider)
 *   C  components/settings/live-feed-card.tsx, components/risk/breach-banner.tsx,
 *      app/page.tsx, app/risk/page.tsx              U-1, U-2
 *   D  lib/domain/live-feed-disclosure.ts, lib/domain/help-content.ts,
 *      docs/client/PRIVACY.md, README.md, docs/client/README.md   D-1
 *
 * ── THE CROSSING VALUES ──────────────────────────────────────────────────────
 *
 * # | crossing value                          | producer (file:line)                                   | consumer (file:line)                                      | unit / shape                | test
 * --|-----------------------------------------|--------------------------------------------------------|-----------------------------------------------------------|-----------------------------|-----
 * 1 | the FIRST-CAP clause, byte for byte     | D live-feed-disclosure.ts:172 (the sheet)              | A angelone.ts:254 egressDescription                       | one English sentence        | C1a
 *   | "…re-save the credentials or relaunch"  | D live-feed-disclosure.ts:172                          | A angelone.ts:157/177 the two capped runtime sentences    | a phrase ↔ a toast/health   | C1a
 *   | "without a priced answer in between"    | D live-feed-disclosure.ts:172 (2nd ceiling)           | A angelone.ts:886 `out.size>0 && c===invalidationsBefore` | a WORD ↔ a counter rule     | C1b, C1c
 * 2 | the FIVE sign-in triggers               | B registry.ts:471 liveFeedInstanceKey() field list     | D live-feed-disclosure.ts:172 trigger clauses             | a gesture ↔ a clause        | C2a
 *   | the fields that are NOT triggers        | B registry.ts:517-528 (per-provider consent/cadence)  | D — no clause, and none needed                            | absence of a key field      | C2a
 * 3 | the memoised INSTANCE                   | B registry.ts:596 getLiveFeedProvider() memo slot      | A angelone.ts:659/665 the C-2 and C-1 counters            | object identity ↔ a ceiling | C3a
 * 4 | the memo key, per provider              | B registry.ts:471 liveFeedInstanceKey()               | app/api/live/feed/route.ts:305 healthLine() → the card    | a cache key ↔ a session     | C4a, C4b
 * 5 | the selected account id                 | C app/page.tsx:86, app/risk/page.tsx:343 getSelected… | C breach-banner.tsx:52 BreachBanner({accountId})          | an integer prop             | C5a
 *   | the EOD job's scan scope                | lib/jobs/auto-mtm.ts:146 scanBreaches() (unscoped)    | lib/jobs/auto-mtm.ts:236 outcome.breaches                 | a WHERE clause              | C5b
 * 6 | the provider-write REFUSAL              | app/api/live/feed/route.ts:261 angelOneRefusal()      | C live-feed-card.tsx:706 store()'s `!r.ok` branch         | HTTP 409 + a sentence       | C6a, C6b
 *   | feed.blockedReason                      | registry.ts:355 resolveLiveFeed()                     | C live-feed-card.tsx:329 feedBlockState()                 | JSON on the wire            | C6a
 * 7 | the last-notified STORAGE KEY           | C breach-banner.tsx:36 lastNotifiedKey(accountId)     | C breach-banner.tsx:44 markNotified() → localStorage      | a `vyuha-` key ↔ a record   | C7a
 *
 * ── WHICH SIDE'S REVERT PROVES WHICH TEST (measured, one file at a time,
 *    `git show HEAD:<file>` over the worktree copy and back) ──────────────────
 *   C1a  D  live-feed-disclosure.ts   → the sheet's clause stops ending
 *           "…or relaunch Vyuha", so the string A publishes is no longer the
 *           string D wrote: `expect(egress).toContain(canonical)` fails.
 *        A  angelone.ts               → the same assertion fails from the other
 *           end, and the two capped sentences lose the phrase.
 *   C1b  A  angelone.ts               → the pre-wave `if (out.size > 0)` resets
 *           on the priced row of a poll whose LOOKUP was answered 401, so no
 *           ceiling ever fires: the fourth poll is `<no error>`.
 *   C1c  A  angelone.ts (the same revert) — this one stays GREEN there, and is
 *           here to catch the opposite mistake: an S-1 that also killed the
 *           reset the sheet promises would cap at poll 5 instead of poll 7.
 *   C2a  B  registry.ts               → `oaOn:`/`oaAck:` return to the Angel One
 *           key and an OpenAlgo toggle re-keys it.
 *   C3a  B  registry.ts               → the toggle rebuilds the instance, the
 *           cap is gone and the account is signed in again.
 *        A  angelone.ts               → the cap is never reached at all.
 *   C4a/b B registry.ts               → a broker acknowledgement, made through
 *           the real route, rebuilds the OpenAlgo/Upstox instance.
 *   C5a  C  app/page.tsx + app/risk/page.tsx → the banner is given no
 *           `accountId` at all.
 *   C6a  none — the route is not this wave's code. It is the seam's OTHER half:
 *           C's `store()` re-asks BECAUSE this answer changes underneath it,
 *           and C6b pins that re-ask. Said out loud rather than dressed up.
 *   C7a  C  breach-banner.tsx         → `lastNotifiedKey` and `markNotified` do
 *           not exist, so the file does not compile.
 *
 * ONE temp database for the whole file (`lib/db` caches its connection on
 * `globalThis` — AGENTS.md). Everything server-only is imported DYNAMICALLY
 * inside `beforeAll`, after the helper has set `VYUHA_DB_PATH`.
 * ────────────────────────────────────────────────────────────────────────── */

/* PURE modules — none of these reaches lib/db, so a static import is safe.
 * `breach-banner.tsx` is a client component whose import graph is React, lucide,
 * the button and `Breach` as a TYPE, so it cannot bind the connection either. */
import { BreachBanner, lastNotifiedKey, markNotified } from "@/components/risk/breach-banner";
import { ANGELONE_FEED_ITEMS, withFeedAck } from "@/lib/domain/live-feed-disclosure";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { OPENALGO_DISCLOSURE_VERSION } from "@/lib/domain/openalgo-disclosure";
import type { Breach } from "@/lib/risk/alerts";
import type { AngelQuoteData } from "@/lib/quotes/angelone";
import type { QuoteKey, QuoteProvider } from "@/lib/quotes/types";

let t: TempDb;
let angelone: typeof import("@/lib/quotes/angelone");
let registry: typeof import("@/lib/quotes/registry");
let feedRoute: typeof import("@/app/api/live/feed/route");
let job: typeof import("@/lib/jobs/auto-mtm");
let riskPage: () => unknown;
let dashboardPage: () => unknown;

/* ── the book: one open position per account, each through its own target ── */

const PERSONAL = 1;
const SWING = 2;
const ALL = 0;
const PERSONAL_ID = 961;
const SWING_ID = 962;

/* ── the Angel One credentials this database holds, and nothing else ─────── */

const CLIENT_CODE = "S5SEAM01";
const PIN = "9137";
/** A valid base32 seed — the REAL `totp()` mints from it in C3a. */
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const API_KEY = "seam-fix5-api-key";

/** The one symbol whose token is already in the cache, so it needs no lookup. */
const SBIN_TOKEN = "3045";
const PRICED_ROW = {
  exchange: "NSE",
  tradingSymbol: "SBIN-EQ",
  symbolToken: SBIN_TOKEN,
  ltp: 1005.9,
  close: 1016.1,
};
const SBIN: QuoteKey = { symbol: "SBIN", exchange: "NSE" };
/** The symbol that is NOT cached — every poll asks searchScrip for it. */
const LT: QuoteKey = { symbol: "LT", exchange: "NSE" };

/**
 * 18:30–24:00 UTC — the IST day boundary, which is where the Angel One session
 * clock is most likely to be wrong (the 05:00 IST flush is an IST-day fact).
 * 19:00 UTC is 00:30 IST the NEXT day, so a session minted here expires at
 * 05:00 IST that morning and no poll below crosses it.
 */
const AT_IST_BOUNDARY = new Date("2026-09-08T19:00:00.000Z");

/** What a session Angel One has stopped honouring answers to everything. */
const SESSION_INVALID = () => {
  throw new Error("Angel One quote: Invalid Token (AG8001)");
};

/* ── the ADAPTER RIG: the real gate, the real token cache, a fake broker ─── */

interface Poll {
  /** The message `snapshot()` threw, or `<no error>`. */
  error: string;
  /** How many rows it PRICED — the consumer's output, not a flag. */
  priced: number;
}

interface Rig {
  provider: QuoteProvider;
  readonly logins: number;
  poll(n: number): Promise<Poll[]>;
}

/**
 * The REAL Angel One provider — real gate (this database), real token cache
 * (the `angelone_instrument_tokens` row seeded below), real resolver, real
 * session, counter and clock arithmetic. Injected: the login call, the quote
 * call and the scrip search, which are the BROKER, and the clock, which is
 * already a parameter.
 */
function rig(opts: {
  keys: QuoteKey[];
  respond?: (n: number) => AngelQuoteData | null;
  search?: (n: number) => Awaited<ReturnType<import("@/lib/quotes/angelone-tokens").AngelSearchScrip>>;
}): Rig {
  let clock = AT_IST_BOUNDARY.getTime();
  const state = { logins: 0, quotes: 0, searches: 0 };
  const provider = angelone.createAngelOneProvider({
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    loginImpl: async () => {
      state.logins += 1;
      return { jwtToken: `jwt-${state.logins}` };
    },
    quoteImpl: async () => {
      state.quotes += 1;
      return opts.respond ? opts.respond(state.quotes) : { fetched: [PRICED_ROW], unfetched: [] };
    },
    searchImpl: async () => {
      state.searches += 1;
      if (!opts.search) return [];
      return opts.search(state.searches);
    },
  });
  return {
    provider,
    get logins() {
      return state.logins;
    },
    async poll(n: number) {
      const out: Poll[] = [];
      for (let i = 0; i < n; i += 1) {
        try {
          const snap = await provider.snapshot(opts.keys);
          out.push({ error: "<no error>", priced: snap.size });
        } catch (e) {
          out.push({ error: e instanceof Error ? e.message : String(e), priced: 0 });
        }
        clock += 3000; // the fastest cadence tier
      }
      return out;
    },
  };
}

/* ── reading the pages the way the browser reads the element tree ────────── */

/** The `<BreachBanner>` element itself, found by IDENTITY. */
function findByType(node: unknown, type: unknown): { props: Record<string, unknown> } | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findByType(n, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type && el.props) return { props: el.props };
  return el.props ? findByType(el.props.children, type) : undefined;
}

function bannerProps(page: () => unknown): Record<string, unknown> {
  const found = findByType(page(), BreachBanner);
  expect(found, "no <BreachBanner> in the rendered element tree").toBeDefined();
  return found!.props;
}

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id).sort((a, b) => a - b);

/* ── the shipped documents, as a reader reads them ───────────────────────── */

const REPO = process.cwd();
const readDoc = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
/** Markdown as a reader reads it: no quote marks, no bold, one space per gap. */
const plain = (md: string) =>
  md
    .replace(/^>\s?/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The one sheet item that states the sign-in, its triggers and both ceilings. */
const SIGN_IN_ITEM = ANGELONE_FEED_ITEMS.find((i) =>
  i.body.includes("Vyuha signs in to apiconnect.angelone.in"),
)!;

/* ── database gestures, made the way the product makes them ──────────────── */

/**
 * A settings write, exactly as `app/api/settings/route.ts` and
 * `app/api/live/feed/route.ts` make it — and DELIBERATELY without
 * `resetLiveFeedProviderCache()`. A helper that dropped the cache would rebuild
 * the instance whatever the key said, and the key is the subject: fix wave 4's
 * `setFeed()` did exactly that and made one of its own assertions vacuous.
 */
type SettingsPatch = Partial<{
  liveFeedProvider: string;
  liveFeedAckJson: string | null;
  openalgoEnabled: boolean;
  openalgoAckVersion: string | null;
  selectedAccountId: number;
  liveFeedRefreshSeconds: number;
}>;
const setSettings = (patch: SettingsPatch) => t.db.update(t.schema.settings).set(patch).run();

/** Save (or re-save) one broker's credentials for one account. */
function saveConnection(broker: string, accountId: number, updatedAt: string, secret = TOTP_SECRET) {
  t.sqlite.prepare("DELETE FROM broker_connections WHERE broker = ? AND account_id = ?").run(broker, accountId);
  t.db
    .insert(t.schema.brokerConnections)
    .values({
      accountId,
      broker,
      apiKey: broker === "angelone" ? API_KEY : `${broker}-api-key`,
      accessToken: "",
      authJson: JSON.stringify({ clientCode: CLIENT_CODE, pin: PIN, totpSecret: secret }),
      updatedAt,
    })
    .run();
}

const clearConnections = () => t.db.delete(t.schema.brokerConnections).run();

/** Angel One picked, acknowledged and connected on the Personal account. */
function angelOneLive(updatedAt = "2026-09-08T09:00:00.000Z") {
  clearConnections();
  saveConnection("angelone", PERSONAL, updatedAt);
  setSettings({
    liveFeedProvider: "angelone",
    liveFeedAckJson: withFeedAck(null, "angelone"),
    openalgoEnabled: false,
    openalgoAckVersion: null,
    selectedAccountId: PERSONAL,
    liveFeedRefreshSeconds: 3,
  });
  registry.resetLiveFeedProviderCache();
}

const REQ = { host: "127.0.0.1:3011" };
const feedGet = () =>
  feedRoute.GET(new Request("http://127.0.0.1:3011/api/live/feed", { headers: REQ }));
const feedPost = (body: unknown) =>
  feedRoute.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { ...REQ, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  t = await openTempDb("seams-v42-fix5", { seed: true });
  // The dev/e2e override outranks the stored pick; nothing in this file may
  // read a provider the operator's shell chose.
  delete process.env.VYUHA_QUOTE_PROVIDER;

  angelone = await import("@/lib/quotes/angelone");
  registry = await import("@/lib/quotes/registry");
  feedRoute = await import("@/app/api/live/feed/route");
  job = await import("@/lib/jobs/auto-mtm");
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  dashboardPage = (await import("@/app/page")).default as () => unknown;

  t.db
    .update(t.schema.settings)
    .set({ equityCapital: 1_000_000, activeCapital: 1_000_000, selectedAccountId: PERSONAL })
    .run();
  // A SECOND live account, so 0 is genuinely the aggregate VIEW and not a
  // single-account book resolved to its one account (`getSelectedAccountId`).
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      // Personal — TCS through its target on its own recorded close.
      tradeRow({
        id: PERSONAL_ID,
        accountId: PERSONAL,
        symbol: "TCS",
        tradingsymbol: "TCS",
        instrumentType: "equity",
        buyQty: 10,
        sellQty: 0,
        avgBuyPrice: 2000,
        closingPrice: 2100,
        targetPlanned: 2050,
        isOpen: true,
      }),
      // Swing — INFY, likewise. A different symbol, so a leak is legible.
      tradeRow({
        id: SWING_ID,
        accountId: SWING,
        symbol: "INFY",
        tradingsymbol: "INFY",
        instrumentType: "equity",
        buyQty: 10,
        sellQty: 0,
        avgBuyPrice: 1500,
        closingPrice: 1600,
        targetPlanned: 1550,
        isOpen: true,
      }),
    ])
    .run();

  // The token the REAL DB-backed cache answers with, so SBIN needs no lookup
  // and LT needs one on every single poll.
  t.db
    .insert(t.schema.angeloneInstrumentTokens)
    .values({ exchange: "NSE", symbol: "SBIN", tradingsymbol: "SBIN-EQ", token: SBIN_TOKEN })
    .run();
});

afterAll(() => {
  registry?.resetLiveFeedProviderCache();
  t?.cleanup();
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C1 — D WROTE THE CAP IN ENGLISH; A WROTE IT AS A SENTENCE THE USER IS HANDED
 * AND AS A COUNTER RULE.
 *
 * D-1 rewrote one clause on five copy surfaces; A rewrote the same clause
 * inside `ANGELONE_CAPABILITIES.egressDescription` and inside the two capped
 * runtime sentences. Nobody ran the sheet and the constant together — and the
 * consent sheet is the statement the user's acceptance is recorded against, so
 * a promise the code does not keep is the whole defect class.
 *
 * The SECOND ceiling's clause did not change this wave, but its MEANING did:
 * S-1 is what makes "without a priced answer in between" true on the path
 * where the priced answer and the invalidation arrive in the same poll.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("C1 — the sheet's cap clause is the adapter's constant, and its ceiling rule", () => {
  /** The clause AS D WROTE IT. Never restated here: a test that wrote the
   *  sentence out twice would agree with itself while the files disagreed. */
  const CANONICAL = /If a sign-in is refused,[^.]+\./.exec(SIGN_IN_ITEM.body)?.[0] ?? "";

  it("C1a  the sheet's first-cap clause is byte-identical in A's egress sentence, and A's two capped sentences promise what it promises", () => {
    expect(CANONICAL, "the sheet no longer carries a first-cap clause at all").toContain(
      "If a sign-in is refused",
    );
    // THE PROMISE ITSELF — the half D-1 added. Parsed out of the sheet, so this
    // is D's wording and not a copy of it.
    const resumes = /then stops until you (.+)\.$/.exec(CANONICAL)?.[1];
    expect(resumes, "the sheet's first cap does not say what lifts it").toBe(
      "re-save the credentials or relaunch Vyuha",
    );

    // CONSUMER 1 — the registry's capability block, the ONE claim the egress
    // guard holds lib/quotes/angelone.ts to. Byte for byte, not paraphrased.
    expect(
      angelone.ANGELONE_CAPABILITIES.egressDescription,
      "the egress sentence and the consent sheet state the first cap differently (D-1)",
    ).toContain(CANONICAL);

    // CONSUMER 2 — the two sentences a CAPPED instance actually hands the user,
    // one per kind of failure (ruling P-3). Both must resume the same way, or
    // the two capped states differ in more than what happened.
    for (const [name, sentence] of [
      ["ANGELONE_LOGIN_CAPPED_REASON", angelone.ANGELONE_LOGIN_CAPPED_REASON],
      ["ANGELONE_LOGIN_UNREACHABLE_CAPPED_REASON", angelone.ANGELONE_LOGIN_UNREACHABLE_CAPPED_REASON],
    ] as const) {
      expect(sentence, `${name} does not promise what the sheet promises (D-1)`).toContain(resumes!);
      expect(sentence, `${name} still sends the user to re-save and nothing else (D-1)`).toContain(
        "relaunch Vyuha",
      );
    }

    // THE SHIPPED DOCUMENTS say the same sentence, off disk, as a buyer reads
    // them before the app is ever opened.
    for (const doc of ["docs/client/PRIVACY.md", "README.md", "docs/client/README.md"] as const) {
      expect(plain(readDoc(doc)), `${doc} states the first cap in different words (D-1)`).toContain(CANONICAL);
    }
    // …and every help entry that states the first cap, found by the clause
    // itself rather than by an index into the array. (The privacy entry at
    // help-content.ts:501 enumerates the same five triggers and states NEITHER
    // ceiling — it never has, and D-1 did not add one, so it is not a surface
    // this clause must appear on.)
    const capEntries = HELP_ENTRIES.flatMap((e) => e.body).filter((b) =>
      b.includes("If a sign-in is refused"),
    );
    expect(capEntries.length, "no help entry states the first cap").toBe(2);
    for (const body of capEntries) {
      expect(body, "a help entry states the first cap in different words (D-1)").toContain(CANONICAL);
    }

    // THE SWEEP D-1 IS: nowhere may the PRE-WAVE sentence survive. It ends at
    // "re-save the credentials." — the new one runs on into "or relaunch
    // Vyuha", so this substring matches the old copy and only the old copy.
    const STALE = "then stops until you re-save the credentials.";
    for (const [where, text] of [
      ["the consent sheet", SIGN_IN_ITEM.body],
      ["ANGELONE_CAPABILITIES.egressDescription", angelone.ANGELONE_CAPABILITIES.egressDescription],
      ["ANGELONE_LOGIN_CAPPED_REASON", angelone.ANGELONE_LOGIN_CAPPED_REASON],
      ["ANGELONE_LOGIN_UNREACHABLE_CAPPED_REASON", angelone.ANGELONE_LOGIN_UNREACHABLE_CAPPED_REASON],
      ["docs/client/PRIVACY.md", plain(readDoc("docs/client/PRIVACY.md"))],
      ["README.md", plain(readDoc("README.md"))],
      ["docs/client/README.md", plain(readDoc("docs/client/README.md"))],
      ["the help entries", HELP_ENTRIES.flatMap((e) => e.body).join(" ")],
    ] as const) {
      expect(text, `${where} still says a re-save is the only thing that lifts the cap (D-1)`).not.toContain(
        STALE,
      );
    }

    // THE SECOND CEILING is still the S-1 rule in words, on the sheet and in the
    // egress sentence — the clause C1b and C1c drive through the adapter.
    expect(SIGN_IN_ITEM.body).toContain("without a priced answer in between");
    expect(angelone.ANGELONE_CAPABILITIES.egressDescription).toContain("with no priced answer in between");
  });

  it("C1b  a lookup answered 401 in the SAME poll as a priced row is not 'a priced answer in between'", async () => {
    // THE NUMBER, from the sheet — the promise the user accepted, parsed rather
    // than restated, so this expectation is D's and the behaviour is A's.
    const stated = /signs in at most (\w+) times in a row/.exec(SIGN_IN_ITEM.body)?.[1];
    expect(stated, "the sheet no longer states the invalidation ceiling").toBe("three");
    const ceiling = angelone.ANGELONE_MAX_SESSION_INVALIDATIONS;
    expect(ceiling).toBe(3);

    angelOneLive();

    // THE FIXTURE S-1 IS ABOUT: the symbol lookup is answered with a
    // session-invalid error while the quote for the ALREADY-CACHED token is
    // priced by the jwt minted moments earlier. Both are true of the same poll.
    const mixed = rig({
      keys: [SBIN, LT],
      search: () => {
        throw new Error("Angel One symbol search: HTTP 401");
      },
      respond: () => ({ fetched: [PRICED_ROW], unfetched: [] }),
    });
    const polls = await mixed.poll(ceiling + 1);

    // The poll really did BOTH THINGS — a fixture that priced nothing would
    // reach the cap for the ordinary C-1 reason and prove nothing about S-1.
    for (let i = 0; i < ceiling; i += 1) {
      expect(polls[i].priced, `poll ${i + 1} priced nothing — the fixture is not the S-1 case`).toBe(1);
      expect(polls[i].error, `poll ${i + 1} threw`).toBe("<no error>");
    }
    // …and the ceiling the sheet promises fires on the next one. Pre-S-1 the
    // priced row reset the count on every poll, so no ceiling could EVER fire
    // and the credential went out at poll cadence.
    expect(
      polls[ceiling].error,
      `a priced row on a session invalidated in the same poll reset the count — polls: ${JSON.stringify(polls)}`,
    ).toBe(angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON);
    expect(mixed.logins, "the credential kept going out after the ceiling").toBe(ceiling);

    // THE CONSUMER'S OUTPUT — the sentence a capped instance hands the card.
    const health = await mixed.provider.health();
    expect(health.ok).toBe(false);
    expect(health.reason).toBe(angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON);
  });

  it("C1c  a clean priced poll still resets the count — S-1 did not take the sheet's reset with it", async () => {
    angelOneLive();

    // ONE key, already cached: no lookup runs at all, so nothing but the QUOTE
    // can invalidate. The middle poll is priced by a session nothing complained
    // about, which is exactly what the sheet calls "a priced answer in between".
    const clean = rig({
      keys: [SBIN],
      respond: (n) => (n === 3 ? { fetched: [PRICED_ROW], unfetched: [] } : SESSION_INVALID()),
    });
    const polls = await clean.poll(7);
    expect(polls[2].priced, "the middle poll priced nothing — it is not a reset").toBe(1);
    // Two invalidations, a priced poll, three more invalidations: the cap
    // arrives on the SEVENTH poll. An S-1 that also killed the reset would cap
    // on the fifth.
    expect(
      polls[4].error,
      `the priced poll did not reset the count — polls: ${JSON.stringify(polls)}`,
    ).not.toBe(angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON);
    expect(polls[6].error, `the count never reached the ceiling — polls: ${JSON.stringify(polls)}`).toBe(
      angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C2 — THE SHEET'S TRIGGER LIST IS THE ANGEL ONE KEY'S FIELD LIST.
 *
 * Ruling D-1 makes `liveFeedInstanceKey()`'s user-changeable fields the sign-in
 * trigger list a customer is shown; S-2 is what made that true again, by
 * scoping the key per provider. So the test is symmetrical: every field that
 * moves the key must have a clause on the sheet, and every gesture with no
 * clause must not move it.
 *
 * The key STRING a real database produces is enumerated here rather than
 * re-derived from the source text — a composition assertion over the source
 * would prove nothing about the value. Every write below is made directly, with
 * no cache reset: a helper that dropped the memo would decide the outcome by
 * itself, which is how fix wave 4's `setFeed()` made one assertion vacuous.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("C2 — the Angel One key carries the five triggers and nothing else (S-2 ↔ D-1)", () => {
  it("C2a  no OpenAlgo field and no slider in the key; the two gestures that ARE fields are the two the sheet names", async () => {
    angelOneLive();
    const base = await registry.liveFeedInstanceKey("angelone", 3);

    // THE FIELD LIST, read off the value. `oaOn:`/`oaAck:` are OpenAlgo's own
    // consent, which no broker key may see (S-2), and `refresh:` is a slider
    // `createProvider()` never hands to this adapter (ruling 4.2-4).
    for (const token of ["oaOn:", "oaAck:", "refresh:"]) {
      expect(base, `the Angel One key still carries a \`${token}\` field (S-2)`).not.toContain(token);
    }
    // Its own consent IS there — a stale acknowledgement must rebuild.
    expect(base, "the Angel One key lost its own acknowledgement entry").toContain("ack:1");
    // …and the slider is not a field however far it is moved.
    expect(
      await registry.liveFeedInstanceKey("angelone", 5),
      "the refresh slider re-keys a provider that never reads it",
    ).toBe(base);

    /* ── the gestures with NO clause: none of them may move the key ────── */
    setSettings({ openalgoEnabled: true, openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION });
    expect(
      await registry.liveFeedInstanceKey("angelone", 3),
      "switching the OpenAlgo integration ON re-keyed Angel One: an undisclosed sign-in (S-2)",
    ).toBe(base);
    setSettings({ openalgoEnabled: false });
    expect(
      await registry.liveFeedInstanceKey("angelone", 3),
      "switching the OpenAlgo integration OFF re-keyed Angel One (S-2)",
    ).toBe(base);
    setSettings({ openalgoAckVersion: "99" });
    expect(
      await registry.liveFeedInstanceKey("angelone", 3),
      "an OpenAlgo acknowledgement version re-keyed Angel One (S-2)",
    ).toBe(base);
    setSettings({ liveFeedAckJson: withFeedAck(withFeedAck(null, "angelone"), "upstox") });
    expect(
      await registry.liveFeedInstanceKey("angelone", 3),
      "acknowledging the UPSTOX sheet re-keyed Angel One (S-2)",
    ).toBe(base);
    // The OTHER broker's saved credentials are not this broker's either.
    saveConnection("upstox", PERSONAL, "2026-09-09T04:00:00.000Z");
    expect(
      await registry.liveFeedInstanceKey("angelone", 3),
      "saving an Upstox connection re-keyed Angel One (S-2)",
    ).toBe(base);
    // And no other feed's ack version is anywhere in the string: the Upstox
    // entry above is a DIFFERENT version, so a whole-column key would show it.
    setSettings({ liveFeedAckJson: JSON.stringify({ angelone: "1", upstox: "77" }) });
    expect(
      await registry.liveFeedInstanceKey("angelone", 3),
      "the Angel One key carries the Upstox acknowledgement version (S-2)",
    ).toBe(base);

    /* ── the gestures WITH a clause: each one must move the key ────────── */
    // "when you re-save the credentials" — a new `updated_at` and a new digest.
    saveConnection("angelone", PERSONAL, "2026-09-09T05:00:00.000Z", "NEWSECRETJBSWY3DP");
    const afterResave = await registry.liveFeedInstanceKey("angelone", 3);
    expect(afterResave, "re-saving the credentials did not rebuild the session").not.toBe(base);
    expect(SIGN_IN_ITEM.body).toContain("when you re-save the credentials");

    // "when you switch the selected account, including to or from All accounts".
    setSettings({ selectedAccountId: SWING });
    const onSwing = await registry.liveFeedInstanceKey("angelone", 3);
    expect(onSwing, "a switched account reused the other book's session").not.toBe(afterResave);
    setSettings({ selectedAccountId: ALL });
    expect(
      await registry.liveFeedInstanceKey("angelone", 3),
      "the All-accounts view reused an account's session",
    ).not.toBe(onSwing);
    expect(SIGN_IN_ITEM.body).toContain(
      "when you switch the selected account, including to or from All accounts",
    );

    // "when the acknowledgement is accepted" — its OWN entry, which is what
    // makes the sheet's acceptance the thing that starts the feed.
    setSettings({ selectedAccountId: PERSONAL, liveFeedAckJson: JSON.stringify({ angelone: "0" }) });
    expect(
      await registry.liveFeedInstanceKey("angelone", 3),
      "the Angel One acknowledgement left the key — accepting the sheet would not rebuild",
    ).not.toBe(afterResave);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C3 — THE MEMO SLOT AND THE CEILINGS ARE THE SAME OBJECT.
 *
 * B's memo decides WHICH instance a caller gets; A's ceilings live in that
 * instance's closure. So a key that moves for a gesture no surface names does
 * not merely rebuild an object — it clears both caps and signs the account in
 * again. That is one defect made of two files, and neither builder could see it
 * alone.
 *
 * The instance under test is the one the REGISTRY built, so the broker is
 * substituted at `globalThis.fetch` — the same far side of the same network the
 * rig above injects, one layer lower. The gate, the token cache, the resolver,
 * the session, both counters and the memo are all the shipped code. Real time,
 * deliberately: the 1 req/s guard is a wall-clock rule and freezing `Date`
 * would make it refuse the second request of every poll.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("C3 — an OpenAlgo toggle leaves a CAPPED Angel One instance capped (S-2 ↔ S-1)", () => {
  it(
    "C3a  the cap survives the toggle, on the same object, and no further sign-in is made",
    async () => {
      angelOneLive();
      const realFetch = globalThis.fetch;
      const calls = { login: 0, search: 0, quote: 0 };
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      // THE BROKER, and nothing else: a session it mints, a lookup it answers
      // AG8001, and a quote it prices for the token already in the cache.
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("loginByPassword")) {
          calls.login += 1;
          return json({ status: true, data: { jwtToken: `jwt-${calls.login}` } });
        }
        if (url.includes("searchScrip")) {
          calls.search += 1;
          return json({ status: false, message: "Invalid Token", errorcode: "AG8001" }, 401);
        }
        if (url.includes("/market/v1/quote")) {
          calls.quote += 1;
          return json({ status: true, data: { fetched: [PRICED_ROW], unfetched: [] } });
        }
        throw new Error(`unexpected host in a seam test: ${url}`);
      });

      try {
        const before = await registry.getLiveFeedProvider();
        expect(before.id).toBe("angelone");
        // MEMOISED (A-2): a second caller gets the same session, which is what
        // makes "at most once a day while Vyuha stays open" true.
        expect(await registry.getLiveFeedProvider(), "the memo missed on an unchanged database").toBe(before);

        // DRIVE IT TO THE CEILING through the S-1 path — the lookup is refused,
        // the cached token is still priced, and the count no longer resets.
        for (let i = 0; i < angelone.ANGELONE_MAX_SESSION_INVALIDATIONS; i += 1) {
          const snap = await before.snapshot([SBIN, LT]);
          expect(snap.size, `poll ${i + 1} priced nothing — the fixture is not the S-1 case`).toBe(1);
        }
        const capped = await before.health();
        expect(
          capped.reason,
          "the instance the REGISTRY built never reached the ceiling (S-1)",
        ).toBe(angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON);
        const loginsAtCap = calls.login;
        expect(loginsAtCap).toBe(angelone.ANGELONE_MAX_SESSION_INVALIDATIONS);

        // THE GESTURE NO SURFACE NAMES — Settings → Integrations → OpenAlgo on.
        setSettings({ openalgoEnabled: true, openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION });

        const after = await registry.getLiveFeedProvider();
        expect(
          after,
          "flipping the OpenAlgo switch rebuilt the Angel One instance: an undisclosed sign-in with both ceilings cleared (S-2)",
        ).toBe(before);
        // THE CONSUMER'S OUTPUT — the sentence the card would print, after the
        // toggle. Pre-S-2 this read "Angel One is connected with your own
        // account, polling every 3 seconds" on an instance that had just been
        // stopped for re-sending a credential nothing could use.
        expect((await after.health()).reason).toBe(angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON);

        // …and the next poll sends NOTHING: no login, no lookup, no quote.
        await expect(after.snapshot([SBIN, LT])).rejects.toThrow(
          angelone.ANGELONE_SESSION_INVALID_CAPPED_REASON,
        );
        expect(calls.login, "the account was signed in again after the cap (S-2 + S-1)").toBe(loginsAtCap);
      } finally {
        vi.stubGlobal("fetch", realFetch);
        registry.resetLiveFeedProviderCache();
      }
    },
    60_000,
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C4 — THE OWNER'S ADDITION, THROUGH THE ROUTE THAT MAKES THE GESTURE.
 *
 * "make sure OPEN ALGO keys doesn't merge, collide or disturb the original
 * broker keys (a user can have either Open algo key or broker or Both, every
 * item key is different so they should work as they are BUILT PERFECTLY)".
 *
 * tests/quotes-registry.test.ts drives `liveFeedInstanceKey()` and
 * `getLiveFeedProvider()` directly. This crosses the same property through the
 * PRODUCT PATH: the acknowledgement is written by the real
 * `POST /api/live/feed {action:"ack"}`, the pick by the real
 * `{action:"provider"}`, and the instance is the one the real `GET`'s
 * `healthLine()` resolved. `loadLiveDesk()` is deliberately NOT used: it takes a
 * snapshot, and this book has open positions, so it would put them on the wire.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("C4 — three configurations, through the feed route: every item keys on its own", () => {
  /** CONFIGURATION 1 — an OpenAlgo key and nothing else. */
  function openAlgoOnly() {
    clearConnections();
    saveConnection("openalgo", PERSONAL, "2026-09-08T10:11:12.000Z");
    setSettings({
      liveFeedProvider: "openalgo",
      liveFeedAckJson: null,
      openalgoEnabled: true,
      openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION,
      selectedAccountId: PERSONAL,
      liveFeedRefreshSeconds: 3,
    });
    registry.resetLiveFeedProviderCache();
  }

  /** CONFIGURATION 2 — one broker's credentials and no OpenAlgo consent. */
  function brokerOnly(broker: "angelone" | "upstox") {
    clearConnections();
    saveConnection(broker, PERSONAL, "2026-09-08T09:00:00.000Z");
    setSettings({
      liveFeedProvider: broker,
      liveFeedAckJson: withFeedAck(null, broker),
      openalgoEnabled: false,
      openalgoAckVersion: null,
      selectedAccountId: PERSONAL,
      liveFeedRefreshSeconds: 3,
    });
    registry.resetLiveFeedProviderCache();
  }

  it("C4a  an acknowledgement written by the ROUTE never rebuilds another feed's instance", async () => {
    /* ── OpenAlgo only ──────────────────────────────────────────────────── */
    openAlgoOnly();
    const oa = await registry.getLiveFeedProvider();
    expect(oa.id).toBe("openalgo");
    expect(await registry.getLiveFeedProvider(), "the memo missed on an unchanged database").toBe(oa);

    // THE GESTURE — "Review and accept" on the Angel One sheet, which is one
    // POST on the real route. The user holds an OpenAlgo key AND is reading a
    // broker's sheet; the OpenAlgo session must not notice.
    const ack = await feedPost({ action: "ack", provider: "angelone" });
    expect(ack.status).toBe(200);
    expect(
      await registry.getLiveFeedProvider(),
      "accepting a BROKER sheet rebuilt the OpenAlgo instance and dropped its shared rate guard (S-2)",
    ).toBe(oa);
    const ack2 = await feedPost({ action: "ack", provider: "upstox" });
    expect(ack2.status).toBe(200);
    expect(
      await registry.getLiveFeedProvider(),
      "accepting the other broker's sheet rebuilt the OpenAlgo instance (S-2)",
    ).toBe(oa);

    /* ── a broker only, both brokers in turn ────────────────────────────── */
    for (const broker of ["angelone", "upstox"] as const) {
      brokerOnly(broker);
      const feed = await registry.getLiveFeedProvider();
      expect(feed.id, `${broker} is not the effective feed in its own configuration`).toBe(broker);

      // The OTHER broker's sheet, accepted on the real route.
      const other = broker === "angelone" ? "upstox" : "angelone";
      expect((await feedPost({ action: "ack", provider: other })).status).toBe(200);
      expect(
        await registry.getLiveFeedProvider(),
        `acknowledging the ${other} sheet rebuilt the live ${broker} instance (S-2)`,
      ).toBe(feed);

      // …and the OpenAlgo integration, switched on and off underneath it.
      setSettings({ openalgoEnabled: true, openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION });
      expect(
        await registry.getLiveFeedProvider(),
        `switching OpenAlgo ON rebuilt the live ${broker} instance (S-2)`,
      ).toBe(feed);
      setSettings({ openalgoEnabled: false, openalgoAckVersion: null });
      expect(
        await registry.getLiveFeedProvider(),
        `switching OpenAlgo OFF rebuilt the live ${broker} instance (S-2)`,
      ).toBe(feed);
    }
  });

  it("C4b  BOTH configured: the route's own GET resolves the picked feed, and switching picks never crosses the keys", async () => {
    // Both items held at once — the third configuration the owner named.
    clearConnections();
    saveConnection("angelone", PERSONAL, "2026-09-08T09:00:00.000Z");
    saveConnection("openalgo", PERSONAL, "2026-09-08T10:11:12.000Z");
    setSettings({
      liveFeedAckJson: withFeedAck(withFeedAck(null, "angelone"), "upstox"),
      openalgoEnabled: true,
      openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION,
      selectedAccountId: PERSONAL,
      liveFeedRefreshSeconds: 3,
    });

    // THE PICK, made by the real route rather than by a settings write.
    const pick = await feedPost({ action: "provider", provider: "angelone" });
    expect(pick.status).toBe(200);
    registry.resetLiveFeedProviderCache();

    // THE ROUTE'S OWN GET builds the instance (`healthLine()` → the registry),
    // and the next caller must be handed that very object — the memo is what
    // makes one sign-in serve the SSR desk, the stream and this card.
    const body = (await (await feedGet()).json()) as { feed: { stored: string; effective: string }; health: { provider: string } };
    expect(body.feed.stored).toBe("angelone");
    expect(body.feed.effective).toBe("angelone");
    expect(body.health.provider).toBe("angelone");
    const fromRoute = await registry.getLiveFeedProvider();
    expect(fromRoute.id).toBe("angelone");

    // THE THREE KEYS, on this one state: all different, and each moves only for
    // its own item.
    const keys = {
      angelone: await registry.liveFeedInstanceKey("angelone", 3),
      upstox: await registry.liveFeedInstanceKey("upstox", 3),
      openalgo: await registry.liveFeedInstanceKey("openalgo", 3),
    };
    expect(new Set(Object.values(keys)).size, "two providers share one instance key").toBe(3);
    for (const [id, key] of Object.entries(keys)) {
      expect(key.startsWith(`${id}|`), `${id}'s key does not lead with its own id`).toBe(true);
    }

    // Move ONE item: the OpenAlgo consent. Only OpenAlgo's key may move.
    setSettings({ openalgoEnabled: false });
    expect(await registry.liveFeedInstanceKey("angelone", 3)).toBe(keys.angelone);
    expect(await registry.liveFeedInstanceKey("upstox", 3)).toBe(keys.upstox);
    expect(
      await registry.liveFeedInstanceKey("openalgo", 3),
      "the OpenAlgo switch is not in the OpenAlgo key either — nothing would ever rebuild it",
    ).not.toBe(keys.openalgo);

    // …and the live Angel One instance the route resolved is untouched by it.
    expect(
      await registry.getLiveFeedProvider(),
      "the OpenAlgo switch rebuilt the instance the route's GET had just resolved (S-2)",
    ).toBe(fromRoute);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C5 — THE ID THE BANNER IS GIVEN IS THE ID ITS BREACHES WERE SCOPED BY.
 *
 * Two values leave the same page render: `scanBreachesForSelectedAccount()`
 * (the set) and `getSelectedAccountId()` (the id). U-2 is only true if they are
 * the same selection — a banner told the wrong account keeps one device record
 * for another book's set, which is the bug U-2 fixed wearing a different hat.
 *
 * tests/breach-scan-scope.test.ts asserts each side against a LITERAL. This
 * asserts them against EACH OTHER: the set under the banner is re-derived from
 * the id the banner was handed, so a page that scoped by one account and
 * labelled by another reddens here and nowhere else.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("C5 — the banner's account id and its breach set are one selection (U-2)", () => {
  const selectAccount = (id: number) => setSettings({ selectedAccountId: id });

  it("C5a  on both pages, for Personal, Swing and the All view, the set is the scan of the id given", () => {
    for (const [label, page] of [
      ["/risk", () => riskPage()],
      ["/", () => dashboardPage()],
    ] as const) {
      for (const id of [PERSONAL, SWING, ALL]) {
        selectAccount(id);
        const props = bannerProps(page);
        expect(props.accountId, `${label} tells the banner nothing about whose breaches these are (U-2)`).toBe(id);
        const given = props.breaches as Array<{ id: number; symbol: string }>;
        // THE CROSSING: the set, re-scanned with the id the banner was handed.
        expect(
          ids(given),
          `${label} scoped the scan by one account and labelled the banner with another (U-2)`,
        ).toEqual(ids(job.scanBreaches({ accountId: props.accountId as number })));
      }
    }
    // A floor, so an empty result can never pass for the right reason: the two
    // books really do breach, and they breach differently.
    selectAccount(PERSONAL);
    expect((bannerProps(() => dashboardPage()).breaches as Array<{ symbol: string }>).map((b) => b.symbol)).toEqual(
      ["TCS"],
    );
    selectAccount(SWING);
    expect((bannerProps(() => riskPage()).breaches as Array<{ symbol: string }>).map((b) => b.symbol)).toEqual(
      ["INFY"],
    );
  });

  it("C5b  the EOD job's own scan is still unscoped — the two call sites cannot be the same read", () => {
    selectAccount(PERSONAL);
    // The banner sees one book…
    expect(ids(bannerProps(() => riskPage()).breaches as Array<{ id: number }>)).toEqual([PERSONAL_ID]);
    // …while the job that priced EVERY account from one bhavcopy still reports
    // on every account it marked, whatever is selected.
    expect(ids(job.scanBreaches())).toEqual([PERSONAL_ID, SWING_ID]);
    selectAccount(SWING);
    expect(ids(bannerProps(() => riskPage()).breaches as Array<{ id: number }>)).toEqual([SWING_ID]);
    expect(ids(job.scanBreaches()), "the EOD scan picked up the page's selection").toEqual([
      PERSONAL_ID,
      SWING_ID,
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C6 — THE REFUSAL THE CARD RE-ASKS AFTER IS REAL, AND IT CHANGES.
 *
 * U-1's whole justification is that the route's answer is not the answer the
 * card was given at mount. So the route is driven here, on a real database, and
 * what is asserted is that the answer MOVES: a provider POST refused for a
 * missing connection, a `feed.blockedReason` that names something else entirely,
 * and — once the sheet is accepted — a state where the block is gone and the
 * only remaining explanation is on the health line. A card that does not re-ask
 * shows the mount-time sentence through all three.
 *
 * The card's own half is source-shape, and that is stated rather than dressed
 * up: vitest runs `environment: "node"`, the repo ships no DOM harness, and
 * `store()` cannot be driven. C6b checks ORDER by index rather than by a
 * pattern over a line break — nothing here depends on the checkout's newlines.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("C6 — the route's refusal, and the reason that replaces it (U-1)", () => {
  const ACCEPT_FIRST = "accept it first";
  const NO_CONNECTION = "No Angel One connection is saved for this account";

  it("C6a  a pick with no connection is a 409 naming the connection, while the block names the acknowledgement", async () => {
    clearConnections();
    setSettings({
      liveFeedProvider: "eod",
      liveFeedAckJson: null,
      openalgoEnabled: false,
      openalgoAckVersion: null,
      selectedAccountId: PERSONAL,
    });
    registry.resetLiveFeedProviderCache();

    // (i) THE REFUSAL. Both halves are missing; the route answers with the one
    // the user must fix first, and it stores nothing.
    const refused = await feedPost({ action: "provider", provider: "angelone" });
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as { ok: boolean; message: string };
    expect(refusedBody.ok).toBe(false);
    expect(refusedBody.message).toContain(NO_CONNECTION);
    expect(
      refusedBody.message,
      "the route refused the pick for the acknowledgement while the connection is what is missing",
    ).not.toContain(ACCEPT_FIRST);
    const stored = (await (await feedGet()).json()) as { feed: { stored: string } };
    expect(stored.feed.stored, "a refused pick was stored anyway").toBe("eod");

    // (ii) THE BLOCK, with the pick already stored (a restored backup carries
    // the picker value; the acknowledgement is machine state and does not).
    setSettings({ liveFeedProvider: "angelone" });
    registry.resetLiveFeedProviderCache();
    const blocked = (await (await feedGet()).json()) as {
      feed: { stored: string; effective: string; blockedReason?: string };
      angelone: { connected: boolean; ackCurrent: boolean };
    };
    expect(blocked.feed.stored).toBe("angelone");
    expect(blocked.feed.effective, "an unacknowledged broker feed ran anyway").toBe("eod");
    expect(blocked.angelone.connected).toBe(false);
    expect(blocked.angelone.ackCurrent).toBe(false);
    // THE SENTENCE THE CARD WAS SHOWING AT MOUNT — the feed's own gate, taken
    // from the gate rather than restated. Note that it is a THIRD sentence:
    // neither the route's refusal above nor the health line below, and it can
    // only ever speak about the acknowledgement — `resolveLiveFeed()` has no
    // access to whether a connection is saved. So the block cannot name the
    // thing the route just refused for.
    expect(blocked.feed.blockedReason).toBe(registry.liveFeedAckGate(null, "angelone").reason);
    expect(
      blocked.feed.blockedReason,
      "the block named the missing connection — then the route's refusal is not new information",
    ).not.toContain(NO_CONNECTION);

    // (iii) THE SHEET ACCEPTED, on the real route — the gesture that precedes
    // the refused write. The block is now GONE and the only account of what is
    // wrong has moved to the health line, which is why the card must re-ask.
    expect((await feedPost({ action: "ack", provider: "angelone" })).status).toBe(200);
    registry.resetLiveFeedProviderCache();
    const after = (await (await feedGet()).json()) as {
      feed: { stored: string; effective: string; blockedReason?: string };
      health: { ok: boolean; state: string; reason: string };
    };
    expect(after.feed.effective).toBe("angelone");
    expect(
      after.feed.blockedReason,
      "the block still quotes the consent gate for an acknowledgement that is now current",
    ).toBeUndefined();
    expect(after.health.ok).toBe(false);
    expect(after.health.state).toBe("no-key");
    expect(after.health.reason).toContain(NO_CONNECTION);
    // The mount-time sentence and the current one are not the same sentence —
    // which is the whole of U-1, stated as a fact about the route.
    expect(after.health.reason).not.toContain(ACCEPT_FIRST);
  });

  it("C6b  the card's refusal branch reverts, says so, and THEN re-asks — two call sites, neither before a write", () => {
    const src = fs.readFileSync(path.join(REPO, "components/settings/live-feed-card.tsx"), "utf8");
    const start = src.indexOf("async function store(next: ProviderId)");
    expect(start, "store() is gone from the card").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));

    const at = body.indexOf("if (!r.ok) {");
    expect(at, "store() no longer has a refusal branch").toBeGreaterThan(-1);
    const refusal = body.slice(at, body.indexOf("\n    }", at));
    // ORDER BY INDEX, not by a pattern over line breaks: the Windows CI job
    // checks this file out with CRLF, and none of these positions care.
    const revert = refusal.indexOf("setProvider(previous);");
    const toast = refusal.indexOf("toast.error(");
    const reask = refusal.indexOf("await refreshStatus();");
    const ret = refusal.indexOf("return;");
    expect(revert, "the refused write does not put the radio back").toBeGreaterThan(-1);
    expect(
      reask,
      "the refused write never re-asks the route, so the block keeps the mount-time sentence (U-1)",
    ).toBeGreaterThan(-1);
    expect(toast, "the re-ask does not follow the revert and the toast").toBeGreaterThan(revert);
    expect(reask).toBeGreaterThan(toast);
    expect(ret, "the re-ask sits after the return — dead code").toBeGreaterThan(reask);

    // Exactly two re-asks in the whole card: one per outcome of its ONE write,
    // and neither of them before the POST they describe.
    expect(
      src.match(/await refreshStatus\(\);/g)?.length ?? 0,
      "the card re-asks the route somewhere other than the two outcomes of its one write",
    ).toBe(2);
    expect(
      body.indexOf("await refreshStatus();"),
      "a re-ask sits before the write it is supposed to describe (U-1)",
    ).toBeGreaterThan(body.indexOf('const r = await post({ action: "provider", provider: next });'));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C7 — ONE RECORD PER ACCOUNT, UNDER A KEY THE REST OF THE APP WOULD RECOGNISE.
 *
 * The dedup is exported as a pure function taking the store, so it can be
 * driven here: vitest runs `environment: "node"`, there is no DOM and no
 * `localStorage`. What crosses is the KEY — `lastNotifiedKey(accountId)` is the
 * name under which a record is written, and the repo's localStorage convention
 * (AGENTS.md; `components/layout/use-stored-value.ts` is the writer every other
 * surface goes through) is `vyuha-…` kebab-case with a parameterised suffix.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("C7 — the last-notified record is per account, under a vyuha- key (U-2)", () => {
  const fakeStore = () => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
  };
  const breach = (id: number, kind: Breach["kind"], level: number): Breach => ({
    id,
    symbol: `S${id}`,
    kind,
    side: "long",
    level,
    mtm: level + 10,
    throughPct: 1,
    message: "Review this against a live quote.",
  });

  it("C7a  a Swing announcement leaves Personal's record alone, under its own vyuha- key", () => {
    const store = fakeStore();
    const personal = [breach(PERSONAL_ID, "target", 2050)];
    const swing = [breach(SWING_ID, "target", 1550)];

    expect(
      markNotified(store, PERSONAL, personal),
      "a set this device has never announced was treated as already seen",
    ).not.toBeNull();
    // The OTHER account announces — the gesture that used to overwrite the one
    // record the banner kept.
    expect(markNotified(store, SWING, swing), "Swing's own first set was silent").not.toBeNull();
    expect(
      markNotified(store, PERSONAL, personal),
      "a Swing announcement wiped Personal's record, so switching back re-announced it (U-2)",
    ).toBeNull();
    // …and the All view is a third record, because the union is a third set.
    expect(markNotified(store, ALL, [...personal, ...swing])).not.toBeNull();

    // THE KEYS, as they land in the store. One per account, all distinct, all
    // `vyuha-` kebab-case with the id as the suffix.
    expect([...store.map.keys()].sort()).toEqual(
      [lastNotifiedKey(PERSONAL), lastNotifiedKey(SWING), lastNotifiedKey(ALL)].sort(),
    );
    for (const id of [ALL, PERSONAL, SWING]) {
      expect(lastNotifiedKey(id), "the key left the vyuha- kebab-case convention").toMatch(
        /^vyuha-(?:[a-z0-9]+-)*[a-z0-9]+[-:]\d+$/,
      );
      expect(lastNotifiedKey(id).endsWith(String(id)), "the key does not name the account").toBe(true);
    }
    expect(new Set([ALL, PERSONAL, SWING].map(lastNotifiedKey)).size).toBe(3);
    // …and none of them IS the single pre-U-2 key, which would make one account
    // inherit the record of "every account at once".
    expect(lastNotifiedKey(ALL)).not.toBe("vyuha-breach-last-notified");

    // A record, not a mute: a genuinely new breach in the same account speaks.
    expect(
      markNotified(store, PERSONAL, [...personal, breach(963, "sl", 1900)]),
      "a new breach in an account already notified stayed silent",
    ).not.toBeNull();
  });
});
