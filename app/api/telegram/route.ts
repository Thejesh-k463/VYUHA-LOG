import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { encryptSecret, readSecret } from "@/lib/vault";
import { sendTelegram, discoverChatId } from "@/lib/telegram/send";
import { TELEGRAM_TEST_MESSAGE, isTelegramAckCurrent, telegramGate } from "@/lib/domain/telegram-disclosure";
import { parseSendTime } from "@/lib/telegram/digest-gate";

export const runtime = "nodejs";

// Telegram alerts management (v3.6, decision #6). Route handler + client
// fetch + router.refresh(), never server actions (AGENTS.md). The disclosure
// gate is applied HERE, not only in the UI: nothing may be stored, discovered
// or sent on the way to finding out the disclosure was never accepted — the
// openalgo broker-route precedent.

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), token: z.string().min(1), chatId: z.string().min(1) }),
  z.object({ action: z.literal("discover-chat-id"), token: z.string().min(1) }),
  z.object({ action: z.literal("send-test") }),
  z.object({ action: z.literal("disconnect") }),
  // z.boolean(), never z.coerce.boolean() — coercion is truthiness and the
  // STRING "false" would arrive as true, re-opening a gate the user closed
  // (the openalgoEnabled lesson, recorded in app/api/settings/route.ts).
  z.object({ action: z.literal("toggle"), enabled: z.boolean(), ackVersion: z.number().int().optional() }),
  z.object({
    action: z.literal("send-time"),
    sendTime: z.string().refine((s) => parseSendTime(s) != null, "Use HH:MM (24-hour IST)."),
  }),
]);

function settingsRow() {
  return db.select().from(settings).limit(1).all()[0];
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = ActionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message ?? "Bad request" }, { status: 400 });
  }
  const body = parsed.data;
  const s = settingsRow();
  if (!s) return NextResponse.json({ ok: false, message: "No settings row." }, { status: 400 });

  // The consent gate, FIRST, for everything that stores a credential or
  // talks to Telegram. Disconnect and the send-time edit stay open: turning
  // things off or adjusting a preference must never require re-consent.
  const needsAck = body.action === "save" || body.action === "discover-chat-id" || body.action === "send-test";
  if (needsAck && !isTelegramAckCurrent(s.telegramAckVersion)) {
    return NextResponse.json(
      { ok: false, message: "Read and accept the Telegram disclosure first — Settings → Alerts." },
      { status: 403 },
    );
  }

  if (body.action === "toggle") {
    if (body.enabled) {
      // Enabling REQUIRES a current acknowledgement — either already stored,
      // or carried by this very request from the consent dialog. Absent both,
      // 403: hiding the switch is never the only gate (openAlgoGate pattern).
      const ackAfter = body.ackVersion ?? s.telegramAckVersion;
      if (!isTelegramAckCurrent(ackAfter)) {
        return NextResponse.json(
          { ok: false, message: telegramGate({ enabled: true, ackVersion: ackAfter }).reason },
          { status: 403 },
        );
      }
      db.update(settings)
        .set({ telegramEnabled: true, telegramAckVersion: ackAfter })
        .where(eq(settings.id, s.id))
        .run();
      recordAudit({
        entity: "settings",
        action: "update",
        summary: `Telegram alerts enabled (disclosure v${ackAfter} accepted)`,
        before: { telegramEnabled: s.telegramEnabled, telegramAckVersion: s.telegramAckVersion },
        after: { telegramEnabled: true, telegramAckVersion: ackAfter },
      });
      return NextResponse.json({ ok: true, message: "Telegram alerts enabled." });
    }
    // The acknowledgement stays on file — they did read that version.
    db.update(settings).set({ telegramEnabled: false }).where(eq(settings.id, s.id)).run();
    recordAudit({
      entity: "settings",
      action: "update",
      summary: "Telegram alerts disabled",
      before: { telegramEnabled: s.telegramEnabled },
      after: { telegramEnabled: false },
    });
    return NextResponse.json({ ok: true, message: "Telegram alerts disabled." });
  }

  if (body.action === "discover-chat-id") {
    const result = await discoverChatId(body.token.trim());
    return result.ok
      ? NextResponse.json({ ok: true, chatId: result.chatId })
      : NextResponse.json({ ok: false, message: result.reason }, { status: 502 });
  }

  if (body.action === "save") {
    const token = body.token.trim();
    const chatId = body.chatId.trim();
    // Validate BY SENDING — the promised test alert is the proof the pair
    // works. Nothing is stored until Telegram confirms it.
    const test = await sendTelegram(token, chatId, TELEGRAM_TEST_MESSAGE);
    if (!test.ok) {
      return NextResponse.json({ ok: false, message: test.reason ?? "The test alert could not be sent." }, { status: 502 });
    }
    // Encrypted at rest; a broken vault REFUSES the save rather than storing
    // a live bot token in plaintext (the broker-connections posture).
    let enc: string;
    try {
      enc = encryptSecret(token);
    } catch (e) {
      return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "The secrets vault is unavailable." }, { status: 500 });
    }
    db.update(settings).set({ telegramTokenEnc: enc, telegramChatId: chatId }).where(eq(settings.id, s.id)).run();
    recordAudit({
      entity: "settings",
      action: "update",
      summary: "Telegram bot connected (test alert delivered)", // never the token
      // Never the chat id either: it identifies the user's Telegram account,
      // and audit_log rows travel in backups UNREDACTED — writing the raw id
      // here would smuggle out exactly what migration 0053 promises to redact
      // from the settings table. The audit fact is THAT a chat was set.
      after: { telegramChatId: "(set)" },
    });
    return NextResponse.json({ ok: true, message: "Connected — the test alert is in your Telegram chat." });
  }

  if (body.action === "send-test") {
    const tokenRead = readSecret(s.telegramTokenEnc);
    if (!tokenRead.ok || !tokenRead.value || !s.telegramChatId) {
      return NextResponse.json({ ok: false, message: "No working bot connection on file — save the token and chat id first." }, { status: 400 });
    }
    const test = await sendTelegram(tokenRead.value, s.telegramChatId, TELEGRAM_TEST_MESSAGE);
    return test.ok
      ? NextResponse.json({ ok: true, message: "Test alert sent." })
      : NextResponse.json({ ok: false, message: test.reason }, { status: 502 });
  }

  if (body.action === "send-time") {
    db.update(settings).set({ telegramSendTime: body.sendTime }).where(eq(settings.id, s.id)).run();
    return NextResponse.json({ ok: true, message: `Send time set to ${body.sendTime} IST.` });
  }

  // disconnect: delete the credentials and close the gate. The ack stays — it
  // records that this person read that disclosure version.
  db.update(settings)
    .set({ telegramTokenEnc: null, telegramChatId: null, telegramEnabled: false })
    .where(eq(settings.id, s.id))
    .run();
  recordAudit({
    entity: "settings",
    action: "update",
    summary: "Telegram disconnected (stored token deleted, alerts disabled)",
    before: { telegramEnabled: s.telegramEnabled },
    after: { telegramEnabled: false },
  });
  return NextResponse.json({ ok: true, message: "Disconnected. The stored token was deleted; revoke it in BotFather too if you are done with the bot." });
}
