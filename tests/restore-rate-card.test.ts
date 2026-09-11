import { afterAll, beforeAll, describe, expect, it } from "vitest";
// PURE (no DB) — safe to import statically beside openTempDb; see its header.
import { buildChargeConfigSeed } from "@/lib/db/seed-data";
import { findRates, ratesMapOf } from "@/lib/engine/rates";
import type { ChargeRates } from "@/lib/engine/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 R7: a restore puts back the rate card it carried — a backup from an
 * older release, or a "My Default Settings" snapshot captured before this
 * build's corrections — and the desktop refresh runs only at sidecar start, so
 * every import for the rest of the session priced from the OLD card. Both
 * restore paths now run seed-core's refreshChargeConfig() inside their own
 * transaction, right after the re-insert: the rows the user never edited
 * follow this version's card, and the user's own rows, windows included, stay
 * exactly as restored.
 *
 * The stale card is the pre-v3.2.0 shape: ONE open 1970 row per key at the
 * current rates, F&O at the FY25 STT (FATAX63809: futures 0.02%, options
 * 0.10%) — the card on which a 30-Sep-2024 option sale priced at 0.10% instead
 * of the 0.0625% in force (FATAX56235).
 *
 * Two user edits ride in it:
 *   OPEN    zerodha/future/NSE, 1970 → open, brokerage Rs 15. It owns every
 *           date, so no seed epoch may be added to that key.
 *   CLOSED  groww/index_option/NSE, 1970 → 2024-10-01, brokerage Rs 15. Its
 *           effective_to IS a seed boundary, and windows are exclusive-to, so
 *           the seed epoch starting that day IS reinstated. That is the
 *           closed-window branch of seed-core's user-edit guard (R35), which
 *           runs on user databases for the first time through this path.
 *
 * ONE temp database per file (lib/db caches its connection): the tests share
 * it and run in declaration order.
 */

let t: TempDb;
let backup: typeof import("@/lib/backup");
let baseline: typeof import("@/lib/queries/settings-baseline");

beforeAll(async () => {
  t = await openTempDb("restore-rate-card", { seed: true });
  backup = await import("@/lib/backup");
  baseline = await import("@/lib/queries/settings-baseline");
});

afterAll(() => t?.cleanup());

type Key = { broker: string; plan: string; segment: string; exchange: string };
type Row = Record<string, unknown>;
const keyOf = (r: Key | Row) => `${r.broker}/${r.plan}/${r.segment}/${r.exchange}`;

const OPEN: Key = { broker: "zerodha", plan: "default", segment: "future", exchange: "NSE" };
const CLOSED: Key = { broker: "groww", plan: "default", segment: "index_option", exchange: "NSE" };
/** A seed boundary (FATAX63809), and the end of the CLOSED user window. */
const CLOSED_TO = "2024-10-01";
/** FY25 sell-side STT (FATAX63809), typed here: what a pre-v3.2.0 card charged on every date. */
const FY25_STT: Record<string, number> = { future: 0.0002, index_option: 0.001, stock_option: 0.001 };
/** A write stamp no refresh may touch on a user-edited row. */
const STAMP = "2025-01-15 10:00:00";

const SEED = buildChargeConfigSeed();
const fromOf = (r: { effectiveFrom?: string }) => r.effectiveFrom ?? "1970-01-01";
/** A seed row as the database reads it back: dated, and not user-edited. */
const asStored = (r: (typeof SEED)[number]): Row => ({
  ...r,
  effectiveFrom: fromOf(r),
  effectiveTo: r.effectiveTo ?? null,
  userEdited: false,
});
const pick = (r: Row, cols: string[]): Row => Object.fromEntries(cols.map((c) => [c, r[c]]));

/** The stale card: one open 1970 row per key (its current rates, F&O at FY25 STT), plus the two user rows. */
function staleCard(): Row[] {
  const rows: Row[] = [];
  for (const r of SEED) {
    if (r.effectiveTo != null) continue; // each key's open (current) epoch
    const row: Row = {
      ...r,
      sttPct: FY25_STT[r.segment] ?? r.sttPct,
      effectiveFrom: "1970-01-01",
      effectiveTo: null,
      userEdited: false,
    };
    if (keyOf(r) === keyOf(OPEN)) {
      Object.assign(row, { userEdited: true, brokerageFlat: 15, brokeragePct: 0, brokerageCap: null, updatedAt: STAMP });
    }
    if (keyOf(r) === keyOf(CLOSED)) {
      Object.assign(row, { userEdited: true, brokerageFlat: 15, effectiveTo: CLOSED_TO, updatedAt: STAMP });
    }
    rows.push(row);
  }
  expect(rows).toHaveLength(117);
  return rows;
}

const stored = (): Row[] => t.db.select().from(t.schema.chargeConfig).all() as unknown as Row[];
const rowsOfKey = (rows: Row[], k: Key) =>
  rows.filter((r) => keyOf(r) === keyOf(k)).sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)));

/** What both restore paths must leave: this build's card, with both user rows exactly as restored. */
function expectRefreshedCard(card: Row[]): void {
  const rows = stored();

  // What an import then prices with.
  const map = ratesMapOf(rows as unknown as ChargeRates[]);
  expect(findRates(map, "dhan", "index_option", "NSE", "2024-09-30").sttPct).toBe(0.000625); // FATAX56235: 0.0625%
  expect(findRates(map, "zerodha", "future", "NSE", "2026-06-15").brokerageFlat).toBe(15); // the OPEN user rate
  expect(findRates(map, "groww", "index_option", "NSE", "2024-09-30").brokerageFlat).toBe(15); // inside CLOSED
  expect(findRates(map, "groww", "index_option", "NSE", CLOSED_TO).sttPct).toBe(0.001); // the reinstated seed epoch

  // Every key the user never edited is this build's card, epoch for epoch.
  const mine = new Set([keyOf(OPEN), keyOf(CLOSED)]);
  const expected = SEED.filter((r) => !mine.has(keyOf(r))).map(asStored);
  const got = rows.filter((r) => !mine.has(keyOf(r)));
  expect(got).toHaveLength(expected.length);
  const byEpoch = new Map(got.map((r) => [`${keyOf(r)} ${r.effectiveFrom}`, r]));
  for (const e of expected) {
    const at = `${keyOf(e)} ${e.effectiveFrom}`;
    const g = byEpoch.get(at);
    expect(g, at).toBeDefined();
    expect(pick(g!, Object.keys(e)), at).toEqual(e);
  }

  // OPEN: the user's row alone, byte-identical (write stamp included).
  const open = card.find((r) => keyOf(r) === keyOf(OPEN))!;
  const openRows = rowsOfKey(rows, OPEN);
  expect(openRows).toHaveLength(1);
  expect(pick(openRows[0], Object.keys(open))).toEqual(open);

  // CLOSED: the user's row, then exactly the seed epochs starting on or after its effective_to.
  const closed = card.find((r) => keyOf(r) === keyOf(CLOSED))!;
  const closedRows = rowsOfKey(rows, CLOSED);
  const seedAfter = SEED.filter((r) => keyOf(r) === keyOf(CLOSED) && fromOf(r) >= CLOSED_TO)
    .map(asStored)
    .sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)));
  expect(closedRows.map((r) => r.effectiveFrom)).toEqual(["1970-01-01", CLOSED_TO, "2026-03-01", "2026-04-01"]);
  expect(pick(closedRows[0], Object.keys(closed))).toEqual(closed);
  expect(closedRows.slice(1).map((r, i) => pick(r, Object.keys(seedAfter[i])))).toEqual(seedAfter);
}

describe("restoreDatabase brings a restored rate card onto this version's card (R7)", () => {
  it("a backup carrying a stale card: rows the user never edited follow this build's card, both user rows byte-identical", () => {
    const dump = backup.dumpDatabase(false);
    const card = staleCard();
    const res = backup.restoreDatabase({ ...dump, tables: { ...dump.tables, charge_config: card } });
    expect(res.ok, res.message).toBe(true);
    expectRefreshedCard(card);
  });

  it("a backup that did not carry charge_config leaves the table exactly as it was", () => {
    // A non-edited row off the card: a refresh would put it back, so this restore must not run one.
    const moved = t.sqlite
      .prepare(
        `UPDATE charge_config SET brokerage_flat = 999 WHERE broker = 'dhan' AND plan = 'default'
           AND segment = 'eq_delivery' AND exchange = 'NSE' AND effective_to IS NULL`,
      )
      .run().changes;
    expect(moved).toBe(1);
    const before = stored();
    const dump = backup.dumpDatabase(false);
    const tables: Record<string, unknown[]> = { ...dump.tables };
    delete tables.charge_config;

    const res = backup.restoreDatabase({ ...dump, tables });
    expect(res.ok, res.message).toBe(true);
    expect(stored()).toEqual(before);
  });
});

describe("restoreBaseline brings a stale snapshot's rate card onto this version's card (R7)", () => {
  it("rows the user never edited follow this build's card, both user rows byte-identical, and the message says so", () => {
    const b = baseline.getBaseline();
    expect(b).not.toBeNull();
    const card = staleCard();
    t.db
      .update(t.schema.settingsBaseline)
      .set({ payload: { ...b!, chargeConfig: card } as unknown as Record<string, unknown> })
      .run();

    const res = baseline.restoreBaseline();
    expect(res.ok, res.message).toBe(true);
    expect(res.message).toMatch(/Rate rows you never edited follow this version's rate card\./);
    expectRefreshedCard(card);
  });
});
