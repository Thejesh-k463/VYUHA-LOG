import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEDUP_LABEL_PREFIX,
  dedupLabelFromNotes,
  executionIdentity,
  identityScope,
  isDedupHash,
  scopedHash,
  scopedHashes,
  withDedupLabelNote,
} from "@/lib/import/trade-identity";
import { dedupHash, dedupSymbolKey } from "@/lib/import/dedup";
import { normalizeCompanyName, securityByCompanyName } from "@/lib/import/isin-symbol";
import { parseDhanGtr } from "@/lib/import/parsers/dhan-gtr";
import { parseDhanCsv } from "@/lib/import/parsers/dhan-csv";
import { parseDhanRealisedPnl } from "@/lib/import/parsers/dhan-realised-pnl";
import * as XLSX from "xlsx";
import snapshot from "@/lib/data/isin-symbols.json";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * v4.5.0 W1 — ONE trade identity (`lib/import/trade-identity.ts`), the PURE half.
 *
 * Three claims are under test here, and every one of them is a claim about a
 * hash that is ALREADY STORED in somebody's journal:
 *
 *   1. F-L1-7 — rows of ONE file that share a `dedupHash` across more than one
 *      `segment|exchange` scope are different executions. The first scope by
 *      string sort keeps the LEGACY hash and the rest take `sha1(hash|scope)`,
 *      so a file with one scope per hash — which is nearly every file ever
 *      imported — hashes byte-for-byte as v4.4.0 hashed it.
 *   2. F-L1-3 — the three Dhan reports that state a company NAME now resolve it
 *      to a ticker, and RESOLVING IT MOVES NO HASH: identity stays the label the
 *      file carried (`dedupLabel`, recorded as a `gtr-name:` note). Four hashes
 *      are pinned as literal hex so a future edit to the resolution chain cannot
 *      silently re-key a stored book.
 *   3. A company name resolves to exactly one security or to NOTHING. Never to
 *      the first of two — that is the silent two-companies-in-one-position merge
 *      `lib/import/isin-symbol.ts` exists to prevent (invariant 6).
 *
 * Pure module, no database (invariant 2); the DB half is
 * tests/trade-identity-db.test.ts.
 */

const FIX = (...p: string[]) => path.join(process.cwd(), "tests", "fixtures", ...p);

/**
 * The hash EXACTLY as v4.4.0 computed it: broker, the label the file carried
 * upper-cased, quantities, prices, values, dates. Written out longhand rather
 * than called from lib/, so a change to `dedupSymbolKey` cannot move both sides
 * of the assertion at once.
 */
function legacyHash(t: {
  broker: string; label: string; buyQty: number; avgBuyPrice: number; buyValue: number;
  sellQty: number; avgSellPrice: number; sellValue: number; buyDate?: string | null; sellDate?: string | null;
}): string {
  const parts = [
    t.broker, t.label.trim().toUpperCase(), t.buyQty, t.avgBuyPrice, t.buyValue,
    t.sellQty, t.avgSellPrice, t.sellValue, t.buyDate ?? "", t.sellDate ?? "",
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex");
}

/** The raw text a parsed row is KEYED on — its `dedupLabel`, or its symbol. */
const rawLabel = (t: NormalizedTrade) => (t.dedupLabel ?? t.tradingsymbol).trim();

const ROW = {
  broker: "dhan",
  tradingsymbol: "TCS",
  isin: null as string | null,
  buyQty: 10,
  avgBuyPrice: 3000,
  buyValue: 30000,
  sellQty: 10,
  avgSellPrice: 3100,
  sellValue: 31000,
  buyDate: "2026-08-03",
  sellDate: "2026-08-04",
};

// ───────────────────────────── the identity door ────────────────────────────

describe("executionIdentity — hash, scope, symbol key and label", () => {
  it("the hash is dedupHash, unchanged; the scope is segment|exchange", () => {
    const id = executionIdentity({ ...ROW, segment: "eq_delivery", exchange: "NSE" });
    expect(id.hash).toBe(dedupHash(ROW));
    expect(id.hash).toBe(legacyHash({ ...ROW, label: "TCS" }));
    expect(id.scope).toBe("eq_delivery|NSE");
    expect(id.symbolKey).toBe("TCS");
    expect(id.label).toBe("TCS");
    expect(isDedupHash(id.hash)).toBe(true);
  });

  it("the SCOPE is not in the hash — two exchanges hash the same", () => {
    const nse = executionIdentity({ ...ROW, segment: "eq_delivery", exchange: "NSE" });
    const bse = executionIdentity({ ...ROW, segment: "eq_delivery", exchange: "BSE" });
    expect(bse.hash).toBe(nse.hash);
    expect(bse.scope).not.toBe(nse.scope);
  });

  it("a missing half of the scope is stated as the empty string, not dropped", () => {
    expect(identityScope(null, "NSE")).toBe("|NSE");
    expect(identityScope("eq_delivery", undefined)).toBe("eq_delivery|");
    expect(identityScope(" eq_intraday ", " BSE ")).toBe("eq_intraday|BSE");
    expect(identityScope(null, null)).toBe("|");
  });

  it("a dedupLabel becomes the identity, and the tradingsymbol becomes cosmetic", () => {
    const id = executionIdentity({
      ...ROW, tradingsymbol: "AARTIIND", isin: "INE769A01020",
      dedupLabel: "Aarti Industries", segment: "eq_delivery", exchange: "NSE",
    });
    expect(id.label).toBe("Aarti Industries");
    expect(id.symbolKey).toBe("AARTI INDUSTRIES");
    expect(id.hash).toBe(legacyHash({ ...ROW, label: "Aarti Industries" }));
    // The ticker it is SHOWN as has no say in the hash.
    expect(id.hash).not.toBe(legacyHash({ ...ROW, label: "AARTIIND" }));
  });
});

// ─────────────────────── dedupSymbolKey — the precedence ────────────────────

describe("dedupSymbolKey — label beats tradingsymbol, Paytm's ISIN rule is untouched", () => {
  it("states no label: the tradingsymbol, trimmed and upper-cased, exactly as before", () => {
    expect(dedupSymbolKey("dhan", " tcs ", "INE467B01029")).toBe("TCS");
    expect(dedupSymbolKey("dhan", "TCS", null, null)).toBe("TCS");
    expect(dedupSymbolKey("dhan", "TCS", null, "   ")).toBe("TCS");
  });

  it("states a label: the label wins over the tradingsymbol", () => {
    expect(dedupSymbolKey("dhan", "AARTIIND", "INE769A01020", "Aarti Industries")).toBe("AARTI INDUSTRIES");
    expect(dedupSymbolKey("zerodha", "TCS", null, " tata consultancy ")).toBe("TATA CONSULTANCY");
  });

  it("Paytm still keys on ISIN — a label cannot take that back (owner ruling 2026-09-04)", () => {
    expect(dedupSymbolKey("paytm", "SYNALPHA", "INE0SYN01001")).toBe("ISIN:INE0SYN01001");
    expect(dedupSymbolKey("paytm", "SYNALPHA", "INE0SYN01001", "Syn Alpha Limited")).toBe("ISIN:INE0SYN01001");
    // …and a Paytm row WITHOUT an ISIN still falls back to the label like everyone else.
    expect(dedupSymbolKey("paytm", "999001", null, "Syn Alpha")).toBe("SYN ALPHA");
    expect(dedupSymbolKey("paytm", "999001", "  ", null)).toBe("999001");
  });
});

// ──────────────────────────── F-L1-7 — one hash, k scopes ───────────────────

describe("scopedHashes — the in-file NSE/BSE collision (F-L1-7)", () => {
  const H1 = "a".repeat(40);
  const H2 = "b".repeat(40);

  it("one scope per hash: every row keeps the hash v4.4.0 gave it", () => {
    const rows = [
      { hash: H1, scope: "eq_delivery|NSE" },
      { hash: H2, scope: "eq_delivery|BSE" },
      { hash: H2, scope: "eq_delivery|BSE" },
    ];
    expect(scopedHashes(rows)).toEqual([H1, H2, H2]);
  });

  it("two scopes on one hash: the FIRST by string sort keeps the legacy hash", () => {
    const out = scopedHashes([
      { hash: H1, scope: "eq_delivery|NSE" },
      { hash: H1, scope: "eq_delivery|BSE" },
    ]);
    // "eq_delivery|BSE" < "eq_delivery|NSE", so the BSE row is the one that keeps it.
    expect(out).toEqual([scopedHash(H1, "eq_delivery|NSE"), H1]);
    expect(out[0]).not.toBe(out[1]);
    expect(isDedupHash(out[0]!)).toBe(true);
  });

  it("the derived hash is sha1(hash|scope) and nothing else", () => {
    expect(scopedHash(H1, "eq_delivery|NSE")).toBe(
      createHash("sha1").update(`${H1}|eq_delivery|NSE`).digest("hex"),
    );
  });

  it("is ORDER-INDEPENDENT — shuffling the file's rows moves no row's hash", () => {
    const rows = [
      { hash: H1, scope: "eq_delivery|NSE" },
      { hash: H1, scope: "eq_delivery|BSE" },
      { hash: H1, scope: "eq_intraday|NSE" },
      { hash: H2, scope: "eq_delivery|NSE" },
    ];
    const byIndex = new Map(rows.map((r, i) => [i, scopedHashes(rows)[i]!]));
    // Every permutation of four rows, not a sample of them.
    const permute = <T,>(xs: T[]): T[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    for (const order of permute([0, 1, 2, 3])) {
      const out = scopedHashes(order.map((i) => rows[i]!));
      for (const [j, i] of order.entries()) expect(out[j]).toBe(byIndex.get(i));
    }
  });

  it("three scopes: one legacy hash and two derived, all distinct", () => {
    const rows = [
      { hash: H1, scope: "eq_intraday|NSE" },
      { hash: H1, scope: "eq_delivery|NSE" },
      { hash: H1, scope: "eq_delivery|BSE" },
    ];
    const out = scopedHashes(rows);
    expect(out.filter((h) => h === H1)).toHaveLength(1);
    // The alphabetically first scope is the delivery/BSE row.
    expect(out[2]).toBe(H1);
    expect(new Set(out).size).toBe(3);
  });

  it("CONTROL — the same hash in the SAME scope is an in-file duplicate and still collapses", () => {
    const rows = [
      { hash: H1, scope: "eq_delivery|NSE" },
      { hash: H1, scope: "eq_delivery|NSE" },
    ];
    expect(scopedHashes(rows)).toEqual([H1, H1]);
  });

  it("an empty file returns nothing and throws nothing", () => {
    expect(scopedHashes([])).toEqual([]);
  });
});

// ─────────────────── the gtr-name: note (the stored raw label) ──────────────

describe("withDedupLabelNote / dedupLabelFromNotes", () => {
  it("appends the segment once and reads it back", () => {
    const notes = withDedupLabelNote(null, "Aarti Industries");
    expect(notes).toBe(`${DEDUP_LABEL_PREFIX}Aarti Industries`);
    expect(dedupLabelFromNotes(notes)).toBe("Aarti Industries");
  });

  it("preserves the segments already there, in order", () => {
    const prior = "Bill mixed intraday and delivery | Imported 2026-07-21";
    const notes = withDedupLabelNote(prior, "Anant Raj");
    expect(notes).toBe(`${prior.replace(/ \| /g, " | ")} | ${DEDUP_LABEL_PREFIX}Anant Raj`);
    expect(dedupLabelFromNotes(notes)).toBe("Anant Raj");
  });

  it("is idempotent — a second pass adds no second segment", () => {
    const once = withDedupLabelNote("Some note", "Anant Raj");
    expect(withDedupLabelNote(once, "Anant Raj")).toBe(once);
    // …and it does not overwrite the label already recorded, whatever it is told.
    expect(withDedupLabelNote(once, "Something Else")).toBe(once);
  });

  it("a row with no gtr-name: segment reads back null — its tradingsymbol IS its label", () => {
    expect(dedupLabelFromNotes(null)).toBeNull();
    expect(dedupLabelFromNotes("")).toBeNull();
    expect(dedupLabelFromNotes("dedup-alias:abc | Closed by this file")).toBeNull();
    expect(dedupLabelFromNotes(`${DEDUP_LABEL_PREFIX}   `)).toBeNull();
  });

  it("isDedupHash accepts a sha1 hex digest and nothing else", () => {
    expect(isDedupHash("a".repeat(40))).toBe(true);
    expect(isDedupHash("A".repeat(40))).toBe(false);
    expect(isDedupHash("a".repeat(39))).toBe(false);
    expect(isDedupHash("test-dedup-1")).toBe(false);
  });
});

// ───────────────── F-L1-3 — resolving a name moves NO stored hash ───────────

/**
 * The pinned hashes below were computed with the LEGACY recipe (`legacyHash`
 * above) from the raw scrip name each report states — i.e. they are the hashes
 * v4.4.0 wrote into `trades.dedup_hash` for these exact fixture rows. They are
 * literal hex on purpose: a future change to the resolution chain that moved a
 * hash would re-import an entire report as new trades, and the only thing that
 * can catch it is a number written down before the change.
 */
interface Pin { file: string; label: string; hex: string }

const gtrReal = parseDhanGtr({
  filename: "Dhan_GlobalTransction_Report_01-07-2026_29-07-2026.csv",
  text: fs.readFileSync(FIX("dhan-gtr-real.csv"), "utf8"),
});
const gtrRedacted = parseDhanGtr({
  filename: "Dhan_GlobalTransction_Report_01-07-2026_29-07-2026.csv",
  text: fs.readFileSync(FIX("dhan-gtr.csv"), "utf8"),
});
const pnlReal = parseDhanCsv({
  filename: "dhan-pnl-real.csv",
  text: fs.readFileSync(FIX("dhan-pnl-real.csv"), "utf8"),
});
const realisedA1 = parseDhanRealisedPnl({
  filename: "dhan-realised-pnl-2026-04-01_2026-09-03-a1.xls",
  buffer: fs.readFileSync(FIX("redacted", "dhan-realised-pnl-2026-04-01_2026-09-03-a1.xls")),
});

/** The first row of each named file that is keyed on `label`, and its v4.4.0 hash. */
const PINS: Pin[] = [
  { file: "dhan-gtr-real.csv", label: "Aarti Industries", hex: "2cc66e8880670dd96ef30149fc57e3184a041ecc" },
  { file: "dhan-pnl-real.csv", label: "Reliance Industries", hex: "922340ca4cfbc3b12e5cb16f8c37d5d0002cf682" },
  // The one row that resolves to NOTHING: it is keyed on its tradingsymbol,
  // because it never got a label.
  { file: "dhan-pnl-real.csv", label: "Paras Defence Space Tech", hex: "0c3582bc7b4b14247f99a7fc93d7644bf8ad86d2" },
  { file: "dhan-realised-pnl-…-a1.xls", label: "Adani Energy Solutions", hex: "0dce9e07ba4c787df04daef044393f89788f1d95" },
];

const BY_FILE: Record<string, NormalizedTrade[]> = {
  "dhan-gtr-real.csv": gtrReal.trades,
  "dhan-pnl-real.csv": pnlReal.trades,
  "dhan-realised-pnl-…-a1.xls": realisedA1.trades,
};

/** Every cell of a workbook as one blob — the file's OWN words, not a parser's. */
function rawTextOf(file: string): string {
  const buf = fs.readFileSync(file);
  if (file.endsWith(".csv")) return buf.toString("utf8");
  const wb = XLSX.read(buf, { type: "buffer" });
  return wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join("\n");
}
const squash = (s: string) => s.replace(/\s+/g, " ").toUpperCase();

const FILES = [
  { label: "the Dhan Global Transaction Report", parsed: gtrReal, resolves: true, raw: squash(rawTextOf(FIX("dhan-gtr-real.csv"))) },
  { label: "the redacted GTR (no name resolves)", parsed: gtrRedacted, resolves: false, raw: squash(rawTextOf(FIX("dhan-gtr.csv"))) },
  { label: "the Dhan P&L export", parsed: pnlReal, resolves: true, raw: squash(rawTextOf(FIX("dhan-pnl-real.csv"))) },
  {
    label: "the Dhan Realised P&L report", parsed: realisedA1, resolves: true,
    raw: squash(rawTextOf(FIX("redacted", "dhan-realised-pnl-2026-04-01_2026-09-03-a1.xls"))),
  },
];

describe.each(FILES)("stored-hash stability — $label", ({ parsed, resolves, raw }) => {
  /**
   * The oracle that keeps the claim above honest. `legacyHash(rawLabel(t))`
   * would agree with `dedupHash(t)` no matter WHICH string the row is keyed on
   * — so the string itself is checked against the file's own bytes: identity
   * must be text the report states, never a ticker we resolved for it.
   */
  it("keys identity on text the FILE states — a resolved ticker is never the identity", () => {
    const labelled = parsed.trades.filter((t) => t.dedupLabel);
    if (resolves) {
      expect(labelled.length, "no row of this file is keyed on the name the file states").toBeGreaterThan(0);
      // …and the ticker each one is SHOWN as is our word, not the file's.
      const invented = labelled.filter((t) => !raw.includes(squash(t.tradingsymbol)));
      expect(invented.length, "every resolved ticker also appears in the file — nothing was resolved").toBeGreaterThan(0);
    }
    for (const t of parsed.trades) {
      expect(raw, `the identity "${rawLabel(t)}" is not text this file contains`).toContain(squash(rawLabel(t)));
    }
  });

  it("every row hashes on the RAW scrip name the file states, exactly as v4.4.0 did", () => {
    expect(parsed.trades.length).toBeGreaterThan(0);
    for (const t of parsed.trades) {
      const label = rawLabel(t);
      expect(dedupHash({ ...t, broker: "dhan" })).toBe(legacyHash({ ...t, broker: "dhan", label }));
      // The v4.4.0 row byte for byte: the name AS the tradingsymbol, no ISIN,
      // no label. Resolving the name moved this hash nowhere.
      expect(dedupHash({ ...t, broker: "dhan", tradingsymbol: label, isin: null, dedupLabel: null }))
        .toBe(dedupHash({ ...t, broker: "dhan" }));
    }
  });

  it("a resolved row carries its raw label in importNotes; an unresolved one carries none", () => {
    for (const t of parsed.trades) {
      const note = dedupLabelFromNotes((t.importNotes ?? []).join(" | "));
      if (t.dedupLabel) {
        expect(note, `${t.tradingsymbol} states a dedupLabel but no gtr-name: note`).toBe(t.dedupLabel);
        // The shown symbol is the resolved TICKER — upper case, and the same
        // string as the label only where the file already stated the ticker
        // (IFCI, CUPID): the note is then a harmless restatement of identity.
        expect(t.tradingsymbol).toBe(t.tradingsymbol.toUpperCase());
      } else {
        expect(note).toBeNull();
      }
    }
    if (!resolves) expect(parsed.trades.every((t) => !t.dedupLabel)).toBe(true);
    else expect(parsed.trades.some((t) => t.dedupLabel)).toBe(true);
  });
});

describe("stored-hash stability — the literal pins", () => {
  it.each(PINS)("$file / $label still hashes to $hex", ({ file, label, hex }) => {
    const row = BY_FILE[file]!.find((t) => rawLabel(t) === label);
    expect(row, `no row of ${file} is keyed on "${label}" any more`).toBeTruthy();
    expect(dedupHash({ ...row!, broker: "dhan" })).toBe(hex);
    expect(legacyHash({ ...row!, broker: "dhan", label })).toBe(hex);
  });

  it("the unresolved pin is a row that states NO label — it hashes on its tradingsymbol", () => {
    const row = pnlReal.trades.find((t) => t.tradingsymbol === "Paras Defence Space Tech");
    expect(row, "the unresolved fixture row has gone").toBeTruthy();
    expect(row!.dedupLabel ?? null).toBeNull();
    expect(row!.isin).toBeNull();
    expect(dedupHash({ ...row!, broker: "dhan" })).toBe(PINS[2]!.hex);
  });

  it("the redacted GTR resolves nothing and every one of its hashes is the v4.4.0 hash", () => {
    for (const t of gtrRedacted.trades) {
      expect(t.dedupLabel ?? null).toBeNull();
      expect(t.isin).toBeNull();
      expect(dedupHash({ ...t, broker: "dhan" })).toBe(legacyHash({ ...t, broker: "dhan", label: t.tradingsymbol }));
    }
  });
});

// ───────────────── securityByCompanyName — one answer or none ───────────────

describe("normalizeCompanyName", () => {
  it("upper-cases, reads & as AND and collapses punctuation to one space", () => {
    expect(normalizeCompanyName("Bhansali Engg. Polymers")).toBe("BHANSALI ENGG POLYMERS");
    expect(normalizeCompanyName("Gujarat Narmada Valley Fert & Chem")).toBe("GUJARAT NARMADA VALLEY FERT AND CHEM");
  });

  it("strips corporate suffixes from the END only, repeatedly, and a leading THE", () => {
    expect(normalizeCompanyName("Acme Widgets Private Limited")).toBe("ACME WIDGETS");
    expect(normalizeCompanyName("Tata Consultancy Services Ltd.")).toBe("TATA CONSULTANCY SERVICES");
    expect(normalizeCompanyName("The Indian Hotels Company Limited")).toBe("INDIAN HOTELS COMPANY");
    // …and NOT from the middle: "Limited Liability" is part of a name.
    expect(normalizeCompanyName("Ltd Horizons Industries")).toBe("LTD HORIZONS INDUSTRIES");
  });

  it("does not collapse two different companies into one key", () => {
    expect(normalizeCompanyName("Gabriel India")).not.toBe(normalizeCompanyName("Gabriel"));
  });

  it("an empty or punctuation-only name normalises to nothing", () => {
    expect(normalizeCompanyName("")).toBe("");
    expect(normalizeCompanyName("   --  ")).toBe("");
  });
});

describe("securityByCompanyName", () => {
  it("a unique name resolves to the ticker the rest of the book is keyed on", () => {
    expect(securityByCompanyName("Reliance Industries")).toEqual({ symbol: "RELIANCE", isin: "INE002A01018" });
    expect(securityByCompanyName("Aarti Industries")).toEqual({ symbol: "AARTIIND", isin: "INE769A01020" });
    // Case, spacing and a corporate suffix do not change the answer.
    expect(securityByCompanyName("  reliance industries limited ")).toEqual(securityByCompanyName("Reliance Industries"));
  });

  it("an UNKNOWN or abbreviated name resolves to nothing — the caller keeps the file's word", () => {
    expect(securityByCompanyName("Gujarat Narmada Valley Fert & Chem")).toBeNull();
    expect(securityByCompanyName("Paras Defence Space Tech")).toBeNull();
    expect(securityByCompanyName("Not A Listed Company At All")).toBeNull();
    expect(securityByCompanyName("")).toBeNull();
    expect(securityByCompanyName("   ")).toBeNull();
    // An F&O contract name is not a company name either.
    expect(securityByCompanyName("OPT NIFTY 29 Sep 2026 24500 CE")).toBeNull();
  });

  it("a name held by TWO securities resolves to NEITHER — never first-writer-wins", () => {
    // The DVR/partly-paid pairs are the real ones: one name, two ISINs.
    expect(securityByCompanyName("Jain Irrigation Systems")).toBeNull();
    // And the rule, over the whole bundled snapshot rather than one example:
    // EVERY normalised name carried by more than one security answers null.
    const byKey = new Map<string, Set<string>>();
    for (const [isin, t] of Object.entries((snapshot as unknown as { byIsin: Record<string, string[]> }).byIsin)) {
      if (!t[0] || !t[1]) continue;
      const key = normalizeCompanyName(t[1]);
      if (!key) continue;
      const set = byKey.get(key) ?? new Set<string>();
      set.add(`${t[0]}|${isin.toUpperCase()}`);
      byKey.set(key, set);
    }
    const ambiguous = [...byKey].filter(([, s]) => s.size > 1).map(([k]) => k);
    expect(ambiguous.length, "the snapshot carries no ambiguous name at all — this rule is untested").toBeGreaterThan(0);
    for (const key of ambiguous) {
      expect(securityByCompanyName(key), `"${key}" is two securities and must resolve to neither`).toBeNull();
    }
  });
});
