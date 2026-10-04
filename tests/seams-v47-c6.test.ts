import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as XLSX from "xlsx";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { istWallClockIso } from "@/lib/domain/trading-day";
import { BROKER_PULL_DISCLOSURES, pullAckCurrent, type BrokerPullDisclosureId } from "@/lib/domain/broker-pull-disclosure";

/**
 * SEAM PASS — v4.7.0 wave C6 (native read-only pulls: Fyers, Kotak Neo, Nuvama).
 * Both real halves of every value that crosses a builder boundary, run together
 * over ONE migrated temp database (tests/helpers/temp-db.ts; one per file).
 * Nothing on either side is mocked: `fetch` is a DISPATCHER that answers the
 * three brokers' documented hosts from per-test queues and THROWS on any other
 * host (no real broker is ever reached); the route, A's normalisers, B1's
 * pull-symbols / cross-source, the commit pipeline, the vault (`machine`), the
 * rival check and auto-pull are all the real modules. `next/cache` is stubbed
 * (revalidatePath needs a Next runtime) — it is neither side of any seam here.
 *
 * Builders: B1 = lib/import/pull-symbols.ts, lib/engine/classify.ts, lib/import/cross-source.ts;
 * A = lib/import/api/{broker-auth-error,fyers,kotakneo,nuvama}.ts, lib/domain/broker-pull-disclosure.ts;
 * C = app/api/import/broker/route.ts, lib/import/broker-identity.ts, lib/jobs/auto-pull.ts,
 *     components/import/broker-connect.tsx, lib/domain/import-help-content.ts;
 * ORCH = UNVERIFIED_PULL_BROKERS (A's file) read by the route GET.
 *
 * The card (broker-connect.tsx) cannot be rendered on a non-default tab under node (no DOM;
 * `broker` state starts at "zerodha"), so its REQUEST BODIES and the 409 FIELDS it reads are
 * derived from its own source with the TypeScript AST (the readers-follow-writers pattern) and
 * then sent to / compared with the REAL route. Assertions are on the route's behaviour and the
 * database, never on source text. One card line is mirrored, named where it is used:
 * `consentShowing = pullSheet != null && saveTargetConn?.pullAckCurrent !== true` (:981).
 *
 * ┌──────────────────────────────┬──────────────────────────────────────────────┬──────────────────────────────────────────────┬──────────────────────┬─────────┐
 * │ crossing value               │ producer (builder) file:line                 │ consumer (builder) file:line                 │ unit / type          │ case    │
 * ├──────────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┼──────────────────────┼─────────┤
 * │ tradingsymbol (Fyers)        │ B1 pull-symbols.ts:158 via A fyers.ts:268    │ C route.ts:1537 preview → B1 cross-source    │ string, compact form │ S1a-c,6 │
 * │ tradingsymbol (Kotak)        │ B1 pull-symbols.ts:207 via A kotakneo.ts:267 │ C route → commit; OpenAlgo-Kotak dedupHash   │ OpenAlgo canonical   │ S1e,S6  │
 * │ tradingsymbol (Nuvama)       │ B1 pull-symbols.ts:280 via A nuvama.ts:277   │ cross-source string bucket vs P&L report     │ report's own string  │ S1d,S6  │
 * │ contract key / monthOnly     │ B1 cross-source.ts:300-360,425               │ C route.ts:1579 (risky→409) + card badge     │ key + day|null       │ S1a,b   │
 * │ refused (count) / notes      │ A {fyers,kotakneo,nuvama}.ts normalise*      │ C route.ts:699/752/772 → warnings            │ int, sentences       │ S1f,S6  │
 * │ today (IST)                  │ C route.ts:690/751/771 todayIstIso()         │ A normalise*(rows, today) → buyDate          │ ISO day, IST         │ S1g     │
 * │ fileName `<broker>-api-<day>`│ C route.ts:1510 / auto-pull.ts:314           │ commit supersedeSnapshot (snapshot key)      │ string               │ S1c,S3d │
 * │ save body keys               │ C broker-connect.tsx:1089-1111 save()        │ C route.ts:400-449 packAuth, :903 consent    │ JSON keys            │ S2a     │
 * │ pull body keys + paste field │ C broker-connect.tsx:1153-1162, :407         │ C route.ts:659 authCode / :727 requestId     │ JSON keys            │ S2b     │
 * │ 409 vocabulary               │ C route.ts:186-225,617-642,1494              │ C broker-connect.tsx:1171-1201 (data.*)      │ JSON booleans, url   │ S2c     │
 * │ pullAckVersion               │ C route.ts:908-911 (stamp)                   │ route GET :536, pull :1346, auto-pull :94    │ NUMBER, === current  │ S3a-c   │
 * │ pullAckCurrent (GET)         │ C route.ts:536                               │ C card consentShowing → pullSaveBlocked      │ boolean              │ S3b     │
 * │ auth_json via mergeAuth      │ C broker-identity.ts:213 (all writers)       │ route pull / identity / auto-pull            │ JSON object          │ S4a-c   │
 * │ tokenExpiresAt / cache       │ C route.ts:685,697,744,750,1487              │ route cacheAlive :646, GET :507              │ ISO instant          │ S4a,b   │
 * │ AppIdKey (session)           │ A nuvama.ts:209 (mutates session)            │ C route.ts:750 re-cache → next pull headers  │ header string        │ S4c     │
 * │ BrokerAuthExpired.need       │ A broker-auth-error.ts:21, fyers/nuvama/kotak│ C route.ts:1486-1497 → 409 [need]            │ "needsAuthCode"|…    │ S4a,c,d │
 * │ fyId / nuvamaUserId / ucc    │ C route.ts:618-685,744; :412 (ucc upper)     │ C broker-identity.ts:181-192                 │ id string            │ S5a-d   │
 * │ ranged (gap line)            │ C card PULL_GAP_RANGED :370 (vs route GET    │ C card pullGapLines :589                     │ boolean              │ S7      │
 * │                              │   catchUpFrom :550, lastPullAt stamp :1609)  │                                              │                      │         │
 * │ unverified (GET)             │ ORCH route.ts:537 ← UNVERIFIED_PULL_BROKERS  │ NO CONSUMER in the card (badge keys on tab)  │ boolean              │ D-C6-1  │
 * │ needsConsent.version         │ C route.ts:218                               │ NO CONSUMER (card re-reads GET instead)      │ number               │ S2c     │
 * └──────────────────────────────┴──────────────────────────────────────────────┴──────────────────────────────────────────────┴──────────────────────┴─────────┘
 *
 * BOUNDARIES WITH NO CASE HERE (named, with why):
 *   - The card's consent SHEET markup, unverified Badge and login dialog DOM: no DOM under vitest and the
 *     tab cannot be switched in a static render; e2e/z-broker-pulls-c6.spec.ts owns them.
 *   - lib/domain/import-help-content.ts copy: no value crosses into code — it is prose only.
 *   - Kotak `assertKotakBaseUrl` refusal: both halves are A's (kotakneo.ts:52 → :188); pinned in
 *     tests/kotakneo-api.test.ts. S1e runs the accepted host through the route.
 *   - Fyers `/trade-history` (owner Q1: not built) — no producer exists.
 *
 * RECORDED SEAM DEFECTS (it.fails — each turns green when fixed; flip it in the fixing commit):
 *   D-C6-1 — GET's `unverified` (route.ts:537) has no consumer: the card badges every C6 tab whatever
 *            UNVERIFIED_PULL_BROKERS says (broker-connect.tsx:1348), so verifying a broker cannot un-badge it.
 *   D-C6-2 — a currency future (USDINR) is REFUSED from Kotak (pull-symbols.ts:175-179) but named and priced
 *            as an equity `future` from Nuvama (CDS, pull-symbols.ts:245) and Fyers (segment 12, fyers.ts:268).
 * Also recorded, NOT a defect (design P10/R7, pinned by S5e): when the NEWER of two connections for one
 * Fyers client logs in first, neither pull refuses; Data Quality's duplicate-connection list is the catch.
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/* ─────────────────────────────── harness ─────────────────────────────── */

let t: TempDb;
let route: typeof import("@/app/api/import/broker/route");
let vault: typeof import("@/lib/vault");
let identity: typeof import("@/lib/import/broker-identity");
let autoPull: typeof import("@/lib/jobs/auto-pull");
let commit: typeof import("@/lib/import/commit");
let openalgo: typeof import("@/lib/import/api/openalgo");
let fyers: typeof import("@/lib/import/api/fyers");
let kotak: typeof import("@/lib/import/api/kotakneo");
let nuvama: typeof import("@/lib/import/api/nuvama");
let symbols: typeof import("@/lib/import/pull-symbols");
let classifyMod: typeof import("@/lib/engine/classify");
let card: typeof import("@/components/import/broker-connect");
let detect: typeof import("@/lib/import/detect");
let nuvamaReport: typeof import("@/lib/import/parsers/nuvama-pnl-report");

const at = (d: string, hhmm: string) => new Date(istWallClockIso(d, hhmm));
const TODAY = "2026-10-07"; // an ordinary Wednesday
const YESTERDAY = "2026-10-06";
const SECRET = "JBSWY3DPEHPK3PXP";
const PRIMARY = 1;
let SECOND = 2;

type Answer = { status: number; body: unknown; headers?: Record<string, string> };
type Call = { key: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let answers: Array<[RegExp, (c: Call) => Answer]> = [];
const answer = (re: RegExp, fn: (c: Call) => Answer) => answers.unshift([re, fn]);

function dispatcher() {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    const known = ["api-t1.fyers.in", "mis.kotaksecurities.com", "cis.kotaksecurities.com", "nc.nuvamawealth.com"];
    if (!known.includes(u.host)) throw new Error(`TEST GUARD: the C6 seam reached an unexpected host ${u.host}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = String(v);
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = String(init?.body);
    }
    const c: Call = { key: `${u.host}${u.pathname}`, method: init?.method ?? "GET", headers, body };
    calls.push(c);
    const hit = answers.find(([re]) => re.test(c.key));
    if (!hit) throw new Error(`TEST GUARD: no answer queued for ${c.key}`);
    const a = hit[1](c);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json", ...(a.headers ?? {}) } });
  };
}
const hit = (re: RegExp) => calls.filter((c) => re.test(c.key));

function setClock(d: Date) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"], now: d });
}

beforeAll(async () => {
  t = await openTempDb("seams-v47-c6", { seed: true });
  route = await import("@/app/api/import/broker/route");
  vault = await import("@/lib/vault");
  identity = await import("@/lib/import/broker-identity");
  autoPull = await import("@/lib/jobs/auto-pull");
  commit = await import("@/lib/import/commit");
  openalgo = await import("@/lib/import/api/openalgo");
  fyers = await import("@/lib/import/api/fyers");
  kotak = await import("@/lib/import/api/kotakneo");
  nuvama = await import("@/lib/import/api/nuvama");
  symbols = await import("@/lib/import/pull-symbols");
  classifyMod = await import("@/lib/engine/classify");
  card = await import("@/components/import/broker-connect");
  detect = await import("@/lib/import/detect");
  nuvamaReport = await import("@/lib/import/parsers/nuvama-pnl-report");
  SECOND = Number(
    t.sqlite.prepare("INSERT INTO accounts (name) VALUES ('Seam second book')").run().lastInsertRowid,
  );
  // Warm the commit pipeline's lazy loads (rate tables, bundled maps) once, so no `it` pays them (≤ 300 ms each).
  commit.previewParsedFile({ sourceId: "warm", broker: "fyers", format: "api", trades: [], warnings: [] }, null, PRIMARY, "warm-up");
  await route.GET();
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.cleanup();
});

beforeEach(() => {
  setClock(at(TODAY, "11:00"));
  const tables = (t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((x) => x.name)
    .filter((n) => /^(trades|trade_legs|trade_executions|import_batches|broker_connections|audit_log)$/.test(n));
  t.sqlite.pragma("foreign_keys = OFF");
  for (const n of tables) t.sqlite.prepare(`DELETE FROM "${n}"`).run();
  t.sqlite.pragma("foreign_keys = ON");
  t.db.update(t.schema.settings).set({ selectedAccountId: PRIMARY, autoPullEnabled: false, lastAutoPullDate: null }).run();
  calls = [];
  answers = [];
  vi.stubGlobal("fetch", dispatcher());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A route JSON body as the CARD receives it: untyped JSON (`res.json()`), read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WireJson = Record<string, any>;

async function post(body: unknown): Promise<{ status: number; json: WireJson }> {
  const res = await route.POST(
    new Request("http://localhost/api/import/broker", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  );
  return { status: res.status, json: (await res.json()) as WireJson };
}
async function getRows(): Promise<WireJson[]> {
  const res = await route.GET();
  return ((await res.json()) as { connections: WireJson[] }).connections;
}

type ConnRow = { id: number; account_id: number; broker: string; api_key: string; access_token: string; auth_json: string | null; last_pull_at: string | null };
const conn = (broker: string, accountId = PRIMARY) =>
  t.sqlite.prepare("SELECT * FROM broker_connections WHERE broker = ? AND account_id = ?").get(broker, accountId) as ConnRow | undefined;
const plain = (stored: string | null | undefined) => {
  const r = vault.readSecret(stored);
  return r.ok ? r.value : "";
};
const authOf = (broker: string, accountId = PRIMARY): Record<string, unknown> => JSON.parse(plain(conn(broker, accountId)?.auth_json) || "null") ?? {};

function seedConn(broker: string, apiKey: string, auth: Record<string, unknown> | null, opts: { accountId?: number; token?: string; lastPullAt?: string | null } = {}) {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      opts.accountId ?? PRIMARY,
      broker,
      vault.encryptSecret(apiKey),
      vault.encryptSecret(opts.token ?? ""),
      auth ? vault.encryptSecret(JSON.stringify(auth)) : null,
      opts.lastPullAt ?? null,
    );
}

type TradeRowDb = { id: number; account_id: number; broker: string; tradingsymbol: string; symbol: string; segment: string; buy_qty: number; sell_qty: number; buy_date: string | null; source_file: string | null };
const tradesOf = (tradingsymbol?: string) =>
  (tradingsymbol
    ? t.sqlite.prepare("SELECT * FROM trades WHERE tradingsymbol = ? ORDER BY id").all(tradingsymbol)
    : t.sqlite.prepare("SELECT * FROM trades ORDER BY id").all()) as TradeRowDb[];

/* ───────────────────────────── broker answers ───────────────────────────── */

const APP_ID = "SEAMAPP1-100";
const FY_ID = "XA12345";

function fyersLogin(fyId: string | null = FY_ID, token = "FY-TOKEN-1") {
  answer(/api-t1\.fyers\.in\/api\/v3\/validate-authcode$/, () => ({ status: 200, body: { s: "ok", code: 200, message: "", access_token: token } }));
  answer(/api-t1\.fyers\.in\/api\/v3\/profile$/, () => ({ status: 200, body: { s: "ok", code: 200, data: fyId ? { fy_id: fyId } : {} } }));
}
function fyersBook(rows: unknown[] | (() => Answer)) {
  answer(/api-t1\.fyers\.in\/api\/v3\/tradebook$/, typeof rows === "function" ? rows : () => ({ status: 200, body: { s: "ok", code: 200, message: "", tradeBook: rows } }));
}
const fyFill = (symbol: string, side: 1 | -1, qty: number, price: number, time = "10:15:33", extra: Record<string, unknown> = {}) => ({
  symbol, side, tradedQty: qty, tradePrice: price, tradeValue: qty * price, productType: "MARGIN",
  exchange: symbol.startsWith("BSE:") ? 12 : symbol.startsWith("MCX:") ? 11 : 10, segment: symbol.endsWith("-EQ") ? 10 : 11,
  orderDateTime: `07-Oct-2026 ${time}`, orderNumber: "26100700001", tradeNumber: "1", exchangeOrderNo: "1100000000001", clientId: FY_ID,
  ...extra,
});

function kotakAnswers(rows: unknown[]) {
  answer(/mis\.kotaksecurities\.com\/login\/1\.0\/tradeApiLogin$/, () => ({ status: 200, body: { data: { token: "VIEW-TOK", sid: "VIEW-SID" } } }));
  answer(/mis\.kotaksecurities\.com\/login\/1\.0\/tradeApiValidate$/, () => ({
    status: 200,
    body: { data: { token: "TRADE-TOK", sid: "TRADE-SID", baseUrl: "https://cis.kotaksecurities.com" } },
  }));
  answer(/cis\.kotaksecurities\.com\/quick\/user\/trades$/, () => ({ status: 200, body: { stat: "Ok", stCode: 200, data: rows } }));
}

const NV_KEY = "nv-api-key-1";
const NV_USER = "55501234";
function nuvamaLoginAnswers(userId = NV_USER) {
  answer(/nc\.nuvamawealth\.com\/edelmw-login\/login\/accounts\/loginvendor\//, () => ({ status: 200, body: { msg: "VENDOR-SESSION" } }));
  answer(/nc\.nuvamawealth\.com\/edelmw-login\/login\/accounts\/logindata\/$/, () => ({
    status: 200,
    body: { data: { auth: "NV-AUTH", lgnData: { accTyp: "EQ", accs: { eqAccID: userId } } } },
  }));
}
function nuvamaBook(rows: unknown[], headers: Record<string, string> = {}) {
  answer(/nc\.nuvamawealth\.com\/edelmw-eq\/eq\/tradebook\/v1\//, () => ({ status: 200, body: { data: { trade: rows } }, headers }));
}

/* ─────────────────────── the card's own request bodies (AST) ─────────────────────── */

const CARD_FILE = path.join(process.cwd(), "components/import/broker-connect.tsx");
let cardSf: ts.SourceFile | null = null;
function cardFn(name: string): ts.FunctionDeclaration {
  cardSf ??= ts.createSourceFile(CARD_FILE, fs.readFileSync(CARD_FILE, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else ts.forEachChild(n, visit);
  };
  visit(cardSf);
  if (!found) throw new Error(`broker-connect.tsx has no function ${name}`);
  return found;
}

type PostedKey = { key: string; guard: string; computed: ts.Expression | null; inner: string[] };
/** The keys of the object literal a card function hands to `post(...)`, each with the guard it rides under. */
function postedKeys(fnName: string): PostedKey[] {
  const fn = cardFn(fnName);
  let obj: ts.ObjectLiteralExpression | null = null;
  const find = (n: ts.Node) => {
    if (obj) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "post" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
      obj = n.arguments[0];
    } else ts.forEachChild(n, find);
  };
  find(fn);
  if (!obj) throw new Error(`${fnName}() posts no object literal`);
  const out: PostedKey[] = [];
  const unwrap = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
  const walk = (o: ts.ObjectLiteralExpression, guard: string) => {
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p)) {
        const inner = ts.isObjectLiteralExpression(p.initializer)
          ? p.initializer.properties.map((q) => (q.name && (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name)) ? q.name.text : "?"))
          : [];
        if (ts.isComputedPropertyName(p.name)) out.push({ key: "", guard, computed: p.name.expression, inner });
        else out.push({ key: (p.name as ts.Identifier).text, guard, computed: null, inner });
      } else if (ts.isShorthandPropertyAssignment(p)) {
        out.push({ key: p.name.text, guard, computed: null, inner: [] });
      } else if (ts.isSpreadAssignment(p)) {
        const e = unwrap(p.expression);
        if (ts.isConditionalExpression(e)) {
          const g = `${guard} && (${e.condition.getText()})`;
          const wt = unwrap(e.whenTrue);
          if (ts.isObjectLiteralExpression(wt)) walk(wt, g);
        }
      }
    }
  };
  walk(obj, "");
  return out;
}

/** Every `data.<name>` the card function reads. */
function dataReads(fnName: string): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "data") out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(cardFn(fnName));
  return out;
}

/** Build the body the card would send for `broker`, from the card's own keys and these values. */
function cardBody(fnName: "save" | "pull", broker: string, values: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of postedKeys(fnName)) {
    // Keep a guarded key only when its guard names this broker or names none.
    const brokersNamed = [...k.guard.matchAll(/active === "([a-z]+)"/g)].map((m) => m[1]);
    if (brokersNamed.length > 0 && !brokersNamed.includes(broker)) continue;
    let key = k.key;
    if (k.computed) {
      // The only computed key the card may use: loginPasteField(<brokerId>).
      if (!(ts.isCallExpression(k.computed) && ts.isIdentifier(k.computed.expression) && k.computed.expression.text === "loginPasteField")) {
        throw new Error(`unrecognised computed key in ${fnName}(): ${k.computed.getText()}`);
      }
      key = card.loginPasteField(broker);
    }
    if (!(key in values)) continue; // a value this scenario does not send (busy flags, picker, …)
    body[key] = values[key];
  }
  return body;
}


/** Save through the card's own save() keys. */
async function cardSave(broker: BrokerPullDisclosureId, fields: Record<string, unknown>, accountId?: number) {
  const pc = postedKeys("save").find((k) => k.key === "pullConsent");
  // the shape of the consent the card sends: { <inner keys>: the sheet's version }
  const consent = fields.consent === false ? undefined : Object.fromEntries((pc?.inner ?? []).map((k) => [k, BROKER_PULL_DISCLOSURES[broker].version]));
  return post(
    cardBody("save", broker, {
      action: "save",
      broker,
      apiKey: "",
      accessToken: "",
      ...fields,
      ...(consent ? { pullConsent: consent } : {}),
      ...(accountId ? { accountId } : {}),
    }),
  );
}
/** Pull through the card's own pull() keys (the login paste under loginPasteField's name). */
function cardPull(broker: string, mode: "preview" | "commit", opts: { paste?: string; accountId?: number; force?: boolean } = {}) {
  const values: Record<string, unknown> = { action: "pull", broker, mode, accountId: opts.accountId ?? PRIMARY };
  if (opts.force) values.force = true;
  if (opts.paste) values[card.loginPasteField(broker)] = opts.paste;
  return post(cardBody("pull", broker, values));
}

const FYERS_FIELDS = { apiKey: APP_ID, apiSecret: "fyers-app-secret" };
const KOTAK_FIELDS = { apiKey: "kotak-trade-api-token", mobileNumber: "9876543210", ucc: "xab12", mpin: "123456", totpSecret: SECRET };
const NUVAMA_FIELDS = { apiKey: NV_KEY, apiSecret: "nuvama-secret" };
const FY_PASTE = "https://127.0.0.1/?s=ok&code=200&auth_code=eyJhbGciOiJIUzI1.seam-code&state=abc";
const NV_PASTE = "https://127.0.0.1/?requestId=REQ-SEAM-0001";

/* ═══════════════════════════════ S1 — A → C → B1 ═══════════════════════════════ */

describe("S1 · A's real normalisers through C's real route into B1's real cross-source and the commit", () => {
  const FY_MONTHLY = "NSE:NIFTY26OCT25000CE";
  const OA_DATED = "OPT NIFTY 27 Oct 2026 25000 CE";

  function commitOpenAlgoFyers(day: string, qty = 75) {
    // The route's own OpenAlgo path (route.ts:1201-1202, fileName :1509, opts :1529-1536), minus the HTTP.
    const result = openalgo.normalizeOpenAlgoTrades(
      [{ action: "BUY", symbol: "NIFTY27OCT2625000CE", exchange: "NFO", product: "NRML", quantity: qty, average_price: 120.5, timestamp: "10:15:00" }],
      "fyers",
      day,
    );
    const fileName = `openalgo-fyers-${day}`;
    const parsed = openalgo.toParsedFile("fyers", result);
    commit.commitParsedFile(parsed, fileName, null, PRIMARY, { supersedeSnapshot: { fileName }, autoClose: true });
    expect(tradesOf(OA_DATED).map((r) => r.buy_qty)).toEqual([qty]);
  }

  async function savedFyers() {
    const s = await cardSave("fyers", FYERS_FIELDS);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
  }

  it("S1a — OpenAlgo-Fyers holds the dated name TODAY; the native compact monthly meets it by contract and SHARES a date → 409 needsForce (risky), nothing written", async () => {
    commitOpenAlgoFyers(TODAY);
    await savedFyers();
    fyersLogin();
    fyersBook([fyFill(FY_MONTHLY, 1, 75, 120.5)]);
    const r = await cardPull("fyers", "commit", { paste: FY_PASTE });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.needsForce).toBe(true);
    expect(r.json.collisions).toHaveLength(1);
    expect(r.json.collisions[0]).toMatchObject({ kind: "same-quantity", existing: { sourceFile: `openalgo-fyers-${TODAY}` } });
    expect(r.json.collisions[0].monthOnly).toBeUndefined();
    expect(tradesOf("NIFTY26OCT25000CE")).toHaveLength(0);
  });

  it("S1b — the same contract held from YESTERDAY (no shared date): month-only, informational — the pull commits, the card badges it 'same month'", async () => {
    commitOpenAlgoFyers(YESTERDAY);
    await savedFyers();
    fyersLogin();
    fyersBook([fyFill(FY_MONTHLY, 1, 75, 120.5)]);
    const pre = await cardPull("fyers", "preview", { paste: FY_PASTE });
    expect(pre.status, JSON.stringify(pre.json)).toBe(200);
    const cs = pre.json.preview.crossSource;
    expect(cs.risky).toBe(false);
    expect(cs.collisions[0]).toMatchObject({ kind: "same-quantity", monthOnly: true });
    expect(card.collisionBadge(cs.collisions[0].kind, cs.collisions[0].monthOnly)).toBe("same month (expiry day unstated)");
    const c = await cardPull("fyers", "commit"); // the day's cached token — no second paste
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(tradesOf("NIFTY26OCT25000CE").map((r) => [r.buy_qty, r.source_file])).toEqual([[75, `fyers-api-${TODAY}`]]);
    expect(hit(/validate-authcode$/)).toHaveLength(1);
  });

  it("S1c — a second same-day pull after a partial exit REPLACES the 11:00 snapshot (one row, 75 bought / 25 sold), never adds", async () => {
    await savedFyers();
    fyersLogin();
    fyersBook([fyFill(FY_MONTHLY, 1, 75, 120.5)]);
    expect((await cardPull("fyers", "commit", { paste: FY_PASTE })).status).toBe(200);
    expect(tradesOf("NIFTY26OCT25000CE").map((r) => [r.buy_qty, r.sell_qty])).toEqual([[75, 0]]);

    setClock(at(TODAY, "15:00"));
    fyersBook([fyFill(FY_MONTHLY, 1, 75, 120.5), fyFill(FY_MONTHLY, -1, 25, 131, "14:40:02")]);
    const second = await cardPull("fyers", "commit");
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(tradesOf("NIFTY26OCT25000CE").map((r) => [r.buy_qty, r.sell_qty])).toEqual([[75, 25]]);
  });

  it("S1d — a Nuvama pull's derivative meets the Nuvama P&L-report row BY TRADINGSYMBOL (no dedupLabel on the pull) → needsForce, same-quantity", async () => {
    const INST = "NIFTY-OPT-27Oct2026-CE-24500-NSE";
    const pre = (title: string) => [["Nuvama Wealth and Investment Limited"], [title], ["Period as on : 01-Oct-2026 to 07-Oct-2026"], ["Calculation Method : FIFO"]];
    const HEADER = ["", "Isin", "Instrument", "TxnDate", "TxnType", "Action", "Quantity", "Price", "Brok", "STax/GST on Brokerage", "STT", "Stamp Duty", "Sebi Fees", "Txn Charges", "Tax on Txn Charges", "Other Charges", "Cumulative Quantity", "Net Charges", "Delete Flag"];
    const detail = [
      ...pre("Detail Realised"),
      HEADER,
      ["", "Total", "", "", "", "", "", "", 40, 7.2, 4.13, 0.23, 0.02, 5.4, 0.97, 0, "", 57.95, ""],
      ["", "", INST, "07-Oct-26", "NSE", "Buy", 75, 100, 20, 3.6, 0, 0.23, 0.01, 2.6, 0.47, 0, 75, 26.91, "False"],
      ["", "", INST, "07-Oct-26", "NSE", "Sell", 75, 110, 20, 3.6, 4.13, 0, 0.01, 2.8, 0.5, 0, 0, 31.04, "False"],
      ["DISCLAIMER"],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Nuvama Wealth and Investment Limited"], ["Summary"]]), "Summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), "Detail Realised");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...pre("Unrealised Details"), HEADER, ["DISCLAIMER"]]), "Unrealised Details");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Dividend"]]), "Dividend");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Understanding the Report"]]), "Understanding the Report");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const file = "NUVAMA_PnL_Report_SEAM.xlsx";
    const parsed = nuvamaReport.parseNuvamaPnlReport(detect.buildContext(file, buf));
    commit.commitParsedFile(parsed, file, null, PRIMARY);
    const fileRows = tradesOf().filter((r) => r.broker === "nuvama");
    expect(fileRows.map((r) => [r.tradingsymbol, r.buy_qty, r.sell_qty])).toEqual([["OPT NIFTY 27 Oct 2026 24500 CE", 75, 75]]);

    expect((await cardSave("nuvama", NUVAMA_FIELDS)).status).toBe(200);
    nuvamaLoginAnswers();
    const fill = { sym: "NIFTY", exc: "NFO", opTyp: "CE", stkPrc: "24500.00", dpExpDt: "27Oct2026", prdCode: "NRML", trdSym: "NIFTY26OCT24500CE" };
    nuvamaBook([
      { ...fill, trsTyp: "B", fldQty: "75", flPrc: "100.00", flTim: "10:15:00" },
      { ...fill, trsTyp: "S", fldQty: "75", flPrc: "110.00", flTim: "11:15:00" },
    ]);
    const p = await cardPull("nuvama", "preview", { paste: NV_PASTE });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.preview.rows.map((r: { tradingsymbol: string; isDuplicate: boolean }) => [r.tradingsymbol, r.isDuplicate])).toEqual([
      [fileRows[0]!.tradingsymbol, false],
    ]);
    const c = await cardPull("nuvama", "commit");
    expect(c.status, JSON.stringify(c.json)).toBe(409);
    expect(c.json.needsForce).toBe(true);
    expect(c.json.collisions[0]).toMatchObject({ kind: "same-quantity", existing: { id: fileRows[0]!.id, sourceFile: file } });
    expect(c.json.collisions[0].monthOnly).toBeUndefined();
  });

  it("S1e — a Kotak equity `IDEA-EQ` fill is stored as IDEA (eq_delivery), and a Kotak future meets OpenAlgo-Kotak's exact hash (nothingNew)", async () => {
    expect((await cardSave("kotakneo", KOTAK_FIELDS)).status).toBe(200);
    kotakAnswers([
      { trdSym: "IDEA-EQ", exSeg: "nse_cm", trnsTp: "B", fldQty: 100, avgPrc: "9.39", flDt: "07-Oct-2026", flTm: "10:15:16", prod: "CNC" },
    ]);
    const c = await cardPull("kotakneo", "commit");
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(tradesOf().map((r) => [r.tradingsymbol, r.symbol, r.segment, r.buy_qty, r.account_id])).toEqual([["IDEA", "IDEA", "eq_delivery", 100, PRIMARY]]);

    // The future: OpenAlgo-Kotak first (route.ts:1201-1202 path), then the native pull of the same fill.
    const oa = openalgo.normalizeOpenAlgoTrades(
      [{ action: "BUY", symbol: "TCS27OCT26FUT", exchange: "NFO", product: "NRML", quantity: 175, average_price: 3100.5, timestamp: "10:20:00" }],
      "kotakneo",
      TODAY,
    );
    const oaFile = `openalgo-kotakneo-${TODAY}`;
    commit.commitParsedFile(openalgo.toParsedFile("kotakneo", oa), oaFile, null, PRIMARY, { supersedeSnapshot: { fileName: oaFile }, autoClose: true });
    kotakAnswers([
      { trdSym: "IDEA-EQ", exSeg: "nse_cm", trnsTp: "B", fldQty: 100, avgPrc: "9.39", flDt: "07-Oct-2026", flTm: "10:15:16", prod: "CNC" },
      { trdSym: "TCS26OCTFUT", sym: "TCS", exSeg: "nse_fo", optTp: "XX", expDt: "27 Oct, 2026", stkPrc: "0", trnsTp: "B", fldQty: 175, avgPrc: "3100.50", flTm: "10:20:01", prod: "NRML" },
    ]);
    const again = await cardPull("kotakneo", "commit");
    expect(again.status, JSON.stringify(again.json)).toBe(409);
    expect(again.json.nothingNew).toBe(true);
    expect(tradesOf("FUT TCS 27 Oct 2026")).toHaveLength(1);
  });

  it("S1f — a fill pull-symbols cannot name is REFUSED and counted through the route (never a trade)", async () => {
    expect((await cardSave("kotakneo", KOTAK_FIELDS)).status).toBe(200);
    kotakAnswers([
      { trdSym: "IDEA-EQ", exSeg: "nse_cm", trnsTp: "B", fldQty: 10, avgPrc: "9.40", flTm: "10:15:16", prod: "CNC" },
      { trdSym: "NIFTY26OCT25000CE", sym: "NIFTY", exSeg: "nse_fo", optTp: "CE", expDt: "the last Tuesday", stkPrc: "25000", trnsTp: "B", fldQty: 75, avgPrc: "120", prod: "NRML" },
    ]);
    const p = await cardPull("kotakneo", "preview");
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.preview.summary.total).toBe(1);
    expect(p.json.warnings.filter((w: string) => /^1 fill had no readable side, quantity, price or instrument/.test(w))).toHaveLength(1);
    expect(p.json.warnings.filter((w: string) => /^1 fill named no instrument/.test(w))).toHaveLength(1);
  });

  it("S1g — at 00:30 IST (19:00 UTC the day before) the route's IST day reaches A's normaliser: the fill is dated the IST day and filed under it", async () => {
    setClock(new Date(`${TODAY}T19:00:00.000Z`)); // = 2026-10-08 00:30 IST
    await savedFyers();
    fyersLogin();
    fyersBook([fyFill("NSE:SBIN-EQ", 1, 10, 800, "00:29:00", { productType: "CNC", orderDateTime: "08-Oct-2026 00:29:00" })]);
    const c = await cardPull("fyers", "commit", { paste: FY_PASTE });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(tradesOf("SBIN").map((r) => [r.buy_date, r.source_file])).toEqual([["2026-10-08", "fyers-api-2026-10-08"]]);
    // and the day token's end is the NEXT IST midnight, not the UTC one
    expect(authOf("fyers").tokenExpiresAt).toBe("2026-10-08T18:30:00.000Z");
  });
});

/* ═══════════════════════════════ S2 — card ↔ route ═══════════════════════════════ */

describe("S2 · the card's request keys and 409 reads against the real route", () => {
  it("S2a — the save() keys the card sends for each C6 broker are the ones packAuth + the consent check read (stamped, stored, complete)", async () => {
    for (const [b, fields] of [["fyers", FYERS_FIELDS], ["kotakneo", KOTAK_FIELDS], ["nuvama", NUVAMA_FIELDS]] as const) {
      const r = await cardSave(b, fields);
      expect(r.status, `${b}: ${JSON.stringify(r.json)}`).toBe(200);
      const a = authOf(b);
      expect(a.pullAckVersion, b).toBe(BROKER_PULL_DISCLOSURES[b].version);
      if (b === "kotakneo") expect(a).toMatchObject({ mobileNumber: "9876543210", ucc: "XAB12", mpin: "123456", totpSecret: SECRET });
      else expect(a.apiSecret, b).toBe((fields as { apiSecret: string }).apiSecret);
    }
  });

  it("S2b — the pull() paste lands under the name the route reads: Fyers exchanges the auth_code, Nuvama logs in with the request id", async () => {
    expect((await cardSave("fyers", FYERS_FIELDS)).status).toBe(200);
    expect((await cardSave("nuvama", NUVAMA_FIELDS)).status).toBe(200);
    fyersLogin();
    fyersBook([]);
    const f = await cardPull("fyers", "preview", { paste: FY_PASTE });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(hit(/validate-authcode$/).map((c) => (c.body as { code: string }).code)).toEqual(["eyJhbGciOiJIUzI1.seam-code"]);
    nuvamaLoginAnswers();
    nuvamaBook([]);
    const n = await cardPull("nuvama", "preview", { paste: NV_PASTE });
    expect(n.status, JSON.stringify(n.json)).toBe(200);
    expect(hit(/logindata\/$/).map((c) => (c.body as { reqId: string }).reqId)).toEqual(["REQ-SEAM-0001"]);
  });

  it("S2c — every C6 409 the route answers carries a key the card branches on (or the message its fallback shows)", async () => {
    const pullReads = dataReads("pull");
    const saveReads = dataReads("save");
    const failReads = dataReads("fail");
    // 1. save without consent → needsConsent (save() re-reads GET on it)
    const s = await cardSave("fyers", { ...FYERS_FIELDS, consent: false });
    expect(s.status).toBe(409);
    expect(s.json).toMatchObject({ needsConsent: true, version: BROKER_PULL_DISCLOSURES.fyers.version });
    expect(saveReads.has("needsConsent")).toBe(true);
    // 2. Fyers with no cached token → needsAuthCode + loginUrl (the dialog opens on both)
    expect((await cardSave("fyers", FYERS_FIELDS)).status).toBe(200);
    const f = await cardPull("fyers", "preview");
    expect(f.status).toBe(409);
    expect(f.json.needsAuthCode).toBe(true);
    expect(new URL(f.json.loginUrl).host).toBe("api-t1.fyers.in");
    expect(new URL(f.json.loginUrl).searchParams.get("client_id")).toBe(APP_ID);
    for (const k of ["needsAuthCode", "loginUrl"]) expect(pullReads.has(k), k).toBe(true);
    // 3. Nuvama with no session → needsLogin + loginUrl
    expect((await cardSave("nuvama", NUVAMA_FIELDS)).status).toBe(200);
    const n = await cardPull("nuvama", "preview");
    expect(n.status).toBe(409);
    expect(n.json.needsLogin).toBe(true);
    expect(new URL(n.json.loginUrl).searchParams.get("api_key")).toBe(NV_KEY);
    for (const k of ["needsLogin", "loginUrl"]) expect(pullReads.has(k), k).toBe(true);
    // 4. a stale ack at pull → needsConsent (pull() re-reads GET on it)
    t.sqlite.prepare("UPDATE broker_connections SET auth_json = ? WHERE broker = 'nuvama'").run(vault.encryptSecret(JSON.stringify({ apiSecret: "s", pullAckVersion: 0 })));
    const st = await cardPull("nuvama", "preview", { paste: NV_PASTE });
    expect(st.status).toBe(409);
    expect(st.json.needsConsent).toBe(true);
    expect(pullReads.has("needsConsent")).toBe(true);
    // 5. Kotak session end → needsLogin with NO link: the card's fallback shows the message
    expect((await cardSave("kotakneo", KOTAK_FIELDS)).status).toBe(200);
    kotakAnswers([]);
    answer(/cis\.kotaksecurities\.com\/quick\/user\/trades$/, () => ({ status: 200, body: { stat: "Not_Ok", stCode: 1003, emsg: "Invalid session" } }));
    const k = await cardPull("kotakneo", "preview");
    expect(k.status).toBe(409);
    expect(k.json).toMatchObject({ needsLogin: true });
    expect(k.json.loginUrl).toBeUndefined();
    expect(typeof k.json.message).toBe("string");
    expect(failReads.has("message")).toBe(true);
    // every needs* flag the route used is one the card's pull() reads
    for (const body of [f.json, n.json, st.json, k.json]) {
      const flags = Object.keys(body).filter((x) => /^needs/.test(x) && body[x] === true);
      expect(flags.length).toBe(1);
      expect(pullReads.has(flags[0]!), flags[0]).toBe(true);
    }
  });
});

/* ═══════════════════════════════ S3 — consent ═══════════════════════════════ */

describe("S3 · consent — one stamp, four readers (route pull, GET → card, auto-pull)", () => {
  it.each([
    ["current (number)", BROKER_PULL_DISCLOSURES.kotakneo.version],
    ["older", 0],
    ["newer than shipped", BROKER_PULL_DISCLOSURES.kotakneo.version + 1],
    ["string", String(BROKER_PULL_DISCLOSURES.kotakneo.version)],
    ["absent", undefined],
  ])("S3a — stored ack %s: GET.pullAckCurrent, the card's sheet, autoPullEligibility and the pull route agree", async (_label, v) => {
    const blob: Record<string, unknown> = { mobileNumber: "9876543210", ucc: "XAB12", mpin: "123456", totpSecret: SECRET };
    if (v !== undefined) blob.pullAckVersion = v;
    seedConn("kotakneo", "kotak-trade-api-token", blob);
    const current = pullAckCurrent("kotakneo", v);
    const row = (await getRows()).find((r) => r.broker === "kotakneo")!;
    expect(row.pullAckCurrent).toBe(current);
    // card (mirrored line :981): consentShowing = pullSheet != null && saveTargetConn?.pullAckCurrent !== true
    const consentShowing = row.pullAckCurrent !== true;
    const blocked = card.pullSaveBlocked({ active: "kotakneo", hasSavedRow: true, consentShowing, consentAccepted: false, apiSecret: "", mobileNumber: "", ucc: "", mpin: "", totpSecret: "" });
    expect(blocked).toBe(!current);
    expect(autoPull.autoPullEligibility("kotakneo", blob).eligible).toBe(current);
    answer(/mis\.kotaksecurities\.com\/login\/1\.0\/tradeApiLogin$/, () => ({ status: 401, body: { message: "seam stop" } }));
    const p = await cardPull("kotakneo", "preview");
    if (current) {
      expect(p.status).toBe(502);
      expect(hit(/tradeApiLogin$/)).toHaveLength(1);
    } else {
      expect(p.status).toBe(409);
      expect(p.json.needsConsent).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });

  it("S3b — the version the card renders from BROKER_PULL_DISCLOSURES stamps; GET then hides the sheet; a later save without consent keeps the ack", async () => {
    expect((await getRows()).some((r) => r.broker === "fyers")).toBe(false);
    expect((await cardSave("fyers", FYERS_FIELDS)).status).toBe(200);
    let row = (await getRows()).find((r) => r.broker === "fyers")!;
    expect(row.pullAckCurrent).toBe(true);
    expect(card.pullSaveBlocked({ active: "fyers", hasSavedRow: true, consentShowing: row.pullAckCurrent !== true, consentAccepted: false, apiSecret: "", mobileNumber: "", ucc: "", mpin: "", totpSecret: "" })).toBe(false);
    // the re-save the card sends when the sheet is hidden carries no pullConsent
    const r = await cardSave("fyers", { apiSecret: "rotated", consent: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    row = (await getRows()).find((x) => x.broker === "fyers")!;
    expect(row.pullAckCurrent).toBe(true);
    expect(authOf("fyers")).toMatchObject({ apiSecret: "rotated", pullAckVersion: BROKER_PULL_DISCLOSURES.fyers.version });
  });

  it("S3c — auto-pull (Kotak, with trades) commits to the CONNECTION's account while the view is another account; a manual pull later supersedes it", async () => {
    expect((await cardSave("kotakneo", KOTAK_FIELDS)).status).toBe(200);
    t.db.update(t.schema.settings).set({ selectedAccountId: SECOND, autoPullEnabled: true, lastAutoPullDate: null }).run();
    kotakAnswers([{ trdSym: "IDEA-EQ", exSeg: "nse_cm", trnsTp: "B", fldQty: 100, avgPrc: "9.39", flTm: "09:20:00", prod: "CNC" }]);
    const out = await autoPull.runAutoPull(at(TODAY, "09:30"));
    expect(out.summary.map((e) => [e.broker, e.status, e.accountId])).toEqual([["kotakneo", "imported", PRIMARY]]);
    expect(tradesOf("IDEA").map((r) => [r.account_id, r.buy_qty, r.source_file])).toEqual([[PRIMARY, 100, `kotakneo-api-${TODAY}`]]);
    expect(hit(/tradeApiLogin$/).map((c) => (c.body as { ucc: string }).ucc)).toEqual(["XAB12"]);

    // S3d: the manual pull at 15:00 from the OTHER view, sending the row's own account (the card's default)
    setClock(at(TODAY, "15:00"));
    kotakAnswers([
      { trdSym: "IDEA-EQ", exSeg: "nse_cm", trnsTp: "B", fldQty: 100, avgPrc: "9.39", flTm: "09:20:00", prod: "CNC" },
      { trdSym: "IDEA-EQ", exSeg: "nse_cm", trnsTp: "B", fldQty: 50, avgPrc: "9.45", flTm: "14:20:00", prod: "CNC" },
    ]);
    const c = await cardPull("kotakneo", "commit", { accountId: PRIMARY });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(tradesOf("IDEA").map((r) => [r.account_id, r.buy_qty])).toEqual([[PRIMARY, 150]]);
  });
});

/* ═══════════════════════════════ S4 — mergeAuth sequences ═══════════════════════════════ */

describe("S4 · mergeAuth across save → pull stamp → re-save → pull", () => {
  it("S4a — Fyers: identity + current ack survive every writer; the cached token clears on re-save and on BrokerAuthExpired", async () => {
    expect((await cardSave("fyers", FYERS_FIELDS)).status).toBe(200);
    fyersLogin();
    fyersBook([]);
    expect((await cardPull("fyers", "preview", { paste: FY_PASTE })).status).toBe(200);
    expect(authOf("fyers")).toMatchObject({ fyId: FY_ID, pullAckVersion: 1, apiSecret: "fyers-app-secret" });
    expect(plain(conn("fyers")!.access_token)).toBe("FY-TOKEN-1");
    expect((await getRows()).find((r) => r.broker === "fyers")!.tokenExpiresAt).toBe(authOf("fyers").tokenExpiresAt);

    // re-save: secret only (the card's empty fields keep the stored ones)
    expect((await cardSave("fyers", { apiSecret: "fyers-secret-2", consent: false })).status).toBe(200);
    expect(authOf("fyers")).toEqual({ apiSecret: "fyers-secret-2", fyId: FY_ID, pullAckVersion: 1 });
    expect(plain(conn("fyers")!.access_token)).toBe("");
    const ask = await cardPull("fyers", "preview");
    expect([ask.status, ask.json.needsAuthCode]).toEqual([409, true]);

    // a fresh login, then Fyers states the token is dead mid-day
    calls = [];
    fyersLogin(FY_ID, "FY-TOKEN-2");
    expect((await cardPull("fyers", "preview", { paste: FY_PASTE })).status).toBe(200);
    expect(plain(conn("fyers")!.access_token)).toBe("FY-TOKEN-2");
    fyersBook(() => ({ status: 200, body: { s: "error", code: -16, message: "Could not authenticate the user" } }));
    const dead = await cardPull("fyers", "preview");
    expect(dead.status).toBe(409);
    expect(dead.json.needsAuthCode).toBe(true);
    expect(new URL(dead.json.loginUrl).host).toBe("api-t1.fyers.in");
    expect(plain(conn("fyers")!.access_token)).toBe("");
    expect(authOf("fyers")).toEqual({ apiSecret: "fyers-secret-2", fyId: FY_ID, pullAckVersion: 1 });
    expect((await getRows()).find((r) => r.broker === "fyers")!.tokenExpiresAt).toBeNull();
  });

  it("S4b — Nuvama: 222 on logindata (an expired request id) is needsLogin, never a 502, and caches nothing", async () => {
    expect((await cardSave("nuvama", NUVAMA_FIELDS)).status).toBe(200);
    answer(/loginvendor\//, () => ({ status: 200, body: { msg: "VENDOR-SESSION" } }));
    answer(/logindata\/$/, () => ({ status: 222, body: { msg: "request id expired" } }));
    const r = await cardPull("nuvama", "preview", { paste: NV_PASTE });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ needsLogin: true });
    expect(new URL(r.json.loginUrl).searchParams.get("api_key")).toBe(NV_KEY);
    expect(plain(conn("nuvama")!.access_token)).toBe("");
    expect(authOf("nuvama").nuvamaUserId).toBeUndefined();
  });

  it("S4c — Nuvama: the AppIdKey A's fetch takes from a response is persisted by C and sent on the next pull of the session; EGN0011 then clears the session", async () => {
    expect((await cardSave("nuvama", NUVAMA_FIELDS)).status).toBe(200);
    nuvamaLoginAnswers();
    nuvamaBook([], { AppIdKey: "APPKEY-FROM-NUVAMA" });
    expect((await cardPull("nuvama", "preview", { paste: NV_PASTE })).status).toBe(200);
    expect(hit(/tradebook\/v1\//)[0]!.headers.appidkey).toBeUndefined();
    expect(JSON.parse(plain(conn("nuvama")!.access_token)).appIdKey).toBe("APPKEY-FROM-NUVAMA");
    expect(authOf("nuvama")).toMatchObject({ nuvamaUserId: NV_USER, pullAckVersion: 1 });

    calls = [];
    nuvamaBook([]);
    expect((await cardPull("nuvama", "preview")).status).toBe(200);
    expect(hit(/loginvendor\//)).toHaveLength(0);
    expect(hit(/tradebook\/v1\//).map((c) => c.headers.appidkey)).toEqual(["APPKEY-FROM-NUVAMA"]);

    answer(/tradebook\/v1\//, () => ({ status: 200, body: { error: { errCd: "EGN0011", errMsg: "Session Expired" } } }));
    const dead = await cardPull("nuvama", "preview");
    expect([dead.status, dead.json.needsLogin]).toEqual([409, true]);
    expect(plain(conn("nuvama")!.access_token)).toBe("");
    expect(authOf("nuvama")).toEqual({ apiSecret: "nuvama-secret", nuvamaUserId: NV_USER, pullAckVersion: 1 });
  });
});

/* ═══════════════════════════════ S5 — identity ═══════════════════════════════ */

describe("S5 · identity — what the route stamps is what broker-identity reads", () => {
  it("S5a — after a real login each broker's connectionIdentity is the id the route stamped (Fyers fy_id, Nuvama userID, Kotak UCC upper-cased)", async () => {
    expect((await cardSave("fyers", FYERS_FIELDS)).status).toBe(200);
    expect((await cardSave("nuvama", NUVAMA_FIELDS)).status).toBe(200);
    expect((await cardSave("kotakneo", KOTAK_FIELDS)).status).toBe(200);
    fyersLogin();
    fyersBook([]);
    nuvamaLoginAnswers();
    nuvamaBook([]);
    expect((await cardPull("fyers", "preview", { paste: FY_PASTE })).status).toBe(200);
    expect((await cardPull("nuvama", "preview", { paste: NV_PASTE })).status).toBe(200);
    const idOf = (b: string) => {
      const r = conn(b)!;
      return identity.connectionIdentity({ broker: b, apiKey: r.api_key, authJson: r.auth_json });
    };
    expect(idOf("fyers")).toEqual({ kind: "id", value: FY_ID });
    expect(idOf("nuvama")).toEqual({ kind: "id", value: NV_USER });
    expect(idOf("kotakneo")).toEqual({ kind: "id", value: "XAB12" });
  });

  it("S5b — Fyers: one client in two accounts (different App IDs) is refused at the second account's login BEFORE its token is cached or a trade is read", async () => {
    expect((await cardSave("fyers", FYERS_FIELDS)).status).toBe(200);
    fyersLogin();
    fyersBook([]);
    expect((await cardPull("fyers", "preview", { paste: FY_PASTE })).status).toBe(200);
    expect((await cardSave("fyers", { apiKey: "OTHERAPP-100", apiSecret: "other-secret" }, SECOND)).status).toBe(200);
    calls = [];
    const r = await cardPull("fyers", "preview", { paste: FY_PASTE, accountId: SECOND });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.message).toMatch(/already connected in account "/);
    expect(hit(/tradebook$/)).toHaveLength(0);
    expect(plain(conn("fyers", SECOND)!.access_token)).toBe("");
    expect(authOf("fyers", SECOND).fyId).toBeUndefined();
    expect(authOf("fyers", SECOND).tokenExpiresAt).toBeUndefined();
  });

  it("S5c — Fyers: a login for a different client than the stamped one is fyersUserMismatch, nothing cached or read", async () => {
    seedConn("fyers", APP_ID, { apiSecret: "s", fyId: FY_ID, pullAckVersion: 1 });
    fyersLogin("ZZ99999");
    const r = await cardPull("fyers", "preview", { paste: FY_PASTE });
    expect([r.status, r.json.fyersUserMismatch]).toEqual([409, true]);
    expect(hit(/tradebook$/)).toHaveLength(0);
    expect(plain(conn("fyers")!.access_token)).toBe("");
  });

  it("S5e — the OTHER ordering (the newer connection logs in first): neither pull-time check refuses (P10's onlyOlderThan), so the route's two stamps must reach Data Quality as one client in two accounts", async () => {
    // account SECOND's connection is saved FIRST (smaller id) but pulls LAST
    expect((await cardSave("fyers", { apiKey: "OTHERAPP-100", apiSecret: "other-secret" }, SECOND)).status).toBe(200);
    expect((await cardSave("fyers", FYERS_FIELDS)).status).toBe(200);
    fyersLogin();
    fyersBook([]);
    expect((await cardPull("fyers", "preview", { paste: FY_PASTE })).status).toBe(200);
    const late = await cardPull("fyers", "preview", { paste: FY_PASTE, accountId: SECOND });
    expect(late.status, JSON.stringify(late.json)).toBe(200);
    expect([authOf("fyers").fyId, authOf("fyers", SECOND).fyId]).toEqual([FY_ID, FY_ID]);
    const dup = identity.listDuplicateConnections().filter((g) => g.broker === "fyers");
    expect(dup.map((g) => [g.maskedIdentity, g.accounts.map((a) => a.id)])).toEqual([[identity.maskAccountId(FY_ID), [PRIMARY, SECOND]]]);
  });

  it("S5d — Kotak: the same UCC typed in another case on another account is refused at SAVE (both sides upper-case the UCC)", async () => {
    expect((await cardSave("kotakneo", KOTAK_FIELDS)).status).toBe(200);
    const r = await cardSave("kotakneo", { ...KOTAK_FIELDS, apiKey: "another-token", ucc: "XaB12" }, SECOND);
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.message).toMatch(/already connected in account "/);
    expect(conn("kotakneo", SECOND)).toBeUndefined();
  });
});

/* ═══════════════════════════════ S6 — B1 ↔ A ═══════════════════════════════ */

describe("S6 · every tradingsymbol A emits classifies to the contract the other sources name", () => {
  const cls = (ts_: string) => {
    const c = classifyMod.classify({ tradingsymbol: ts_, productHint: null, exchangeHint: null });
    return { segment: c.segment, symbol: c.symbol, strike: c.strike, optionType: c.optionType, expiry: c.expiry };
  };
  const sameContract = (a: string, b: string) => {
    const x = cls(a), y = cls(b);
    expect({ ...x, expiry: null }, `${a} vs ${b}`).toEqual({ ...y, expiry: null });
    expect(x.expiry === null || y.expiry === null || x.expiry === y.expiry, `${a} vs ${b} expiry`).toBe(true);
    const ka = symbols.contractKeyOf(a)!, kb = symbols.contractKeyOf(b)!;
    expect(ka.key, `${a} vs ${b} key`).toBe(kb.key);
    expect(symbols.sameContractDay(ka.day, kb.day)).toBe(true);
  };
  const fyOne = (symbol: string) => {
    const n = fyers.normalizeFyersTrades([fyFill(symbol, 1, 1, 10)], TODAY);
    expect(n.refused, symbol).toBe(0);
    return n.trades[0]!.tradingsymbol;
  };
  const oa = (symbol: string, exchange: string) => openalgo.canonicalOpenAlgoSymbol(symbol, exchange) ?? symbol;

  it.each([
    ["NSE:NIFTY26OCT25000CE", "NIFTY27OCT2625000CE", "NFO"],
    ["NSE:NIFTY26O0625000CE", "NIFTY06OCT2625000CE", "NFO"],
    ["NSE:NIFTY26OCTFUT", "NIFTY27OCT26FUT", "NFO"],
    ["BSE:SENSEX2681377500PE", "SENSEX13AUG2677500PE", "BFO"],
    ["MCX:CRUDEOIL26OCTFUT", "CRUDEOIL19OCT26FUT", "MCX"],
    ["NSE:SBIN-EQ", "SBIN", "NSE"],
  ])("S6a — Fyers %s (A → B1) is the contract OpenAlgo-Fyers names as %s", (fy, oaSym, ex) => {
    sameContract(fyOne(fy), oa(oaSym, ex));
  });

  it("S6b — Kotak derivative names (A → B1) are BYTE-EQUAL to OpenAlgo-Kotak's canonical names", () => {
    const n = kotak.normalizeKotakTrades(
      [
        { trdSym: "TCS26OCTFUT", sym: "TCS", exSeg: "nse_fo", optTp: "XX", expDt: "27 Oct, 2026", trnsTp: "B", fldQty: 1, avgPrc: "1" },
        { trdSym: "NIFTY26OCT25000CE", sym: "NIFTY", exSeg: "nse_fo", optTp: "CE", expDt: "27-Oct-2026", stkPrc: "25000.00", trnsTp: "B", fldQty: 1, avgPrc: "1" },
        { trdSym: "SENSEX2681377500PE", sym: "SENSEX", exSeg: "bse_fo", optTp: "PE", expDt: "13 Aug 2026", stkPrc: "77500", trnsTp: "B", fldQty: 1, avgPrc: "1" },
        { trdSym: "IDEA-EQ", exSeg: "nse_cm", trnsTp: "B", fldQty: 1, avgPrc: "1" },
      ],
      TODAY,
    );
    expect(n.refused).toBe(0);
    expect(n.trades.map((x) => x.tradingsymbol)).toEqual([
      oa("TCS27OCT26FUT", "NFO"),
      oa("NIFTY27OCT2625000CE", "NFO"),
      oa("SENSEX13AUG2677500PE", "BFO"),
      "IDEA",
    ]);
  });

  it("S6c — Nuvama names (A → B1) are BYTE-EQUAL to the P&L report's `nuvamaInstrument` for the same contract", () => {
    const n = nuvama.normalizeNuvamaTrades(
      [
        { trdSym: "NIFTY26OCT24500CE", sym: "NIFTY", exc: "NFO", opTyp: "CE", stkPrc: "24500.00", dpExpDt: "27Oct2026", trsTyp: "B", fldQty: "1", flPrc: "1" },
        { trdSym: "BANKNIFTY26OCTFUT", sym: "26009_NSE", exc: "NFO", opTyp: "FUT", dpExpDt: "27-Oct-2026", trsTyp: "B", fldQty: "1", flPrc: "1" },
        { trdSym: "NIFTY-OPT-27Oct2026-PE-187.5-NSE", trsTyp: "B", fldQty: "1", flPrc: "1" },
        { trdSym: "SBIN-EQ", exc: "NSE", trsTyp: "B", fldQty: "1", flPrc: "1" },
      ],
      TODAY,
    );
    expect(n.refused).toBe(0);
    expect(n.trades.map((x) => x.tradingsymbol)).toEqual([
      nuvamaReport.nuvamaInstrument("NIFTY-OPT-27Oct2026-CE-24500-NSE", "")!.tradingsymbol,
      nuvamaReport.nuvamaInstrument("BANKNIFTY-FUT-27Oct2026-NSE", "")!.tradingsymbol,
      nuvamaReport.nuvamaInstrument("NIFTY-OPT-27Oct2026-PE-187.5-NSE", "")!.tradingsymbol,
      "SBIN",
    ]);
  });

  it("S6d — a null from pull-symbols is a REFUSED row in every normaliser (counted, never a trade)", () => {
    const f = fyers.normalizeFyersTrades([fyFill("NSE:NIFTY 26 OCT", 1, 1, 10)], TODAY);
    const k = kotak.normalizeKotakTrades([{ trdSym: "X", sym: "NIFTY", exSeg: "nse_fo", optTp: "CE", expDt: "27 Oct 2026", stkPrc: "abc", trnsTp: "B", fldQty: 1, avgPrc: "1" }], TODAY);
    const n = nuvama.normalizeNuvamaTrades([{ trdSym: "NIFTY26OCT24500CE", sym: "NIFTY", exc: "NFO", opTyp: "CE", stkPrc: "24500", dpExpDt: "27/10/2026", trsTyp: "B", fldQty: "1", flPrc: "1" }], TODAY);
    for (const [name, out] of [["fyers", f], ["kotak", k], ["nuvama", n]] as const) {
      expect([out.trades.length, out.refused], name).toEqual([0, 1]);
    }
    expect(symbols.fyersTradingsymbol("NSE:NIFTY 26 OCT")).toBeNull();
  });
});

/* ═══════════════════════════════ S7 — the gap line ═══════════════════════════════ */

describe("S7 · `ranged` — the card's gap line vs what each route pull reads", () => {
  it("S7a — the card says 'fetches the gap' ONLY for the broker whose GET carries a catch-up window (Dhan); the today-only six say import the file", async () => {
    const stale = new Date(`${TODAY}T05:00:00.000Z`).getTime() - 7 * 86_400_000;
    const lastPullAt = new Date(stale).toISOString();
    for (const b of ["dhan", "angelone", "upstox"]) seedConn(b, `${b}-key`, null, { lastPullAt });
    seedConn("fyers", APP_ID, { apiSecret: "s", pullAckVersion: 1 }, { lastPullAt });
    seedConn("kotakneo", "tok", { ucc: "XAB12", mobileNumber: "9876543210", mpin: "123456", totpSecret: SECRET, pullAckVersion: 1 }, { lastPullAt });
    seedConn("nuvama", NV_KEY, { apiSecret: "s", pullAckVersion: 1 }, { lastPullAt });
    const rows = await getRows();
    const now = at(TODAY, "11:00");
    for (const r of rows) {
      const ranged = card.PULL_GAP_RANGED[r.broker as keyof typeof card.PULL_GAP_RANGED];
      expect(ranged, r.broker).not.toBeUndefined();
      // the route reads a RANGE only where it exposes the next pull's window
      expect(ranged, r.broker).toBe(typeof r.catchUpFrom === "string");
      const [line] = card.pullGapLines([{ ...(r as { accountId: number; lastPullAt: string }), ranged }], false, now);
      expect(line, r.broker).toMatch(/^Pulls missed since 30 Sep 2026 — /);
      expect(line!.endsWith("this broker states today's trades only; import its file for the days between."), r.broker).toBe(!ranged);
    }
    expect(rows.map((r) => r.broker).sort()).toEqual(["angelone", "dhan", "fyers", "kotakneo", "nuvama", "upstox"]);
  });

  it("S7b — a real Fyers commit at 00:30 IST stamps lastPullAt; a week later GET → the card names that IST day with the today-only tail", async () => {
    setClock(new Date(`${TODAY}T19:00:00.000Z`)); // 2026-10-08 00:30 IST
    expect((await cardSave("fyers", FYERS_FIELDS)).status).toBe(200);
    fyersLogin();
    fyersBook([fyFill("NSE:SBIN-EQ", 1, 10, 800, "00:29:00", { productType: "CNC" })]);
    expect((await cardPull("fyers", "commit", { paste: FY_PASTE })).status).toBe(200);
    setClock(at("2026-10-15", "11:00"));
    const row = (await getRows()).find((r) => r.broker === "fyers")!;
    expect(row.lastPullAt).toBe(`${TODAY}T19:00:00.000Z`);
    const lines = card.pullGapLines([{ ...(row as { accountId: number; lastPullAt: string }), ranged: card.PULL_GAP_RANGED.fyers }], false, at("2026-10-15", "11:00"));
    expect(lines).toEqual(["Pulls missed since 08 Oct 2026 — this broker states today's trades only; import its file for the days between."]);
  });
});

/* ═══════════════════════════════ recorded defects ═══════════════════════════════ */

describe("recorded seam defects", () => {
  /**
   * D-C6-1 — GET's `unverified` (route.ts:537, read from UNVERIFIED_PULL_BROKERS by the orchestrator) has
   * NO consumer: the card's badge keys on the TAB (`{pullSheet && <Badge>}`, broker-connect.tsx:1348) and its
   * intro copy hard-codes "(the last three documented, not yet verified …)" (:1308). When the owner records a
   * live pull and removes a broker from UNVERIFIED_PULL_BROKERS — "the patch that records the owner's first live
   * pull" (broker-pull-disclosure.ts:38-42) — GET answers unverified:false and the card STILL badges it
   * "documented, not yet verified with a real account". Wrong: badge shown for a verified broker. Right: the
   * badge renders from the connection's `unverified` (or from UNVERIFIED_PULL_BROKERS itself).
   */
  it("D-C6-1 —the card reads the GET row's `unverified` flag that UNVERIFIED_PULL_BROKERS drives", async () => {
    seedConn("fyers", APP_ID, { apiSecret: "s", pullAckVersion: 1 });
    const row = (await getRows()).find((r) => r.broker === "fyers")!;
    expect(row.unverified).toBe(true); // the producer half works
    // the consumer half: any read of `.unverified` anywhere in the card
    const reads = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAccessExpression(n)) reads.add(n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(cardFn("BrokerConnect"));
    expect(reads.has("unverified")).toBe(true);
  });

  /**
   * D-C6-2 — ONE currency future, three answers. B1 refuses Kotak's `cde_fo` on purpose
   * (pull-symbols.ts:175-179: "Vyuha has no currency segment vocabulary … a currency option named
   * OPT USDINR … would be priced as a stock option. Such a row is refused"), but its Nuvama branch
   * lists CDS and BCD as derivative exchanges (pull-symbols.ts:245) and A's Fyers normaliser never
   * reads segment 12 (fyers.ts:268-273). So `USDINR` currency futures pulled from Nuvama are named
   * `FUT USDINR 28 Oct 2026` and from Fyers `USDINR26OCTFUT`, and the classifier files both as an
   * equity `future` on NSE — charged equity-F&O STT/stamp on a currency contract (a CDS trade pays
   * no STT). Wrong: a priced `future` row. Right: refused and counted, as Kotak does (minimal fix:
   * drop CDS/BCD from NUVAMA_DERIVATIVE_EXCHANGES and return null for them; refuse a Fyers row whose
   * `segment` is 12).
   */
  it("D-C6-2a —a Nuvama CDS currency future is refused through the route, as Kotak's cde_fo is", async () => {
    expect((await cardSave("nuvama", NUVAMA_FIELDS)).status).toBe(200);
    nuvamaLoginAnswers();
    nuvamaBook([{ trdSym: "USDINR26OCTFUT", sym: "USDINR", exc: "CDS", opTyp: "FUT", dpExpDt: "28Oct2026", trsTyp: "B", fldQty: "1000", flPrc: "88.10", prdCode: "NRML", flTim: "10:00:00" }]);
    const p = await cardPull("nuvama", "preview", { paste: NV_PASTE });
    expect(p.status).toBe(200);
    // actual: [["FUT USDINR 28 Oct 2026", "future", <chargesTotal incl. STT>]]
    expect(p.json.preview.rows.map((r: { tradingsymbol: string; segment: string }) => [r.tradingsymbol, r.segment])).toEqual([]);
  });

  it("D-C6-2b —a Fyers segment-12 currency future is refused, as Kotak's cde_fo is", () => {
    const k = kotak.normalizeKotakTrades([{ trdSym: "USDINR26OCTFUT", sym: "USDINR", exSeg: "cde_fo", optTp: "XX", expDt: "28 Oct, 2026", trnsTp: "B", fldQty: 1000, avgPrc: "88.1" }], TODAY);
    expect([k.trades.length, k.refused]).toEqual([0, 1]); // the producer B1 chose for Kotak
    const f = fyers.normalizeFyersTrades(
      [{ symbol: "NSE:USDINR26OCTFUT", side: 1, tradedQty: 1000, tradePrice: 88.1, productType: "MARGIN", exchange: 10, segment: 12, orderDateTime: "07-Oct-2026 10:00:00", exchangeOrderNo: "1" }],
      TODAY,
    );
    // actual: [1 trade "USDINR26OCTFUT", classified segment "future", refused 0]
    expect([f.trades.map((x) => classifyMod.classify({ tradingsymbol: x.tradingsymbol, exchangeHint: x.exchangeHint }).segment), f.refused]).toEqual([[], 1]);
  });
});
