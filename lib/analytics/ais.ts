// IND-5 — AIS / Form 26AS / TIS reconciliation (PURE, no DB/React).
// Offline-first: the user pastes rows out of the IT-department statement (AIS
// PDF/JSON or 26AS) in a tolerant line format; the engine reconciles them
// against what the journal actually recorded and flags mismatches BEFORE filing.
//
// Paste format (one item per line, comma/tab separated):
//   TYPE, PARTY-OR-SYMBOL, FY-or-date, AMOUNT [, TDS]
// e.g.
//   dividend, ATGL, 2026-27, 9000, 900
//   sale, Sale of securities (SFT-18), 2026-27, 1250000
//   purchase, SFT-17, 2026-27, 1100000
//   interest, SBI Savings, 2026-27, 4210, 0
//
// TYPE keywords are fuzzy: "dividend", anything containing "sale"/"SFT-18",
// "purchase"/"SFT-17", "interest". FY accepts "2026-27", "FY 2026-27" or any
// ISO/DD-MM-YYYY date (converted to the FY it falls in).

export type AisRowType = "dividend" | "sale" | "purchase" | "interest" | "other";

export interface AisRow {
  type: AisRowType;
  party: string; // reporting entity / symbol as pasted (upper-cased)
  fy: string; // "2026-27"
  amount: number;
  tds: number;
}

export interface JournalDividend {
  symbol: string; // canonical ticker (upper-cased)
  fy: string;
  gross: number;
  tds: number;
}

export interface JournalFyTotal {
  fy: string;
  saleConsideration: number; // Σ equity sell value (+ IPO exits) in the FY
  purchaseValue: number; // Σ equity buy value (+ IPO allotments) in the FY
}

export type ReconStatus = "matched" | "mismatch" | "missing_in_journal" | "missing_in_ais";

export interface DividendRecon {
  key: string; // TICKER FY
  party: string;
  fy: string;
  aisGross: number | null;
  aisTds: number | null;
  journalGross: number | null;
  journalTds: number | null;
  delta: number; // ais − journal (0 when either side missing)
  status: ReconStatus;
}

export interface FyTotalRecon {
  fy: string;
  kind: "sale" | "purchase";
  ais: number | null;
  journal: number | null;
  delta: number;
  status: ReconStatus;
}

export interface AisReconciliation {
  dividends: DividendRecon[];
  fyTotals: FyTotalRecon[];
  interest: AisRow[]; // informational — the journal doesn't track bank interest
  unparsed: string[]; // lines that didn't parse (surfaced, never silently dropped)
  counts: { matched: number; mismatch: number; missingInJournal: number; missingInAis: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Amounts within max(₹10, 0.5%) of each other reconcile as matched. */
export function withinTolerance(a: number, b: number): boolean {
  const tol = Math.max(10, 0.005 * Math.max(Math.abs(a), Math.abs(b)));
  return Math.abs(a - b) <= tol;
}

export function fyOfDate(dateStr: string, fyStartMonth = 4): string | null {
  const d = new Date(dateStr.length === 10 && dateStr[2] === "-" ? dateStr.split("-").reverse().join("-") : dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const start = d.getMonth() + 1 >= fyStartMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function parseFy(token: string, fyStartMonth: number): string | null {
  const t = token.trim().replace(/^fy\s*/i, "");
  const m = t.match(/^(\d{4})\s*[-/]\s*(\d{2,4})$/);
  if (m) {
    const start = Number(m[1]);
    return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  }
  return fyOfDate(t, fyStartMonth);
}

function parseAmount(token: string): number | null {
  const n = Number(token.replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function typeOf(token: string): AisRowType {
  const t = token.toLowerCase();
  if (t.includes("dividend")) return "dividend";
  if (t.includes("sale") || t.includes("sft-18") || t.includes("sft 18")) return "sale";
  if (t.includes("purchase") || t.includes("sft-17") || t.includes("sft 17")) return "purchase";
  if (t.includes("interest")) return "interest";
  return "other";
}

export function parseAisText(
  text: string,
  fyStartMonth = 4,
): { rows: AisRow[]; unparsed: string[] } {
  const rows: AisRow[] = [];
  const unparsed: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Field separators: tabs first (AIS PDF copies), then comma+space, then plain
    // comma. The comma+space pass keeps Indian grouped amounts ("₹12,50,000")
    // intact — grouping commas have no space after them.
    let parts = line.split(/\t+/).map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length < 4) parts = line.split(/,\s+/).map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length < 4) parts = line.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length < 4) {
      unparsed.push(line);
      continue;
    }
    const type = typeOf(parts[0]);
    const fy = parseFy(parts[2], fyStartMonth);
    const amount = parseAmount(parts[3]);
    const tds = parts.length > 4 ? parseAmount(parts[4]) ?? 0 : 0;
    if (type === "other" || fy == null || amount == null) {
      unparsed.push(line);
      continue;
    }
    rows.push({ type, party: parts[1].toUpperCase(), fy, amount, tds });
  }
  return { rows, unparsed };
}

export function reconcileAis(
  parsed: { rows: AisRow[]; unparsed: string[] },
  journalDividends: JournalDividend[],
  journalFyTotals: JournalFyTotal[],
  resolveTickerFn: (name: string) => string = (s) => s,
): AisReconciliation {
  const { rows, unparsed } = parsed;

  // --- Dividends: match per company (canonical ticker) per FY -------------
  const aisDivs = new Map<string, { party: string; fy: string; gross: number; tds: number }>();
  for (const r of rows.filter((x) => x.type === "dividend")) {
    const ticker = resolveTickerFn(r.party);
    const key = `${ticker} ${r.fy}`;
    const cur = aisDivs.get(key) ?? { party: r.party, fy: r.fy, gross: 0, tds: 0 };
    cur.gross = r2(cur.gross + r.amount);
    cur.tds = r2(cur.tds + r.tds);
    aisDivs.set(key, cur);
  }
  const jDivs = new Map<string, JournalDividend>();
  for (const d of journalDividends) {
    const key = `${resolveTickerFn(d.symbol)} ${d.fy}`;
    const cur = jDivs.get(key);
    if (cur) {
      cur.gross = r2(cur.gross + d.gross);
      cur.tds = r2(cur.tds + d.tds);
    } else jDivs.set(key, { ...d });
  }

  const dividends: DividendRecon[] = [];
  for (const [key, a] of aisDivs) {
    const j = jDivs.get(key) ?? null;
    const status: ReconStatus =
      j == null ? "missing_in_journal" : withinTolerance(a.gross, j.gross) ? "matched" : "mismatch";
    dividends.push({
      key,
      party: a.party,
      fy: a.fy,
      aisGross: a.gross,
      aisTds: a.tds,
      journalGross: j?.gross ?? null,
      journalTds: j?.tds ?? null,
      delta: j == null ? 0 : r2(a.gross - j.gross),
      status,
    });
  }
  for (const [key, j] of jDivs) {
    if (aisDivs.has(key)) continue;
    dividends.push({
      key,
      party: j.symbol,
      fy: j.fy,
      aisGross: null,
      aisTds: null,
      journalGross: j.gross,
      journalTds: j.tds,
      delta: 0,
      status: "missing_in_ais",
    });
  }
  dividends.sort((a, b) => a.key.localeCompare(b.key));

  // --- Sale / purchase consideration: per-FY aggregate totals -------------
  const fyTotals: FyTotalRecon[] = [];
  const jByFy = new Map(journalFyTotals.map((t) => [t.fy, t]));
  for (const kind of ["sale", "purchase"] as const) {
    const aisByFy = new Map<string, number>();
    for (const r of rows.filter((x) => x.type === kind)) {
      aisByFy.set(r.fy, r2((aisByFy.get(r.fy) ?? 0) + r.amount));
    }
    for (const [fy, ais] of aisByFy) {
      const j = jByFy.get(fy);
      const journal = j == null ? null : kind === "sale" ? j.saleConsideration : j.purchaseValue;
      const status: ReconStatus =
        journal == null || journal === 0
          ? "missing_in_journal"
          : withinTolerance(ais, journal)
            ? "matched"
            : "mismatch";
      fyTotals.push({ fy, kind, ais, journal, delta: journal == null ? 0 : r2(ais - journal), status });
    }
    for (const t of journalFyTotals) {
      const val = kind === "sale" ? t.saleConsideration : t.purchaseValue;
      if (val > 0 && !aisByFy.has(t.fy)) {
        fyTotals.push({ fy: t.fy, kind, ais: null, journal: val, delta: 0, status: "missing_in_ais" });
      }
    }
  }
  fyTotals.sort((a, b) => a.fy.localeCompare(b.fy) || a.kind.localeCompare(b.kind));

  const all = [...dividends, ...fyTotals];
  return {
    dividends,
    fyTotals,
    interest: rows.filter((x) => x.type === "interest"),
    unparsed,
    counts: {
      matched: all.filter((x) => x.status === "matched").length,
      mismatch: all.filter((x) => x.status === "mismatch").length,
      missingInJournal: all.filter((x) => x.status === "missing_in_journal").length,
      missingInAis: all.filter((x) => x.status === "missing_in_ais").length,
    },
  };
}
