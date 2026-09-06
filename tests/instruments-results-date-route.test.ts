import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * `/api/instruments` — the `results-date` action (owner ruling Q-9, migration
 * 0068).
 *
 * WHAT IS ACTUALLY AT RISK. The column is free text at rest — SQLite stores
 * whatever it is handed — so the route is the ONLY thing standing between a
 * typo and a chip that silently never renders. `2026-02-30` is the interesting
 * case: it matches `\d{4}-\d{2}-\d{2}`, so a regex-only guard accepts it,
 * `Date.UTC` rolls it forward to 02 March, and the desk would print a distance
 * to a day that does not exist. The route validates with the SAME predicate
 * the desk reads through (`isIsoDate`), so the two cannot drift.
 *
 * `lib/db` is imported DYNAMICALLY through `openTempDb`, and the route module
 * after it — a static import here binds the connection before the helper sets
 * `VYUHA_DB_PATH`. `next/cache` is mocked because `revalidatePath` needs a
 * request store no unit test has.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/instruments/route");
let TCS = 0;

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://local/api/instruments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const storedDate = (id: number) =>
  (t.sqlite.prepare("SELECT results_date AS d FROM instruments WHERE id = ?").get(id) as { d: string | null }).d;

beforeAll(async () => {
  t = await openTempDb("instruments-results-date", { seed: true });
  route = await import("@/app/api/instruments/route");
  t.sqlite.prepare("INSERT INTO instruments (symbol, sector) VALUES ('TCS','IT')").run();
  TCS = (t.sqlite.prepare("SELECT id FROM instruments WHERE symbol='TCS'").get() as { id: number }).id;
});
afterAll(() => t?.cleanup());

describe("the results-date edit writes a calendar date, or nothing", () => {
  it("stores an ISO date", async () => {
    const res = await post({ action: "results-date", id: TCS, resultsDate: "2026-10-14" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(storedDate(TCS)).toBe("2026-10-14");
  });

  it("clears with null, and with the empty string a cleared date input submits", async () => {
    expect((await (await post({ action: "results-date", id: TCS, resultsDate: null })).json()).ok).toBe(true);
    expect(storedDate(TCS)).toBeNull();

    await post({ action: "results-date", id: TCS, resultsDate: "2026-11-03" });
    expect(storedDate(TCS)).toBe("2026-11-03");
    expect((await (await post({ action: "results-date", id: TCS, resultsDate: "" })).json()).ok).toBe(true);
    expect(storedDate(TCS)).toBeNull();
  });

  it("refuses a well-shaped string that is not a real day, and writes nothing", async () => {
    await post({ action: "results-date", id: TCS, resultsDate: "2026-10-14" });
    const res = await post({ action: "results-date", id: TCS, resultsDate: "2026-02-30" });
    expect(res.status, "a regex-only guard would have taken 30 February").toBe(400);
    expect(storedDate(TCS), "the refused write still landed").toBe("2026-10-14");
  });

  it("refuses every other malformed shape", async () => {
    for (const bad of ["14-10-2026", "2026/10/14", "2026-10-14T00:00:00Z", "tomorrow", "2027-02-29"]) {
      const res = await post({ action: "results-date", id: TCS, resultsDate: bad });
      expect(res.status, String(bad)).toBe(400);
    }
    expect(storedDate(TCS)).toBe("2026-10-14");
  });

  it("a malformed NON-STRING is refused, never silently read as a clear", async () => {
    // The bug this pins: normalising "anything that is not a string" to null
    // turns a broken client into a delete of a date the user typed.
    for (const bad of [20261014, true, { d: "2026-10-14" }, ["2026-10-14"]]) {
      const res = await post({ action: "results-date", id: TCS, resultsDate: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(storedDate(TCS), `${JSON.stringify(bad)} cleared the stored date`).toBe("2026-10-14");
    }
  });

  it("an ABSENT field is a bad request, not a clear", async () => {
    const res = await post({ action: "results-date", id: TCS });
    expect(res.status).toBe(400);
    expect(storedDate(TCS)).toBe("2026-10-14");
  });

  it("refuses an unknown instrument rather than reporting a write that never happened", async () => {
    const res = await post({ action: "results-date", id: 999_999, resultsDate: "2026-10-14" });
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  it("refuses a bad id shape", async () => {
    for (const id of [0, -3, "abc", null, 1.5]) {
      expect((await post({ action: "results-date", id, resultsDate: "2026-10-14" })).status, String(id)).toBe(400);
    }
  });

  it("touches nothing else on the row — this edit is the results date and only that", async () => {
    await post({ action: "results-date", id: TCS, resultsDate: "2026-12-01" });
    const row = t.sqlite.prepare("SELECT symbol, sector FROM instruments WHERE id = ?").get(TCS) as {
      symbol: string;
      sector: string | null;
    };
    expect(row.symbol).toBe("TCS");
    expect(row.sector, "a sector the user typed was collateral damage").toBe("IT");
  });

  it("is readable back through the query the Live Desk uses", async () => {
    await post({ action: "results-date", id: TCS, resultsDate: "2026-12-01" });
    const q = await import("@/lib/queries/instruments");
    expect(q.getResultsDateMap().get("TCS")).toBe("2026-12-01");
    expect(q.getInstruments().find((r) => r.symbol === "TCS")!.resultsDate).toBe("2026-12-01");
    // Symbols with no date are OMITTED from the map, never mapped to null.
    t.sqlite.prepare("INSERT INTO instruments (symbol) VALUES ('INFY')").run();
    expect(q.getResultsDateMap().has("INFY")).toBe(false);
  });
});
