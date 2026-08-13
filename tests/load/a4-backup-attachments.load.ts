import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "../helpers/temp-db";
import { report, rssAround, time } from "./helpers/measure";

/**
 * A4 — backup and restore with attachments.
 *
 * Two things under test, and the first is not a performance question at all —
 * it is silent data loss that a load test happened to be standing next to.
 *
 * THE THUMBNAIL BUG. Screenshot thumbnails are sidecars by naming convention:
 * `thumb-<storedName>`, written next to the original with NO row in
 * `trade_attachments` (app/api/trades/attachments/route.ts). The comment there
 * says: "Backup copies the directory wholesale, so sidecars ride along."
 *
 * It does not. `dumpDatabase` walks `trade_attachments` ROWS and enveloped
 * only `row.storedName`, so no thumbnail was ever in a backup. Restore then
 * renames the live directory to `.replaced`, promotes a staging directory
 * built purely from envelope entries, and deletes the retired one — so every
 * thumbnail on the machine is destroyed by any attachment-carrying restore,
 * including the automatic pre-migration backup/restore cycle. The user sees
 * their screenshots survive and their previews silently turn blank.
 *
 * ONE TEMP DB PER FILE (tests/helpers/temp-db.ts).
 */

let t: TempDb;
let backup: typeof import("@/lib/backup");

beforeAll(async () => {
  t = await openTempDb("a4-backup-attachments", { seed: true });
  backup = await import("@/lib/backup");
});
afterAll(() => t?.cleanup());

/** One trade + one attachment + its thumbnail sidecar, all on disk. */
function seedAttachment(i: number, bytes: number): { storedName: string; thumbName: string } {
  const trade = t.db.insert(t.schema.trades).values(tradeRow({ symbol: `SYM${i}` })).returning().get();
  const storedName = `${String(i).padStart(6, "0")}deadbeef.png`;
  const thumbName = `thumb-${storedName}`;
  t.db
    .insert(t.schema.tradeAttachments)
    .values({ tradeId: trade.id, fileName: `chart-${i}.png`, storedName, mime: "image/png", sizeBytes: bytes })
    .run();
  fs.mkdirSync(t.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(t.attachmentsDir, storedName), Buffer.alloc(bytes, i % 251));
  // The sidecar: real bytes, no row. This is what the naming convention means.
  fs.writeFileSync(path.join(t.attachmentsDir, thumbName), Buffer.alloc(2_048, 7));
  return { storedName, thumbName };
}

describe("A4 · attachments through a backup/restore round trip", () => {
  it("carries screenshot THUMBNAILS through the envelope", () => {
    const { storedName, thumbName } = seedAttachment(1, 64 * 1024);

    const envelope = backup.dumpDatabase(true);
    const names = (envelope.attachments ?? []).map((a) => a.storedName);

    expect(names, "the screenshot itself must be in the backup").toContain(storedName);
    expect(
      names,
      `thumbnail ${thumbName} is missing from the envelope. dumpDatabase walks ` +
        "trade_attachments rows, and a thumbnail has no row — so restore, which rebuilds the " +
        "directory from envelope entries only, destroys every thumbnail on the machine.",
    ).toContain(thumbName);
  });

  it("still has the thumbnail on disk after a real restore", () => {
    const { storedName, thumbName } = seedAttachment(2, 32 * 1024);
    const envelope = backup.dumpDatabase(true);

    // Restore the dump we just took — the round trip a user performs after a
    // reinstall, and the one the app runs itself before a migration.
    const result = backup.restoreDatabase(envelope);
    expect(result.ok, result.message).toBe(true);

    expect(fs.existsSync(path.join(t.attachmentsDir, storedName)), "screenshot lost by restore").toBe(true);
    expect(
      fs.existsSync(path.join(t.attachmentsDir, thumbName)),
      "thumbnail destroyed by restore — the attachment directory is rebuilt from the envelope, " +
        "so anything the envelope omitted is gone once the retired directory is deleted.",
    ).toBe(true);
  });

  it("reports the memory multiple of enveloping attachments", () => {
    // Report-only. Every file is read whole, base64'd (+33%), collected into one
    // array, and the caller then JSON.stringify()s the lot — so the row graph,
    // the base64 strings and the JSON string are all resident at once.
    const COUNT = 40;
    const EACH = 256 * 1024;
    for (let i = 0; i < COUNT; i++) seedAttachment(100 + i, EACH);
    const logicalMb = (COUNT * EACH) / 1e6;

    let envelopeChars = 0;
    const mem = rssAround(() => {
      const t0 = performance.now();
      const env = backup.dumpDatabase(true);
      envelopeChars = JSON.stringify(env).length;
      report(time(`dump ${COUNT} attachments (${logicalMb.toFixed(1)} MB logical)`, COUNT, () => {}), {
        test: "a4-envelope",
        logicalMb,
        envelopeMb: envelopeChars / 1e6,
        multiple: envelopeChars / (COUNT * EACH),
        dumpMs: performance.now() - t0,
      });
    });
    console.log(
      `    logical ${logicalMb.toFixed(1)} MB → envelope ${(envelopeChars / 1e6).toFixed(1)} MB ` +
        `(${(envelopeChars / (COUNT * EACH)).toFixed(2)}×), rss +${mem.deltaMb.toFixed(0)} MB, peak +${mem.peakMb.toFixed(0)} MB`,
    );

    // A sanity ceiling, not a budget: base64 alone is 1.33×, and the JSON string
    // holding it doubles that. Above 4× something is copying more than it must.
    expect(envelopeChars / (COUNT * EACH)).toBeLessThan(4);
  });
});
