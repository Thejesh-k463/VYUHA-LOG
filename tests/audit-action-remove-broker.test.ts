import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditInput } from "@/lib/audit";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * `"import.remove-broker"` is a member of the audit action union.
 *
 * lib/trash.ts wrote it through an `as unknown as AuditInput["action"]` cast
 * until lib/audit.ts admitted the literal (2026-09-04). The `satisfies` below
 * is the compile-time half of the proof — `npm run typecheck` reddens if the
 * literal leaves the union — and the write below is the runtime half: the row
 * lands with the action verbatim.
 */

const ACTION = "import.remove-broker" satisfies AuditInput["action"];

let t: TempDb;
let audit: typeof import("@/lib/audit");

beforeAll(async () => {
  t = await openTempDb("audit-remove-broker", { seed: true });
  audit = await import("@/lib/audit");
});
afterAll(() => t?.cleanup());

describe("import.remove-broker", () => {
  it("is an admitted audit action and is written verbatim", () => {
    audit.recordAudit({ entity: "trade", entityId: null, action: ACTION, summary: "removed dhan from account 1", source: "test" });
    const rows = t.db.select().from(t.schema.auditLog).all();
    expect(rows.map((r) => r.action)).toContain("import.remove-broker");
  });
});
