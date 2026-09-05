import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * The three `/api/atlas` routes.
 *
 * What is worth pinning here is not the JSON but the REFUSALS, because each of
 * them is the only thing standing between a local-first app and a habit it
 * promised not to have:
 *
 *   - every handler is same-origin. All three WRITE (recompute, start a
 *     download, apply files), so a page on another origin must not be able to
 *     poke them while the desktop shell is running.
 *   - GET /api/atlas never computes. A read that could kick off a
 *     2,000-symbol recompute would make "just looking" expensive.
 *   - POST /api/atlas/backfill without consent is a 403 with a sentence, not a
 *     silent no-op — the user is told which of the two consents is missing.
 *   - the file drop needs no consent at all, because it makes no request.
 *
 * `next/cache` is mocked: `revalidatePath` needs a Next request scope that no
 * unit test has, and the assertion here is about the response, not the cache.
 */

let t: TempDb;
let atlas: typeof import("@/app/api/atlas/route");
let backfill: typeof import("@/app/api/atlas/backfill/route");
let importFiles: typeof import("@/app/api/atlas/import-files/route");
let job: typeof import("@/lib/jobs/bhavcopy-backfill");

const url = (p: string) => `http://localhost:3011${p}`;
const get = (p: string, headers: Record<string, string> = {}) => new Request(url(p), { headers });
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url(p), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const CSV = [
  "TradDt,FinInstrmTp,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol",
  "2026-09-04,STK,RELIANCE,EQ,1400,1425,1395,1420,120000",
  "2026-09-04,STK,TCS,EQ,3000,3040,2990,3010,45000",
].join("\n");

beforeAll(async () => {
  t = await openTempDb("atlas-route", { seed: true });
  atlas = await import("@/app/api/atlas/route");
  backfill = await import("@/app/api/atlas/backfill/route");
  importFiles = await import("@/app/api/atlas/import-files/route");
  job = await import("@/lib/jobs/bhavcopy-backfill");
});

afterAll(() => t?.cleanup());
afterEach(() => vi.unstubAllGlobals());

describe("the same-origin guard, on all three routes", () => {
  const hostile = { origin: "https://not-vyuha.example", host: "localhost:3011" };

  it("refuses a cross-origin read of the snapshot", async () => {
    const res = await atlas.GET(get("/api/atlas", hostile));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Cross-origin request refused.");
  });

  it("refuses a cross-origin recompute, a cross-origin backfill and a cross-origin file drop", async () => {
    expect((await atlas.POST(post("/api/atlas", {}, hostile))).status).toBe(403);
    expect((await backfill.POST(post("/api/atlas/backfill", { action: "start" }, hostile))).status).toBe(403);
    expect((await importFiles.POST(post("/api/atlas/import-files", {}, hostile))).status).toBe(403);
  });

  it("refuses on sec-fetch-site even when no Origin header is sent", async () => {
    expect((await backfill.GET(get("/api/atlas/backfill", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });

  it("allows the desktop shell, the dev server, and a same-origin fetch that sends no Origin", async () => {
    expect((await atlas.GET(get("/api/atlas"))).status).toBe(200);
    expect((await atlas.GET(get("/api/atlas", { origin: "http://tauri.localhost" }))).status).toBe(200);
    expect((await atlas.GET(get("/api/atlas", { "sec-fetch-site": "same-origin" }))).status).toBe(200);
  });
});

describe("GET /api/atlas — a read, and only a read", () => {
  it("reports 'not computed' on an empty database instead of computing one", async () => {
    const body = await (await atlas.GET(get("/api/atlas"))).json();
    expect(body.computed).toBe(false);
    expect(body.snapshot).toBeNull();
    expect(body.provenance).toBe("Computed from your stored end-of-day bhavcopy. No Chartink data is used.");
    const rows = t.sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_daily").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("POST /api/atlas — the explicit recompute", () => {
  it("says why it did nothing when there are no bars at all", async () => {
    const body = await (await atlas.POST(post("/api/atlas", {}))).json();
    expect(body.recomputed).toBe(false);
    expect(body.reason).toBe("no_bars");
  });

  it("computes once bars exist, and does not compute twice for the same bars", async () => {
    const insert = t.sqlite.prepare(
      "INSERT INTO price_history (symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < 3; i++) {
      const date = `2026-08-0${i + 1}`;
      insert.run("RELIANCE", date, 100, 105, 99, 100 + i, 1000);
      insert.run("TCS", date, 300, 305, 299, 300 - i, 900);
    }
    const first = await (await atlas.POST(post("/api/atlas", {}))).json();
    expect(first.recomputed).toBe(true);
    expect(first.snapshot.asOf).toBe("2026-08-03");

    const second = await (await atlas.POST(post("/api/atlas", {}))).json();
    expect(second.recomputed).toBe(false);
    expect(second.reason).toBe("checksum_unchanged");

    const forced = await (await atlas.POST(post("/api/atlas", { force: true }))).json();
    expect(forced.recomputed).toBe(true);
    expect(forced.reason).toBe("forced");
  });
});

describe("POST /api/atlas/backfill — consent is a 403, not a shrug", () => {
  it("refuses to start and names both ways to consent", async () => {
    const res = await backfill.POST(post("/api/atlas/backfill", { action: "start" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.consented).toBe(false);
    expect(body.error).toContain("252");
    expect(body.error).toContain("auto-MTM");
    expect(job.readBackfillProgress().status).toBe("idle"); // nothing was started
  });

  it("rejects an unknown action rather than guessing at it", async () => {
    const res = await backfill.POST(post("/api/atlas/backfill", { action: "wipe" }));
    expect(res.status).toBe(400);
  });

  it("records the ack, and only then starts — the run itself makes the requests", async () => {
    const acked = await (await backfill.POST(post("/api/atlas/backfill", { action: "ack" }))).json();
    expect(acked.consented).toBe(true);

    // Every request refused, so the walk gives up quickly and touches nothing.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })));
    const started = await (await backfill.POST(post("/api/atlas/backfill", { action: "start", days: 1 }))).json();
    expect(started.started).toBe(true);
    expect(started.days).toBe(1);

    // The route does not await the run (252 files is ~6.5 minutes), so wait for
    // the progress the loop persists rather than for the response.
    for (let i = 0; i < 40 && job.readBackfillProgress().status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const p = job.readBackfillProgress();
    expect(p.status).toBe("done");
    expect(p.requested).toBe(1);
    expect(p.applied).toBe(0);
    expect(p.missing).toBe(1);
  });

  it("reports the progress, the pace and the ceiling on GET", async () => {
    const body = await (await backfill.GET(get("/api/atlas/backfill"))).json();
    expect(body.consented).toBe(true);
    expect(body.rateLimitMs).toBe(1_500);
    expect(body.defaultDays).toBe(252);
    expect(body.maxDays).toBe(252);
    expect(body.progress.v).toBe(1);
  });

  it("turns abort into a request the loop can see, and is a no-op when nothing runs", async () => {
    const body = await (await backfill.POST(post("/api/atlas/backfill", { action: "abort" }))).json();
    expect(body.ok).toBe(true);
    expect(body.progress.abortRequested).toBe(false); // nothing was running
  });
});

describe("POST /api/atlas/import-files — the offline half", () => {
  const drop = (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return new Request(url("/api/atlas/import-files"), { method: "POST", body: form });
  };

  it("applies a dropped CSV through the same applier the download uses", async () => {
    const res = await importFiles.POST(drop([new File([CSV], "BhavCopy_NSE_CM_20260904.csv", { type: "text/csv" })]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(1);
    expect(body.rows).toBe(2);
    expect(body.results[0].date).toBe("2026-09-04");
    const rows = t.sqlite.prepare("SELECT COUNT(*) AS n FROM price_history WHERE date = '2026-09-04'").get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it("makes no network request of any kind", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await importFiles.POST(drop([new File([CSV], "again.csv", { type: "text/csv" })]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a file it could not read per file, and keeps the ones it could", async () => {
    const res = await importFiles.POST(
      drop([
        new File([CSV], "good.csv", { type: "text/csv" }),
        new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "screenshot.png"),
      ]),
    );
    const body = await res.json();
    expect(body.files).toBe(2);
    expect(body.applied).toBe(1);
    expect(body.results[1].ok).toBe(false);
    expect(body.results[1].message).toBeTruthy();
  });

  it("says so when nothing was uploaded", async () => {
    const res = await importFiles.POST(drop([]));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("No files uploaded.");
  });

  it("caps a single file at 32 MB and the drop at 300 files", () => {
    expect(importFiles.MAX_FILE_BYTES).toBe(32 * 1024 * 1024);
    expect(importFiles.MAX_FILES).toBe(300);
  });
});
