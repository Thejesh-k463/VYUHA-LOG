import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { chargeInputsChanged, chargeInputsOf, patchMovesChargeInput } from "@/lib/domain/trade-edit";
import { toSlimTrade } from "@/lib/domain/slim-trade";
import { plural } from "@/lib/format";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 fix wave 2P — B2P-MTF-DATES: the pure D4 predicates, the D5 source pin,
 * the D9 render pin and the D4 data fix. The money designs (D1, D3) are pinned in
 * `tests/staged-charges.test.ts`, `tests/charges.test.ts` and
 * `tests/mtf-accrual-unpriced.test.ts`; the DB doors of D4 / D7 / D9 in
 * `tests/wave2n-dates-and-charges.test.ts`; D8 in `tests/ipo-link.test.ts` and
 * `tests/ipo-charger-dates.test.ts`; D6 in `tests/data-quality.test.ts`.
 *
 * ONE temp database per FILE (AGENTS.md Testing): the trade editor's import graph
 * reaches lib/db through `app/trades/actions` → `lib/import/commit`, so the
 * dialog is imported dynamically after the helper sets VYUHA_DB_PATH. The pure
 * imports above reach no database.
 */

// The server action module the dialog imports calls `revalidatePath` on a save;
// a render never does, and a unit test has no request scope for it anyway.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// ===========================================================================
// D4 — the two editor predicates compare the DAYS two dates state
// ===========================================================================

/**
 * D4 (mtf-staged#3 ≡ dates-charges-ask#0). `patchMovesChargeInput` and
 * `chargeInputsChanged` compared the two date columns byte for byte: a staged
 * parent whose first leg holds a legacy '20-01-2026' was refused every save —
 * notes included, through the stored strings, the dialog's form and the ISO day
 * — as "a staged position built from more than one fill…", and a flat 4.2.x
 * holding storing '05-01-2026' was re-priced on a notes-only save (its broker's
 * bill and the IPO sync's marker replaced) over a date that did not change.
 */
describe("D4 · patchMovesChargeInput / chargeInputsChanged compare days, not bytes", () => {
  const stored = { buyQty: 150, avgBuyPrice: 103.33, buyDate: "20-01-2026", sellQty: 0, avgSellPrice: 0, sellDate: null, mtfFundedAmount: null };

  it.each([
    ["2026-01-20", "20-01-2026", false, "the same day, spelt ISO by the save"],
    ["2026-01-21", "20-01-2026", true, "the next day"],
    ["9999-99-99", "9999-99-99", false, "an unreadable value compares to itself"],
    [null, "20-01-2026", true, "a cleared date"],
    ["20-01-2026", "20-01-2026", false, "the stored bytes sent back"],
  ] as const)("patch %j vs stored %j → moved %j (%s)", (patch, storedDate, moved, _why) => {
    // THE assertion for row 1 (on revert: true — the staged refusal on a notes-only save).
    expect(patchMovesChargeInput({ buyDate: patch }, { ...stored, buyDate: storedDate })).toBe(moved);
  });

  it("the sell date follows the same rule, and an omitted date is never a move", () => {
    const closed = { ...stored, sellQty: 150, avgSellPrice: 120, sellDate: "10-02-2026" };
    expect(patchMovesChargeInput({ sellDate: "2026-02-10" }, closed)).toBe(false);
    expect(patchMovesChargeInput({ sellDate: "2026-02-11" }, closed)).toBe(true);
    expect(patchMovesChargeInput({}, closed)).toBe(false);
  });

  it("chargeInputsChanged: a 4.2.x flat row's '05-01-2026' beside the save's '2026-01-05' is NOT a changed input", () => {
    const defaults = { buyOrders: 1, sellOrders: 1 };
    const legacy = chargeInputsOf(
      { buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-01-01", sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "05-01-2026", isOpen: false, buyOrderCount: 1, sellOrderCount: 1, mtfFundedAmount: null },
      defaults,
    );
    const resolved = chargeInputsOf(
      { buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-01-01", sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-01-05", isOpen: false, buyOrderCount: 1, sellOrderCount: 1, mtfFundedAmount: null },
      defaults,
    );
    // THE assertion (on revert: true — re-priced, the sync marker stripped).
    expect(chargeInputsChanged(legacy, resolved)).toBe(false);
    // A real move is still a move.
    expect(chargeInputsChanged(legacy, { ...resolved, sellDate: "2026-01-06" })).toBe(true);
  });
});

// ===========================================================================
// D5 — ONE leg-count predicate
// ===========================================================================

/**
 * D5 (mtf-staged#4). The literal leg-count query was copied SIX times outside
 * `closeStaleLot`'s transaction, and the accrual job had none — so a
 * staged-flagged row with no legs was rewritten from an empty ladder there. The
 * six sites now read `legCountOf` / `hasLadder` (lib/queries/staged), and the
 * literal lives in exactly two places: that helper, and `closeStaleLot`'s `tx`
 * block (a transaction cannot borrow a non-transactional helper).
 */
describe("D5 · the leg-count query has one owner", () => {
  const LITERAL = /from\(tradeLegs\)\.where\(eq\(tradeLegs\.tradeId/g;

  it("lib/queries/staged.ts states it once (legCountOf); commit.ts only inside closeStaleLot's tx", () => {
    expect(read("lib/queries/staged.ts").match(LITERAL)?.length).toBe(1);
    const commit = read("lib/import/commit.ts");
    expect(commit.match(LITERAL)?.length).toBe(2);
    for (const m of commit.matchAll(LITERAL)) {
      const line = commit.slice(commit.lastIndexOf("\n", m.index) + 1, commit.indexOf("\n", m.index));
      expect(line, "a copy outside the transaction").toMatch(/\btx\.select\(/);
    }
  });

  it.each([
    ["lib/import/commit.ts", /\b(legCountOf|hasLadder)\(/g, 3],
    ["app/api/charges/preview/route.ts", /\bhasLadder\(/g, 1],
    ["app/api/ipos/route.ts", /\bhasLadder\(/g, 1],
    ["app/trades/actions.ts", /\bhasLadder\(/g, 1],
    ["lib/jobs/mtf-accrual.ts", /\blegCountOf\(/g, 1],
  ] as const)("%s reads the shared predicate (%i call(s)) and holds no copy of the query", (rel, re, calls) => {
    const src = read(rel);
    expect(src.match(re)?.length ?? 0, "calls of the shared predicate").toBeGreaterThanOrEqual(calls);
    if (rel !== "lib/import/commit.ts") expect(src.match(LITERAL), "a private copy of the leg-count query").toBeNull();
  });
});

// ===========================================================================
// D12 — noun and verb agree, from one helper
// ===========================================================================

/**
 * D12 (seams#0 cosmetic). The Effective-leverage hint pluralised its noun on the
 * count and not its verb: "over the 1 row that state own capital". `plural()`
 * returns the WHOLE phrase, so noun and verb travel together, and the tracker's
 * four inline count-noun sites read it.
 */
describe("D12 · plural(n, one, many) is the whole phrase, and the tracker reads it", () => {
  it.each([
    [1, "1 row that states"],
    [2, "2 rows that state"],
    [0, "0 rows that state"],
  ])("plural(%i, …) → %s", (n, expected) => {
    expect(plural(n, "row that states", "rows that state")).toBe(expected);
  });

  it("tracker-client.tsx builds the hint from plural() and holds no inline noun-only plural", () => {
    const src = read("components/trackers/tracker-client.tsx");
    expect(src).toContain('plural(ownCap.stating, "row that states", "rows that state")');
    // THE assertion (on revert: the noun-only ternary is back).
    expect(src).not.toContain('"row" : "rows"} that state');
    expect(src.match(/\bplural\(/g)?.length, "the four sites").toBe(4);
    expect(src.match(/=== 1 \? "rows? /g), "no inline count-noun ternary survives").toBeNull();
  });
});

// ===========================================================================
// D9 — the editor states the STORED date problem, and Save waits
// ===========================================================================

let t: TempDb;
let fixes: typeof import("@/lib/db/data-fixes");
let stagedQ: typeof import("@/lib/queries/staged");
let Dialog: typeof import("@/components/ui/dialog").Dialog;
let EditTradeDialog: typeof import("@/components/trades/edit-trade-dialog").EditTradeDialog;

// Measured locally 2026-09-17: migrate + seed + the dialog's import graph ~2.4 s,
// inside the 3 s local hook budget. The raised timeout is for the Windows runner
// (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("wave2p-mtf-dates", { seed: true });
  fixes = await import("@/lib/db/data-fixes");
  stagedQ = await import("@/lib/queries/staged");
  ({ Dialog } = await import("@/components/ui/dialog"));
  ({ EditTradeDialog } = await import("@/components/trades/edit-trade-dialog"));
}, 120_000);
afterAll(() => t?.cleanup());

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
/** The trade as /trades ships it to the client (the RSC payload is JSON). */
const wire = (id: number) => JSON.parse(JSON.stringify(toSlimTrade(row(id)))) as ReturnType<typeof toSlimTrade>;

/**
 * D9 (dates-charges-ask#3). The dialog seeded its date STATE from the stored
 * '9999-99-99', derived the SENT-value sentence from it ("The buy date “9999-99-99”
 * is not a real calendar day… Nothing was changed.") and left Save enabled — while
 * the browser shows a `<input type="date" value="9999-99-99">` BLANK. Pressing
 * Save posted the blank, the action read it as "clear", and the row was cleared
 * and re-priced: the opposite of the sentence on screen. The dialog now asks the
 * STORED row first (`unreadableStoredDate`), states the stored problem in its own
 * words, and Save is disabled until the user types over the value.
 */
describe("D9 · a stored '9999-99-99' row: the STORED sentence, and a disabled Save", () => {
  const STORED = "This trade's stored buy date “9999-99-99” is not a real calendar day, so the field shows blank. Enter the day it was to save this trade.";
  const SENT = "The buy date “9999-99-99” is not a real calendar day";
  const html = (id: number) =>
    renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(EditTradeDialog, { trade: wire(id), onDone: () => {} }))).replace(/&#x27;/g, "'");
  const submit = (h: string) => h.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0] ?? "";

  it("renders the stored sentence, not the sent-value one, and Save carries disabled", () => {
    const id = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          broker: "zerodha", segment: "eq_mtf", symbol: "D9BAD", tradingsymbol: "D9BAD",
          buyQty: 100, avgBuyPrice: 160, buyValue: 16000, buyDate: "9999-99-99", buyOrderCount: 1, mtfFundedAmount: 12000,
          sellQty: 100, avgSellPrice: 170, sellValue: 17000, sellDate: "2026-09-01", sellOrderCount: 1,
          grossPnl: 1000, chargesTotal: 40, netPnl: 960, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const h = html(id);
    // THE assertions (on revert: the SENT-value sentence, and no `disabled` on Save).
    expect(h).toContain(STORED);
    expect(h).not.toContain(SENT);
    expect(submit(h), "the submit button").not.toBe("");
    expect(submit(h)).toMatch(/\sdisabled=""/);
    // The stored value is still what the form would post — the server's own
    // sent-value refusal stands behind the disabled button (H12).
    expect(h).toMatch(/name="buyDate"[^>]*value="9999-99-99"|value="9999-99-99"[^>]*name="buyDate"/);
  });

  it("a readable row: no sentence, Save enabled", () => {
    const id = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          broker: "zerodha", segment: "eq_delivery", symbol: "D9OK", tradingsymbol: "D9OK",
          buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const h = html(id);
    expect(h).not.toContain("is not a real calendar day");
    expect(submit(h)).not.toBe("");
    // The ATTRIBUTE, not Tailwind's `disabled:` variant in the class list.
    expect(submit(h)).not.toMatch(/\sdisabled(?:=""|>|\s)/);
  });
});

// ===========================================================================
// D4 layer 3 — the leg-trade-date data fix
// ===========================================================================

/**
 * D4 layer 3. Legacy `trade_legs.trade_date` values in a day-first spelling are
 * rewritten to the ISO day ONCE at startup (`leg-trade-date-iso-v1`); an
 * unreadable value is left for `validateLegs` to refuse by name (invariant 6:
 * a fix must not invent a day). The readers that need it are the ones that
 * compare or parse the leg date as ISO — the scaling replay's string window,
 * the replay chart's `time` — none of which a rebuild touches.
 */
describe("D4 · leg-trade-date-iso-v1 rewrites a readable day-first leg date, leaves an unreadable one, and is idempotent", () => {
  const FIX = "leg-trade-date-iso-v1";
  const marker = () => t.sqlite.prepare("SELECT name FROM data_fixes WHERE name = ?").get(FIX);
  const legDates = (id: number) =>
    t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, id)).all().sort((a, b) => a.seq - b.seq).map((l) => l.tradeDate);

  it("the fix, the readers it exists for, and the parent's ISO day after a rebuild (layer 2)", () => {
    expect(fixes.LEG_TRADE_DATE_ISO_FIX).toBe(FIX);
    expect(marker(), "the temp database ran the fix as it opened, like the app does").toBeTruthy();

    const id = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ broker: "zerodha", segment: "eq_delivery", symbol: "D4LEGS", tradingsymbol: "D4LEGS", staged: true, buyQty: 150, avgBuyPrice: 103.33, buyValue: 15500, buyDate: "20-01-2026", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.tradeLegs)
      .values([
        { tradeId: id, kind: "entry", seq: 1, tradeDate: "20-01-2026", qty: 100, price: 100 },
        { tradeId: id, kind: "entry", seq: 2, tradeDate: "2026-02-10", qty: 50, price: 110 },
      ])
      .run();
    const bad = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ broker: "zerodha", segment: "eq_delivery", symbol: "D4UNREADABLE", tradingsymbol: "D4UNREADABLE", staged: true, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-31", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db.insert(t.schema.tradeLegs).values([{ tradeId: bad, kind: "entry", seq: 1, tradeDate: "2026-02-31", qty: 10, price: 100 }]).run();

    // The reader the rewrite exists for: the scaling replay's string window
    // (`b.date >= from && b.date <= to`) drops a day-first date that is inside it.
    const inWindow = (d: string) => d >= "2026-01-01" && d <= "2026-12-31";
    expect(legDates(id).map(inWindow), "the premise: a day-first leg falls out of the window").toEqual([false, true]);

    // Run the fix the way a restore does: forget the marker, run again.
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(FIX);
    const first = fixes.runDataFixes(t.sqlite).find((r) => r.name === FIX)!;
    // THE assertion (on revert: no such fix, the leg still '20-01-2026').
    expect([first.applied, first.rekeyed]).toEqual([true, 1]);
    expect(legDates(id)).toEqual(["2026-01-20", "2026-02-10"]);
    expect(legDates(id).map(inWindow)).toEqual([true, true]);
    expect(legDates(bad), "an unreadable value is not rewritten — a fix must not invent a day").toEqual(["2026-02-31"]);
    expect(marker()).toBeTruthy();

    // Idempotent: a second call is a no-op behind the marker, and a forced re-run rewrites nothing.
    expect(fixes.runDataFixes(t.sqlite).find((r) => r.name === FIX)!.applied).toBe(false);
    t.sqlite.prepare("DELETE FROM data_fixes WHERE name = ?").run(FIX);
    expect(fixes.runDataFixes(t.sqlite).find((r) => r.name === FIX)!.rekeyed).toBe(0);

    // Layer 2: the parent carries the ISO day after a rebuild, and the ladder is
    // still refused by name for the unreadable leg (nothing invented there either).
    expect(stagedQ.rebuildStagedTrade(id).ok).toBe(true);
    expect(row(id).buyDate).toBe("2026-01-20");
    const refused = stagedQ.rebuildStagedTrade(bad);
    expect(refused.ok).toBe(false);
    expect(refused.problems[0]?.message).toContain("2026-02-31");
  });
});
