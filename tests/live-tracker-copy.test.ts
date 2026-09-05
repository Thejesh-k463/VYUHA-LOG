import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DESK_COPY, EM_DASH, needsSessions, stalenessLabel, stopLabel } from "@/components/live/desk-copy";

/**
 * The Live Desk copy guard (owner rulings Q31 / Q32).
 *
 * Vyuha describes arithmetic and attributes every choice to the user. It does
 * not name a security and prompt a transaction — that is the SEBI IA line, and
 * a desk that crosses it crosses it in a string, not in a formula. So this is
 * a SOURCE guard over every user-facing string in `components/live/` and
 * `app/live/`, in the family of `tests/tax-levers.test.ts:175`.
 *
 * ── It scans the WHOLE comment-stripped source ──────────────────────────────
 * `buyQty`, `avgBuyPrice`, `sellDate` and `isShort` are the journal's own
 * vocabulary and are not copy — but every banned token is `\b`-anchored, so
 * none of them can match, and scanning everything is what closes the hole an
 * extractor leaves (see `copyOf` below, audit T1).
 *
 * ── The disclaimer is exempt, and only the disclaimer ───────────────────────
 * "Nothing here is investment advice or a recommendation" contains two banned
 * words BY DESIGN — a negation is the one legitimate use. Those exact strings
 * are removed before the scan, so the exemption is a value, not a regex hole
 * a future sentence can slip through.
 */

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["components/live", "app/live"];

const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function files(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  return out;
}

/** The exact negated sentences the guard must not fire on. */
/*
 * All three say what Vyuha is NOT doing, which is the one legitimate use of a
 * banned word. They are removed BY VALUE, so the exemption cannot widen into a
 * regex hole a future prescriptive sentence slips through.
 */
const EXEMPT = [DESK_COPY.disclaimer, DESK_COPY.disclaimerShort, DESK_COPY.fillsCaveat];

/**
 * The comment-stripped source, with the three negated sentences removed.
 *
 * WHY THE WHOLE SOURCE, NOT EXTRACTED STRINGS (audit T1). The old extractor
 * pulled quoted literals plus JSX text matched by `/>([^<>{}]+)</` — a text node
 * containing ANY interpolation fails that character class, so a banned verb
 * standing next to `{fmt.pct(…)}` was invisible to the guard.
 * `tracker-client.tsx` and `position-chart-panel.tsx` both have text nodes of
 * exactly that shape, so the hole was over live copy, not a hypothetical.
 *
 * `tests/sizing-lab-copy.test.ts` scans the whole comment-stripped source
 * instead, and that is what this now does. The journal's own identifiers
 * survive it because every banned token is `\b`-anchored: `buyQty`, `buyDate`,
 * `sellQty` and `avgSellPrice` all continue into another word character, so
 * `\bbuy\b` and `\bsell now\b` cannot match them.
 */
function copyOf(file: string): string {
  let src = stripComments(fs.readFileSync(file, "utf8"));
  for (const e of EXEMPT) src = src.split(e).join(" ");
  return src;
}

/**
 * The banned vocabulary. `sell now` and `target price` are phrases on purpose:
 * "Target" is a level the USER recorded and must stay printable, while "target
 * price" is Vyuha asserting one.
 *
 * `suggest` is matched only in its VERB forms (`suggest`, `suggests`,
 * `suggested`). The rail heading "Trailing profit suggestions" is owner-mandated
 * (W2): a NOUN naming a list of computed levels describes arithmetic, which is
 * exactly what the desk may print — "Vyuha suggests you trail" is not. So
 * `suggestion`/`suggestions` pass, and the heading test below pins that, so a
 * future tightening to /suggest/ goes red here and not in the owner's screen.
 */
const BANNED =
  /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed)\b/i;

describe("Live Desk copy never prompts a transaction", () => {
  it.each(files().map((f) => path.relative(ROOT, f).replace(/\\/g, "/")))("%s carries no banned vocabulary", (rel) => {
    const src = copyOf(path.join(ROOT, rel));
    const offenders = [...src.matchAll(new RegExp(BANNED.source, "gi"))].map((m) => m[0]);
    expect(offenders, `${rel}: ${offenders.join(" | ")}`).toEqual([]);
  });

  it("the scan sees a banned verb in a text node that carries an interpolation (T1)", () => {
    // The exact shape the old extractor was blind to. A guard with a hole over
    // live copy is worse than no guard, because it reports green.
    const planted = "return (<p>You should trim {fmt.pct(row.openRPpm)} here</p>);";
    expect(BANNED.test(planted), "the whole-source scan must catch it").toBe(true);
    const oldExtractor = [...planted.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
    expect(oldExtractor.some((s) => BANNED.test(s)), "the old JSX-text extractor could not").toBe(false);
  });

  it("the scan really can fire — a prescriptive sentence is caught", () => {
    // A guard nobody has seen go red is a guard nobody has tested.
    for (const bad of [
      "We recommend trailing your stop",
      "Consider booking profit here",
      "You should buy more",
      "Our target price is 3,100",
      "Vyuha suggests you trail to 2,880",
      "We suggested a tighter stop",
      "Our recommendation is to hold",
      "Take our advice and exit",
    ]) {
      expect(BANNED.test(bad), bad).toBe(true);
    }
  });

  it("the three negated sentences are exempt BY VALUE, not by a regex hole", () => {
    // Each says what Vyuha does NOT do, so each legitimately carries a banned
    // word. They pass because they are removed before the scan — the regex
    // itself still fires on every one of them.
    for (const e of EXEMPT) expect(BANNED.test(e), e).toBe(true);
    expect(EXEMPT).toContain(DESK_COPY.fillsCaveat);
  });

  it("…but the owner-mandated heading NOUN is not a verb, and is allowed", () => {
    // W2 ships this heading verbatim. The guard must tell a noun naming
    // computed levels apart from Vyuha telling the user to act on them.
    expect(BANNED.test("Trailing profit suggestions"), "the rail heading").toBe(false);
    expect(BANNED.test("One suggestion per structure level"), "singular noun").toBe(false);
    expect(BANNED.test("Vyuha suggests trailing"), "the verb it must still catch").toBe(true);
  });

  it("the rail heading is on the screen exactly as the owner mandated it", () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/position-chart-panel.tsx"), "utf8"));
    expect(src).toContain("Trailing profit suggestions");
  });

  it("…and passes the desk's own descriptive phrasing", () => {
    for (const ok of [
      DESK_COPY.description,
      DESK_COPY.riskNotSet,
      DESK_COPY.chargesCaveat,
      stopLabel("₹2,600.00", "the stop you recorded", "1.20%"),
      needsSessions(21, 8),
    ]) {
      expect(BANNED.test(ok), ok).toBe(false);
    }
  });
});

describe("the standing disclaimer is on the screen, not in a comment", () => {
  it("the tracker renders both disclaimer sentences", () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));
    expect(src).toContain("DESK_COPY.disclaimer");
    expect(src).toContain("DESK_COPY.disclaimerShort");
  });

  it("the short line says what Vyuha does and does not do", () => {
    expect(DESK_COPY.disclaimerShort).toBe("Vyuha computes; it does not advise.");
  });

  it("the long line refuses the two claims a tracker most easily implies", () => {
    expect(DESK_COPY.disclaimer).toContain("record-keeping and calculation tool");
    expect(DESK_COPY.disclaimer).toContain("verify with your broker before acting");
  });

  it("stops are never presented as guaranteed fills", () => {
    expect(DESK_COPY.fillsCaveat).toContain("not guaranteed fills");
    expect(DESK_COPY.fillsCaveat).toContain("gaps, circuits and illiquidity");
  });
});

describe("empty states state a shortfall — never a zero (invariant 6)", () => {
  it("an insufficient history says how many sessions are missing", () => {
    expect(needsSessions(21, 8)).toBe("— needs 21 sessions. You have 8.");
    expect(needsSessions(21, 8)).not.toContain("0");
  });

  it("the dash is an EM dash — a hyphen beside a signed figure reads as a minus", () => {
    expect(EM_DASH).toBe("—");
    expect(needsSessions(21, 0).startsWith(EM_DASH)).toBe(true);
  });
});

/**
 * C2 — "alerts" is advertised nowhere on /live until Telegram alerts ship.
 *
 * No alert code exists under `lib/live` or `components/live`; the feature is
 * v4.1. A paywall label naming a capability the build does not have is an
 * upsell for something the buyer cannot get, which is the one claim a Pro chip
 * must never make. The word leaves EVERY Pro label until the feature ships.
 */
describe("the Pro label names only what v4.0 actually computes", () => {
  it("no file on the Live Desk advertises alerts", () => {
    const offenders = files()
      .filter((f) => /\balerts?\b/i.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(offenders, `these still advertise alerts: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the Pro chip lists R, risk at stop, heat and the chart overlay — and stops there", () => {
    expect(DESK_COPY.proColumns).not.toMatch(/\balerts?\b/i);
    expect(DESK_COPY.proColumns).toContain("risk at stop");
    expect(DESK_COPY.proColumns).toContain("chart overlay");
  });
});

/**
 * C9 — a mark read back from `mtm_prices` has UNKNOWN provenance.
 *
 * `persist-mark.ts` writes feed marks into the same table the manual MTM editor
 * writes to, and the table carries no source column. Calling every row "Manual
 * mark" tells the user they typed a number the feed may well have written.
 * "Stored mark" states what is actually known: it came from the store.
 */
describe("a stored mark is labelled by what is known about it", () => {
  it("names the store, not the user, since mtm_prices has no source column", () => {
    expect(stalenessLabel("manual", null)).toBe("Stored mark");
    expect(stalenessLabel("manual", "04 Sep")).toBe("Stored mark · 04 Sep");
    expect(stalenessLabel("manual", null)).not.toContain("Manual");
  });

  it("the other three provenances are unchanged", () => {
    expect(stalenessLabel("eod", null)).toBe("End of day");
    expect(stalenessLabel("delayed", null)).toBe("Delayed");
    expect(stalenessLabel("tick", null)).toBe("Last traded");
    expect(stalenessLabel(null, null)).toBe(DESK_COPY.noMark);
  });
});
