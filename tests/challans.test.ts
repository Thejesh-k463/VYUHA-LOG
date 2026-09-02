import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * WS4 — advance_tax_challans (the dated advance-tax payment ledger) against a
 * real migrated temp DB, which also proves migration 0058 applies cleanly
 * (openTempDb runs the whole drizzle folder).
 *
 * Mirrors tests/bf-losses.test.ts group for group, because the modules are
 * siblings: writes + the refuse-don't-default rules (invariant 6) and the
 * aggregate-view write ban (invariant 9), the account boundary (invariant 8),
 * paise-at-rest / rupees-at-runtime (invariant 1), the payments list handed to
 * the engine, duplicates allowed but detected, and the route's 400/403 mapping.
 *
 * The adversarial probe is the 31-March cliff: s.408(3) makes anything paid BY
 * 31 March advance tax and anything after it self-assessment tax. Accepting a
 * post-March payment under the FY it was computed for would credit an
 * instalment ladder that had already closed and understate s.425 interest,
 * with nothing on screen looking wrong.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let ch: typeof import("@/lib/queries/challans");
let route: typeof import("@/app/api/challans/route");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function req(body: unknown): Request {
  return new Request("http://local/api/challans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** amount_paise straight out of SQLite — the 100× guard reads this, not the ORM. */
function rawPaise(id: number): number {
  return (t.sqlite.prepare("select amount_paise as p from advance_tax_challans where id = ?").get(id) as { p: number }).p;
}

const pad = (n: number) => String(n).padStart(2, "0");
/**
 * Offsets from TODAY IN INDIA — the same clock `todayIstIso()` validates against.
 * Local parts would put this test one day away from the code under test on any
 * box that is not on IST, which is the whole defect being pinned here.
 */
const daysFromNow = (n: number) => {
  const [y, m, d] = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** FY label of an ISO date under the April-start convention the seed uses. */
const fyOf = (s: string) => {
  const y = Number(s.slice(0, 4));
  const start = Number(s.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${pad((start + 1) % 100)}`;
};

beforeAll(async () => {
  t = await openTempDb("challans", { seed: true });
  ch = await import("@/lib/queries/challans");
  route = await import("@/app/api/challans/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("writes (invariants 6/9)", () => {
  it("records a challan against the selected account, receipt fields and all", () => {
    selectAccount(PRIMARY);
    const res = ch.upsertChallan({
      fy: "2024-25",
      paidOn: "2024-06-14",
      amount: 25000,
      bsrCode: "0510308",
      challanSerial: "02145",
      note: "  Q1 instalment  ",
    });
    expect(res.ok).toBe(true);
    const row = ch.getChallans("2024-25")[0];
    expect(row.accountId).toBe(PRIMARY);
    expect(row.paidOn).toBe("2024-06-14");
    expect(row.bsrCode).toBe("0510308");
    expect(row.challanSerial).toBe("02145");
    expect(row.note).toBe("Q1 instalment"); // trimmed, not refused
  });

  it("a ₹50,000 challan stores 5,000,000 paise and reads back 50,000 (invariant 1 — the 100× guard)", () => {
    selectAccount(PRIMARY);
    expect(ch.upsertChallan({ fy: "2024-25", paidOn: "2024-09-15", amount: 50000 }).ok).toBe(true);
    const row = ch.getChallans("2024-25").find((r) => r.paidOn === "2024-09-15")!;
    expect(row.amount).toBe(50000); // rupees at runtime …
    expect(rawPaise(row.id)).toBe(5000000); // … integer paise at rest

    // A paise fraction survives the round trip untouched: a hand ×100 or ÷100
    // anywhere in the module moves one of these two numbers.
    expect(ch.upsertChallan({ fy: "2024-25", paidOn: "2024-12-15", amount: 12345.67 }).ok).toBe(true);
    const frac = ch.getChallans("2024-25").find((r) => r.paidOn === "2024-12-15")!;
    expect(frac.amount).toBe(12345.67);
    expect(rawPaise(frac.id)).toBe(1234567);
  });

  it("a second identical payment is RECORDED, not refused — the table has no natural key", () => {
    selectAccount(PRIMARY);
    expect(ch.upsertChallan({ fy: "2021-22", paidOn: "2021-06-15", amount: 10000 }).ok).toBe(true);
    expect(ch.upsertChallan({ fy: "2021-22", paidOn: "2021-06-15", amount: 10000 }).ok).toBe(true);
    expect(ch.getChallans("2021-22")).toHaveLength(2);
  });

  it("passing an id EDITS that row in place instead of adding one", () => {
    selectAccount(PRIMARY);
    const before = ch.getChallans("2021-22");
    expect(ch.upsertChallan({ id: before[0].id, fy: "2021-22", paidOn: "2021-06-15", amount: 11000, note: "corrected" }).ok).toBe(true);
    const after = ch.getChallans("2021-22");
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.id === before[0].id)!.amount).toBe(11000);
    expect(after.find((r) => r.id === before[1].id)!.amount).toBe(10000); // the twin is untouched
  });

  it("refuses a malformed or inconsistent FY — never coerces (invariant 6)", () => {
    selectAccount(PRIMARY);
    for (const bad of ["2018", "18-19", "2018-2019", "2018-21", "1950-51"]) {
      const res = ch.upsertChallan({ fy: bad, paidOn: "2018-06-15", amount: 1000 });
      expect(res.ok, bad).toBe(false);
      expect(res.message, bad).toMatch(/FY must look like/);
    }
  });

  it("refuses a date that is not a real day — shape is not enough", () => {
    selectAccount(PRIMARY);
    // "2018-02-30" has the right shape and JS will happily roll it to 2 March.
    for (const bad of ["2018-02-30", "2018-13-01", "15-06-2018", "2018-6-15", "yesterday"]) {
      const res = ch.upsertChallan({ fy: "2018-19", paidOn: bad, amount: 1000 });
      expect(res.ok, bad).toBe(false);
      expect(res.message, bad).toMatch(/not a real date/);
    }
  });

  it("refuses a non-positive or non-finite amount — a challan for nothing is worse than no challan", () => {
    selectAccount(PRIMARY);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = ch.upsertChallan({ fy: "2018-19", paidOn: "2018-06-15", amount: bad });
      expect(res.ok, String(bad)).toBe(false);
      expect(res.message, String(bad)).toMatch(/above zero/);
    }
    expect(ch.getChallans("2018-19")).toHaveLength(0); // nothing was coerced in
  });

  it("REFUSES the aggregate view with the forbidden marker — 0 is a view, not a place (invariant 9)", () => {
    selectAccount(ALL);
    const res = ch.upsertChallan({ fy: "2024-25", paidOn: "2024-06-14", amount: 1000 });
    expect(res.ok).toBe(false);
    expect(res.forbidden).toBe(true);
    expect(ch.deleteChallan(1).forbidden).toBe(true);
    // …and nothing landed against getWriteAccountId's lowest-id fallback: a
    // bank payment filed under whichever account sorts first is the silent bug.
    expect(t.db.select().from(t.schema.advanceTaxChallans).all().filter((r) => r.amount === 1000)).toHaveLength(0);
    selectAccount(PRIMARY);
  });

  it("edit and delete reach only the selected account's rows", () => {
    selectAccount(SWING);
    expect(ch.upsertChallan({ fy: "2025-26", paidOn: "2025-06-15", amount: 8000 }).ok).toBe(true);
    expect(ch.upsertChallan({ fy: "2025-26", paidOn: "2025-09-15", amount: 9000 }).ok).toBe(true);
    const [keep, doomed] = ch.getChallans("2025-26");

    selectAccount(PRIMARY);
    expect(ch.deleteChallan(keep.id).ok).toBe(false); // not this account's row
    expect(ch.upsertChallan({ id: keep.id, fy: "2025-26", paidOn: "2025-06-15", amount: 1 }).ok).toBe(false);

    selectAccount(SWING);
    expect(ch.getChallans("2025-26").find((r) => r.id === keep.id)!.amount).toBe(8000); // untouched
    expect(ch.deleteChallan(doomed.id).ok).toBe(true);
    expect(ch.getChallans("2025-26")).toHaveLength(1);
    selectAccount(PRIMARY);
  });
});

describe("s.408(3) — the 31-March cliff (adversarial probe)", () => {
  it("REFUSES a payment dated after the FY ended, and names it self-assessment tax", () => {
    selectAccount(PRIMARY);
    // ₹1,00,000 paid on 20 May 2024 is a real payment — but for FY 2023-24 it
    // is SELF-ASSESSMENT tax, not advance tax. Filing it here would credit an
    // instalment ladder that closed on 31 Mar 2024 and understate the s.425
    // interest, with nothing on screen looking wrong.
    const res = ch.upsertChallan({ fy: "2023-24", paidOn: "2024-05-20", amount: 100000 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/self-assessment/i);
    expect(res.message).toContain("2024-03-31");
    expect(ch.getChallans("2023-24").some((r) => r.paidOn === "2024-05-20")).toBe(false);
  });

  it("ACCEPTS 31 March itself — s.408(3) makes anything paid BY 31 March advance tax", () => {
    selectAccount(PRIMARY);
    expect(ch.upsertChallan({ fy: "2023-24", paidOn: "2024-03-31", amount: 5000 }).ok).toBe(true);
    expect(ch.getChallans("2023-24").map((r) => r.paidOn)).toEqual(["2024-03-31"]);
  });

  it("refuses a payment dated before the FY began — it cannot be advance tax for a year that had not started", () => {
    selectAccount(PRIMARY);
    const res = ch.upsertChallan({ fy: "2023-24", paidOn: "2023-03-31", amount: 5000 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/before FY 2023-24 began on 2023-04-01/);
  });

  it("refuses a future-dated challan — a receipt is money that already left the bank, not a plan", () => {
    selectAccount(PRIMARY);
    const when = daysFromNow(1);
    const res = ch.upsertChallan({ fy: fyOf(when), paidOn: when, amount: 5000 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/in the future/);
    expect(ch.getChallans(fyOf(when)).some((r) => r.paidOn === when)).toBe(false);
  });

  it("the window closes on 31 March — the Act's own year, not the journal's", () => {
    expect(ch.advanceTaxFyWindow("2026-27")).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(ch.advanceTaxFyWindow("2023-24")).toEqual({ start: "2023-04-01", end: "2024-03-31" });
    // It takes no fyStartMonth, so there is no second opinion to drift from the
    // engine's ladder (which is April-based whatever the setting says).
    expect(ch.advanceTaxFyWindow.length).toBe(1);
  });

  it("isRealIsoDate rejects the shapes a regex alone lets through", () => {
    expect(ch.isRealIsoDate("2024-03-31")).toBe(true);
    expect(ch.isRealIsoDate("2024-02-29")).toBe(true); // leap
    expect(ch.isRealIsoDate("2023-02-29")).toBe(false);
    expect(ch.isRealIsoDate("2024-02-30")).toBe(false);
    expect(ch.isRealIsoDate("2024-04-31")).toBe(false);
  });
});

describe("reads (invariant 8)", () => {
  it("getChallans returns only the selected account's rows; the aggregate reads ALL", () => {
    selectAccount(PRIMARY);
    expect(ch.getChallans().every((r) => r.accountId === PRIMARY)).toBe(true);
    expect(ch.getChallans("2025-26")).toHaveLength(0); // SWING's FY

    selectAccount(SWING);
    expect(ch.getChallans().every((r) => r.accountId === SWING)).toBe(true);
    expect(ch.getChallans("2025-26")).toHaveLength(1);

    // The tax pages blend every account's trades in the aggregate view, so the
    // ledger must blend there too or the paid-so-far figure contradicts them.
    selectAccount(ALL);
    const all = ch.getChallans();
    expect(all.some((r) => r.accountId === PRIMARY)).toBe(true);
    expect(all.some((r) => r.accountId === SWING)).toBe(true);
    selectAccount(PRIMARY);
  });

  it("reads oldest payment first, id breaking a same-day tie", () => {
    selectAccount(PRIMARY);
    // Recorded newest-first, all inside ONE fy: the (account_id, fy) lookup
    // index must not be able to supply the ordering by accident — only an
    // explicit ORDER BY paid_on, id can satisfy this.
    expect(ch.upsertChallan({ fy: "2016-17", paidOn: "2017-03-10", amount: 300 }).ok).toBe(true);
    expect(ch.upsertChallan({ fy: "2016-17", paidOn: "2016-06-10", amount: 100 }).ok).toBe(true);
    expect(ch.upsertChallan({ fy: "2016-17", paidOn: "2016-06-10", amount: 200 }).ok).toBe(true);
    const scoped = ch.getChallans("2016-17");
    expect(scoped.map((r) => r.paidOn)).toEqual(["2016-06-10", "2016-06-10", "2017-03-10"]);
    expect(scoped[0].amount).toBe(100);
    expect(scoped[0].id).toBeLessThan(scoped[1].id); // same day → id breaks the tie

    const rows = ch.getChallans();
    expect(rows.length).toBeGreaterThan(3);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].paidOn <= rows[i].paidOn, `${rows[i - 1].paidOn} before ${rows[i].paidOn}`).toBe(true);
      if (rows[i - 1].paidOn === rows[i].paidOn) expect(rows[i - 1].id).toBeLessThan(rows[i].id);
    }
  });
});

describe("the payments list handed to the engine", () => {
  beforeAll(() => {
    selectAccount(PRIMARY);
    // Recorded out of date order on purpose — the engine reads them oldest-first.
    expect(ch.upsertChallan({ fy: "2022-23", paidOn: "2022-12-15", amount: 30000 }).ok).toBe(true);
    expect(ch.upsertChallan({ fy: "2022-23", paidOn: "2022-06-15", amount: 15000 }).ok).toBe(true);
    expect(ch.upsertChallan({ fy: "2022-23", paidOn: "2023-03-15", amount: 0.1 }).ok).toBe(true);
    expect(ch.upsertChallan({ fy: "2022-23", paidOn: "2023-03-16", amount: 0.2 }).ok).toBe(true);
  });

  it("totals the FY in RUPEES with the count and the dated list, oldest first", () => {
    selectAccount(PRIMARY);
    const totals = ch.challanTotalsByFy("2022-23");
    expect(totals.fy).toBe("2022-23");
    expect(totals.count).toBe(4);
    // 45000.3, not 45000.29999999999854: the figure is reconciled against a
    // receipt, so the float dust is cleaned at paise precision.
    expect(totals.total).toBe(45000.3);
    expect(totals.payments).toEqual([
      { date: "2022-06-15", amount: 15000 },
      { date: "2022-12-15", amount: 30000 },
      { date: "2023-03-15", amount: 0.1 },
      { date: "2023-03-16", amount: 0.2 },
    ]);
  });

  it("hands the engine RUPEES, not paise — no second conversion at this boundary (invariant 1)", () => {
    selectAccount(PRIMARY);
    const totals = ch.challanTotalsByFy("2024-25");
    expect(totals.payments.some((p) => p.amount === 50000)).toBe(true); // ₹50,000, not 5,000,000
    expect(totals.payments.every((p) => p.amount < 1_000_000)).toBe(true);
    expect(totals.total).toBe(87345.67); // 25000 + 50000 + 12345.67
  });

  it("an empty FY reports nothing — total 0 WITH count 0, so the caller can say “—” (invariant 6)", () => {
    selectAccount(PRIMARY);
    expect(ch.challanTotalsByFy("2015-16")).toEqual({ fy: "2015-16", total: 0, count: 0, payments: [] });
  });

  it("the totals are account-scoped too — SWING's payments never reach PRIMARY's ladder", () => {
    selectAccount(PRIMARY);
    expect(ch.challanTotalsByFy("2025-26").count).toBe(0);
    selectAccount(SWING);
    expect(ch.challanTotalsByFy("2025-26")).toMatchObject({ count: 1, total: 8000, payments: [{ date: "2025-06-15", amount: 8000 }] });
    selectAccount(PRIMARY);
  });
});

describe("duplicates are allowed but DETECTED", () => {
  beforeAll(() => {
    selectAccount(PRIMARY);
    expect(ch.upsertChallan({ fy: "2019-20", paidOn: "2019-06-15", amount: 7500.25 }).ok).toBe(true);
  });

  it("finds an exact (fy, paid_on, amount) match — and recording it anyway still WORKS", () => {
    selectAccount(PRIMARY);
    const hit = ch.findDuplicateChallan("2019-20", "2019-06-15", 750025);
    expect(hit?.amount).toBe(7500.25);
    // The detector warns; it must never become a block. Two real payments of
    // the same amount on the same day are legal, which is why the schema
    // carries no unique key.
    expect(ch.upsertChallan({ fy: "2019-20", paidOn: "2019-06-15", amount: 7500.25 }).ok).toBe(true);
    expect(ch.getChallans("2019-20")).toHaveLength(2);
  });

  it("one paisa apart is not a duplicate", () => {
    selectAccount(PRIMARY);
    expect(ch.findDuplicateChallan("2019-20", "2019-06-15", 750026)).toBeNull();
  });

  it("the amount parameter is PAISE — handing it rupees finds nothing (unit guard)", () => {
    selectAccount(PRIMARY);
    expect(ch.findDuplicateChallan("2019-20", "2019-06-15", 7500.25)).toBeNull();
  });

  it("a different date or FY never matches, and excludeId skips the row being edited", () => {
    selectAccount(PRIMARY);
    const rows = ch.getChallans("2019-20");
    expect(ch.findDuplicateChallan("2019-20", "2019-09-15", 750025)).toBeNull();
    expect(ch.findDuplicateChallan("2018-19", "2019-06-15", 750025)).toBeNull();
    expect(ch.findDuplicateChallan("2019-20", "2019-06-15", 750025, rows[0].id)?.id).toBe(rows[1].id);
  });

  it("never matches another account's challan, and returns null in the aggregate view", () => {
    selectAccount(SWING);
    expect(ch.findDuplicateChallan("2019-20", "2019-06-15", 750025)).toBeNull();
    selectAccount(ALL);
    expect(ch.findDuplicateChallan("2019-20", "2019-06-15", 750025)).toBeNull(); // that view cannot write
    selectAccount(PRIMARY);
  });
});

describe("route: zod + status mapping", () => {
  it("a bad FY shape 400s", async () => {
    selectAccount(PRIMARY);
    const res = await route.POST(req({ action: "upsert", fy: "20-21", paidOn: "2020-06-15", amount: 1000 }));
    expect(res.status).toBe(400);
  });

  it("a bad date shape and a zero amount 400 at the zod boundary", async () => {
    selectAccount(PRIMARY);
    expect((await route.POST(req({ action: "upsert", fy: "2020-21", paidOn: "15/06/2020", amount: 1000 }))).status).toBe(400);
    expect((await route.POST(req({ action: "upsert", fy: "2020-21", paidOn: "2020-06-15", amount: 0 }))).status).toBe(400);
    expect((await route.POST(req({ action: "sideways" }))).status).toBe(400);
    expect((await route.POST(req(null))).status).toBe(400);
  });

  it("a shape-valid but impossible date 400s through the QUERY rule, not zod", async () => {
    selectAccount(PRIMARY);
    const res = await route.POST(req({ action: "upsert", fy: "2020-21", paidOn: "2020-02-30", amount: 1000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/not a real date/);
  });

  it("a post-31-March payment 400s with the self-assessment reason (s.408(3))", async () => {
    selectAccount(PRIMARY);
    const res = await route.POST(req({ action: "upsert", fy: "2020-21", paidOn: "2021-07-20", amount: 1000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/self-assessment/i);
  });

  it("the aggregate view 403s on both actions", async () => {
    selectAccount(ALL);
    expect((await route.POST(req({ action: "upsert", fy: "2020-21", paidOn: "2020-06-15", amount: 1000 }))).status).toBe(403);
    expect((await route.POST(req({ action: "delete", id: 1 }))).status).toBe(403);
    selectAccount(PRIMARY);
  });

  it("a valid upsert lands, and delete removes it", async () => {
    selectAccount(PRIMARY);
    const ok = await route.POST(req({ action: "upsert", fy: "2020-21", paidOn: "2020-06-15", amount: 2500, bsrCode: "0510308", challanSerial: "00021" }));
    expect(ok.status).toBe(200);
    const row = ch.getChallans("2020-21")[0];
    expect(row.amount).toBe(2500);
    expect(rawPaise(row.id)).toBe(250000);

    const del = await route.POST(req({ action: "delete", id: row.id }));
    expect(del.status).toBe(200);
    expect(ch.getChallans("2020-21")).toHaveLength(0);
  });

  it("revalidates the two surfaces that read the ledger", async () => {
    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();
    selectAccount(PRIMARY);
    await route.POST(req({ action: "upsert", fy: "2020-21", paidOn: "2020-09-15", amount: 100 }));
    const paths = vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
    expect(paths).toContain("/reports/advance-tax");
    expect(paths).toContain("/reports/itr");
  });
});

/**
 * v3.7 audit M-1 — the planner and the ledger must date money on ONE clock.
 *
 * /reports/advance-tax read `new Date().toISOString().slice(0,10)` (UTC) while
 * this module accepted payments on a different one. For the 5½ hours between
 * midnight and 05:30 IST the two disagreed by a day, and the page could state
 * "45% paid" and "₹4,50,000 short now" about the same challan — `paidPct` off
 * the ledger total, `totalShortfallNow` off a `today` that was still yesterday.
 * The same UTC day set the editor's `<input type="date" max>` to yesterday, so
 * a challan paid that morning could not be entered at all until 05:30.
 */
describe("one clock, India's (M-1)", () => {
  // 21:30 UTC on the 15th IS 03:00 IST on the 16th.
  const earlyMorningIst = new Date("2026-09-15T21:30:00Z");

  it("todayIstIso() reads India's day, not UTC's and not the box's", () => {
    expect(ch.todayIstIso(earlyMorningIst)).toBe("2026-09-16");
    expect(earlyMorningIst.toISOString().slice(0, 10)).toBe("2026-09-15"); // what the page used to read
  });

  it("ACCEPTS a challan paid at 03:00 IST — that is today's money, not tomorrow's", () => {
    selectAccount(PRIMARY);
    vi.useFakeTimers();
    vi.setSystemTime(earlyMorningIst);
    try {
      const res = ch.upsertChallan({ fy: "2026-27", paidOn: "2026-09-16", amount: 450000 });
      expect(res.ok, res.message).toBe(true);
      expect(ch.getChallans("2026-27").some((r) => r.paidOn === "2026-09-16")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still refuses tomorrow — the IST clock moves the line, it does not remove it", () => {
    selectAccount(PRIMARY);
    vi.useFakeTimers();
    vi.setSystemTime(earlyMorningIst);
    try {
      const res = ch.upsertChallan({ fy: "2026-27", paidOn: "2026-09-17", amount: 1000 });
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/in the future/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the planner page dates itself on the SAME clock — no private UTC copy", () => {
    const src = readFileSync(path.join(process.cwd(), "app/reports/advance-tax/page.tsx"), "utf8");
    // `today` feeds computeAdvanceTax AND the editor's maxDate, so it must be
    // the ledger's own helper — a fourth private copy is how this defect
    // reappears (the week bucketer and the review card each had their own).
    // The name is matched EXACTLY: lib/engine/rates.ts exports a todayIso() on
    // a UTC clock, so importing that one instead would compile, read plausibly,
    // and put this page back on the day it was just taken off.
    expect(src).toMatch(/const today = todayIstIso\(\)/);
    expect(src).not.toMatch(/toISOString\(\)\s*\.slice\(\s*0,\s*10\s*\)/);
  });
});

/**
 * v3.7 audit L-3 — the accepted window and the engine's s.408(3) cut.
 *
 * `fyWindow(fy, fyStartMonth)` honoured the user-settable book year;
 * `computeAdvanceTax` hardcodes 31 March and an April-based ladder. With
 * fyStartMonth = 6 the table therefore ACCEPTED a payment dated 15 Apr 2027 that
 * the planner then classed as late and dropped from `taxPaidToDate` and every
 * rung — money visible in the ledger and absent from the plan — and REFUSED an
 * April payment the ladder would have counted towards 15 June. The window is now
 * the statutory year, so neither can happen.
 */
describe("the window cannot drift from the ladder (L-3)", () => {
  it("a non-April book year moves neither edge", () => {
    selectAccount(PRIMARY);
    t.db.update(t.schema.settings).set({ fyStartMonth: 6 }).run();
    // 20 May 2027 — deliberately AFTER the payment being tested, so the
    // future-date guard cannot fire and mask the window check. This is the real
    // shape of the bug: money paid in April, transcribed in May.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-05-20T06:00:00Z"));
    try {
      const late = ch.upsertChallan({ fy: "2026-27", paidOn: "2027-04-15", amount: 250000 });
      expect(late.ok).toBe(false);
      expect(late.message).toMatch(/self-assessment/i);
      expect(late.message).toContain("2027-03-31"); // not 2027-05-31
      expect(ch.getChallans("2026-27").some((r) => r.paidOn === "2027-04-15")).toBe(false);

      // The mirror: the ladder's first rung is 15 Jun 2026 and counts this, so
      // refusing it as "before FY 2026-27 began on 2026-06-01" was the same
      // disagreement pointing the other way.
      const april = ch.upsertChallan({ fy: "2026-27", paidOn: "2026-04-15", amount: 150000 });
      expect(april.ok, april.message).toBe(true);
      expect(ch.challanTotalsByFy("2026-27").payments.some((p) => p.date === "2026-04-15")).toBe(true);
    } finally {
      vi.useRealTimers();
      t.db.update(t.schema.settings).set({ fyStartMonth: 4 }).run();
    }
  });
});

describe("audit trail — a money write is always recorded", () => {
  it("create, update and delete each leave a row under the advance_tax_challan entity", () => {
    selectAccount(PRIMARY);
    expect(ch.upsertChallan({ fy: "2017-18", paidOn: "2017-06-15", amount: 4200 }).ok).toBe(true);
    const row = ch.getChallans("2017-18")[0];
    expect(ch.upsertChallan({ id: row.id, fy: "2017-18", paidOn: "2017-06-15", amount: 4300 }).ok).toBe(true);
    expect(ch.deleteChallan(row.id).ok).toBe(true);

    const actions = t.db
      .select()
      .from(t.schema.auditLog)
      .all()
      .filter((a) => a.entity === "advance_tax_challan")
      .map((a) => a.action);
    for (const action of ["create", "update", "delete"]) expect(actions).toContain(action);
  });
});
