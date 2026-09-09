import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { cn } from "@/lib/utils";
import { pct } from "@/lib/format";
import { todayIstIso } from "@/lib/domain/trading-day";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 — THE SEAMS OF A FIVE-BUILDER WAVE.
 *
 * Each builder's wave was disjoint by file, so no builder ever ran the two
 * halves of a crossing together. This file does. Nothing here is mocked on
 * either side of a seam: the only stub is `globalThis.fetch`, which is the
 * NETWORK, not a half of any crossing — every Vyuha module in these tests is
 * the real one, reading and writing one real migrated SQLite file.
 *
 * ── THE SEAM TABLE ─────────────────────────────────────────────────────────
 *
 * # | crossing value                      | producer (file:line)                          | consumer (file:line)                          | unit / shape                     | test name
 * --|-------------------------------------|-----------------------------------------------|-----------------------------------------------|----------------------------------|----------------------------------------------
 * 1 | DialogDescription base className    | components/ui/dialog.tsx:73 (B1)              | every <DialogDescription> in app+components   | Tailwind class string, twMerge   | S1 · the shared DialogDescription size
 *   |   ↳ per-dialog className override   | components/import/broker-connect.tsx:1217 (B2)| components/ui/dialog.tsx:73                    | string | undefined               | S1 · B2/B4 dialogs inherit
 *   |                                     | components/quality/duplicate-fix.tsx:181 (B4) |                                               |                                  |
 * 2 | findRivalConnection(...) → Rival|null| lib/import/broker-identity.ts:216 (B4)        | app/api/import/broker/route.ts:490 (B2)       | {accountId:int, accountName:str} | S2 · a rival client refuses the save
 * 3 | the 409 body                        | app/api/import/broker/route.ts:502 (B2)       | components/import/broker-connect.tsx:593       | JSON {ok,error,message} over HTTP| S2 · `error` and `message` are ONE string
 * 4 | maskSecret / maskAccountId          | lib/import/broker-identity.ts:88,93 (B4)      | route.ts:93 `mask`, route.ts:100 `maskId`(B2) | masked string, char for char     | S3 · the two masks are one mask
 * 5 | NormalizedTrade[] from a Dhan pull  | lib/import/api/dhan.ts:889 toParsedFile (B2)  | lib/import/commit.ts:802 previewParsedFile(B3)| ParsedFile, rupees (invariant 1) | S4 · a Dhan history SELL closes the book's long
 * 6 | PreviewResult.autoClose             | lib/import/commit.ts:883 (B3)                 | components/import/import-client.tsx:521 (B2)  | {closes:int, positions:[{sym,qty}]}| S4 · autoClose.closes crosses as an integer
 * 7 | catchUpRange(lastPullAt, today)     | lib/import/api/dhan.ts:327 (B2)               | lib/jobs/auto-pull.ts:170 / route.ts:727 (B2) | {from,to} ISO dates, IST day     | S4 · the IST day boundary (18:30–24:00 UTC)
 * 8 | (broker, dedupHash) across accounts | lib/import/commit.ts commit (B3)              | lib/import/broker-identity.ts:326 (B4)        | sha string, account-free         | S5 · one account is never its own duplicate
 * 9 | removeDuplicateCopy(broker,hash,acc)| app/data-quality/actions.ts:33 (B4)           | lib/import/commit.ts lot book (B3)            | row ids scoped to ONE account    | S5 · B4's delete must not touch account A
 *10 | trades.is_open after an auto-close  | lib/import/commit.ts applyLotCloses (B3)      | lib/analytics/positions.ts:97 (B5, /risk)     | boolean column → OpenPosition[]  | S6 · a closed lot leaves the risk open set
 *11 | pct(value, decimals)                | lib/format.ts:32 (B5, pre-existing)           | every % surface outside B5                    | percent (NOT ppm), no "+" sign   | S7 · pct() is byte-identical in behaviour
 *12 | app/reports/rom/page.tsx local pct  | app/reports/rom/page.tsx:20 (unowned)         | — (recorded divergence, not fixed this wave)  | percent, WITH a "+"              | S7 · rom keeps its own helper (recorded)
 *13 | the splash tagline + struck phrases | src-tauri/loading/index.html:73 (B1)          | tests/positioning-copy.test.ts STRUCK scan    | literal sentence, UTF-8          | S8 · the splash crosses the positioning scan
 *14 | every new user-facing string        | all five builders' files                      | the SEBI copy rule                            | prose                            | S9 · no advice verb entered the wave
 *
 * NOTE ON UNITS. Two different `signedPct` exist after this wave:
 * `lib/format.ts:60` (B5) takes RUPEES + PERCENT and emits an ASCII "-", while
 * `components/live/desk-format.ts:43` (pre-existing) takes PPM and emits a
 * U+2212. No file imports both, so it is not a crossing — it is recorded in
 * the report as a naming hazard, not asserted here.
 *
 * Source-shape regexes use `\r?\n`: Windows CI checks these files out CRLF.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// One temp database for the whole file (lib/db caches its connection on
// globalThis — AGENTS.md), so every DB seam below uses its own account id.
// ---------------------------------------------------------------------------

let t: TempDb;
let route: typeof import("@/app/api/import/broker/route");
let identity: typeof import("@/lib/import/broker-identity");
let commit: typeof import("@/lib/import/commit");
let dhan: typeof import("@/lib/import/api/dhan");
let positionsMod: typeof import("@/lib/analytics/positions");
let tradesQ: typeof import("@/lib/queries/trades");
let actions: typeof import("@/app/data-quality/actions");

const PRIMARY = 1; // seeded as "Primary"
const SWING = 2;
const PULL = 11; // the Dhan catch-up seam (B2 ↔ B3 ↔ B5)
const BOOK_A = 21; // the cross-account duplicate seam (B3 ↔ B4)
const BOOK_B = 22;
const MASKS = 31; // the mask seam (B4 ↔ B2)

const CLIENT = "1000000009";
const RIVAL_CLIENT = "1000000009"; // deliberately the SAME Dhan Client ID
const OTHER_CLIENT = "1100011000";

/** A structurally valid JWT with a chosen `exp` (seconds). */
const fakeJwt = (expSeconds: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url"), "sig"].join(".");

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const connRows = () =>
  t.sqlite
    .prepare("SELECT account_id, broker, api_key FROM broker_connections ORDER BY account_id, broker")
    .all() as { account_id: number; broker: string; api_key: string }[];

const tradeRowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all();

/** No test in this file may reach the network by accident. */
function guardNetwork() {
  vi.stubGlobal("fetch", () => {
    throw new Error("TEST GUARD: a seam test reached the network");
  });
}

beforeAll(async () => {
  t = await openTempDb("seams-v43", { seed: true });
  route = await import("@/app/api/import/broker/route");
  identity = await import("@/lib/import/broker-identity");
  commit = await import("@/lib/import/commit");
  dhan = await import("@/lib/import/api/dhan");
  positionsMod = await import("@/lib/analytics/positions");
  tradesQ = await import("@/lib/queries/trades");
  actions = await import("@/app/data-quality/actions");
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: SWING, name: "Swing", isDefault: false },
      { id: PULL, name: "Catch-up", isDefault: false },
      { id: BOOK_A, name: "Book A", isDefault: false },
      { id: BOOK_B, name: "Book B", isDefault: false },
      { id: MASKS, name: "Masks", isDefault: false },
    ])
    .run();
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ===========================================================================
// SEAM 1 — B1's shared DialogDescription, and the dialogs B2/B4 hang off it
// ===========================================================================

/**
 * The crossing is a Tailwind class string that is MERGED, not concatenated:
 * `cn()` is tailwind-merge, so a consumer's `text-xs` silently WINS over the
 * primitive's `text-sm`. So the assertion is on the merged OUTPUT — B1's real
 * base string, taken from B1's file, run through the real `cn` with each
 * consumer's real override — not on either half alone.
 */
function dialogBaseClass(): string {
  const m = /DialogPrimitive\.Description className=\{cn\("([^"]*)"/.exec(read("components/ui/dialog.tsx"));
  if (!m) throw new Error("components/ui/dialog.tsx no longer composes a base className for DialogDescription");
  return m[1];
}

/** Every `<DialogDescription …>` in app/ and components/, with its override. */
function dialogDescriptionSites(): { at: string; className: string | null; dynamic: boolean }[] {
  const out: { at: string; className: string | null; dynamic: boolean }[] = [];
  for (const rel of tsxFiles(["app", "components"])) {
    const src = read(rel);
    const lines = src.split(/\r?\n/);
    for (const m of src.matchAll(/<DialogDescription\b([^>]*)>/g)) {
      const line = src.slice(0, m.index).split(/\r?\n/).length;
      const attrs = m[1];
      const lit = /className="([^"]*)"/.exec(attrs);
      const dyn = /className=\{/.test(attrs);
      out.push({ at: `${rel}:${line}`, className: lit ? lit[1] : null, dynamic: dyn && !lit });
      void lines;
    }
  }
  return out;
}

function tsxFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith(".tsx")) out.push(r);
    }
  };
  for (const d of dirs) walk(d);
  return out.sort();
}

/** The font-size token twMerge actually leaves standing. */
const sizeOf = (merged: string) => merged.split(" ").filter((c) => /^text-(xs|sm|base|lg|xl)$/.test(c));

describe("S1 · the shared DialogDescription size (B1 → B2's and B4's dialogs)", () => {
  const EXEMPT = "components/import/delete-import-dialog.tsx:53";

  it("every dialog in the app renders text-sm after the merge — except the one pinned mono filename", () => {
    const base = dialogBaseClass();
    const offenders: string[] = [];
    const sites = dialogDescriptionSites();
    expect(sites.length, "the DialogDescription scan found nothing — the walk is broken").toBeGreaterThan(20);

    for (const s of sites) {
      // The merged class the browser would actually see: B1's base, then the
      // consumer's override, through the real tailwind-merge.
      const merged = cn(base, s.className ?? undefined);
      if (sizeOf(merged).join(" ") !== "text-sm") offenders.push(`${s.at} → "${merged}"`);
    }
    expect(offenders.map((o) => o.split(" →")[0])).toEqual([EXEMPT]);
    // And the exemption is deliberate: a monospaced FILENAME, not prose.
    const exempt = sites.find((s) => s.at === EXEMPT)!;
    expect(exempt.className).toBe("font-mono text-xs");
    // twMerge keeps B1's colour and lets only the SIZE be overridden.
    expect(cn(base, exempt.className!)).toBe("text-foreground/90 font-mono text-xs");
  });

  it("B2's expired-token dialog and B4's confirm dialog pass no size of their own — they INHERIT", () => {
    const base = dialogBaseClass();
    const inheriting = dialogDescriptionSites().filter(
      (s) =>
        s.at.startsWith("components/import/broker-connect.tsx:") ||
        s.at.startsWith("components/quality/duplicate-fix.tsx:"),
    );
    expect(inheriting.length, "B2/B4 lost their dialogs").toBeGreaterThanOrEqual(4);
    for (const s of inheriting) {
      expect(s.className, `${s.at} started overriding the shared size`).toBeNull();
      expect(s.dynamic, `${s.at} took a computed className`).toBe(false);
      // The whole point of the seam: with no override, the consumer renders
      // exactly what B1 decided.
      expect(cn(base, s.className ?? undefined)).toBe(base);
      expect(sizeOf(base)).toEqual(["text-sm"]);
    }
  });
});

// ===========================================================================
// SEAM 2 + 3 — B4's findRivalConnection, through B2's REAL route handler
// ===========================================================================

/**
 * `tests/broker-route-hardening.test.ts` (B2's own) vi.mock()s
 * `findRivalConnection` — so the two halves of this crossing have never run
 * together. Here neither half is mocked: the real B4 reader reads the real
 * `broker_connections` rows the real B2 route just wrote.
 */
describe("S2/S3 · one broker CLIENT, two accounts (B4's reader → B2's route)", () => {
  beforeEachClean();

  function beforeEachClean() {
    // (declared as a function so the describe reads top-down)
  }

  const save = (accountId: number, apiKey: string, token: string) =>
    post({ action: "save", broker: "dhan", accountId, apiKey, accessToken: token });

  it("the SECOND account is refused 409, naming the FIRST account, and writes no row", async () => {
    guardNetwork();
    t.sqlite.prepare("DELETE FROM broker_connections").run();
    selectAccount(PRIMARY);

    expect((await save(PRIMARY, CLIENT, "tok-primary")).status).toBe(200);
    const before = connRows();
    expect(before).toHaveLength(1);

    selectAccount(SWING);
    const res = await save(SWING, RIVAL_CLIENT, "tok-swing");
    const json = (await res.json()) as { ok: boolean; error?: string; message?: string };

    expect(res.status).toBe(409);
    expect(json.ok).toBe(false);
    // The rival's ACCOUNT NAME crossed from B4's reader into B2's sentence.
    expect(json.message).toBe(
      'This Dhan client is already connected in account "Primary". Vyuha keeps one connection per broker client so a book is never imported twice.',
    );
    // Seam 3: `error` is the seam's field, `message` is what the client renders
    // (components/import/broker-connect.tsx:593 reads `data.message`). ONE string.
    expect(json.error).toBe(json.message);
    // The refusal ran BEFORE any write.
    expect(connRows()).toEqual(before);
  });

  it("a DIFFERENT client in the second account is not a rival — the check is the identity, not the broker", async () => {
    guardNetwork();
    t.sqlite.prepare("DELETE FROM broker_connections").run();
    selectAccount(PRIMARY);
    expect((await save(PRIMARY, CLIENT, "tok-primary")).status).toBe(200);
    selectAccount(SWING);
    expect((await save(SWING, OTHER_CLIENT, "tok-swing")).status).toBe(200);
    expect(connRows().map((r) => r.account_id)).toEqual([PRIMARY, SWING]);
  });

  it("the same save in the FIRST account is a RE-SAVE, not a rival — it succeeds and moves the token", async () => {
    guardNetwork();
    t.sqlite.prepare("DELETE FROM broker_connections").run();
    selectAccount(PRIMARY);
    expect((await save(PRIMARY, CLIENT, "tok-1")).status).toBe(200);
    const res = await save(PRIMARY, CLIENT, "tok-2");
    expect(res.status).toBe(200);
    expect(connRows()).toHaveLength(1);
    const vault = await import("@/lib/vault");
    const stored = t.sqlite.prepare("SELECT access_token FROM broker_connections").get() as { access_token: string };
    const readBack = vault.readSecret(stored.access_token);
    expect(readBack.ok && readBack.value).toBe("tok-2");
  });

  it("a token-only re-save (empty apiKey) keeps its own stored key and is still not its own rival", async () => {
    guardNetwork();
    t.sqlite.prepare("DELETE FROM broker_connections").run();
    selectAccount(PRIMARY);
    await save(PRIMARY, CLIENT, "tok-1");
    const beforeKey = connRows()[0].api_key;
    const res = await post({ action: "save", broker: "dhan", accountId: PRIMARY, apiKey: "", accessToken: "tok-3" });
    expect(res.status).toBe(200);
    expect(connRows()[0].api_key).toBe(beforeKey);
  });

  it("B4's reader agrees with what B2's route just refused", async () => {
    guardNetwork();
    t.sqlite.prepare("DELETE FROM broker_connections").run();
    selectAccount(PRIMARY);
    await save(PRIMARY, CLIENT, "tok-1");
    // The same question the route asked, asked directly: same answer.
    expect(identity.findRivalConnection({ broker: "dhan", apiKey: CLIENT, accountId: SWING })).toEqual({
      accountId: PRIMARY,
      accountName: "Primary",
    });
    expect(identity.findRivalConnection({ broker: "dhan", apiKey: CLIENT, accountId: PRIMARY })).toBeNull();
  });
});

// ===========================================================================
// SEAM 4 — B4's maskSecret/maskAccountId vs B2's route-local mask/maskId
// ===========================================================================

/**
 * `mask` and `maskId` are module-local consts in route.ts and are exported by
 * neither file, so the only honest comparison is OUTPUT to OUTPUT: drive the
 * route until it renders each mask, and compare that rendering with B4's.
 *
 *   mask   → GET's `apiKeyMasked` (route.ts:284)
 *   maskId → the Zerodha id-mismatch refusal (route.ts:776)
 */
describe("S4 · the two masks are one mask (B4's exports vs B2's route-local copies)", () => {
  const SECRET_SAMPLES = ["1000000009", "abc", "abcdef"]; // long, under-6, exactly-6

  it("maskSecret equals the route's `mask`, character for character, on three inputs", async () => {
    guardNetwork();
    t.sqlite.prepare("DELETE FROM broker_connections").run();
    selectAccount(MASKS);

    for (const sample of SECRET_SAMPLES) {
      t.sqlite.prepare("DELETE FROM broker_connections").run();
      const saved = await post({ action: "save", broker: "dhan", accountId: MASKS, apiKey: sample, accessToken: "t" });
      expect(saved.status, `saving ${sample}`).toBe(200);
      const got = (await (await route.GET()).json()) as { connections: { apiKeyMasked: string }[] };
      // The ROUTE's own rendering, versus B4's exported one.
      expect(got.connections[0].apiKeyMasked, `mask("${sample}")`).toBe(identity.maskSecret(sample));
    }
    // …and the masks are not all the same constant.
    expect(new Set(SECRET_SAMPLES.map(identity.maskSecret)).size).toBe(3);
  });

  it("maskAccountId equals the route's `maskId`, character for character, on three inputs", async () => {
    t.sqlite.prepare("DELETE FROM broker_connections").run();
    selectAccount(MASKS);

    // storedId / loginId pairs — three distinct sample inputs across two runs.
    const pairs: [string, string][] = [
      ["AB1234", "ZZ"],
      ["Q", "XY9876"],
    ];
    for (const [storedId, loginId] of pairs) {
      t.sqlite.prepare("DELETE FROM broker_connections").run();
      t.sqlite
        .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?,?,?,?,?)")
        .run(MASKS, "zerodha", "kite-api-key", "kite-token", JSON.stringify({ apiSecret: "sec", kiteUserId: storedId }));

      vi.stubGlobal("fetch", async () =>
        new Response(JSON.stringify({ status: "success", data: { access_token: "at", user_id: loginId } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const res = await post({ action: "pull", broker: "zerodha", accountId: MASKS, mode: "preview", requestToken: "rt" });
      const json = (await res.json()) as { kiteUserMismatch?: boolean; message: string };
      expect(res.status).toBe(409);
      expect(json.kiteUserMismatch).toBe(true);
      // Both masks in one sentence — both compared against B4's export.
      expect(json.message).toBe(
        `This connection is bound to Zerodha ID ${identity.maskAccountId(storedId)}, but today's login was for a different Zerodha ID (${identity.maskAccountId(loginId)}). Nothing was pulled — log in with the account this connection belongs to, or disconnect and reconnect for the other account.`,
      );
      vi.unstubAllGlobals();
    }
    expect(identity.maskAccountId("AB1234")).toBe("••••34"); // not a constant
    expect(identity.maskAccountId("Q")).toBe("••");
  });
});

// ===========================================================================
// SEAM 5 + 6 + 7 — B2's Dhan catch-up pull → B3's preview/commit → B4 → B5
// ===========================================================================

interface Fill {
  id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  at: string;
}

const dhanFill = (f: Fill) => ({
  exchangeTradeId: f.id,
  orderId: `O-${f.id}`,
  transactionType: f.side,
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  tradingSymbol: "TCS",
  tradedQuantity: f.qty,
  tradedPrice: f.price,
  exchangeTime: f.at,
});

/**
 * The REAL B2 producer: `dhanImportSource(...).fetchTrades(range)` walking the
 * real paging + dedup code, over a stubbed HTTP layer. `/positions` answers
 * empty (the catch-up window is history), `/trades/{f}/{t}/{p}` answers page p.
 */
async function realDhanPull(range: { from: string; to: string }, fills: Fill[]): Promise<ParsedFile> {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    paths.push(u.pathname);
    const body =
      u.pathname === "/v2/positions"
        ? []
        : /^\/v2\/trades\/[\d-]+\/[\d-]+\/0$/.test(u.pathname)
          ? fills.map(dhanFill)
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const creds = { clientId: CLIENT, accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 3600) };
  const trades = await dhan.dhanImportSource(creds).fetchTrades(range);
  const parsed = dhan.toParsedFile(trades, range);
  // The window really was requested — the seam carried the dates, not a default.
  expect(paths).toContain(`/v2/trades/${range.from}/${range.to}/0`);
  return parsed;
}

describe("S5/S6/S7 · a Dhan history SELL closes the long the book already holds (B2 → B3 → B4 → B5)", () => {
  // 2026-09-08T19:00:00Z is 2026-09-09 00:30 IST — the day boundary the whole
  // catch-up window is measured from. Every date below is decided at that
  // instant, so an off-by-one in the IST definition shows up as a wrong window.
  const AT_IST_BOUNDARY = new Date("2026-09-08T19:00:00Z");
  const TODAY = "2026-09-09";

  it("catchUpRange turns a stored stamp into the window BOTH callers pass on (18:30–24:00 UTC)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT_IST_BOUNDARY);
    expect(todayIstIso()).toBe(TODAY);
    // 2026-09-04T19:00Z is already the 5th in India — the ONE +5:30 definition.
    expect(dhan.catchUpRange("2026-09-04T19:00:00Z")).toEqual({ from: "2026-09-05", to: TODAY });
    expect(dhan.catchUpRange("2026-09-04T10:00:00Z")).toEqual({ from: "2026-09-04", to: TODAY });
    // A stamp from earlier tonight is ALREADY today in IST: nothing to catch up.
    expect(dhan.catchUpRange("2026-09-08T18:45:00Z")).toBeNull();
    expect(dhan.catchUpRange(null)).toBeNull();
  });

  it("the pull's SELL closes the open long: autoClose.closes === 1, then one closed row and no new short", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT_IST_BOUNDARY);
    selectAccount(PULL);

    // ── B2, for real: pull #1, the buy that opens the position ──────────────
    const range1 = dhan.catchUpRange("2026-09-04T19:00:00Z")!;
    const buyPull = await realDhanPull(range1, [
      { id: "F-BUY", side: "BUY", qty: 100, price: 100, at: "2026-09-05 09:30:00" },
    ]);
    expect(buyPull.broker).toBe("dhan");
    expect(buyPull.trades).toHaveLength(1);
    // The catch-up warning names the window this pull covered.
    expect(buyPull.warnings.some((w) => w.includes(`fills from ${range1.from} to ${range1.to}`))).toBe(true);

    // ── B3, for real ────────────────────────────────────────────────────────
    expect(commit.previewParsedFile(buyPull, null, PULL).autoClose).toEqual({ closes: 0, positions: [] });
    expect(commit.commitParsedFile(buyPull, "dhan-api", null, PULL).added).toBe(1);
    const open = tradeRowsOf(PULL);
    expect(open).toHaveLength(1);
    expect(open[0].isOpen).toBe(true);
    expect(open[0].buyQty).toBe(100);

    // ── B2 again: pull #2, the SELL of what the book is already holding ─────
    const range2 = dhan.catchUpRange("2026-09-06T19:00:00Z")!;
    const sellPull = await realDhanPull(range2, [
      { id: "F-SELL", side: "SELL", qty: 100, price: 120, at: "2026-09-07 14:00:00" },
    ]);
    expect(sellPull.trades[0].sellQty).toBe(100);
    expect(sellPull.trades[0].buyQty).toBe(0);

    // Seam 6: the integer that crosses into components/import/import-client.tsx.
    const preview = commit.previewParsedFile(sellPull, null, PULL);
    expect(preview.autoClose).toEqual({ closes: 1, positions: [{ symbol: "TCS", qty: 100 }] });

    const res = commit.commitParsedFile(sellPull, "dhan-api", null, PULL);
    const after = tradeRowsOf(PULL);
    expect(after, "the close landed on the existing row, not beside it").toHaveLength(1);
    expect(after[0].id).toBe(open[0].id);
    expect(after[0].isOpen).toBe(false);
    expect(after[0].buyQty).toBe(100);
    expect(after[0].sellQty).toBe(100);
    expect(after[0].avgSellPrice).toBe(120);
    expect(after[0].grossPnl).toBe(2000); // (120 − 100) × 100, rupees
    expect(after.filter((r) => r.isOpen && r.sellQty > r.buyQty), "no phantom short").toHaveLength(0);
    expect(res.added).toBe(0); // it CLOSED a row; it did not add one
  });

  it("a SECOND identical pull closes nothing and adds nothing — dedup runs before matching", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT_IST_BOUNDARY);
    selectAccount(PULL);
    const before = tradeRowsOf(PULL);
    expect(before).toHaveLength(1);

    const range2 = dhan.catchUpRange("2026-09-06T19:00:00Z")!;
    const again = await realDhanPull(range2, [
      { id: "F-SELL", side: "SELL", qty: 100, price: 120, at: "2026-09-07 14:00:00" },
    ]);
    expect(commit.previewParsedFile(again, null, PULL).autoClose).toEqual({ closes: 0, positions: [] });
    const res = commit.commitParsedFile(again, "dhan-api", null, PULL);
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(1);
    const after = tradeRowsOf(PULL);
    expect(after).toHaveLength(1);
    expect(after[0].sellQty).toBe(100);
    expect(after[0].grossPnl).toBe(2000);
  });

  it("S5 · B4 sees no duplicate: one account can never be its own duplicate", () => {
    const mine = identity.listDuplicateTradeGroups().filter((g) => g.accounts.some((a) => a.id === PULL));
    expect(mine).toEqual([]);
  });

  it("S6 · the auto-closed lot has left the risk page's open set (B3's column → B5's derivation)", () => {
    selectAccount(PULL);
    const trades = tradesQ.getTrackerTrades();
    expect(trades.length, "the account still holds its row").toBe(1);
    // The REAL /risk derivation, on the REAL rows the commit above wrote.
    const open = positionsMod.deriveOpenPositions(trades, new Map(), TODAY);
    expect(open.map((p) => p.symbol)).not.toContain("TCS");
    expect(open).toEqual([]);
  });
});

// ===========================================================================
// SEAM 8 + 9 — the same broker record in two books (B3 ↔ B4)
// ===========================================================================

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan",
    isin: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    grossPnl: 0,
    unrealisedPnl: 0,
    buyDate: null,
    sellDate: null,
    productHint: "delivery",
    exchangeHint: "NSE",
    sourceFile: null,
    ...over,
  } as NormalizedTrade;
}

const buyFile = (symbol: string, qty: number, price: number, date: string): ParsedFile => ({
  sourceId: "dhan-gtr",
  broker: "dhan",
  format: "tradebook",
  warnings: [],
  trades: [
    trade({ tradingsymbol: symbol, buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: date }),
  ],
});

const sellFile = (symbol: string, qty: number, price: number, date: string): ParsedFile => ({
  sourceId: "dhan-gtr",
  broker: "dhan",
  format: "tradebook",
  warnings: [],
  trades: [
    trade({ tradingsymbol: symbol, sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: date }),
  ],
});

describe("S8/S9 · one broker record in two books (B3's dedupHash → B4's grouping → back to B3's matcher)", () => {
  it("the same file committed into two accounts is ONE duplicate group naming both", () => {
    // The dedup hash carries no account id, so committing the SAME file twice
    // into two accounts is exactly the defect B4's reader is for.
    selectAccount(BOOK_A);
    expect(commit.commitParsedFile(buyFile("INFY", 50, 200, "2026-04-01"), "book.csv", null, BOOK_A).added).toBe(1);
    selectAccount(BOOK_B);
    expect(commit.commitParsedFile(buyFile("INFY", 50, 200, "2026-04-01"), "book.csv", null, BOOK_B).added).toBe(1);

    const groups = identity
      .listDuplicateTradeGroups()
      .filter((g) => g.accounts.some((a) => a.id === BOOK_A || a.id === BOOK_B));
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.broker).toBe("dhan");
    expect(g.brokerLabel).toBe("Dhan");
    expect(g.symbol).toBe("INFY");
    expect(g.qty).toBe(50);
    expect(g.rows).toBe(2);
    expect(g.accounts.map((a) => [a.id, a.name, a.rows])).toEqual([
      [BOOK_A, "Book A", 1],
      [BOOK_B, "Book B", 1],
    ]);
    // The two rows really are the same broker record.
    expect(tradeRowsOf(BOOK_A)[0].dedupHash).toBe(tradeRowsOf(BOOK_B)[0].dedupHash);
    expect(g.dedupHash).toBe(tradeRowsOf(BOOK_A)[0].dedupHash);
  });

  it("removing B's copy leaves A's lot intact — and A's auto-close matcher still closes it", async () => {
    const hash = tradeRowsOf(BOOK_A)[0].dedupHash;
    const aRowId = tradeRowsOf(BOOK_A)[0].id;

    // From the ALL-ACCOUNTS view, which is the path the refusal message itself
    // advertises ("Switch to Book B or to All accounts to remove it"). It is
    // also the only path where B4's own per-account id scoping is the ONLY
    // thing standing between the fix and account A: `deleteTradesByIds`
    // (lib/queries/delete.ts:123) allows every id when the selected account is
    // 0, so a `duplicateTradeIdsIn` that forgot its account filter would take
    // BOTH copies. Running this from inside Book B would hide that.
    selectAccount(0);
    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: hash, accountId: BOOK_B });
    expect(res.ok, res.message).toBe(true);
    expect(res.removed).toBe(1);
    expect(tradeRowsOf(BOOK_B)).toHaveLength(0);

    // B4's delete must not have touched A.
    const aRows = tradeRowsOf(BOOK_A);
    expect(aRows).toHaveLength(1);
    expect(aRows[0].id).toBe(aRowId);
    expect(aRows[0].isOpen).toBe(true);

    // …and B3's matcher, run afterwards in A, still SEES that lot.
    selectAccount(BOOK_A);
    const sell = sellFile("INFY", 50, 240, "2026-05-01");
    expect(commit.previewParsedFile(sell, null, BOOK_A).autoClose).toEqual({
      closes: 1,
      positions: [{ symbol: "INFY", qty: 50 }],
    });
    commit.commitParsedFile(sell, "sell.csv", null, BOOK_A);
    const closed = tradeRowsOf(BOOK_A);
    expect(closed).toHaveLength(1);
    expect(closed[0].id).toBe(aRowId);
    expect(closed[0].isOpen).toBe(false);
    expect(closed[0].grossPnl).toBe(2000); // (240 − 200) × 50

    // The group is gone: a sole copy is not a duplicate (the EMPTY case).
    expect(identity.findDuplicateTradeGroup("dhan", hash)).toBeNull();
    expect(
      identity.listDuplicateTradeGroups().filter((g) => g.accounts.some((a) => a.id === BOOK_A || a.id === BOOK_B)),
    ).toEqual([]);
  });

  it("B4 refuses to delete from the All-accounts view — 0 is a view, not a place", async () => {
    selectAccount(0);
    const res = await actions.removeDuplicateCopy({ broker: "dhan", dedupHash: "whatever", accountId: 0 });
    expect(res.ok).toBe(false);
    expect(res.removed).toBe(0);
    expect(res.message).toBe("Name the account the copy is removed from. All accounts is a view, not an account.");
  });
});

// ===========================================================================
// SEAM 11 + 12 — B5's lib/format.ts, and what did NOT change with it
// ===========================================================================

describe("S7 · pct() is byte-identical in behaviour after B5 added three neighbours", () => {
  it("three values, pinned: no sign is added, the decimals are honoured, null is an em dash", () => {
    expect(pct(1.234)).toBe("1.23%");
    expect(pct(-1.235)).toBe("-1.24%");
    expect(pct(12.5, 1)).toBe("12.5%");
    expect(pct(0)).toBe("0.00%");
    expect(pct(null)).toBe("—");
    // The one property every non-B5 caller depends on: a POSITIVE percentage
    // carries NO "+". B5's `signedPct` is the opt-in that does.
    expect(pct(1.23).startsWith("+")).toBe(false);
  });

  it("app/reports/rom/page.tsx still runs its OWN pct — recorded, not fixed this wave", () => {
    const src = read("app/reports/rom/page.tsx");
    const imp = /import \{([^}]*)\} from "@\/lib\/format";/.exec(src);
    expect(imp, "rom stopped importing from lib/format at all").not.toBeNull();
    const imported = imp![1].split(",").map((s) => s.trim()).filter(Boolean).sort();
    // If `pct` ever appears here, this divergence has been FIXED and the
    // rendered percentages on /reports/rom change (rom prints "+1.23%",
    // lib/format prints "1.23%") — which is a wave, not a silent edit.
    expect(imported).toEqual(["inr", "num"]);
    expect(/const pct = \(v: number \| null, dp = 2\)/.test(src), "rom's local helper is gone").toBe(true);
  });
});

// ===========================================================================
// SEAM 13 — B1's splash, crossing the positioning-copy scan
// ===========================================================================

describe("S8 · the splash crosses tests/positioning-copy.test.ts's banned-phrase scan (B1 → tests)", () => {
  const TAGLINE = "Every warrior had a charioteer. Yours keeps count.";

  /** The struck list as the OTHER test actually holds it — read, not retyped,
   *  so this seam cannot drift from the scan it is standing in for. */
  function struckPhrases(): string[] {
    const src = read("tests/positioning-copy.test.ts");
    const block = /const STRUCK = \[([\s\S]*?)\] as const;/.exec(src);
    expect(block, "positioning-copy.test.ts no longer declares STRUCK").not.toBeNull();
    return [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  it("the splash is still on the scanned surface list", () => {
    const src = read("tests/positioning-copy.test.ts");
    const block = /const SURFACES = \[([\s\S]*?)\] as const;/.exec(src) ?? /const SURFACES = \[([\s\S]*?)\];/.exec(src);
    expect(block, "SURFACES is gone").not.toBeNull();
    expect(block![1]).toContain("src-tauri/loading/index.html");
  });

  it("carries the new tagline and none of the struck phrases came back with it", () => {
    const splash = read("src-tauri/loading/index.html");
    expect(splash).toContain(TAGLINE);
    const struck = struckPhrases();
    expect(struck.length, "the struck list emptied out").toBeGreaterThanOrEqual(10);
    const back = struck.filter((p) => splash.toLowerCase().includes(p.toLowerCase()));
    expect(back).toEqual([]);
    // The retired strap the tagline replaced.
    expect(/YOUR\s+CHOICE/i.test(splash)).toBe(false);
  });
});

// ===========================================================================
// SEAM 14 — the SEBI copy rule, across all five builders' files
// ===========================================================================

/** Every file this wave touched, by builder. */
const WAVE_FILES = [
  // B1
  "src-tauri/loading/index.html",
  "components/system/help-desk.tsx",
  "components/ui/dialog.tsx",
  // B2
  "components/import/broker-connect.tsx",
  "components/import/import-client.tsx",
  "lib/import/api/dhan.ts",
  "lib/jobs/auto-pull.ts",
  "app/api/import/broker/route.ts",
  // B3
  "lib/import/commit.ts",
  "lib/import/close-open-lots.ts",
  // B4
  "lib/import/broker-identity.ts",
  "lib/analytics/data-quality.ts",
  "app/data-quality/page.tsx",
  "app/data-quality/actions.ts",
  "components/quality/duplicate-fix.tsx",
  // B5
  "app/risk/page.tsx",
  "components/risk/expiry-obligations.tsx",
  "components/risk/risk-cockpit-client.tsx",
  "components/risk/spot-mark-editor.tsx",
  "lib/format.ts",
];

/** Prose the user can read: string literals and JSX text, comments removed. */
function userFacingStrings(rel: string): string[] {
  const src = read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l))
    .join("\n");
  const out = new Set<string>();
  for (const m of src.matchAll(/"([^"\\\n]{8,})"/g)) out.add(m[1]);
  // Newline-free only: a backtick that spans lines in these files is a `sql`
  // fragment or a multi-line code template, never a sentence a user reads.
  for (const m of src.matchAll(/`([^`\\\n]{8,})`/g)) out.add(m[1]);
  for (const m of src.matchAll(/>\s*([A-Z][^<>{}\n]{7,})</g)) out.add(m[1]);
  // Identifiers, test ids, class strings and paths are not prose.
  return [...out].filter((s) => /\s/.test(s) && /[a-z]{3}/.test(s) && !/^[a-z0-9/:.\-\s]+$/.test(s));
}

/**
 * The two phrases that already said one of these words BEFORE this wave, and
 * why each is not investment advice. Anything not on this list is a finding.
 */
const PRE_EXISTING = new Map<string, string>([
  [
    "Connect once with PIN + TOTP (recommended)",
    "product configuration, not a market view — pre-existing, untouched by this wave",
  ],
  [
    "At least one side (buy or sell) needs a positive quantity.",
    "'buy'/'sell' as ORDER-SIDE nouns naming the two legs of a trade row",
  ],
  ["Buy-back (cover) price", "'Buy-back' is the order side of a short cover, a noun"],
]);

describe("S9 · no advice verb entered the wave (SEBI copy rule, all five builders)", () => {
  const ADVICE = /\b(recommend|recommends|recommended|recommendation|suggest|suggests|suggested|should|consider|considering)\b/i;
  const ORDER_SIDE = /\b(buy|sell)\b/i;

  it("every user-facing string across the wave is free of advice verbs", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const rel of WAVE_FILES) {
      for (const s of userFacingStrings(rel)) {
        scanned++;
        if (!ADVICE.test(s) && !ORDER_SIDE.test(s)) continue;
        if (PRE_EXISTING.has(s)) continue;
        offenders.push(`${rel} :: ${s}`);
      }
    }
    expect(scanned, "the prose scan found nothing — the extractor is broken").toBeGreaterThan(300);
    expect(offenders).toEqual([]);
  });

  it("the allowlist is not a loophole — each pinned phrase is still exactly where it was", () => {
    const all = WAVE_FILES.flatMap(userFacingStrings);
    for (const phrase of PRE_EXISTING.keys()) {
      expect(all, `${phrase} is gone — drop it from PRE_EXISTING rather than leaving a dead exemption`).toContain(
        phrase,
      );
    }
    // The scanner really does fire.
    expect(ADVICE.test("Vyuha recommends you sell")).toBe(true);
    expect(ADVICE.test("You should consider trimming")).toBe(true);
  });
});
