import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { workbookOf, type ParseContext } from "@/lib/import/types";

/**
 * `workbookOf(ctx)` — one decode per context, however many readers ask.
 *
 * Every fingerprinting detector opens the workbook (AGENTS.md: a broker-named
 * parser must SEE the broker's name) and the route ranks twice before it
 * parses once; with each reader decoding for itself that was 11 full XLSX
 * decodes of one upload (tests/load/b7-import-parse-count.load.ts). The
 * memo lives on the context object, so a fresh request can never be served
 * another file's workbook, and it follows `buffer` identity — the same rule
 * `rankParsers`' cache uses — so a context whose bytes change is re-read.
 */

const reads = { full: 0, sheetsOnly: 0 };
vi.mock("xlsx", async (importOriginal) => {
  const mod = await importOriginal<typeof import("xlsx")>();
  return {
    ...mod,
    read: (data: unknown, opts?: { bookSheets?: boolean }) => {
      if (opts?.bookSheets) reads.sheetsOnly++;
      else reads.full++;
      return mod.read(data as never, opts as never);
    },
  };
});

const FILE = path.join(process.cwd(), "tests", "fixtures", "redacted", "groww-order-history.xlsx");
const bytes = () => fs.readFileSync(FILE);
const reset = () => { reads.full = 0; reads.sheetsOnly = 0; };

describe("workbookOf", () => {
  it("decodes once and hands every later caller the same workbook object", () => {
    reset();
    const ctx: ParseContext = { filename: "x.xlsx", buffer: bytes() };
    const a = workbookOf(ctx);
    const b = workbookOf(ctx);
    const c = workbookOf(ctx);
    // THE assertion: reverting the memo (each caller calling XLSX.read) reads 3 times.
    expect(reads.full).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a.SheetNames.length).toBeGreaterThan(0);
  });

  it("answers a sheet-list ask from the full workbook for free, and only decodes sheet names when nothing has decoded the cells", () => {
    reset();
    const ctx: ParseContext = { filename: "x.xlsx", buffer: bytes() };
    const names = workbookOf(ctx, { bookSheets: true }).SheetNames;
    expect(reads).toEqual({ full: 0, sheetsOnly: 1 });
    const full = workbookOf(ctx);
    expect(reads).toEqual({ full: 1, sheetsOnly: 1 });
    expect(workbookOf(ctx, { bookSheets: true })).toBe(full); // served from the full decode now
    expect(reads).toEqual({ full: 1, sheetsOnly: 1 });
    expect(full.SheetNames).toEqual(names);
  });

  it("re-decodes when the context's bytes are replaced — the memo follows buffer identity", () => {
    reset();
    const ctx: ParseContext = { filename: "x.xlsx", buffer: bytes() };
    const first = workbookOf(ctx);
    ctx.buffer = bytes(); // same content, a different Buffer — a different file as far as identity goes
    const second = workbookOf(ctx);
    expect(reads.full).toBe(2);
    expect(second).not.toBe(first);
  });

  it("is per context: two contexts over the same bytes are two decodes, never a shared workbook", () => {
    reset();
    const b = bytes();
    const one = workbookOf({ filename: "a.xlsx", buffer: b });
    const two = workbookOf({ filename: "b.xlsx", buffer: b });
    expect(reads.full).toBe(2);
    expect(two).not.toBe(one);
  });

  it("throws what XLSX.read throws — a context with no bytes, junk bytes — so callers keep their own fallbacks", () => {
    expect(() => workbookOf({ filename: "x.xlsx" })).toThrow(/no bytes/);
    // A text-only context (a CSV) has no workbook; callers that guard on
    // ctx.buffer never get here, and one that does gets the throw, not a fake.
    expect(() => workbookOf({ filename: "x.csv", text: "a,b" })).toThrow();
  });
});
