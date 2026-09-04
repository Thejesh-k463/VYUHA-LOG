import "server-only";
import { db } from "@/lib/db";
import { brokerConnections, settings as settingsTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { encryptSecret, readSecret } from "@/lib/vault";
import { recordAudit } from "@/lib/audit";
import { toIst } from "@/lib/domain/trading-day";
import { previewParsedFile, commitParsedFile } from "@/lib/import/commit";
import { angelOneLogin, fetchAngelTradeBook, normalizeAngelTrades, toParsedFile as angelToParsedFile } from "@/lib/import/api/angelone";
import { dhanImportSource, dhanTotpEnrolled, toParsedFile as dhanToParsedFile } from "@/lib/import/api/dhan";
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
      parsed = dhanToParsedFile(await source.fetchTrades({}));
    } else if (conn.broker === "upstox") {
      parsed = upstoxToParsedFile(normalizeUpstoxTrades(await fetchUpstoxTrades({ accessToken: keyRead.value }), today));
    } else {
      return { ...base, status: "error", detail: "not an auto-pull broker" };
    }
  } catch (e) {
    return { ...base, status: "error", detail: (e as Error).message };
  }

  // Same file naming as the manual pull, so dedup and batch history line up.
  const fileName = `${conn.broker}-api-${today}`;
  try {
    const pre = previewParsedFile(parsed, null, conn.accountId, fileName);
    const cls = classifyPreview(pre);
    if (cls === "nothingNew") {
      return { ...base, status: "nothingNew", detail: pre.summary.total > 0 ? "already in the journal" : "no trades today" };
    }
    if (cls === "collision") {
      // The manual flow's needsForce 409. Auto-pull must never force past a
      // collision — these rows wait for the Import screen.
      return { ...base, status: "collision", detail: "collision — review in Import" };
    }
    commitParsedFile(parsed, fileName, null, conn.accountId);
    db.update(brokerConnections)
      .set({ lastPullAt: new Date().toISOString() })
      .where(eq(brokerConnections.id, conn.id))
      .run();
    return { ...base, status: "imported", detail: `+${pre.summary.newCount} trade${pre.summary.newCount === 1 ? "" : "s"}`, newCount: pre.summary.newCount };
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
              : e.status === "nothingNew" ? "nothing new"
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
