import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ftsMatch, ftsTokens, tokenise, TRIGRAM_MIN } from "@/lib/domain/search-rank";
import { RESULT_CAP, SOURCES, type SearchResult, type SourceKey } from "@/lib/domain/search-scope";
import {
  EMPTY_SESSION,
  framesFor,
  popSession,
  pushSession,
  shortTokens,
  tradesUnsearchable,
  visibleResults,
  type SearchFrame,
} from "@/components/system/use-search-session";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * v3.8.0 fix wave — the search surface (palette, ranker, route, results list).
 *
 * Each block names the defect it exists to keep fixed; every one of them was
 * reproduced before it was repaired.
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

// ───────────────────────────────────────────────────────────────────────────
// MUST-FIX 1 — the palette outlives an account switch
// ───────────────────────────────────────────────────────────────────────────

const hit = (source: SourceKey, id: number | string): SearchResult => ({
  source,
  id,
  title: `${source} ${id}`,
  href: `/${source}/${id}`,
  locked: false,
});

const frame = (q: string, results: SearchResult[] = []): SearchFrame => ({ q, cats: [], results });

describe("the search session belongs to ONE account", () => {
  it("a frame captured under account A is not restorable under account B", () => {
    const a = pushSession(EMPTY_SESSION, 1, frame("kou", [hit("trades", 11)]));
    expect(framesFor(a, 1)).toHaveLength(1);
    expect(a.frames[0].account, "the frame is stamped with the account it was captured under").toBe(1);

    // The switch: same mounted palette, different selected account.
    expect(framesFor(a, 2), "account 2 can see account 1's frames").toEqual([]);
    const popped = popSession(a, 2);
    expect(popped.frame, "account 1's trade rows came back under account 2").toBeNull();
    expect(popped.session.frames).toEqual([]);
  });

  it("pushing under a new account discards the previous account's stack", () => {
    let s = pushSession(EMPTY_SESSION, 1, frame("kou"));
    s = pushSession(s, 1, frame("infy"));
    expect(s.frames).toHaveLength(2);
    s = pushSession(s, 2, frame("tcs"));
    expect(s.frames.map((f) => f.q)).toEqual(["tcs"]);
    expect(s.account).toBe(2);
  });

  it("within one account the stack still works exactly as before", () => {
    const s = pushSession(EMPTY_SESSION, 3, frame("kou", [hit("trades", 7)]));
    const { frame: back, session } = popSession(s, 3);
    expect(back?.q).toBe("kou");
    expect(back?.results.map((r) => r.id)).toEqual([7]);
    expect(session.frames).toEqual([]);
    expect(popSession(session, 3).frame).toBeNull();
  });
});

describe("the palette is remounted and re-keyed on the selected account (source)", () => {
  it("the layout keys CommandPalette on the selected account and passes it down", () => {
    const src = read("app/layout.tsx");
    expect(src, "the palette is mounted once and survives an account switch").toMatch(
      /<CommandPalette\s+key=\{selectedAccountId\}\s+accountId=\{selectedAccountId\}/,
    );
    expect(src, "the account id must be read server-side, once").toMatch(/const selectedAccountId = getSelectedAccountId\(\);/);
  });

  it("the palette's result cache key carries the account, not just the chips", () => {
    const src = read("components/system/command-palette.tsx");
    expect(src).toMatch(/function hitsKey\(accountId: number, cats: readonly SourceKey\[\]\): string \{\s*\n\s*return `\$\{accountId\}\|\$\{catsKey\(cats\)\}`;/);
    // `fresh` compares q + key; a key without the account short-circuits the
    // fetch after a switch and re-renders the other book's rows.
    expect(src).toMatch(/const key = hitsKey\(accountId, cats\);/);
    expect(src, "catsKey() alone is the bug").not.toMatch(/const key = catsKey\(cats\);/);
    expect(src).toMatch(/useSearchSession\(accountId\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SHOULD-FIX 3 — a control character must not reach FTS5
// ───────────────────────────────────────────────────────────────────────────

describe("control characters never reach FTS5", () => {
  it("tokenise strips C0 bytes instead of passing them into a quoted term", () => {
    expect(tokenise("hello\u0000world")).toEqual(["helloworld"]);
    expect(tokenise('"\u0000"a')).toEqual(['""a']);
    expect(tokenise("tcs\u0007 \u001bbreak")).toEqual(["tcs", "break"]);
    expect(tokenise("\u0000")).toEqual([]);
    for (const t of ftsTokens("hello\u0000world")) expect(t).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("the MATCH expression it builds carries no control byte", () => {
    const m = ftsMatch("hello\u0000world");
    expect(m).toBe('"helloworld"');
    expect(ftsMatch('"\u0000"abc')).toBe('"""""abc"'); // quotes doubled, NUL gone
    expect(ftsMatch("\u0000")).toBeNull();
  });

  it("the route treats a throw from the fan-out as a 400, not an unhandled 500", () => {
    const src = read("app/api/search/route.ts");
    expect(src).toMatch(/try \{[\s\S]*searchAll\(q, \{ accountId, categories: categories \?\? undefined \}\)[\s\S]*\} catch \{[\s\S]*status: 400/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SHOULD-FIX 5/6/7 — what the results list must say
// ───────────────────────────────────────────────────────────────────────────

describe("MIN_QUERY is 2 but the trigram index needs 3", () => {
  it("a token below TRIGRAM_MIN is named, and drops the trade rows", () => {
    expect(shortTokens("IT")).toEqual(["it"]);
    expect(shortTokens("it swing")).toEqual(["it"]);
    expect(shortTokens("swing breakout")).toEqual([]);
    expect(TRIGRAM_MIN).toBe(3);

    const rows = [hit("trades", 1), hit("help", "/risk"), hit("symbols", "INE0")];
    // "it swing" reaches FTS as "swing" ALONE, so a trade row would be on
    // screen under a weaker rule than every other source (which AND every
    // token). Drop them and say so.
    expect(visibleResults("it swing", rows).map((r) => r.source)).toEqual(["help", "symbols"]);
    expect(visibleResults("swing", rows).map((r) => r.source)).toEqual(["trades", "help", "symbols"]);
    expect(tradesUnsearchable("it swing")).toBe(true);
    expect(tradesUnsearchable("swing")).toBe(false);
  });

  it("the results list renders the notice, the cap line and the global-scope suffix", () => {
    const src = read("components/system/search-results.tsx");
    expect(src, "the cursor and the list must walk the SAME rows").toContain("groupBySource(visibleResults(q, results))");
    expect(src, "no word on why Trades is missing").toMatch(/Trades need \{TRIGRAM_MIN\}\+ characters/);
    expect(src, "a truncated group looks complete").toMatch(/g\.results\.length === RESULT_CAP[\s\S]*Showing first \{RESULT_CAP\} — refine the query\./);
    expect(src, "global rows read as the selected account's").toMatch(/SOURCES\[g\.key\]\.scope === "global"[\s\S]*· all accounts/);
  });

  it("the palette's keyboard cursor walks the same filtered list", () => {
    const src = read("components/system/command-palette.tsx");
    expect(src).toMatch(/groupBySource\(visibleResults\(q, shownHits\)\)/);
  });

  it("every source the suffix claims is global really is, per the registry", () => {
    expect(SOURCES.symbols.scope).toBe("global");
    expect(SOURCES.trades.scope).toBe("account");
    expect(RESULT_CAP).toBe(50);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NOTE 8 — a bad account id means NO ROWS, never every row
// ───────────────────────────────────────────────────────────────────────────

describe("searchAll's account guard (real DB, two accounts)", () => {
  let t: TempDb;
  let search: typeof import("@/lib/queries/search");
  const PRO = { pro: true };

  beforeAll(async () => {
    t = await openTempDb("search-fixes", { seed: true });
    search = await import("@/lib/queries/search");
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).run();
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({ accountId: 1, symbol: "TCS", notes: "breakout retest", buyDate: "2026-07-01", sellDate: "2026-07-03" }),
        tradeRow({ accountId: 2, symbol: "INFY", notes: "breakout retest", buyDate: "2026-07-02", sellDate: "2026-07-02" }),
      ])
      .run();
  });

  afterAll(() => t?.cleanup());

  const tradeCount = (accountId: number) =>
    search.searchAll("breakout", { accountId, categories: ["trades"], entitlement: PRO }).results.length;

  it("0 is every account and a real id is that account", () => {
    expect(tradeCount(0)).toBe(2);
    expect(tradeCount(1)).toBe(1);
    expect(tradeCount(2)).toBe(1);
  });

  it("a negative, fractional or NaN id yields NO rows — it must never widen to every account", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, undefined as unknown as number, null as unknown as number]) {
      expect(tradeCount(bad), `accountId ${String(bad)} merged the books`).toBe(0);
    }
  });

  it("a bad id does not suppress the GLOBAL sources — only the account-scoped ones", () => {
    const global = search.searchAll("breakout", { accountId: -1, categories: ["trades", "help", "screens"], entitlement: PRO });
    expect(global.results.every((r) => SOURCES[r.source].scope === "global")).toBe(true);
  });
});
