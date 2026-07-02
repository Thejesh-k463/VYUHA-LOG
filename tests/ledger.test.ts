import { describe, it, expect } from "vitest";
import { summariseLedger, type LedgerEntryInput, type LedgerType } from "@/lib/analytics/ledger";
import { toPaise } from "@/lib/money";

const e = (id: number, date: string, bucket: string, type: LedgerType, rupees: number): LedgerEntryInput => ({
  id, date, bucket, type, amountPaise: toPaise(rupees),
});

describe("summariseLedger", () => {
  const opening = { equity: toPaise(1300000), active: toPaise(400000) };
  const entries: LedgerEntryInput[] = [
    e(1, "2026-06-20", "equity", "deposit", 50000),
    e(2, "2026-06-22", "equity", "withdrawal", -20000),
    e(3, "2026-06-23", "active", "charge", -1500),
    e(4, "2026-06-24", "active", "realised_pnl", 8000),
    e(5, "2026-06-25", "active", "mtf_interest", -500),
    e(6, "2026-06-26", "active", "margin_penalty", -300),
  ];
  const s = summariseLedger(entries, opening);

  it("derives available capital = opening + Σ flows per bucket", () => {
    const eq = s.buckets.find((b) => b.bucket === "equity")!;
    const ac = s.buckets.find((b) => b.bucket === "active")!;
    expect(eq.availablePaise).toBe(toPaise(1300000 + 50000 - 20000)); // 13.3L
    expect(eq.flowsPaise).toBe(toPaise(30000));
    expect(ac.availablePaise).toBe(toPaise(400000 - 1500 + 8000 - 500 - 300)); // 4,05,700
    expect(ac.chargesPaise).toBe(toPaise(-2300)); // charge + mtf interest + margin penalty (IND-9)
    expect(ac.realisedPnlPaise).toBe(toPaise(8000));
  });

  it("totals across buckets", () => {
    expect(s.totalOpeningPaise).toBe(toPaise(1700000));
    expect(s.totalFlowsPaise).toBe(toPaise(50000 - 20000 - 1500 + 8000 - 500 - 300));
    expect(s.totalAvailablePaise).toBe(s.totalOpeningPaise + s.totalFlowsPaise);
  });

  it("breaks down by type", () => {
    expect(s.byType.deposit).toBe(toPaise(50000));
    expect(s.byType.withdrawal).toBe(toPaise(-20000));
    expect(s.byType.mtf_interest).toBe(toPaise(-500));
    expect(s.byType.margin_penalty).toBe(toPaise(-300));
  });

  it("computes a chronological running balance per bucket", () => {
    expect(s.running[0]).toMatchObject({ id: 1, balancePaise: toPaise(1350000) });
    expect(s.running[1]).toMatchObject({ id: 2, balancePaise: toPaise(1330000) });
    // active bucket runs independently
    const activeRows = s.running.filter((r) => r.bucket === "active");
    expect(activeRows[activeRows.length - 1].balancePaise).toBe(toPaise(405700));
  });

  it("handles an empty ledger (available = opening)", () => {
    const z = summariseLedger([], opening);
    expect(z.totalAvailablePaise).toBe(toPaise(1700000));
    expect(z.running).toEqual([]);
  });
});
