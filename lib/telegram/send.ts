import "server-only";

// TELEGRAM SEND (server-only; no DB — credentials are handed in by the caller,
// decrypted at the moment of use, the broker-route pattern).
//
// Failure posture: NOTHING here throws to a caller. A digest that cannot be
// sent must degrade to an in-app note, never crash a route or a render — so
// every path returns `{ ok } | { ok: false, reason }`, and the reason never
// contains the token (it is part of the URL, so error text is built by hand,
// never from the URL or a caught message that might embed it).
//
// Retry contract (plan WS4): 5s timeout per attempt, at most 3 attempts with
// exponential backoff, honouring Telegram's own `retry_after` on HTTP 429.
// No night retries — one call, three tries, then the caller's quiet note.

export interface SendResult {
  ok: boolean;
  reason?: string;
}

export interface DiscoverResult {
  ok: boolean;
  chatId?: string;
  reason?: string;
}

/** Test seams — production callers pass nothing. */
export interface SendDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Base backoff before attempt 2 / 3 (doubles); 429 retry_after overrides. */
  backoffMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MAX_ATTEMPTS = 3;

/** Human reason for a non-OK Telegram response, without leaking anything. */
function apiReason(status: number, description?: string): string {
  const desc = typeof description === "string" && description ? ` — ${description}` : "";
  if (status === 401) return `Telegram rejected the bot token (HTTP 401)${desc}. Re-check it with BotFather.`;
  if (status === 400) return `Telegram rejected the message (HTTP 400)${desc}. Re-check the chat id.`;
  return `Telegram answered HTTP ${status}${desc}.`;
}

/**
 * POST one HTML-parse-mode message. Never throws.
 */
export async function sendTelegram(
  token: string,
  chatId: string,
  html: string,
  deps: SendDeps = {},
): Promise<SendResult> {
  if (!token || !chatId) return { ok: false, reason: "No bot token or chat id on file." };
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const backoffMs = deps.backoffMs ?? 1_000;

  let lastReason = "Telegram was unreachable.";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true };
      type TgError = { description?: string; parameters?: { retry_after?: number } };
      let body: TgError | null = null;
      try {
        body = (await res.json()) as TgError;
      } catch {
        /* non-JSON error page — the status alone will have to do */
      }
      if (res.status === 429) {
        lastReason = "Telegram is rate-limiting (HTTP 429).";
        if (attempt < MAX_ATTEMPTS) {
          const retryAfter = body?.parameters?.retry_after;
          const waitMs =
            typeof retryAfter === "number" && retryAfter > 0
              ? retryAfter * 1_000
              : backoffMs * 2 ** (attempt - 1);
          await sleep(waitMs);
        }
        continue;
      }
      // 4xx other than 429 will not improve on retry — bad token / chat id.
      return { ok: false, reason: apiReason(res.status, body?.description ?? undefined) };
    } catch {
      // Timeout, DNS failure, offline, blocked — retriable, and unreadable in
      // detail without risking the token appearing in a wrapped URL message.
      lastReason = "Telegram was unreachable (offline, blocked, or timed out).";
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * One getUpdates call → the newest message's chat id. The user must have sent
 * their bot ANY message (usually /start) first — said in the card copy, and in
 * the reason here when the update list comes back empty. Never throws.
 */
export async function discoverChatId(token: string, deps: SendDeps = {}): Promise<DiscoverResult> {
  if (!token) return { ok: false, reason: "Paste the bot token first." };
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  try {
    const res = await doFetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let description: string | undefined;
      try {
        description = ((await res.json()) as { description?: string }).description;
      } catch {
        /* status alone */
      }
      return { ok: false, reason: apiReason(res.status, description) };
    }
    const body = (await res.json()) as {
      result?: { update_id?: number; message?: { chat?: { id?: number | string } } }[];
    };
    const updates = Array.isArray(body.result) ? body.result : [];
    // Newest last per Telegram's contract — walk backwards to the latest
    // update that actually carries a message with a chat.
    for (let i = updates.length - 1; i >= 0; i--) {
      const id = updates[i]?.message?.chat?.id;
      if (id != null) return { ok: true, chatId: String(id) };
    }
    return {
      ok: false,
      reason: "No messages found on this bot yet — open Telegram, send your bot /start, then try again.",
    };
  } catch {
    return { ok: false, reason: "Telegram was unreachable (offline, blocked, or timed out)." };
  }
}
