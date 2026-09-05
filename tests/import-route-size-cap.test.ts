import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * /api/import refuses an oversized upload on its DECLARED size, before
 * `arrayBuffer()` copies it and the parsers touch it.
 *
 * This is a parse-cost/UX guard, not a memory guard: `req.formData()` runs
 * first and has already buffered the whole request body, so an oversized
 * upload is resident either way. What the cap prevents is the route spending
 * seconds parsing a 500 MB file (a whole backup dropped on the import screen
 * by mistake) and copying it a second time. The refusal must therefore happen
 * on `file.size` alone: the test asserts `arrayBuffer` is never called.
 *
 * `maxDuration` is pinned here too: parsing a large workbook is CPU-bound and
 * single-shot, and the platform default cuts it off mid-parse.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/import/route");

const MB = 1024 * 1024;
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "groww-pnl.xlsx");

beforeAll(async () => {
  t = await openTempDb("import-route-size-cap", { seed: true });
  route = await import("@/app/api/import/route");
});
afterAll(() => t?.cleanup());

/**
 * A File that CLAIMS a size without allocating one. `file.size` is what the
 * route reads, and this is the only way to exercise a 33 MB upload without
 * putting 33 MB through the test runner.
 */
function fileClaiming(sizeBytes: number, name: string, body: Uint8Array) {
  // `Uint8Array<ArrayBufferLike>` is not a `BlobPart` under TS 5.7's stricter
  // typed-array generics (a SharedArrayBuffer-backed view cannot be a BlobPart).
  // The bytes are always ArrayBuffer-backed here; the cast says so.
  const f = new File([body as unknown as BlobPart], name);
  Object.defineProperty(f, "size", { value: sizeBytes });
  const arrayBuffer = vi.fn(async () => body.buffer.slice(0) as ArrayBuffer);
  Object.defineProperty(f, "arrayBuffer", { value: arrayBuffer });
  return { file: f, arrayBuffer };
}

function post(file: File): Promise<Response> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", "preview");
  // The route reads only `req.formData()`. Going through `new Request(…)`
  // would re-encode the multipart body and rebuild the File from its real
  // bytes, discarding the claimed size this test depends on.
  const req = { formData: async () => fd } as unknown as Request;
  return route.POST(req);
}

describe("import route — 32 MB size cap", () => {
  it("keeps the claimed size through FormData (the fixture this test rests on)", () => {
    const { file } = fileClaiming(33 * MB, "big.xlsx", new Uint8Array([1, 2, 3]));
    const fd = new FormData();
    fd.append("file", file);
    expect((fd.get("file") as File).size).toBe(33 * MB);
  });

  it("refuses a 33 MB file with 413 and never reads its bytes", async () => {
    const { file, arrayBuffer } = fileClaiming(33 * MB, "big.xlsx", fs.readFileSync(FIXTURE));
    const res = await post(file);
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/larger than 32 MB/i);
    // The route's error shape is `{ error }` — not `{ ok:false, … }`.
    expect(Object.keys(json)).toEqual(["error"]);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("lets a 31 MB file through the cap", async () => {
    const { file } = fileClaiming(31 * MB, "groww-pnl.xlsx", fs.readFileSync(FIXTURE));
    const res = await post(file);
    expect(res.status).not.toBe(413);
  });

  it("lets an ordinary broker export through untouched", async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const res = await post(new File([bytes], "groww-pnl.xlsx"));
    expect(res.status).not.toBe(413);
  });
});

describe("import route — runtime configuration", () => {
  it("exports maxDuration = 60 so a large workbook parse is not cut off", () => {
    expect(route.maxDuration).toBe(60);
  });

  it("still runs on the node runtime", () => {
    expect(route.runtime).toBe("nodejs");
  });
});
