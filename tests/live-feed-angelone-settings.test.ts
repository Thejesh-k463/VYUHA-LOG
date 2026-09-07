import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import {
  ANGELONE_FEED_COPY,
  FEED_BLOCKED_HEALTH,
  FEED_CHECKING,
  PROVIDERS,
  REVIEW_CONSENT_CTA,
  angelOneCadenceText,
  angelOneRowState,
  feedBlockState,
  feedHealthText,
} from "@/components/settings/live-feed-card";
import {
  ANGELONE_BATCH_SIZE,
  ANGELONE_MAX_PRICED_POSITIONS,
  angelOneCadenceLine,
  angelOneRefreshCalls,
  deskAngelOneCadence,
} from "@/components/live/desk-copy";
import {
  ANGELONE_FEED_ITEMS,
  LIVE_FEED_DISCLOSURE_VERSIONS,
  UPSTOX_FEED_ITEMS,
  isFeedAckCurrent,
  parseFeedAcks,
} from "@/lib/domain/live-feed-disclosure";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";
import { ANGELONE_FEED_ENABLED, angelOneCadenceSeconds } from "@/lib/quotes/types";

/**
 * THE ANGEL ONE LIVE FEED IN SETTINGS (v4.2) — the row, the cadence line, the
 * sheet and the gate.
 *
 * The Upstox sibling (`tests/live-feed-upstox-settings.test.ts`) holds five
 * properties; every one of them applies here, and Angel One adds two more that
 * no other provider has:
 *
 *   6. THERE IS NO SLIDER UNDER THIS FEED (ruling 4.2-4). Angel One allows
 *      about one request a second and takes 50 symbols to a batch, so the
 *      interval is arithmetic over the user's own book, not a preference. A
 *      1–5 s control here would offer a setting the poll overrides — which is
 *      worse than no setting, because it reads as a promise. The control is
 *      replaced by ONE line stating the interval and the calls behind it.
 *   7. THE DAILY RE-AUTHENTICATION IS SAID, AND SAID FACTUALLY. Angel One
 *      really does clear every session at 5 AM IST, so the highlighted block
 *      stays — but the generic sentence ("has to be signed in again") is true
 *      of the SESSION and false of the READER: Vyuha signs in from the enrolled
 *      TOTP secret with nothing for the user to click. It therefore gets its own
 *      sentence, and that sentence NAMES NO REGULATOR — the same ruling that
 *      softened `LIVE_FEED_COPY.dailyReauth`, asserted here as a ban.
 *
 * ONE temp database for the FILE (lib/db caches its connection on globalThis),
 * and the route is imported DYNAMICALLY after `openTempDb()`.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CARD = "components/settings/live-feed-card.tsx";
const ROUTE = "app/api/live/feed/route.ts";
const DESK_COPY_FILE = "components/live/desk-copy.ts";

/** The same vocabulary the Upstox wave banned, and for the same reason. */
const BANNED =
  /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed|alert(s|ed|ing)?)\b/i;

/** Every string this wave puts on a user's screen from the files it owns. */
const NEW_STRINGS: [where: string, text: string][] = [
  ...Object.entries(ANGELONE_FEED_COPY).map(([k, v]) => [`ANGELONE_FEED_COPY.${k}`, v] as [string, string]),
  ["cadence line, 30 open", angelOneCadenceLine(30)],
  ["cadence line, 120 open", angelOneCadenceLine(120)],
  ["cadence line, 300 open", angelOneCadenceLine(300)],
  ["dialog title", "Before Angel One prices your desk"],
  [
    "route refusal (no connection)",
    "No Angel One connection is saved for this account. Add Angel One under Import → Connect broker first.",
  ],
  [
    "route refusal (no acknowledgement)",
    "Read what the Angel One feed does and accept it first — until then the desk stays on end-of-day prices.",
  ],
];

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

describe("the Angel One radio is offered only behind the one release flag", () => {
  const ids = PROVIDERS.map((p) => p.id);

  it("renders the row when the flag is on, and would drop it with no other edit", () => {
    expect(ANGELONE_FEED_ENABLED, "v4.2 ships the Angel One feed").toBe(true);
    expect(ids).toContain("angelone");
    expect(ids).toEqual(["manual", "eod", "openalgo", "upstox", "angelone"]);
  });

  it("the row is filtered by the FLAG, not by a hand-kept list", () => {
    // v4.2 seam fix: the filter took the three flags as an ARGUMENT so the
    // broker-feed gate could be proved for combinations this build does not
    // ship (tests/live-feed-copy.test.ts). The property pinned here is
    // unchanged and now needs both halves — the clause that reads the injected
    // flag, and the call that injects the REAL constant into it.
    const src = stripComments(read(CARD));
    expect(src, "the Angel One row no longer derives from a flag").toMatch(/\(p\.id !== "angelone" \|\| flags\.angelone\)/);
    expect(src, "the Angel One row no longer derives from ANGELONE_FEED_ENABLED").toMatch(
      /angelone: ANGELONE_FEED_ENABLED,/,
    );
  });

  it("says Angel One, in the owner's words", () => {
    expect(ANGELONE_FEED_COPY.label).toBe("Angel One");
    expect(ANGELONE_FEED_COPY.blurb).toBe(
      "Uses the client code, PIN and TOTP secret saved under Import → Connect broker. Angel One clears every session at 5 AM IST; Vyuha signs in again each morning without asking you.",
    );
    // Byte-identical to the Upstox scope sentence: one release-scope rule, one
    // sentence, so the two rows cannot drift into two different promises.
    expect(ANGELONE_FEED_COPY.equityOnly).toBe(
      "Prices equity positions only in this release; futures and options rows keep their last stored mark.",
    );
  });
});

describe("the row's state is DERIVED from what the route said about this account", () => {
  it("no connection saved → the radio is dead and says what to do about it", () => {
    const s = angelOneRowState({ connected: false, ackCurrent: false, openCount: 0 });
    expect(s.disabled).toBe(true);
    expect(s.line).toBe("Add Angel One under Import → Connect broker first.");
  });

  it("connection saved → the radio takes a click and the line describes the credential", () => {
    const s = angelOneRowState({ connected: true, ackCurrent: false, openCount: 12 });
    expect(s.disabled).toBe(false);
    expect(s.line).toBe(ANGELONE_FEED_COPY.blurb);
  });

  it("nothing known yet → enabled, because a request that never answered is not a refusal", () => {
    const s = angelOneRowState(undefined);
    expect(s.disabled).toBe(false);
    expect(s.line).toBe(ANGELONE_FEED_COPY.blurb);
  });

  it("both derived values reach the JSX — the helper is not decoration", () => {
    const src = stripComments(read(CARD));
    expect(src).toMatch(/angelOneRowState\(status\?\.angelone\)/);
    expect(src, "the radio ignores the derived disabled state").toMatch(
      /disabled=\{pending \|\| \(row\?\.disabled \?\? false\)\}/,
    );
    expect(src, "the derived line is not what the row renders").toMatch(/\{row \? row\.line : p\.blurb\}/);
  });

  it("the scope sentence is rendered ALWAYS, exactly once, connected or not", () => {
    const src = stripComments(read(CARD));
    expect(src.split("ANGELONE_FEED_COPY.equityOnly").length - 1, "a second copy of the scope sentence").toBe(1);
    expect(src).toMatch(/\{p\.id === "angelone" && \(\s*<span[\s\S]*?ANGELONE_FEED_COPY\.equityOnly/);
  });
});

// ---------------------------------------------------------------------------
// The tiered cadence line (ruling 4.2-4)
// ---------------------------------------------------------------------------

describe("the cadence line states the tier and the arithmetic behind it", () => {
  /** The three worked cases, one per tier, with the calls each implies. */
  it.each([
    [30, 3, 1],
    [120, 5, 3],
    [300, 10, 6],
  ])("%i open positions → every %i s, %i calls per refresh", (count, seconds, calls) => {
    expect(angelOneCadenceSeconds(count), "the tier itself").toBe(seconds);
    expect(angelOneRefreshCalls(count), "50 symbols to a batch").toBe(calls);
    expect(angelOneCadenceLine(count)).toBe(
      `Refreshes every ${seconds} seconds — Angel One allows about one request a second, ` +
        `and your ${count} open positions take ${calls} ${calls === 1 ? "call" : "calls"} per refresh.`,
    );
  });

  it("names the tier boundaries exactly where the contract puts them", () => {
    // The edges, not the middles: an off-by-one in a tier table is invisible at
    // 30 / 120 / 300 and changes the sentence at 50 / 51 / 200 / 201.
    expect(angelOneCadenceSeconds(50)).toBe(3);
    expect(angelOneCadenceSeconds(51)).toBe(5);
    expect(angelOneCadenceSeconds(200)).toBe(5);
    expect(angelOneCadenceSeconds(201)).toBe(10);
    expect(angelOneCadenceSeconds(500)).toBe(10);
  });

  it("caps the book at 500 — the same ceiling the poll itself applies", () => {
    expect(ANGELONE_MAX_PRICED_POSITIONS).toBe(500);
    expect(ANGELONE_BATCH_SIZE).toBe(50);
    // A larger book does not produce a bigger number on screen than the poll
    // will ever carry: 900 positions are 500 keys and 10 calls, not 18.
    expect(angelOneCadenceLine(900)).toBe(angelOneCadenceLine(500));
    expect(angelOneRefreshCalls(900)).toBe(10);
  });

  it("never says 'take 1 calls' — the sentence is grammatical at every count", () => {
    expect(angelOneCadenceLine(1)).toContain("your 1 open position takes 1 call per refresh");
    expect(angelOneCadenceLine(2)).toContain("your 2 open positions take 1 call per refresh");
    expect(angelOneCadenceLine(51)).toContain("your 51 open positions take 2 calls per refresh");
  });

  /**
   * ONE SENTENCE, TWO SURFACES — asserted as BEHAVIOUR (A-5 / A-7).
   *
   * This used to pin the two call sites as SOURCE TEXT
   * (`angelOneCadenceLine(status?.angelone?.openCount ?? 0)` and
   * `angelOneCadenceLine(rows.length)`), and both defects this wave fixes were
   * live underneath those green pins: the desk counted ROWS where the poll
   * counts deduped KEYS, and the card defaulted an unknown count to 0. A pin on
   * the expression that is wrong can only ever report that it is still there.
   */
  it("is ONE sentence, shared by both surfaces rather than restated", () => {
    // Still the G2 rule: the sentence is DEFINED once, and both surfaces import
    // it rather than writing their own.
    const defs = stripComments(read(DESK_COPY_FILE)).match(/Refreshes every \$\{seconds\} seconds/g) ?? [];
    expect(defs.length, "the cadence sentence is written in more than one place").toBe(1);
    expect(stripComments(read(CARD)), "the card restates the sentence instead of importing it").not.toMatch(
      /Refreshes every/,
    );
    expect(
      stripComments(read("components/live/tracker-client.tsx")),
      "the desk restates the sentence instead of importing it",
    ).not.toMatch(/Refreshes every/);
  });

  it("BOTH surfaces say the same thing for the same book — 50 keys is 3 seconds and 1 call", () => {
    // The Settings card counts `openPositionKeys().length` (deduped) and the
    // desk now counts the stream's own `symbols` (that same deduped set), so
    // one book produces one sentence. It did not: the desk counted the 51 ROWS
    // behind those 50 keys and printed 5 seconds and 2 calls beside a card
    // saying 3 seconds and 1 call.
    const card = angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 50 });
    const desk = deskAngelOneCadence({ providerId: "angelone", linkSymbolCount: 50, feedSymbolCount: null });
    expect(card).toBe(desk);
    expect(card).toContain("Refreshes every 3 seconds");
    expect(card).toContain("your 50 open positions take 1 call per refresh");
  });
});

/**
 * A-7 — THE CARD STATED A BOOK NOBODY HAD TOLD IT ABOUT.
 *
 * The cadence block rendered `angelOneCadenceLine(status?.angelone?.openCount ??
 * 0)`, so between mount and the fetch answering — and FOR EVER if that fetch
 * failed, because the catch swallows — the card told a user with a full book
 * "your 0 open positions take 1 call per refresh". A 0 where the number is
 * simply unknown is a claim about the user's positions (invariant 6), and this
 * same card already had the honest treatment for exactly this case: the health
 * line says "Checking the feed…" until the server answers.
 */
describe("the cadence line says nothing about a book it has not been told about (A-7)", () => {
  const src = stripComments(read(CARD));

  it("before the fetch answers, it says it is checking — it does not claim 0 positions", () => {
    expect(angelOneCadenceText(undefined)).toBe(FEED_CHECKING);
    expect(angelOneCadenceText(undefined), "a book the card has not been told about").not.toMatch(/0 open/);
    // The sentence that used to print, so this test can tell the two apart.
    expect(angelOneCadenceLine(0)).toContain("your 0 open positions take 1 call per refresh");
  });

  it("once the server has answered, it states that account's own count", () => {
    expect(angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 0 })).toBe(angelOneCadenceLine(0));
    expect(angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 51 })).toContain(
      "Refreshes every 5 seconds",
    );
  });

  it("the JSX renders the derived text, and no defaulted count survives in the card", () => {
    expect(src).toContain("angelOneCadenceText(status?.angelone)");
    expect(src, "the card still defaults an unknown count to 0").not.toContain("openCount ?? 0");
  });

  it("it is the SAME treatment the health line uses — one sentence, not two", () => {
    expect(feedHealthText({ health: null, blocked: false })).toBe(FEED_CHECKING);
    expect(src.split('"' + FEED_CHECKING + '"').length - 1, "the checking sentence is written twice").toBe(1);
  });
});

describe("the 1–5 s slider is HIDDEN under the Angel One pick, and only under it", () => {
  const src = stripComments(read(CARD));

  it("the swap is a ternary on the provider, inside the one release gate", () => {
    // The gate itself is untouched — `tests/live-feed-copy.test.ts` requires
    // the slider to sit inside exactly one `{BROKER_FEED_OFFERED && (…)}`
    // subtree, and a second gate would satisfy neither test.
    expect(src).toContain("{BROKER_FEED_OFFERED && (");
    expect(src).toMatch(/\{BROKER_FEED_OFFERED && \(\s*provider === "angelone" \? \(/);
    expect(src.split('data-testid="live-feed-seconds"').length - 1, "a second copy of the slider").toBe(1);
  });

  it("the cadence line takes the slider's place, in the same block", () => {
    const block = src.slice(src.indexOf("{BROKER_FEED_OFFERED && ("));
    const cadenceAt = block.indexOf('data-testid="live-feed-angelone-cadence"');
    const sliderAt = block.indexOf('data-testid="live-feed-seconds"');
    expect(cadenceAt, "the cadence line is not rendered at all").toBeGreaterThan(-1);
    expect(sliderAt, "the slider is gone entirely — the other providers still need it").toBeGreaterThan(-1);
    expect(cadenceAt, "the cadence line is not the Angel One branch of the swap").toBeLessThan(sliderAt);
  });
});

describe("the daily re-authentication block is SHOWN for Angel One, with the factual sentence", () => {
  it("says what Angel One's system does, and what Vyuha does about it", () => {
    expect(ANGELONE_FEED_COPY.dailyReauth).toBe(
      "Angel One ends every API session at 5 AM IST. Vyuha opens the next one by itself from the client code, PIN and TOTP secret you saved — there is nothing for you to do each morning.",
    );
    expect(ANGELONE_FEED_COPY.dailyReauth).toMatch(/5 AM IST/);
    // UNATTENDED is the whole point: the generic sentence says the session
    // "has to be signed in again", which is true of the session and false of
    // the reader. Neither Angel One string may put the work back on them.
    for (const [where, text] of Object.entries(ANGELONE_FEED_COPY)) {
      expect(/you (?:have to|must|need to) (?:sign|log) in/i.test(text), `${where}: ${text}`).toBe(false);
    }
  });

  it("NAMES NO REGULATOR — no circular saying so is cited anywhere in this tree", () => {
    // The same ban `tests/live-feed-copy.test.ts` puts on LIVE_FEED_COPY.
    // An unverified claim about what a regulator requires is exactly the kind
    // of sentence that ships as fact and cannot be defended.
    for (const [where, text] of Object.entries(ANGELONE_FEED_COPY)) {
      expect(text, `${where} names a regulator`).not.toMatch(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i);
    }
    // …and the scan can fire on the shape the sentence could have taken.
    expect(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i.test("SEBI requires a daily sign-in")).toBe(true);
  });

  it("is the block the OTHER providers already use — one block, one testid", () => {
    const src = stripComments(read(CARD));
    expect(src.split('data-testid="live-feed-reauth"').length - 1, "a second re-auth block").toBe(1);
    expect(src).toMatch(
      /provider === "angelone" \? ANGELONE_FEED_COPY\.dailyReauth : LIVE_FEED_COPY\.dailyReauth/,
    );
    // Upstox is still the one provider the block is suppressed for.
    expect(src).toContain('provider === "upstox" ? null :');
  });
});

// ---------------------------------------------------------------------------
// The consent sheet
// ---------------------------------------------------------------------------

describe("the consent sheet shows ANGEL ONE's items, and never another provider's", () => {
  it("the card hands it Angel One's items and Angel One's version", () => {
    const src = stripComments(read(CARD));
    expect(src).toContain("items={ANGELONE_FEED_ITEMS}");
    expect(src).toContain("version={LIVE_FEED_DISCLOSURE_VERSIONS.angelone}");
    expect(src).toContain('testId="angelone-feed-dialog"');
    expect(src, "OpenAlgo's items are reachable from the card").not.toContain("OPENALGO_FEED_ITEMS");
  });

  it("the two sheets cannot both be open, because the state is WHICH and not WHETHER", () => {
    const src = stripComments(read(CARD));
    expect(src).toContain('open={consentOpen === "angelone"}');
    expect(src).toContain('open={consentOpen === "upstox"}');
    expect(src, "a boolean would open both sheets at once").toMatch(
      /React\.useState<null \| "upstox" \| "angelone">\(null\)/,
    );
  });

  it("names no OTHER provider, and carries none of another sheet's body verbatim", () => {
    // NOT a title-disjointness check: two of the seven headings are shared on
    // purpose ("Equity positions only in this release", "The prices stay on
    // this machine") because they state ONE release-scope rule and ONE storage
    // rule, and re-phrasing them per provider is how two promises drift apart.
    // What must be disjoint is the CLAIM: no Angel One item may name another
    // broker, and every risk peculiar to this provider must be here and here
    // only.
    expect(ANGELONE_FEED_ITEMS.length).toBeGreaterThan(0);
    const angelText = ANGELONE_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ");
    expect(angelText, "the Angel One sheet names Upstox").not.toMatch(/upstox/i);
    expect(angelText, "the Angel One sheet names OpenAlgo").not.toMatch(/openalgo/i);
    expect(angelText, "the Angel One sheet does not name Angel One").toMatch(/angel one/i);

    // THE FOUR CLAIMS THAT ARE ANGEL ONE'S ALONE, each named by the thing it
    // asserts. Two headings on this sheet restate a rule the Upstox sheet also
    // states (equities only; the prices stay here) and that is deliberate —
    // one release-scope rule, one storage rule, re-phrased per provider is how
    // two promises drift. What must be UNIQUE is the risk each provider
    // carries, and a sheet handed to the wrong dialog loses exactly these.
    const angelBodies = ANGELONE_FEED_ITEMS.map((i) => i.body).join(" ");
    const otherText = [...UPSTOX_FEED_ITEMS, ...OPENALGO_FEED_ITEMS]
      .map((i) => `${i.title} ${i.body}`)
      .join(" ");
    for (const [what, pattern] of [
      ["the once-a-day sign-in", /signs in to apiconnect\.angelone\.in once each trading day/i],
      ["the 5 AM flush, unattended", /clears every session at 5 AM IST, so this happens each morning without asking you/i],
      ["the batching and the tiers", /in batches of 50, no more than once a second/i],
      ["the token look-up kept locally", /keeps that mapping on this machine/i],
    ] as [string, RegExp][]) {
      expect(angelBodies, `the Angel One sheet no longer states ${what}`).toMatch(pattern);
      expect(otherText, `${what} is not unique to the Angel One sheet`).not.toMatch(pattern);
    }
  });

  it("the accept hook the sheet renders is Angel One's own", () => {
    // `FeedConsentDialog` derives its testids from `testId`, so this is the
    // pair an e2e or a support screenshot can name.
    const src = read("components/system/feed-consent-dialog.tsx");
    expect(src).toContain('data-testid={`${testId}-items`}');
    expect(src).toContain('data-testid={`${testId}-accept`}');
  });
});

describe("nothing this wave adds to the screen prompts a transaction", () => {
  it.each(NEW_STRINGS)("%s carries no banned vocabulary", (_where, text) => {
    expect(BANNED.test(text), text).toBe(false);
    expect(PRESCRIPTIVE_LANGUAGE.test(text), text).toBe(false);
  });

  it("the scan really can fire on the shapes this copy could have taken", () => {
    expect(BANNED.test("You should connect Angel One for live alerts")).toBe(true);
    expect(BANNED.test("We recommend the Angel One feed")).toBe(true);
    expect(BANNED.test("Consider a shorter refresh for Angel One")).toBe(true);
    expect(PRESCRIPTIVE_LANGUAGE.test("You must add Angel One first")).toBe(true);
  });

  it("the word alert appears nowhere in the card, the route or the desk's copy", () => {
    for (const rel of [CARD, ROUTE, DESK_COPY_FILE]) {
      expect(stripComments(read(rel)), `${rel} mentions alerts`).not.toMatch(/\balert/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

let t: TempDb;
let route: typeof import("@/app/api/live/feed/route");

const SWING = 2;
const OTHER = 3;

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

function settingsRow() {
  return t.db.select().from(t.schema.settings).limit(1).all()[0];
}

/** The seed the whole file's egress claims rest on: this must never appear. */
const SECRET = "ANGELONE-TOTP-SECRET-BASE32-DO-NOT-LEAK";

function connect(accountId: number) {
  t.db
    .insert(t.schema.brokerConnections)
    .values({
      accountId,
      broker: "angelone",
      apiKey: "smartapi-key",
      accessToken: "angelone-jwt-do-not-leak",
      authJson: JSON.stringify({ totp: SECRET }),
    })
    .run();
}

beforeAll(async () => {
  t = await openTempDb("live-feed-angelone-settings", { seed: true });
  route = await import("@/app/api/live/feed/route");
  await import("@/lib/queries/trades");

  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing" }, { id: OTHER, name: "Long term" }]).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: SWING }).run();
});

afterAll(() => {
  t?.cleanup();
});

describe("GET — the facts the card renders the Angel One radio from", () => {
  it("says neither half holds on a fresh install, and reports the open count", async () => {
    const body = await (await get()).json();
    expect(body.ok).toBe(true);
    expect(body.angelone).toEqual({ connected: false, ackCurrent: false, disclosureVersion: "1", openCount: 0 });
    expect(body.angelone.disclosureVersion).toBe(LIVE_FEED_DISCLOSURE_VERSIONS.angelone);
  });

  it("offers angelone in the pickable set the card reads", async () => {
    const body = await (await get()).json();
    expect(body.providers.map((p: { id: string }) => p.id)).toContain("angelone");
  });

  it("counts the OPEN positions of the SELECTED account, and nobody else's (invariant 8)", async () => {
    // Three rows: two open on the selected account, one open on the other, one
    // closed on the selected. The count the cadence line is computed from must
    // be 2 — an account leak here would silently change the interval on screen.
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({ accountId: SWING, symbol: "TCS", tradingsymbol: "TCS", isOpen: true, buyQty: 10, avgBuyPrice: 3000 }),
        tradeRow({ accountId: SWING, symbol: "INFY", tradingsymbol: "INFY", isOpen: true, buyQty: 10, avgBuyPrice: 1500 }),
        tradeRow({ accountId: SWING, symbol: "WIPRO", tradingsymbol: "WIPRO", isOpen: false, buyQty: 10, avgBuyPrice: 400 }),
        tradeRow({ accountId: OTHER, symbol: "HDFCBANK", tradingsymbol: "HDFCBANK", isOpen: true, buyQty: 10, avgBuyPrice: 1600 }),
      ])
      .run();
    const body = await (await get()).json();
    expect(body.angelone.openCount, "another account's open positions were counted").toBe(2);
  });
});

describe("POST provider angelone — 409 until BOTH halves hold, storing nothing", () => {
  it("refuses when no connection is saved, and names the next step", async () => {
    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("Add Angel One under Import → Connect broker first.");
    expect(settingsRow()?.liveFeedProvider, "a refused pick was stored anyway").toBe("eod");
  });

  it("a connection on ANOTHER account is not this account's connection (invariant 8)", async () => {
    connect(OTHER);
    const body = await (await get()).json();
    expect(body.angelone.connected, "another account's credential counted as this one's").toBe(false);
    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(409);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });

  it("refuses with the disclosure reason once the connection exists but nothing was accepted", async () => {
    connect(SWING);
    const body = await (await get()).json();
    expect(body.angelone).toMatchObject({ connected: true, ackCurrent: false });
    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("Read what the Angel One feed does");
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });
});

describe("POST ack — the acknowledgement round-trips, per provider", () => {
  it("stores the version this build ships, under Angel One's own id", async () => {
    const res = await post({ action: "ack", provider: "angelone" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.angelone).toMatchObject({ connected: true, ackCurrent: true });

    const stored = settingsRow()?.liveFeedAckJson;
    expect(parseFeedAcks(stored)).toEqual({ angelone: LIVE_FEED_DISCLOSURE_VERSIONS.angelone });
    expect(isFeedAckCurrent(stored, "angelone")).toBe(true);
    // Accepting Angel One is NOT accepting Upstox — one column, two keys.
    expect(isFeedAckCurrent(stored, "upstox")).toBe(false);
  });

  it("…and the pick is accepted once both halves hold", async () => {
    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(200);
    expect(settingsRow()?.liveFeedProvider).toBe("angelone");
  });

  it("accepting the OTHER sheet does not withdraw this one", async () => {
    await post({ action: "ack", provider: "upstox" });
    const stored = settingsRow()?.liveFeedAckJson;
    expect(parseFeedAcks(stored)).toEqual({ angelone: "1", upstox: "1" });
  });

  it("a version bump re-asks: a stored older version is refused, and the pick with it", async () => {
    t.db.update(t.schema.settings).set({ liveFeedAckJson: '{"angelone":"0"}', liveFeedProvider: "eod" }).run();
    const body = await (await get()).json();
    expect(body.angelone.ackCurrent, "an older acknowledgement was accepted as current").toBe(false);

    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(409);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");

    await post({ action: "ack", provider: "angelone" });
    expect(parseFeedAcks(settingsRow()?.liveFeedAckJson)).toEqual({ angelone: "1" });
  });
});

describe("the route reads the row's existence and never the credential", () => {
  it("no credential of any kind is in the answer — least of all the TOTP seed", async () => {
    const text = await (await get()).text();
    expect(text).toContain('"connected":true');
    expect(text, "the TOTP secret reached the client").not.toContain(SECRET);
    expect(text).not.toContain("smartapi-key");
    expect(text, "the session token reached the client").not.toContain("angelone-jwt-do-not-leak");
  });

  it("the select list is the id alone — proved in the source, since a wider select would still pass above", () => {
    const src = stripComments(read(ROUTE));
    const fn = src.slice(src.indexOf("function angelOneConnected()"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/\.select\(\{ id: brokerConnections\.id \}\)/);
    expect(src, "the route reads a credential column").not.toMatch(/brokerConnections\.(apiKey|accessToken|authJson)/);
  });
});

/**
 * A-6 — A BLOCKED FEED WAS INVISIBLE FOR EVERY PROVIDER BUT OpenAlgo.
 *
 * `resolveLiveFeed()` falls back to `eod` and publishes `blockedReason`
 * whenever the STORED provider's acknowledgement is not current — a disclosure
 * version bump, or a backup restored on another machine (`liveFeedProvider`
 * travels in the envelope; `liveFeedAckJson` is machine state and does not).
 * The card rendered that reason only inside `provider === "openalgo" && …`, so
 * with Angel One stored and blocked: the radio showed CHECKED (the card's state
 * is initialised from the stored value), the health line said "Feed OK" (it
 * describes the EFFECTIVE provider, which is end-of-day and genuinely healthy),
 * nothing said blocked — and because a checked radio fires no `onChange`, the
 * one path to the consent sheet was unreachable without switching away first.
 *
 * Driven through the REAL route, so the fixture cannot drift from what the
 * server sends.
 */
describe("a blocked Angel One feed is stated, and the sheet is reachable again (A-6)", () => {
  const src = stripComments(read(CARD));

  it("the restore case: the pick travels, the acknowledgement does not", async () => {
    t.db.update(t.schema.settings).set({ liveFeedProvider: "angelone", liveFeedAckJson: null }).run();
    const body = await (await get()).json();
    expect(body.feed.stored, "the pick is what the user chose").toBe("angelone");
    expect(body.feed.effective, "…and it is not what runs").toBe("eod");
    expect(body.feed.blockedReason).toBeTruthy();

    const block = feedBlockState(body.feed);
    expect(block, "the card renders nothing at all for a blocked Angel One feed").not.toBeNull();
    expect(block?.reason).toBe(body.feed.blockedReason);
    expect(block?.reviewProvider, "there is no way back to the consent sheet").toBe("angelone");
  });

  it("the health line stops reporting the FALLBACK feed as fine", async () => {
    const body = await (await get()).json();
    const blocked = feedBlockState(body.feed) !== null;
    // The trap: `health` describes the EFFECTIVE provider, so the card said
    // whatever end-of-day had to say about itself over a feed the user picked
    // and is not getting. Whatever that is, the blocked fact comes first.
    expect(body.health.provider, "the health line describes the fallback").toBe("eod");
    expect(feedHealthText({ health: body.health, blocked })).toBe(FEED_BLOCKED_HEALTH);
    // The exact shape that used to print "Feed OK" over a blocked feed.
    expect(feedHealthText({ health: { ok: true, latencyMs: null, reason: "" }, blocked: true })).toBe(
      FEED_BLOCKED_HEALTH,
    );
    expect(feedHealthText({ health: body.health, blocked }), "a blocked feed still reads OK").not.toContain("Feed OK");
    // …and with nothing blocked it is unchanged from v4.1.
    expect(feedHealthText({ health: { ok: true, latencyMs: 12, reason: "" }, blocked: false })).toBe("Feed OK · 12 ms");
  });

  it("accepting the sheet clears the block — the same GET, one write later", async () => {
    await post({ action: "ack", provider: "angelone" });
    const body = await (await get()).json();
    expect(body.feed.stored).toBe("angelone");
    expect(body.feed.effective).toBe("angelone");
    expect(body.feed.blockedReason).toBeUndefined();
    expect(feedBlockState(body.feed)).toBeNull();
  });

  it("the block and its control reach the JSX, for the STORED provider", () => {
    expect(src).toContain("const blocked = feedBlockState(status?.feed);");
    expect(src).toContain('data-testid="live-feed-blocked"');
    expect(src).toContain('data-testid="live-feed-review-consent"');
    // The control opens the sheet for the provider that is BLOCKED, which is
    // the STORED one — `pick()` cannot be reached from a radio already checked.
    expect(src).toMatch(/onClick=\{\(\) => setConsentOpen\(review\)\}/);
    expect(src).toContain("{REVIEW_CONSENT_CTA}");
    expect(REVIEW_CONSENT_CTA).toBe("Review and accept");
    expect(PRESCRIPTIVE_LANGUAGE.test(REVIEW_CONSENT_CTA), REVIEW_CONSENT_CTA).toBe(false);
  });
});
