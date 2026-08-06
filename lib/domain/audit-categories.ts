/**
 * Semantic grouping for the audit log.
 *
 * The flat table stops working after a few months of real use: bhavcopy
 * auto-MTM alone writes one row per trading day, and by entry ~200 the rows a
 * trader actually cares about (their own edits, deletes, capital changes) are
 * buried in price-maintenance noise. Grouping is BY WHAT HAPPENED, not by the
 * raw entity column — the entity column files auto-MTM under "Settings", which
 * is technically where it writes and semantically useless.
 *
 * Pure module: no DB, no React. The classifier takes whatever fields a row
 * has; every rule is ordered most-specific-first, and anything unmatched lands
 * in "other" rather than being guessed at.
 */

export type AuditCategoryId =
  | "trades"
  | "journal"
  | "prices"
  | "imports"
  | "capital"
  | "config"
  | "licence"
  | "other";

export interface AuditCategoryDef {
  id: AuditCategoryId;
  label: string;
  /** One line under the label — what a user will find inside. */
  hint: string;
}

/** Display order: the user's own actions first, machine maintenance last. */
export const AUDIT_CATEGORIES: AuditCategoryDef[] = [
  { id: "trades", label: "Trades", hint: "Created, edited, closed, staged" },
  { id: "journal", label: "Journal & playbooks", hint: "Playbook tags, emotions, mistake reviews" },
  { id: "imports", label: "Imports, deletes & backups", hint: "Files committed, batches removed, restores" },
  { id: "capital", label: "Capital & ledger", hint: "Capital changes, cash ledger entries" },
  { id: "config", label: "Settings & rates", hint: "Preferences, charge/risk rate edits" },
  { id: "licence", label: "Licence", hint: "Activation and licence checks" },
  { id: "prices", label: "Auto-MTM & prices", hint: "Bhavcopy runs marking open positions" },
  { id: "other", label: "Other", hint: "Anything the rules above don't claim" },
];

interface RowLike {
  entity: string;
  action: string;
  summary?: string | null;
  source?: string | null;
}

export function categorizeAuditRow(row: RowLike): AuditCategoryId {
  const summary = row.summary ?? "";
  const entity = row.entity ?? "";
  const action = row.action ?? "";
  const source = row.source ?? "";

  // Machine price maintenance — by far the noisiest writer, so it goes first.
  // It records itself under entity "settings", which is why entity alone is
  // the wrong grouping key.
  if (source === "bhavcopy" || /bhavcopy|auto-?mtm/i.test(summary)) return "prices";

  if (/licen[cs]e/i.test(summary)) return "licence";

  if (entity === "capital" || entity === "ledger") return "capital";

  // Destruction and restoration — the rows people come here to find.
  if (
    /\bimport(ed)?\b|\bbatch\b|\brestore(d)?\b|\bbackup\b/i.test(summary) ||
    action === "delete" ||
    entity === "import"
  ) {
    return "imports";
  }

  if (entity === "trade") {
    // A journal edit mutates the trade row too; what the user DID was journal.
    if (/journal updated|playbook|emotion|mistake/i.test(summary)) return "journal";
    return "trades";
  }

  if (/playbook/i.test(summary)) return "journal";

  if (
    entity === "settings" ||
    entity === "charge_config" ||
    entity === "risk_config" ||
    entity === "restriction"
  ) {
    return "config";
  }

  return "other";
}

/** Rows per category, in AUDIT_CATEGORIES display order, empty groups kept. */
export function groupAuditRows<T extends RowLike>(rows: T[]): Map<AuditCategoryId, T[]> {
  const out = new Map<AuditCategoryId, T[]>(AUDIT_CATEGORIES.map((c) => [c.id, []]));
  for (const r of rows) out.get(categorizeAuditRow(r))!.push(r);
  return out;
}
