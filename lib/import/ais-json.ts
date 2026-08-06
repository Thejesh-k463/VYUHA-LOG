/**
 * AIS JSON extractor (PURE).
 *
 * Input: the JSON download of the Annual Information Statement from the
 * income-tax portal (incometax.gov.in → AIS → Download → JSON). Output: the
 * same `AisRow` shape the paste path produces, so reconciliation logic is
 * untouched — one reconciler, two front doors.
 *
 * The portal has changed this file's schema more than once and documents none
 * of it, so this is a TOLERANT WALKER, not a schema binding: it recurses the
 * whole document looking for objects that carry (a) a description that
 * classifies as dividend / sale / purchase / interest and (b) an amount.
 * Party names and FY are picked up from the object or inherited from
 * ancestors (AIS nests entries under a per-year, per-source header).
 *
 * Double-counting guard: AIS repeats information as category AGGREGATES above
 * the per-source detail rows. When an object's descendants already produced
 * rows, the object itself is never emitted — leaves win, aggregates are
 * dropped. Anything recognisable but incomplete lands in `unparsed` instead of
 * being guessed at.
 */

import type { AisRow } from "@/lib/analytics/ais";

export interface AisJsonResult {
  rows: AisRow[];
  unparsed: string[];
  /** Objects that classified as one of the four types (pre-dedup). */
  recognised: number;
}

type Type4 = AisRow["type"];

const DESC_KEYS = /desc|information|category|particular|nature|head|name$/i;
const AMOUNT_KEYS = /gross|amount|value|consideration|total|credited/i;
const TDS_KEYS = /tds|taxdeduct/i;
const PARTY_KEYS = /source|entity|deductor|payer|party|reporting|symbol|company/i;
const FY_KEYS = /^fy$|financialyear|^year$|^ay$|assessmentyear|finyear/i;

function classify(s: string): Type4 | null {
  const t = s.toLowerCase();
  if (t.includes("dividend")) return "dividend";
  if (t.includes("sale of securities") || t.includes("sft-18") || t.includes("sft 018") || /\bsale\b.*(securit|mutual|unit)/.test(t)) return "sale";
  if (t.includes("purchase of securities") || t.includes("sft-17") || t.includes("sft 017") || /\bpurchase\b.*(securit|mutual|unit)/.test(t)) return "purchase";
  if (t.includes("interest")) return "interest";
  return null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[₹,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** "2026-27" | "2026-2027" | "FY 2026-27" → "2026-27"; AY → the FY before it. */
function normaliseFy(v: unknown, isAssessmentYear: boolean): string | null {
  const s = String(v ?? "").trim();
  const m = s.match(/(\d{4})\s*-\s*(\d{2,4})/);
  if (!m) return null;
  let start = Number(m[1]);
  if (!Number.isFinite(start)) return null;
  if (isAssessmentYear) start -= 1; // AY 2027-28 assesses FY 2026-27
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

interface Ctx {
  fy: string | null;
  party: string | null;
  /** Classification inherited from an ancestor's description — AIS puts the
   *  "Dividend received" heading on the CATEGORY object and only numbers on
   *  the per-source detail rows beneath it. */
  type: Type4 | null;
  desc: string;
}

export function extractAisJson(jsonText: string): AisJsonResult {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return { rows: [], unparsed: ["Not valid JSON — download AIS in JSON format, not PDF."], recognised: 0 };
  }

  const rows: AisRow[] = [];
  const unparsed: string[] = [];
  let recognised = 0;

  /** Returns true when this subtree emitted at least one row. */
  function walk(node: unknown, ctx: Ctx): boolean {
    if (Array.isArray(node)) {
      let any = false;
      for (const item of node) any = walk(item, ctx) || any;
      return any;
    }
    if (node === null || typeof node !== "object") return false;

    const obj = node as Record<string, unknown>;
    const entries = Object.entries(obj);

    // Context this object contributes for its descendants.
    const next: Ctx = { ...ctx };
    for (const [k, v] of entries) {
      if (FY_KEYS.test(k)) {
        const fy = normaliseFy(v, /^ay$|assessment/i.test(k));
        if (fy) next.fy = fy;
      }
      if (PARTY_KEYS.test(k) && typeof v === "string" && v.trim() && !DESC_KEYS.test(k)) {
        next.party = v.trim().toUpperCase();
      }
      if (typeof v === "string" && DESC_KEYS.test(k)) {
        const c = classify(v);
        if (c) {
          next.type = c;
          next.desc = v;
          recognised += 1;
        }
      }
    }

    // Recurse FIRST — if detail rows exist below, this object is an aggregate
    // of them and must not be emitted too.
    let childEmitted = false;
    for (const [, v] of entries) {
      if (v && typeof v === "object") childEmitted = walk(v, next) || childEmitted;
    }
    if (childEmitted) return true;

    // Leaf candidate: a classification (own or inherited) plus an amount here.
    const type = next.type;
    if (!type) return false;

    let amount: number | null = null;
    let tds = 0;
    for (const [k, v] of entries) {
      if (TDS_KEYS.test(k)) {
        const n = toNumber(v);
        if (n != null && n >= 0) tds = Math.max(tds, n);
        continue;
      }
      if (AMOUNT_KEYS.test(k)) {
        const n = toNumber(v);
        // Largest amount wins: gross beats net beats per-quarter fragments.
        if (n != null && n > 0 && (amount == null || n > amount)) amount = n;
      }
    }
    if (amount == null) return false; // structural node under a heading — not a figure

    const party = next.party ?? next.desc.toUpperCase();
    if (!next.fy) {
      unparsed.push(`${next.desc}${party !== next.desc.toUpperCase() ? ` (${party})` : ""} — no FY found`);
      return false;
    }

    rows.push({ type, party, fy: next.fy, amount, tds });
    return true;
  }

  walk(doc, { fy: null, party: null, type: null, desc: "" });

  // The same figure can still appear twice via sibling summaries — collapse
  // exact duplicates (type+party+fy+amount) rather than summing them.
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const k = `${r.type}|${r.party}|${r.fy}|${r.amount}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (deduped.length === 0 && unparsed.length === 0) {
    unparsed.push("Read the JSON but found no dividend / sale / purchase / interest entries.");
  }
  return { rows: deduped, unparsed, recognised };
}
