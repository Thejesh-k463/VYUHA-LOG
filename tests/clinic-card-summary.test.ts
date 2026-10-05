// v4.8.0 wave P2 — the Arjun's Eye Clinic card reads a stored summary
// (`clinic_cache.summary_json`, migration 0081) instead of re-projecting the book,
// hashing it and parsing the whole cached report to print ONE finding.
//
// What is pinned here, each against a REAL migrated database (ONE temp DB for the
// file) and each shown red with its half of the change reverted:
//
//   1. migration 0081 — one nullable TEXT column, registered right after 0080;
//   2. the compute writes the summary NEXT TO the report, and it equals what
//      `weeklyNote` / `teaser` derive from that SAME stored report (insert AND upsert);
//      the report itself is byte-for-byte the engine's output — nothing moved into it;
//   3. the card path with a summary performs NO `getClinicTrades` call (a throwing
//      stub — which also rules out the digest, whose only input is that array) and NO
//      parse of `report_json` (a JSON.parse spy, and a corrupted report it never notices);
//   4. the card is the v4.7.0 card: same data and byte-identical markup as
//      `clinicStateFor(getClinicState(), pro)` through the v4.7.0 component, for a Pro
//      and a free copy, in every scope and cache state;
//   5. a row cached before 0081 (summary NULL), or a summary that is not its report's,
//      falls back to the report on that read — never a blank card, never a write;
//   6. a row from another ENGINE_VERSION is never read; the read is scoped by
//      `getSelectedAccountId()` (invariant 8; `acct:0` = the All view).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { BACKUP_TABLES } from "@/lib/backup-format";
import { Card, CardContent } from "@/components/ui/card";
import { ClinicCopyBlock, GradeBadge } from "@/components/edge-clinic/clinic-copy";
import { ArjunClinicCard } from "@/components/edge-clinic/arjun-clinic-card";
import { hubForHref, hubTabHref } from "@/lib/domain/hubs";
import { edgeClinic, ENGINE_VERSION, type ClinicReport } from "@/lib/analytics/edge-clinic";
import {
  CLINIC_CARD_MISSING,
  clinicCardFor,
  clinicStateFor,
  type ClinicCard,
  type ClinicCardSummary,
  type ClinicState,
} from "@/lib/analytics/edge-clinic-contract";
import { clinicCardSummary, parseClinicCardSummary, teaser, weeklyNote } from "@/lib/analytics/edge-clinic-note";

// The book read, wrapped: every call is counted, and while `forbid` is set it THROWS.
const book = vi.hoisted(() => ({ calls: 0, forbid: false }));
vi.mock("@/lib/queries/trades", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/trades")>();
  return {
    ...real,
    getClinicTrades: (...args: Parameters<typeof real.getClinicTrades>) => {
      book.calls++;
      if (book.forbid) throw new Error("getClinicTrades() was called on the card path");
      return real.getClinicTrades(...args);
    },
  };
});

let t: TempDb;
let q: typeof import("@/lib/queries/edge-clinic");
let lic: typeof import("@/lib/queries/license");

const A = 1; //   the seeded Primary account: 60 closed trades with a clear edge → a finding
const B = 2; //   a thin book: 5 trades → a report with NO finding, a teaser still counting
const C = 3; //   an account the Clinic never computed → missing
const ALL = 0; // the All-accounts VIEW

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const setFree = (free: boolean) =>
  t.db.update(t.schema.settings).set({ licenseKey: null, trialStartedAt: free ? "2020-01-01T00:00:00.000Z" : new Date().toISOString() }).run();
const rowOf = (scope: string) => t.db.select().from(t.schema.clinicCache).where(eq(t.schema.clinicCache.scopeKey, scope)).get();
const setRow = (scope: string, set: Partial<{ summaryJson: string | null; reportJson: string; engineVersion: string; digest: string }>) =>
  t.db.update(t.schema.clinicCache).set(set).where(eq(t.schema.clinicCache.scopeKey, scope)).run();
const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
/** A deterministic R series, mean ≈ +0.8, never degenerate. */
const rAt = (i: number) => 0.8 + (((i * 37) % 23) - 11) / 20;

function closed(accountId: number, i: number) {
  const r = rAt(i);
  return tradeRow({
    accountId, bucket: "active", segment: "eq_intraday", symbol: `SYM${i % 5}`, tradingsymbol: `SYM${i % 5}`,
    buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 100 + r * 10, side: "long",
    buyDate: dayPlus(i), sellDate: dayPlus(i), isOpen: false,
    grossPnl: r * 100 + 20, chargesTotal: 20, netPnl: r * 100, riskAmount: 100, rMultiple: r, riskSource: "set", setupTag: "S",
  });
}

/** Run a read with the book read forbidden and JSON.parse watched; returns the result and every string parsed. */
function watched<T>(fn: () => T): { out: T; parsed: unknown[]; bookCalls: number } {
  const parse = vi.spyOn(JSON, "parse");
  book.calls = 0;
  book.forbid = true;
  try {
    const out = fn();
    return { out, parsed: parse.mock.calls.map((c) => c[0]), bookCalls: book.calls };
  } finally {
    book.forbid = false;
    parse.mockRestore();
  }
}

// ── The v4.7.0 card, FROZEN (components/edge-clinic/arjun-clinic-card.tsx at 180dd3c, JSX → createElement,
// nothing else changed). It reads a whole ClinicState; it is the oracle the new card's markup is compared with.
const CLINIC_HREF = hubTabHref(hubForHref("/reports/edge-clinic")!, "clinic");
function V470Card({ state }: { state: ClinicState }) {
  const e = React.createElement;
  const first = state.note?.findings[0] ?? null;
  const muted = { className: "text-muted-foreground" };
  return e(
    Card,
    { "data-arjun-clinic": "" } as React.ComponentProps<typeof Card>,
    e(
      CardContent,
      { className: "space-y-2 p-4 text-xs" },
      e(
        "div",
        { className: "flex flex-wrap items-center gap-2" },
        e("span", { className: "font-medium text-foreground" }, "Edge Clinic"),
        first ? e(GradeBadge, { grade: first.grade }) : null,
        first ? e("span", muted, first.label) : null,
      ),
      first
        ? e(ClinicCopyBlock, { verb: first.verb, headline: first.headline, provenanceLine: first.provenanceLine })
        : state.report
          ? e("p", muted, "No finding in your book is past the evidence bar this week.")
          : state.teaser
            ? e("p", muted, state.teaser.headline)
            : e("p", muted, "The Clinic has not read this book yet."),
      e(Link, { href: CLINIC_HREF, className: "text-accent underline-offset-2 hover:underline" }, "Open the Clinic"),
    ),
  );
}
/** What the v4.7.0 card READ of a state — the same four facts, as data. */
function v470Facts(s: ClinicState): ClinicCard {
  const f = s.note?.findings[0] ?? null;
  return {
    hasReport: s.report != null,
    computedAt: s.computedAt,
    finding: f ? { label: f.label, grade: f.grade, verb: f.verb, headline: f.headline, provenanceLine: f.provenanceLine } : null,
    teaser: s.teaser,
  };
}
const oldMarkup = (s: ClinicState) => renderToStaticMarkup(React.createElement(V470Card, { state: s }));
const newMarkup = (card: ClinicCard) => renderToStaticMarkup(React.createElement(ArjunClinicCard, { card }));

// Measured locally 2026-10-05: the hook ≈ 1.7 s — migrate + seed + three engine runs on ≤ 65 trades (≈ 0.6 s) and
// the file's FIRST entitlement read (≈ 1.1 s here; tests/seams-v47-c2 records 335–557 ms for the same first use),
// taken in the hook so no `it` carries it.
beforeAll(async () => {
  t = await openTempDb("clinic-card-summary", { seed: true });
  q = await import("@/lib/queries/edge-clinic");
  lic = await import("@/lib/queries/license");
  t.db.insert(t.schema.accounts).values([{ id: B, name: "Thin book", isDefault: false }, { id: C, name: "Never computed", isDefault: false }]).run();
  t.db.insert(t.schema.trades).values(Array.from({ length: 60 }, (_, i) => closed(A, i))).run();
  t.db.insert(t.schema.trades).values(Array.from({ length: 5 }, (_, i) => closed(B, i + 200))).run();
  setFree(false);
  expect(lic.getEntitlement().pro).toBe(true);
  for (const s of [A, B, ALL]) {
    select(s);
    await q.computeClinic();
  }
  select(A);
});

afterAll(() => t?.cleanup());

describe("migration 0081 — clinic_cache.summary_json", () => {
  it("is registered in the journal right after 0080 as the newest migration, with a matching one-statement .sql file", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const entry = journal.entries.find((x) => x.idx === 81);
    expect(entry?.tag).toBe("0081_clinic-card-summary");
    expect(entry!.when).toBeGreaterThan(journal.entries.find((x) => x.idx === 80)!.when);
    expect(Math.max(...journal.entries.map((x) => x.idx))).toBe(81);
    const sql = fs.readFileSync(path.join(process.cwd(), "drizzle", "0081_clinic-card-summary.sql"), "utf8");
    // /\r?\n/: the Windows CI checkout is CRLF (FAIL-AI) — a bare "\n" split leaves the "\r" on the statement.
    const statements = sql.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("--"));
    expect(statements).toEqual(["ALTER TABLE `clinic_cache` ADD COLUMN `summary_json` text;"]);
  });

  it("adds ONE nullable TEXT column with no default; the table is still keyed by scope, with no account_id, outside the backup", () => {
    const cols = t.sqlite.prepare("PRAGMA table_info(clinic_cache)").all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
    expect(cols.map((c) => c.name)).toEqual(["scope_key", "digest", "engine_version", "report_json", "computed_at", "summary_json"]);
    const c = cols.find((x) => x.name === "summary_json")!;
    expect({ type: c.type.toLowerCase(), notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }).toEqual({ type: "text", notnull: 0, dflt: null, pk: 0 });
    expect(BACKUP_TABLES as readonly string[]).not.toContain("clinic_cache");
    expect(fs.readFileSync(path.join(process.cwd(), "lib", "db", "schema.ts"), "utf8")).toContain('summaryJson: text("summary_json"),');
  });
});

describe("the compute writes the summary next to the report", () => {
  it("summary == derived from the SAME stored report by weeklyNote / teaser; the report is the engine's output unchanged", () => {
    select(A);
    const row = rowOf("acct:1")!;
    const report = JSON.parse(row.reportJson) as ClinicReport;
    const stored = JSON.parse(row.summaryJson!) as ClinicCardSummary;
    const first = weeklyNote(report, []).findings[0];
    expect(first, "the seeded book must produce a finding, or this case pins nothing").toBeDefined();
    expect(stored).toEqual(clinicCardSummary(report, row.computedAt));
    expect(stored.finding).toEqual({ label: first.label, grade: first.grade, verb: first.verb, headline: first.headline, provenanceLine: first.provenanceLine });
    expect(stored.teaser).toEqual(teaser(report));
    expect(stored).toMatchObject({ v: 1, engineVersion: ENGINE_VERSION, computedAt: row.computedAt, hasReport: true });
    // Exactly what the card prints — no cell, no experiment, nothing else rides along.
    expect(Object.keys(stored).sort()).toEqual(["computedAt", "engineVersion", "finding", "hasReport", "teaser", "v"]);
    expect(Object.keys(stored.finding!).sort()).toEqual(["grade", "headline", "label", "provenanceLine", "verb"]);
    expect(parseClinicCardSummary(row.summaryJson)).toEqual(stored);
    // A few hundred bytes next to the report it summarises.
    expect(Buffer.byteLength(row.summaryJson!)).toBeLessThan(2048);
    expect(row.reportJson.length).toBeGreaterThan(20 * row.summaryJson!.length);
    // The report is a sibling, not a container: it is exactly what the engine returns for this input.
    const ins = q.clinicInputs();
    expect(ins.digest).toBe(row.digest);
    expect(row.reportJson).toBe(JSON.stringify(edgeClinic(ins.trades, ins.opts)));
    expect(row.engineVersion).toBe("c4.0");
  });

  it("a thin book stores a summary with NO finding and the teaser; the All view stores its own", () => {
    const thin = JSON.parse(rowOf("acct:2")!.summaryJson!) as ClinicCardSummary;
    expect(thin.finding).toBeNull();
    expect(thin.teaser).toMatchObject({ closedTrades: 5 });
    expect(thin.teaser!.tradesStillNeeded).toBeGreaterThan(0);
    const all = JSON.parse(rowOf("acct:0")!.summaryJson!) as ClinicCardSummary;
    expect(all.teaser).toMatchObject({ closedTrades: 65 });
  });

  it("a FRESH row with no summary (cached before 0081) gets one from the next compute — the report, digest and computedAt untouched", async () => {
    select(A);
    const row = rowOf("acct:1")!;
    try {
      for (const legacy of [null, JSON.stringify({ ...JSON.parse(row.summaryJson!), computedAt: "2020-01-01T00:00:00.000Z" })]) {
        setRow("acct:1", { summaryJson: legacy });
        expect((await q.computeClinic()).status).toBe("fresh"); // the digest holds: the engine does not run
        expect(rowOf("acct:1")).toEqual(row); // the summary is back, byte for byte, and nothing else moved
      }
    } finally {
      setRow("acct:1", { summaryJson: row.summaryJson }); // a red here must not redden the cases below
    }
  });

  it("a RE-compute (the upsert) replaces the summary with its own report's", async () => {
    select(B);
    const before = rowOf("acct:2")!;
    // A row whose digest no longer matches, carrying a summary that is not its report's.
    setRow("acct:2", { digest: "not-the-input", summaryJson: JSON.stringify({ ...JSON.parse(before.summaryJson!), teaser: null }) });
    expect((await q.computeClinic()).status).toBe("computed");
    const after = rowOf("acct:2")!;
    expect(JSON.parse(after.summaryJson!)).toEqual(clinicCardSummary(JSON.parse(after.reportJson) as ClinicReport, after.computedAt));
    expect((JSON.parse(after.summaryJson!) as ClinicCardSummary).teaser).not.toBeNull();
    select(A);
  });
});

describe("the card path — one small row, no book read, no report parse", () => {
  it("with a summary: getClinicTrades is never called, report_json is never parsed, and a corrupted report goes unnoticed", () => {
    select(A);
    const row = rowOf("acct:1")!;
    const want = q.getClinicCard();
    expect(want.finding).not.toBeNull();
    const w = watched(() => q.getClinicCard());
    expect(w.out).toEqual(want);
    expect(w.bookCalls).toBe(0);
    expect(w.parsed.includes(row.reportJson), "report_json was parsed on the card path").toBe(false);
    expect(w.parsed).toContain(row.summaryJson);
    // The stub does throw when the book IS read — the v4.7.0 path trips it (a spy that cannot fire proves nothing).
    book.forbid = true;
    try {
      expect(() => q.getClinicState()).toThrow(/getClinicTrades\(\) was called/);
    } finally {
      book.forbid = false;
    }
    // …and the card does not depend on the report at all while a summary stands.
    setRow("acct:1", { reportJson: "{ not json" });
    try {
      expect(watched(() => q.getClinicCard()).out).toEqual(want);
    } finally {
      setRow("acct:1", { reportJson: row.reportJson });
    }
  });

  it("is scoped by the selected account (invariant 8): each scope reads its own row, the All view reads acct:0", () => {
    const closedOf = (id: number) => {
      select(id);
      return watched(() => q.getClinicCard()).out.teaser?.closedTrades ?? null;
    };
    expect([closedOf(A), closedOf(B), closedOf(ALL), closedOf(C)]).toEqual([60, 5, 65, null]);
    select(C);
    expect(q.getClinicCard()).toEqual(CLINIC_CARD_MISSING);
    select(A);
  });

  it("a row from another ENGINE_VERSION is never read — missing, summary or not", () => {
    select(A);
    const row = rowOf("acct:1")!;
    setRow("acct:1", { engineVersion: "c3.0" });
    try {
      expect(q.getClinicCard()).toEqual(CLINIC_CARD_MISSING);
      expect(q.getClinicState().status).toBe("missing"); // the same rule readCache applies
    } finally {
      setRow("acct:1", { engineVersion: row.engineVersion });
    }
    expect(q.getClinicCard().finding).not.toBeNull();
  });
});

describe("the card is the v4.7.0 card — same facts, byte-identical markup, same free cut", () => {
  const SCOPES: [string, number][] = [
    ["a book with a finding", A],
    ["a thin book (report, no finding)", B],
    ["the All view", ALL],
    ["a scope never computed (missing)", C],
  ];

  it.each(SCOPES)("%s — Pro and free", (_label, scope) => {
    select(scope);
    for (const pro of [true, false]) {
      const old = clinicStateFor(q.getClinicState(), pro);
      const card = clinicCardFor(q.getClinicCard(), pro);
      expect(card, `pro=${pro}`).toEqual(v470Facts(old));
      expect(newMarkup(card), `pro=${pro}`).toBe(oldMarkup(old));
    }
    select(A);
  });

  it("the three branches are really exercised: a finding, 'no finding this week', 'has not read this book yet'", () => {
    select(A);
    const a = newMarkup(clinicCardFor(q.getClinicCard(), true));
    expect(a).toContain(q.getClinicCard().finding!.headline.slice(0, 12));
    expect(a).toContain("data-grade=");
    select(B);
    expect(newMarkup(clinicCardFor(q.getClinicCard(), true))).toContain("No finding in your book is past the evidence bar this week.");
    select(C);
    expect(newMarkup(clinicCardFor(q.getClinicCard(), true))).toContain("The Clinic has not read this book yet.");
    select(A);
  });

  it("FREE through the real entitlement: no finding and no report flag cross; the teaser does (seam D3 holds)", () => {
    select(B); // the thin book: Pro reads "No finding … this week", a free copy must read the teaser instead
    const proCard = clinicCardFor(q.getClinicCard(), lic.getEntitlement().pro);
    expect(proCard.hasReport).toBe(true);
    select(A);
    const pro = clinicCardFor(q.getClinicCard(), lic.getEntitlement().pro);
    expect(pro.finding).not.toBeNull();
    setFree(true);
    try {
      expect(lic.getEntitlement().pro).toBe(false);
      const free = clinicCardFor(q.getClinicCard(), lic.getEntitlement().pro);
      expect({ hasReport: free.hasReport, finding: free.finding }).toEqual({ hasReport: false, finding: null });
      expect(free.teaser).toEqual(pro.teaser);
      expect(free.teaser).not.toBeNull();
      const wire = JSON.stringify(free);
      expect(wire).not.toContain('"verb"');
      expect(wire).not.toContain(JSON.stringify(pro.finding!.label));
      const markup = newMarkup(free);
      expect(markup).toBe(oldMarkup(clinicStateFor(q.getClinicState(), false)));
      expect(markup).not.toContain("has not read this book");
      expect(markup).not.toContain("data-grade=");
      expect(markup).toContain(renderToStaticMarkup(React.createElement("p", { className: "text-muted-foreground" }, free.teaser!.headline)));
      select(B);
      const freeThin = newMarkup(clinicCardFor(q.getClinicCard(), lic.getEntitlement().pro));
      expect(freeThin).not.toContain("No finding in your book");
      expect(freeThin).toBe(oldMarkup(clinicStateFor(q.getClinicState(), false)));
    } finally {
      setFree(false);
      select(A);
    }
  });

  it("a STALE cache and an OPEN experiment on the finding's cell change nothing the card prints", () => {
    select(A);
    const fresh = newMarkup(clinicCardFor(q.getClinicCard(), true));
    // An experiment moves only `finding.experiment` on the v4.7.0 note — which the card never printed.
    const started = q.startExperiment("eq_intraday|setup:S");
    expect(started.ok, JSON.stringify(started)).toBe(true);
    // A new trade makes the cached report stale; both paths still show it.
    const ins = t.db.insert(t.schema.trades).values(closed(A, 999)).returning({ id: t.schema.trades.id }).get()!;
    try {
      const old = clinicStateFor(q.getClinicState(), true);
      expect(old.status).toBe("stale");
      expect(old.experiments.some((x) => x.status === "open")).toBe(true);
      const card = clinicCardFor(q.getClinicCard(), true);
      expect(card).toEqual(v470Facts(old));
      expect(newMarkup(card)).toBe(oldMarkup(old));
      expect(newMarkup(card)).toBe(fresh);
    } finally {
      t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, ins.id)).run();
      if (started.ok) q.abandonExperiment(started.experiment.id);
    }
    expect(q.getClinicState().status).toBe("fresh");
  });
});

describe("a summary that is absent, or not its report's — fall back to the report, never blank, never a write", () => {
  it("summary NULL (a row cached before 0081): the card is derived from report_json on that read, and the row is left as it was", () => {
    select(A);
    const row = rowOf("acct:1")!;
    const want = q.getClinicCard();
    setRow("acct:1", { summaryJson: null });
    try {
      const legacy = rowOf("acct:1")!;
      const w = watched(() => q.getClinicCard());
      expect(w.out).toEqual(want);
      expect(w.out.finding).not.toBeNull();
      expect(w.bookCalls).toBe(0); // the fallback parses the report; it still does not re-read the book
      expect(w.parsed.filter((p) => p === row.reportJson), "the report is parsed exactly once per read").toHaveLength(1);
      expect(rowOf("acct:1")).toEqual(legacy); // no write on a read path: summary_json is still NULL
      expect(rowOf("acct:1")!.summaryJson).toBeNull();
      for (const pro of [true, false]) {
        expect(newMarkup(clinicCardFor(q.getClinicCard(), pro))).toBe(oldMarkup(clinicStateFor(q.getClinicState(), pro)));
      }
    } finally {
      setRow("acct:1", { summaryJson: row.summaryJson });
    }
  });

  const WRONG = "WRONG-REPORT-MARKER-5e1c";
  const tampered = (row: { summaryJson: string | null }, over: Record<string, unknown>) => {
    const s = JSON.parse(row.summaryJson!) as ClinicCardSummary;
    return JSON.stringify({ ...s, finding: { ...s.finding!, headline: WRONG }, ...over });
  };
  it.each<[string, (row: { summaryJson: string | null }) => string]>([
    ["unreadable JSON", () => `{ ${WRONG}`],
    ["another envelope version", (row) => tampered(row, { v: 2 })],
    ["another engine version inside the summary", (row) => tampered(row, { engineVersion: "c3.0" })],
    ["a computedAt that is not its sibling report's (a summary left by an older write)", (row) => tampered(row, { computedAt: "2020-01-01T00:00:00.000Z" })],
    ["a finding that is not the card's shape", (row) => tampered(row, { finding: { headline: WRONG } })],
    ["a JSON value that is not an object", () => JSON.stringify(WRONG)],
  ])("%s → the report's own card", (_label, make) => {
    select(A);
    const row = rowOf("acct:1")!;
    const want = q.getClinicCard();
    setRow("acct:1", { summaryJson: make(row) });
    try {
      const card = q.getClinicCard();
      expect(JSON.stringify(card)).not.toContain(WRONG);
      expect(card).toEqual(want);
    } finally {
      setRow("acct:1", { summaryJson: row.summaryJson });
    }
  });

  it("the tampering above WOULD show: a well-formed summary of this report is believed as stored", () => {
    select(A);
    const row = rowOf("acct:1")!;
    setRow("acct:1", { summaryJson: tampered(row, {}) });
    try {
      expect(q.getClinicCard().finding!.headline).toBe(WRONG);
    } finally {
      setRow("acct:1", { summaryJson: row.summaryJson });
    }
  });
});
