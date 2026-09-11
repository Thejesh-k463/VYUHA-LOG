import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, brokerConnections } from "@/lib/db/schema";
import type { DhanUnfetchedSpan } from "@/lib/import/api/dhan";

/**
 * C-6 (v4.3.0 fix wave C, owner ruling "Say it plainly") — the KEPT notice for
 * Dhan history a committed pull never read. ONE module, so the manual route
 * (app/api/import/broker/route.ts), the background sweep (lib/jobs/auto-pull.ts)
 * and an account merge (lib/queries/account-delete.ts) write and read the same
 * record. Moved here from the route in v4.3.0 fix wave 1 (R19, R27, R10).
 *
 * THE STORE IS THE AUDIT TRAIL, and no column was added (4.3.0 ships exactly
 * one migration, 0071). A record is one append-only `audit_log` row, entity
 * "settings" (what every broker-connection event already uses), whose after
 * snapshot is `{notice, broker, accountId, from, to, reason, clearedAt: null}`;
 * the user's clear is a SECOND row with the same keys and `clearedAt` set. The
 * notice is outstanding while the latest row for its span is uncleared. Keyed
 * by ACCOUNT, not connection id, because the fact is about the book: a
 * disconnect + reconnect in the same account still shows it.
 *
 * Why not the alternatives: `auth_json` is the vault-encrypted credential blob
 * — `hasAuth`, `clearAuth`, a re-save with new PIN + TOTP and the backup's
 * credential redaction would each misreport or silently erase the notice;
 * `import_batches.notes` is shown on the imports table and every file touching
 * that table must be a declared owner in tests/account-isolation.test.ts
 * (auto-pull resolves no account by design); `panel_dismissals` is
 * account-scoped with its own owners and the inverse meaning; `settings` has no
 * general JSON column. `audit_log` has no account_id (lib/domain/search-scope.ts),
 * travels in backups, and is already written by every caller.
 *
 * THE WRITES THROW. `recordAuditMany` swallows an INSERT failure by design
 * (auditing is best-effort) — which let a pull move lastPullAt past dates whose
 * notice was never saved (R19). Every writer here uses a plain `insert` inside
 * a transaction, so a failure reaches the caller and the caller refuses to go
 * on. This module never READS broker_connections (it only stamps a row by id),
 * so it is not a scoped reader in tests/account-isolation.test.ts's sense.
 */

export const DHAN_UNFETCHED_NOTICE = "dhan-unfetched";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What a write needs from its executor — the connection or a transaction. */
type Exec = Pick<typeof db, "select" | "insert" | "update">;

export interface UnfetchedSpanRow {
  from: string;
  to: string;
  reason: string;
}

const keyOf = (s: { from: string; to: string; reason: string }) => `${s.from}|${s.to}|${s.reason}`;

function outstandingVia(exec: Pick<typeof db, "select">, accountId: number): UnfetchedSpanRow[] {
  const rows = exec
    .select({ after: auditLog.afterJson })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entity, "settings"),
        sql`json_extract(${auditLog.afterJson}, '$.notice') = ${DHAN_UNFETCHED_NOTICE}`,
        sql`json_extract(${auditLog.afterJson}, '$.accountId') = ${accountId}`,
      ),
    )
    .orderBy(asc(auditLog.id))
    .all();
  const latest = new Map<string, UnfetchedSpanRow & { cleared: boolean }>();
  for (const r of rows) {
    const a = r.after;
    if (!a) continue;
    const from = String(a.from ?? "");
    const to = String(a.to ?? "");
    const reason = String(a.reason ?? "");
    if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) continue;
    latest.set(keyOf({ from, to, reason }), { from, to, reason, cleared: a.clearedAt != null });
  }
  return [...latest.values()]
    .filter((s) => !s.cleared)
    .map(({ from, to, reason }) => ({ from, to, reason }))
    .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

/** The spans still outstanding for one account, oldest first. */
export function outstandingUnfetched(accountId: number): UnfetchedSpanRow[] {
  return outstandingVia(db, accountId);
}

interface SpanOwner {
  /** The broker_connections row the pull ran on (the audit row's entity id). */
  connId: number | null;
  accountId: number;
  /** audit_log.source — "import" for the route, "auto-pull" for the sweep. */
  source: string;
}

/**
 * Append the spans to the store through `exec`, THROWING on failure.
 *
 * Idempotent: a span already outstanding for the account with the same
 * from/to/reason is skipped. A pull whose write failed leaves lastPullAt where
 * it was, so the next pull recomputes the very same span — and must not list
 * it twice once the write succeeds.
 */
function writeSpans(exec: Exec, spans: readonly { from: string; to: string; reason: string; summary: string }[], owner: SpanOwner): number {
  if (spans.length === 0) return 0;
  const open = new Set(outstandingVia(exec, owner.accountId).map(keyOf));
  const values = [];
  for (const s of spans) {
    const k = keyOf(s);
    if (open.has(k)) continue;
    open.add(k);
    values.push({
      entity: "settings",
      entityId: owner.connId,
      action: "create",
      summary: s.summary,
      beforeJson: null,
      afterJson: {
        notice: DHAN_UNFETCHED_NOTICE,
        broker: "dhan",
        accountId: owner.accountId,
        from: s.from,
        to: s.to,
        reason: s.reason,
        clearedAt: null,
      },
      source: owner.source,
    });
  }
  if (values.length > 0) exec.insert(auditLog).values(values).run();
  return values.length;
}

const asRows = (spans: readonly DhanUnfetchedSpan[]) =>
  spans.map((s) => ({ from: s.from, to: s.to, reason: s.reason, summary: s.message }));

/**
 * R19: keep what a pull did not read, in its own transaction, BEFORE the pull
 * commits. Throws when the notice cannot be saved; the caller then commits
 * nothing and leaves lastPullAt unmoved. Recording first is safe because a
 * range-cap or page-cap span is true whether or not the commit lands.
 */
export function keepUnfetched(spans: readonly DhanUnfetchedSpan[], owner: SpanOwner): void {
  if (spans.length === 0) return;
  db.transaction((tx) => {
    writeSpans(tx, asRows(spans), owner);
  });
}

/**
 * R27: a pull that found nothing new is still a successful READ — its spans
 * and the stamp land together, in ONE transaction, or neither does. Also the
 * stamp after a commit (with the spans already kept). `stamp` is the instant
 * taken immediately before the pull read today's book (R42), never a
 * post-commit clock.
 */
export function keepUnfetchedAndStamp(spans: readonly DhanUnfetchedSpan[], owner: SpanOwner & { connId: number }, stamp: string): void {
  db.transaction((tx) => {
    writeSpans(tx, asRows(spans), owner);
    tx.update(brokerConnections).set({ lastPullAt: stamp }).where(eq(brokerConnections.id, owner.connId)).run();
  });
}

/**
 * R10: an account MERGE carries the source account's outstanding notices to
 * the target, inside the merge's own transaction (a throw aborts the merge).
 * Whatever happens to the connection row: the fact is about the BOOK, and the
 * book's trades are what moved. Append-only — the source's own rows stay as
 * they were; one new row per span names the target's account id.
 */
export function carryUnfetchedOnMerge(
  tx: Exec,
  opts: { fromAccountId: number; toAccountId: number; fromName: string; toName: string; source: string },
): number {
  const spans = outstandingVia(tx, opts.fromAccountId);
  return writeSpans(
    tx,
    spans.map((s) => ({
      ...s,
      summary: `Dhan notice carried from “${opts.fromName}” into “${opts.toName}” by an account merge: fills from ${s.from} to ${s.to} were not fetched by a pull.`,
    })),
    { connId: null, accountId: opts.toAccountId, source: opts.source },
  );
}
