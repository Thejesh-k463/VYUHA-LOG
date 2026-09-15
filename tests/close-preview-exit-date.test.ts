import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * I1 [1] (v4.3.0 wave 2I, pre-existing) — the Trades close dialog previewed a
 * DIFFERENT exit epoch from the one its save bills whenever the exit-date field
 * was cleared or unreadable.
 *
 * `closePreviewBody` took the holding period off the RAW field
 * (`new Date(exitDate)`), while the rest of the same body — and `closePosition`
 * — fall back to today. `new Date("")` is an Invalid Date, so `daysHeld` was
 * NaN, `JSON.stringify` sent it as `null`, and the route's `v.daysHeld ?? 0`
 * billed ZERO days of MTF interest. The save then charged the real holding
 * period: the probe showed a preview of ₹192.31 charges / ₹5,307.69 net against
 * a stored ₹397.46 / ₹5,102.54 — ₹205.15 of interest the preview called zero.
 *
 * Both halves run for real here: the actual route handler
 * (app/api/charges/preview/route.ts) against the actual `closePosition` on a
 * temp database, to the paisa. Non-MTF rows never read `daysHeld`, so the reach
 * is bounded to open eq_mtf positions.
 *
 * The dates the dialog SENDS are the caller's (`buyDate`/`sellDate` — R56), so
 * this file resolves them the way `closePosition` does (`sameExitIso` below,
 * mirroring commit.ts's private `normalizeDate`) and pins the dialog's own
 * resolution against its source, exactly as tests/mtf-funded-zero.test.ts pins
 * the editor preview's null-vs-0 read.
 *
 * ONE temp database per FILE (AGENTS.md Testing); everything that reaches
 * lib/db is imported dynamically after it.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let POST: (req: Request) => Promise<Response>;
let closePreviewBody: typeof import("@/components/trades/close-trade-dialog").closePreviewBody;
let toSlimTrade: typeof import("@/lib/domain/slim-trade").toSlimTrade;
let todayIstIso: typeof import("@/lib/domain/trading-day").todayIstIso;

// Measured locally 2026-09-15: migrate + seed + the commit, route and dialog
// imports ~2 s, inside the 3 s local hook budget. The raised timeout is for the
// Windows runner (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("close-preview-exit-date", { seed: true });
  commit = await import("@/lib/import/commit");
  ({ POST } = await import("@/app/api/charges/preview/route"));
  ({ closePreviewBody } = await import("@/components/trades/close-trade-dialog"));
  ({ toSlimTrade } = await import("@/lib/domain/slim-trade"));
  ({ todayIstIso } = await import("@/lib/domain/trading-day"));
}, 120_000);
afterAll(() => t?.cleanup());

const DAYS_HELD = 30;
const EXIT_PRICE = 255;

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
const wire = (id: number) => JSON.parse(JSON.stringify(toSlimTrade(row(id)))) as ReturnType<typeof toSlimTrade>;

/** `closePosition`'s own exit-date rule (commit.ts `normalizeDate(exitDate) ?? todayIstIso()`). */
function sameExitIso(raw: string): string {
  const s = raw.trim();
  const dmy = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return todayIstIso();
}

function mtfOpen(sym: string, buyDate: string): number {
  return t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        broker: "angelone",
        segment: "eq_mtf",
        symbol: sym,
        tradingsymbol: sym,
        buyQty: 100,
        avgBuyPrice: 200,
        buyValue: 20000,
        buyDate,
        sellQty: 0,
        avgSellPrice: 0,
        sellValue: 0,
        isOpen: true,
        buyOrderCount: 1,
        sellOrderCount: 0,
        mtfFundedAmount: 16000,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** The route's answer as the dialog renders it: [charges total, net, MTF interest]. */
async function preview(body: unknown): Promise<number[]> {
  const res = await POST(
    new Request("http://localhost:3011/api/charges/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The wire, not the object: NaN only becomes null through JSON.
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  const j = (await res.json()) as { breakdown: { total: number; mtfInterest: number }; grossPnl: number; netPnl: number };
  return [j.breakdown.total, j.netPnl, j.breakdown.mtfInterest];
}

describe("I1 [1] — the close preview bills the same exit date the close stores, however the date field reads", () => {
  it.each([
    ["", "cleared"],
    ["not-a-date", "unreadable"],
  ])("exit date %j (%s): preview charges / net / days equal the save's", async (raw, tag) => {
    const today = todayIstIso();
    const buyDate = new Date(new Date(`${today}T00:00:00Z`).getTime() - DAYS_HELD * 86_400_000).toISOString().slice(0, 10);
    const id = mtfOpen(`MTFX${tag.slice(0, 3).toUpperCase()}`, buyDate);

    const exitIso = sameExitIso(raw);
    const body = closePreviewBody(wire(id), EXIT_PRICE, raw, { buyDate, sellDate: exitIso });

    const shown = await preview(body);
    // `closeTradeAction`'s own read of the field (str(): "" → null).
    expect(commit.closePosition(id, EXIT_PRICE, raw === "" ? null : raw).ok).toBe(true);

    const r = row(id);
    expect(r.sellDate, "the save's exit epoch").toBe(exitIso);
    expect(r.mtfInterest, "30 days of MTF interest on ₹16,000").toBeGreaterThan(0);
    // THE assertions (on revert: the preview bills 0 days, so its charges are
    // short by the whole MTF interest and its net is that much richer).
    expect(shown.slice(0, 2), "the close preview is the close").toEqual([r.chargesTotal, r.netPnl]);
    expect(shown[2]).toBe(r.mtfInterest);
    // On revert: `new Date("")` / `new Date("not-a-date")` is Invalid Date, so
    // this is NaN and the wire carries null.
    expect(Number.isFinite(body.daysHeld), "the preview sends a real holding period").toBe(true);
    expect(body.daysHeld).toBe(DAYS_HELD);
  });

  it("the dialog resolves its exit date ONCE, for the dates and the holding period alike", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/trades/close-trade-dialog.tsx"), "utf8");
    // The body takes the period off the resolved date, never the raw field.
    expect(/daysHeld:[^\n]*new Date\(exitDate\)/.test(src), "daysHeld read off the raw field").toBe(false);
    expect(/resolveExitIso\(exitDate\)/.test(src), "the effect's exitIso uses the same resolver").toBe(true);
  });
});
