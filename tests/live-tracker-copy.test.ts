import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ANGELONE_CADENCE_NO_COUNT,
  CONNECT_PROMPT_COPY,
  angelOneCadenceLine,
  deskAngelOneCadence,
  DESK_COPY,
  NOT_PRICED_BY_FEED,
  showsNotPricedByFeed,
  EM_DASH,
  LIVE_STREAM_COPY,
  lockedInAtStop,
  needsSessions,
  resultsChip,
  stalenessLabel,
  stopLabel,
} from "@/components/live/desk-copy";
import { ANGELONE_FEED_COPY, LIVE_FEED_COPY } from "@/components/settings/live-feed-card";

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

  it("says CONNECTED, not Live, for a pipe with nothing streaming down it", () => {
    // The route heartbeats every 25 s whether or not it ever subscribed, and
    // outside 09:00–15:40 it never subscribes at all — so a heartbeat counted
    // as a live frame printed `Live · openalgo · 3 s` at 21:00 with no poll
    // running behind it. `tests/live-stream-link.test.ts` drives which frame
    // earns which phase; this is what the earned phase SAYS.
    expect(LIVE_STREAM_COPY.connected("openalgo")).toBe("Connected · openalgo · not streaming");
    expect(LIVE_STREAM_COPY.connected("openalgo")).not.toContain("Live");
    // G4: it states the absence of a STREAM, never the absence of PRICES. The
    // line read "no prices yet" until the fix wave, and the after-hours
    // snapshot ships quotes — `stream-link.ts` pushes them to the rows BEFORE
    // it decides the phase (`tests/live-stream-link.test.ts` pins exactly
    // that) — so the strip denied the prices it had just delivered.
    expect(LIVE_STREAM_COPY.connected("openalgo")).not.toMatch(/no prices|price/i);
    // It claims nothing about WHY nothing is streaming: the desk ships no
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
    // `dailyReauth` is no longer rendered unconditionally (v4.2 seam fix, and
    // the block below is what pins the three cases) — but it is still the
    // imported constant rather than a literal wherever it IS rendered.
    expect(src).toContain("LIVE_FEED_COPY.dailyReauth");
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

/**
 * Ruling 4.2-8 — THE DERIVATIVE MARK LABEL.
 *
 * A feed that quotes cash scrips only leaves every futures and options row on
 * the desk showing a stored number: an imported close, or a mark the user
 * typed. Before this label the row was indistinguishable from a live one, and
 * the strip above it said "Live · upstox · 2 s".
 *
 * WHAT MAKES IT SAFE is what it does NOT do: it states a fact about the feed,
 * names no other product, and nothing follows it. The desk's own vocabulary
 * guard (the BANNED scan above) covers the string as well, since it lives in
 * `components/live/desk-copy.ts`.
 */
describe("a derivative row says which prices are not the feed's (ruling 4.2-8)", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));

  it("is the sentence, verbatim, and it is a statement rather than an instruction", () => {
    expect(NOT_PRICED_BY_FEED).toBe("Not priced by this feed");
    expect(BANNED.test(NOT_PRICED_BY_FEED)).toBe(false);
    // It claims nothing about WHY, and offers nothing to do about it.
    expect(NOT_PRICED_BY_FEED).not.toMatch(/(instead|switch|use|try|upgrade)/i);
  });

  it("labels options and futures under `upstox` and `angelone`, and NOTHING under any other feed", () => {
    // v4.2 ships two cash-only broker feeds, and the label is a fact about the
    // FEED, so both carry it. `openalgo` deliberately does not: the bridge
    // quotes contracts, and labelling its rows would be a false statement.
    for (const id of ["upstox", "angelone"]) {
      expect(showsNotPricedByFeed(id, "option"), id).toBe(true);
      expect(showsNotPricedByFeed(id, "future"), id).toBe(true);
      expect(showsNotPricedByFeed(id, "equity"), id).toBe(false);
      // A row whose instrument type was never recorded is not labelled: the
      // label would be a claim about an instrument nobody has classified.
      expect(showsNotPricedByFeed(id, null), id).toBe(false);
    }
    for (const id of ["openalgo", "eod", "manual", "mock"]) {
      expect(showsNotPricedByFeed(id, "option"), id).toBe(false);
      expect(showsNotPricedByFeed(id, "future"), id).toBe(false);
    }
  });

  it("renders in the MARK cell, beside the staleness pill, from the constant", () => {
    // Same cell as "Stored mark"/"Stale": the label is the same kind of
    // statement — where this number came from — so it belongs where the user
    // already looks for that.
    expect(src).toContain("showsNotPricedByFeed(providerId, row.instrumentType)");
    expect(src).toContain("{NOT_PRICED_BY_FEED}");
    expect(src).toContain("<StalenessChip row={row} newestDay={newestDay} providerId={providerId} />");
  });
});

/**
 * Ruling 4.2-8 — THE UPSTOX CONNECT PROMPT.
 *
 * Same banner, a different sentence and a different destination: the Upstox
 * Analytics token is generated in a browser visit to the broker and saved on
 * the Import screen, so the OpenAlgo headline ("20 seconds" — the measured cost
 * of starting a bridge and signing in) and the OpenAlgo body (start your
 * instance) are both false here.
 */
describe("the Upstox connect prompt says where its token lives", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));

  it("is pinned VERBATIM, and promises no duration", () => {
    expect(CONNECT_PROMPT_COPY.upstoxHeadline).toBe(
      "Connect your feed — Upstox uses the Analytics token saved under Import → Connect broker.",
    );
    expect(CONNECT_PROMPT_COPY.upstoxHeadline).not.toMatch(/second|minute/i);
  });

  it("routes to the Import screen, which is where the token is saved", () => {
    expect(CONNECT_PROMPT_COPY.upstoxHref).toBe("/import");
    expect(src).toContain("href={CONNECT_PROMPT_COPY.upstoxHref}");
    expect(src).toContain("{CONNECT_PROMPT_COPY.upstoxCta}");
  });

  it("swaps BOTH OpenAlgo sentences out, not just the headline", () => {
    // The body tells the reader to start an OpenAlgo instance. Saying that to
    // an Upstox user is an instruction to set up software they are not running.
    expect(src).toContain("<p className=\"text-sm font-medium\">{CONNECT_PROMPT_COPY.upstoxHeadline}</p>");
    // …and the OpenAlgo headline survives as its own literal, which is what
    // the seam guard (tests/seams-v41-fix.test.ts S5b) reads.
    expect(src).toContain("<p className=\"text-sm font-medium\">{LIVE_FEED_COPY.connect}</p>");
    // Widened in the Angel One wave for the same reason, not loosened: the
    // body is rendered for the BRIDGE alone, and there are now two broker
    // feeds it would be wrong for.
    expect(src).toContain(
      "{!upstoxFeed && !angeloneFeed && <p className=\"mt-1 text-muted-foreground\">{CONNECT_PROMPT_COPY.body}</p>}",
    );
    // …and the daily re-sign-in sentence is NOT true of Upstox, so it goes —
    // see "the daily re-sign-in line names the right broker, or nobody" below.
    // This assertion used to read `toContain("{LIVE_FEED_COPY.dailyReauth}")`
    // with the comment "true of Upstox too"; it was neither.
    expect(src).toContain("{upstoxFeed ? null : angeloneFeed ? (");
  });
});

/**
 * THE DAILY RE-SIGN-IN LINE IS A CLAIM ABOUT ONE BROKER (v4.2 seam fix).
 *
 * The prompt printed `LIVE_FEED_COPY.dailyReauth` — "Your broker's API session
 * expires every day and has to be signed in again" — under ALL THREE feeds.
 * Under Upstox that is false (the Analytics token is read-only for about a
 * year, which `UPSTOX_FEED_COPY.blurb` says two lines away, and the Settings
 * card already suppresses the sentence for exactly that reason). Under Angel
 * One it is half false in the more expensive direction: the session really does
 * die at 5 AM IST, but nobody signs it back in — Vyuha does, from the enrolled
 * TOTP secret — so the generic sentence tells a user to do a chore that does
 * not exist. OpenAlgo is the one feed it was written for, and it is unchanged.
 *
 * The Angel One sentence is REUSED from the Settings card, never restated: one
 * sentence, one source, and the card's own guard
 * (`tests/live-feed-angelone-settings.test.ts`) is what keeps it factual and
 * regulator-free.
 */
describe("the daily re-sign-in line names the right broker, or nobody", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));

  it("is suppressed entirely under Upstox", () => {
    // `upstoxFeed` is the FIRST arm and its branch is `null` — nothing at all,
    // not a softer sentence. The two remaining arms are asserted below.
    const gate = src.match(/\{upstoxFeed \? null : angeloneFeed \? \(([\s\S]{0,600}?)\)\}/);
    expect(gate, "the re-sign-in line is no longer suppressed under Upstox").not.toBeNull();
    expect(gate![1]).toContain("ANGELONE_FEED_COPY.dailyReauth");
    expect(gate![1]).toContain("LIVE_FEED_COPY.dailyReauth");
  });

  it("prints Angel One's own sentence under Angel One, and the generic one otherwise", () => {
    expect(src).toContain("<p className=\"mt-1 text-muted-foreground\">{ANGELONE_FEED_COPY.dailyReauth}</p>");
    // …and the OpenAlgo arm survives as its own literal, which is what the seam
    // guard (tests/seams-v41-fix.test.ts S5b) reads.
    expect(src).toContain("<p className=\"mt-1 text-muted-foreground\">{LIVE_FEED_COPY.dailyReauth}</p>");
    // Imported from the card — a second literal is a second thing to drift.
    expect(src).toMatch(/import \{ ANGELONE_FEED_COPY \} from "@\/components\/settings\/live-feed-card";/);
    expect(src).toContain('import { LIVE_FEED_COPY } from "@/components/settings/live-feed-card"');
    expect(src.split("ANGELONE_FEED_COPY.dailyReauth").length - 1, "a second copy of the Angel One sentence").toBe(1);
    expect(src.split("LIVE_FEED_COPY.dailyReauth").length - 1, "a second copy of the generic sentence").toBe(1);
  });

  it("the two sentences really are different, and neither names a regulator", () => {
    expect(ANGELONE_FEED_COPY.dailyReauth).not.toBe(LIVE_FEED_COPY.dailyReauth);
    expect(ANGELONE_FEED_COPY.dailyReauth).toContain("5 AM IST");
    for (const line of [ANGELONE_FEED_COPY.dailyReauth, LIVE_FEED_COPY.dailyReauth]) {
      expect(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i.test(line), line).toBe(false);
    }
    // The OpenAlgo sentence is unchanged byte for byte — it is the one feed the
    // wording was ever true of.
    expect(LIVE_FEED_COPY.dailyReauth).toBe(
      "Your broker's API session expires every day and has to be signed in again; that is the broker's rule, not Vyuha's.",
    );
  });
});

/**
 * Ruling 4.2-8 again — THE ANGEL ONE CONNECT PROMPT, and ruling 4.2-4's
 * cadence line on the strip.
 *
 * The prompt is the third headline in the same banner. Angel One's credential
 * is the client code, PIN and TOTP secret already saved on the Import screen,
 * so the OpenAlgo headline ("20 seconds") and the OpenAlgo body (start your
 * instance) are both false here, exactly as they are for Upstox — and no
 * duration is promised in their place, because the daily sign-in is unattended
 * and there is nothing for the user to time.
 *
 * The cadence line is on the strip because Angel One has no slider to point at:
 * its interval is derived from the size of the book, so the desk states it.
 */
describe("the Angel One connect prompt and cadence line", () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));

  it("is pinned VERBATIM, and promises no duration", () => {
    expect(CONNECT_PROMPT_COPY.angeloneHeadline).toBe(
      "Connect your feed — Angel One uses the client code, PIN and TOTP secret saved under Import → Connect broker.",
    );
    expect(CONNECT_PROMPT_COPY.angeloneHeadline).not.toMatch(/second|minute/i);
    expect(BANNED.test(CONNECT_PROMPT_COPY.angeloneHeadline)).toBe(false);
  });

  it("routes to the Import screen, which is where those credentials are saved", () => {
    expect(CONNECT_PROMPT_COPY.angeloneHref).toBe("/import");
    expect(src).toContain("href={CONNECT_PROMPT_COPY.angeloneHref}");
    expect(src).toContain("{CONNECT_PROMPT_COPY.angeloneCta}");
  });

  it("swaps BOTH OpenAlgo sentences out for it too", () => {
    expect(src).toContain("<p className=\"text-sm font-medium\">{CONNECT_PROMPT_COPY.angeloneHeadline}</p>");
    // …and the other two headlines survive as their own literals.
    expect(src).toContain("<p className=\"text-sm font-medium\">{CONNECT_PROMPT_COPY.upstoxHeadline}</p>");
    expect(src).toContain("<p className=\"text-sm font-medium\">{LIVE_FEED_COPY.connect}</p>");
  });

  /**
   * A-5 — THE STRIP COUNTED THE WRONG THING, AND SAID SO CONFIDENTLY.
   *
   * The desk printed `angelOneCadenceLine(rows.length)`: one row per open
   * TRADE. The adapter paces on the DEDUPED quote-key count (`quoteKeyId` =
   * exchange:tradingsymbol — two trades in one scrip are two rows and ONE key)
   * and the Settings card states `openPositionKeys().length`, which is that
   * same deduped set. So a 51-row / 50-key book read "every 5 seconds … 2
   * calls" on the desk while the poll ran at 3 s and one call and Settings said
   * 3 s. Ruling 4.2-4 asks for ONE sentence on both surfaces; two different
   * denominators cannot produce one sentence.
   *
   * These are BEHAVIOUR tests over the shared derivation, not a pin on the
   * source text of the old call — the old pin was green throughout the defect,
   * because it asserted exactly the expression that was wrong.
   */
  it("51 rows in 50 scrips reads 3 seconds and 1 call — what the poll really does", () => {
    const line = deskAngelOneCadence({ providerId: "angelone", linkSymbolCount: 50, feedSymbolCount: null });
    expect(line).toContain("Refreshes every 3 seconds");
    expect(line).toContain("your 50 open positions take 1 call per refresh");
    // …and the sentence the row count used to produce is a DIFFERENT one, so
    // this test can tell the fix from the defect.
    expect(angelOneCadenceLine(51)).toContain("Refreshes every 5 seconds");
    expect(angelOneCadenceLine(51)).toContain("2 calls per refresh");
    expect(line).not.toBe(angelOneCadenceLine(51));
  });

  it("takes the LIVE stream's count first, then the server render's, then none", () => {
    const at = (linkSymbolCount: number | null, feedSymbolCount: number | null) =>
      deskAngelOneCadence({ providerId: "angelone", linkSymbolCount, feedSymbolCount });
    // The open stream's own snapshot frame is the only count true of the poll
    // running now, so it wins whenever it exists.
    expect(at(50, 51)).toBe(angelOneCadenceLine(50));
    // One page render older, but the same deduped arithmetic.
    expect(at(null, 50)).toBe(angelOneCadenceLine(50));
    // Neither: the sentence loses its count rather than borrowing a wrong one.
    expect(at(null, null)).toBe(ANGELONE_CADENCE_NO_COUNT);
    expect(at(null, null)).not.toMatch(/\d+ open position/);
    expect(at(null, null), "an interval nobody computed").not.toMatch(/every \d+ seconds/);
  });

  it("says nothing at all under any other feed", () => {
    for (const providerId of ["openalgo", "upstox", "eod", "manual", "mock"]) {
      expect(deskAngelOneCadence({ providerId, linkSymbolCount: 50, feedSymbolCount: 50 })).toBeNull();
    }
  });

  it("the countless sentence is descriptive, and states the provider's own limit", () => {
    expect(BANNED.test(ANGELONE_CADENCE_NO_COUNT), ANGELONE_CADENCE_NO_COUNT).toBe(false);
    expect(ANGELONE_CADENCE_NO_COUNT).toContain("about one request a second");
    expect(ANGELONE_CADENCE_NO_COUNT).toContain("50 symbols to a batch");
  });

  it("the desk renders THAT derivation, and no longer counts rows", () => {
    expect(src).toContain('const angeloneFeed = feed.providerId === "angelone";');
    expect(src, "the desk still computes the cadence from its row count").not.toContain(
      "angelOneCadenceLine(rows.length)",
    );
    expect(src).toContain("linkSymbolCount: link.symbolCount");
    expect(src).toContain("feedSymbolCount: feed.symbolCount ?? null");
    expect(src).toContain('data-testid="live-feed-cadence"');
  });

  it("the cadence sentence itself is descriptive, at every tier", () => {
    for (const n of [0, 1, 30, 120, 300, 900]) {
      const line = angelOneCadenceLine(n);
      expect(BANNED.test(line), line).toBe(false);
      expect(line, line).not.toMatch(/alerts?/i);
      expect(line).toMatch(/^Refreshes every (3|5|10) seconds — /);
    }
  });
});

/**
 * A-13 — THE COMMENT THAT DESCRIBED A PREVIOUS RELEASE.
 *
 * `LIVE_STREAM_COPY.connected` explains why it claims no REASON for a silent
 * stream, and the explanation used to be "the desk cannot assert an exchange
 * calendar it does not ship (`lib/live/market-hours.ts` models the clock, not
 * holidays)". v4.2 ships one: `lib/data/nse-holidays.json`, read through
 * `isTradingDayIst()`, which `market-hours.ts` consults. The string is
 * UNCHANGED — the reason for not naming a holiday is the other one, that this
 * label is a statement about the CONNECTION and a quiet bridge on a trading
 * afternoon sends the same frame as one on Republic Day — but a comment that
 * states a fact about another file has to be true of that file.
 */
describe("the strip's own comment tells the truth about the calendar this build ships (A-13)", () => {
  const raw = fs.readFileSync(path.join(ROOT, "components/live/desk-copy.ts"), "utf8");

  it("no longer says the app ships no exchange calendar", () => {
    expect(raw, "the comment still claims market-hours models the clock only").not.toMatch(
      /models the clock, not holidays/,
    );
    expect(raw).toContain("lib/data/nse-holidays.json");
  });

  it("…and the two files it now names really are what it says they are", () => {
    expect(fs.existsSync(path.join(ROOT, "lib/data/nse-holidays.json")), "the bundled calendar").toBe(true);
    const hours = fs.readFileSync(path.join(ROOT, "lib/live/market-hours.ts"), "utf8");
    expect(hours, "market-hours does not consult the calendar after all").toMatch(/isTradingDayIst/);
  });

  it("the STRING is unchanged: it still claims no reason for a silent stream", () => {
    // Deliberate, and re-asserted here so the comment fix cannot drift into a
    // copy change: the label is about the pipe, and a holiday would explain the
    // silence on one day a year and mis-explain it on every other.
    expect(LIVE_STREAM_COPY.connected("upstox")).toBe("Connected · upstox · not streaming");
    expect(LIVE_STREAM_COPY.connected("upstox")).not.toMatch(/holiday|closed|market hours/i);
  });
});

/**
 * A-11 — THE BREADCRUMB NAMES THE SCREEN IT ACTUALLY IS.
 *
 * Owner ruling, 2026-09-07: the phrase is exactly `Import → Connect broker`.
 * The old wording named a tab ("Brokers") that the Import screen does not have,
 * so every sentence that told a user where their token lives sent them to a
 * place with the wrong name.
 */
describe("the Import breadcrumb is the owner's phrase, in every file this wave owns (A-11)", () => {
  const FILES = [
    "components/live/desk-copy.ts",
    "components/settings/live-feed-card.tsx",
    "app/api/live/feed/route.ts",
  ];

  it.each(FILES)("%s says Import → Connect broker, and never Import → Brokers", (rel) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    expect(raw, `${rel} still carries the old breadcrumb`).not.toContain("Import → Brokers");
    expect(raw, `${rel} names the Import screen at all`).toContain("Import → Connect broker");
  });

  it("both connect-prompt headlines carry it, verbatim", () => {
    expect(CONNECT_PROMPT_COPY.upstoxHeadline).toBe(
      "Connect your feed — Upstox uses the Analytics token saved under Import → Connect broker.",
    );
    expect(CONNECT_PROMPT_COPY.angeloneHeadline).toBe(
      "Connect your feed — Angel One uses the client code, PIN and TOTP secret saved under Import → Connect broker.",
    );
  });
});
