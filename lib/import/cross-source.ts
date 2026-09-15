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
}

/**
 * `earlier-snapshot` (W2R N2): the row restates a position today's earlier
 * pull recorded on the same key (or, W2G M1, in another segment or exchange
 * when nothing is on the key), with no quantity or value relation to it — a
 * position that grew or changed product, or one of two positions the key
 * cannot tell apart.
 */
export type OverlapKind = "same-quantity" | "same-value" | "partial-quantity" | "earlier-snapshot";

export interface CrossSourceCollision {
  symbol: string;
  incoming: { buyQty: number; sellQty: number; buyValue: number; sellValue: number };
  existing: { id: number; buyQty: number; sellQty: number; sourceFile: string | null };
  kind: OverlapKind;
  /** Plain-language reason a human can check against their broker statement. */
  detail: string;
  /** R43: the existing row is today's earlier snapshot from this same pull file. */
  sameSnapshot?: boolean;
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

/** R43: is `e` the earlier snapshot of `inc`'s own position — this very pull file, on its key? */
const snapshotOf = (inc: IncomingRow, e: ExistingRow, fileName: string) =>
  inc.snapshotIds?.includes(e.id) === true && (e.sourceFile ?? "") === fileName;

/** Likely a double count. Any overlap with today's earlier snapshot of the same
 *  pull is: a snapshot is cumulative, so "part of" it is the same position grown. */
const isRisky = (c: CrossSourceCollision) =>
  c.kind === "same-quantity" || c.kind === "same-value" || c.sameSnapshot === true;

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
  const byKey = new Map<string, Set<string>>();
  for (const e of otherBrokerRows) {
    for (const d of [e.buyDate, e.sellDate]) {
      if (!d) continue;
      const key = `${norm(e.tradingsymbol)}|${d}`;
      const set = byKey.get(key) ?? new Set<string>();
      set.add(e.broker);
      byKey.set(key, set);
    }
  }
  const echoes = new Map<string, Set<string>>();
  for (const inc of incoming) {
    for (const d of [inc.buyDate, inc.sellDate]) {
      if (!d) continue;
      const brokers = byKey.get(`${norm(inc.tradingsymbol)}|${d}`);
      if (!brokers) continue;
      const set = echoes.get(inc.tradingsymbol) ?? new Set<string>();
      for (const b of brokers) set.add(b);
      echoes.set(inc.tradingsymbol, set);
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
  // deduplicated — two incoming rows of one tradingsymbol name the same set. One
  // report is made per incoming row, but the ask stands until EVERY named row is
  // gone, so the remedy's number is this, not the number of incoming rows.
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
  for (const e of existing) {
    const key = `${e.broker} ${norm(e.tradingsymbol)}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(e);
    else byKey.set(key, [e]);
  }

  for (const inc of incoming) {
    const candidates = (byKey.get(`${inc.broker} ${norm(inc.tradingsymbol)}`) ?? []).filter(
      (e) =>
        // An identical hash is an ordinary duplicate the existing dedup already
        // handles — this is only about rows that slip past it.
        e.dedupHash !== inc.dedupHash &&
        // A row from the SAME file is a genuine second trade in that scrip, not
        // a cross-source echo of the first — except (R43) today's earlier
        // snapshot of the same pull, which is the same book stated earlier.
        ((e.sourceFile ?? "") !== incomingFileName || snapshotOf(inc, e, incomingFileName)),
    );

    let softer: CrossSourceCollision | null = null;
    let risky: CrossSourceCollision | null = null;
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
      if (!buy && !sell && !snapshot) continue;
      const incQty = Math.max(buy ? inc.buyQty : 0, sell ? inc.sellQty : 0);
      const exQty = Math.max(buy ? e.buyQty : 0, sell ? e.sellQty : 0);

      if (incQty > 0 && incQty === exQty) {
        kind = "same-quantity";
        detail = `${incQty} shares already recorded from ${e.sourceFile ?? "an earlier import"}.`;
      } else if ((buy && closeEnough(inc.buyValue, e.buyValue)) || (sell && closeEnough(inc.sellValue, e.sellValue))) {
        kind = "same-value";
        detail = `A trade of nearly the same value is already recorded from ${e.sourceFile ?? "an earlier import"}.`;
      } else if (incQty > 0 && exQty > 0 && (incQty % exQty === 0 || exQty % incQty === 0)) {
        kind = "partial-quantity";
        detail = `${incQty} shares here against ${exQty} already recorded from ${e.sourceFile ?? "an earlier import"} — one may be part of the other.`;
      }
      // W2R N2: the commit's plan asked about this row, so today's earlier
      // snapshot on its key is reported whether or not a relation was found.
      if (!kind && snapshot) {
        kind = "earlier-snapshot";
        detail = `Today's earlier pull recorded ${e.buyQty} bought and ${e.sellQty} sold in ${e.sourceFile ?? "this pull"}; this pull states ${inc.buyQty} bought and ${inc.sellQty} sold.`;
      }

      if (kind) {
        const sameSnapshot = snapshot;
        const c: CrossSourceCollision = {
          symbol: inc.symbol,
          incoming: { buyQty: inc.buyQty, sellQty: inc.sellQty, buyValue: inc.buyValue, sellValue: inc.sellValue },
          existing: { id: e.id, buyQty: e.buyQty, sellQty: e.sellQty, sourceFile: e.sourceFile },
          kind,
          detail,
          ...(sameSnapshot ? { sameSnapshot: true } : {}),
        };
        // One report per incoming row is enough to prompt a decision — but the
        // MOST severe one: a partial overlap met first must not hide a risky
        // one behind it (R43: two products of one contract, in either order).
        //
        // W2L: and by PRIORITY, not by order of arrival. `existing` arrives in
        // rowid order, so an OLDER cross-FILE row (an earlier P&L or tradebook
        // import) was met before today's snapshot rows and won the pick — the
        // pull then advised deleting that earlier IMPORT while the row actually
        // blocking the commit was today's own snapshot row, so one round of the
        // advice did not end the ask (the user deleted the import, pulled again
        // and met the snapshot sentence). Today's snapshot IS the blocker, so it
        // is what is reported; among cross-file candidates the first risky one
        // still wins, and the collision object is unchanged.
        if (isRisky(c)) {
          if (c.sameSnapshot === true || !mayMeetSnapshot) {
            risky = c;
            break;
          }
          risky ??= c;
          continue;
        }
        softer ??= c;
      }
    }
    const pick = risky ?? softer;
    if (pick) {
      collisions.push(pick);
      if (pick.sameSnapshot === true && inc.snapshotOffKey === true) {
        offKey.add(pick);
        for (const id of inc.snapshotIds ?? []) offKeyStored.add(id);
      }
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
  const crossFile = collisions.filter((c) => !c.sameSnapshot);
  const earlier = collisions.filter((c) => c.sameSnapshot && !offKey.has(c));
  // W2H: an ask made only because nothing is on the key has its own reason and path.
  const converted = collisions.filter((c) => offKey.has(c));
  const parts: string[] = [];
  if (crossFile.length > 0) {
    parts.push(
      `${crossFile.length} row${crossFile.length === 1 ? "" : "s"} in this file (${listOf(crossFile)}) look like trades already recorded from a different file. ` +
        "The two file kinds state different facts — a transaction report has dates and both legs, a P&L export has neither — so the duplicate check cannot match them and importing both would record the same trade twice. " +
        "Nothing is merged automatically: merging means choosing whose numbers to keep, and getting that wrong silently corrupts cost basis and holding period. Delete the earlier import first if these are the same trades.",
    );
  }
  if (earlier.length > 0) {
    const one = earlier.length === 1;
    parts.push(
      `${earlier.length} row${one ? "" : "s"} in this pull (${listOf(earlier)}) restate${one ? "s" : ""} a position today's earlier pull already recorded, and ${one ? "is" : "are"} not written over it: ` +
        "the recorded row carries detail a replacement would lose (a ladder of fills, a Data Quality join, a segment or exchange you set, or a cost basis or journal entry you recorded), or more than one position shares its instrument. " +
        "Nothing is merged or overwritten automatically; committing anyway adds this pull's row beside the earlier one.",
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
