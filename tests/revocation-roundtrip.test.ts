import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sign, createPrivateKey } from "node:crypto";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { canonicalListBytes, type RevocationList } from "@/lib/revocation-format";

/**
 * The revocation list end to end, against a real database and real files:
 * write a cache the way the desktop shell does, then check what the app makes
 * of it.
 *
 * The vendor key here is the REAL one — `lib/license.ts` verifies against
 * `LICENSE_PUBLIC_KEY_PEM`, so a list signed with anything else must be
 * rejected, and that rejection is itself one of the assertions.
 *
 * ONE temp database per FILE (tests/helpers/temp-db.ts).
 */

let t: TempDb;
let revocation: typeof import("@/lib/revocation");
let cachePath: string;

const KEY_ID = "A1B2-C3D4-E5";

/**
 * Read at MODULE scope, not in beforeAll: `describe.skipIf` is evaluated while
 * the file is being collected, long before any hook runs — reading it later
 * silently skipped every signature test even on a machine that had the key.
 * The vendor key is gitignored, so CI legitimately skips this block.
 */
const privPem: string | null = (() => {
  try {
    return fs.readFileSync("license-private.pem", "utf8");
  } catch {
    return null;
  }
})();

beforeAll(async () => {
  t = await openTempDb("revocation", { seed: true });
  revocation = await import("@/lib/revocation");
  cachePath = (await import("@/lib/db")).revocationFile;
});
afterAll(() => t?.cleanup());

beforeEach(() => {
  revocation.resetRevocationCache();
  fs.rmSync(cachePath, { force: true });
  t.db.update(t.schema.settings).set({ revocationListIssuedAt: null }).run();
});

function writeCache(list: RevocationList, signWith: string | null) {
  const signature = signWith
    ? sign(null, Buffer.from(canonicalListBytes(list), "utf8"), createPrivateKey(signWith)).toString("base64url")
    : "bm90LWEtc2lnbmF0dXJl";
  fs.writeFileSync(cachePath, JSON.stringify({ list, signature }));
}

const list = (over: Partial<RevocationList> = {}): RevocationList => ({
  vyuhaRevocations: true,
  v: 1,
  issuedAt: "2026-08-12T00:00:00.000Z",
  entries: [{ keyId: KEY_ID, effectiveFrom: "2026-08-26" }],
  ...over,
});

describe("no list is the normal state", () => {
  it("returns null when the shell has never cached one", () => {
    expect(revocation.loadRevocationList()).toBeNull();
  });

  it("returns null for a corrupt file instead of throwing", () => {
    fs.writeFileSync(cachePath, "not json {{{");
    expect(revocation.loadRevocationList()).toBeNull();
  });

  it("returns null for a captive-portal HTML page", () => {
    fs.writeFileSync(cachePath, "<!doctype html><title>Sign in to WiFi</title>");
    expect(revocation.loadRevocationList()).toBeNull();
  });
});

describe("signature is the whole trust model", () => {
  it("refuses a list signed by anyone but the vendor", () => {
    writeCache(list(), null);
    expect(revocation.loadRevocationList()).toBeNull();
    // …and refusing must not advance the ratchet, or a forgery could lock the
    // machine out of accepting the genuine list that follows.
    expect(t.db.select().from(t.schema.settings).get()!.revocationListIssuedAt).toBeNull();
  });
});

describe.skipIf(!privPem)("accepted lists, and the rollback guard", () => {
  it("accepts a genuinely signed list and records its issue date", () => {
    writeCache(list(), privPem);
    const loaded = revocation.loadRevocationList();
    expect(loaded?.entries[0].keyId).toBe(KEY_ID);
    expect(t.db.select().from(t.schema.settings).get()!.revocationListIssuedAt).toBe("2026-08-12T00:00:00.000Z");
  });

  it("re-reads the SAME list on the next launch without complaint", () => {
    writeCache(list(), privPem);
    expect(revocation.loadRevocationList()).not.toBeNull();
    revocation.resetRevocationCache();
    expect(revocation.loadRevocationList()).not.toBeNull(); // steady state
  });

  it("REFUSES an older list dropped in to undo a revocation", () => {
    writeCache(list(), privPem);
    expect(revocation.loadRevocationList()).not.toBeNull();

    // The attack: keep yesterday's (empty) list and restore it afterwards.
    revocation.resetRevocationCache();
    writeCache(list({ issuedAt: "2026-08-01T00:00:00.000Z", entries: [] }), privPem);
    expect(revocation.loadRevocationList()).toBeNull();
    // The high-water mark is untouched, so the newer list still stands.
    expect(t.db.select().from(t.schema.settings).get()!.revocationListIssuedAt).toBe("2026-08-12T00:00:00.000Z");
  });

  it("accepts a NEWER list that clears the entries — the un-revoke path", () => {
    writeCache(list(), privPem);
    revocation.loadRevocationList();
    revocation.resetRevocationCache();

    writeCache(list({ issuedAt: "2026-09-01T00:00:00.000Z", entries: [] }), privPem);
    const loaded = revocation.loadRevocationList();
    expect(loaded?.entries).toEqual([]);
    expect(t.db.select().from(t.schema.settings).get()!.revocationListIssuedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe.skipIf(!privPem)("the PUBLISHER and the VERIFIER agree", () => {
  it("a list produced by scripts/revocation-publish.mjs verifies in-app", async () => {
    // The publisher re-implements the canonical bytes (it is a plain .mjs and
    // cannot import the TS module). A key-order drift between the two would
    // make every published signature verify NOWHERE, silently — the feature
    // would look shipped and do nothing. So run the real script and feed its
    // real output to the real reader.
    const { execFileSync } = await import("node:child_process");
    const out = path.join(os.tmpdir(), `vyuha-revocations-${process.pid}.json`);
    try {
      execFileSync(process.execPath, ["scripts/revocation-publish.mjs", "--out", out, "--grace-days", "14"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      fs.copyFileSync(out, cachePath);
      const loaded = revocation.loadRevocationList();
      expect(loaded).not.toBeNull();
      expect(loaded!.vyuhaRevocations).toBe(true);
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
});

describe("backups never carry the ratchet", () => {
  it("revocationListIssuedAt is redacted like the other machine columns", async () => {
    const { SETTINGS_MACHINE_COLUMNS } = await import("@/lib/backup-format");
    // Restoring a backup taken before a revocation must not reset the ratchet
    // — that would be the rollback attack by another route.
    expect(SETTINGS_MACHINE_COLUMNS).toContain("revocationListIssuedAt");
  });
});
