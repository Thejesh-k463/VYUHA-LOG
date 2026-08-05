"use client";

/**
 * A6 — where does this write land?
 *
 * "All accounts" is a read view: it aggregates every book into one set of
 * numbers. A trade, though, belongs to exactly one account, so saving from that
 * view is a question the app cannot answer on the user's behalf. It used to
 * answer it anyway — silently, always Primary.
 *
 * This renders ONLY when the question is real: the user is in the aggregate
 * view AND more than one account exists. With a single account the aggregate is
 * that account (see getSelectedAccountId), so callers pass an empty list and
 * nothing appears — the common path keeps zero extra friction.
 */

export interface WriteAccountOption {
  id: number;
  name: string;
}

export function WriteAccountPicker({
  accounts,
  name = "accountId",
  value,
  onChange,
  label = "Save to account",
  className = "",
}: {
  /** Empty (or one entry) renders nothing. */
  accounts: WriteAccountOption[];
  /** Field name when used uncontrolled inside a form action. */
  name?: string;
  /** Controlled value, for callers that build their own FormData. */
  value?: number;
  onChange?: (id: number) => void;
  label?: string;
  className?: string;
}) {
  if (accounts.length < 2) return null;

  return (
    <div className={`rounded-md border border-amber-500/40 bg-amber-500/5 p-3 ${className}`}>
      <label className="block text-xs font-medium text-amber-600 dark:text-amber-400" htmlFor={`write-account-${name}`}>
        {label}
      </label>
      <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
        You are viewing all accounts. Pick the one this belongs to.
      </p>
      <select
        id={`write-account-${name}`}
        name={name}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
        value={value}
        defaultValue={value === undefined ? accounts[0].id : undefined}
        onChange={onChange ? (e) => onChange(Number(e.target.value)) : undefined}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}
