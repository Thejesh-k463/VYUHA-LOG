import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPENALGO_STREAM_HINT, openAlgoSaveFields } from "@/components/import/broker-connect";
import { LIVE_STREAM_COPY } from "@/components/live/desk-copy";
import {
  LIVE_FEED_COPY,
  feedStreamLine,
  openAlgoStreamText,
  type FeedStreamHealth,
} from "@/components/settings/live-feed-card";
import { OPENALGO_DISCLOSURE_VERSION, OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { OPENALGO_WS_PORT } from "@/lib/import/api/openalgo";
import { STREAM_CLOSE_GRACE_MS, STREAM_QUIET_MS, type OpenAlgoStreamHealth } from "@/lib/quotes/openalgo-stream";

/**
 * v4.7.0 wave C7, Builder B — the OpenAlgo WebSocket feed as the USER reads it.
 *
 * Builder A's tests hold the socket (tests/openalgo-stream*.test.ts) and the
 * egress guard holds where it may go (tests/egress-guard.test.ts). This file
 * holds the other half of each seam: the consent sheet, the docs, the Settings
 * card, the desk's strip and the Import form say what that code does — the
 * same numbers, read from the same constants, and nothing the code does not do.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");

/* ───────────────────────── the disclosure "5", amended ───────────────────────── */

describe("the OpenAlgo disclosure is AMENDED for the stream, never bumped (D-6)", () => {
  const item2 = OPENALGO_FEED_ITEMS[1];
  const item3 = OPENALGO_FEED_ITEMS[2];
  const item5 = OPENALGO_FEED_ITEMS[4];

  it('the version is still "5" — no install accepts "5" before v4.7.0 ships', () => {
    // Literal on purpose: a test that followed the constant would go green on "6".
    expect(OPENALGO_DISCLOSURE_VERSION).toBe("5");
  });

  it("item 2 leads with the stream and no longer claims 1–5 s as the primary cadence", () => {
    expect(item2.title, "the title still leads with the poll").not.toMatch(/every 1 to 5 seconds/i);
    expect(item2.title).toMatch(/one price stream/);
    const first = item2.body.split(/(?<=\.)\s+/)[0];
    expect(first, "the body's first sentence is not the stream").toMatch(/holds one streaming connection to your bridge/);
    // The slider range survives — as the FALLBACK interval.
    expect(item2.body).toMatch(/asked for the old way, at the interval you set on the slider/);
    expect(item2.body).toMatch(/outside 1 to 5 seconds is clamped/);
    // The Telegram sentence is unchanged from C5.
    expect(item2.body).toContain("Only if you turn on Telegram stop/target alerts (Pro)");
  });

  it("item 2's two 30-second figures are the stream module's constants", () => {
    const quiet = item2.body.match(/no streamed price for (\d+) seconds/);
    expect(quiet, "the quiet rule is not stated").not.toBeNull();
    expect(Number(quiet![1]) * 1000, "the quiet window disagrees with STREAM_QUIET_MS").toBe(STREAM_QUIET_MS);
    const grace = item2.body.match(/closes within (\d+) seconds of the desk closing/);
    expect(grace, "the close grace is not stated").not.toBeNull();
    expect(Number(grace![1]) * 1000, "the close grace disagrees with STREAM_CLOSE_GRACE_MS").toBe(STREAM_CLOSE_GRACE_MS);
    // …and the route's window-end stop (owner answer Q4).
    expect(item2.body).toMatch(/at the end of the live window/);
  });

  it("item 3 says the key goes once PER CONNECTION and the stream carries the same symbols (review R10)", () => {
    expect(item3.body).toContain("your API key once per connection, in the message that signs it in");
    expect(item3.body).toContain("the same symbols and exchanges in the messages that start and stop each symbol's prices");
    expect(item3.body).toMatch(/are in neither/);
  });

  it("item 5 sends the stream to the same machine, on OPENALGO_WS_PORT, and says ws:// is unencrypted", () => {
    expect(item5.body).toContain(`streaming port ${OPENALGO_WS_PORT}`);
    expect(item5.body).toContain("the same machine as the address you saved");
    expect(item5.body).toContain("WEBSOCKET_URL");
    expect(item5.body).toMatch(/refuses a streaming address on any other machine/);
    expect(item5.body).toMatch(/a ws:\/\/ stream is not encrypted/);
  });

  it("the 'ticks are never written' item stays TRUE — the stream module imports no database", () => {
    const DB_IMPORT = /from\s+["'](?:@\/lib\/db[^"']*|drizzle-orm[^"']*|better-sqlite3|@\/lib\/queries\/[^"']*)["']/;
    expect(DB_IMPORT.test('import { db } from "@/lib/db";'), "the scan really can fire").toBe(true);
    const src = read("lib/quotes/openalgo-stream.ts");
    expect(DB_IMPORT.test(src), "lib/quotes/openalgo-stream.ts imports a database module").toBe(false);
    expect(OPENALGO_FEED_ITEMS[5].title).toBe("Prices refresh on screen only — ticks are never written");
  });
});

/* ───────────────────────── one port, written once ───────────────────────── */

describe("every surface that names the streaming port names OPENALGO_WS_PORT (review R6 d)", () => {
  it("no file under lib/ app/ components/ writes the number except the one that defines it", () => {
    const offenders = ["lib", "app", "components"]
      .flatMap((d) => walk(path.join(ROOT, d)))
      .filter((f) => new RegExp(`\\b${OPENALGO_WS_PORT}\\b`).test(fs.readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => f !== "lib/import/api/openalgo.ts");
    expect(offenders, `typed the streaming port instead of interpolating OPENALGO_WS_PORT: ${offenders.join(", ")}`).toEqual([]);
  });

  /** What a reader sees: comments and markup out, markdown emphasis out, wrap joined. */
  const flat = (text: string) =>
    text
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ");

  const DOCS = ["docs/client/PRIVACY.md", "docs/client/OPENALGO_SETUP_GUIDE.html", "docs/client/README.md"];

  it.each(DOCS)("%s names the default streaming port, and only that one", (doc) => {
    const text = flat(read(doc));
    const named = [...text.matchAll(/streaming port (\d+)/g)].map((m) => Number(m[1]));
    expect(named.length, `${doc} never names the streaming port`).toBeGreaterThan(0);
    for (const n of named) expect(n, `${doc} names streaming port ${n}`).toBe(OPENALGO_WS_PORT);
  });

  it("the Import form's hint interpolates the constant", () => {
    expect(OPENALGO_STREAM_HINT).toBe(
      `Leave empty for OpenAlgo's default (ws://<host>:${OPENALGO_WS_PORT}). Running more than one OpenAlgo? Copy WEBSOCKET_URL from that instance's .env.`,
    );
  });
});

/* ───────────────────────── the desk's strip ───────────────────────── */

describe("the strip says stream / poll for the OpenAlgo bridge only (design D11, review R5)", () => {
  it("names the path that priced the last batch", () => {
    expect(LIVE_STREAM_COPY.live("openalgo", 3, "stream")).toBe("Live · OpenAlgo stream · 3 s");
    expect(LIVE_STREAM_COPY.live("openalgo", 3, "poll")).toBe("Live · OpenAlgo poll · 3 s");
  });

  it("every other provider — the e2e mock included — prints exactly what it printed before C7", () => {
    expect(LIVE_STREAM_COPY.live("mock", 3, "stream")).toBe("Live · mock · 3 s");
    expect(LIVE_STREAM_COPY.live("upstox", 4, "poll")).toBe("Live · upstox · 4 s");
    expect(LIVE_STREAM_COPY.live("angelone", 5, "stream")).toBe("Live · angelone · 5 s");
    // …and an OpenAlgo link that has not yet had a tick.
    expect(LIVE_STREAM_COPY.live("openalgo", 3, null)).toBe("Live · openalgo · 3 s");
    expect(LIVE_STREAM_COPY.live("openalgo", 3)).toBe("Live · openalgo · 3 s");
  });

  it("the desk hands the link's transport to the strip", () => {
    expect(read("components/live/tracker-client.tsx")).toContain(
      "LIVE_STREAM_COPY.live(feed.providerId, frameAgeS, link.transport)",
    );
  });
});

/* ───────────────────────── the Settings card ───────────────────────── */

describe("Settings → Live feed shows the stream state and names the slider as the fallback", () => {
  const S = (state: FeedStreamHealth["state"], reason: string | null = null): FeedStreamHealth => ({
    state,
    reason,
    since: null,
  });

  it("the card's stream shape is the provider's (a client-safe restatement, held assignable both ways)", () => {
    const fromServer: OpenAlgoStreamHealth = { state: "polling", reason: "r", since: null };
    const card: FeedStreamHealth = fromServer;
    const back: OpenAlgoStreamHealth = card;
    expect(back).toEqual(fromServer);
  });

  it("says each state in the provider's own words", () => {
    expect(openAlgoStreamText(S("streaming", "Streaming from ws://127.0.0.1:4051."), 3)).toBe(
      "Streaming from ws://127.0.0.1:4051.",
    );
    expect(openAlgoStreamText(S("polling", "Outside market hours — the stream opens only while the live window is open."), 3)).toBe(
      "Polling every 3 s — Outside market hours — the stream opens only while the live window is open.",
    );
    expect(openAlgoStreamText(S("polling"), 5)).toBe("Polling every 5 s");
    expect(openAlgoStreamText(S("off"), 3)).toBe("Stream starts when the Live Desk opens in market hours.");
    expect(openAlgoStreamText(S("connecting"), 3)).toBe(LIVE_FEED_COPY.streamConnecting);
    expect(openAlgoStreamText(S("streaming"), 3)).toBe(LIVE_FEED_COPY.streamOn);
    expect(openAlgoStreamText(null, 3), "no stream block, nothing said").toBeNull();
  });

  it("is said only for an EFFECTIVE OpenAlgo pick, from an answer about OpenAlgo", () => {
    const health = { provider: "openalgo", stream: S("streaming", "Streaming from ws://127.0.0.1:8765.") };
    expect(feedStreamLine({ pick: "openalgo", blocked: false, health, seconds: 3 })).toBe("Streaming from ws://127.0.0.1:8765.");
    expect(feedStreamLine({ pick: "upstox", blocked: false, health, seconds: 3 }), "another pick").toBeNull();
    expect(feedStreamLine({ pick: "openalgo", blocked: true, health, seconds: 3 }), "a blocked pick").toBeNull();
    expect(
      feedStreamLine({ pick: "openalgo", blocked: false, health: { provider: "eod", stream: null }, seconds: 3 }),
      "end-of-day's health has no stream",
    ).toBeNull();
    expect(feedStreamLine({ pick: "openalgo", blocked: false, health: null, seconds: 3 }), "not answered yet").toBeNull();
  });

  it("renders the line, and labels the slider as the fallback under OpenAlgo only", () => {
    const src = read("components/settings/live-feed-card.tsx");
    expect(src).toContain('data-testid="live-feed-stream"');
    expect(src).toMatch(/feedStreamLine\(\{ pick: provider, blocked: blocked !== null, health, seconds \}\)/);
    expect(src).toContain('{provider === "openalgo" ? LIVE_FEED_COPY.fallbackLabel : "On-screen refresh"}');
    expect(LIVE_FEED_COPY.fallbackLabel).toBe("Fallback refresh");
    expect(LIVE_FEED_COPY.fallback).toBe(
      "Used for symbols the stream has not priced, and whenever streaming is unavailable.",
    );
    expect(LIVE_FEED_COPY.remote, "the remote-host sentence does not name the stream").toMatch(/over its price stream/);
    expect(LIVE_FEED_COPY.remote, "the remote-host sentence still says every few seconds").not.toMatch(/every few seconds/);
  });
});

/* ───────────────────────── the Import form ───────────────────────── */

describe("the OpenAlgo form's streaming address (owner answer D2')", () => {
  it("sends the box's value — an empty string clears — and omits an untouched box", () => {
    const base = { host: "http://127.0.0.1:5050", underlyingBroker: "upstox" };
    expect(openAlgoSaveFields({ ...base, wsUrl: null }), "an untouched box must let the server keep the stored one").toEqual(base);
    expect("wsUrl" in openAlgoSaveFields({ ...base, wsUrl: null })).toBe(false);
    expect(openAlgoSaveFields({ ...base, wsUrl: "" })).toEqual({ ...base, wsUrl: "" });
    expect(openAlgoSaveFields({ ...base, wsUrl: "  ws://127.0.0.1:4051 " })).toEqual({ ...base, wsUrl: "ws://127.0.0.1:4051" });
  });

  it("is wired: prefilled from the GET's openalgoWsUrl, bound to the box, sent on save", () => {
    const src = read("components/import/broker-connect.tsx");
    expect(src).toMatch(/if \(oa\.openalgoWsUrl\) \{\s*setWsUrl\(\(prev\) => \(prev === null \? oa\.openalgoWsUrl! : prev\)\);/);
    expect(src).toContain('value={wsUrl ?? ""}');
    expect(src).toContain("onChange={(e) => setWsUrl(e.target.value)}");
    expect(src).toContain('...(active === "openalgo" ? openAlgoSaveFields({ host, underlyingBroker, wsUrl }) : {})');
    expect(src).toContain("{OPENALGO_STREAM_HINT}");
  });
});
