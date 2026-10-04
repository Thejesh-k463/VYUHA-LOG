import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createOpenAlgoStream, STREAM_MODE, type OpenAlgoStream } from "@/lib/quotes/openalgo-stream";
import type { Quote, QuoteKey } from "@/lib/quotes/types";
import { startFakeOpenAlgoServer, type FakeConnection, type FakeOpenAlgoServer } from "./helpers/fake-openalgo-ws";

/**
 * The OpenAlgo stream over a REAL socket (v4.7.0 C7, design §2 Builder A).
 *
 * `tests/openalgo-stream.test.ts` drives the manager with a fake socket class
 * and a fake clock; this file proves the same module works with the socket the
 * app actually ships — Node's own global `WebSocket` (undici; no dependency, no
 * `webSocketImpl`) — against a minimal RFC 6455 server
 * (`tests/helpers/fake-openalgo-ws.ts`) scripted with the wire shapes research
 * R11 recorded from OpenAlgo's `server.py`: the auth reply
 * `{"type":"auth","status":"success"}`, the error shape with no `type`, the
 * `partial` subscribe ack, `market_data` frames, a protocol ping, and the
 * 4401 close. Real timers, 127.0.0.1 on an ephemeral port; the whole file runs
 * well under 2 s.
 */

const KEY = "wire-api-key-7f3a";
const TCS: QuoteKey = { symbol: "TCS", exchange: "NSE" };
const BAD: QuoteKey = { symbol: "BADSYM", exchange: "NSE" };
const ref = (k: QuoteKey) => ({ id: `${k.exchange}:${k.symbol}`, key: k, symbol: k.symbol, exchange: k.exchange });

let server: FakeOpenAlgoServer;
let stream: OpenAlgoStream | null = null;
let quotes: Quote[] = [];

beforeAll(async () => {
  server = await startFakeOpenAlgoServer();
});
afterAll(async () => {
  await server.stop();
});
afterEach(() => {
  stream?.dispose();
  stream = null;
  quotes = [];
  server.onMessage = () => {};
});

async function until(cond: () => boolean, label: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A manager on the real socket class, pointed at the fake server. */
function open(): { s: OpenAlgoStream; conn: () => FakeConnection } {
  const before = server.connections.length;
  stream = createOpenAlgoStream({ onQuote: (_id, q) => quotes.push(q), isLiveWindow: () => true });
  stream.setTarget({ apiKey: KEY, host: "http://127.0.0.1:5000", wsUrl: server.url });
  return { s: stream, conn: () => server.connections[before] };
}

function okAuth(conn: FakeConnection, msg: unknown) {
  const m = msg as { action?: string; api_key?: string };
  if (m.action === "authenticate" && m.api_key === KEY) {
    conn.send({ type: "auth", status: "success", message: "Authentication successful", broker: "upstox", user_id: "u1" });
  }
}

describe("the real Node WebSocket against an RFC 6455 OpenAlgo stand-in", () => {
  it("authenticates, subscribes once in mode 2, applies a PARTIAL ack, and turns market_data into paise", async () => {
    server.onMessage = (conn, msg) => {
      okAuth(conn, msg);
      const m = msg as { action?: string; request_id?: string };
      if (m.action === "subscribe") {
        conn.send({
          type: "subscribe",
          status: "partial",
          request_id: m.request_id,
          subscriptions: [
            { symbol: "TCS", exchange: "NSE", status: "success", mode: "Quote", depth: 5, broker: "upstox" },
            { symbol: "BADSYM", exchange: "NSE", status: "error", message: "Symbol BADSYM not found", broker: "upstox" },
          ],
          message: "Subscription processing complete",
          broker: "upstox",
        });
        conn.send({
          type: "market_data",
          symbol: "TCS",
          exchange: "NSE",
          mode: 2,
          broker: "upstox",
          data: { ltp: 3101.55, open: 3090, high: 3110.2, low: 3085.05, close: 3088.4, volume: 120034, timestamp: Date.now() },
        });
      }
    };
    const { s, conn } = open();
    s.hold([ref(TCS), ref(BAD)]);
    await until(() => quotes.length === 1, "the first streamed quote");

    const c = conn();
    expect(c.received[0], "the key goes once, in the authenticate message").toEqual({ action: "authenticate", api_key: KEY });
    const sub = c.received[1] as { action: string; symbols: unknown[]; mode: number; request_id: string };
    expect(sub.action).toBe("subscribe");
    expect(sub.mode).toBe(STREAM_MODE);
    expect(typeof sub.request_id).toBe("string");
    expect(sub.symbols).toEqual([
      { symbol: "TCS", exchange: "NSE" },
      { symbol: "BADSYM", exchange: "NSE" },
    ]);
    expect(JSON.stringify(c.received.slice(1)), "the key travelled in a second message").not.toContain(KEY);

    const q = quotes[0];
    expect(q.ltp).toBe(310155);
    expect(q.prevClose).toBe(308840);
    expect(q.dayHigh).toBe(311020);
    expect(q.volume).toBe(120034);
    expect(q.staleness).toBe("tick");
    expect(s.health().state).toBe("streaming");
    expect(s.isQuiet("NSE:TCS")).toBe(false);
    expect(s.isQuiet("NSE:BADSYM"), "a refused key stays quiet — the REST poll keeps it priced").toBe(true);
  });

  it("answers the server's protocol ping by itself (OpenAlgo closes a client that does not, R11 A15)", async () => {
    server.onMessage = okAuth;
    const { s, conn } = open();
    s.hold([ref(TCS)]);
    await until(() => (conn()?.received.length ?? 0) >= 2, "auth + subscribe");
    conn().ping("hb-20s");
    await until(() => conn().pongs.includes("hb-20s"), "the pong");
    expect(conn().ended).toBe(false);
  });

  it("an AUTHENTICATION_ERROR (no `type` on the reply) closes OUR side and reports OpenAlgo's words, never the key", async () => {
    server.onMessage = (conn, msg) => {
      if ((msg as { action?: string }).action === "authenticate") {
        conn.send({ status: "error", code: "AUTHENTICATION_ERROR", message: "Invalid API key" });
      }
    };
    const { s, conn } = open();
    s.hold([ref(TCS)]);
    await until(() => conn()?.clientCloseCode != null, "the client's close frame");
    expect(conn().clientCloseCode).toBe(1000);
    const h = s.health();
    expect(h.state).toBe("polling");
    expect(h.reason).toContain("Invalid API key");
    expect(h.reason).toContain(server.url);
    expect(h.reason).not.toContain(KEY);
  });

  it("a 4401 close (OpenAlgo's auth timeout) puts the feed on polling with the code named", async () => {
    server.onMessage = (conn, msg) => {
      if ((msg as { action?: string }).action === "authenticate") conn.close(4401, "auth timeout");
    };
    const { s } = open();
    s.hold([ref(TCS)]);
    await until(() => s.health().state === "polling", "the polling state");
    expect(s.health().reason).toMatch(/4401/);
  });

  it("dispose() closes the server-side socket", async () => {
    server.onMessage = okAuth;
    const { s, conn } = open();
    s.hold([ref(TCS)]);
    await until(() => (conn()?.received.length ?? 0) >= 2, "auth + subscribe");
    s.dispose();
    await until(() => conn().ended, "the server-side socket to end");
    expect(conn().clientCloseCode).toBe(1000);
  });
});
