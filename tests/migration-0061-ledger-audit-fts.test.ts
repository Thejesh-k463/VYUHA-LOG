import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Migration 0061 — `ledger_fts` and `audit_fts` (FTS5, external content,
 * trigram) kept in step with `ledger_entries` / `audit_log` by triggers.
 *
 * Rows go in through the ordinary Drizzle insert/update/delete path — the same
 * path the ledger screen and `recordAudit` use — so what is asserted here is
 * what the app will see. One temp database per FILE.
 */

const migrationsDir = path.join(process.cwd(), "drizzle");
let t: TempDb;

const searchLedger = (q: string) =>
  (t.sqlite.prepare("SELECT rowid AS id FROM ledger_fts WHERE ledger_fts MATCH ? ORDER BY rowid").all(q) as { id: number }[]).map((r) => r.id);
const searchAudit = (q: string) =>
  (t.sqlite.prepare("SELECT rowid AS id FROM audit_fts WHERE audit_fts MATCH ? ORDER BY rowid").all(q) as { id: number }[]).map((r) => r.id);

const addLedger = (over: Record<string, unknown> = {}) =>
  t.db.insert(t.schema.ledgerEntries)
    .values({ accountId: 1, date: "2026-07-01", type: "deposit", bucket: "equity", amountPaise: 100, ...over })
    .returning({ id: t.schema.ledgerEntries.id }).get()!.id;

const addAudit = (over: Record<string, unknown> = {}) =>
  t.db.insert(t.schema.auditLog)
    .values({ entity: "trade", action: "create", summary: "created", ts: "2026-07-01T09:15:00", ...over })
    .returning({ id: t.schema.auditLog.id }).get()!.id;

beforeAll(async () => {
  t = await openTempDb("m0061", { seed: true });
});

afterAll(() => t?.cleanup());

describe("migration 0061 applies", () => {
  it("is journalled — a hand-written migration with no entry is silently skipped", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; version: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.tag === "0061_ledger-audit-fts");
    expect(entry, "0061 is not in _journal.json — nothing would apply it").toBeTruthy();
    expect(entry!.idx).toBe(61);
    expect(entry!.version).toBe("6");
    expect(entry!.breakpoints).toBe(true);
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it("creates both virtual tables, both content views and all eight triggers", () => {
    const objects = t.sqlite
      .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'ledger_fts%' OR name LIKE 'audit_fts%' ORDER BY name")
      .all() as { type: string; name: string }[];
    const byName = Object.fromEntries(objects.map((o) => [o.name, o.type]));
    for (const base of ["ledger_fts", "audit_fts"]) {
      expect(byName[base], base).toBe("table");
      expect(byName[`${base}_src`], `${base}_src`).toBe("view");
      for (const suffix of ["ai", "au", "bd", "bu"]) expect(byName[`${base}_${suffix}`], `${base}_${suffix}`).toBe("trigger");
    }
  });

  it("ends with a rebuild per index, and every trigger is its own breakpoint chunk", () => {
    const sql = fs.readFileSync(path.join(migrationsDir, "0061_ledger-audit-fts.sql"), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((s) => s.trim());
    expect(statements.at(-2)).toMatch(/^INSERT INTO `ledger_fts`\(`ledger_fts`\) VALUES \('rebuild'\);$/);
    expect(statements.at(-1)).toMatch(/^INSERT INTO `audit_fts`\(`audit_fts`\) VALUES \('rebuild'\);$/);
    // Drizzle hands each chunk to better-sqlite3's prepare(), which takes ONE
    // statement — a BEGIN…END trigger body is one statement, two in a chunk is
    // an error.
    const triggerChunks = statements.filter((s) => /CREATE TRIGGER/.test(s));
    expect(triggerChunks).toHaveLength(8);
    for (const c of triggerChunks) expect(c.match(/CREATE TRIGGER/g)).toHaveLength(1);
  });

  it("says in its own header that audit_log carries no account_id", () => {
    const sql = fs.readFileSync(path.join(migrationsDir, "0061_ledger-audit-fts.sql"), "utf8");
    expect(sql).toMatch(/`audit_log` HAS NO account_id COLUMN/);
    const cols = (t.sqlite.prepare("PRAGMA table_info('audit_log')").all() as { name: string }[]).map((c) => c.name);
    expect(cols, "if audit_log ever gains account_id, audit_fts must gain it too").not.toContain("account_id");
  });
});

describe("ledger_fts follows the Drizzle write path", () => {
  it("a mid-word trigram finds a freshly inserted note", () => {
    const id = addLedger({ note: "quarterly dividend payout" });
    expect(searchLedger("vidend")).toEqual([id]);
    expect(searchLedger("payout")).toEqual([id]);
  });

  it("an update drops the old term and indexes the new one", () => {
    const id = addLedger({ note: "pledge charge" });
    expect(searchLedger("pledge")).toEqual([id]);
    t.db.update(t.schema.ledgerEntries).set({ note: "dp charge" }).where(eq(t.schema.ledgerEntries.id, id)).run();
    expect(searchLedger("pledge")).toEqual([]);
    expect(searchLedger('"dp charge"')).toEqual([id]);
  });

  it("a delete removes the row from the index", () => {
    const id = addLedger({ note: "interest reversal" });
    expect(searchLedger("reversal")).toEqual([id]);
    t.db.delete(t.schema.ledgerEntries).where(eq(t.schema.ledgerEntries.id, id)).run();
    expect(searchLedger("reversal")).toEqual([]);
  });

  it("indexes symbol, type, bucket and date", () => {
    const id = addLedger({ symbol: "RELIANCE", type: "dividend_tds", bucket: "equity", date: "2026-11-23", note: "" });
    expect(searchLedger("relian")).toEqual([id]);
    expect(searchLedger('"dividend_tds"')).toEqual([id]);
    expect(searchLedger('"2026-11-23"')).toEqual([id]);
  });

  it("is scoped by joining the match back to ledger_entries — the index itself is not account-scoped", () => {
    // A three-digit id on purpose: the trigram tokenizer needs three
    // characters, so "234" is a term the index COULD carry if account_id were
    // one of its columns — the last assertion proves it is not.
    t.db.insert(t.schema.accounts).values({ id: 234, name: "Swing", isDefault: false }).onConflictDoNothing().run();
    const mine = addLedger({ accountId: 1, note: "scopedterm alpha" });
    const theirs = addLedger({ accountId: 234, note: "scopedterm beta" });
    expect(searchLedger("scopedterm"), "unscoped, the index answers for both books").toEqual([mine, theirs]);
    const scoped = (t.sqlite
      .prepare(
        `SELECT l.id AS id FROM ledger_fts f JOIN ledger_entries l ON l.id = f.rowid
         WHERE ledger_fts MATCH ? AND (? = 0 OR l.account_id = ?) ORDER BY l.id`,
      )
      .all("scopedterm", 234, 234) as { id: number }[]).map((r) => r.id);
    expect(scoped).toEqual([theirs]);
    expect(searchLedger("234"), "an account number must never be a searchable term").toEqual([]);
    // The VIEW carries account_id so any reader has it; the virtual table does
    // NOT, so an FTS index never enters the account-scoped-table registry.
    const viewCols = (t.sqlite.prepare("PRAGMA table_info('ledger_fts_src')").all() as { name: string }[]).map((c) => c.name);
    expect(viewCols).toContain("account_id");
    const ftsCols = (t.sqlite.prepare("PRAGMA table_info('ledger_fts')").all() as { name: string }[]).map((c) => c.name);
    expect(ftsCols).not.toContain("account_id");
  });
});

describe("audit_fts follows the Drizzle write path", () => {
  it("a mid-word trigram finds a freshly inserted summary", () => {
    const id = addAudit({ summary: "closed RELIANCE at 2810" });
    expect(searchAudit("elianc")).toEqual([id]);
  });

  it("indexes action, entity and ts", () => {
    const id = addAudit({ entity: "charge_config", action: "override", summary: "", ts: "2026-12-05T10:00:00" });
    expect(searchAudit("charge_config")).toEqual([id]);
    expect(searchAudit("override")).toEqual([id]);
    expect(searchAudit('"2026-12-05"')).toEqual([id]);
  });

  it("an update drops the old term and a delete removes the row — audit_log is append-only, but a broken index is worse than none", () => {
    const id = addAudit({ summary: "provisional wording" });
    expect(searchAudit("provisional")).toEqual([id]);
    t.db.update(t.schema.auditLog).set({ summary: "final wording" }).where(eq(t.schema.auditLog.id, id)).run();
    expect(searchAudit("provisional")).toEqual([]);
    expect(searchAudit("final")).toEqual([id]);
    t.db.delete(t.schema.auditLog).where(eq(t.schema.auditLog.id, id)).run();
    expect(searchAudit("final")).toEqual([]);
  });
});

describe("rebuild is symmetric with the triggers", () => {
  it("a rebuild reproduces exactly what the triggers wrote", () => {
    const before = { ledger: searchLedger("charge"), audit: searchAudit("create") };
    t.sqlite.prepare("INSERT INTO ledger_fts(ledger_fts) VALUES ('rebuild')").run();
    t.sqlite.prepare("INSERT INTO audit_fts(audit_fts) VALUES ('rebuild')").run();
    expect(searchLedger("charge")).toEqual(before.ledger);
    expect(searchAudit("create")).toEqual(before.audit);
  });

  it("both indexes pass FTS5's own integrity check after all of the above", () => {
    expect(() => t.sqlite.prepare("INSERT INTO ledger_fts(ledger_fts) VALUES ('integrity-check')").run()).not.toThrow();
    expect(() => t.sqlite.prepare("INSERT INTO audit_fts(audit_fts) VALUES ('integrity-check')").run()).not.toThrow();
  });
});
