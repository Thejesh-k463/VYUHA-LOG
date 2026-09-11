import "server-only";
import { db } from "@/lib/db";
import { brokerConnections, settings as settingsTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { encryptSecret, readSecret } from "@/lib/vault";
import { recordAudit } from "@/lib/audit";
import { toIst } from "@/lib/domain/trading-day";
import { previewParsedFile, commitParsedFile } from "@/lib/import/commit";
import { angelOneLogin, fetchAngelTradeBook, normalizeAngelTrades, toParsedFile as angelToParsedFile } from "@/lib/import/api/angelone";
import {
  catchUpAfter,
  catchUpRange,
  dhanImportSource,
  dhanTotpEnrolled,
  toParsedFile as dhanToParsedFile,
  type DhanHistoryRead,
  type DhanUnfetchedSpan,
} from "@/lib/import/api/dhan";
import { keepUnfetched, keepUnfetchedAndStamp } from "@/lib/import/dhan-unfetched";
import { toParsedFile as upstoxToParsedFile, normalizeUpstoxTrades, fetchUpstoxTrades } from "@/lib/import/api/upstox";

// Opt-in auto-pull on launch (v3.6, WS3) — the auto-MTM render-guard pattern,
// NO scheduler subsystem: AutoPullRunner fires the route once per browser
// session, this job no-ops unless the Settings toggle is on and today's sweep
// has not run, then pulls ONLY the connections whose auth is UNATTENDED:
//
//   angelone — always (TOTP secret mints the day's code; nothing to ask for)
//   dhan     — only when auth_json carries pin + totpSecret (pasted-token
//              mode expires daily and would 401 unattended)
//   upstox   — always (year-long read-only Analytics token)
//   zerodha  — NEVER (daily browser login + request_token paste, by regulation)
//   openalgo — NEVER (a user-run third-party server; silent background calls
//              to it were never part of its disclosure)
//
// Collisions are sacred: a commit that the manual flow would stop with a 409
// (nothing new / risky cross-source collision) is SKIPPED here and recorded in
// the summary — auto-pull NEVER passes force, those rows wait for the manual
// Import flow where the user can see them. The date stamp lands after the
// sweep REGARDLESS of per-broker outcomes: one attempt per day, not a retry
// loop against a broker that is refusing.

export interface AutoPullAuthBlob {
  pin?: string;
  totpSecret?: string;
  /** Dhan only — the consent version the save route stamped. pin+totpSecret
   *  WITHOUT it is a legacy blob and counts as not enrolled. */
  totpAckVersion?: number;
  clientCode?: string;
  apiSecret?: string;
}

export interface AutoPullEligibility {
  eligible: boolean;
  reason: string;
}

/** PURE eligibility rule — exported for its unit test. `auth` is the parsed
 *  auth_json blob (null when absent/unreadable). */
export function autoPullEligibility(broker: string, auth: AutoPullAuthBlob | null): AutoPullEligibility {
  if (broker === "angelone") return { eligible: true, reason: "unattended (TOTP mint)" };
  if (broker === "upstox") return { eligible: true, reason: "unattended (year-long token)" };
  if (broker === "dhan") {
    // Enrolled means pin + totpSecret + the RECORDED consent (totpAckVersion,
    // stamped by the save route). A legacy blob with the pair but no ack is
    // NOT unattended-eligible: the consent gate must hold here too, not only
    // at save time.
    if (dhanTotpEnrolled(auth)) return { eligible: true, reason: "unattended (PIN + TOTP mint)" };
    return auth?.pin && auth?.totpSecret
      ? { eligible: false, reason: "Dhan PIN + TOTP were saved without the recorded consent — re-save the connection to re-enroll" }
      : { eligible: false, reason: "Dhan is on pasted 24-hour tokens — save PIN + TOTP to include it" };
  }
  if (broker === "zerodha") return { eligible: false, reason: "Zerodha needs a daily browser login by regulation" };
  return { eligible: false, reason: "not an unattended connection" };
}

export type AutoPullStatus = "imported" | "nothingNew" | "collision" | "error" | "notEligible";

/**
 * PURE classification of a preview into the auto-pull decision — the exact
 * shapes the manual flow answers with a 409 (nothingNew / needsForce) become
 * skips here, because auto-pull must never force past a collision. Exported
 * for its unit test: proving "mock 409 → skipped, not forced" is proving this
 * function plus the fact that realPullOne commits ONLY on "commit".
 */
export function classifyPreview(pre: {
  summary: { total: number; newCount: number };
  crossSource?: { risky?: boolean } | null;
}): "nothingNew" | "collision" | "commit" {
  // Covers both "no trades today" and "every row already in the journal" —
  // no commit, no empty import batch.
  if (pre.summary.newCount === 0) return "nothingNew";
  if (pre.crossSource?.risky) return "collision";
  return "commit";
}

export interface AutoPullEntry {
  broker: string;
  accountId: number;
  status: AutoPullStatus;
  detail: string;
  newCount: number;
  /** C-6 on a "nothingNew" pull: the sweep line's words for the Dhan history
   *  it did not read (an "imported" entry carries them in `detail`). */
  notFetched?: string;
}

export interface AutoPullOutcome {
  ran: boolean;
  reason: string;
  date: string | null;
  /** One human line — "Auto-pull 07:20: Angel One +3 trades · …". */
  line: string | null;
  summary: AutoPullEntry[];
}

const LABELS: Record<string, string> = { angelone: "Angel One", dhan: "Dhan", upstox: "Upstox", zerodha: "Zerodha" };
const labelOf = (broker: string) => LABELS[broker] ?? broker;

type ConnRow = typeof brokerConnections.$inferSelect;

/**
 * C-6: what a background Dhan pull did not read is kept through the SAME
 * store and writers the manual route uses (lib/import/dhan-unfetched.ts, where
 * the store is explained), so the Dhan card lists a clamp from a sweep exactly
 * as it lists one from a click. tests/fix-wave-c-import.test.ts reads it back
 * through the route's GET.
 */

/** The sweep line's words for the same spans — plain, and with the remedy.
 *  F-L1-3a: the remedy starts the day AFTER the last pull's own day; that day
 *  is stated as a fact, never named as something to import. */
function unfetchedDetail(spans: readonly DhanUnfetchedSpan[]): string {
  if (spans.length === 0) return "";
  const parts = spans.map((s) => {
    const fact =
      s.reason === "range-cap"
        ? `fills from ${s.from} to ${s.to} not fetched`
        : `fills from ${s.from} to ${s.to} not read (page limit)`;
    const remedy = s.remedy ? ` — import a Dhan tradebook for ${s.remedy.from} to ${s.remedy.to}` : "";
    const partial = s.partial
      ? `; fills on ${s.partial.day} after ${s.partial.after ? `${s.partial.after} IST` : "the last pull"} not fetched — a tradebook for ${s.partial.day} would repeat the fills already imported from it`
      : "";
    return `${fact}${remedy}${partial}`;
  });
  return ` (${parts.join("; ")})`;
}

/** R19: the detail when the notice cannot be saved — the pull then commits nothing. */
const unsavedDetail = (e: unknown) =>
  `the notice naming the Dhan history this pull did not read could not be saved (${e instanceof Error ? e.message : "unknown error"}) — nothing was committed`;

/** One eligible connection's pull → preview → commit, 409-shapes skipped.
 *  Injectable for tests; the default does the real adapter work. */
export type PullOne = (conn: ConnRow, today: string) => Promise<AutoPullEntry>;

async function realPullOne(conn: ConnRow, today: string): Promise<AutoPullEntry> {
  const base = { broker: conn.broker, accountId: conn.accountId, newCount: 0 };
  const keyRead = readSecret(conn.apiKey);
  if (!keyRead.ok) return { ...base, status: "error", detail: "saved credentials cannot be read — reconnect in Import" };
  const authRead = readSecret(conn.authJson);
  let auth: AutoPullAuthBlob | null = null;
  if (authRead.ok && authRead.value) {
    try {
      auth = JSON.parse(authRead.value) as AutoPullAuthBlob;
    } catch {
      auth = null;
    }
  }

  let parsed;
  /** C-6: Dhan history this pull did not read — kept only if it commits. */
  let unfetched: readonly DhanUnfetchedSpan[] = [];
  /** R42: this pull's lastPullAt — Dhan's pre-/positions instant (`onCutoff`),
   *  else when the pull started. Never a post-commit clock. */
  const pulledAt = new Date().toISOString();
  let cutoff = null as string | null;
  try {
    if (conn.broker === "angelone") {
      if (!auth?.clientCode || !auth?.pin || !auth?.totpSecret) {
        return { ...base, status: "error", detail: "Angel One extras missing — reconnect in Import" };
      }
      const creds = { apiKey: keyRead.value, clientCode: auth.clientCode, pin: auth.pin, totpSecret: auth.totpSecret };
      const { jwtToken } = await angelOneLogin(creds);
      const { trades, refused } = normalizeAngelTrades(await fetchAngelTradeBook(creds, jwtToken), today);
      parsed = angelToParsedFile(trades, refused);
    } else if (conn.broker === "dhan") {
      // Eligibility already guaranteed pin+totp, but the pull must still go
      // through the SAME reuse-first token path as the manual route: Dhan mints
      // at most one token per 2 minutes (live-verified 2026-09-02). Passing no
      // stored token and no onMinted meant every sweep minted a token and threw
      // it away — so a manual Preview a minute later (or the reverse) failed on
      // the rate limit. Reuse the stored token when it is alive, and PERSIST any
      // mint into the same vault column the route writes.
      const tokenRead = readSecret(conn.accessToken);
      const source = dhanImportSource(
        {
          clientId: keyRead.value,
          accessToken: (tokenRead.ok && tokenRead.value) || undefined,
          pin: auth?.pin,
          totpSecret: auth?.totpSecret,
        },
        (minted) => {
          try {
            db.update(brokerConnections)
              .set({ accessToken: encryptSecret(minted), updatedAt: new Date().toISOString() })
              .where(eq(brokerConnections.id, conn.id))
              .run();
          } catch {
            /* cache miss only — the next pull mints again */
          }
        },
      );
      // CATCH-UP (v4.2.1): `/positions` is TODAY's book, so a sweep that ran
      // after a gap — a laptop closed for a week, auto-pull enabled late —
      // used to stamp lastPullAt over days it never fetched. `catchUpRange`
      // turns the stored stamp into [lastPullAt IST day, today], clamped to
      // DHAN_MAX_PULL_RANGE_DAYS; null (never pulled, or already pulled
      // today) leaves the daily pull byte-identical to what it always did.
      // C-6: a clamp (range.unfetched) or a page-capped walk (onHistory) is
      // named in the warnings and handed back as spans, as in the route.
      // R42: `after` drops the fills the last pull's snapshot already stored.
      const range = catchUpRange(conn.lastPullAt, today);
      let read: DhanHistoryRead | null = null;
      const trades = await source.fetchTrades({
        ...(range
          ? {
              from: range.from,
              to: range.to,
              after: catchUpAfter(conn.lastPullAt, today),
              onHistory: (h: DhanHistoryRead) => {
                read = h;
              },
            }
          : {}),
        onCutoff: (iso) => {
          cutoff = iso;
        },
      });
      const pulled = dhanToParsedFile(trades, range, read, conn.lastPullAt);
      unfetched = pulled.unfetched;
      parsed = pulled;
    } else if (conn.broker === "upstox") {
      parsed = upstoxToParsedFile(normalizeUpstoxTrades(await fetchUpstoxTrades({ accessToken: keyRead.value }), today));
    } else {
      return { ...base, status: "error", detail: "not an auto-pull broker" };
    }
  } catch (e) {
    return { ...base, status: "error", detail: (e as Error).message };
  }

  const stamp = cutoff ?? pulledAt;
  const owner = { connId: conn.id, accountId: conn.accountId, source: "auto-pull" };
  // Same file naming as the manual pull, so dedup and batch history line up.
  const fileName = `${conn.broker}-api-${today}`;
  try {
    const pre = previewParsedFile(parsed, null, conn.accountId, fileName);
    const cls = classifyPreview(pre);
    if (cls === "nothingNew") {
      // R27 (v4.3.0 fix wave 1): nothing new — for either total — is still a
      // successful read. Its spans and the stamp land in ONE transaction.
      try {
        keepUnfetchedAndStamp(unfetched, owner, stamp);
      } catch (e) {
        return { ...base, status: "error", detail: unsavedDetail(e) };
      }
      const notFetched = unfetchedDetail(unfetched);
      return {
        ...base,
        status: "nothingNew",
        detail: `${pre.summary.total > 0 ? "already in the journal" : "no trades today"}${notFetched}`,
        ...(notFetched ? { notFetched } : {}),
      };
    }
    if (cls === "collision") {
      // The manual flow's needsForce 409. Auto-pull must never force past a
      // collision — these rows wait for the Import screen.
      return { ...base, status: "collision", detail: "collision — review in Import" };
    }
    // R19 (v4.3.0 fix wave 1): the unread spans FIRST, with a write that
    // throws; a failure commits nothing and leaves the stamp where it was.
    try {
      keepUnfetched(unfetched, owner);
    } catch (e) {
      return { ...base, status: "error", detail: unsavedDetail(e) };
    }
    const res = commitParsedFile(parsed, fileName, null, conn.accountId);
    // R42: the stamp is the instant taken before /v2/positions was read.
    db.update(brokerConnections)
      .set({ lastPullAt: stamp })
      .where(eq(brokerConnections.id, conn.id))
      .run();
    // "+N trades" is what the commit ADDED — the manual pull's "N added" — not
    // the preview's non-duplicate rows, which also count a row the pull repeats
    // and the commit then skips (F-L1-7). Auto-close is switched off for 4.3.0
    // (06-ANSWERS, v4.3.0 release-level-audit rulings, row 1), so a SELL of a
    // held lot lands as its own row, exactly as in v4.2.0, and reads "+1 trade"
    // either way.
    return {
      ...base,
      status: "imported",
      detail: `+${res.added} trade${res.added === 1 ? "" : "s"}${unfetchedDetail(unfetched)}`,
      newCount: pre.summary.newCount,
    };
  } catch (e) {
    return { ...base, status: "error", detail: `import refused: ${(e as Error).message}` };
  }
}

export async function runAutoPull(now = new Date(), pullOne: PullOne = realPullOne): Promise<AutoPullOutcome> {
  const s = db.select().from(settingsTable).limit(1).all()[0];
  const none = (reason: string): AutoPullOutcome => ({ ran: false, reason, date: null, line: null, summary: [] });
  if (!s) return none("No settings row.");
  if (!s.autoPullEnabled) return none("Auto-pull is off — enable it in Settings if you want eligible brokers pulled once per day at launch.");

  const ist = toIst(now);
  const today = ist.toISOString().slice(0, 10);
  if (s.lastAutoPullDate != null && s.lastAutoPullDate >= today) {
    return none(`Already swept today (${s.lastAutoPullDate}).`);
  }

  // EVERY account's connections — commits land in each row's own account, and
  // the aggregate view must not hide another account's eligible broker
  // (invariant 8's spirit; the manual Import page lists them the same way).
  const conns = db.select().from(brokerConnections).all();
  const summary: AutoPullEntry[] = [];
  for (const conn of conns) {
    const authRead = readSecret(conn.authJson);
    let auth: AutoPullAuthBlob | null = null;
    if (authRead.ok && authRead.value) {
      try {
        auth = JSON.parse(authRead.value) as AutoPullAuthBlob;
      } catch {
        auth = null;
      }
    }
    const elig = autoPullEligibility(conn.broker, auth);
    if (!elig.eligible) {
      summary.push({ broker: conn.broker, accountId: conn.accountId, status: "notEligible", detail: elig.reason, newCount: 0 });
      continue;
    }
    summary.push(await pullOne(conn, today));
  }

  // ONE attempt per day, stamped after the sweep regardless of outcomes —
  // a refusing broker must not turn launch into a retry loop.
  db.update(settingsTable).set({ lastAutoPullDate: today }).where(eq(settingsTable.id, s.id)).run();

  const attempted = summary.filter((e) => e.status !== "notEligible");
  const hhmm = `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
  const line =
    attempted.length === 0
      ? null
      : `Auto-pull ${hhmm}: ${attempted
          .map((e) => {
            const what =
              e.status === "imported" ? e.detail
              : e.status === "nothingNew" ? `nothing new${e.notFetched ?? ""}`
              : e.status === "collision" ? "skipped (collision — review in Import)"
              : `failed (${e.detail})`;
            return `${labelOf(e.broker)} ${what}`;
          })
          .join(" · ")}`;
  if (line) {
    // The summary a settings/import surface can show later — the Audit Log is
    // that surface today, and recordAudit is best-effort by design.
    recordAudit({ entity: "settings", action: "update", summary: line, source: "auto-pull" });
  }
  return {
    ran: attempted.length > 0,
    reason: attempted.length > 0 ? line! : "No eligible unattended connections to pull.",
    date: today,
    line,
    summary,
  };
}
