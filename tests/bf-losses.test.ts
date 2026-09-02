import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  computeTaxTimeline,
  lossExpiryFy,
  type CarryForwardLot,
  type FyGrossGains,
  type LossBucket,
} from "@/lib/analytics/capital-gains";

/**
 * WS5 — bf_loss_lots (pre-journal brought-forward losses) against a real
 * migrated temp DB, which also proves migration 0054 applies cleanly
 * (openTempDb runs the whole drizzle folder).
 *
 * Covers: CRUD + the refuse-don't-default write rules (invariant 6), the
 * account boundary (invariant 8) and the aggregate-view write refusal
 * (invariant 9), paise-at-rest / rupees-at-runtime (invariant 1), the
 * toSeedLots boundary (no second conversion), expiry ALIGNMENT with the
 * engine (the alignment loop proves displayRows and the engine agree — but it
 * CANNOT red on a CARRY_WINDOW mutation, because both sides read the mutated
 * table; only the LITERAL pins below catch the window itself changing, so do
 * not delete them as "redundant"), the seed guard against journalled-FY
 * double-counting, the page-level seed wiring (query + engine, no React),
 * the route's 400/403 mapping, and the merge policy (move; collisions keep
 * the larger amount with a note, never the sum).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let bf: typeof import("@/lib/queries/bf-losses");
let route: typeof import("@/app/api/bf-losses/route");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function req(body: unknown): Request {
  return new Request("http://local/api/bf-losses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const fy = (name: string, over: Partial<FyGrossGains> = {}): FyGrossGains => ({
  fy: name,
  stcg: 0,
  ltcg: 0,
  speculative: 0,
  nonSpeculative: 0,
  stcgRate: 0.2,
  ltcgRate: 0.125,
  ltcgExemption: 125000,
  ...over,
});

beforeAll(async () => {
  t = await openTempDb("bf-losses", { seed: true });
  bf = await import("@/lib/queries/bf-losses");
  route = await import("@/app/api/bf-losses/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("writes (invariants 6/9)", () => {
  it("records a lot for the selected account", () => {
    selectAccount(PRIMARY);
    const res = bf.upsertBfLoss({ incurredFy: "2022-23", head: "stcl", amount: 50000, originalAmount: 80000, note: "AY 2023-24 ITR-3" });
    expect(res.ok).toBe(true);
    const row = t.db.select().from(t.schema.bfLossLots).all()[0];
    expect(row.accountId).toBe(PRIMARY);
    expect(row.incurredFy).toBe("2022-23");
    expect(row.head).toBe("stcl");
  });

  it("round-trips rupees through the paise columns (invariant 1)", () => {
    selectAccount(PRIMARY);
    expect(bf.upsertBfLoss({ incurredFy: "2023-24", head: "ltcl", amount: 12345.67, originalAmount: 23456.78 }).ok).toBe(true);
    const row = t.db.select().from(t.schema.bfLossLots).all().find((r) => r.head === "ltcl")!;
    expect(row.amount).toBe(12345.67); // rupees at runtime …
    expect(row.originalAmount).toBe(23456.78);
    const raw = t.sqlite.prepare("select amount_paise as a, original_amount_paise as o from bf_loss_lots where head = 'ltcl'").get() as { a: number; o: number };
    expect(raw.a).toBe(1234567); // … integer paise at rest
    expect(raw.o).toBe(2345678);
  });

  it("re-entering the same (FY, head) UPDATES the lot — one carry-out per vintage (unique index honoured)", () => {
    selectAccount(PRIMARY);
    expect(bf.upsertBfLoss({ incurredFy: "2022-23", head: "stcl", amount: 60000 }).ok).toBe(true);
    const rows = t.db.select().from(t.schema.bfLossLots).all().filter((r) => r.head === "stcl" && r.incurredFy === "2022-23");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(60000);
    expect(rows[0].originalAmount).toBeNull(); // the edit is the new full statement
  });

  it("refuses malformed or inconsistent FYs — never coerces (invariant 6)", () => {
    selectAccount(PRIMARY);
    for (const bad of ["2022", "22-23", "2022-2023", "2022-25", "1950-51"]) {
      expect(bf.upsertBfLoss({ incurredFy: bad, head: "stcl", amount: 1000 }).ok).toBe(false);
    }
    expect(bf.isValidFy("2022-23")).toBe(true);
    expect(bf.isValidFy("2099-00")).toBe(true); // century wrap
    expect(bf.isValidFy("2022-24")).toBe(false);
  });

  it("refuses a non-positive amount, an unknown head, and an original smaller than the remainder", () => {
    selectAccount(PRIMARY);
    expect(bf.upsertBfLoss({ incurredFy: "2021-22", head: "stcl", amount: 0 }).ok).toBe(false);
    expect(bf.upsertBfLoss({ incurredFy: "2021-22", head: "stcl", amount: -5 }).ok).toBe(false);
    expect(bf.upsertBfLoss({ incurredFy: "2021-22", head: "capital" as never, amount: 1000 }).ok).toBe(false);
    // A loss only shrinks after it is incurred — remaining > original is not a
    // statement the filed returns could have made.
    const res = bf.upsertBfLoss({ incurredFy: "2021-22", head: "stcl", amount: 5000, originalAmount: 4000 });
    expect(res.ok).toBe(false);
    expect(t.db.select().from(t.schema.bfLossLots).all().filter((r) => r.incurredFy === "2021-22")).toHaveLength(0);
  });

  it("REFUSES the aggregate view with the forbidden marker — 0 is a view, not a place (invariant 9)", () => {
    selectAccount(ALL);
    const res = bf.upsertBfLoss({ incurredFy: "2020-21", head: "stcl", amount: 1000 });
    expect(res.ok).toBe(false);
    expect(res.forbidden).toBe(true);
    expect(bf.deleteBfLoss(1).forbidden).toBe(true);
  });

  it("delete removes only the selected account's lot", () => {
    selectAccount(SWING);
    expect(bf.upsertBfLoss({ incurredFy: "2020-21", head: "speculative", amount: 7000 }).ok).toBe(true);
    const swingLot = t.db.select().from(t.schema.bfLossLots).all().find((r) => r.accountId === SWING)!;
    selectAccount(PRIMARY);
    expect(bf.deleteBfLoss(swingLot.id).ok).toBe(false); // not this account's row
    selectAccount(SWING);
    expect(bf.deleteBfLoss(swingLot.id).ok).toBe(true);
  });
});

describe("reads (invariant 8)", () => {
  it("getBfLossRows returns only the selected account's lots; aggregate reads ALL", () => {
    selectAccount(SWING);
    expect(bf.upsertBfLoss({ incurredFy: "2024-25", head: "nonSpeculative", amount: 9000 }).ok).toBe(true);

    selectAccount(PRIMARY);
    expect(bf.getBfLossRows().every((r) => r.accountId === PRIMARY)).toBe(true);
    expect(bf.getBfLossRows()).toHaveLength(2); // 2022-23 stcl + 2023-24 ltcl

    // Aggregate: the tax pages blend every account's trades in that view, so
    // the seed reads every account's lots too.
    selectAccount(ALL);
    expect(bf.getBfLossRows()).toHaveLength(3);
  });
});

describe("toSeedLots + expiry alignment (red-on-revert)", () => {
  it("maps rows to CarryForwardLots in rupees, unchanged — no second conversion", () => {
    selectAccount(PRIMARY);
    const lots = bf.toSeedLots(bf.getBfLossRows());
    expect(lots).toContainEqual({ bucket: "stcl", fyIncurred: "2022-23", amount: 60000 });
    expect(lots).toContainEqual({ bucket: "ltcl", fyIncurred: "2023-24", amount: 12345.67 });
  });

  it("displayRows' expiry agrees with the ENGINE for every head: absorbed in its lossExpiryFy, pruned the FY after", () => {
    // The alignment loop, not a copy of the window table: if CARRY_WINDOW or
    // lossExpiryFy changes (revert the 8y/4y windows), the engine absorbs or
    // prunes in a different FY than the displayed expiry and this fails.
    const gainFor: Record<LossBucket, Partial<FyGrossGains>> = {
      stcl: { stcg: 5000 },
      ltcl: { ltcg: 5000 },
      speculative: { speculative: 5000 },
      nonSpeculative: { nonSpeculative: 5000 },
    };
    for (const head of bf.LOSS_HEADS) {
      const seed: CarryForwardLot[] = [{ bucket: head, fyIncurred: "2016-17", amount: 4000 }];
      const expiry = lossExpiryFy(head, "2016-17");
      const yearAfter = `${Number(expiry.slice(0, 4)) + 1}-${String((Number(expiry.slice(0, 4)) + 2) % 100).padStart(2, "0")}`;

      const [atExpiry] = computeTaxTimeline([fy(expiry, gainFor[head])], seed);
      expect(atExpiry.usedCarryForward, `${head} must still absorb in its displayed expiry FY ${expiry}`).toHaveLength(1);

      const [after] = computeTaxTimeline([fy(yearAfter, gainFor[head])], seed);
      expect(after.usedCarryForward, `${head} must be pruned the FY after ${expiry}`).toHaveLength(0);
    }
  });

  it("displayRows derives expiry via lossExpiryFy, and the statutory windows are pinned LITERALLY (red-on-revert)", () => {
    selectAccount(PRIMARY);
    const rows = bf.displayRows(bf.getBfLossRows());
    const stcl = rows.find((r) => r.head === "stcl")!;
    expect(stcl.expiresAfterFy).toBe(lossExpiryFy("stcl", "2022-23"));
    // Literal pins, not a re-derivation: S.74 gives capital and S.72
    // non-speculative losses 8 years, S.73 speculative 4 — editing
    // CARRY_WINDOW moves lossExpiryFy AND pruneExpired together (one home),
    // so only a literal expectation can catch the window itself changing.
    expect(stcl.expiresAfterFy).toBe("2030-31"); // 2022 + 8
    expect(lossExpiryFy("ltcl", "2022-23")).toBe("2030-31");
    expect(lossExpiryFy("nonSpeculative", "2022-23")).toBe("2030-31");
    expect(lossExpiryFy("speculative", "2022-23")).toBe("2026-27"); // 2022 + 4
  });
});

describe("page-level seed wiring (query + engine — what the tax page computes)", () => {
  it("a seeded STCL reduces the first FY's taxable STCG in the timeline", () => {
    selectAccount(PRIMARY); // holds 2022-23 stcl ₹60,000
    const seed = bf.toSeedLots(bf.getBfLossRows());
    const gains = [fy("2025-26", { stcg: 100000 })];

    const unseeded = computeTaxTimeline(gains);
    const seeded = computeTaxTimeline(gains, seed);

    expect(unseeded[0].taxableStcg).toBe(100000);
    expect(seeded[0].taxableStcg).toBe(40000); // 1L gain − 60k seeded STCL
    expect(seeded[0].usedCarryForward).toContainEqual({ bucket: "stcl", fyIncurred: "2022-23", amount: 60000 });
  });
});

describe("seed guard — a journalled FY cannot double-count (adversarial probe, 2026-09-01)", () => {
  const lots = (rows: { incurredFy: string; head: LossBucket; amount: number }[]) =>
    rows as unknown as Parameters<typeof bf.toSeedLots>[0];

  it("toSeedLots drops a lot whose FY the journal covers; excludedSeedLots names it", () => {
    selectAccount(PRIMARY); // holds 2022-23 stcl + 2023-24 ltcl
    const rows = bf.getBfLossRows();
    const guard = { journalledFys: new Set(["2023-24", "2024-25"]), currentFy: "2026-27" };
    const seeded = bf.toSeedLots(rows, guard);
    expect(seeded.some((l) => l.fyIncurred === "2023-24")).toBe(false);
    expect(seeded.some((l) => l.fyIncurred === "2022-23")).toBe(true); // pre-journal vintages survive
    expect(bf.excludedSeedLots(rows, guard).map((r) => r.incurredFy)).toEqual(["2023-24"]);
  });

  it("PROBE 1: an FY filed as a b/f lot AND imported later stays ₹50k taxable — the unguarded seed made it 0", () => {
    // FY23-24: net STCL 50k now journalled; the user had already entered the
    // same 50k as a lot before importing that year. FY24-25: 1L STCG.
    const byFy = [fy("2023-24", { stcg: -50000 }), fy("2024-25", { stcg: 100000 })];
    const legacy = lots([{ incurredFy: "2023-24", head: "stcl", amount: 50000 }]);
    const guard = { journalledFys: new Set(byFy.map((f) => f.fy)), currentFy: "2026-27" };

    const guarded = computeTaxTimeline(byFy, bf.toSeedLots(legacy, guard));
    expect(guarded[1].taxableStcg).toBe(50000); // 1L − the journal's OWN 50k carry, once

    // Red-on-revert: the unguarded seed really does count the loss twice.
    const unguarded = computeTaxTimeline(byFy, bf.toSeedLots(legacy));
    expect(unguarded[1].taxableStcg).toBe(0);
  });

  it("PROBE 2: a future-FY lot (2035-36) neither writes nor absorbs today's gains", () => {
    selectAccount(PRIMARY);
    const res = bf.upsertBfLoss({ incurredFy: "2035-36", head: "stcl", amount: 40000 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/hasn't happened yet/);
    // Belt-and-braces: a legacy future-dated lot is excluded at read time too.
    const legacy = lots([{ incurredFy: "2035-36", head: "stcl", amount: 40000 }]);
    const byFy = [fy("2025-26", { stcg: 100000 })];
    const [r] = computeTaxTimeline(byFy, bf.toSeedLots(legacy, { journalledFys: new Set(["2025-26"]), currentFy: "2026-27" }));
    expect(r.taxableStcg).toBe(100000);
    expect(r.usedCarryForward).toHaveLength(0);
  });

  it("upsert REFUSES any FY >= the journal's earliest FY for the scoped account", async () => {
    const { tradeRow } = await import("./helpers/temp-db");
    const JRNL = 5;
    t.db.insert(t.schema.accounts).values({ id: JRNL, name: "Journalled" }).run();
    t.db.insert(t.schema.trades).values(tradeRow({ accountId: JRNL, isOpen: false, sellDate: "2023-06-15", netPnl: -50000 })).run();
    selectAccount(JRNL);
    expect(bf.earliestJournalledFy()).toBe("2023-24");

    const res = bf.upsertBfLoss({ incurredFy: "2023-24", head: "stcl", amount: 50000 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/already in your journal — losses from imported trades are computed, not entered/);
    expect(bf.upsertBfLoss({ incurredFy: "2024-25", head: "stcl", amount: 1000 }).ok).toBe(false); // later FYs too
    expect(bf.upsertBfLoss({ incurredFy: "2022-23", head: "stcl", amount: 1000 }).ok).toBe(true); // pre-journal stays open

    // The scope is per account: PRIMARY's journal is still empty, so its
    // pre-journal entries are untouched by JRNL's trades.
    selectAccount(PRIMARY);
    expect(bf.earliestJournalledFy()).toBeNull();
  });
});

describe("the pages actually pass the seed (drift guard on the one-line wiring)", () => {
  it("both computeTaxTimeline call sites hand toSeedLots(getBfLossRows()) as the second argument", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const rel of ["app/reports/tax/page.tsx", "app/reports/itr/page.tsx"]) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      // toSeedLots must appear INSIDE computeTaxTimeline's argument list (the
      // old [\s\S]*? form matched a toSeedLots anywhere later in the file).
      expect(
        /computeTaxTimeline\(\s*byFy\s*,\s*toSeedLots\(/.test(src),
        `${rel} calls computeTaxTimeline without toSeedLots(...) as its second argument — reverting the wiring silently drops hand-entered losses`,
      ).toBe(true);
      // …and both surfaces must pass the SeedGuard, or a lot colliding with a
      // journalled FY silently double-counts that FY's loss.
      expect(
        /toSeedLots\(\s*(?:bfRows|getBfLossRows\(\))\s*,\s*(?:seedGuard|\{\s*journalledFys)/.test(src),
        `${rel} seeds without the journalled-FY guard`,
      ).toBe(true);
    }
  });
});

describe("route: zod + status mapping", () => {
  it("a bad FY format 400s", async () => {
    selectAccount(PRIMARY);
    const res = await route.POST(req({ action: "upsert", incurredFy: "22-23", head: "stcl", amount: 1000 }));
    expect(res.status).toBe(400);
  });

  it("an inconsistent FY (right shape, wrong second half) 400s via the query rule", async () => {
    selectAccount(PRIMARY);
    const res = await route.POST(req({ action: "upsert", incurredFy: "2022-25", head: "stcl", amount: 1000 }));
    expect(res.status).toBe(400);
  });

  it("the aggregate view 403s", async () => {
    selectAccount(ALL);
    const res = await route.POST(req({ action: "upsert", incurredFy: "2022-23", head: "stcl", amount: 1000 }));
    expect(res.status).toBe(403);
    selectAccount(PRIMARY);
  });

  it("a valid upsert lands", async () => {
    selectAccount(PRIMARY);
    const res = await route.POST(req({ action: "upsert", incurredFy: "2019-20", head: "speculative", amount: 2500 }));
    expect(res.status).toBe(200);
    expect(t.db.select().from(t.schema.bfLossLots).all().some((r) => r.incurredFy === "2019-20" && r.accountId === PRIMARY)).toBe(true);
    await route.POST(req({ action: "delete", id: t.db.select().from(t.schema.bfLossLots).all().find((r) => r.incurredFy === "2019-20")!.id }));
  });
});

describe("account delete/merge — lots are statements of fact and FOLLOW the book", () => {
  const SRC = 7;
  const TGT = 8;

  it("merge MOVES non-colliding lots and keeps the LARGER amount (with a note) on a shared vintage — never the sum", async () => {
    const del = await import("@/lib/queries/account-delete");
    t.db.insert(t.schema.accounts).values({ id: SRC, name: "Old-Zerodha" }).run();
    t.db.insert(t.schema.accounts).values({ id: TGT, name: "New-Zerodha" }).run();
    selectAccount(SRC);
    expect(bf.upsertBfLoss({ incurredFy: "2020-21", head: "ltcl", amount: 30000 }).ok).toBe(true); // moves
    expect(bf.upsertBfLoss({ incurredFy: "2021-22", head: "stcl", amount: 90000, originalAmount: 90000 }).ok).toBe(true); // collides, larger
    selectAccount(TGT);
    expect(bf.upsertBfLoss({ incurredFy: "2021-22", head: "stcl", amount: 40000 }).ok).toBe(true);
    selectAccount(PRIMARY);

    const preview = del.previewAccountDelete({ accountId: SRC, mode: "merge", targetId: TGT });
    expect(preview.warnings?.some((w) => /loss lot.*move/i.test(w))).toBe(true);
    expect(preview.warnings?.some((w) => /2021-22 stcl/.test(w) && /LARGER/.test(w))).toBe(true);

    const res = del.deleteAccount({ accountId: SRC, mode: "merge", targetId: TGT, connections: "delete" });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/1 b\/f loss lot moved/);
    expect(res.message).toMatch(/1 shared vintage kept at the larger amount/);

    const lots = t.db.select().from(t.schema.bfLossLots).all().filter((r) => r.accountId === TGT);
    expect(lots).toHaveLength(2);
    const moved = lots.find((r) => r.incurredFy === "2020-21")!;
    expect(moved.amount).toBe(30000); // moved intact
    const kept = lots.find((r) => r.incurredFy === "2021-22")!;
    expect(kept.amount).toBe(90000); // larger, NOT 130000
    expect(kept.originalAmount).toBe(90000); // larger non-null original survives
    expect(kept.note).toMatch(/kept the larger/);
    expect(t.db.select().from(t.schema.bfLossLots).all().some((r) => r.accountId === SRC)).toBe(false);
  });

  it("purge deletes the account's lots outright (restated from filed ITRs, not snapshotted)", async () => {
    const del = await import("@/lib/queries/account-delete");
    t.db.insert(t.schema.accounts).values({ id: 9, name: "Doomed" }).run();
    selectAccount(9);
    expect(bf.upsertBfLoss({ incurredFy: "2018-19", head: "nonSpeculative", amount: 1000 }).ok).toBe(true);
    selectAccount(PRIMARY);

    const preview = del.previewAccountDelete({ accountId: 9, mode: "purge" });
    expect(preview.counts?.bfLossLots).toBe(1);

    const res = del.deleteAccount({ accountId: 9, mode: "purge", connections: "delete" });
    expect(res.ok).toBe(true);
    expect(t.db.select().from(t.schema.bfLossLots).all().some((r) => r.accountId === 9)).toBe(false);
  });
});
