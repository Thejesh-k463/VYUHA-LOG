// CROSS-SOURCE DUPLICATE DETECTION (PURE, no DB/React).
//
// ── The problem this exists for ─────────────────────────────────────────────
//
// `dedupHash` keys on broker + tradingsymbol + quantities + PRICES + DATES. That
// is exactly right for re-importing the SAME file: nothing changes, the hash
// matches, the row is skipped.
//
// It cannot work across file KINDS, because the two kinds do not state the same
// facts. A Dhan Global Transaction Report gives one row per (date, scrip, bill)
// with both legs and real dates. A P&L export is scrip-aggregated with no dates
// and often only the side that realised. The same real trade therefore hashes
// differently in each, both rows insert, and the journal now holds it twice.
//
// The symptoms look unrelated but share this one cause:
//   • a holding shows "no cost on record" — the P&L row carried only the sell
//   • a position that was closed still shows open — the extra row has one leg
//   • re-importing "merges wrongly" — nothing merged; it duplicated
//
// ── Why this DETECTS rather than merges ─────────────────────────────────────
//
// Automatically merging two rows means choosing which file's numbers to keep,
// and getting that wrong silently corrupts cost basis, holding period and tax
// treatment. The GTR states charges the broker actually levied; the P&L states
// an aggregate. Neither is a superset. So this reports the collision with enough
// detail for a person to decide, and the import stays a decision rather than a
// guess. That is the same rule the product applies to MTF and to product type.

// Still a leaf: `contract-key.ts` imports only `lib/engine/classify`, which
// imports only `lib/domain/constants` (no parser, no DB) —
// `components/import/import-client.tsx` imports this module into the client bundle.
import { contractKeyOf, monthKeyOf, sameContractDay, sameContractDayOf, type ContractKey } from "./contract-key";
import {
  closeOriginOf,
  execOriginFromNotes,
  heldIdentityHashes,
  isLotIdentityFrozen,
  saysAutoClosePiece,
  UNJOIN_MENU_LABEL,
  type CloseOrigin,
} from "./close-open-lots";

// v4.8.0 X1 (D1): the contract key LIVES in `./contract-key` now; re-exported so
// `pull-symbols.ts` and every test keep importing from here.
export { contractKeyOf, sameContractDay, stripSeriesSuffix, type ContractKey } from "./contract-key";

export interface ExistingRow {
  id: number;
  broker: string;
  symbol: string;
  tradingsymbol: string;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  buyDate: string | null;
  sellDate: string | null;
  sourceFile: string | null;
  dedupHash: string;
  /**
   * v4.8.0 X1 (review D6b iii, PROBE-5b): the row's `import_notes`, read ONLY
   * for the `exec-origin:` segment an auto-close writes — a lot this very file
   * opened that ANOTHER file's execution has since closed is not "a second
   * trade in the same file", so the same-file exclusion below must not hide it.
   * Optional: a caller that hands in none gets exactly the report it got before.
   */
  importNotes?: string | null;
  /** v4.8.0 FIX-A: which side opened a flat row (`sideOf`); read only through `heldIdentityHashes`. */
  side?: string | null;
}

export interface IncomingRow {
  broker: string;
  symbol: string;
  tradingsymbol: string;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  buyDate: string | null;
  sellDate: string | null;
  dedupHash: string;
  /**
   * R43 (4.3.0): set on a broker pull's SNAPSHOT row (a today's-book row dated
   * this IST day) whose hash is new and which the commit will NOT replace in
   * place — the match was ambiguous, or the stored row carries a ladder, an
   * alias or something the user recorded. The ids are the stored rows of
   * today's earlier snapshot on the SUPERSEDE KEY (account + broker + file +
   * day + tradingsymbol + symbol + segment + exchange), as the commit's plan
   * found them, plus any row of that snapshot and tradingsymbol whose segment
   * or exchange the user re-classified (W2F OVERRIDE-DOUBLE); when NOTHING is on
   * the key, every row of that snapshot and tradingsymbol in any segment or
   * exchange (W2G M1, reversing W2R N3 — a broker-side product conversion). Only
   * those rows stop being hidden as "a second trade in the same file", and each
   * one is reported — risky whatever its kind, and even
   * when no quantity or value relation exists (W2R N2) — so the user is asked
   * instead of the pull silently adding a second row.
   */
  snapshotIds?: readonly number[];
  /**
   * W2H (4.3.0): the `snapshotIds` exist ONLY because of W2G M1 — nothing of
   * today's snapshot is on this row's supersede key, and the ids are rows of the
   * same tradingsymbol under another product, segment or exchange. None of the
   * key's reasons (a ladder, a Data Quality join, a user record, two positions on
   * one key) applies, so such an ask gets its own sentence: that reason, and the
   * path that reaches the broker's book. The collision object is unchanged.
   */
  snapshotOffKey?: boolean;
  /**
   * v4.8.0 X1 (review D6b ii, PROBE-4): the stored rows that ALREADY HOLD the
   * hash this execution's remainder or slice would be stored under, as the
   * auto-close plan found them (`heldIdentityHashes`). The plan REFUSED the
   * close rather than insert a row the unique index would reject; the row lands
   * as stated and is reported here as RISKY — whatever file the holder came
   * from — so the pull asks instead of adding a second sale.
   */
  heldIds?: readonly number[];
}

/**
 * `earlier-snapshot` (W2R N2): the row restates a position today's earlier
 * pull recorded on the same key (or, W2G M1, in another segment or exchange
 * when nothing is on the key), with no quantity or value relation to it — a
 * position that grew or changed product, or one of two positions the key
 * cannot tell apart.
 * `held-identity` (X1 D6b ii): the stored row already holds the identity part
 * of this execution would be stored under after an auto-close, so the close
 * was refused and the row is asked about before it is added beside it.
 */
export type OverlapKind = "same-quantity" | "same-value" | "partial-quantity" | "earlier-snapshot" | "held-identity";

export interface CrossSourceCollision {
  symbol: string;
  /**
   * D18 (v4.3.0 wave 2O, ask#0) — WHICH incoming row this blocks: its index in the
   * `incoming` array the caller passed.
   *
   * The dialog is a list of ROWS, not of blockers (at most two are reported per
   * row), and it keyed a card on symbol + the four incoming figures — so two
   * DIFFERENT incoming rows of one scrip that agree on those five (one scrip under
   * two products, or on two exchanges) collapsed into ONE card reading "…cannot
   * vouch for this row." beside a server sentence reading "2 rows in this file
   * (TWOEX)". Wave 2N rejected an id on the premise that such rows are
   * indistinguishable; they are not — they carry different `existing.id`,
   * quantities and detail text.
   */
  row: number;
  incoming: { buyQty: number; sellQty: number; buyValue: number; sellValue: number };
  existing: { id: number; buyQty: number; sellQty: number; sourceFile: string | null };
  kind: OverlapKind;
  /** Plain-language reason a human can check against their broker statement. */
  detail: string;
  /** R43: the existing row is today's earlier snapshot from this same pull file. */
  sameSnapshot?: boolean;
  /**
   * v4.7.0 C6 (review R1): the existing row was met ONLY through the contract
   * key at MONTH level — the two strings differ and one of them states no expiry
   * day (a compact monthly `CDSL26SEP1400CE` against a dated name) — and the
   * two rows share no buy or sell date. A monthly contract must not block a
   * same-month weekly, so this is INFORMATIONAL: reported, never risky.
   */
  monthOnly?: boolean;
  /**
   * v4.8.0 FIX-A (J-1): for a snapshot candidate, WHAT closed the stored row —
   * `closeOriginOf` on its notes — so the sentence can name today's earlier pull,
   * "an earlier pull today" (≤ v4.7.0, no file stored) or a Data Quality join,
   * each with the remedy that actually ends at the broker's figure.
   */
  origin?: CloseOrigin;
  /**
   * v4.8.0 FIX-A (J-2): for `held-identity`, the HOLDER's shape — an auto-close
   * piece (has an Un-close), a plain never-closed row (deletable), or a row that
   * holds the identity as an alias / carries its own other leg (never advise a
   * delete: it holds a purchase on no other row — U1).
   */
  holder?: "auto-close" | "plain-row" | "joined";
}

export interface CrossSourceReport {
  collisions: CrossSourceCollision[];
  /** Distinct symbols involved — what the warning headline counts. */
  symbols: string[];
  /** True when importing as-is would very likely double-count. */
  risky: boolean;
  message: string | null;
}

const norm = (s: string) => s.trim().toUpperCase();
/** Values rarely match to the paisa across file kinds; 1% is a real match. */
const VALUE_TOLERANCE = 0.01;

function closeEnough(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= VALUE_TOLERANCE;
}

type Sides = { buyQty: number; sellQty: number; buyValue: number; sellValue: number };
const statesBuy = (r: Sides) => r.buyQty > 0 || r.buyValue !== 0;
const statesSell = (r: Sides) => r.sellQty > 0 || r.sellValue !== 0;

/**
 * X1 D6b (iii): the file whose execution CLOSED this stored row (the
 * `exec-origin:` segment an auto-close writes), or null when nothing did.
 */
const closedFromFile = (e: ExistingRow): string | null => execOriginFromNotes(e.importNotes ?? null)?.sourceFile ?? null;

/**
 * R43: is `e` the earlier snapshot of `inc`'s own position — this very pull
 * file, on its key? X1 D6b (PROBE-1): a row this pull's earlier execution CLOSED
 * belongs to the pull's book too, whatever file opened it.
 */
const snapshotOf = (inc: IncomingRow, e: ExistingRow, fileName: string) =>
  inc.snapshotIds?.includes(e.id) === true &&
  ((e.sourceFile ?? "") === fileName ||
    closedFromFile(e) === fileName ||
    // FIX-A S-1: the plan admitted a frozen row that records no closing pull (a
    // ≤ v4.7.0 whole-fold, a Data Quality join) — `closedOnDayWithoutPull`, whose
    // day half the plan has already applied; the file halves above cannot see it.
    (isLotIdentityFrozen({ dedupHash: e.dedupHash, importNotes: e.importNotes ?? null }) && closeOriginOf(e.importNotes ?? null) !== "pull"));

/**
 * FIX-A J-1: WHERE the stored row's figure came from, as the detail names it.
 * A plain row names its file; a row an execution CLOSED names what closed it —
 * never the LOT's file (P-D: "already recorded from lot.csv" sent the user to
 * the wrong record), and never a guessed file for a ≤ v4.7.0 close, whose
 * closing pull was not stored (invariant 6).
 */
const recordedFrom = (e: ExistingRow, snapshot: boolean): string => {
  const origin = snapshot ? closeOriginOf(e.importNotes ?? null) : null;
  if (origin === "pull") return `today's earlier pull (${closedFromFile(e) ?? "this broker"})`;
  if (origin === "auto-close") return "an earlier pull today";
  if (origin === "dq-join") return "a Data Quality join you made today";
  return e.sourceFile ?? "an earlier import";
};

/**
 * FIX-A J-2: the three shapes a holder of a refused identity can have (`heldBy`
 * is any stored row whose `heldIdentityHashes` contains the slice / remainder
 * hash). An auto-close piece keeps the Un-close remedy; a plain one-sided row
 * holding only its own hash may be deleted; a row holding the identity as a
 * HELD alias, or carrying its own other leg, is never advised deleted — it holds
 * a purchase recorded on no other row (U1, lib/trash.ts).
 */
const holderShapeOf = (e: ExistingRow): NonNullable<CrossSourceCollision["holder"]> => {
  if (saysAutoClosePiece({ importNotes: e.importNotes ?? null })) return "auto-close";
  const oneSided = (statesBuy(e) && !statesSell(e)) || (statesSell(e) && !statesBuy(e));
  const held = heldIdentityHashes({ dedupHash: e.dedupHash, importNotes: e.importNotes ?? null, buyQty: e.buyQty, sellQty: e.sellQty, buyDate: e.buyDate, sellDate: e.sellDate, side: e.side ?? null });
  return oneSided && held.length === 1 ? "plain-row" : "joined";
};

/** X1 D6b (ii): does `e` hold the identity the plan refused to store twice? */
const holderOf = (inc: IncomingRow, e: ExistingRow) => inc.heldIds?.includes(e.id) === true;

/** Likely a double count. Any overlap with today's earlier snapshot of the same
 *  pull is: a snapshot is cumulative, so "part of" it is the same position grown.
 *  A month-only contract match with no shared date (C6) never is. A row that
 *  already holds the identity an auto-close would have stored (X1) always is. */
const isRisky = (c: CrossSourceCollision) =>
  c.monthOnly !== true && (c.kind === "same-quantity" || c.kind === "same-value" || c.kind === "held-identity" || c.sameSnapshot === true);

/**
 * Find incoming rows that look like trades already recorded from a DIFFERENT
 * file, judged on the facts both kinds agree on: symbol, quantity and value.
 *
 * Dates are deliberately NOT required to match — a P&L export has none, which
 * is the whole reason the hashes differ.
 */
/**
 * The OTHER kind of overlap: the same instrument traded the same day under a
 * DIFFERENT broker. That is two real trades in two real books (a user with two
 * accounts genuinely bought the same SENSEX option twice), so nothing is
 * skipped and nothing needs confirming — but the user asked to be TOLD, so a
 * multi-broker day reads as intentional rather than as a suspected double.
 * Purely informational; returns null when there is nothing to say.
 */
export function detectCrossBrokerEchoes(
  incoming: IncomingRow[],
  otherBrokerRows: ExistingRow[],
): string | null {
  if (incoming.length === 0 || otherBrokerRows.length === 0) return null;
  // X1 D8: keyed on the contract MONTH plus the day, and admitted only when the
  // two names state the same expiry day (or one states none) — two brokers
  // print one contract two ways, and the raw string missed the echo. The date
  // is shared by construction (C6 Q6), which is what makes month level safe here.
  const byKey = new Map<string, { broker: string; name: string }[]>();
  for (const e of otherBrokerRows) {
    for (const d of [e.buyDate, e.sellDate]) {
      if (!d) continue;
      const key = `${monthKeyOf(e.tradingsymbol)}|${d}`;
      const list = byKey.get(key) ?? [];
      list.push({ broker: e.broker, name: e.tradingsymbol });
      byKey.set(key, list);
    }
  }
  const echoes = new Map<string, Set<string>>();
  for (const inc of incoming) {
    for (const d of [inc.buyDate, inc.sellDate]) {
      if (!d) continue;
      const hits = byKey.get(`${monthKeyOf(inc.tradingsymbol)}|${d}`);
      if (!hits) continue;
      const set = echoes.get(inc.tradingsymbol) ?? new Set<string>();
      for (const h of hits) if (sameContractDayOf(h.name, inc.tradingsymbol)) set.add(h.broker);
      if (set.size > 0) echoes.set(inc.tradingsymbol, set);
    }
  }
  if (echoes.size === 0) return null;
  const parts = [...echoes.entries()]
    .slice(0, 5)
    .map(([sym, brokers]) => `${sym} (also under ${[...brokers].sort().join(", ")})`);
  const more = echoes.size > 5 ? `, +${echoes.size - 5} more` : "";
  return (
    `Same-day overlap with another broker's book: ${parts.join("; ")}${more}. ` +
    "Different brokers are different books, so these import as separate trades — this note only confirms the overlap is intentional."
  );
}

export function detectCrossSourceDuplicates(
  incoming: IncomingRow[],
  existing: ExistingRow[],
  incomingFileName: string,
): CrossSourceReport {
  const collisions: CrossSourceCollision[] = [];
  // W2H: the same-snapshot collisions of rows asked ONLY by W2G M1 (`snapshotOffKey`).
  const offKey = new Set<CrossSourceCollision>();
  // W2I: the STORED rows those asks named (`snapshotIds`, the plan's own list),
  // deduplicated — two incoming rows of one tradingsymbol name the same set. At
  // most one snapshot report is made per incoming row (W2N), but the ask stands
  // until EVERY named row is gone, so the remedy's number is this, not the
  // number of incoming rows or of collisions.
  const offKeyStored = new Set<number>();

  /**
   * Bucket the existing book ONCE by the two fields a candidate must match
   * exactly — broker and normalised tradingsymbol.
   *
   * This used to be `existing.filter(...)` inside the loop below, with `norm()`
   * (trim + toUpperCase) evaluated inside the predicate on BOTH operands, so
   * two strings were allocated per comparison and nothing could be hoisted.
   * That is incoming × existing: a load test at 5,000 incoming against a
   * 25,000-row book measured 8 SECONDS, and quadrupling the workload cost
   * 16.8× the time — quadratic, confirmed, not inferred. It runs on every
   * import PREVIEW, in a synchronous handler, so the whole app was frozen for
   * the duration and the user (whose file appeared to hang) could re-upload
   * and pay it again.
   *
   * Insertion order is preserved within each bucket, so the collisions array
   * comes out in the same order as before.
   */
  const byKey = new Map<string, ExistingRow[]>();
  /**
   * v4.7.0 C6 (review R1 + R2): EVERY existing row is ALSO indexed under its
   * contract key, and an incoming row looks up BOTH — the string bucket above
   * is not replaced, because W2G M1's off-key ask needs same-string rows of
   * another segment in one bucket. The union is de-duplicated by id and kept in
   * `existing` order (W2L's priority depends on it). One parse per DISTINCT
   * tradingsymbol (memoised), so the index stays linear in the book.
   */
  const byContract = new Map<string, { e: ExistingRow; pos: number; day: string | null }[]>();
  const keyMemo = new Map<string, ContractKey | null>();
  const contractOf = (ts: string) => {
    let k = keyMemo.get(ts);
    if (k === undefined) {
      k = contractKeyOf(ts);
      keyMemo.set(ts, k);
    }
    return k;
  };
  const posOf = new Map<ExistingRow, number>();
  for (const [pos, e] of existing.entries()) {
    const key = `${e.broker}\u0000${norm(e.tradingsymbol)}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(e);
    else byKey.set(key, [e]);
    posOf.set(e, pos);
    const ck = contractOf(e.tradingsymbol);
    if (!ck) continue;
    const cKey = `${e.broker}\u0000${ck.key}`;
    const cBucket = byContract.get(cKey);
    if (cBucket) cBucket.push({ e, pos, day: ck.day });
    else byContract.set(cKey, [{ e, pos, day: ck.day }]);
  }

  // D18: the INDEX rides onto every collision this row produces, so the dialog
  // can count the rows the message counts.
  for (const [incRow, inc] of incoming.entries()) {
    const byString = byKey.get(`${inc.broker}\u0000${norm(inc.tradingsymbol)}`) ?? [];
    // C6: the rows met ONLY through the contract key (their string differs).
    // `monthLevel` holds those whose match rests on an unstated expiry day.
    const monthLevel = new Set<number>();
    let pool = byString;
    const inCk = contractOf(inc.tradingsymbol);
    const viaContract = inCk ? byContract.get(`${inc.broker}\u0000${inCk.key}`) : undefined;
    if (inCk && viaContract) {
      const seen = new Set(byString.map((e) => e.id));
      const extra: { e: ExistingRow; pos: number }[] = [];
      for (const h of viaContract) {
        if (seen.has(h.e.id) || !sameContractDay(h.day, inCk.day)) continue;
        seen.add(h.e.id);
        extra.push(h);
        if ((h.day === null) !== (inCk.day === null)) monthLevel.add(h.e.id);
      }
      if (extra.length > 0) {
        // Both lists are already in `existing` order (buckets fill in book
        // order), so a linear merge keeps W2L's order without a sort.
        const merged: ExistingRow[] = [];
        let i = 0;
        for (const x of extra) {
          while (i < byString.length && posOf.get(byString[i]!)! < x.pos) merged.push(byString[i++]!);
          merged.push(x.e);
        }
        while (i < byString.length) merged.push(byString[i++]!);
        pool = merged;
      }
    }
    const candidates = pool.filter(
      (e) =>
        // An identical hash is an ordinary duplicate the existing dedup already
        // handles — this is only about rows that slip past it.
        e.dedupHash !== inc.dedupHash &&
        // A row from the SAME file is a genuine second trade in that scrip, not
        // a cross-source echo of the first — except (R43) today's earlier
        // snapshot of the same pull, which is the same book stated earlier;
        // except (X1 D6b iii) a lot this file opened that ANOTHER file's
        // execution has since closed — a day-aggregate re-pull then restates
        // that closed position, and hiding the row doubled it (PROBE-5b); and
        // except (X1 D6b ii) the holder of an identity the plan refused.
        ((e.sourceFile ?? "") !== incomingFileName ||
          snapshotOf(inc, e, incomingFileName) ||
          holderOf(inc, e) ||
          (closedFromFile(e) != null && closedFromFile(e) !== incomingFileName)),
    );

    let softer: CrossSourceCollision | null = null;
    let crossRisky: CrossSourceCollision | null = null;
    let snapshotPick: CrossSourceCollision | null = null;
    // W2L: only a row the commit's plan NAMED can be today's snapshot, so an
    // ordinary import (no ids) keeps the old early break and scans no further
    // than it ever did — the priority below costs it nothing.
    const mayMeetSnapshot = (inc.snapshotIds?.length ?? 0) > 0;
    for (const e of candidates) {
      let kind: OverlapKind | null = null;
      let detail = "";

      // SIDE-AWARE (Q-LOOP, 4.3.0): buy is compared with buy and sell with
      // sell. A SELL of a held BUY shares no side with it, so it is never the
      // same quantity, value or part of it — it is the exit, and it lands as
      // its own row. A row states a side when it has a quantity or a value on
      // it; two round trips share both sides and compare exactly as before.
      const buy = statesBuy(inc) && statesBuy(e);
      const sell = statesSell(inc) && statesSell(e);
      // A snapshot candidate with no shared side still goes on: no relation
      // below can fire for it (both quantities read 0), and it is reported.
      const snapshot = snapshotOf(inc, e, incomingFileName);
      const holder = holderOf(inc, e);
      if (!buy && !sell && !snapshot && !holder) continue;
      const incQty = Math.max(buy ? inc.buyQty : 0, sell ? inc.sellQty : 0);
      const exQty = Math.max(buy ? e.buyQty : 0, sell ? e.sellQty : 0);

      // FIX-A J-1: a stored row an execution CLOSED is named by what closed it.
      const from = recordedFrom(e, snapshot);
      const origin = snapshot ? closeOriginOf(e.importNotes ?? null) : null;
      let holderShape: CrossSourceCollision["holder"];
      if (incQty > 0 && incQty === exQty) {
        kind = "same-quantity";
        detail = `${incQty} shares already recorded from ${from}.`;
      } else if ((buy && closeEnough(inc.buyValue, e.buyValue)) || (sell && closeEnough(inc.sellValue, e.sellValue))) {
        kind = "same-value";
        detail = `A trade of nearly the same value is already recorded from ${from}.`;
      } else if (incQty > 0 && exQty > 0 && (incQty % exQty === 0 || exQty % incQty === 0)) {
        kind = "partial-quantity";
        detail = `${incQty} shares here against ${exQty} already recorded from ${from} — one may be part of the other.`;
      }
      // W2R N2: the commit's plan asked about this row, so today's earlier
      // snapshot on its key is reported whether or not a relation was found.
      if (!kind && snapshot) {
        kind = "earlier-snapshot";
        detail = origin
          ? `${from[0]!.toUpperCase()}${from.slice(1)} recorded ${e.buyQty} bought and ${e.sellQty} sold against an older position; this pull states ${inc.buyQty} bought and ${inc.sellQty} sold.`
          : `Today's earlier pull recorded ${e.buyQty} bought and ${e.sellQty} sold in ${e.sourceFile ?? "this pull"}; this pull states ${inc.buyQty} bought and ${inc.sellQty} sold.`;
      }
      // X1 D6b (ii): the plan refused to close with this row's identity; said
      // as its own kind whatever the quantity relation, and always risky.
      // FIX-A J-2: the remedy is the HOLDER's — three shapes, three sentences.
      if (holder) {
        kind = "held-identity";
        holderShape = holderShapeOf(e);
        const file = e.sourceFile ?? "an earlier import";
        const when = e.sellDate ?? e.buyDate ?? "no date";
        detail =
          holderShape === "auto-close"
            ? `Part of this execution — what would be left of it after closing the position it matches — is already recorded as ${file} (${e.buyQty} bought, ${e.sellQty} sold), so nothing was closed automatically. Un-close that record from Trades and pull again, or commit this row beside it.`
            : holderShape === "plain-row"
              ? `That earlier row (${file}, ${when}) already records this sale — it is part of this file's ${incQty || Math.max(inc.buyQty, inc.sellQty)}. Delete that row in Trades, then import / pull again; committing anyway records this row beside it.`
              : `Trade #${e.id} (${e.tradingsymbol}) already records this sale as part of its close. Undo that join (Trades → the row's menu → ${UNJOIN_MENU_LABEL}) and import again, or commit anyway to record this row beside it.`;
      }

      if (kind) {
        const sameSnapshot = snapshot;
        // C6 (R1): a candidate reached only through an unstated expiry day is
        // the same contract only if the two rows also share a trade date;
        // without one it may be another expiry of the month — told, not blocked.
        const sharesDate =
          (inc.buyDate != null && inc.buyDate === e.buyDate) || (inc.sellDate != null && inc.sellDate === e.sellDate);
        const monthOnly = monthLevel.has(e.id) && !sharesDate;
        if (monthOnly) {
          detail += " Only the contract month matched: one of the two names states no expiry day and they share no trade date, so this may be another expiry of the same month.";
        }
        const c: CrossSourceCollision = {
          symbol: inc.symbol,
          row: incRow,
          incoming: { buyQty: inc.buyQty, sellQty: inc.sellQty, buyValue: inc.buyValue, sellValue: inc.sellValue },
          existing: { id: e.id, buyQty: e.buyQty, sellQty: e.sellQty, sourceFile: e.sourceFile },
          kind,
          detail,
          ...(sameSnapshot ? { sameSnapshot: true } : {}),
          ...(monthOnly ? { monthOnly: true } : {}),
          ...(origin ? { origin } : {}),
          ...(holderShape ? { holder: holderShape } : {}),
        };
        // The MOST severe candidate of each kind: a partial overlap met first
        // must not hide a risky one behind it (R43: two products of one
        // contract, in either order).
        //
        // W2L: and by PRIORITY, not by order of arrival. `existing` arrives in
        // rowid order, so an OLDER cross-FILE row (an earlier P&L or tradebook
        // import) was met before today's snapshot rows and won the pick — the
        // pull then advised deleting that earlier IMPORT while the row actually
        // blocking the commit was today's own snapshot row.
        //
        // W2N (D8): one report per incoming row was the remaining half of that
        // finding — with BOTH blockers real, whichever sentence was reported
        // sent the user through a second round in either order, and the
        // snapshot sentence promises "the pull run again … records the position
        // as the broker now states it", which is FALSE while the cross-file row
        // also blocks it. So the pick is a SET of at most two: today's snapshot
        // candidate AND the most severe RISKY cross-file candidate. The scan
        // therefore continues past a snapshot hit and ends only when both are
        // held; an import that can meet no snapshot (no ids) keeps the old
        // early break, so its cost is unchanged.
        if (isRisky(c)) {
          if (c.sameSnapshot === true) snapshotPick ??= c;
          else crossRisky ??= c;
          if (!mayMeetSnapshot || (snapshotPick !== null && crossRisky !== null)) break;
          continue;
        }
        softer ??= c;
      }
    }
    // A softer cross-file candidate is not a blocker, so it is reported only
    // when nothing risky was found — never beside a snapshot pick.
    const picks = snapshotPick !== null ? [snapshotPick, ...(crossRisky ? [crossRisky] : [])] : [crossRisky ?? softer];
    for (const pick of picks) {
      if (!pick) continue;
      collisions.push(pick);
    }
    if (snapshotPick !== null && inc.snapshotOffKey === true) {
      offKey.add(snapshotPick);
      for (const id of inc.snapshotIds ?? []) offKeyStored.add(id);
    }
  }

  const symbols = [...new Set(collisions.map((c) => c.symbol))].sort();
  const risky = collisions.some(isRisky);
  const listOf = (cs: CrossSourceCollision[]) => {
    const syms = [...new Set(cs.map((c) => c.symbol))].sort();
    return `${syms.slice(0, 5).join(", ")}${syms.length > 5 ? `, +${syms.length - 5} more` : ""}`;
  };
  // Two different questions get two different sentences. A row that meets
  // today's earlier snapshot of this same pull is NOT from a different file,
  // and deleting that earlier import would delete the recorded position with
  // whatever the user wrote on it (W2R N3) — so it never reads the advice below.
  const held = collisions.filter((c) => c.kind === "held-identity");
  const crossFile = collisions.filter((c) => !c.sameSnapshot && c.kind !== "held-identity");
  const earlier = collisions.filter((c) => c.sameSnapshot && c.kind !== "held-identity" && !offKey.has(c));
  // W2H: an ask made only because nothing is on the key has its own reason and path.
  const converted = collisions.filter((c) => offKey.has(c) && c.kind !== "held-identity");
  const parts: string[] = [];
  // X1 D6b (ii): the plan would have stored what is left of this execution
  // under a record the journal already holds (the unique index refuses it), so
  // the close is refused and the row is asked about rather than inserted.
  // FIX-A J-2: the remedy is the HOLDER's — an auto-close piece has an Un-close;
  // a plain never-closed row has none (Trades offers no button, the server
  // answers NOT_FOUND) and may be deleted; a joined lot holds a purchase on no
  // other row and is never advised deleted — its door is the un-join.
  const heldBy = (shape: CrossSourceCollision["holder"]) => held.filter((c) => (c.holder ?? "auto-close") === shape);
  for (const shape of ["auto-close", "plain-row", "joined"] as const) {
    const group = heldBy(shape);
    if (group.length === 0) continue;
    const one = group.length === 1;
    const lead =
      shape === "joined"
        ? `${group.length} row${one ? "" : "s"} in this pull (${listOf(group)}) would close a position this account holds, but what is left of ${one ? "it" : "them"} after that close is already recorded as part of a position's close — a Data Quality join. `
        : `${group.length} row${one ? "" : "s"} in this pull (${listOf(group)}) would close a position this account holds, but what is left of ${one ? "it" : "them"} after that close is already recorded as a row of its own — a sale of the same quantity, price and day. `;
    const remedy =
      shape === "auto-close"
        ? `Nothing was closed automatically and nothing was committed. Un-close that earlier record (Trades → the row's menu → "Un-close") and pull again, or commit anyway to add this pull's row${one ? "" : "s"} beside it.`
        : shape === "plain-row"
          ? `Nothing was closed automatically and nothing was committed. Delete that earlier row in Trades, then pull again — the pull then closes the position itself; committing anyway records this pull's row${one ? "" : "s"} beside it.`
          : `Nothing was closed automatically and nothing was committed. Undo that join (Trades → the row's menu → ${UNJOIN_MENU_LABEL}) and pull again, or commit anyway to record this pull's row${one ? "" : "s"} beside it.`;
    parts.push(lead + remedy);
  }
  if (crossFile.length > 0) {
    parts.push(
      `${crossFile.length} row${crossFile.length === 1 ? "" : "s"} in this file (${listOf(crossFile)}) look like trades already recorded from a different file. ` +
        "The two file kinds state different facts — a transaction report has dates and both legs, a P&L export has neither — so the duplicate check cannot match them and importing both would record the same trade twice. " +
        "Nothing is merged automatically: merging means choosing whose numbers to keep, and getting that wrong silently corrupts cost basis and holding period. Delete the earlier import first if these are the same trades.",
    );
  }
  // FIX-A J-1 (release audit, PROBE-1's 409): a restated figure whose earlier
  // part was FOLDED INTO AN OLDER POSITION is its own case — the recorded row is
  // not "today's earlier pull's row" but a lot that pull (or a Data Quality
  // join) closed. The old sentence listed reasons that did not include it, and
  // its "committing anyway adds this pull's row beside the earlier one" ended
  // at 225 sold against the broker's 150. The only remedy that ends at the
  // broker's figure with the lot closed (review P-C / P-D): undo the close,
  // delete the sale it brings back, pull again — the pull then closes the lot.
  const earlierPlain = earlier.filter((c) => !c.origin);
  const earlierClosed = earlier.filter((c) => c.origin === "pull" || c.origin === "auto-close");
  const earlierJoined = earlier.filter((c) => c.origin === "dq-join");
  if (earlierPlain.length > 0) {
    const one = earlierPlain.length === 1;
    parts.push(
      `${earlierPlain.length} row${one ? "" : "s"} in this pull (${listOf(earlierPlain)}) restate${one ? "s" : ""} a position today's earlier pull already recorded, and ${one ? "is" : "are"} not written over it: ` +
        "the recorded row carries detail a replacement would lose (a ladder of fills, a Data Quality join, a segment or exchange you set, or a cost basis or journal entry you recorded), or more than one position shares its instrument. " +
        "Nothing is merged or overwritten automatically; committing anyway adds this pull's row beside the earlier one.",
    );
  }
  const closedQty = (c: CrossSourceCollision) => Math.max(c.existing.buyQty, c.existing.sellQty);
  const statedQty = (c: CrossSourceCollision) => Math.max(c.incoming.buyQty, c.incoming.sellQty);
  if (earlierClosed.length > 0) {
    const one = earlierClosed.length === 1;
    const c = earlierClosed[0]!;
    // A ≤ v4.7.0 close stored no closing file, so none is named (invariant 6).
    const who = one && c.origin === "pull" ? "Today's earlier pull from this broker" : one ? "An earlier pull today" : "Today's earlier pulls from this broker";
    parts.push(
      (one
        ? `${who} already closed ${closedQty(c)} of ${c.symbol} against an older position; this pull states the day's total as ${statedQty(c)}. `
        : `${who} already closed ${earlierClosed.length} positions (${listOf(earlierClosed)}) with sales this pull now restates as larger day totals. `) +
        `To record the new total: in Trades, Un-close ${one ? "that position" : "each position"} (the row's menu → Un-close), delete the sale row that brings back, then pull again — the pull then closes the position itself. ` +
        `Committing anyway records this pull's figure beside the sale already counted, so the day is counted twice. ` +
        `The deleted sale stays in Deleted items; a later restore of it is skipped because the pull has recorded it.`,
    );
  }
  if (earlierJoined.length > 0) {
    const one = earlierJoined.length === 1;
    const c = earlierJoined[0]!;
    parts.push(
      (one
        ? `A Data Quality join you made today already closed ${closedQty(c)} of ${c.symbol} against an older position with this pull's earlier sale; this pull states the day's total as ${statedQty(c)}. `
        : `Data Quality joins you made today already closed ${earlierJoined.length} positions (${listOf(earlierJoined)}) with sales this pull now restates as larger day totals. `) +
        `To record the new total: in Trades, undo ${one ? "that join" : "each join"} (the row's menu → ${UNJOIN_MENU_LABEL}), delete the sale row that brings back, then pull again — the pull then closes the position itself. ` +
        `Committing anyway records this pull's figure beside the sale already counted, so the day is counted twice.`,
    );
  }
  if (converted.length > 0) {
    const one = converted.length === 1;
    // W2I: the remedy counts the STORED rows the plan named, NOT the incoming
    // rows. The M1 ask is raised against every same-tradingsymbol row of today's
    // snapshot, so one incoming row can stand against two stored rows (two
    // exchanges, or two products) while only one of them is reported — and a
    // singular "the earlier row can be deleted" then left the same pull refused
    // with the same sentence after the user had followed it. Only `stored` rows
    // are named, so one round of the remedy ends the ask.
    const stored = offKeyStored.size;
    const storedOne = stored <= 1;
    // Descriptive, not advice: the path the re-check probed (the earlier rows
    // deleted, the pull run again: no question, the broker's book), what a
    // forced commit does, and — since an M1 ask never reaches planSnapshot's
    // `carriesUserRecord` check, the stored row being on another key — the same
    // warning the on-key sentence carries, plus the way back. Rejected for 4.3.0
    // (4.3.1, product-keyed snapshot identity): a one-click "replace the earlier
    // row" action.
    parts.push(
      `${converted.length} row${one ? "" : "s"} in this pull (${listOf(converted)}) restate${one ? "s an instrument" : " instruments"} today's earlier pull already recorded under another product, segment or exchange, and ${one ? "is" : "are"} not written over ${storedOne ? "that row" : "those rows"}. ` +
        `If the broker converted ${one ? "the position" : "these positions"} between the two pulls, the ${storedOne ? "earlier row" : `${stored} earlier rows`} can be deleted from Trades and the pull run again, ` +
        `which records the position${one ? "" : "s"} as the broker now states ${one ? "it" : "them"}; committing anyway adds this pull's row${one ? "" : "s"} beside the earlier ${storedOne ? "one" : "ones"}. ` +
        `${storedOne ? "That row may" : "Those rows may"} carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.`,
    );
  }

  return {
    collisions,
    symbols,
    risky,
    message: parts.length === 0 ? null : parts.join(" "),
  };
}

/**
 * The collisions as a UI list, capped by SYMBOL rather than by collision (W2N,
 * D8) AND bounded in LINES (D19, wave 2O). One incoming row can carry TWO entries
 * — today's snapshot blocker and the older cross-FILE one — so a flat
 * `slice(0, 6)` could list a symbol's first blocker and elide its second, and its
 * "…and n more" counted collisions while the headline above it counts symbols.
 *
 * But keeping EVERY entry of a listed symbol made the card unbounded on the path
 * that motivated nothing: on a FILE import `symbol` is the incoming
 * `tradingsymbol` and `app/api/import/route.ts` previews with no
 * `supersedeSnapshot`, so one scrip stated on many days rendered one `<li>` per
 * colliding row (30 collisions → 30 lines, `more 0`) where the pre-wave
 * `collisions.slice(0, 6)` rendered six and "…and 24 more." (ask#1).
 *
 * So a ROW budget sits beside the symbol cap: symbols are admitted WHOLE, in the
 * order they first appear, while they fit — the first is always admitted and
 * truncated to `maxRows` if it alone exceeds it. No symbol is ever listed with one
 * of its two blockers, and no card is unbounded.
 *
 *   `more`      — SYMBOLS not listed at all (the existing "…and n more." tail);
 *   `truncated` — rows of a LISTED symbol that were elided (a second tail).
 *
 * A symbol that does not fit ends the admission rather than being skipped over: a
 * list whose lines jump back and forth over the budget reads as arbitrary, and
 * every symbol left is counted in `more` either way.
 */
export function collisionsToList<C extends { symbol: string }>(
  collisions: readonly C[],
  maxSymbols = 6,
  maxRows = 12,
): { rows: C[]; more: number; truncated: number } {
  const bySymbol = new Map<string, C[]>();
  for (const c of collisions) {
    const bucket = bySymbol.get(c.symbol);
    if (bucket) bucket.push(c);
    else bySymbol.set(c.symbol, [c]);
  }
  // The QUOTA per admitted symbol, decided before anything is emitted, so the
  // rows keep the server's own collision order (the tail of one symbol is not
  // hoisted above another's head).
  const quota = new Map<string, number>();
  let budget = 0;
  let truncated = 0;
  for (const [symbol, entries] of bySymbol) {
    if (quota.size >= maxSymbols) break;
    if (quota.size > 0 && budget + entries.length > maxRows) break;
    // The first symbol is listed even when it alone overflows — a card that named
    // no symbol at all would say less than the message above it.
    const room = quota.size === 0 ? Math.min(entries.length, maxRows) : entries.length;
    quota.set(symbol, room);
    budget += room;
    truncated += entries.length - room;
  }
  const left = new Map(quota);
  const rows = collisions.filter((c) => {
    const n = left.get(c.symbol) ?? 0;
    if (n <= 0) return false;
    left.set(c.symbol, n - 1);
    return true;
  });
  return { rows, more: bySymbol.size - quota.size, truncated };
}
