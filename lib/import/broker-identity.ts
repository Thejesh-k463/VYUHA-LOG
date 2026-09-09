import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brokerConnections, trades } from "@/lib/db/schema";
import { readSecret, secretsEqual } from "@/lib/vault";
import { BROKER_LABELS, type Broker } from "@/lib/domain/constants";
import type { DuplicateConnectionGroup, DuplicateTradeGroup } from "@/lib/analytics/data-quality";

/**
 * WHO a broker connection belongs to, and where else that same client already
 * is (v4.2.1, owner rulings R4a / R4b).
 *
 * ── The question this module answers ────────────────────────────────────────
 *
 * `broker_connections` is unique on (account_id, broker), so ONE Dhan client
 * can be connected under account #1 and again under account #2 with nothing
 * refusing it. Both connections then pull the same tradebook, the dedup hash
 * carries no account id (lib/import/dedup.ts) and the index that enforces it
 * is per account (`trades_account_broker_dedup_uq`) — so the same broker
 * record is stored twice and the All-accounts view counts both copies.
 *
 * ── WHOLE-DATABASE READER, DELIBERATELY (invariant 8) ───────────────────────
 *
 * Every read here spans EVERY account and resolves no selected account: the
 * fact being reported is "this identity is in more than one account", and an
 * account filter would hide exactly the row that makes the answer true. A
 * rival that only exists when you happen to be looking at the other book is
 * not a refusal at all — the save would simply succeed from the other view.
 * Same reasoning as lib/jobs/auto-pull.ts and lib/vault.ts's sweep.
 *
 * `0 is a view, not a place` still holds for every WRITE: nothing here writes,
 * and the one write path built on it (app/data-quality/actions.ts) refuses
 * account 0 before it deletes anything.
 *
 * ── The identity, per broker ────────────────────────────────────────────────
 *
 * The identifier must name the CLIENT and must be STABLE. Never the access
 * token: it rotates daily for Zerodha and Dhan, so two accounts holding the
 * same client would compare as different every morning.
 *
 *   dhan          apiKey — for Dhan the `api_key` column IS the Client ID
 *                 (route.ts labels the field "Client ID").
 *   zerodha       auth_json.kiteUserId when the connection has one, else
 *                 apiKey. The api_key is the KITE CONNECT APP's key, not the
 *                 client's: one developer app can log in several Zerodha
 *                 clients, so treating it as the identity would refuse a
 *                 second, genuinely different account with no way around it.
 *                 The user id is stamped into auth_json on the first token
 *                 exchange (route.ts ~:757) and is the id Zerodha itself
 *                 states; falling back to the app key keeps the refusal
 *                 working for connections that have not exchanged yet.
 *   angelone      auth_json.clientCode — the SmartAPI api_key is the app's,
 *                 same as Zerodha; the client code is the account.
 *   upstox        apiKey — the Analytics token is the only identifier an
 *                 Upstox connection carries, and it is issued per client.
 *   openalgo:*    apiKey — the OpenAlgo instance's own key. Two accounts
 *                 pointing at one instance are one client.
 *   anything else apiKey.
 *
 * Comparison is `secretsEqual` (lib/vault.ts) — constant time, and it is the
 * repo's one equality for values of this kind.
 *
 * ── The plaintext never leaves this module ──────────────────────────────────
 *
 * `findRivalConnection` answers with an ACCOUNT, not with an identifier, and
 * the grouped listings carry only the masked form. Grouping is keyed on a
 * sha-256 of the identity, so no structure this module builds holds the
 * plaintext at all.
 */

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/**
 * The two masks the Import screen already shows, character for character:
 * `maskSecret` is app/api/import/broker/route.ts:92 (`mask`, the stored-key
 * form — "111…••••") and `maskAccountId` is :99 (`maskId`, used in the Zerodha
 * id-mismatch message). They are re-stated here rather than imported because
 * the route declares them as module-local consts and exports neither; the
 * route is free to import these two and delete its own copies, which is the
 * direction this duplication should be resolved in.
 *
 * A secret shorter than six characters is bullets ALONE: the last-two tail
 * that `maskAccountId` keeps is 40% of a five-character secret, which is a
 * leak rather than a hint. An account id is not a secret, so it keeps its tail.
 */
export function maskSecret(s: string): string {
  if (s.length < 6) return "••••";
  return `${s.slice(0, Math.min(4, Math.floor(s.length / 3)))}…${"•".repeat(4)}`;
}

export function maskAccountId(s: string): string {
  return s.length <= 2 ? "••" : `${"•".repeat(s.length - 2)}${s.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------

/**
 * The joiner for every grouping key below. Built at runtime rather than
 * written as an escape, because a literal control byte in a source file
 * makes grep read the file as binary — and it is not a character any broker
 * id, dedup hash or hex digest can contain, so two different pairs can never
 * fold into one key (a broker id CAN contain a colon: openalgo:zerodha).
 */
const SEP = String.fromCharCode(31);

/** `id` = a client code/user id (not a secret); `secret` = a stored key. */
type IdentityKind = "id" | "secret";

interface BrokerIdentity {
  kind: IdentityKind;
  /** Plaintext. Never returned, never logged, never rendered. */
  value: string;
}

export interface ConnectionIdentityInput {
  broker: string;
  /** Plaintext or the stored vault ciphertext — `readSecret` reads either. */
  apiKey?: string | null;
  authJson?: string | null;
}

const readPlain = (stored: string | null | undefined): string => {
  const r = readSecret(stored);
  return r.ok ? r.value.trim() : "";
};

const readAuth = (stored: string | null | undefined): Record<string, unknown> | null => {
  const plain = readPlain(stored);
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const authString = (auth: Record<string, unknown> | null, key: string): string =>
  auth && typeof auth[key] === "string" ? (auth[key] as string).trim() : "";

/**
 * The stable client identifier for a connection, or null when there is none to
 * compare — an unreadable vault, an empty key, an Angel One row with no client
 * code. Null NEVER matches anything: a credential we cannot read is not
 * evidence that two accounts hold the same client, and refusing a save on it
 * would be a refusal nobody can clear.
 */
export function connectionIdentity(c: ConnectionIdentityInput): BrokerIdentity | null {
  const key = readPlain(c.apiKey);
  if (c.broker === "angelone") {
    const code = authString(readAuth(c.authJson), "clientCode");
    return code ? { kind: "id", value: code } : null;
  }
  if (c.broker === "zerodha") {
    const uid = authString(readAuth(c.authJson), "kiteUserId");
    if (uid) return { kind: "id", value: uid };
  }
  return key ? { kind: "secret", value: key } : null;
}

/** The masked form of an identity — the ONLY form that may be displayed. */
export function maskedIdentity(id: BrokerIdentity): string {
  return id.kind === "id" ? maskAccountId(id.value) : maskSecret(id.value);
}

/** Two identities are the same client only if their KIND matches too, so a
 *  client code can never collide with an API key that happens to equal it. */
function sameIdentity(a: BrokerIdentity, b: BrokerIdentity): boolean {
  return a.kind === b.kind && secretsEqual(a.value, b.value);
}

/** A grouping key that is not the identity: sha-256 over kind + value. */
function identityKey(id: BrokerIdentity): string {
  return createHash("sha256").update(`${id.kind}:${id.value}`).digest("hex");
}

/** "Dhan", "Angel One", "OpenAlgo (Zerodha)", or the stored id verbatim. */
export function brokerLabel(broker: string): string {
  if (broker.startsWith("openalgo:")) {
    const under = broker.slice("openalgo:".length);
    return `OpenAlgo (${BROKER_LABELS[under as Broker] ?? under})`;
  }
  if (broker === "openalgo") return "OpenAlgo";
  return BROKER_LABELS[broker as Broker] ?? broker;
}

function accountNames(): Map<number, string> {
  return new Map(db.select({ id: accounts.id, name: accounts.name }).from(accounts).all().map((a) => [a.id, a.name]));
}

const nameOf = (names: Map<number, string>, id: number): string => names.get(id) ?? `Account ${id}`;

// ---------------------------------------------------------------------------
// R4a — the rival check the save runs
// ---------------------------------------------------------------------------

/** The OTHER account already holding this broker client. Never the identity. */
export interface RivalConnection {
  accountId: number;
  accountName: string;
}

/**
 * The account — other than `accountId` — whose connection for the SAME broker
 * holds the same client identity, or null.
 *
 * Synchronous: better-sqlite3 is, and the save path that calls this refuses
 * before it writes.
 *
 * @param accountId the account the save would land on. Its own row is skipped,
 *   so re-saving a connection (a new token, a kept key) is never a rival of
 *   itself.
 */
export function findRivalConnection(input: {
  broker: string;
  apiKey?: string | null;
  authJson?: string | null;
  accountId: number;
}): RivalConnection | null {
  const mine = connectionIdentity(input);
  if (!mine) return null;

  const rows = db.select().from(brokerConnections).where(eq(brokerConnections.broker, input.broker)).all();
  const names = accountNames();
  for (const r of rows) {
    if (r.accountId === input.accountId) continue;
    const theirs = connectionIdentity({ broker: r.broker, apiKey: r.apiKey, authJson: r.authJson });
    if (theirs && sameIdentity(mine, theirs)) {
      return { accountId: r.accountId, accountName: nameOf(names, r.accountId) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// R4b (a) — connections that are already duplicated
// ---------------------------------------------------------------------------

/**
 * One group per broker client that sits in two or more accounts, for installs
 * that made the duplicate before the save refused it.
 */
export function listDuplicateConnections(): DuplicateConnectionGroup[] {
  const rows = db.select().from(brokerConnections).all();
  const names = accountNames();
  const groups = new Map<string, { broker: string; masked: string; accountIds: number[] }>();

  for (const r of rows) {
    const id = connectionIdentity({ broker: r.broker, apiKey: r.apiKey, authJson: r.authJson });
    if (!id) continue;
    // a literal byte: a broker id can itself contain ":" (openalgo:zerodha),
    // and two different pairs must never fold into one key.
    const key = `${r.broker}${SEP}${identityKey(id)}`;
    const g = groups.get(key) ?? { broker: r.broker, masked: maskedIdentity(id), accountIds: [] };
    if (!g.accountIds.includes(r.accountId)) g.accountIds.push(r.accountId);
    groups.set(key, g);
  }

  return [...groups.values()]
    .filter((g) => g.accountIds.length >= 2)
    .map((g) => ({
      broker: g.broker,
      brokerLabel: brokerLabel(g.broker),
      maskedIdentity: g.masked,
      accounts: g.accountIds.sort((a, b) => a - b).map((id) => ({ id, name: nameOf(names, id) })),
    }))
    .sort((a, b) => a.brokerLabel.localeCompare(b.brokerLabel));
}

// ---------------------------------------------------------------------------
// R4b (b) — the same broker record in two books
// ---------------------------------------------------------------------------

interface DupRow {
  id: number;
  accountId: number;
  broker: string;
  dedupHash: string;
  symbol: string;
  qty: number;
  buyDate: string | null;
  sellDate: string | null;
}

const dupColumns = {
  id: trades.id,
  accountId: trades.accountId,
  broker: trades.broker,
  dedupHash: trades.dedupHash,
  symbol: trades.symbol,
  buyQty: trades.buyQty,
  sellQty: trades.sellQty,
  buyDate: trades.buyDate,
  sellDate: trades.sellDate,
};

const toDupRow = (r: { id: number; accountId: number; broker: string; dedupHash: string; symbol: string; buyQty: number; sellQty: number; buyDate: string | null; sellDate: string | null }): DupRow => ({
  id: r.id,
  accountId: r.accountId,
  broker: r.broker,
  dedupHash: r.dedupHash,
  symbol: r.symbol,
  qty: r.buyQty > 0 ? r.buyQty : r.sellQty,
  buyDate: r.buyDate,
  sellDate: r.sellDate,
});

/** Fold rows that share one (broker, dedupHash) into a group, or null when
 *  they all sit in ONE account — a sole copy is not a duplicate. */
function toGroup(rows: DupRow[], names: Map<number, string>): DuplicateTradeGroup | null {
  const byAccount = new Map<number, number>();
  for (const r of rows) byAccount.set(r.accountId, (byAccount.get(r.accountId) ?? 0) + 1);
  if (byAccount.size < 2) return null;
  const first = rows[0];
  return {
    broker: first.broker,
    brokerLabel: brokerLabel(first.broker),
    dedupHash: first.dedupHash,
    symbol: first.symbol,
    qty: first.qty,
    buyDate: first.buyDate,
    sellDate: first.sellDate,
    rows: rows.length,
    ids: rows.map((r) => r.id).sort((a, b) => a - b),
    accounts: [...byAccount.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, n]) => ({ id, name: nameOf(names, id), rows: n })),
  };
}

/** Every (broker, dedupHash) present in two or more accounts. */
export function listDuplicateTradeGroups(): DuplicateTradeGroup[] {
  const rows = db.select(dupColumns).from(trades).all().map(toDupRow);
  const names = accountNames();
  const byKey = new Map<string, DupRow[]>();
  for (const r of rows) {
    const key = `${r.broker}${SEP}${r.dedupHash}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const out: DuplicateTradeGroup[] = [];
  for (const list of byKey.values()) {
    const g = toGroup(list, names);
    if (g) out.push(g);
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.dedupHash.localeCompare(b.dedupHash));
}

/**
 * One group, re-derived from the database.
 *
 * The fix path calls this instead of trusting the form it was submitted from:
 * a page rendered ten minutes ago can name a group that is no longer
 * duplicated, and deleting "the copy" of a record that now has only one copy
 * is data loss, not a fix. Null means "not duplicated across accounts".
 */
export function findDuplicateTradeGroup(broker: string, dedupHash: string): DuplicateTradeGroup | null {
  const rows = db
    .select(dupColumns)
    .from(trades)
    .where(and(eq(trades.broker, broker), eq(trades.dedupHash, dedupHash)))
    .all()
    .map(toDupRow);
  if (rows.length === 0) return null;
  return toGroup(rows, accountNames());
}

/** The rows of one group that live in ONE account — the exact ids a fix
 *  removes. Empty when that account holds no copy. */
export function duplicateTradeIdsIn(broker: string, dedupHash: string, accountId: number): number[] {
  if (!Number.isInteger(accountId) || accountId <= 0) return [];
  return db
    .select({ id: trades.id })
    .from(trades)
    .where(and(eq(trades.broker, broker), eq(trades.dedupHash, dedupHash), eq(trades.accountId, accountId)))
    .all()
    .map((r) => r.id)
    .sort((a, b) => a - b);
}
