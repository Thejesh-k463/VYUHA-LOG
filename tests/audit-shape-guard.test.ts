import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v3.8 — the recordAudit KEY-SET guard (owner ruling 2026-09-04).
 *
 * tests/audit-snapshot-integrity.test.ts pins three call sites whose
 * before/after snapshots described different columns, so the audit screen
 * reported clears that never happened. v3.7 found that class had survived
 * FOUR fixes — each fix hand-assembled one side. This is the structural
 * version: `recordAudit` itself refuses the shape outside production (a typed
 * `AuditShapeError` naming the action and the odd keys), and in production
 * warns and still records, because a mutation must never lose its trail over
 * a logging defect.
 *
 * One temp database per FILE (tests/helpers/temp-db.ts).
 */

let t: TempDb;
let audit: typeof import("@/lib/audit");

beforeAll(async () => {
  t = await openTempDb("audit-shape");
  audit = await import("@/lib/audit");
});

afterAll(() => t?.cleanup());

const rows = () => t.db.select().from(t.schema.auditLog).all();

describe("recordAudit key-set guard", () => {
  it("records a symmetric before/after, key order ignored", () => {
    const n = rows().length;
    audit.recordAudit({
      entity: "trade",
      entityId: 1,
      action: "update",
      before: { a: 1, b: null },
      after: { b: 2, a: 1 },
    });
    expect(rows()).toHaveLength(n + 1);
  });

  it("before: null (a create) and after: null (a delete) stay legal", () => {
    const n = rows().length;
    audit.recordAudit({ entity: "ledger", entityId: 2, action: "create", before: null, after: { x: 1 } });
    audit.recordAudit({ entity: "ledger", entityId: 3, action: "delete", before: { x: 1, y: 2 }, after: null });
    audit.recordAudit({ entity: "ledger", entityId: 4, action: "create", after: { x: 1 } });
    expect(rows()).toHaveLength(n + 3);
  });

  it("THROWS a typed AuditShapeError on an asymmetric pair outside production, and records nothing", () => {
    const n = rows().length;
    let caught: unknown;
    try {
      audit.recordAudit({
        entity: "weekly_review",
        entityId: 5,
        action: "update",
        before: { id: 5, note: "kept", completedAt: "x" },
        after: { note: "kept + appended", appended: true },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(audit.AuditShapeError);
    const err = caught as InstanceType<typeof audit.AuditShapeError>;
    expect(err.entity).toBe("weekly_review");
    expect(err.action).toBe("update");
    expect(err.onlyBefore).toEqual(["completedAt", "id"]);
    expect(err.onlyAfter).toEqual(["appended"]);
    expect(err.message).toMatch(/weekly_review\/update/);
    expect(err.message).toMatch(/completedAt, id/);
    // The throw happens BEFORE the best-effort insert, so no half-truth lands.
    expect(rows()).toHaveLength(n);
  });

  it("recordAuditMany checks every entry, not just the first", () => {
    expect(() =>
      audit.recordAuditMany([
        { entity: "trade", entityId: 1, action: "update", before: { a: 1 }, after: { a: 2 } },
        { entity: "trade", entityId: 2, action: "update", before: { a: 1 }, after: { b: 2 } },
      ]),
    ).toThrow(audit.AuditShapeError);
  });

  it("in production it WARNS and still records the entry", () => {
    const n = rows().length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warned: string[] = [];
    try {
      vi.stubEnv("NODE_ENV", "production");
      audit.recordAudit({ entity: "trade", entityId: 6, action: "update", before: { a: 1 }, after: { b: 1 } });
      warned = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore(); // also resets the call log — hence the copy above
    }
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/trade\/update/);
    expect(rows()).toHaveLength(n + 1);
  });
});
