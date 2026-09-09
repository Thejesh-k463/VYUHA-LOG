// Indian-locale formatting helpers (lakh/crore grouping, INR, signed P&L).

export function inr(value: number | null | undefined, opts?: { decimals?: number }): string {
  if (value == null || Number.isNaN(value)) return "—";
  const decimals = opts?.decimals ?? 2;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function inrCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

export function num(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function pct(value: number | null | undefined, decimals = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "" : ""}${value.toFixed(decimals)}%`;
}

/**
 * The sign a rupee figure wears — and the ONLY sign a percentage printed
 * BESIDE it may wear (R8).
 *
 * The Open P&L tile chose the two independently — `inrCompact(unrealised)`
 * next to `openPnlPct >= 0 ? "+" : ""` — and printed "-₹17 · +0.00%": one
 * loss stated twice, with two different signs, because the percentage of
 * capital rounded up to a non-negative zero while the rupee figure did not.
 * They are not two facts. Zero rupees is unsigned; a negative rupee whose
 * percentage rounds away still prints "-0.00%", which is the honest reading
 * (a loss too small to show, never a gain).
 *
 * ASCII "-", because that is the glyph `inrCompact()` already emits — a
 * U+2212 here would make the two halves disagree typographically instead.
 */
export function signOf(rupees: number | null | undefined): "" | "+" | "-" {
  if (rupees == null || Number.isNaN(rupees) || rupees === 0) return "";
  return rupees > 0 ? "+" : "-";
}

/** A percentage that BORROWS the rupee figure's sign, never states its own.
 *  The magnitude is absolute so the borrowed sign is the only one. */
export function signedPct(
  rupees: number | null | undefined,
  value: number | null | undefined,
  decimals = 2,
): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${signOf(rupees)}${Math.abs(value).toFixed(decimals)}%`;
}

/** "₹x · y%" as ONE string, both halves signed once from the rupee value. */
export function formatSignedPair(
  rupees: number | null | undefined,
  value: number | null | undefined,
  decimals = 2,
): string {
  const money =
    rupees == null || Number.isNaN(rupees) ? "—" : `${signOf(rupees)}${inrCompact(Math.abs(rupees))}`;
  return `${money} · ${signedPct(rupees, value, decimals)}`;
}

export function signedClass(value: number | null | undefined): string {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-profit" : "text-loss";
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}
