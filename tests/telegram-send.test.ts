import { describe, expect, it } from "vitest";
import { sendTelegram, discoverChatId } from "@/lib/telegram/send";

/**
 * The send contract: 5s timeout per attempt, ≤3 attempts, exponential backoff
 * with Telegram's own retry_after honoured on 429, and NEVER a throw to the
 * caller — a digest that cannot go out becomes an in-app note, not a crash.
 * fetch and sleep are injected; no test here touches the network.
 */

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const status = (code: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

function recorder() {
  const calls: { url: string; method: string | undefined; contentType: string | undefined; body: unknown }[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    fetchSeq(responses: (Response | Error)[]): typeof fetch {
      let i = 0;
      return (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          contentType: (init?.headers as Record<string, string> | undefined)?.["content-type"],
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r instanceof Error) throw r;
        // Response bodies are one-shot; clone so a repeated last entry re-reads.
        return r.clone();
      }) as typeof fetch;
    },
  };
}

describe("sendTelegram", () => {
  it("POSTs sendMessage with chat_id, text and HTML parse mode", async () => {
    const r = recorder();
    const res = await sendTelegram("TOKEN", "42", "<b>hi</b>", { fetchImpl: r.fetchSeq([ok()]), sleep: r.sleep });
    expect(res).toEqual({ ok: true });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    // Method and content-type pinned, as the Dhan/Kite send tests pin theirs —
    // a GET or an unlabelled body is a request Telegram would reject.
    expect(r.calls[0].method).toBe("POST");
    expect(r.calls[0].contentType).toBe("application/json");
    expect(r.calls[0].body).toEqual({ chat_id: "42", text: "<b>hi</b>", parse_mode: "HTML" });
  });

  it("retries a timeout with exponential backoff, then reports unreachable — never throws", async () => {
    const r = recorder();
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const res = await sendTelegram("T", "1", "x", { fetchImpl: r.fetchSeq([timeout]), sleep: r.sleep, backoffMs: 100 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unreachable|timed out/i);
    expect(r.calls).toHaveLength(3); // ≤3 attempts, no more
    expect(r.sleeps).toEqual([100, 200]); // exponential, and none after the last
  });

  it("honours retry_after on 429 instead of its own backoff", async () => {
    const r = recorder();
    const res = await sendTelegram("T", "1", "x", {
      fetchImpl: r.fetchSeq([status(429, { ok: false, parameters: { retry_after: 7 } }), ok()]),
      sleep: r.sleep,
      backoffMs: 100,
    });
    expect(res.ok).toBe(true);
    expect(r.sleeps).toEqual([7000]); // Telegram's own figure, in ms — not 100
    expect(r.calls).toHaveLength(2);
  });

  it("gives up after 3 attempts of sustained 429", async () => {
    const r = recorder();
    const res = await sendTelegram("T", "1", "x", {
      fetchImpl: r.fetchSeq([status(429, { ok: false, parameters: { retry_after: 1 } })]),
      sleep: r.sleep,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/rate-limit/i);
    expect(r.calls).toHaveLength(3);
  });

  it("does NOT retry a 401 (bad token) — retrying cannot fix it", async () => {
    const r = recorder();
    const res = await sendTelegram("T", "1", "x", {
      fetchImpl: r.fetchSeq([status(401, { ok: false, description: "Unauthorized" })]),
      sleep: r.sleep,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/bot token/i);
    expect(r.calls).toHaveLength(1);
  });

  it("never leaks the token into a failure reason", async () => {
    const r = recorder();
    const boom = new Error("request to https://api.telegram.org/botSECRET-TOKEN/sendMessage failed");
    const res = await sendTelegram("SECRET-TOKEN", "1", "x", { fetchImpl: r.fetchSeq([boom]), sleep: r.sleep });
    expect(res.ok).toBe(false);
    expect(res.reason).not.toContain("SECRET-TOKEN");
  });

  it("refuses cleanly with nothing on file instead of dialling Telegram", async () => {
    const r = recorder();
    const res = await sendTelegram("", "", "x", { fetchImpl: r.fetchSeq([ok()]), sleep: r.sleep });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
  });
});

describe("discoverChatId", () => {
  it("returns the NEWEST update's chat id", async () => {
    const r = recorder();
    const res = await discoverChatId("T", {
      fetchImpl: r.fetchSeq([
        status(200, {
          ok: true,
          result: [
            { update_id: 1, message: { chat: { id: 111 } } },
            { update_id: 2, message: { chat: { id: 222 } } },
          ],
        }),
      ]),
    });
    expect(res).toEqual({ ok: true, chatId: "222" });
    expect(r.calls[0].url).toBe("https://api.telegram.org/botT/getUpdates");
  });

  it("tells the user to /start the bot when there are no updates yet", async () => {
    const r = recorder();
    const res = await discoverChatId("T", { fetchImpl: r.fetchSeq([status(200, { ok: true, result: [] })]) });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/\/start/);
  });

  it("never throws on a network failure", async () => {
    const r = recorder();
    const res = await discoverChatId("T", { fetchImpl: r.fetchSeq([new Error("ECONNREFUSED")]) });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unreachable/i);
  });
});
