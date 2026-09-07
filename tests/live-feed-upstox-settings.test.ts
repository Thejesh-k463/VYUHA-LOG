import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  PROVIDERS,
  UPSTOX_FEED_COPY,
  upstoxRowState,
} from "@/components/settings/live-feed-card";
import {
  LIVE_FEED_DISCLOSURE_VERSIONS,
  UPSTOX_FEED_ITEMS,
  isFeedAckCurrent,
  parseFeedAcks,
} from "@/lib/domain/live-feed-disclosure";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";
import { UPSTOX_FEED_ENABLED } from "@/lib/quotes/types";

/**
 * THE UPSTOX LIVE FEED IN SETTINGS (v4.2) — the row, the sheet and the gate.
 *
 * What this file holds to account, none of which a screenshot proves:
 *
 *   1. THE ROW EXISTS ONLY BEHIND THE ONE FLAG, and its disabled state is
 *      DERIVED from what the route said about this account, never held in
 *      state and re-synced in an effect (AGENTS.md).
 *   2. THE GATE IS SERVER-SIDE AND HAS TWO HALVES. A disabled radio is not a
 *      control: `/api/live/feed` answers 409 and stores nothing until a
 *      connection exists FOR THE SELECTED ACCOUNT (invariant 8) and the
 *      acknowledgement matches the version this build ships — `===`, so a
 *      bump re-asks every install.
 *   3. THE SHEET CANNOT SHOW THE WRONG PROVIDER'S SENTENCES, because the
 *      generic dialog names no provider at all and imports no disclosure
 *      module; the caller passes the items.
 *   4. THE ROUTE NEVER RETURNS A TOKEN. `connected` is the existence of a
 *      broker_connections row and nothing else.
 *   5. NO SENTENCE ADDED HERE PROMPTS A TRANSACTION, and none of them repeats
 *      the daily re-authentication claim — it is false for Upstox, whose
 *      Analytics token is read-only for about a year.
 *
 * ONE temp database for the FILE (lib/db caches its connection on globalThis),
 * and the route is imported DYNAMICALLY after `openTempDb()` — it imports
 * `@/lib/db` statically, so a top-level import here would bind the connection
 * before the helper sets `VYUHA_DB_PATH`.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CARD = "components/settings/live-feed-card.tsx";
const ROUTE = "app/api/live/feed/route.ts";
const DIALOG = "components/system/feed-consent-dialog.tsx";

/**
 * The same vocabulary `tests/live-feed-copy.test.ts` bans on this card, plus
 * the words this wave adds: a feed is not an alert service, and nothing on a
 * settings screen may name a side.
 */
const BANNED =
  /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed|alert(s|ed|ing)?)\b/i;

/** Every string this wave puts on a user's screen from the files it owns. */
const NEW_STRINGS: [where: string, text: string][] = [
  ...Object.entries(UPSTOX_FEED_COPY).map(([k, v]) => [`UPSTOX_FEED_COPY.${k}`, v] as [string, string]),
  ["dialog title", "Before Upstox prices your desk"],
  ["dialog description", "Read this in full. Disclosure v — if it materially changes, Vyuha asks again."],
  ["dialog accept", "I understand — use this feed"],
  ["dialog cancel", "Not now"],
  [
    "route refusal (no connection)",
    "No Upstox connection is saved for this account. Add Upstox under Import → Brokers first.",
  ],
  [
    "route refusal (no acknowledgement)",
    "Read what the Upstox feed does and accept it first — until then the desk stays on end-of-day prices.",
  ],
];

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

describe("the Upstox radio is offered only behind the one release flag", () => {
  const ids = PROVIDERS.map((p) => p.id);

  it("renders the row when the flag is on, and would drop it with no other edit", () => {
    expect(UPSTOX_FEED_ENABLED, "v4.2 ships the Upstox feed").toBe(true);
    expect(ids).toContain("upstox");
    // The picker offers exactly what this release ships. Angel One joined it
    // later in the same wave behind its OWN flag (ANGELONE_FEED_ENABLED); the
    // list is restated rather than loosened, because a sixth id appearing here
    // is exactly the regression this pin exists to catch.
    expect(ids).toEqual(["manual", "eod", "openalgo", "upstox", "angelone"]);
  });

  it("the row is filtered by the FLAG, not by a hand-kept list", () => {
    // v4.2 seam fix: the filter now takes the three flags as an ARGUMENT (see
    // the note in the Angel One twin of this test). Same property, both halves.
    const src = stripComments(read(CARD));
    expect(src, "the Upstox row no longer derives from a flag").toMatch(/\(p\.id !== "upstox" \|\| flags\.upstox\)/);
    expect(src, "the Upstox row no longer derives from UPSTOX_FEED_ENABLED").toMatch(/upstox: UPSTOX_FEED_ENABLED,/);
  });

  it("says Upstox, in the owner's words", () => {
    expect(UPSTOX_FEED_COPY.label).toBe("Upstox");
    expect(UPSTOX_FEED_COPY.blurb).toBe(
      "Uses the Analytics token saved under Import → Brokers for this account. Upstox keeps that token read-only for about a year, so there is no daily login.",
    );
    expect(UPSTOX_FEED_COPY.equityOnly).toBe(
      "Prices equity positions only in this release; futures and options rows keep their last stored mark.",
    );
  });
});

describe("the row's state is DERIVED from what the route said about this account", () => {
  it("no connection saved → the radio is dead and says what to do about it", () => {
    const s = upstoxRowState({ connected: false, ackCurrent: false });
    expect(s.disabled).toBe(true);
    expect(s.line).toBe("Add Upstox under Import → Brokers first.");
  });

  it("connection saved → the radio takes a click and the line describes the token", () => {
    const s = upstoxRowState({ connected: true, ackCurrent: false });
    expect(s.disabled).toBe(false);
    expect(s.line).toBe(UPSTOX_FEED_COPY.blurb);
  });

  it("nothing known yet → enabled, because a request that never answered is not a refusal", () => {
    const s = upstoxRowState(undefined);
    expect(s.disabled).toBe(false);
    expect(s.line).toBe(UPSTOX_FEED_COPY.blurb);
  });

  it("both derived values reach the JSX — the helper is not decoration", () => {
    const src = stripComments(read(CARD));
    expect(src).toMatch(/upstoxRowState\(status\?\.upstox\)/);
    // The row-state pair is now shared: TWO providers have a server-answered
    // state, so the JSX reads `row` (`upstox ?? angelone`) rather than one of
    // them by name. What is pinned is unchanged — the DERIVED value is what
    // the control and the line render.
    expect(src).toMatch(/const row = upstox \?\? angelone;/);
    expect(src, "the radio ignores the derived disabled state").toMatch(
      /disabled=\{pending \|\| \(row\?\.disabled \?\? false\)\}/,
    );
    expect(src, "the derived line is not what the row renders").toMatch(/\{row \? row\.line : p\.blurb\}/);
  });

  it("the scope sentence is rendered ALWAYS, exactly once, connected or not", () => {
    const src = stripComments(read(CARD));
    expect(src.split("UPSTOX_FEED_COPY.equityOnly").length - 1, "a second copy of the scope sentence").toBe(1);
    // Inside the row, guarded only by which row this is — never by the
    // connection state, which is what "always" means here.
    expect(src).toMatch(/\{p\.id === "upstox" && \(\s*<span[\s\S]*?UPSTOX_FEED_COPY\.equityOnly/);
  });
});

describe("the daily re-authentication sentence is not repeated for Upstox, and not shown against it", () => {
  it("no Upstox string claims a daily session", () => {
    for (const [where, text] of Object.entries(UPSTOX_FEED_COPY)) {
      expect(/expires every day|daily re-?auth|signed in again/i.test(text), `${where}: ${text}`).toBe(false);
    }
    // It says the opposite, once, and that is the whole statement.
    expect(UPSTOX_FEED_COPY.blurb).toContain("there is no daily login");
  });

  it("the warning block is suppressed while Upstox is the pick", () => {
    const src = stripComments(read(CARD));
    const gate = src.slice(src.indexOf("{BROKER_FEED_OFFERED && ("));
    const reauth = gate.slice(0, gate.indexOf('data-testid="live-feed-reauth"'));
    expect(reauth, "the re-auth block still renders under an Upstox pick").toContain('provider === "upstox" ? null :');
  });
});

describe("the consent sheet is provider-agnostic, and Upstox gets Upstox's sentences", () => {
  it("the generic dialog names no provider and imports no disclosure module", () => {
    // COMMENT-STRIPPED for the name scan: the header explains why this file is
    // the sibling of the OpenAlgo sheet rather than its replacement, and a ban
    // that swallowed its own explanation would delete the record. Nothing a
    // user can see may name a provider — that is the property being pinned.
    const copy = stripComments(read(DIALOG));
    expect(copy).not.toMatch(/openalgo/i);
    expect(copy).not.toMatch(/upstox/i);
    expect(read(DIALOG), "the generic dialog imports a provider's own copy").not.toMatch(
      /from "@\/lib\/domain\/[a-z-]*disclosure"/,
    );
  });

  it("the card hands it UPSTOX's items, and never OpenAlgo's", () => {
    const src = stripComments(read(CARD));
    expect(src).toContain("items={UPSTOX_FEED_ITEMS}");
    // …and the Angel One sheet is a SEPARATE dialog with its own items, so
    // neither can be handed the other's (its own file asserts the pair).
    expect(src).toContain("items={ANGELONE_FEED_ITEMS}");
    expect(src).toContain("version={LIVE_FEED_DISCLOSURE_VERSIONS.upstox}");
    expect(src, "OpenAlgo's items are reachable from the card").not.toContain("OPENALGO_FEED_ITEMS");
  });

  it("the two item sets share no sentence, so a mix-up would be visible", () => {
    const upstox = UPSTOX_FEED_ITEMS.map((i) => i.title);
    const openalgo = OPENALGO_FEED_ITEMS.map((i) => i.title);
    expect(UPSTOX_FEED_ITEMS.length).toBeGreaterThan(0);
    expect(upstox.filter((t) => openalgo.includes(t))).toEqual([]);
  });

  it("the OpenAlgo sheet is untouched — its own testid and its own items still ship", () => {
    const src = read("components/system/openalgo-dialog.tsx");
    expect(src).toContain('data-testid="openalgo-dialog"');
    expect(src).toContain("OPENALGO_FEED_ITEMS");
  });
});

describe("nothing this wave adds to the screen prompts a transaction", () => {
  it.each(NEW_STRINGS)("%s carries no banned vocabulary", (_where, text) => {
    expect(BANNED.test(text), text).toBe(false);
    expect(PRESCRIPTIVE_LANGUAGE.test(text), text).toBe(false);
  });

  it("the scan really can fire on the shapes this copy could have taken", () => {
    expect(BANNED.test("You should connect Upstox for live alerts")).toBe(true);
    expect(BANNED.test("We recommend the Upstox feed")).toBe(true);
    expect(BANNED.test("Price alerts every 3 seconds")).toBe(true);
    expect(PRESCRIPTIVE_LANGUAGE.test("You must add Upstox first")).toBe(true);
  });

  it("the word alert appears nowhere in the card or the route", () => {
    for (const rel of [CARD, ROUTE, DIALOG]) {
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

const TOKEN = "upstox-analytics-token-do-not-leak";

function connect(accountId: number) {
  t.db
    .insert(t.schema.brokerConnections)
    .values({ accountId, broker: "upstox", apiKey: "upstox-key", accessToken: TOKEN })
    .run();
}

beforeAll(async () => {
  t = await openTempDb("live-feed-upstox-settings", { seed: true });
  route = await import("@/app/api/live/feed/route");

  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing" }, { id: OTHER, name: "Long term" }]).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: SWING }).run();
});

afterAll(() => {
  t?.cleanup();
});

describe("GET — the two facts the card renders the Upstox radio from", () => {
  it("says neither half holds on a fresh install", async () => {
    const body = await (await get()).json();
    expect(body.ok).toBe(true);
    expect(body.upstox).toEqual({ connected: false, ackCurrent: false, disclosureVersion: "1" });
    // Angel One's block is a SIBLING and never a rename of this one.
    expect(body.angelone).toMatchObject({ connected: false, ackCurrent: false, disclosureVersion: "1" });
    expect(body.upstox.disclosureVersion).toBe(LIVE_FEED_DISCLOSURE_VERSIONS.upstox);
  });

  it("offers upstox in the pickable set the card reads", async () => {
    const body = await (await get()).json();
    expect(body.providers.map((p: { id: string }) => p.id)).toContain("upstox");
  });
});

describe("POST provider upstox — 409 until BOTH halves hold, storing nothing", () => {
  it("refuses when no connection is saved, and names the next step", async () => {
    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("Add Upstox under Import → Brokers first.");
    expect(settingsRow()?.liveFeedProvider, "a refused pick was stored anyway").toBe("eod");
  });

  it("a connection on ANOTHER account is not this account's connection (invariant 8)", async () => {
    connect(OTHER);
    const body = await (await get()).json();
    expect(body.upstox.connected, "another account's token counted as this one's").toBe(false);
    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(409);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });

  it("refuses with the disclosure reason once the connection exists but nothing was accepted", async () => {
    connect(SWING);
    const body = await (await get()).json();
    expect(body.upstox).toMatchObject({ connected: true, ackCurrent: false });
    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("Read what the Upstox feed does");
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });
});

describe("POST ack — the acknowledgement round-trips through parseFeedAcks", () => {
  it("stores the version this build ships, under the provider's own id", async () => {
    const res = await post({ action: "ack", provider: "upstox" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.upstox).toMatchObject({ connected: true, ackCurrent: true });

    const stored = settingsRow()?.liveFeedAckJson;
    expect(parseFeedAcks(stored)).toEqual({ upstox: LIVE_FEED_DISCLOSURE_VERSIONS.upstox });
    expect(isFeedAckCurrent(stored, "upstox")).toBe(true);
  });

  it("…and the pick is accepted once both halves hold", async () => {
    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(200);
    expect(settingsRow()?.liveFeedProvider).toBe("upstox");
  });

  it("a version bump re-asks: a stored older version is refused, and the pick with it", async () => {
    t.db.update(t.schema.settings).set({ liveFeedAckJson: '{"upstox":"0"}', liveFeedProvider: "eod" }).run();
    const body = await (await get()).json();
    expect(body.upstox.ackCurrent, "an older acknowledgement was accepted as current").toBe(false);

    const res = await post({ action: "provider", provider: "upstox" });
    expect(res.status).toBe(409);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");

    // Accepting again restores it — and replaces the old version rather than
    // adding a second entry for the same provider.
    await post({ action: "ack", provider: "upstox" });
    expect(parseFeedAcks(settingsRow()?.liveFeedAckJson)).toEqual({ upstox: "1" });
  });
});

describe("the route reads the row's existence and never its token", () => {
  it("no credential of any kind is in the answer", async () => {
    const text = await (await get()).text();
    expect(text).toContain('"connected":true');
    expect(text, "the access token reached the client").not.toContain(TOKEN);
    expect(text).not.toContain("upstox-key");
    expect(text).not.toMatch(/access_?[Tt]oken/);
  });

  it("the select list is the id alone — proved in the source, since a wider select would still pass above", () => {
    const src = stripComments(read(ROUTE));
    expect(src).toMatch(/\.select\(\{ id: brokerConnections\.id \}\)/);
    expect(src, "the route reads a credential column").not.toMatch(/brokerConnections\.(apiKey|accessToken|authJson)/);
  });
});
