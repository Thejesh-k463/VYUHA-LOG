/**
 * TAX PERSON — who a tax figure belongs to (v4.5.0 wave TP, owner ruling T1).
 *
 * A tax return is filed by a PERSON, not by a broking account: one person may
 * hold five accounts, and a family's accounts may sit in the same journal. So
 * the 112A exemption, every set-off, the carry-forward ledger, harvest
 * headroom, advance tax and the ITR export are computed over ONE person's
 * accounts together, and NEVER across two persons (invariant 6: never
 * fabricate a figure nobody can file).
 *
 * The identity is the existing `accounts.tax_identity` free-text column
 * (migration 0034) — a name or a PAN, whatever the user types. It is never
 * validated as a PAN and never sent anywhere.
 *
 * UNDER-MERGE, NEVER OVER-MERGE. A blank identity is its OWN person
 * (`account:<id>`), and two blank accounts are never merged: folding a
 * spouse's book into the owner's exemption is a silent wrong number, while an
 * un-merged second account of one person is visible on screen and the page
 * says so.
 *
 * Pure (invariant 2): no DB, no React. `lib/queries/tax-scope.ts` is the
 * server-only reader that feeds it real accounts.
 */

/** The fields this module needs from an account row. */
export interface TaxPersonAccount {
  id: number;
  name?: string | null;
  taxIdentity?: string | null;
  archived?: boolean | null;
}

/**
 * The person key of one account: the normalised identity (trim, collapse
 * internal whitespace, upper-case), or `account:<id>` when blank.
 *
 * Normalisation exists so "thejesh k", "Thejesh  K" and "THEJESH K" are ONE
 * person — a typo that mints a second person splits an exemption in half with
 * nothing on screen looking wrong. It deliberately does NOT strip punctuation
 * or spaces entirely: "A.B." and "AB" are different strings a user may well
 * mean as different people, and over-merging is the unsafe direction.
 */
export function taxPersonKey(account: TaxPersonAccount): string {
  const raw = (account.taxIdentity ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return raw === "" ? `account:${account.id}` : raw;
}

/** True when the account states no tax identity — it stands alone. */
export function isUnassigned(account: TaxPersonAccount): boolean {
  return (account.taxIdentity ?? "").trim() === "";
}

/**
 * The label a page shows for a person: the identity AS TYPED on the
 * lowest-numbered account carrying it (so casing the user chose survives), or
 * the account's own name when it has none.
 */
export function taxPersonLabel(accounts: readonly TaxPersonAccount[]): string {
  const first = [...accounts].sort((a, b) => a.id - b.id)[0];
  if (!first) return "";
  const typed = (first.taxIdentity ?? "").trim().replace(/\s+/g, " ");
  return typed !== "" ? typed : (first.name ?? `Account ${first.id}`);
}

export interface TaxPersonGroup {
  key: string;
  label: string;
  accounts: TaxPersonAccount[];
  /** True when the group is one account with no stated identity. */
  unassigned: boolean;
}

/**
 * Accounts grouped by person, each group's accounts in id order and the groups
 * ordered by their lowest account id — a stable order the pickers and the
 * settings list both render, so the same book always lists people the same way.
 */
export function groupByTaxPerson(accounts: readonly TaxPersonAccount[]): TaxPersonGroup[] {
  const byKey = new Map<string, TaxPersonAccount[]>();
  for (const a of accounts) {
    const key = taxPersonKey(a);
    const held = byKey.get(key);
    if (held) held.push(a);
    else byKey.set(key, [a]);
  }
  return [...byKey.entries()]
    .map(([key, group]) => {
      const sorted = [...group].sort((a, b) => a.id - b.id);
      return {
        key,
        label: taxPersonLabel(sorted),
        accounts: sorted,
        unassigned: sorted.every((a) => isUnassigned(a)),
      };
    })
    .sort((a, b) => a.accounts[0].id - b.accounts[0].id);
}

/** The distinct identities already typed, as typed — the editor's datalist. */
export function knownTaxIdentities(accounts: readonly TaxPersonAccount[]): string[] {
  const byKey = new Map<string, string>();
  for (const a of accounts) {
    if (isUnassigned(a)) continue;
    const key = taxPersonKey(a);
    if (!byKey.has(key)) byKey.set(key, (a.taxIdentity ?? "").trim().replace(/\s+/g, " "));
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}
