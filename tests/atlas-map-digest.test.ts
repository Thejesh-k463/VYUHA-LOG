/**
 * Q52 — the bundled classification maps carry a sha256 beside their as-of date.
 *
 * The sector/index maps are refreshed BY HAND, once per minor release, and
 * `asOf` is a field inside the file rather than a property of it: two builds
 * of the same dated snapshot, or a map edited after it was dated, read
 * identically on screen. The digest is what tells them apart, and it is taken
 * over the CANONICAL JSON BYTES of the object the runtime actually loaded —
 * not over a re-read from disk, which a packaged build may not have.
 *
 * This file recomputes both digests from the very same imports the query layer
 * uses and compares. It also changes ONE BYTE of the input and asserts the
 * digest moves, because a hash that does not move is a hash of the wrong
 * thing.
 *
 * One temp database for the FILE (lib/db caches its connection on globalThis),
 * and `@/lib/queries/atlas` is imported dynamically AFTER the helper has set
 * VYUHA_DB_PATH — it is `server-only` and reaches lib/db, so a static import
 * would bind the real database first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
// Data, not code: importing the JSON binds no database connection.
import nseIndexMapJson from "@/lib/data/nse-index-map.json";
import sectorMapJson from "@/lib/data/sector-map.json";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** The independent recomputation — deliberately NOT the module's own helper. */
const digestOf = (json: unknown) =>
  createHash("sha256").update(JSON.stringify(json), "utf8").digest("hex");

let t: TempDb;
let q: typeof import("@/lib/queries/atlas");

beforeAll(async () => {
  t = await openTempDb("atlas-map-digest", { seed: true });
  q = await import("@/lib/queries/atlas");
});

afterAll(() => t?.cleanup());

describe("both bundled maps are digested, and the digest is of the bytes the runtime reads", () => {
  it("covers the sector taxonomy AND the NSE index map — the two files the sector chain reads", () => {
    expect(q.getMapDigests().map((d) => d.file)).toEqual([
      "lib/data/sector-map.json",
      "lib/data/nse-index-map.json",
    ]);
  });

  it("the sector map's digest recomputes from the same bytes", () => {
    const d = q.getMapDigests().find((x) => x.file === "lib/data/sector-map.json")!;
    expect(d.sha256).toBe(digestOf(sectorMapJson));
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the index map's digest recomputes from the same bytes", () => {
    const d = q.getMapDigests().find((x) => x.file === "lib/data/nse-index-map.json")!;
    expect(d.sha256).toBe(digestOf(nseIndexMapJson));
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ONE changed byte of the input moves the digest — and the MODULE is what is measured", () => {
    // The whole point of the field: a map edited without its asOf being
    // touched has to read differently on screen.
    //
    // This case used to hash two strings it had built itself and compare them,
    // which is a property of sha256, not of `getMapDigests()`: a module that
    // digested the wrong thing — the file bytes, the asOf, a constant — passed
    // it untouched. It now runs the mutation THROUGH the module's contract.
    const bytes = JSON.stringify(sectorMapJson);
    const mutated = `${bytes.slice(0, -1)} }`;
    expect(mutated).toHaveLength(bytes.length + 1);
    expect(createHash("sha256").update(mutated, "utf8").digest("hex")).not.toBe(digestOf(sectorMapJson));

    // 1. What the module publishes IS the canonical-JSON digest of each of the
    //    two objects the runtime holds — asserted for both maps together, so a
    //    module that hashed one and stubbed the other cannot pass.
    const digests = Object.fromEntries(q.getMapDigests().map((d) => [d.file, d.sha256]));
    expect(digests).toEqual({
      "lib/data/sector-map.json": digestOf(sectorMapJson),
      "lib/data/nse-index-map.json": digestOf(nseIndexMapJson),
    });

    // 2. …and it is NOT the sha256 of the file on disk. Those bytes carry the
    //    source file's own formatting — indentation, key spacing, the trailing
    //    newline — so the two digests differ, and the difference is the fact the
    //    panel's title attribute has to state: a buyer running `sha256sum` on
    //    `lib/data/sector-map.json` reads a different 64 hex and must not
    //    conclude the build was tampered with.
    for (const [file, canonical] of Object.entries(digests)) {
      const onDisk = createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex");
      expect(onDisk, `${file}: the file-bytes digest is not a 64-hex sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(canonical, `${file}: the module appears to hash the file on disk, not the loaded map`).not.toBe(onDisk);
    }
  });

  it("each digest is stated beside the map's OWN clock, not the snapshot's", () => {
    for (const d of q.getMapDigests()) {
      expect(d.asOf, `${d.file} carries no asOf`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const sector = q.getMapDigests().find((x) => x.file === "lib/data/sector-map.json")!;
    expect(sector.asOf).toBe((sectorMapJson as { asOf: string }).asOf);
  });

  it("is computed once and cannot be poisoned by a caller that mutates the result", () => {
    const first = q.getMapDigests();
    first[0].sha256 = "tampered";
    expect(q.getMapDigests()[0].sha256).toBe(digestOf(sectorMapJson));
  });
});

describe("the panel prints it — twelve hex beside the date, the full digest in the title", () => {
  it("the view hands the digests to the panel", () => {
    const view = q.getAtlasPageData().view!;
    expect(view.mapDigests).toEqual(q.getMapDigests());
  });

  it("the panel renders them and never hashes anything itself", () => {
    const panel = read("components/atlas/atlas-panel.tsx");
    expect(panel, "the digests are not rendered").toContain("view.mapDigests");
    expect(panel, "the short form is not 12 hex").toContain("d.sha256.slice(0, 12)");
    expect(panel, "no `sha256 <hex> · as of <date>` line").toMatch(/sha256 \{d\.sha256\.slice\(0, 12\)\} · as of/);
    expect(panel, "the full digest is not in a title attribute").toMatch(/title=\{`\$\{d\.file\} · sha256 \$\{d\.sha256\}/);
    // …and the title says WHAT was hashed. "sha256" beside a filename reads as
    // a digest OF THAT FILE, which it is not — see the canonical-vs-file
    // assertion above. The clause is what stops a buyer running sha256sum on
    // lib/data/sector-map.json and reporting a tampered build.
    expect(panel, "the title does not say the digest is of the canonical JSON").toMatch(/canonical JSON/);
    expect(panel, "the title does not disclaim the file on disk").toMatch(/not of the file on disk/);
    // node:crypto in a client component is a bundling failure, not a test one —
    // which is exactly why it is asserted here rather than discovered at build.
    expect(panel).not.toMatch(/import[^\n]*node:crypto|createHash\(/);
  });
});
