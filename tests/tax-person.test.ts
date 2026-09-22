import { describe, it, expect } from "vitest";
import {
  groupByTaxPerson,
  isUnassigned,
  knownTaxIdentities,
  taxPersonKey,
  taxPersonLabel,
  type TaxPersonAccount,
} from "@/lib/domain/tax-person";

/**
 * WHO A TAX FIGURE BELONGS TO (v4.5.0 wave TP, owner ruling T1) — the pure half.
 *
 * A return is filed by a PERSON, not by a broking account: the 112A exemption,
 * every set-off, the carry-forward ledger, harvest headroom, advance tax and the
 * ITR export are computed over ONE person's accounts together and NEVER across
 * two. `lib/domain/tax-person.ts` decides who is who, from the free-text
 * `accounts.tax_identity` column; `tests/tax-person-scope.test.ts` is the same
 * rule against a real database and every threaded reader.
 *
 * The two failure directions are NOT symmetrical, and that asymmetry is the
 * whole design (AGENTS.md invariant 6 — never fabricate a denominator; here,
 * never fabricate a taxpayer):
 *
 *   OVER-merge  — folding a spouse's book into the owner's exemption — is a
 *                 silent wrong number on a filed return. It must be impossible.
 *   UNDER-merge — a second account of one person standing alone — is visible on
 *                 screen, the page says so, and the user fixes it by typing the
 *                 same identity into both.
 *
 * So a blank identity is its OWN person and two blanks are never pooled, while
 * a whitespace/case variant of ONE identity IS one person (a typo that mints a
 * second person would split an exemption in half with nothing looking wrong).
 */

const acc = (id: number, taxIdentity?: string | null, name?: string): TaxPersonAccount => ({
  id,
  name: name ?? `Account ${id}`,
  taxIdentity: taxIdentity ?? null,
});

describe("taxPersonKey — one person, however it was typed", () => {
  it("trims, collapses inner whitespace and upper-cases, so four typings are ONE person", () => {
    const typings = ["Thejesh K", "thejesh k", "  THEJESH   K  ", "Thejesh\tK"];
    const keys = typings.map((v) => taxPersonKey(acc(1, v)));
    expect(new Set(keys).size, `${typings.join(" | ")} are one person`).toBe(1);
    expect(keys[0]).toBe("THEJESH K");
  });

  it("a PAN is treated the same way — it is free text, never validated", () => {
    expect(taxPersonKey(acc(1, " abcde1234f "))).toBe(taxPersonKey(acc(2, "ABCDE1234F")));
  });

  it("does NOT strip punctuation or close up spaces — over-merging is the unsafe direction", () => {
    // "A.B." and "AB" are different strings a user may well mean as different
    // people. Under-merge, never over-merge.
    expect(taxPersonKey(acc(1, "A.B."))).not.toBe(taxPersonKey(acc(2, "AB")));
    expect(taxPersonKey(acc(1, "R K Sharma"))).not.toBe(taxPersonKey(acc(2, "RKSharma")));
  });

  it("blank is the account's OWN key, and two blanks NEVER merge", () => {
    for (const blank of [null, undefined, "", "   ", "\t\n "]) {
      expect(taxPersonKey(acc(7, blank)), `blank ${JSON.stringify(blank)}`).toBe("account:7");
      expect(isUnassigned(acc(7, blank))).toBe(true);
    }
    // THE assertion this module exists for: two accounts stating nothing are two
    // persons, so they can never share one ₹1.25L exemption.
    expect(taxPersonKey(acc(7, null))).not.toBe(taxPersonKey(acc(8, null)));
    expect(taxPersonKey(acc(7, "  "))).not.toBe(taxPersonKey(acc(8, null)));
  });

  it("a stated identity is never confused with an unassigned key", () => {
    // The unassigned key is lower-case `account:<id>`; an identity is upper-cased.
    expect(taxPersonKey(acc(9, "account:9"))).toBe("ACCOUNT:9");
    expect(taxPersonKey(acc(9, "account:9"))).not.toBe(taxPersonKey(acc(9, null)));
  });
});

describe("groupByTaxPerson — the picker's and the settings list's order", () => {
  it("groups by normalised identity, keeps each group's accounts in id order, and orders groups by lowest id", () => {
    const groups = groupByTaxPerson([
      acc(5, "meera sharma"),
      acc(2, "  AARAV   SHARMA "),
      acc(9, null),
      acc(1, "Aarav Sharma"),
      acc(7, "Meera Sharma"),
    ]);
    expect(groups.map((g) => [g.key, g.accounts.map((a) => a.id), g.unassigned])).toEqual([
      ["AARAV SHARMA", [1, 2], false],
      ["MEERA SHARMA", [5, 7], false],
      ["account:9", [9], true],
    ]);
  });

  it("every account lands in exactly one group, and no group is empty", () => {
    const accounts = [acc(1, "A"), acc(2, null), acc(3, "a"), acc(4, "  "), acc(5, "B")];
    const groups = groupByTaxPerson(accounts);
    const ids = groups.flatMap((g) => g.accounts.map((a) => a.id)).sort((x, y) => x - y);
    expect(ids, "a partition: every book belongs to exactly one person").toEqual([1, 2, 3, 4, 5]);
    expect(groups.every((g) => g.accounts.length > 0)).toBe(true);
    expect(groups.length, "A+a are one person; the two blanks are two; B is one").toBe(4);
  });

  it("an empty book has no persons at all", () => {
    expect(groupByTaxPerson([])).toEqual([]);
  });
});

describe("taxPersonLabel — what the page and every export print", () => {
  it("is the identity AS TYPED on the lowest-numbered account carrying it", () => {
    expect(taxPersonLabel([acc(4, "THEJESH K"), acc(2, "Thejesh  K")]), "the casing the user chose survives")
      .toBe("Thejesh K");
  });

  it("falls back to the account's NAME when it states no identity — never to an empty header", () => {
    expect(taxPersonLabel([acc(3, null, "Dhan manual")])).toBe("Dhan manual");
    expect(taxPersonLabel([{ id: 3, name: null, taxIdentity: "   " }])).toBe("Account 3");
  });

  it("an empty group has no label to print", () => {
    expect(taxPersonLabel([])).toBe("");
  });
});

describe("knownTaxIdentities — the editor's datalist, so a typo cannot mint a person", () => {
  it("lists each distinct identity once, as first typed, sorted, and never a blank", () => {
    expect(
      knownTaxIdentities([acc(3, "meera sharma"), acc(1, "Aarav Sharma"), acc(2, "  AARAV  SHARMA"), acc(4, null), acc(5, "  ")]),
    ).toEqual(["Aarav Sharma", "meera sharma"]);
  });

  it("is empty when nobody has stated one", () => {
    expect(knownTaxIdentities([acc(1, null), acc(2, "  ")])).toEqual([]);
  });
});
