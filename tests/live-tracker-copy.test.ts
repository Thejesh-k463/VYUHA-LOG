import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CONNECT_PROMPT_COPY,
  DESK_COPY,
  EM_DASH,
  LIVE_STREAM_COPY,
  lockedInAtStop,
  needsSessions,
  resultsChip,
  stalenessLabel,
  stopLabel,
} from "@/components/live/desk-copy";

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

/**
 * v4.1 — the results date (owner ruling Q-9).
 *
 * It is a DATE FACT about the company, in the same family as the symbol, so it
 * is FREE and it is the whole of what the desk says. The risk this pins is not
 * that the chip goes missing; it is that a later sentence attaches an
 * instruction to it — "Results in 2 days, consider trimming" is the exact shape
 * SEBI's line forbids, and it would arrive as copy, not as a formula.
 */
describe("the results chip states a date fact and nothing follows it", () => {
  it("spells today and tomorrow out, and counts the rest", () => {
    expect(resultsChip(0)).toBe("Results today");
    expect(resultsChip(1)).toBe("Results tomorrow");
    expect(resultsChip(12)).toBe("Results in 12 days");
  });

  it("passes the desk's own banned vocabulary", () => {
    for (const s of [resultsChip(0), resultsChip(1), resultsChip(9), DESK_COPY.resultsMissing, DESK_COPY.resultsPast]) {
      expect(BANNED.test(s), s).toBe(false);
    }
  });

  it("the row and the detail pane both render it, from the shared helper", () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));
    // TWO renders, counted rather than merely present: the row's identity cell
    // and the detail pane's block. `toContain` alone stayed green when the row
    // chip was deleted, because the pane's copy of the call satisfied it.
    const chips = [...src.matchAll(/resultsChip\(resultsIn\)/g)].length;
    expect(chips, "one chip on the row, one in the detail pane").toBe(2);
    const derived = [...src.matchAll(/daysToResults\(row\.resultsDate, today\)/g)].length;
    expect(derived, "derived from ONE date and today in both places — never a per-row number").toBe(2);
    expect(src, "the identity cell renders it as a chip beside the row's own facts").toMatch(
      /resultsIn !== null && \(\s*<Badge[\s\S]{0,120}resultsChip\(resultsIn\)/,
    );
    expect(src, "the detail pane block").toContain('title="Results date"');
    // FREE (Q-9). A results date behind <ProLock> would gate a fact about the
    // company, which is invariant 7's line, not a Pro analytic.
    expect(src).not.toMatch(/resultsChip[\s\S]{0,80}ProLock/);
  });

  it("says nothing about a date that has passed except that it has", () => {
    expect(DESK_COPY.resultsPast).toBe("That date has passed.");
    expect(DESK_COPY.resultsPast).not.toMatch(/\bago\b/);
  });
});

/**
 * v4.1 — `lockedInProfitP` reaches the screen.
 *
 * `lib/live/heat.ts` has computed it since v4.0 and published it on `HeatView`,
 * and no surface rendered it: heat counts each row as `max(riskAtStopP, 0)`, so
 * a stop that has trailed beyond entry contributes nothing, and the money it
 * would return was dropped off the screen as well as out of the sum. The line
 * states it WITHOUT netting it into heat — and without implying the money is
 * already banked, because a stop is not a fill.
 */
describe("locked-in profit at stop is stated, not netted and not promised", () => {
  it("names the arithmetic and its condition", () => {
    const line = lockedInAtStop("₹10,000.00");
    expect(line.startsWith("Locked in at stop ₹10,000.00")).toBe(true);
    expect(line).toContain("computed");
    expect(line).toContain("if every stop is hit");
  });

  it("never claims the money is secured", () => {
    const line = lockedInAtStop("₹10,000.00");
    for (const claim of [/\bprotected\b/i, /\bsafe\b/i, /\bguaranteed\b/i, /\bbanked\b/i, /\bsecured\b/i, /\brealised\b/i]) {
      expect(claim.test(line), `${claim} in: ${line}`).toBe(false);
    }
    expect(BANNED.test(line), line).toBe(false);
  });

  it("the heat strip renders it, inside the Pro branch", () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));
    expect(src).toContain("lockedInAtStop(fmt.money(heat.lockedInProfitP))");
    // It must sit AFTER the `!pro || heat === null` lock, i.e. in the same
    // branch that prints the heat percentage — heat is Pro (Q55).
    const lock = src.indexOf("!pro || heat === null");
    const line = src.indexOf("lockedInAtStop(");
    expect(lock, "the Pro lock is gone from the heat tile").toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(lock);
    // …and it must not be folded into the heat figure itself.
    expect(src).not.toContain("heat.openRiskP - heat.lockedInProfitP");
  });
});

/**
 * FW-1 — the stream's connection line, and the once-a-day connect prompt.
 *
 * TWO OBLIGATIONS a screenshot cannot prove:
 *
 *   1. THE STRIP DESCRIBES THE PIPE, NEVER THE PRICES. "Live" is a claim about
 *      the CONNECTION; each mark keeps stating its own staleness per row
 *      through `stalenessLabel()`, so a polled LTP still reads "Delayed" while
 *      the strip reads "Live". A strip that upgraded a delayed print into a
 *      tick would be the desk asserting a provenance it does not have.
 *   2. THE PROMPT'S TWO SENTENCES ARE SINGLE-SOURCED. `LIVE_FEED_COPY.connect`
 *      and `LIVE_FEED_COPY.dailyReauth` are pinned verbatim by
 *      `tests/live-feed-copy.test.ts` — including the owner's ruling that the
 *      daily re-sign-in is attributed to the user's BROKER and names no
 *      regulator. A second copy of either on the desk is a second thing to
 *      drift, and the drift would be a regulatory claim.
 */
describe("the live stream's connection line says what it can support", () => {
  it("states the connection, the provider and the age of the last frame", () => {
    expect(LIVE_STREAM_COPY.live("openalgo", 3)).toBe("Live · openalgo · 3 s");
    expect(LIVE_STREAM_COPY.reconnecting).toBe("Reconnecting…");
    expect(LIVE_STREAM_COPY.stopped("the bridge is not answering.")).toBe(
      "Feed stopped — the bridge is not answering.",
    );
  });

  it("says CONNECTED, not Live, for a pipe that has carried no prices", () => {
    // The route heartbeats every 25 s whether or not it ever subscribed, and
    // outside 09:00–15:40 it never subscribes at all — so a heartbeat counted
    // as a live frame printed `Live · openalgo · 3 s` at 21:00 with no poll
    // running behind it. `tests/live-stream-link.test.ts` drives which frame
    // earns which phase; this is what the earned phase SAYS.
    expect(LIVE_STREAM_COPY.connected("openalgo")).toBe("Connected · openalgo · no prices yet");
    expect(LIVE_STREAM_COPY.connected("openalgo")).not.toContain("Live");
    // It claims nothing about WHY there are no prices: the desk ships no
    // exchange calendar, so "outside market hours" is not a fact it holds.
    expect(LIVE_STREAM_COPY.connected("openalgo")).not.toMatch(/market hours|holiday|closed/i);
  });

  it("announces the LINK's transitions, with no number and no price (F7)", () => {
    // One polite region on the strip replaced `aria-live` on every Mark cell.
    // Every string here is constant per phase, so a 30 s clock tick cannot
    // re-announce a state that has not changed.
    expect(LIVE_STREAM_COPY.announce.idle, "the state a page mounts in is not an event").toBe("");
    expect(LIVE_STREAM_COPY.announce.connected).toBe("Feed connected.");
    expect(LIVE_STREAM_COPY.announce.live).toBe("Feed connected.");
    expect(LIVE_STREAM_COPY.announce.reconnecting).toBe("Feed reconnecting.");
    expect(LIVE_STREAM_COPY.announce.paused).toBe("Feed paused.");
    expect(LIVE_STREAM_COPY.announce.stopped).toBe("Feed stopped.");
    for (const line of Object.values(LIVE_STREAM_COPY.announce)) {
      expect(/\d/.test(line), `${line} carries a number, so it re-announces`).toBe(false);
      expect(BANNED.test(line), line).toBe(false);
    }
  });

  it("never upgrades a delayed print into a tick, and never names a price", () => {
    const lines = [
      LIVE_STREAM_COPY.live("openalgo", 3),
      LIVE_STREAM_COPY.connected("openalgo"),
      LIVE_STREAM_COPY.connecting,
      LIVE_STREAM_COPY.reconnecting,
      LIVE_STREAM_COPY.paused,
      LIVE_STREAM_COPY.stopped(LIVE_STREAM_COPY.stoppedNoReason),
      ...Object.values(LIVE_STREAM_COPY.announce),
    ];
    for (const line of lines) {
      expect(BANNED.test(line), line).toBe(false);
      // "real-time", "tick" and "live price" are all claims about the DATA.
      // The only "Live" that ships is about the connection, and it is followed
      // by the provider's own id — never by a price or a staleness word.
      expect(/real[- ]?time|\btick\b|live price/i.test(line), line).toBe(false);
    }
  });

  it("says WHY a background tab stopped updating, rather than looking broken", () => {
    expect(LIVE_STREAM_COPY.paused).toMatch(/background/i);
  });

  it("the strip renders it only for a streaming provider", () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));
    expect(src).toMatch(/const linkLabel = !streaming\s*\?\s*null/);
    expect(src).toContain('data-testid="live-stream-state"');
    // …and the `connected` line is really reachable from the strip, or the
    // heartbeat-only state falls through to "Connecting…" for ever.
    expect(src).toContain("LIVE_STREAM_COPY.connected(feed.providerId)");
  });
});

describe("the connect prompt borrows its sentences and restates neither", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));

  it("renders the imported constants, not literals", () => {
    expect(src).toContain("{LIVE_FEED_COPY.connect}");
    expect(src).toContain("{LIVE_FEED_COPY.dailyReauth}");
  });

  it("carries no second copy of either sentence anywhere under components/live", () => {
    // A copied sentence is a sentence that drifts, and `dailyReauth` is the one
    // the owner already had to soften once (it used to name a regulator).
    for (const file of files()) {
      // Comment-stripped, like every other guard here: a comment quoting the
      // sentence is documentation, and only a STRING is copy.
      const raw = stripComments(fs.readFileSync(file, "utf8"));
      expect(raw, `${path.relative(ROOT, file)} restates the connect prompt`).not.toContain(
        "Connect your feed — 20 seconds",
      );
      expect(raw, `${path.relative(ROOT, file)} restates the re-authentication sentence`).not.toContain(
        "expires every day and has to be signed in again",
      );
    }
  });

  it("its own chrome names no regulator and prompts no transaction", () => {
    for (const line of Object.values(CONNECT_PROMPT_COPY)) {
      expect(BANNED.test(line), line).toBe(false);
      expect(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i.test(line), line).toBe(false);
    }
    // It says who holds the credential, because that is the one thing a user
    // hands to a bridge and the one thing Vyuha must never hold.
    expect(CONNECT_PROMPT_COPY.body).toContain("Vyuha never holds the broker credential");
  });

  it("is dismissible for the DAY, and says so on the control", () => {
    expect(CONNECT_PROMPT_COPY.dismissTitle).toMatch(/until tomorrow/i);
    expect(src).toContain("writeStored(promptKey, connectPromptDismissal())");
  });
});
