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
 * snapshot is `{notice, broker, accountId, from, to, reason, fact, remedy,
 * clearedAt: null}` (`fact` / `remedy` since v4.3.0 fix wave 2, P15 / P16);
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

/**
 * One outstanding span as GET sends it to the card (P15 / P16, v4.3.0 fix
 * wave 2): the server's OWN sentences, which the card prints verbatim and never
 * re-derives. `fact` + `remedy` are what toParsedFile warned when the span was
 * kept (DhanUnfetchedSpan.fact / remedyText), in its ISO dates. A row kept
 * before they were stored reads its audit row's `summary` as `fact`, with
 * `remedy` null — the sentence the server wrote then, never an inferred one.
 */
export interface UnfetchedSpanRow {
  from: string;
  to: string;
  reason: string;
  fact: string;
  remedy: string | null;
}

/** An outstanding span with the connection its latest row names (audit_log.entity_id). */
type OpenSpan = UnfetchedSpanRow & { connId: number | null };

const keyOf = (s: { from: string; to: string; reason: string }) => `${s.from}|${s.to}|${s.reason}`;

function outstandingVia(exec: Pick<typeof db, "select">, accountId: number): OpenSpan[] {
  const rows = exec
    .select({ after: auditLog.afterJson, summary: auditLog.summary, entityId: auditLog.entityId })
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
  const latest = new Map<string, OpenSpan & { cleared: boolean }>();
  for (const r of rows) {
    const a = r.after;
    if (!a) continue;
    const from = String(a.from ?? "");
    const to = String(a.to ?? "");
    const reason = String(a.reason ?? "");
    if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) continue;
    const fact =
      typeof a.fact === "string" && a.fact
        ? a.fact
        : r.summary || `Fills from ${from} to ${to} were not fetched by a Dhan pull.`;
    const remedy = typeof a.fact === "string" && a.fact && typeof a.remedy === "string" && a.remedy ? a.remedy : null;
    latest.set(keyOf({ from, to, reason }), { from, to, reason, fact, remedy, connId: r.entityId ?? null, cleared: a.clearedAt != null });
  }
  return [...latest.values()]
    .filter((s) => !s.cleared)
    .map(({ from, to, reason, fact, remedy, connId }) => ({ from, to, reason, fact, remedy, connId }))
    .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

/** The spans still outstanding for one account, oldest first — GET's shape. */
export function outstandingUnfetched(accountId: number): UnfetchedSpanRow[] {
  return outstandingVia(db, accountId).map(({ from, to, reason, fact, remedy }) => ({ from, to, reason, fact, remedy }));
}

interface SpanOwner {
  /** The broker_connections row the pull ran on (the audit row's entity id). */
  connId: number | null;
  accountId: number;
  /** audit_log.source — "import" for the route, "auto-pull" for the sweep. */
  source: string;
}

type SpanWrite = { from: string; to: string; reason: string; summary: string; fact: string; remedy: string | null };

/** The span's own connection (P11). N4 (v4.3.0 fix wave 2R): a row with no
 *  connection — an account merge's carry — matches NO connection. The merge
 *  keeps the target's own Dhan client (R4a: a different client), whose read
 *  says nothing about the source client's fills; only the user's Clear removes
 *  a carried notice. */
const sameConnection = (a: number | null, b: number | null) => a != null && b != null && a === b;

/** The ISO day before `day` (UTC arithmetic on a calendar date — no clock). */
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The row that CLEARS an outstanding span — the same keys, `clearedAt` set,
 *  appended (the record it clears is never rewritten). */
function clearRow(o: OpenSpan, owner: SpanOwner, summary: string) {
  const snap = { notice: DHAN_UNFETCHED_NOTICE, broker: "dhan", accountId: owner.accountId, from: o.from, to: o.to, reason: o.reason };
  return {
    entity: "settings",
    entityId: owner.connId,
    action: "update",
    summary,
    beforeJson: { ...snap, clearedAt: null },
    afterJson: { ...snap, clearedAt: new Date().toISOString() },
    source: owner.source,
  };
}

/**
 * Append the spans to the store through `exec`, THROWING on failure.
 *
 * Idempotent: a span already outstanding for the account with the same
 * from/to/reason is skipped. A pull whose write failed leaves lastPullAt where
 * it was, so the next pull recomputes the very same span — and must not list
 * it twice once the write succeeds.
 *
 * P11 (v4.3.0 fix wave 2), `supersede` (a PULL's write): R19 keeps the spans
 * before the commit, so a commit that then throws leaves a span with the stamp
 * unmoved. A retry on a later day recomputes the range-cap span with a later
 * `to` (catchUpRange's floor moved), which the from|to|reason key would list as
 * a SECOND, overlapping notice. So a new span supersedes the outstanding span
 * with the same account + reason + `from` and the same connection (N4: a
 * merge-carried row names none, so no pull supersedes it): its clear row and the new row are appended together, in the
 * caller's transaction. An account merge's carry does not supersede — two books'
 * spans that happen to start on one day are two facts.
 */
function writeSpans(exec: Exec, spans: readonly SpanWrite[], owner: SpanOwner, supersede = false): number {
  if (spans.length === 0) return 0;
  const outstanding = outstandingVia(exec, owner.accountId);
  const open = new Set(outstanding.map(keyOf));
  const values = [];
  for (const s of spans) {
    const k = keyOf(s);
    if (open.has(k)) continue;
    open.add(k);
    if (supersede) {
      for (const o of outstanding) {
        if (o.reason !== s.reason || o.from !== s.from || o.to === s.to || !sameConnection(o.connId, owner.connId)) continue;
        if (!open.has(keyOf(o))) continue;
        open.delete(keyOf(o));
        values.push(
          clearRow(o, owner, `Dhan notice superseded by a later pull: fills from ${o.from} to ${o.to} are now named as fills from ${s.from} to ${s.to}.`),
        );
      }
    }
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
        fact: s.fact,
        remedy: s.remedy,
        clearedAt: null,
      },
      source: owner.source,
    });
  }
  if (values.length > 0) exec.insert(auditLog).values(values).run();
  return values.length;
}

const asRows = (spans: readonly DhanUnfetchedSpan[]): SpanWrite[] =>
  spans.map((s) => ({ from: s.from, to: s.to, reason: s.reason, summary: s.message, fact: s.fact, remedy: s.remedyText }));

/**
 * P11: the page-cap spans a successful, UNTRUNCATED history read covered.
 * `read` is that pull's window [from, to] — pass null when the walk was
 * truncated or no history was read. A span inside the window was read in full
 * this time (its first day's fills after the last stamp too: the same stamp
 * gave the same `after`), so its notice no longer names a gap. Range-cap spans
 * sit before the window by construction and are never cleared here.
 *
 * N5 (v4.3.0 fix wave 2R): a CLAMPED page-cap span starts on the floor of the
 * pull that kept it. A retry on a later day (its commit threw, so the stamp
 * never moved) reads from a later floor, and keeps — before this clear runs
 * (R19) — the range-cap span [stamp day, its floor − 1] that names the days in
 * between. The window the pull accounted for is therefore [that range-cap
 * span's from, read.to]: a page-cap span wholly inside it is cleared, whatever
 * its from. Only a range-cap span of the SAME connection ending the day before
 * the read counts; with none, a span starting before the read stays listed
 * (its first days were neither read nor named — e.g. a committed truncated
 * pull, whose stamp moved past them).
 */
function clearCoveredPageCaps(exec: Exec, owner: SpanOwner, read: { from: string; to: string } | null): void {
  if (!read) return;
  const outstanding = outstandingVia(exec, owner.accountId).filter((o) => sameConnection(o.connId, owner.connId));
  const beforeRead = dayBefore(read.from);
  const named = outstanding.find((o) => o.reason === "range-cap" && o.to === beforeRead) ?? null;
  const coveredFrom = named && named.from < read.from ? named.from : read.from;
  const values = outstanding
    .filter((o) => o.reason === "page-cap" && coveredFrom <= o.from && o.to <= read.to)
    .map((o) => {
      const parts: string[] = [];
      if (o.to >= read.from) parts.push(`fills from ${o.from < read.from ? read.from : o.from} to ${o.to} were read`);
      if (named && o.from < read.from) {
        parts.push(`fills from ${o.from} to ${o.to < beforeRead ? o.to : beforeRead} are named by the notice for fills from ${named.from} to ${named.to}`);
      }
      return clearRow(o, owner, `Dhan notice cleared by a later pull that read Dhan's trade history from ${read.from} to ${read.to} in full: ${parts.join("; ")}.`);
    });
  if (values.length > 0) exec.insert(auditLog).values(values).run();
}

/**
 * R19: keep what a pull did not read, in its own transaction, BEFORE the pull
 * commits. Throws when the notice cannot be saved; the caller then commits
 * nothing and leaves lastPullAt unmoved. Recording first is safe because a
 * range-cap or page-cap span is true whether or not the commit lands.
 */
export function keepUnfetched(spans: readonly DhanUnfetchedSpan[], owner: SpanOwner): void {
  if (spans.length === 0) return;
  db.transaction((tx) => {
    writeSpans(tx, asRows(spans), owner, true);
  });
}

/**
 * R27: a pull that found nothing new is still a successful READ — its spans
 * and the stamp land together, in ONE transaction, or neither does. Also the
 * stamp after a commit (with the spans already kept, `spans` empty). `stamp`
 * is the instant taken immediately before the pull read today's book (R42),
 * never a post-commit clock.
 *
 * P11: `read` is the window an UNTRUNCATED history walk covered (null when the
 * walk was truncated or there was none); the page-cap spans inside it are
 * cleared in this same transaction, so the notice and the stamp never disagree.
 */
export function keepUnfetchedAndStamp(
  spans: readonly DhanUnfetchedSpan[],
  owner: SpanOwner & { connId: number },
  stamp: string,
  read: { from: string; to: string } | null = null,
): void {
  db.transaction((tx) => {
    writeSpans(tx, asRows(spans), owner, true);
    clearCoveredPageCaps(tx, owner, read);
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
    // P15 / P16: the source's own sentences travel with the span, so the
    // target's card says what the source's did.
    spans.map((s) => ({
      from: s.from,
      to: s.to,
      reason: s.reason,
      fact: s.fact,
      remedy: s.remedy,
      summary: `Dhan notice carried from “${opts.fromName}” into “${opts.toName}” by an account merge: fills from ${s.from} to ${s.to} were not fetched by a pull.`,
    })),
    { connId: null, accountId: opts.toAccountId, source: opts.source },
  );
}
