import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_FRAMES,
  MIN_QUERY,
  catsKey,
  deriveKeywords,
  groupBySource,
  popFrame,
  pushFrame,
  searchUrl,
  toggleCat,
  unlockLine,
  type SearchFrame,
} from "@/components/system/use-search-session";
import { CATEGORY_CHIPS } from "@/lib/domain/search-rank";
import type { SearchResult } from "@/lib/domain/search-scope";

/**
 * Search v1 in the palette (v3.8 Wave 3).
 *
 * Two halves. The PURE half exercises the session stack and the helpers the
 * palette and its results list share. The SOURCE half reads the palette's
 * file and pins its performance contract — the palette mounts on every page,
 * so the results component may be reached only through a dynamic import,
 * and the one `fetch(` must sit inside the debounced, MIN_QUERY-guarded
 * effect. Neither back control may drive `router.back()`.
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PALETTE = "components/system/command-palette.tsx";
const SESSION = "components/system/use-search-session.ts";
const RESULTS = "components/system/search-results.tsx";

const hit = (source: SearchResult["source"], id: number | string, extra: Partial<SearchResult> = {}): SearchResult => ({
  source,
  id,
  title: `${source} ${id}`,
  href: `/${source}/${id}`,
  locked: false,
  ...extra,
});

const frame = (q: string, cats: SearchFrame["cats"] = [], results: SearchResult[] = []): SearchFrame => ({ q, cats, results });

describe("session stack", () => {
  it("push then pop restores the same frame, results included", () => {
    const a = frame("kou", ["trades"], [hit("trades", 1)]);
    const stack = pushFrame([], a);
    const { stack: rest, frame: popped } = popFrame(stack);
    expect(popped).toBe(a);
    expect(rest).toEqual([]);
  });

  it("pop on an empty stack yields no frame and stays empty", () => {
    expect(popFrame([])).toEqual({ stack: [], frame: null });
  });

  it("the same search opened twice is ONE frame (the newer results win)", () => {
    const first = frame("kou", ["trades"], [hit("trades", 1)]);
    const second = frame("kou", ["trades"], [hit("trades", 1), hit("trades", 2)]);
    const stack = pushFrame(pushFrame([], first), second);
    expect(stack).toHaveLength(1);
    expect(stack[0].results).toHaveLength(2);
  });

  it("a different query or chip set is a new frame", () => {
    let stack = pushFrame([], frame("kou", []));
    stack = pushFrame(stack, frame("kou", ["help"]));
    stack = pushFrame(stack, frame("koutons", ["help"]));
    expect(stack.map((f) => f.q + "|" + catsKey(f.cats))).toEqual(["kou|", "kou|help", "koutons|help"]);
  });

  it("is capped at MAX_FRAMES, dropping the oldest", () => {
    let stack: SearchFrame[] = [];
    for (let i = 0; i < MAX_FRAMES + 5; i++) stack = pushFrame(stack, frame(`q${i}`));
    expect(stack).toHaveLength(MAX_FRAMES);
    expect(stack[0].q).toBe("q5");
  });
});

describe("helpers", () => {
  it("catsKey is chip order, whatever order the chips were clicked in", () => {
    expect(catsKey(["help", "trades"])).toBe("trades,help");
    expect(catsKey([])).toBe("");
  });

  it("searchUrl encodes the query and omits cat when every source is wanted", () => {
    expect(searchUrl("tcs breakout", [])).toBe("/api/search?q=tcs%20breakout");
    expect(searchUrl("kou", ["help", "trades"])).toBe("/api/search?q=kou&cat=trades,help");
  });

  it("toggleCat adds, removes, and keeps chip order", () => {
    expect(toggleCat([], "help")).toEqual(["help"]);
    expect(toggleCat(["help"], "trades")).toEqual(["trades", "help"]);
    expect(toggleCat(["trades", "help"], "trades")).toEqual(["help"]);
  });

  it("groupBySource groups in chip order and omits empty sources", () => {
    const groups = groupBySource([hit("help", "/risk"), hit("trades", 7), hit("screens", "/risk"), hit("trades", 3)]);
    expect(groups.map((g) => g.key)).toEqual(["trades", "help", "screens"]);
    expect(groups[0].results.map((r) => r.id)).toEqual([7, 3]);
    expect(groups[1].label).toBe("Help");
    expect(CATEGORY_CHIPS.indexOf("trades")).toBeLessThan(CATEGORY_CHIPS.indexOf("help"));
  });

  it("unlockLine names what Pro unlocks, and is absent for a free result", () => {
    expect(unlockLine({ locked: true, unlocks: "Portfolio Risk cockpit" })).toBe("Unlocks with Pro — Portfolio Risk cockpit");
    expect(unlockLine({ locked: false })).toBeNull();
  });

  it("deriveKeywords reads the help registry by href and falls back to the label", () => {
    const entries = [{ href: "/risk", keywords: ["VaR", "Greeks"] }, { href: "/empty", keywords: [] }];
    expect(deriveKeywords(entries, "/risk", "Portfolio Risk")).toBe("var greeks");
    expect(deriveKeywords(entries, "/empty", "Empty Screen")).toBe("empty screen");
    expect(deriveKeywords(entries, "/missing", "Missing Screen")).toBe("missing screen");
  });

  it("MIN_QUERY is two characters — one keystroke never searches", () => {
    expect(MIN_QUERY).toBe(2);
  });
});

describe("palette performance contract (source)", () => {
  const src = read(PALETTE);

  it("reaches the results component only through a dynamic import", () => {
    expect(src).toMatch(/dynamic\(\(\) => import\("\.\/search-results"\)/);
    expect(src).not.toMatch(/^import[^\n]*from "(\.\/|@\/components\/system\/)search-results"/m);
  });

  it("has exactly one fetch(, inside the debounced MIN_QUERY-guarded effect", () => {
    const calls = src.match(/\bfetch\(/g) ?? [];
    expect(calls, "fetch( call sites in the palette").toHaveLength(1);

    const at = src.indexOf("fetch(");
    const effectStart = src.lastIndexOf("React.useEffect(", at);
    expect(effectStart, "fetch( is not inside a useEffect").toBeGreaterThan(-1);
    const effectEnd = src.indexOf("}, [", at);
    const effect = src.slice(effectStart, effectEnd);
    expect(effect).toContain("if (!searching || fresh) return;");
    expect(effect).toContain("setTimeout(");
    expect(effect).toContain("SEARCH_DEBOUNCE_MS");
    expect(effect).toContain("ctrl.abort()");
    // `searching` is what gates on MIN_QUERY.
    expect(src).toMatch(/const searching = open && q\.length >= MIN_QUERY;/);
  });

  it("loads the help keyword registry lazily, not at module evaluation", () => {
    expect(src).toContain('import("@/lib/domain/help-content")');
    expect(src).not.toMatch(/^import[^\n]*from "@\/lib\/domain\/help-content"/m);
  });

  it("neither back control calls router.back()", () => {
    for (const f of [PALETTE, SESSION, RESULTS]) {
      expect(read(f), f).not.toContain("router.back(");
    }
    expect(src).toContain("router.push(href)");
  });
});
