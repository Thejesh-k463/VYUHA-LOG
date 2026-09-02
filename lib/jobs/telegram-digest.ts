import "server-only";
import { db } from "@/lib/db";
import { accounts, settings as settingsTable, trades as tradesTable } from "@/lib/db/schema";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { getBucketCapital } from "@/lib/queries/capital";
import { readSecret } from "@/lib/vault";
import { toIst } from "@/lib/domain/trading-day";
import { shouldSendDigest } from "@/lib/telegram/digest-gate";
import { formatEodDigest, type EodDigestInput } from "@/lib/telegram/format";
import { sendTelegram, type SendResult } from "@/lib/telegram/send";

// Opt-in Telegram EOD digest job (v3.6, decision #6) — the auto-MTM shape:
// fired in the background on app open by TelegramRunner, no-ops unless every
// precondition in lib/telegram/digest-gate.ts holds, and NEVER throws to the
// route.
//
// Once-per-day is enforced by CLAIMING the day BEFORE dialling Telegram: a
// synchronous conditional UPDATE stamps last_telegram_sent_date, and exactly
// one caller changes the row (better-sqlite3 is synchronous, so the claim is
// race-free). TelegramRunner's sessionStorage latch is per-tab — two restored
// tabs both POST, and stamping only AFTER the awaited send let both pass the
// gate and the user got the digest twice. On a FAILED send the claim is
// reverted to its previous value, so a failed send still costs nothing and
// the next launch today retries.
//
// Scope: the digest reads the SELECTED account, exactly like the dashboard —
// the numbers in the message are the numbers on screen (invariant 8).

export interface TelegramDigestOutcome {
  ran: boolean;
  /** True when the gate was open but the send did not go through —
   *  the runner shows the degrade-to-in-app note for this case. */
  failed?: boolean;
  reason: string;
  date: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The digest input, assembled from the selected account's book. Exported for
 *  the temp-db test — pure once the rows are read. */
export function buildDigestInput(today: string): EodDigestInput {
  const accountId = getSelectedAccountId();
  const q = db
    .select({
      isOpen: tradesTable.isOpen,
      tradingsymbol: tradesTable.tradingsymbol,
      buyQty: tradesTable.buyQty,
      sellQty: tradesTable.sellQty,
      avgBuyPrice: tradesTable.avgBuyPrice,
      avgSellPrice: tradesTable.avgSellPrice,
      riskAmount: tradesTable.riskAmount,
      netPnl: tradesTable.netPnl,
      sellDate: tradesTable.sellDate,
      notes: tradesTable.notes,
    })
    .from(tradesTable);
  const rows = (accountId > 0 ? q.where(eq(tradesTable.accountId, accountId)) : q).all();

  const open = rows.filter((t) => t.isOpen);
  const positions = open.map((t) => {
    const isShort = t.sellQty > t.buyQty;
    return {
      symbol: t.tradingsymbol,
      side: (isShort ? "short" : "long") as "short" | "long",
      qty: Math.abs(t.buyQty - t.sellQty) || (isShort ? t.sellQty : t.buyQty),
      invested: (Math.abs(t.buyQty - t.sellQty) || (isShort ? t.sellQty : t.buyQty)) * (isShort ? t.avgSellPrice : t.avgBuyPrice),
      risk: t.riskAmount,
    };
  });
  const withRisk = positions.filter((p) => p.risk != null && p.risk > 0);

  const weekStart = new Date(today + "T00:00:00Z");
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const weekIso = weekStart.toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);

  const closed = rows.filter((t) => !t.isOpen);
  const sum = (xs: typeof closed) => r2(xs.reduce((a, t) => a + t.netPnl, 0));
  const closedToday = closed.filter((t) => t.sellDate === today);
  const closedWeek = closed.filter((t) => t.sellDate != null && t.sellDate >= weekIso && t.sellDate <= today);

  const cap = getBucketCapital();
  const accountName =
    accountId > 0
      ? (db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, accountId)).get()?.name ?? null)
      : "All accounts";

  return {
    date: today,
    accountLabel: accountName,
    openPositions: positions.map(({ symbol, side, qty }) => ({ symbol, side, qty })),
    openRiskRupees: withRisk.length > 0 ? r2(withRisk.reduce((a, p) => a + (p.risk as number), 0)) : null,
    openRiskUnknownCount: positions.length - withRisk.length,
    capitalTotal: cap.totalCapital > 0 ? cap.totalCapital : null,
    capitalDeployed: positions.length > 0 ? r2(positions.reduce((a, p) => a + p.invested, 0)) : null,
    realisedToday: sum(closedToday),
    realisedWeek: sum(closedWeek),
    realisedMonth: sum(closed.filter((t) => t.sellDate != null && t.sellDate.startsWith(monthPrefix) && t.sellDate <= today)),
    closedToday: closedToday.length,
    journalPendingCount: closedWeek.filter((t) => !t.notes || !String(t.notes).trim()).length,
  };
}

type Sender = (token: string, chatId: string, html: string) => Promise<SendResult>;

export async function runTelegramDigest(now = new Date(), send: Sender = sendTelegram): Promise<TelegramDigestOutcome> {
  const s = db.select().from(settingsTable).limit(1).all()[0];
  const none = (reason: string, failed = false): TelegramDigestOutcome => ({ ran: false, failed: failed || undefined, reason, date: null });
  if (!s) return none("No settings row.");

  const tokenRead = readSecret(s.telegramTokenEnc);
  const hasCredentials = tokenRead.ok && Boolean(tokenRead.value) && Boolean(s.telegramChatId);

  const gate = shouldSendDigest(
    {
      enabled: s.telegramEnabled,
      ackVersion: s.telegramAckVersion,
      hasCredentials,
      sendTime: s.telegramSendTime,
      lastSentDate: s.lastTelegramSentDate,
    },
    now,
  );
  if (!gate.send) {
    // An unreadable vault with the feature ON is a failure worth a note, not
    // silence — the stored token exists but this machine cannot open it.
    if (s.telegramEnabled && s.telegramTokenEnc && !tokenRead.ok) {
      return none(`The stored bot token cannot be read: ${(tokenRead as { reason: string }).reason}. Reconnect Telegram in Settings.`, true);
    }
    return none(gate.reason);
  }

  // CLAIM today before sending. Conditional on the stored stamp still being
  // behind today, so of N concurrent callers exactly one wins the row; the
  // rest see 0 changes and stand down without dialling Telegram.
  const claimed = db
    .update(settingsTable)
    .set({ lastTelegramSentDate: gate.today })
    .where(
      and(
        eq(settingsTable.id, s.id),
        or(isNull(settingsTable.lastTelegramSentDate), lt(settingsTable.lastTelegramSentDate, gate.today)),
      ),
    )
    .run();
  if (claimed.changes === 0) {
    return none(`Another launch already owns the ${gate.today} digest.`);
  }

  const html = formatEodDigest(buildDigestInput(gate.today));
  const result = await send(tokenRead.ok ? tokenRead.value : "", s.telegramChatId ?? "", html);
  if (!result.ok) {
    // Degrade to the in-app note and GIVE THE DAY BACK — restore the stamp
    // this claim overwrote, so the next launch today retries.
    db.update(settingsTable).set({ lastTelegramSentDate: s.lastTelegramSentDate }).where(eq(settingsTable.id, s.id)).run();
    return { ran: false, failed: true, reason: result.reason ?? "The digest could not be sent.", date: gate.today };
  }

  const sentAt = toIst(now);
  const hhmm = `${String(sentAt.getUTCHours()).padStart(2, "0")}:${String(sentAt.getUTCMinutes()).padStart(2, "0")}`;
  return { ran: true, reason: `EOD digest sent to Telegram at ${hhmm} IST.`, date: gate.today };
}
