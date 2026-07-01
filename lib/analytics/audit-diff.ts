// P0.3 — pure helper to diff before/after snapshots for the audit viewer.

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

function eq(x: unknown, y: unknown): boolean {
  return JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
}

/**
 * Field-level diff between two snapshots. With `fields` given, only those keys are
 * compared (and in that order); otherwise the union of both objects' keys is used.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields?: string[],
): FieldChange[] {
  const b = before ?? {};
  const a = after ?? {};
  const keys = fields ?? [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (!eq(b[k], a[k])) out.push({ field: k, from: b[k] ?? null, to: a[k] ?? null });
  }
  return out;
}
