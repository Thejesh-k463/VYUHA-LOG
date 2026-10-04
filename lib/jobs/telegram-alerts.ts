import "server-only";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, settings as settingsTable, telegramAlertsSent, trades as tradesTable } from "@/lib/db/schema";
import { readSecret } from "@/lib/vault";
import { istClock } from "@/lib/domain/market-calendar";
import { todayIstIso } from "@/lib/domain/trading-day";
import { sideOf } from "@/lib/domain/side";
import { detectBreaches, type AlertPositionInput, type BreachKind } from "@/lib/risk/alerts";
import { positionKeyFor, MAX_POSITION_KEYS } from "@/lib/live/position-keys";
import { fromPaise, quoteKeyId, type Quote, type QuoteKey, type QuoteProvider } from "@/lib/quotes/types";
import { alertFeedState, alertsGate, ALERT_CHECK_MS, type AlertRefusal } from "@/lib/telegram/alert-gate";
import { ALERT_DAILY_CAP, planAlerts, receiptKey, type AlertCandidate } from "@/lib/telegram/alert-plan";
import { formatAlert, formatAlertSummary } from "@/lib/telegram/format";
import { sendTelegram, type SendResult } from "@/lib/telegram/send";

// TELEGRAM STOP/TARGET ALERTS — the server job (v4.7.0 C5; ruling Q18, owner
// answers TG1–TG6; design C5-DESIGN-2026-10-04 D1–D10 as amended by review
// R1–R10). `POST /api/telegram/alerts` is its ONLY caller; the client runner
// only POSTs and schedules from the answer's `nextInMs`.
//
// One run, in order:
//   1. the gates (lib/telegram/alert-gate.ts): Pro → Telegram on → disclosure
//      current → alerts on → credentials → a LIVE feed (R4) → at least one
//      position whose OWN market is open now per the calendar (D4/R8);
//   2. EVERY account's open trades (TG3, design D7/R7) — never
//      `getSelectedAccountId()`: switching the on-screen book must never
//      silence an alert the user expects. Declared in prose in
//      tests/account-isolation.test.ts, which also checks this file never
//      resolves the selection;
//   3. keys ONLY for positions alertable NOW (R8), one snapshot with an 8 s
//      timeout through `peekLiveFeedProvider()` (R1: the desk's instance, one
//      session); held in memory, never persisted (Q25), never written to
//      `mtm_prices`;
//   4. a price counts only when THIS check took it, the provider calls it
//      `tick` or `delayed`, its `asOf` is today's IST date, and it is not a
//      zero-volume print (R2 — a scrip untraded today answers with yesterday's
//      price). Anything else is a 0 mark, which `detectBreaches` skips: a stale
//      or missing price is never pushed;
//   5. `detectBreaches` (lib/risk/alerts.ts, unchanged), receipts older than
//      seven days pruned, `planAlerts` (20 a day, then one summary);
//   6. each message is CLAIMED before the dial (`INSERT … ON CONFLICT DO
//      NOTHING` with the cap inside the same statement; changes === 1 → ours)
//      and the claim is DELETED if the send fails — the digest's
//      claim-before-dial, per row. The summary claims
//      `last_telegram_alert_summary_date` the same way and reverts on failure.
//
// Failure posture: a snapshot that throws returns `feed-error` with NO failure
// envelope (that strip is for SEND failures — R3) and the next run retries; a
// send failure returns `sendTelegram`'s own hand-built reason (it never holds
// the token), never a caught message. Concurrent calls in this process share
// one run (an in-process promise); across processes the receipts decide.

export type AlertRunRefusal = AlertRefusal | "feed-error";

export type TelegramAlertsOutcome =
  | {
      refused: AlertRunRefusal;
      nextInMs: number;
      /** On `feed-reaccept` only: `resolveLiveFeed().blockedReason` — the feed's
       *  own gate sentence (which screen, which cause), built from literals and
       *  never holding a token, key or host (review R4; seam defect D-C5-1). */
      detail?: string;
    }
  | {
      refused: null;
      /** Positions priced and checked this run. */
      checked: number;
      breaches: number;
      sent: number;
      /** The first send failure, which also ends the run's sending. */
      failed: { reason: string } | null;
      summarySent: boolean;
      nextInMs: number;
    };

type Sender = (token: string, chatId: string, html: string) => Promise<SendResult>;

/** Test seams — production callers pass nothing. */
export interface TelegramAlertDeps {
  send?: Sender;
  getProvider?: () => Promise<QuoteProvider>;
  isPro?: () => boolean;
  resolveFeed?: () => Promise<{ stored: string; effective: string; blockedReason?: string }>;
  /** `VYUHA_QUOTE_PROVIDER` unless given. */
  envOverride?: string | null;
}

/** How long one snapshot may take before the run gives up on the feed (D3). */
export const ALERT_SNAPSHOT_TIMEOUT_MS = 8_000;
/** Receipts older than this many IST days are pruned at the start of a run. */
export const ALERT_RECEIPT_KEEP_DAYS = 7;

const shiftIso = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The mark this check may use for one quote, in RUPEES, or 0 (= no mark,
 * `detectBreaches` skips it). `fromPaise` exactly once, here, at the job
 * boundary (invariant 1; precedent lib/quotes/persist-mark.ts).
 */
export function freshMark(q: Quote | undefined, today: string): number {
  if (!q) return 0;
  if (q.staleness !== "tick" && q.staleness !== "delayed") return 0;
  if (q.volume != null && q.volume === 0) return 0;
  if (!Number.isFinite(q.ltp) || q.ltp <= 0) return 0;
  const at = Date.parse(q.asOf);
  if (!Number.isFinite(at) || todayIstIso(new Date(at)) !== today) return 0;
  return fromPaise(q.ltp);
}

/**
 * Claim one receipt. 1 = this caller owns the alert and may dial; 0 = it is
 * already on file today, or the day's cap is spent (the cap is enforced inside
 * the SAME statement, so two processes cannot both claim the 20th slot).
 */
export function claimAlert(
  r: { tradeId: number; symbol: string; kind: BreachKind; istDate: string; level: number; mark: number; sentAt: string },
  cap: number = ALERT_DAILY_CAP,
): number {
  const res = db.run(sql`
    INSERT INTO telegram_alerts_sent (trade_id, symbol, kind, ist_date, level, mark, sent_at)
    SELECT ${r.tradeId}, ${r.symbol}, ${r.kind}, ${r.istDate}, ${r.level}, ${r.mark}, ${r.sentAt}
    WHERE (SELECT count(*) FROM telegram_alerts_sent WHERE ist_date = ${r.istDate}) < ${cap}
    ON CONFLICT DO NOTHING
  `);
  return res.changes;
}

/** Give a claim back — the send failed, so the next run retries it. */
export function releaseAlert(r: { tradeId: number; symbol: string; kind: BreachKind; istDate: string }): void {
  db.delete(telegramAlertsSent)
    .where(
      and(
        eq(telegramAlertsSent.tradeId, r.tradeId),
        eq(telegramAlertsSent.symbol, r.symbol),
        eq(telegramAlertsSent.kind, r.kind),
        eq(telegramAlertsSent.istDate, r.istDate),
      ),
    )
    .run();
}

async function defaultResolveFeed(): Promise<{ stored: string; effective: string; blockedReason?: string }> {
  const { resolveLiveFeed } = await import("@/lib/quotes/registry");
  return resolveLiveFeed();
}

async function defaultGetProvider(): Promise<QuoteProvider> {
  const { peekLiveFeedProvider } = await import("@/lib/quotes/registry");
  return peekLiveFeedProvider();
}

async function defaultIsPro(): Promise<boolean> {
  const { getEntitlement } = await import("@/lib/queries/license");
  return getEntitlement().pro;
}

/** ONE snapshot, ≤ 8 s, or null when the feed threw or timed out. Never persisted. */
async function takeSnapshot(
  deps: TelegramAlertDeps,
  keys: readonly QuoteKey[],
): Promise<{ quotes: Map<string, Quote>; providerId: string } | null> {
  try {
    const provider = await (deps.getProvider ?? defaultGetProvider)();
    const quotes = await provider.snapshot(keys, AbortSignal.timeout(ALERT_SNAPSHOT_TIMEOUT_MS));
    return { quotes, providerId: provider.id };
  } catch {
    return null;
  }
}

async function runOnce(now: Date, deps: TelegramAlertDeps): Promise<TelegramAlertsOutcome> {
  const send = deps.send ?? sendTelegram;
  const s = db.select().from(settingsTable).limit(1).all()[0];
  if (!s) return { refused: "telegram-off", nextInMs: ALERT_CHECK_MS };

  const tokenRead = readSecret(s.telegramTokenEnc);
  const token = tokenRead.ok ? tokenRead.value : "";
  const hasCredentials = Boolean(token) && Boolean(s.telegramChatId);
  const feed = await (deps.resolveFeed ?? defaultResolveFeed)();
  const pro = deps.isPro ? deps.isPro() : await defaultIsPro();

  // EVERY account's open book (TG3) — no selected-account scope, on purpose.
  const open = db
    .select({
      id: tradesTable.id,
      accountId: tradesTable.accountId,
      symbol: tradesTable.symbol,
      tradingsymbol: tradesTable.tradingsymbol,
      exchange: tradesTable.exchange,
      segment: tradesTable.segment,
      buyQty: tradesTable.buyQty,
      sellQty: tradesTable.sellQty,
      side: tradesTable.side,
      buyDate: tradesTable.buyDate,
      sellDate: tradesTable.sellDate,
      importNotes: tradesTable.importNotes,
      avgBuyPrice: tradesTable.avgBuyPrice,
      avgSellPrice: tradesTable.avgSellPrice,
      slPlanned: tradesTable.slPlanned,
      trailingSl: tradesTable.trailingSl,
      targetPlanned: tradesTable.targetPlanned,
      riskAmount: tradesTable.riskAmount,
    })
    .from(tradesTable)
    .where(eq(tradesTable.isOpen, true))
    .all();

  const hasLevel = (t: (typeof open)[number]) =>
    [t.slPlanned, t.trailingSl, t.targetPlanned].some((v) => v != null && v > 0);

  const gate = alertsGate({
    pro,
    telegramEnabled: s.telegramEnabled,
    telegramAckVersion: s.telegramAckVersion,
    alertsEnabled: s.telegramAlertsEnabled,
    hasCredentials,
    feed: alertFeedState({
      stored: feed.stored,
      effective: feed.effective,
      envOverride: deps.envOverride !== undefined ? deps.envOverride : (process.env.VYUHA_QUOTE_PROVIDER ?? null),
    }),
    windowFrom: s.telegramAlertFrom,
    windowTo: s.telegramAlertTo,
    positions: open.map((t) => ({ exchange: t.exchange, segment: t.segment, symbol: t.symbol, hasLevel: hasLevel(t) })),
    now,
  });
  if (!gate.ok) {
    // R4: a feed-reaccept refusal carries the feed's own blocked reason, so
    // the card can say WHERE the consent lives (OpenAlgo: Integrations) and
    // WHY (the integration is off, or its disclosure changed).
    const detail = gate.reason === "feed-reaccept" ? feed.blockedReason : undefined;
    return { refused: gate.reason, nextInMs: gate.nextInMs, ...(detail ? { detail } : {}) };
  }

  // ONLY the positions alertable NOW get a key (R8) — no cash key once the
  // cash close has passed, none for MCX / CDS, none without a recorded level.
  const alertable = open.filter((_, i) => gate.alertable[i]);
  const keyOf = new Map<number, QuoteKey>();
  const keys: QuoteKey[] = [];
  const seen = new Set<string>();
  for (const t of alertable) {
    const key = positionKeyFor(t);
    keyOf.set(t.id, key);
    const id = quoteKeyId(key);
    if (seen.has(id) || keys.length >= MAX_POSITION_KEYS) continue;
    seen.add(id);
    keys.push(key);
  }

  const snap = await takeSnapshot(deps, keys);
  // No failure envelope: that strip is for SEND failures (R3). Next run retries.
  if (!snap) return { refused: "feed-error", nextInMs: ALERT_CHECK_MS };
  const { quotes, providerId } = snap;

  const today = istClock(now).date;
  const byId = new Map(alertable.map((t) => [t.id, t]));
  const inputs: AlertPositionInput[] = alertable.map((t) => {
    const isShort = sideOf(t) === "short";
    const key = keyOf.get(t.id)!;
    return {
      id: t.id,
      symbol: (t.tradingsymbol || t.symbol).trim(),
      side: isShort ? "short" : "long",
      qty: Math.abs(t.buyQty - t.sellQty) || (isShort ? t.sellQty : t.buyQty),
      entry: isShort ? t.avgSellPrice : t.avgBuyPrice,
      mtm: freshMark(quotes.get(quoteKeyId(key)), today),
      slPlanned: t.slPlanned,
      trailingSl: t.trailingSl,
      targetPlanned: t.targetPlanned,
      riskAmount: t.riskAmount,
    };
  });
  const checked = inputs.filter((p) => p.mtm > 0).length;
  const breaches = detectBreaches(inputs);

  // Prune, then read today's receipts — the cap is `count(*)` for today (R6).
  db.delete(telegramAlertsSent).where(lt(telegramAlertsSent.istDate, shiftIso(today, -ALERT_RECEIPT_KEEP_DAYS))).run();
  const todays = db
    .select({ tradeId: telegramAlertsSent.tradeId, symbol: telegramAlertsSent.symbol, kind: telegramAlertsSent.kind })
    .from(telegramAlertsSent)
    .where(eq(telegramAlertsSent.istDate, today))
    .all();

  const accountRows = db.select({ id: accounts.id, name: accounts.name }).from(accounts).all();
  const nameOf = new Map(accountRows.map((a) => [a.id, a.name]));
  const multiAccount = accountRows.length > 1;

  const candidates: AlertCandidate[] = breaches.map((b) => {
    const t = byId.get(b.id)!;
    return {
      tradeId: b.id,
      symbol: b.symbol,
      kind: b.kind,
      side: b.side,
      level: b.level,
      mark: b.mtm,
      throughPct: b.throughPct,
      accountId: t.accountId,
      accountName: nameOf.get(t.accountId) ?? null,
    };
  });
  const plan = planAlerts({
    breaches: candidates,
    sentToday: new Set(todays.map((r) => receiptKey(r.tradeId, r.symbol, r.kind))),
    sentCountToday: todays.length,
    summarySentToday: s.lastTelegramAlertSummaryDate != null && s.lastTelegramAlertSummaryDate >= today,
  });

  const sentAt = now.toISOString();
  let sent = 0;
  let failed: { reason: string } | null = null;
  for (const c of plan.toSend) {
    const receipt = { tradeId: c.tradeId, symbol: c.symbol, kind: c.kind, istDate: today, level: c.level, mark: c.mark, sentAt };
    if (claimAlert(receipt) !== 1) continue; // another caller owns it, or the cap is spent
    const html = formatAlert({
      symbol: c.symbol,
      kind: c.kind,
      side: c.side,
      level: c.level,
      mark: c.mark,
      throughPct: c.throughPct,
      accountName: c.accountName,
      multiAccount,
      checkedAt: now,
      providerId,
    });
    const result = await send(token, s.telegramChatId ?? "", html);
    if (!result.ok) {
      releaseAlert(receipt);
      failed = { reason: result.reason ?? "The Telegram alert could not be sent." };
      break; // Telegram is not answering; the rest wait for the next run.
    }
    sent++;
  }

  let summarySent = false;
  if (plan.summary && !failed) {
    const claimed = db
      .update(settingsTable)
      .set({ lastTelegramAlertSummaryDate: today })
      .where(
        and(
          eq(settingsTable.id, s.id),
          or(isNull(settingsTable.lastTelegramAlertSummaryDate), lt(settingsTable.lastTelegramAlertSummaryDate, today)),
        ),
      )
      .run();
    if (claimed.changes === 1) {
      const result = await send(token, s.telegramChatId ?? "", formatAlertSummary(plan.summary.count, ALERT_DAILY_CAP));
      if (result.ok) {
        summarySent = true;
      } else {
        db.update(settingsTable)
          .set({ lastTelegramAlertSummaryDate: s.lastTelegramAlertSummaryDate })
          .where(eq(settingsTable.id, s.id))
          .run();
        failed = { reason: result.reason ?? "The Telegram alert summary could not be sent." };
      }
    }
  }

  return { refused: null, checked, breaches: breaches.length, sent, failed, summarySent, nextInMs: gate.nextInMs };
}

/** The run in flight in THIS process — a concurrent caller awaits it (D9). */
let inFlight: Promise<TelegramAlertsOutcome> | null = null;

export function runTelegramAlerts(now: Date = new Date(), deps: TelegramAlertDeps = {}): Promise<TelegramAlertsOutcome> {
  if (inFlight) return inFlight;
  const run: Promise<TelegramAlertsOutcome> = runOnce(now, deps).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}
