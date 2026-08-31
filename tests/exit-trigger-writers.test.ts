import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// Pure module — safe to import statically without binding lib/db first.
import { EXIT_TRIGGERS } from "@/lib/analytics/exit-behaviour";

/**
 * U3 — `exit_trigger` finally has writers. Until v3.5.0 the column (migration
 * 0051) existed, `exitTriggers()` in lib/analytics/exit-behaviour.ts analysed
 * it, and NOTHING wrote it — 100% null on every book. These tests pin the two
 * write paths (the journal route and updateManualTrade behind the edit-trade
 * dialog) and the schema's contract: free text is allowed, and blank means
 * UNANSWERED — the empty string is never stored as a value.
 */

let t: TempDb;
let tradeId: number;

async function postJournal(body: Record<string, unknown>) {
  const route = await import("@/app/api/trades/journal/route");
  const req = new Request("http://localhost/api/trades/journal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // revalidatePath may throw outside a request scope — the update has already
  // happened by then; assertions read the database directly.
  await route.POST(req).catch(() => null);
}

beforeAll(async () => {
  t = await openTempDb("exit-trigger", { seed: true });
  const row = t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-08-01",
        sellQty: 10, avgSellPrice: 110, sellValue: 1100, sellDate: "2026-08-05",
        isOpen: false, grossPnl: 100, netPnl: 95,
      }) as typeof t.schema.trades.$inferInsert,
    )
    .returning({ id: t.schema.trades.id })
    .get();
  tradeId = row.id;
});

afterAll(() => t?.cleanup());

const readTrigger = () =>
  (t.sqlite.prepare("SELECT exit_trigger AS v FROM trades WHERE id = ?").get(tradeId) as { v: string | null }).v;

describe("journal route persists exit_trigger", () => {
  it("accepts a trigger from the curated list", async () => {
    await postJournal({ id: tradeId, exitTrigger: EXIT_TRIGGERS[0] });
    expect(readTrigger()).toBe(EXIT_TRIGGERS[0]);
  });

  it("accepts free text, trimmed — the list is a convenience, not a validation set", async () => {
    await postJournal({ id: tradeId, exitTrigger: "  held past my plan  " });
    expect(readTrigger()).toBe("held past my plan");
  });

  it("blank means unanswered — stored as NULL, never as an empty string", async () => {
    await postJournal({ id: tradeId, exitTrigger: "target hit" });
    expect(readTrigger()).toBe("target hit");
    await postJournal({ id: tradeId, exitTrigger: "   " });
    expect(readTrigger()).toBeNull();
    await postJournal({ id: tradeId, exitTrigger: "panic" });
    await postJournal({ id: tradeId }); // field omitted entirely
    expect(readTrigger()).toBeNull();
    // The invariant the analytics rely on: "" is never a value in the column.
    const blanks = t.sqlite.prepare("SELECT COUNT(*) AS n FROM trades WHERE exit_trigger = ''").get() as { n: number };
    expect(blanks.n).toBe(0);
  });

  it("rejects non-string shapes rather than coercing them", async () => {
    await postJournal({ id: tradeId, exitTrigger: "expiry" });
    await postJournal({ id: tradeId, exitTrigger: 42 });
    expect(readTrigger()).toBeNull();
  });
});

describe("updateManualTrade (edit-trade dialog path) carries exit_trigger", () => {
  it("writes, preserves when omitted, and clears on null", async () => {
    const { updateManualTrade } = await import("@/lib/import/commit");

    expect(updateManualTrade(tradeId, { exitTrigger: "stop hit" }).ok).toBe(true);
    expect(readTrigger()).toBe("stop hit");

    // An edit that never touches the field must not erase the answer.
    expect(updateManualTrade(tradeId, { notes: "unrelated edit" }).ok).toBe(true);
    expect(readTrigger()).toBe("stop hit");

    // Blank in the form arrives as null (str() in app/trades/actions.ts) and
    // clears — back to unanswered, matching the dialog's blank-means-clear rule.
    expect(updateManualTrade(tradeId, { exitTrigger: null }).ok).toBe(true);
    expect(readTrigger()).toBeNull();
  });
});

describe("source guard — both trade writers offer the field", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  it("the shared field offers the curated EXIT_TRIGGERS list plus free text", () => {
    const src = read("components/trades/exit-trigger-field.tsx");
    expect(src).toMatch(/EXIT_TRIGGERS/);
    expect(src).toMatch(/@\/lib\/analytics\/exit-behaviour/);
  });

  it("the edit-trade dialog and the journal dialog both render it", () => {
    const editDialog = read("components/trades/edit-trade-dialog.tsx");
    const journalDialog = read("components/behavior/journal-dialog.tsx");
    expect(editDialog).toMatch(/ExitTriggerField/);
    expect(journalDialog).toMatch(/ExitTriggerField/);
  });

  it("both write paths actually submit it", () => {
    expect(read("app/trades/actions.ts")).toMatch(/exitTrigger: str\(formData\.get\("exitTrigger"\)\)/);
    expect(read("app/api/trades/journal/route.ts")).toMatch(/body\.exitTrigger/);
    expect(read("components/behavior/journal-dialog.tsx")).toMatch(/exitTrigger: exitTrigger\.trim\(\) \|\| null/);
  });
});
