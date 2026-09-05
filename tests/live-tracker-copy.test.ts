import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DESK_COPY, EM_DASH, needsSessions, stopLabel } from "@/components/live/desk-copy";

/**
 * The Live Desk copy guard (owner rulings Q31 / Q32).
 *
 * Vyuha describes arithmetic and attributes every choice to the user. It does
 * not name a security and prompt a transaction — that is the SEBI IA line, and
 * a desk that crosses it crosses it in a string, not in a formula. So this is
 * a SOURCE guard over every user-facing string in `components/live/` and
 * `app/live/`, in the family of `tests/tax-levers.test.ts:175`.
 *
 * ── It scans STRINGS, not identifiers ───────────────────────────────────────
 * `buyQty`, `avgBuyPrice`, `sellDate` and `isShort` are the journal's own
 * vocabulary and are not copy. Matching raw source would either fail on them
 * or force the banned list to be so narrow it stops catching prose. So the
 * scan extracts quoted strings and JSX text nodes from comment-stripped
 * source, and tests those.
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

/** Quoted strings + JSX text, comment-free, with the disclaimer removed. */
function copyOf(file: string): string[] {
  let src = stripComments(fs.readFileSync(file, "utf8"));
  for (const e of EXEMPT) src = src.split(e).join(" ");
  const out: string[] = [];
  for (const m of src.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\]*)`/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  for (const m of src.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out.map((s) => s.trim()).filter((s) => s.length > 2);
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
    const offenders = copyOf(path.join(ROOT, rel)).filter((s) => BANNED.test(s));
    expect(offenders, `${rel}: ${offenders.join(" | ")}`).toEqual([]);
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
