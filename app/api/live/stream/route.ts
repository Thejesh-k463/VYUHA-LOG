import { NextResponse } from "next/server";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { getTrackerTrades } from "@/lib/queries/trades";
import { isWithinLiveWindow } from "@/lib/quotes/mapping";
import { getQuoteProvider } from "@/lib/quotes/registry";
import { quoteKeyId, type Exchange, type Quote, type QuoteKey, type Unsubscribe } from "@/lib/quotes/types";

/**
 * `GET /api/live/stream` — the Live Desk's one Server-Sent Events channel.
 *
 * WHY SSE FROM THE SIDECAR AND NOT A SOCKET FROM THE PAGE: Tauri v2 serves the
 * app from `https://tauri.localhost`, so a `ws://` connection opened by the
 * WebView is blocked as mixed content (03D §2.10). Every provider therefore
 * lives server-side and the UI holds one `EventSource`. This is also exactly
 * the code path the hosted web product needs, which is why it is a route and
 * not a Tauri IPC call — the app layer holds zero IPC by design.
 *
 * Frames: `snapshot` once on connect (never extrapolate across a gap — a
 * reconnect gets a fresh snapshot because it is a fresh request), then `tick`
 * frames coalesced to one per 250 ms however fast the provider pushes, then a
 * `heartbeat` every 25 s so an idle EOD desk still proves the pipe is open.
 * The opening `retry:` field is jittered so a sidecar restart does not bring
 * every desk back on the same 1 s boundary.
 *
 * ACCOUNT SCOPE (invariants 8 and 9): the account id is read PER REQUEST from
 * `getSelectedAccountId()` and the symbol set comes from the account-scoped
 * `getTrackerTrades()`. Never a module global — a cached account id in a
 * long-lived stream is a cross-tenant leak the day this ships on the web. This
 * route reads only; id 0 stays a view.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One React commit per 250 ms regardless of tick rate (spec §4.2). */
const COALESCE_MS = 250;
/** Idle keep-alive. Under any proxy's 30–60 s idle timeout. */
const HEARTBEAT_MS = 25_000;
/** Ceiling on the subscription set, before the provider's own cap applies. */
const MAX_KEYS = 500;

const EXCHANGES: readonly Exchange[] = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"];

/** The desktop shell and the dev server; anything else must match the host. */
const LOCAL_ORIGINS = /^(?:tauri\.localhost|localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/**
 * Same-origin guard. There is no shared helper in this repo to reuse — grep
 * `assertSameOrigin` and nothing comes back — so the check lives here, and it
 * is deliberately a DENY of the known-cross-origin case rather than an allow
 * of a fixed origin: a browser sends no `Origin` header on a same-origin
 * `EventSource` GET, so requiring one would break the desk itself.
 */
function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = req.headers.get("host");
    if (host && url.host.toLowerCase() === host.toLowerCase()) return true;
    return LOCAL_ORIGINS.test(url.hostname);
  } catch {
    return false;
  }
}

function toExchange(raw: string | null | undefined): Exchange {
  const v = (raw ?? "").trim().toUpperCase();
  return (EXCHANGES as readonly string[]).includes(v) ? (v as Exchange) : "NSE";
}

/** The open positions of the SELECTED account, as provider keys. */
function openPositionKeys(): QuoteKey[] {
  const out: QuoteKey[] = [];
  const seen = new Set<string>();
  for (const t of getTrackerTrades()) {
    // `is_open` is the open predicate — never `sell_date IS NULL`, which is a
    // sort key on this table (lib/analytics/positions.ts).
    if (!t.isOpen) continue;
    const key: QuoteKey = {
      symbol: t.symbol.trim().toUpperCase(),
      exchange: toExchange(t.exchange),
      ...(t.tradingsymbol && t.tradingsymbol !== t.symbol ? { tradingsymbol: t.tradingsymbol.trim().toUpperCase() } : {}),
    };
    const id = quoteKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

export async function GET(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) {
    return NextResponse.json(
      { ok: false, message: "This stream only answers the app itself." },
      { status: 403 },
    );
  }

  const accountId = getSelectedAccountId();
  const keys = openPositionKeys();
  const provider = getQuoteProvider();
  const encoder = new TextEncoder();

  let closed = false;
  let unsubscribe: Unsubscribe = () => {};
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;
  const pending = new Map<string, Quote>();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          shutdown(); // the client went away mid-write
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      function shutdown() {
        if (closed) return;
        closed = true;
        if (flushTimer) clearInterval(flushTimer);
        if (beatTimer) clearInterval(beatTimer);
        try {
          unsubscribe();
        } catch {
          /* a provider that throws on unsubscribe must not leak the stream */
        }
        req.signal.removeEventListener("abort", shutdown);
        try {
          controller.close();
        } catch {
          /* already closed by the platform */
        }
      }

      if (req.signal.aborted) return shutdown();
      req.signal.addEventListener("abort", shutdown);

      // Jittered reconnect hint, never a fixed 1 s (spec §4.2).
      write(`retry: ${2000 + Math.floor(Math.random() * 1500)}\n\n`);

      const health = await provider.health(); // never throws, by contract
      const marketOpen = isWithinLiveWindow(new Date());

      let quotes: Quote[] = [];
      if (keys.length > 0) {
        try {
          quotes = [...(await provider.snapshot(keys, req.signal)).values()];
        } catch (e) {
          // A provider that is not enabled (or is offline) must degrade the
          // pill, not blank the desk: the snapshot still ships, empty, with the
          // reason attached.
          health.ok = false;
          health.reason = e instanceof Error ? e.message : "The quote provider could not be read.";
        }
      }

      send("snapshot", {
        accountId,
        provider: provider.id,
        capabilities: provider.capabilities,
        health,
        marketOpen,
        symbols: keys.length,
        quotes,
      });

      // Streaming providers only, and only inside 09:00–15:40 IST. A polled
      // or end-of-day provider reports streaming:false and is never started,
      // so the desk can never call a stale print "live".
      if (provider.capabilities.streaming && marketOpen && keys.length > 0) {
        try {
          unsubscribe = provider.subscribe(keys, (q) => pending.set(quoteKeyId(q.key), q), req.signal);
        } catch (e) {
          send("error", {
            provider: provider.id,
            message: e instanceof Error ? e.message : "The quote provider refused to subscribe.",
          });
        }
        flushTimer = setInterval(() => {
          if (pending.size === 0) return;
          const batch = [...pending.values()];
          pending.clear();
          send("tick", { provider: provider.id, quotes: batch });
        }, COALESCE_MS);
      }

      beatTimer = setInterval(() => {
        send("heartbeat", { at: new Date().toISOString(), provider: provider.id });
      }, HEARTBEAT_MS);
    },

    cancel() {
      // The consumer dropped the stream: stop the provider and the timers. The
      // start() closure owns them, so mirror the teardown here.
      closed = true;
      if (flushTimer) clearInterval(flushTimer);
      if (beatTimer) clearInterval(beatTimer);
      try {
        unsubscribe();
      } catch {
        /* nothing to do on the way out */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Stops any intermediary from buffering the stream into one response.
      "X-Accel-Buffering": "no",
    },
  });
}
