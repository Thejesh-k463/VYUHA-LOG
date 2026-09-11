import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPTIONS_HELP,
  OPTIONS_HELP_FOOTER,
  OPTIONS_STRATEGY_IDS,
  OPTIONS_STYLES,
  optionsAnchorId,
  optionsHashTarget,
  rupeesInLakh,
  searchOptionsHelp,
  sebiRealityLine,
  visibleOptions,
  type OptionsHelpEntry,
} from "@/lib/domain/options-help";
import { searchHelp, type HelpHit } from "@/lib/domain/help-content";
import { SEBI_FNO_FACTS } from "@/lib/analytics/sebi-reality";
import { computeSettlement, DEFAULT_SETTLEMENT_RATES } from "@/lib/analytics/settlement";

/**
 * THE OPTIONS HELP DESK (v4.3 wave 2, B5).
 *
 * Forty structures, described and never prescribed. Four things are asserted
 * here that nothing else in the estate can assert:
 *
 *  1. THE ID LIST IS THE CLASSIFIER'S. Help that names a shape the classifier
 *     cannot produce — or misses one it can — is help for a different app.
 *     The list is joined in both directions, and against B1's own module the
 *     moment that file is on disk.
 *  2. EVERY ENTRY HAS ALL FOUR PARTS. A missing `payoff` is not a shorter
 *     card, it is an undescribed structure.
 *  3. THE COPY RULE, STRICTLY, SCOPED TO THIS FILE. `tests/help-content.test.ts`
 *     scopes its own SEBI gate to the Upstox sentences on purpose — run over
 *     the whole registry it reports refusals ("names no trade to take") as
 *     offenders. That gate is NOT widened here; this one is a second, strict
 *     gate over `lib/domain/options-help.ts` alone, where every sentence was
 *     written to it.
 *  4. THE ANCHORS EXIST. B4's strategy cards deep-link to `/help#options-<id>`;
 *     an anchor that is not rendered is a link into the middle of a page.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const MODULE = "lib/domain/options-help.ts";
const DESK = "components/system/help-desk.tsx";
const PALETTE = "components/system/command-palette.tsx";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const parts = (e: OptionsHelpEntry) => [e.what, e.payoff, e.whoUses, e.risk];
const prose = (e: OptionsHelpEntry) => parts(e).join(" ");

describe("the catalogue and the help describe ONE list of shapes", () => {
  it("carries exactly 40 entries, one per frozen id, with no duplicates", () => {
    expect(OPTIONS_STRATEGY_IDS).toHaveLength(40);
    expect(OPTIONS_HELP).toHaveLength(40);
    const ids = OPTIONS_HELP.map((e) => e.id);
    expect(new Set(ids).size, "a duplicate id would render two cards on one anchor").toBe(40);
  });

  it("every frozen id has an entry, and no entry describes a shape not on the list", () => {
    const ids = new Set(OPTIONS_HELP.map((e) => e.id));
    const missing = OPTIONS_STRATEGY_IDS.filter((id) => !ids.has(id));
    expect(missing, `ids with no help entry: ${missing.join(", ")}`).toEqual([]);
    const frozen = new Set(OPTIONS_STRATEGY_IDS);
    const ghosts = OPTIONS_HELP.filter((e) => !frozen.has(e.id)).map((e) => e.id);
    expect(ghosts, `help for shapes the catalogue does not name: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("is in the catalogue's own order", () => {
    expect(OPTIONS_HELP.map((e) => e.id)).toEqual([...OPTIONS_STRATEGY_IDS]);
  });

  /**
   * B1 owns `lib/analytics/strategy-catalogue.ts` this wave. Until it lands the
   * list here is the contract; the moment it lands this compares the two by
   * TEXT (no import, so a half-written module cannot redden the help desk).
   */
  it("matches B1's STRATEGY_IDS once that module is on disk", () => {
    const rel = "lib/analytics/strategy-catalogue.ts";
    if (!fs.existsSync(path.join(ROOT, rel))) {
      expect(OPTIONS_STRATEGY_IDS, "the frozen list is the contract until B1 lands").toHaveLength(40);
      return;
    }
    const src = read(rel);
    const block = /STRATEGY_IDS[^=]*=\s*\[([\s\S]*?)\]/.exec(src);
    expect(block, "STRATEGY_IDS is no longer an array literal in " + rel).not.toBeNull();
    const theirs = [...block![1].matchAll(/["'`]([a-z0-9-]+)["'`]/g)].map((m) => m[1]);
    expect(theirs, "B1's list and the help desk's list have drifted").toEqual([...OPTIONS_STRATEGY_IDS]);
  });

  it("marks exactly the five beginner rows of §4 (1, 2, 5, 6, 10)", () => {
    expect(OPTIONS_HELP.filter((e) => e.beginner).map((e) => e.id)).toEqual([
      "long-call",
      "long-put",
      "covered-call",
      "protective-put",
      "bull-call-spread",
    ]);
  });

  it("every entry carries a style the section can render", () => {
    for (const e of OPTIONS_HELP) expect(OPTIONS_STYLES, e.id).toContain(e.style);
    // Every style is used — an empty group would render as a missing heading.
    for (const s of OPTIONS_STYLES) {
      expect(OPTIONS_HELP.some((e) => e.style === s), `no entry has style ${s}`).toBe(true);
    }
  });
});

describe("every entry is actually written", () => {
  it("has all four parts, each a real paragraph, and at least 60 words in all", () => {
    const short: string[] = [];
    const thin: string[] = [];
    for (const e of OPTIONS_HELP) {
      const labels = ["what", "payoff", "whoUses", "risk"];
      parts(e).forEach((p, i) => {
        if (typeof p !== "string" || words(p) < 10) thin.push(`${e.id}.${labels[i]} (${words(p ?? "")} words)`);
      });
      if (words(prose(e)) < 60) short.push(`${e.id} (${words(prose(e))} words)`);
    }
    expect(thin, `parts that are missing or one-liners:\n${thin.join("\n")}`).toEqual([]);
    expect(short, `entries under the 60-word floor:\n${short.join("\n")}`).toEqual([]);
  });

  it("averages about 120 words an entry — a card, not a pamphlet", () => {
    const counts = OPTIONS_HELP.map((e) => words(prose(e)));
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(Math.min(...counts), "shortest entry").toBeGreaterThanOrEqual(60);
    expect(avg, `avg ${avg.toFixed(1)} words`).toBeGreaterThan(100);
    expect(avg, `avg ${avg.toFixed(1)} words`).toBeLessThan(180);
  });

  it("every entry has keywords the search can reach it by", () => {
    for (const e of OPTIONS_HELP) expect(e.keywords.length, e.id).toBeGreaterThan(2);
  });
});

/**
 * THE COPY RULE. Descriptive only. The nouns do the work — this is the owner's
 * own register from the Meridian risk card (§1.4 of the research), and §6's
 * list of words that must not appear on an option payoff surface.
 */
describe("SEBI copy rule — strict, and scoped to options-help.ts alone", () => {
  const BANNED =
    /\b(should|must|recommend(s|ed|ation|ations)?|suggest(s|ed|ion|ions)?|consider(s|ed|ing)?|advice|advise[sd]?|tips?|opportunit\w*|guarantee\w*|expected|ideal|best|safe|buy|buys|buying|sell|sells|selling|seller|target|will|shall)\b/i;

  it("no entry, in any of its four parts, uses the vocabulary of advice", () => {
    const offenders: string[] = [];
    for (const e of OPTIONS_HELP) {
      for (const p of parts(e)) {
        const m = BANNED.exec(p);
        if (m) offenders.push(`${e.id}: "${m[0]}" in "${p.slice(0, 90)}…"`);
      }
    }
    expect(offenders, `prescriptive vocabulary in the options catalogue:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the section's SEBI line is held to the same rule", () => {
    expect(BANNED.test(sebiRealityLine(SEBI_FNO_FACTS))).toBe(false);
  });

  it("the gate can fire — it is not a dead regex", () => {
    expect(BANNED.test("A trader should buy this spread when the trend is best.")).toBe(true);
    expect(BANNED.test("Consider the recommended target for a guaranteed profit.")).toBe(true);
    expect(BANNED.test("This shape is a safe opportunity you must not sell."), "the scan is dead").toBe(true);
    // …and it does not fire on the register the entries ARE written in.
    expect(BANNED.test("A trader who expects a large move uses this volatility shape.")).toBe(false);
    expect(BANNED.test("Max loss is the debit, computed at underlying = 0.")).toBe(false);
  });

  it("states the caps in the catalogue's own nouns", () => {
    // §4 rows whose max profit or max loss is unbounded, and §6's zero-price cap.
    const UNLIMITED = [
      "long-call",
      "short-call",
      "protective-put",
      "covered-put",
      "long-straddle",
      "short-straddle",
      "long-strangle",
      "short-strangle",
      "call-ratio-spread",
      "call-backspread",
      "synthetic-long-stock",
      "synthetic-short-stock",
      "split-strike-combo",
      "strip-strap",
      "guts",
    ];
    const ZERO_FLOOR = [
      "long-put",
      "short-put",
      "covered-call",
      "protective-call",
      "long-straddle",
      "put-ratio-spread",
      "put-backspread",
      "synthetic-long-stock",
      "synthetic-short-stock",
      "jade-lizard",
    ];
    const by = (id: string) => OPTIONS_HELP.find((e) => e.id === id)!;
    for (const id of UNLIMITED) {
      expect(by(id).payoff, `${id} has an unbounded side and does not say Unlimited`).toContain("Unlimited");
    }
    for (const id of ZERO_FLOOR) {
      expect(prose(by(id)), `${id} caps at the price floor and does not say where`).toContain(
        "computed at underlying = 0",
      );
    }
    // A bounded shape claims neither.
    expect(prose(by("iron-condor"))).not.toContain("Unlimited");
  });

  it("carries exactly ONE STT-on-exercise sentence per entry, on intrinsic value", () => {
    for (const e of OPTIONS_HELP) {
      const hits = prose(e).match(/STT/g) ?? [];
      expect(hits.length, `${e.id} states STT ${hits.length} times — it is one sentence per entry`).toBe(1);
      expect(prose(e), `${e.id} does not say what the STT is charged ON`).toMatch(/STT on intrinsic value/);
    }
  });

  it("names no URL anywhere — SEBI_FNO_FACTS publishes none and none is invented", () => {
    const src = read(MODULE);
    expect(src, "a URL was invented for the SEBI figures").not.toMatch(/https?:\/\/|www\.|sebi\.gov\.in/);
    expect(sebiRealityLine(SEBI_FNO_FACTS)).not.toMatch(/https?:\/\//);
    const desk = read(DESK);
    // lastIndexOf: the footer constant is also named in the import block at the
    // top of the file, and slicing to THAT would read an empty section.
    const section = desk.slice(desk.indexOf('id="options-help"'), desk.lastIndexOf("OPTIONS_HELP_FOOTER"));
    expect(section.length, "the options section is no longer in the desk").toBeGreaterThan(200);
    expect(section, "a URL was hand-written into the options section").not.toMatch(/https?:\/\//);
  });
});

describe("the SEBI line is computed from SEBI_FNO_FACTS, never typed out", () => {
  it("prints this study's own numbers", () => {
    const line = sebiRealityLine(SEBI_FNO_FACTS);
    expect(line).toContain(`${SEBI_FNO_FACTS.lossMakingPct}%`);
    expect(line).toContain(SEBI_FNO_FACTS.period);
    expect(line).toContain(rupeesInLakh(SEBI_FNO_FACTS.avgNetLoss));
    expect(line).toContain(SEBI_FNO_FACTS.sourceNote);
    // What the record actually holds today, so a silent edit to it is visible here.
    expect(line).toContain("91.1%");
    expect(line).toContain("₹1.2 L");
    expect(line).toContain("FY2024");
  });

  it("moves with the record — a revised study rewrites the sentence", () => {
    const moved = sebiRealityLine({
      period: "FY2031",
      lossMakingPct: 12.5,
      avgNetLoss: 250000,
      sourceNote: "A later study.",
    });
    expect(moved).toContain("12.5%");
    expect(moved).toContain("₹2.5 L");
    expect(moved).toContain("FY2031");
    expect(moved, "a literal survived the record change").not.toContain("91.1");
    expect(moved, "a literal survived the record change").not.toContain("1.2 L");
  });

  it("the desk renders that function, not a copy of its numbers", () => {
    const src = read(DESK);
    expect(src).toContain("sebiRealityLine(SEBI_FNO_FACTS)");
    expect(src, "a SEBI figure was hard-coded into the JSX").not.toMatch(/91\.1|1\.2 L|₹1,20,000/);
  });

  it("the footer states the four exclusions in the register of §6", () => {
    expect(OPTIONS_HELP_FOOTER).toMatch(/Intrinsic value only/);
    expect(OPTIONS_HELP_FOOTER).toMatch(/no volatility, no time value, no charges/);
    expect(OPTIONS_HELP_FOOTER).toMatch(/Not a forecast and not advice/);
  });
});

describe("deep-link anchors", () => {
  it("every anchor is options-<id>, and every one is unique", () => {
    const anchors = OPTIONS_HELP.map((e) => optionsAnchorId(e.id));
    expect(new Set(anchors).size).toBe(40);
    for (const e of OPTIONS_HELP) expect(optionsAnchorId(e.id)).toBe(`options-${e.id}`);
    expect(optionsAnchorId("iron-condor")).toBe("options-iron-condor");
  });

  it("the desk renders the anchor on the card, clear of the sticky header", () => {
    const src = read(DESK);
    expect(src, "the strategy card carries no id — /help#options-<id> lands nowhere").toContain(
      "id={optionsAnchorId(e.id)}",
    );
    expect(src, "no scroll-margin — the sticky header covers the card it jumped to").toMatch(/scroll-mt-\d+/);
  });

  it("the highlighted section is a section, badged and free, not a muted group", () => {
    const src = read(DESK);
    expect(src).toContain('id="options-help"');
    expect(src, "the accent border is what makes it visible").toMatch(/border-accent/);
    expect(src, "the Free badge is the owner's ask").toContain(">Free<");
    expect(src, "no route out to the strategies screen").toContain('href="/strategies"');
    expect(src, "the section header dropped to the chrome scale").not.toMatch(/id="options-help"[^>]*text-xs/);
  });

  /**
   * R4-U-2. `/help#options-help` is where a Custom card's "How this works"
   * lands (`helpHref(null)`), and two things were wrong at that anchor.
   *
   * The h2 carried no scroll-margin while every CARD did, so the sticky
   * `PageHeader` (`components/layout/page-header.tsx:15`) sat over the heading
   * the reader had just jumped to — the exact defect `scroll-mt-20` was added
   * to the cards for.
   *
   * And `optionsHashTarget` read that fragment as the entry id "help", because
   * it strips the `options-` prefix and returns whatever is left. Nothing has
   * the id "help", so `visibleOptions` shrugged — but the desk's SCROLL EFFECT
   * fired on it, calling `scrollIntoView` on the section heading for a link the
   * browser's own fragment navigation already handles. The effect exists for
   * cards the search filtered OUT; the heading is never filtered out.
   */
  it("the section heading is a scroll target of the BROWSER's, not of the effect (R4-U-2)", () => {
    expect(optionsHashTarget("#options-help"), "the section heading is read as an entry id").toBeNull();
    expect(optionsHashTarget("options-help"), "the bare fragment is read the same way").toBeNull();
    // …and every real entry still resolves, including one whose id starts with
    // the same letters the section id does.
    expect(optionsHashTarget("#options-long-call")).toBe("long-call");

    const src = read(DESK);
    const h2 = /<h2[^>]*id="options-help"[^>]*>/.exec(src)?.[0] ?? "";
    expect(h2, 'the desk renders no <h2 id="options-help">').not.toBe("");
    expect(h2, "the sticky page header covers the heading the link jumped to").toContain("scroll-mt-20");
  });
});

describe("search reaches the structures", () => {
  it("searchHelp('iron condor') returns the options entry", () => {
    const hits = searchHelp("iron condor");
    const isOption = (h: HelpHit): h is Extract<HelpHit, { kind: "options" }> => h.kind === "options";
    const opt = hits.filter(isOption).map((h) => h.entry.id);
    expect(opt, "the union search does not reach the catalogue").toContain("iron-condor");
  });

  it("the two-argument form is untouched — it still returns screens only", () => {
    const screens = searchHelp([{ href: "/x", title: "X", answers: "a", body: ["iron condor"], keywords: [] }], "iron");
    expect(screens.map((e) => e.href)).toEqual(["/x"]);
  });

  it("finds a structure by name, by id and by keyword", () => {
    expect(searchOptionsHelp(OPTIONS_HELP, "jade").map((e) => e.id)).toContain("jade-lizard");
    expect(searchOptionsHelp(OPTIONS_HELP, "bull call spread").map((e) => e.id)).toContain("bull-call-spread");
    expect(searchOptionsHelp(OPTIONS_HELP, "backspread").map((e) => e.id)).toEqual([
      "call-backspread",
      "put-backspread",
    ]);
    expect(searchOptionsHelp(OPTIONS_HELP, "  ")).toHaveLength(40);
    expect(searchOptionsHelp(OPTIONS_HELP, "zzzznotaword")).toEqual([]);
  });

  it("the palette loads them through the SAME lazy import, never at module evaluation", () => {
    const src = read(PALETTE);
    expect(src).toContain('import("@/lib/domain/options-help")');
    expect(src, "options-help entered the palette's module graph at page load").not.toMatch(
      /^import[^\n]*from "@\/lib\/domain\/options-help"/m,
    );
    expect(src, "the option commands do not deep-link to the help desk").toContain(
      "`/help#${opts.optionsAnchorId(e.id)}`",
    );
  });
});

/**
 * U-4 (v4.3 audit round 3) — A DEEP LINK MUST LAND EVEN INTO A FILTERED DESK.
 *
 * The palette pushes `/help#options-<id>`. When the reader is ALREADY on /help
 * with a query typed, the desk rendered `searchOptionsHelp(options, q)` only:
 * the named card was filtered out, its anchor was not in the DOM, and — a
 * same-path hash push not being a remount — nothing scrolled and nothing on
 * screen changed. `visibleOptions` adds the fragment's own entry back.
 */
describe("a deep link lands even when the search filtered its card out (U-4)", () => {
  it("keeps the entry the fragment names when the query dropped it", () => {
    // "backup" is a Help Desk word that appears in NO options entry — the
    // filter that produced the defect.
    expect(searchOptionsHelp(OPTIONS_HELP, "backup"), "the query hits an entry, so the case is untested").toEqual([]);
    const shown = visibleOptions(OPTIONS_HELP, "backup", "#options-jade-lizard");
    expect(shown.map((e) => e.id), "the deep link's anchor is not rendered").toEqual(["jade-lizard"]);
  });

  it("with no fragment the query alone decides — the server render is untouched", () => {
    expect(visibleOptions(OPTIONS_HELP, "backup", "")).toEqual([]);
    // Identity, not a copy: the empty desk renders exactly what it rendered before.
    expect(visibleOptions(OPTIONS_HELP, "", "")).toBe(OPTIONS_HELP);
  });

  it("a fragment for something else changes nothing", () => {
    expect(visibleOptions(OPTIONS_HELP, "backup", "#options-not-a-shape")).toEqual([]);
    expect(visibleOptions(OPTIONS_HELP, "backup", "#options-")).toEqual([]);
    expect(visibleOptions(OPTIONS_HELP, "backup", "#settings")).toEqual([]);
    expect(visibleOptions(OPTIONS_HELP, "backup", "")).toEqual([]);
    expect(optionsHashTarget("#options-iron-condor")).toBe("iron-condor");
    expect(optionsHashTarget("options-iron-condor"), "the bare fragment is read too").toBe("iron-condor");
    expect(optionsHashTarget("#help")).toBeNull();
  });

  it("catalogue order survives — the target is not appended after the hits", () => {
    const shown = visibleOptions(OPTIONS_HELP, "iron condor", "#options-long-call");
    expect(shown[0].id, "the target was appended instead of slotted in").toBe("long-call");
    expect(shown.map((e) => e.id)).toContain("iron-condor");
    // A hit the fragment also names is not duplicated.
    const once = visibleOptions(OPTIONS_HELP, "iron condor", "#options-iron-condor");
    expect(once.filter((e) => e.id === "iron-condor")).toHaveLength(1);
  });

  /**
   * THE COSMETIC HALF of U-4 (round 3, B3b). With the card rendered the reader
   * still saw nothing move: Next runs its own hash scroll at navigation commit,
   * while the anchor is still absent from the DOM. So the desk scrolls to it
   * itself, from an effect keyed on the TARGET ID — once per deep link, never
   * once per keystroke in `q` — whose body only calls a DOM method, the one
   * thing AGENTS.md leaves an effect free to do. `getElementById` returning
   * null IS the "is that card among the rendered options" question, asked of
   * the document after this render wrote it, so an unknown fragment no-ops.
   */
  it("scrolls the fragment's card into view, from an effect keyed on the target id alone", () => {
    const src = read(DESK);
    const m = /React\.useEffect\(\(\)\s*=>\s*\{([\s\S]{0,800}?)\},\s*\[([^\]]*)\]\s*\);/.exec(src);
    expect(m, "the desk runs no effect — Next's hash scroll fires before the card exists").not.toBeNull();
    const [, body, deps] = m!;
    expect(body, "the effect never looks the anchor up in the document").toMatch(
      /document\.getElementById\(optionsAnchorId\(/,
    );
    expect(body, "the effect does not scroll the card into view").toMatch(/scrollIntoView\(\{ block: "start" \}\)/);
    expect(body, "the effect does not no-op on an empty or unknown fragment").toMatch(/if\s*\(!/);
    const names = deps
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(names, `the effect re-runs on [${deps}] — a keystroke in q would yank the page`).toHaveLength(1);
    expect(src, `${names[0]} is not the id the fragment names`).toMatch(
      new RegExp(String.raw`const\s+${names[0]}\s*=\s*optionsHashTarget\(hash\)`),
    );
  });

  it("the desk reads the fragment through a store, never a setState in an effect", () => {
    const src = read(DESK);
    expect(src, "the desk still filters on the query alone").toContain("visibleOptions(options, q, hash)");
    expect(src, "the fragment is not read as an external store").toContain("React.useSyncExternalStore");
    expect(src, "no server snapshot — SSR would touch window").toMatch(/\(\)\s*=>\s*""/);
    expect(src, "a setState in an effect is what broke the Trades filter").not.toMatch(
      /useEffect\([\s\S]{0,200}?set[QH]/,
    );
  });
});

/**
 * v4.3.0 FIX WAVE 1 (W1-HELP) — the copy states what the exchange and the
 * engine actually do.
 *
 *  - R49. Exercise STT on intrinsic value is "Payable by Purchaser"
 *    (NSE/FATAX/73524 row 4(b)): the HOLDER who exercises, never the assigned
 *    writer. Five entries charged it to the writer, and the generic "an
 *    in-the-money leg left to settle" charged it to short legs too.
 *  - R94. NSE index and stock options are European-style — "Final Exercise is
 *    Automatic on expiry" (NSE Clearing). Six entries described EARLY
 *    assignment, which cannot happen here.
 *  - R95. A stock option held in the money into expiry settles by DELIVERY, so
 *    the premium is not the whole outlay — the app's own settlement panel says
 *    so, and the help said the opposite.
 *  - R97 / R98 / R99 / R100. Closed forms that the engine contradicts: the
 *    collar's sign, the unequal-wing iron butterfly / reverse iron condor and
 *    the one-sided breakeven, "any net credit" dropping a debit, and the
 *    split-strike combo's unbounded side. The engine half of each is pinned in
 *    tests/strategy-catalogue.test.ts.
 */
describe("the help copy agrees with the exchange and the engine (v4.3.0 fix wave 1)", () => {
  const entry = (id: string) => {
    const e = OPTIONS_HELP.find((x) => x.id === id);
    if (!e) throw new Error(`no options help entry ${id}`);
    return e;
  };
  const sentences = (e: OptionsHelpEntry) => prose(e).split(/(?<=\.)\s+/);

  it("R49 — the one STT sentence names who pays: a long leg or the holder, never the assigned writer", () => {
    const unnamed: string[] = [];
    for (const e of OPTIONS_HELP) {
      const stt = sentences(e).filter((s) => /STT/.test(s));
      expect(stt, `${e.id} has ${stt.length} STT sentences`).toHaveLength(1);
      if (!/\b(long (call|put|leg|wing)s?|holder)\b/.test(stt[0])) unnamed.push(`${e.id}: "${stt[0]}"`);
      expect(prose(e), `${e.id} charges exercise STT to an assigned writer`).not.toMatch(
        /\bassigned\b[^.;]*\bcharged STT\b/,
      );
    }
    expect(unnamed, `STT sentences that do not say who pays:\n${unnamed.join("\n")}`).toEqual([]);
    // The short-leg entries say it outright, and scope delivery to stock options.
    for (const id of ["short-call", "short-put", "covered-call", "covered-put", "short-straddle", "short-strangle"]) {
      expect(entry(id).risk, id).toContain("STT on intrinsic value falls on the holder who exercises, not on the assigned writer");
      expect(entry(id).risk, id).toMatch(/a stock option settled by delivery is charged the equity-delivery rate on the shares, on both sides/);
    }
    // Index options settle in cash: every delivery clause names the stock option.
    for (const id of ["short-put", "covered-call", "covered-put", "collar"]) {
      for (const s of sentences(entry(id)).filter((x) => /\bdeliver/i.test(x) && !/STT/.test(x))) {
        expect(s, `${id}: a delivery clause with no stock-option scope`).toMatch(/stock option/);
      }
    }
    // The regex can fire on the sentence that was there.
    expect(/\bassigned\b[^.;]*\bcharged STT\b/.test("An assigned short call is charged STT on intrinsic value.")).toBe(true);
  });

  it("R94 — no entry describes early assignment; NSE options are exercised at expiry only", () => {
    const EARLY =
      /\bassign\w*\b[^.]{0,80}\b(early|before expiry|still carr\w* time value)\b|\bearly (assignment|exercise)\b|\bexercised early\b/i;
    const hits = OPTIONS_HELP.filter((e) => EARLY.test(prose(e))).map((e) => e.id);
    expect(hits, `entries that describe early assignment: ${hits.join(", ")}`).toEqual([]);
    expect(entry("collar").risk, "collar still says assignment delivers 'whatever happens afterwards'").not.toMatch(
      /whatever happens afterwards/,
    );
    // BSE stock-option exercise style is not verified, so it is never named.
    for (const e of OPTIONS_HELP) expect(prose(e), e.id).not.toMatch(/\bBSE\b/);
    // The gate fires on the lines that were there.
    expect(EARLY.test("The short leg can be assigned before expiry, which unbalances the pair.")).toBe(true);
    expect(EARLY.test("Assignment on the short put can arrive while the long put still carries time value.")).toBe(true);
  });

  it("R95 — a long stock option in the money settles by delivery; the settlement engine says the same", () => {
    for (const id of ["long-call", "long-put"]) {
      expect(entry(id).what, `${id} still calls the premium the whole outlay`).toMatch(
        /stock option[^.]*settles by delivery/,
      );
    }
    expect(entry("long-call").what).not.toMatch(/nothing further is blocked/);
    expect(entry("long-put").what).not.toMatch(/entire outlay of the position\./);
    // The other half of the seam: the app's own settlement panel, for the same
    // long ITM stock call, states the cash the delivery takes.
    const s = computeSettlement(
      [
        {
          id: 1,
          symbol: "RELIANCE",
          tradingsymbol: "OPT RELIANCE 15 Sep 2026 1400 CE",
          segment: "stock_option",
          optionType: "CE",
          strike: 1400,
          expiry: "2026-09-15",
          netQty: 500,
          side: "long",
          refPrice: 1500,
        },
      ],
      DEFAULT_SETTLEMENT_RATES,
      "2026-09-11",
    );
    expect(s.obligations[0].fundsOrShares).toMatch(/cash if exercised/);
  });

  it("R97 — the collar's caps carry one signed net premium (credit positive, a debit negative)", () => {
    const p = entry("collar").payoff;
    expect(p).toMatch(/\(K2 − S0\) × quantity plus the net premium/);
    expect(p).toMatch(/\(S0 − K1\) × quantity minus it/);
    expect(p).toMatch(/net debit counted as negative/);
  });

  it("R98 — unequal wings: the wider wing sets the cap, and a narrow wing has no breakeven", () => {
    expect(entry("iron-butterfly").payoff).toContain("max(K2 − K1, K3 − K2)");
    expect(entry("reverse-iron-condor").payoff).toContain("max(K2 − K1, K4 − K3)");
    for (const id of ["iron-condor", "iron-butterfly", "reverse-iron-condor"]) {
      expect(entry(id).payoff, `${id} states two breakevens for any wings`).toMatch(
        /a narrower wing leaves that side with no breakeven/,
      );
    }
    for (const id of [
      "long-call-butterfly",
      "long-put-butterfly",
      "short-butterfly",
      "long-call-condor",
      "short-call-condor",
      "long-put-condor",
    ]) {
      expect(entry(id).payoff, `${id} states an equal-wing closed form with no qualifier`).toMatch(/equal wings/);
    }
  });

  it("R99 — ratios and backspreads carry the signed net, so a debit is not dropped", () => {
    for (const id of ["call-ratio-spread", "put-ratio-spread", "call-backspread", "put-backspread"]) {
      expect(entry(id).payoff, id).not.toMatch(/any net credit/);
      expect(entry(id).payoff, id).toMatch(/net debit counting as negative/);
    }
  });

  it("R100 — the split-strike combo's unbounded side is above the higher strike, and a call-lower combo is not flat", () => {
    const p = entry("split-strike-combo").payoff;
    expect(p).not.toMatch(/Unlimited on the short side/);
    expect(p).toMatch(/Unlimited above the higher strike/);
    expect(p).toMatch(/two-for-one/);
    expect(p).not.toMatch(/on the side the net sits/);
  });
});
