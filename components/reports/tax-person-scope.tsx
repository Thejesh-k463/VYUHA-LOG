import Link from "next/link";
import { getAccounts } from "@/lib/queries/accounts";
import type { TaxScope } from "@/lib/queries/tax-scope";

/**
 * The line every tax surface carries, and the picker it shows instead of a
 * figure (v4.5.0 wave TP, owner ruling T1).
 *
 * A tax figure belongs to a PERSON. So each of the four tax pages states which
 * person it is showing and which accounts that covers — an export whose header
 * names no person is exactly the shape this wave exists to prevent — and when
 * the All-accounts view spans more than one person the page renders THIS picker
 * and no figure at all (invariant 6: never a total nobody can file).
 *
 * The picker is plain links carrying `?person=<key>`: a VIEW choice, never a
 * write and never persisted (invariant 9 — 0 is a view; and a settings write
 * would be a server action, which this project forbids for editor state).
 */
export function TaxPersonLine({ scope }: { scope: TaxScope }) {
  const names = getAccounts()
    .filter((a) => scope.accountIds.includes(a.id))
    .map((a) => `${a.name}${a.archived ? " (archived)" : ""}`);
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
      <div>
        <span className="text-muted-foreground">Tax person: </span>
        <span className="font-medium">{scope.label}</span>
        <span className="text-muted-foreground"> — accounts: {names.join(", ") || "—"}</span>
      </div>
      {scope.unassigned && (
        <div className="mt-1 text-muted-foreground">
          This account has no tax person set — its figures stand alone. Set it in Settings → Accounts.
        </div>
      )}
    </div>
  );
}

/** The "pick a person" card: shown INSTEAD of every figure on the page. */
export function TaxPersonPicker({ scope, basePath }: { scope: TaxScope; basePath: string }) {
  const accountNames = new Map(getAccounts().map((a) => [a.id, a.name]));
  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 p-4 text-sm">
      <div className="font-medium">Choose a tax person</div>
      <p className="mt-1 text-xs text-muted-foreground">
        This book holds more than one tax person, and a return is filed by ONE person. No figure is
        shown across two of them. Pick whose tax view this is, or select one of their accounts in the
        account selector.
      </p>
      <ul className="mt-3 space-y-1">
        {(scope.candidates ?? []).map((c) => (
          <li key={c.key}>
            <Link
              href={`${basePath}?person=${encodeURIComponent(c.key)}`}
              className="text-primary underline underline-offset-2"
            >
              {c.label}
            </Link>
            <span className="text-xs text-muted-foreground">
              {" "}
              — {c.accountIds.map((id) => accountNames.get(id) ?? `#${id}`).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
