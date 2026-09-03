import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * Search v1 — lib/queries/search.ts against a real database.
 *
 * Trades come back as IDS ONLY, from ONE FTS5 query ordered by the index's
 * `rank`, scoped by `trades.account_id`. This file proves that, proves the
 * MATCH string is escaped (a query typed as FTS syntax is searched, not
 * executed), and greps the module's source for the two things it must never
 * do: import lib/queries/trades.ts, or ORDER BY a trades column — /trades
 * sums floats in its own order and a re-ordered tie would move the sums.
 *
 * One temp database per FILE; every import of lib/queries/* is dynamic.
 */

let t: TempDb;
let search: typeof import("@/lib/queries/search");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

let primaryId = 0;
let swingId = 0;

beforeAll(async () => {
  t = await openTempDb("search-query", { seed: true });
  search = await import("@/lib/queries/search");

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
  const rows = t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({ accountId: PRIMARY, symbol: "TCS", notes: "breakout retest, held through lunch", buyDate: "2026-07-01", sellDate: "2026-07-03", setupTag: "orb" }),
      tradeRow({ accountId: SWING, symbol: "INFY", notes: "breakout retest — chased it", buyDate: "2026-07-02", sellDate: "2026-07-02" }),
      tradeRow({ accountId: PRIMARY, symbol: "SBIN", notes: "gap fade", mistakeTags: ["fomo", "chased"] }),
      tradeRow({ accountId: PRIMARY, symbol: "HDFCBANK", notes: 'the "quoted" note' }),
    ])
    .returning({ id: t.schema.trades.id, accountId: t.schema.trades.accountId })
    .all();
  primaryId = rows[0].id;
  swingId = rows[1].id;
});

afterAll(() => t?.cleanup());

describe("searchTradeIds — FTS, ids only, account-scoped", () => {
  it("a mid-word trigram finds the note, and only in the selected account", () => {
    expect(search.searchTradeIds("kou", PRIMARY)).toEqual([primaryId]);
    expect(search.searchTradeIds("kou", SWING)).toEqual([swingId]);
    expect(search.searchTradeIds("kou", ALL).sort()).toEqual([primaryId, swingId].sort());
  });

  it("returns numbers and nothing else", () => {
    const ids = search.searchTradeIds("retest", ALL);
    expect(ids.length).toBe(2);
    for (const id of ids) expect(typeof id).toBe("number");
  });

  it("below the trigram minimum there is no FTS answer — the in-memory path owns short queries", () => {
    expect(search.searchTradeIds("ko", ALL)).toEqual([]);
    expect(search.searchTradeIds("", ALL)).toEqual([]);
    expect(search.searchTradeIds("a b", ALL)).toEqual([]);
  });

  it("every token must appear, in any column", () => {
    expect(search.searchTradeIds("retest chased", ALL)).toEqual([swingId]);
    // mistake_tags are indexed as words: 'fomo' reaches the JSON-array row.
    expect(search.searchTradeIds("fomo", PRIMARY)).toHaveLength(1);
    expect(search.searchTradeIds("orb", PRIMARY)).toEqual([primaryId]);
  });

  it("FTS syntax typed by the user is searched, never executed", () => {
    // Bare operators / column filters / prefix stars would throw or change
    // semantics if they reached FTS5 unquoted. Quoted, they are just text.
    for (const q of ["fomo OR chased", "notes:fomo", "fomo*", "NOT fomo", "(fomo)", 'the "quoted" note', '"""', "^fomo", "a:b:c"]) {
      expect(() => search.searchTradeIds(q, ALL), q).not.toThrow();
    }
    // `OR` is not a union: 'gap' lives only on the SBIN row and 'retest' only
    // on the other two, so a real OR would return three rows. Quoted, the
    // tokens are AND-ed ('or' itself is under the trigram minimum) → none.
    expect(search.searchTradeIds("gap OR retest", ALL)).toEqual([]);
    expect(search.searchTradeIds("gap retest", ALL)).toEqual([]);
    // The doubled-quote escape reaches the note that actually contains quotes.
    expect(search.searchTradeIds('"quoted"', PRIMARY)).toHaveLength(1);
  });
});

describe("searchAll — the fan-out", () => {
  it("a trade result carries the deep-link keys the Trades page honours, and is never locked", () => {
    const { results } = search.searchAll("kou", { accountId: PRIMARY, categories: ["trades"], entitlement: { pro: false } });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.source).toBe("trades");
    expect(r.id).toBe(primaryId);
    expect(r.href).toBe("/trades?symbol=TCS&from=2026-07-01&to=2026-07-03");
    expect(r.locked).toBe(false);
    expect(r.unlocks).toBeUndefined();
  });

  it("symbols: exact ticker first, then prefix; a BSE code and a company name both resolve; sector rides as the subtitle", () => {
    const exact = search.SOURCE_READERS.symbols("reliance", ALL);
    expect(exact[0].title).toBe("RELIANCE");
    expect(exact[0].href).toBe("/trades?symbol=RELIANCE");
    expect(exact[0].subtitle).toMatch(/Reliance Industries/i);
    expect(exact[0].subtitle).toMatch(/Energy|Oil/i);

    // Prefix hits (tier 1) come first, as a block; name-substring hits
    // ("Religare…", tier 2) may follow but never interleave.
    const prefix = search.SOURCE_READERS.symbols("reli", ALL);
    const firstNonPrefix = prefix.findIndex((r) => !r.title.startsWith("RELI"));
    const block = firstNonPrefix === -1 ? prefix : prefix.slice(0, firstNonPrefix);
    expect(block.length).toBeGreaterThan(1);
    expect(block[0].title).toBe("RELIABLE"); // alphabetical within the tier
    if (firstNonPrefix !== -1) expect(prefix.slice(firstNonPrefix).some((r) => r.title.startsWith("RELI"))).toBe(false);

    expect(search.SOURCE_READERS.symbols("500325", ALL).some((r) => r.title === "RELIANCE")).toBe(true);
    expect(search.SOURCE_READERS.symbols("consultancy services", ALL).some((r) => r.title === "TCS")).toBe(true);
  });

  it("help matches title and keywords; screens match the nav label", () => {
    const help = search.SOURCE_READERS.help("var", ALL);
    expect(help.some((r) => r.href === "/risk")).toBe(true);
    const screens = search.SOURCE_READERS.screens("dashboard", ALL);
    expect(screens[0]).toMatchObject({ source: "screens", href: "/", title: "Dashboard" });
  });

  it("categories restrict the fan-out, and every source is capped at 50", () => {
    t.db.transaction((tx) => {
      for (let i = 0; i < 60; i++) tx.insert(t.schema.trades).values(tradeRow({ accountId: SWING, symbol: `CAP${i}`, notes: `overflow note ${i}` })).run();
    });
    const { results, tookMs } = search.searchAll("overflow", { accountId: ALL, categories: ["trades", "playbooks"], entitlement: { pro: true } });
    expect(results.filter((r) => r.source === "trades")).toHaveLength(50);
    expect(results.every((r) => r.source === "trades" || r.source === "playbooks")).toBe(true);
    expect(tookMs).toBeGreaterThanOrEqual(0);
    expect(search.searchTradeIds("overflow", ALL)).toHaveLength(50);
  });

  it("a blank query answers nothing without touching any source", () => {
    expect(search.searchAll("   ", { accountId: ALL, entitlement: { pro: true } }).results).toEqual([]);
  });
});

describe("source guard — what lib/queries/search.ts must never do", () => {
  // Comments stripped: the header EXPLAINS the ORDER BY it refuses to write.
  const src = fs
    .readFileSync(path.resolve(__dirname, "../lib/queries/search.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("does not import lib/queries/trades.ts", () => {
    expect(src).not.toMatch(/queries\/trades["']/);
    expect(src).not.toMatch(/from\s+["']\.\/trades["']/);
  });

  it("its only ORDER BY is the FTS rank — never a trades column, never drizzle orderBy", () => {
    const orderBys = src.match(/ORDER\s+BY\s+[^\n"`]+/gi) ?? [];
    expect(orderBys.length, "the FTS statement must ORDER BY rank").toBeGreaterThan(0);
    for (const ob of orderBys) expect(ob.trim()).toMatch(/^ORDER\s+BY\s+rank\b/i);
    expect(src).not.toMatch(/\.orderBy\(/);
  });

  it("scopes the FTS join on trades.account_id with the 0 = all short-circuit", () => {
    expect(src).toMatch(/@account = 0 OR trades\.account_id = @account/);
  });
});
