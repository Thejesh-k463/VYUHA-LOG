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
 * notice is outstanding while the latest row for its span is uncleared. Read
 * by ACCOUNT, not connection id, because the fact is about the book: a
 * disconnect + reconnect in the same account still shows it. L1 (v4.3.0 fix
 * wave 2G): a span's IDENTITY includes its connection (audit_log.entity_id), so
 * a merge-carried span (no connection) and the target client's span with the
 * same from / to / reason are two records — a pull's clear names its own
 * connection's (`scope: "connection"`). H4 (v4.3.0 fix wave 2H): GET lists one
 * line per RECORD, each with its own fact and its connection (records with the
 * same span AND the same sentences share one line), and the card's Clear names
 * that connection — clearUnfetchedLine clears exactly the records on that line.
 * A Clear with no connection field (the route's legacy row) still clears the
 * span on every connection of the account.
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
/** L1: one record's identity — its connection (null: carried by a merge) and its span. */
const recordKeyOf = (connId: number | null, s: { from: string; to: string; reason: string }) => `${connId ?? "-"}|${keyOf(s)}`;

/** L1: marks a clear row a PULL appended (clearRow), and H4: a user Clear that
 *  named its record (clearUnfetchedLine). It clears only the span of its own
 *  connection (entity_id; null = a merge-carried record). A clear row without
 *  it — the route's legacy Clear, no connection field — clears the account's
 *  span on every connection. */
const CLEAR_SCOPE_CONNECTION = "connection";

/** H4: the records that share one card line — the same span AND the same
 *  sentences. A different fact (another client's last pull at another time of
 *  day) is a second line, so no Clear dismisses a fact the card did not show. */
const lineKeyOf = (s: UnfetchedSpanRow) => `${keyOf(s)}|${s.fact}|${s.remedy ?? ""}`;

/** Every record's LATEST state for one account — its last kept row, and whether
 *  a later clear row cleared it (S3: a cleared record keeps the sentences it
 *  last stated, so a Clear from a card that loaded before can find its line). */
function latestVia(exec: Pick<typeof db, "select">, accountId: number): (OpenSpan & { cleared: boolean })[] {
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
    const connId = r.entityId ?? null;
    if (a.clearedAt != null) {
      if (a.scope === CLEAR_SCOPE_CONNECTION) {
        const own = latest.get(recordKeyOf(connId, { from, to, reason }));
        if (own) own.cleared = true;
      } else {
        const k = keyOf({ from, to, reason });
        for (const o of latest.values()) if (keyOf(o) === k) o.cleared = true;
      }
      continue;
    }
    const fact =
      typeof a.fact === "string" && a.fact
        ? a.fact
        : r.summary || `Fills from ${from} to ${to} were not fetched by a Dhan pull.`;
    const remedy = typeof a.fact === "string" && a.fact && typeof a.remedy === "string" && a.remedy ? a.remedy : null;
    latest.set(recordKeyOf(connId, { from, to, reason }), { from, to, reason, fact, remedy, connId, cleared: false });
  }
  return [...latest.values()];
}

function outstandingVia(exec: Pick<typeof db, "select">, accountId: number): OpenSpan[] {
  return latestVia(exec, accountId)
    .filter((s) => !s.cleared)
    .map(({ from, to, reason, fact, remedy, connId }) => ({ from, to, reason, fact, remedy, connId }))
    .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

/** One outstanding record with its connection (audit_log.entity_id; null: carried by a merge). */
export type UnfetchedRecord = UnfetchedSpanRow & { connection: number | null };

const asRecord = ({ from, to, reason, fact, remedy, connId }: OpenSpan): UnfetchedRecord => ({ from, to, reason, fact, remedy, connection: connId });

/** H4: every outstanding RECORD for one account, oldest span first. */
export function outstandingUnfetchedRecords(accountId: number): UnfetchedRecord[] {
  return outstandingVia(db, accountId).map(asRecord);
}

/** H4: the card's lines — one per record, except that records with the same span
 *  AND the same sentences share one line, which carries the first record's
 *  connection (a Clear naming it clears the whole line, clearUnfetchedLine). */
export function outstandingUnfetchedLines(accountId: number): UnfetchedRecord[] {
  const seen = new Set<string>();
  const out: UnfetchedRecord[] = [];
  for (const r of outstandingUnfetchedRecords(accountId)) {
    const k = lineKeyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** The lines still outstanding for one account, oldest first — GET's `unfetched`
 *  shape, unchanged (no connection key); GET sends each line's connection beside
 *  it, by index (app/api/import/broker/route.ts `unfetchedConnection`). */
export function outstandingUnfetched(accountId: number): UnfetchedSpanRow[] {
  return outstandingUnfetchedLines(accountId).map(({ from, to, reason, fact, remedy }) => ({ from, to, reason, fact, remedy }));
}

/** A clear row's before / after snapshots. `scope` sits on BOTH sides, so the
 *  Audit log's diff (lib/analytics/audit-diff.ts, the union of both key sets)
 *  shows `clearedAt` only — a clear changes no scope of the notice. */
function clearSnapshots(accountId: number, s: { from: string; to: string; reason: string }) {
  const snap = { notice: DHAN_UNFETCHED_NOTICE, broker: "dhan", accountId, from: s.from, to: s.to, reason: s.reason, scope: CLEAR_SCOPE_CONNECTION };
  return { beforeJson: { ...snap, clearedAt: null }, afterJson: { ...snap, clearedAt: new Date().toISOString() } };
}

/**
 * H4: the user's Clear of ONE card line, named by its record's connection
 * (null: a merge-carried record) and span. Clears that record and every record
 * on its line (the same span and sentences, outstandingUnfetchedLines) — one
 * connection-scoped clear row each, appended in one transaction, THROWING on
 * failure. Returns how many records were cleared; 0 when no open record is on
 * the named record's line (nothing is written).
 *
 * S3 (v4.3.0 fix wave 2H seam): the Clear targets the LINE the card showed. A
 * shared line carries one record's connection; when a pull (the route's or
 * lib/jobs/auto-pull.ts) cleared THAT record after the card loaded, the named
 * record is no longer open, and its last stored sentences identify the line:
 * the open records with the same span and the same sentences are cleared. A
 * named record that was never kept for the account matches nothing.
 */
export function clearUnfetchedLine(
  accountId: number,
  record: { from: string; to: string; reason: string; connection: number | null },
  summary: string,
  source = "ui",
): number {
  return db.transaction((tx) => {
    const all = latestVia(tx, accountId);
    const named = all.find((o) => o.connId === record.connection && keyOf(o) === keyOf(record));
    if (!named) return 0;
    const line = all.filter((o) => !o.cleared && lineKeyOf(o) === lineKeyOf(named));
    if (line.length === 0) return 0;
    tx.insert(auditLog)
      .values(line.map((o) => ({ entity: "settings", entityId: o.connId, action: "update", summary, ...clearSnapshots(accountId, o), source })))
      .run();
    return line.length;
  });
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
 *  appended (the record it clears is never rewritten). Every caller passes a
 *  span of the owner's own connection (sameConnection), and L1's scope says so:
 *  the row clears that connection's record only. */
function clearRow(o: OpenSpan, owner: SpanOwner, summary: string) {
  return {
    entity: "settings",
    entityId: owner.connId,
    action: "update",
    summary,
    ...clearSnapshots(owner.accountId, o),
    source: owner.source,
  };
}

/**
 * Append the spans to the store through `exec`, THROWING on failure.
 *
 * Idempotent: a span already outstanding for the account with the same
 * connection and from/to/reason is skipped (L1: the same span of ANOTHER
 * connection — a merge's carry beside the target client's own — is a second
 * record, not a repeat). A pull whose write failed leaves lastPullAt where
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
  const open = new Set(outstanding.map((o) => recordKeyOf(o.connId, o)));
  const values = [];
  for (const s of spans) {
    const k = recordKeyOf(owner.connId, s);
    if (open.has(k)) continue;
    open.add(k);
    if (supersede) {
      for (const o of outstanding) {
        if (o.reason !== s.reason || o.from !== s.from || o.to === s.to || !sameConnection(o.connId, owner.connId)) continue;
        if (!open.has(recordKeyOf(o.connId, o))) continue;
        open.delete(recordKeyOf(o.connId, o));
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
