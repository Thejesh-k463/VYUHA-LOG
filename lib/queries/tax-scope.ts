import "server-only";
import { cache } from "react";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getAccounts, getSelectedAccountId } from "./accounts";
import {
  groupByTaxPerson,
  taxPersonKey,
  type TaxPersonGroup,
} from "@/lib/domain/tax-person";

/**
 * THE ONE DELIBERATE WIDENING OF INVARIANT 8 (v4.5.0 wave TP, owner ruling T1).
 *
 * Invariant 8 says every account-scoped read goes through
 * `getSelectedAccountId()` and applies `accountId > 0 ? filter : all`. The tax
 * surfaces — /reports/tax, /reports/itr, /reports/harvest,
 * /reports/advance-tax, the ITR export, the tax pack and /api/ais — read on a
 * PERSON instead: a return is filed by a person, and one person's five
 * accounts are one return. So the reads those surfaces make are filtered by
 * `account_id IN (…the person's accounts…)` rather than by the single selected
 * account.
 *
 * It is a WIDENING of the read only, and only for those surfaces:
 *   • it still STARTS at `getSelectedAccountId()` — the selected account names
 *     the person, so the global selector still drives every tax page;
 *   • it is never "all accounts": the All-accounts view (0) with more than one
 *     person in the book yields `accountIds: []` and NO figure at all, because
 *     a total spanning two tax persons is a number nobody can file
 *     (invariant 6). The page shows a person picker instead;
 *   • WRITES are untouched — every tax write still resolves ONE account
 *     through `getWriteAccountId()` (invariant 9: 0 is a view, never a place);
 *   • non-tax surfaces are untouched and stay account-scoped.
 *
 * An account with no `tax_identity` is its own person (under-merge, never
 * over-merge): two blank accounts are NEVER pooled into one exemption.
 *
 * Registered in `tests/account-isolation.test.ts` as the named exception —
 * see the prose entry beside the `risk-cap.ts` / `data-fixes.ts` one.
 */
export interface TaxScope {
  /** The normalised person key (`taxPersonKey`), or "" when none resolved. */
  personKey: string;
  /** What the page and every export print: the identity as typed, or the account's name. */
  label: string;
  /**
   * The accounts whose rows this person's figures are computed over — ARCHIVED
   * ACCOUNTS INCLUDED (a closed account's realised sales are still taxable).
   * EMPTY means no figure: an empty list filters to no rows, never to "all".
   */
  accountIds: number[];
  /** True when the resolved person is a single account with no stated identity. */
  unassigned: boolean;
  /**
   * Present only when the selection is All accounts (0) AND the book holds more
   * than one tax person: the page renders a picker over these and NO figure
   * until one is chosen.
   */
  candidates?: { key: string; label: string; accountIds: number[] }[];
}

const EMPTY_SCOPE: TaxScope = { personKey: "", label: "", accountIds: [], unassigned: false };

function toScope(group: TaxPersonGroup): TaxScope {
  return {
    personKey: group.key,
    label: group.label,
    accountIds: group.accounts.map((a) => a.id),
    unassigned: group.unassigned,
  };
}

/**
 * Which tax person the tax surfaces compute for.
 *
 * Rules, in order:
 *   1. `personParam` (the `?person=` query param the four pages read from the
 *      picker) names a person that exists → that person. It is a VIEW choice
 *      only: nothing is written, nothing is persisted, and an unknown key
 *      falls through to the rules below rather than inventing a scope.
 *   2. A selected account N > 0 → N's person → ALL of that person's accounts,
 *      archived included.
 *   3. All accounts (0) with exactly ONE person in the book → that person.
 *   4. All accounts (0) with more than one → `accountIds: []` plus
 *      `candidates`: no figure, a picker.
 *
 * cache()d per person param so the four pages, the exports and every threaded
 * reader in one render resolve it once.
 */
export const resolveTaxScope = cache((personParam?: string | null): TaxScope => {
  const all = getAccounts();
  if (all.length === 0) return EMPTY_SCOPE;
  const groups = groupByTaxPerson(all);

  const wanted = (personParam ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  if (wanted !== "") {
    // Two key shapes, one comparison: an identity key is already upper-cased,
    // while an unassigned account's key is the lower-case `account:<id>` the
    // picker puts in the link — upper-casing the param alone never matched it
    // (found by the wave's own probe), so the group key is normalised the same
    // way before the compare.
    const picked = groups.find((g) => g.key.toUpperCase() === wanted);
    if (picked) return toScope(picked);
  }

  const selected = getSelectedAccountId();
  if (selected > 0) {
    const account = all.find((a) => a.id === selected);
    if (account) {
      const key = taxPersonKey(account);
      const group = groups.find((g) => g.key === key);
      if (group) return toScope(group);
    }
    return EMPTY_SCOPE;
  }

  if (groups.length === 1) return toScope(groups[0]);
  return {
    ...EMPTY_SCOPE,
    candidates: groups.map((g) => ({ key: g.key, label: g.label, accountIds: g.accounts.map((a) => a.id) })),
  };
});

/** True when the page must show a picker and no figure (rule 4 above). */
export function needsPersonChoice(scope: TaxScope): boolean {
  return scope.accountIds.length === 0 && (scope.candidates?.length ?? 0) > 0;
}

/**
 * The account filter every threaded reader applies.
 *
 * `accountIds === undefined` is the LEGACY, account-scoped path (invariant 8's
 * `accountId > 0 ? filter : all`) — every non-tax caller keeps it, unchanged.
 * An ARRAY is a person scope: `IN (…)`, and an EMPTY array filters to NO rows
 * (`1 = 0`) — never to "all", which is the whole point of the widening.
 */
export function accountScopeWhere(
  column: SQLiteColumn,
  accountIds?: readonly number[],
): SQL | undefined {
  if (accountIds) return accountIds.length > 0 ? inArray(column, [...accountIds]) : sql`1 = 0`;
  const accountId = getSelectedAccountId();
  return accountId > 0 ? sql`${column} = ${accountId}` : undefined;
}

/** The same rule for rows already fetched (a JS filter, same semantics). */
export function inTaxScope(rowAccountId: number, accountIds?: readonly number[]): boolean {
  if (accountIds) return accountIds.includes(rowAccountId);
  const accountId = getSelectedAccountId();
  return accountId > 0 ? rowAccountId === accountId : true;
}

/** "Tax person: <label> — accounts: A, B" — the line every tax page and export carries. */
export function taxScopeHeader(scope: TaxScope): string {
  if (scope.accountIds.length === 0) return "Tax person: not chosen — no figure";
  const names = getAccounts()
    .filter((a) => scope.accountIds.includes(a.id))
    .map((a) => a.name);
  return `Tax person: ${scope.label} — accounts: ${names.join(", ")}`;
}
